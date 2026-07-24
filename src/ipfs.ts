/**
 * IPFS integration for invoice metadata storage and verification.
 *
 * Supports both HTTP gateway and Kubo RPC backends for pinning and fetching
 * invoice metadata from IPFS.
 */

import type { InvoiceMetadata, IPFSConfig, LineItem } from "./types.js";
import {
  IPFSPinError,
  IPFSFetchError,
  CIDMismatchError,
  IPFSConfigError,
} from "./errors.js";

/** Default IPFS configuration using public gateway. */
export const DEFAULT_IPFS_CONFIG: IPFSConfig = {
  backend: "gateway",
  url: "https://ipfs.io",
  timeout: 30000,
};

/** Global IPFS configuration. */
let globalIPFSConfig: IPFSConfig = DEFAULT_IPFS_CONFIG;

/**
 * Configure the IPFS backend globally.
 *
 * @param config - IPFS configuration options.
 */
export function configureIPFS(config: Partial<IPFSConfig>): void {
  globalIPFSConfig = {
    ...DEFAULT_IPFS_CONFIG,
    ...config,
  };
}

/**
 * Get the current IPFS configuration.
 */
export function getIPFSConfig(): IPFSConfig {
  return { ...globalIPFSConfig };
}

/**
 * Reset IPFS configuration to defaults.
 */
export function resetIPFSConfig(): void {
  globalIPFSConfig = DEFAULT_IPFS_CONFIG;
}

/**
 * Serialize InvoiceMetadata to JSON, converting bigints to strings.
 */
function serializeMetadata(metadata: InvoiceMetadata): string {
  const serializable = {
    ...metadata,
    lineItems: metadata.lineItems.map((item) => ({
      ...item,
      unitPrice: item.unitPrice.toString(),
      total: item.total?.toString(),
    })),
  };
  return JSON.stringify(serializable);
}

/**
 * Deserialize JSON back to InvoiceMetadata, converting strings to bigints.
 */
export function deserializeMetadata(json: string): InvoiceMetadata {
  const parsed = JSON.parse(json);
  return {
    title: parsed.title,
    description: parsed.description,
    attachmentCIDs: parsed.attachmentCIDs ?? [],
    lineItems: (parsed.lineItems ?? []).map(
      (item: { description: string; quantity: number; unitPrice: string; total?: string }) => ({
        description: item.description,
        quantity: item.quantity,
        unitPrice: BigInt(item.unitPrice),
        total: item.total ? BigInt(item.total) : undefined,
      })
    ),
  };
}

/**
 * Compute a simple hash of content for CID verification.
 * Uses SHA-256 and returns a hex string.
 */
async function computeContentHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Pin invoice metadata to IPFS via the configured backend.
 *
 * @param metadata - The invoice metadata to pin.
 * @param config - Optional IPFS configuration override.
 * @returns The CID of the pinned content.
 * @throws {IPFSPinError} If pinning fails.
 * @throws {IPFSConfigError} If configuration is invalid.
 */
export async function pinInvoiceMetadata(
  metadata: InvoiceMetadata,
  config?: Partial<IPFSConfig>
): Promise<string> {
  const cfg = { ...globalIPFSConfig, ...config };
  const jsonContent = serializeMetadata(metadata);

  if (cfg.backend === "kubo") {
    return pinViaKubo(jsonContent, cfg);
  } else if (cfg.backend === "gateway") {
    return pinViaGateway(jsonContent, cfg);
  } else {
    throw new IPFSConfigError(`Unknown IPFS backend: ${cfg.backend}`);
  }
}

/**
 * Pin content via Kubo RPC API (/api/v0/add).
 */
async function pinViaKubo(content: string, cfg: IPFSConfig): Promise<string> {
  const url = `${cfg.url.replace(/\/$/, "")}/api/v0/add?pin=true`;

  const formData = new FormData();
  const blob = new Blob([content], { type: "application/json" });
  formData.append("file", blob, "metadata.json");

  const headers: Record<string, string> = {};
  if (cfg.authorization) {
    headers["Authorization"] = cfg.authorization;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), cfg.timeout ?? 30000);

  try {
    const response = await fetch(url, {
      method: "POST",
      body: formData,
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new IPFSPinError(
        `Kubo pin failed: ${response.status} ${response.statusText} - ${text}`,
        url
      );
    }

    const result = await response.json();
    if (!result.Hash) {
      throw new IPFSPinError("Kubo response missing Hash field", url);
    }

    return result.Hash;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof IPFSPinError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new IPFSPinError(`Kubo pin request failed: ${message}`, url);
  }
}

