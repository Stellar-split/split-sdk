import type { RPCNode } from "./types.js";

const DEFAULT_DISCOVERY_URL = "https://horizon.stellar.org/network_info";

/**
 * Fetch the Stellar node list and benchmark each endpoint by latency.
 *
 * @param discoveryUrl - URL that returns a JSON array of RPC node URLs.
 *                       Defaults to the public Horizon network_info endpoint.
 * @returns Nodes sorted by latencyMs ascending; unhealthy nodes included.
 */
export async function discoverRPCNodes(
  discoveryUrl = DEFAULT_DISCOVERY_URL
): Promise<RPCNode[]> {
  const nodeUrls = await fetchNodeList(discoveryUrl);
  const nodes = await Promise.all(nodeUrls.map(pingNode));
  return nodes.sort((a, b) => a.latencyMs - b.latencyMs);
}

async function fetchNodeList(discoveryUrl: string): Promise<string[]> {
  const res = await fetch(discoveryUrl);
  if (!res.ok) throw new Error(`Discovery fetch failed: ${res.status} ${res.statusText}`);
  const data: unknown = await res.json();
  if (Array.isArray(data)) {
    return data.filter((u): u is string => typeof u === "string");
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj["nodes"])) {
      return (obj["nodes"] as unknown[]).filter((u): u is string => typeof u === "string");
    }
    if (Array.isArray(obj["rpc_urls"])) {
      return (obj["rpc_urls"] as unknown[]).filter((u): u is string => typeof u === "string");
    }
  }
  return [];
}

async function pingNode(url: string): Promise<RPCNode> {
  const start = Date.now();
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) });
    const latencyMs = Date.now() - start;
    return { url, latencyMs, healthy: res.ok };
  } catch {
    return { url, latencyMs: Date.now() - start, healthy: false };
  }
}
