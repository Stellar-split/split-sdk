/**
 * Freighter wallet adapter for StellarSplit.
 *
 * Wraps @stellar/freighter-api with typed helpers.
 */

import {
  isConnected,
  getAddress,
  signTransaction as freighterSignTransaction,
  requestAccess,
} from "@stellar/freighter-api";
import { WalletNotConnectedError } from "./errors.js";

/** Connect to the Freighter wallet extension and request access. */
export async function connectWallet(): Promise<string> {
  const { isConnected: connected } = await isConnected();
  if (!connected) {
    throw new WalletNotConnectedError(
      "Freighter wallet is not installed. Please install it from https://freighter.app"
    );
  }
  await requestAccess();
  const { address } = await getAddress();
  return address;
}

/** Return the connected wallet's public key (G... address). */
export async function getPublicKey(): Promise<string> {
  const { isConnected: connected } = await isConnected();
  if (!connected) {
    throw new WalletNotConnectedError("Freighter wallet is not connected.");
  }
  const { address } = await getAddress();
  return address;
}

/**
 * Sign a Stellar transaction XDR string using Freighter.
 *
 * @param xdr     - Base64-encoded transaction XDR.
 * @param network - Network passphrase (e.g. "Test SDF Network ; September 2015").
 * @returns Signed transaction XDR.
 */
export async function signTransaction(
  xdr: string,
  network: string
): Promise<string> {
  const result = await freighterSignTransaction(xdr, { networkPassphrase: network });
  // v3 API returns { signedTxXdr } or a plain string depending on version
  if (typeof result === "string") return result;
  return (result as { signedTxXdr: string }).signedTxXdr;
}