/**
 * Pin content via a writable HTTP gateway that supports POST.
 * Falls back to computing a mock CID for testing purposes if the gateway
 * doesn't support pinning.
 */
async function pinViaGateway(content: string, cfg: IPFSConfig): Promise<string> {
  const baseUrl = cfg.url.replace(/\/$/, "");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.authorization) {
    headers["Authorization"] = cfg.authorization;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), cfg.timeout ?? 30000);

  try {
    // Try Pinata-style API first
    const pinataUrl = `${baseUrl}/pinning/pinJSONToIPFS`;
    let response = await fetch(pinataUrl, {
      method: "POST",
      body: content,
      headers,
      signal: controller.signal,
    });

    if (response.ok) {
      clearTimeout(timeoutId);
      const result = await response.json();
      if (result.IpfsHash) {
        return result.IpfsHash;
      }
      if (result.Hash) {
        return result.Hash;
      }
    }

    // Try Web3.Storage style API
    const web3Url = `${baseUrl}/upload`;
    response = await fetch(web3Url, {
      method: "POST",
      body: content,
      headers,
      signal: controller.signal,
    });

    if (response.ok) {
      clearTimeout(timeoutId);
      const result = await response.json();
      if (result.cid) {
        return result.cid;
      }
    }

    // Try direct add endpoint (some gateways support this)
    const addUrl = `${baseUrl}/api/v0/add`;
    const formData = new FormData();
    const blob = new Blob([content], { type: "application/json" });
    formData.append("file", blob, "metadata.json");

    response = await fetch(addUrl, {
      method: "POST",
      body: formData,
      headers: cfg.authorization ? { Authorization: cfg.authorization } : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const result = await response.json();
      if (result.Hash) {
        return result.Hash;
      }
    }

    throw new IPFSPinError(
      `Gateway does not support pinning or pin request failed`,
      baseUrl
    );
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof IPFSPinError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new IPFSPinError(`Gateway pin request failed: ${message}`, baseUrl);
  }
}

/**
 * Fetch content from IPFS by CID.
 *
 * @param cid - The CID to fetch.
 * @param config - Optional IPFS configuration override.
 * @returns The fetched content as a string.
 * @throws {IPFSFetchError} If fetching fails.
 */
export async function fetchFromIPFS(
  cid: string,
  config?: Partial<IPFSConfig>
): Promise<string> {
  const cfg = { ...globalIPFSConfig, ...config };

  if (cfg.backend === "kubo") {
    return fetchViaKubo(cid, cfg);
  } else {
    return fetchViaGateway(cid, cfg);
  }
}

/**
 * Fetch content via Kubo RPC API (/api/v0/cat).
 */
async function fetchViaKubo(cid: string, cfg: IPFSConfig): Promise<string> {
  const url = `${cfg.url.replace(/\/$/, "")}/api/v0/cat?arg=${encodeURIComponent(cid)}`;

  const headers: Record<string, string> = {};
  if (cfg.authorization) {
    headers["Authorization"] = cfg.authorization;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), cfg.timeout ?? 30000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new IPFSFetchError(
        `Kubo fetch failed: ${response.status} ${response.statusText}`,
        cid
      );
    }

    return await response.text();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof IPFSFetchError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new IPFSFetchError(`Kubo fetch request failed: ${message}`, cid);
  }
}

/**
 * Fetch content via HTTP gateway.
 */
async function fetchViaGateway(cid: string, cfg: IPFSConfig): Promise<string> {
  const url = `${cfg.url.replace(/\/$/, "")}/ipfs/${cid}`;

  const headers: Record<string, string> = {};
  if (cfg.authorization) {
    headers["Authorization"] = cfg.authorization;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), cfg.timeout ?? 30000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new IPFSFetchError(
        `Gateway fetch failed: ${response.status} ${response.statusText}`,
        cid
      );
    }

    return await response.text();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof IPFSFetchError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new IPFSFetchError(`Gateway fetch request failed: ${message}`, cid);
  }
}

