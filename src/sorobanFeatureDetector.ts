/**
 * Protocol-version feature detection for StellarSplit.
 *
 * Some classic Stellar operations were superseded by newer equivalents at a
 * given protocol version — e.g. `SetTrustLineFlags` replaced the legacy
 * `AllowTrust` operation at protocol 18. Used by
 * {@link ./trustlineAuthHandler.js} to pick the correct operation for the
 * network it is submitting to.
 */

import type { Horizon } from "@stellar/stellar-sdk";

/** Protocol version at which `SetTrustLineFlags` replaced `AllowTrust`. */
export const SET_TRUST_LINE_FLAGS_PROTOCOL = 18;

/**
 * Detect the current protocol version of the network behind `server`.
 *
 * @param server - Horizon server instance.
 * @returns The network's current protocol version.
 */
export async function detectProtocolVersion(server: Horizon.Server): Promise<number> {
  const root = await server.root();
  return root.current_protocol_version;
}

/** Whether the given protocol version supports the `SetTrustLineFlags` operation. */
export function supportsSetTrustLineFlags(protocolVersion: number): boolean {
  return protocolVersion >= SET_TRUST_LINE_FLAGS_PROTOCOL;
}
