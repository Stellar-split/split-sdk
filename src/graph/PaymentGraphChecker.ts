/**
 * PaymentGraphChecker — Verifies payment path reachability for complex invoices.
 * 
 * Models payment routes as a directed graph and performs reachability analysis
 * to ensure all recipients can be paid from the source account before committing the invoice.
 */

import type { Recipient, Invoice } from "../types.js";

export interface PaymentPath {
  /** Source account in the path */
  from: string;
  /** Destination account in the path */
  to: string;
  /** Asset code for this hop */
  assetCode: string;
  /** Asset issuer for this hop (empty string for native XLM) */
  assetIssuer: string;
}

export interface GraphCheckResult {
  /** Recipients that can be reached from the source */
  reachable: Recipient[];
  /** Recipients that cannot be reached */
  unreachable: Recipient[];
  /** Map of recipient address to payment path */
  paths: Map<string, PaymentPath[]>;
}

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphValidationError";
  }
}

export class UnreachableRecipientError extends Error {
  constructor(
    public readonly unreachableRecipients: string[],
    public readonly checkedEdges: number,
  ) {
    super(
      `Cannot reach ${unreachableRecipients.length} recipient(s): ${unreachableRecipients.join(", ")}. Checked ${checkedEdges} edges.`
    );
    this.name = "UnreachableRecipientError";
  }
}

interface CacheKey {
  sourceAsset: string;
  sourceAccount: string;
  targetAsset: string;
}

interface CacheEntry {
  graph: Map<string, Set<string>>;
  timestamp: number;
}

export interface PaymentGraphCheckerOptions {
  /** TTL for cached graphs in milliseconds (default: 60000 = 60 seconds) */
  cacheTTL?: number;
  /** RPC endpoint for Stellar network */
  rpcUrl?: string;
  /** Horizon endpoint for path-finding */
  horizonUrl: string;
}

export class PaymentGraphChecker {
  private cache = new Map<string, CacheEntry>();
  private cacheTTL: number;
  private horizonUrl: string;

  constructor(options: PaymentGraphCheckerOptions) {
    this.cacheTTL = options.cacheTTL || 60000;
    this.horizonUrl = options.horizonUrl;
  }

  /**
   * Check if valid payment paths exist for all recipients in an invoice.
   */
  async check(
    invoice: Invoice,
    options?: { allowUnreachable?: boolean }
  ): Promise<GraphCheckResult> {
    const recipients = invoice.recipients || [];

    // Detect negative-weight edges (amounts) before path-finding
    for (const recipient of recipients) {
      if (recipient.amount < 0n) {
        throw new GraphValidationError(
          `Negative-weight edge detected: ${sourceAccount} -> ${recipient.address} (amount: ${recipient.amount})`
        );
      }
    }
    const sourceAccount = invoice.creator || invoice.payer || "";
    const sourceAsset = this.extractAssetFromInvoice(invoice);

    const reachable: Recipient[] = [];
    const unreachable: Recipient[] = [];
    const paths = new Map<string, PaymentPath[]>();
    let totalEdgesChecked = 0;

    for (const recipient of recipients) {
      const targetAsset = sourceAsset; // Simplified: assume same asset for now
      
      try {
        const path = await this.findPath(
          sourceAccount,
          recipient.address,
          sourceAsset,
          targetAsset,
          recipient.amount
        );

        if (path.length > 0) {
          reachable.push(recipient);
          paths.set(recipient.address, path);
          totalEdgesChecked += path.length;
        } else {
          unreachable.push(recipient);
        }
      } catch (err) {
        console.error(`Error finding path to ${recipient.address}:`, err);
        unreachable.push(recipient);
      }
    }

    const result: GraphCheckResult = {
      reachable,
      unreachable,
      paths,
    };

    // Throw if there are unreachable recipients and allowUnreachable is not set
    if (unreachable.length > 0 && !options?.allowUnreachable) {
      throw new UnreachableRecipientError(
        unreachable.map((r) => r.address),
        totalEdgesChecked
      );
    }

    return result;
  }