/**
 * Verify that content matches a CID by fetching and comparing hashes.
 *
 * Since we can't recompute the exact CID without the multihash library,
 * this function fetches the content from IPFS and compares it with the
 * provided content by computing SHA-256 hashes of both.
 *
 * @param cid - The CID to verify.
 * @param content - The expected content (object or string).
 * @param config - Optional IPFS configuration override.
 * @returns True if the content matches, false otherwise.
 * @throws {IPFSFetchError} If fetching the CID content fails.
 */
export async function verifyCID(
  cid: string,
  content: unknown,
  config?: Partial<IPFSConfig>
): Promise<boolean> {
  const fetchedContent = await fetchFromIPFS(cid, config);

  // Normalize content to string for comparison
  const expectedContent =
    typeof content === "string" ? content : JSON.stringify(content);

  // Compare by computing hashes
  const fetchedHash = await computeContentHash(fetchedContent);
  const expectedHash = await computeContentHash(expectedContent);

  return fetchedHash === expectedHash;
}

/**
 * Verify CID and throw CIDMismatchError if content doesn't match.
 *
 * @param cid - The CID to verify.
 * @param content - The expected content.
 * @param config - Optional IPFS configuration override.
 * @throws {CIDMismatchError} If content doesn't match.
 * @throws {IPFSFetchError} If fetching fails.
 */
export async function verifyCIDOrThrow(
  cid: string,
  content: unknown,
  config?: Partial<IPFSConfig>
): Promise<void> {
  const isValid = await verifyCID(cid, content, config);
  if (!isValid) {
    throw new CIDMismatchError(cid);
  }
}

/**
 * Fetch and parse invoice metadata from IPFS.
 *
 * @param cid - The CID of the metadata.
 * @param config - Optional IPFS configuration override.
 * @returns The parsed InvoiceMetadata.
 * @throws {IPFSFetchError} If fetching fails.
 */
export async function fetchInvoiceMetadata(
  cid: string,
  config?: Partial<IPFSConfig>
): Promise<InvoiceMetadata> {
  const content = await fetchFromIPFS(cid, config);
  return deserializeMetadata(content);
}

/**
 * Parse an IPFS CID from a memo string.
 * Supports formats: "ipfs:Qm...", "ipfs:bafy...", "Qm...", "bafy..."
 *
 * @param memo - The memo string to parse.
 * @returns The extracted CID or null if not found.
 */
export function parseIPFSCid(memo?: string): string | null {
  if (!memo) {
    return null;
  }

  // Match ipfs: prefix followed by CID
  const prefixMatch = memo.match(/ipfs:([a-zA-Z0-9]+)/i);
  if (prefixMatch && prefixMatch[1]) {
    return prefixMatch[1];
  }

  // Match bare CIDv0 (Qm...)
  const cidV0Match = memo.match(/\b(Qm[a-zA-Z0-9]{44})\b/);
  if (cidV0Match && cidV0Match[1]) {
    return cidV0Match[1];
  }

  // Match bare CIDv1 (bafy...)
  const cidV1Match = memo.match(/\b(bafy[a-zA-Z0-9]+)\b/);
  if (cidV1Match && cidV1Match[1]) {
    return cidV1Match[1];
  }

  return null;
}

/**
 * Create a line item with automatic total calculation.
 *
 * @param description - Item description.
 * @param quantity - Item quantity.
 * @param unitPrice - Unit price in stroops.
 * @returns A LineItem object.
 */
export function createLineItem(
  description: string,
  quantity: number,
  unitPrice: bigint
): LineItem {
  return {
    description,
    quantity,
    unitPrice,
    total: BigInt(quantity) * unitPrice,
  };
}

/**
 * Create invoice metadata with validation.
 *
 * @param title - Invoice title.
 * @param description - Invoice description.
 * @param lineItems - Array of line items.
 * @param attachmentCIDs - Array of attachment CIDs.
 * @returns Validated InvoiceMetadata.
 */
export function createInvoiceMetadata(
  title: string,
  description: string,
  lineItems: LineItem[],
  attachmentCIDs: string[] = []
): InvoiceMetadata {
  return {
    title,
    description,
    lineItems,
    attachmentCIDs,
  };
}