  /**
   * Find a payment path from source to destination using Stellar path-finding.
   */
  private async findPath(
    sourceAccount: string,
    destinationAccount: string,
    sourceAsset: string,
    targetAsset: string,
    amount: bigint
  ): Promise<PaymentPath[]> {
    // Check cache first
    const cacheKey = this.getCacheKey(sourceAsset, sourceAccount, targetAsset);
    const cached = this.getFromCache(cacheKey);

    if (cached) {
      const graph = cached.graph;
      if (this.hasPath(graph, sourceAccount, destinationAccount)) {
        return this.reconstructPath(graph, sourceAccount, destinationAccount, sourceAsset);
      }
    }

    // Query Horizon for strict send paths
    try {
      const [assetCode, assetIssuer] = this.parseAsset(sourceAsset);
      const amountInUnits = this.stroopsToUnits(amount);

      let url: string;
      if (assetCode === "native") {
        url = `${this.horizonUrl}/paths/strict-send?source_asset_type=native&source_amount=${amountInUnits}&destination_account=${destinationAccount}`;
      } else {
        url = `${this.horizonUrl}/paths/strict-send?source_asset_type=credit_alphanum4&source_asset_code=${assetCode}&source_asset_issuer=${assetIssuer}&source_amount=${amountInUnits}&destination_account=${destinationAccount}`;
      }

      const response = await fetch(url);
      
      if (!response.ok) {
        console.warn(`Path finding failed: ${response.status}`);
        return [];
      }

      const data = await response.json();
      const records = data._embedded?.records || [];

      if (records.length === 0) {
        return [];
      }

      // Build graph from path results
      const graph = this.buildGraphFromPaths(records, sourceAccount, destinationAccount);
      this.saveToCache(cacheKey, graph);

      // Return the first valid path
      return this.reconstructPath(graph, sourceAccount, destinationAccount, sourceAsset);
    } catch (err) {
      console.error("Error querying Horizon paths:", err);
      return [];
    }
  }

  /**
   * Build an adjacency list graph from Horizon path results.
   */
  private buildGraphFromPaths(
    pathRecords: any[],
    sourceAccount: string,
    destinationAccount: string
  ): Map<string, Set<string>> {
    const graph = new Map<string, Set<string>>();

    for (const record of pathRecords) {
      const path = record.path || [];
      
      // Add direct edge from source to destination
      if (!graph.has(sourceAccount)) {
        graph.set(sourceAccount, new Set());
      }
      graph.get(sourceAccount)!.add(destinationAccount);

      // Add intermediate hops if any
      let prevNode = sourceAccount;
      for (const hop of path) {
        const hopAccount = hop.asset_issuer || destinationAccount;
        
        if (!graph.has(prevNode)) {
          graph.set(prevNode, new Set());
        }
        graph.get(prevNode)!.add(hopAccount);
        prevNode = hopAccount;
      }
    }

    return graph;
  }

  /**
   * Check if a path exists in the graph using BFS.
   */
  private hasPath(
    graph: Map<string, Set<string>>,
    from: string,
    to: string
  ): boolean {
    if (from === to) return true;

    const visited = new Set<string>();
    const queue: string[] = [from];
    visited.add(from);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = graph.get(current) || new Set();

      for (const neighbor of neighbors) {
        if (neighbor === to) return true;
        
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    return false;
  }

  /**
   * Reconstruct the path from source to destination.
   */
  private reconstructPath(
    graph: Map<string, Set<string>>,
    from: string,
    to: string,
    assetCode: string
  ): PaymentPath[] {
    const [code, issuer] = this.parseAsset(assetCode);
    const path: PaymentPath[] = [];

    // Simple direct path for now
    if (graph.get(from)?.has(to)) {
      path.push({
        from,
        to,
        assetCode: code,
        assetIssuer: issuer,
      });
    }

    return path;
  }

  /**
   * Generate a cache key from payment parameters.
   */
  private getCacheKey(sourceAsset: string, sourceAccount: string, targetAsset: string): string {
    return `${sourceAsset}:${sourceAccount}:${targetAsset}`;
  }

  /**
   * Get cached graph if still valid.
   */
  private getFromCache(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > this.cacheTTL) {
      this.cache.delete(key);
      return null;
    }

    return entry;
  }

  /**
   * Save graph to cache.
   */
  private saveToCache(key: string, graph: Map<string, Set<string>>): void {
    this.cache.set(key, {
      graph,
      timestamp: Date.now(),
    });
  }

  /**
   * Extract asset identifier from invoice.
   */
  private extractAssetFromInvoice(invoice: Invoice): string {
    // Simplified: default to native XLM
    return "native:";
  }

  /**
   * Parse asset string into code and issuer.
   */
  private parseAsset(asset: string): [string, string] {
    if (asset.startsWith("native")) {
      return ["native", ""];
    }

    const parts = asset.split(":");
    return [parts[0] || "XLM", parts[1] || ""];
  }

  /**
   * Convert stroops to decimal units.
   */
  private stroopsToUnits(stroops: bigint): string {
    return (Number(stroops) / 10_000_000).toFixed(7);
  }
}
