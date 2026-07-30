/**
 * Auth-required trustline request handler for StellarSplit.
 *
 * Assets issued by an account with the `AUTH_REQUIRED` flag set require the
 * issuer to explicitly approve each trustline before a recipient can hold
 * the asset. This module detects the condition via
 * {@link ./preflightChecker.js} (`checkTrustlineAuthRequirement`, backed by
 * {@link ./accountFlagsInspector.js}), notifies the issuer through a typed
 * event, and builds/submits the approval transaction on the issuer's behalf —
 * preferring `SetTrustLineFlags` (protocol >= 18) and falling back to the
 * legacy `AllowTrust` operation on older networks, as detected by
 * {@link ./sorobanFeatureDetector.js}.
 */

import { Account, Asset, Horizon, Keypair, Operation, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";
import { TypedEventEmitter } from "./events/TypedEventEmitter.js";
import { checkTrustlineAuthRequirement } from "./preflightChecker.js";
import { detectProtocolVersion, supportsSetTrustLineFlags } from "./sorobanFeatureDetector.js";
import type { TrustlineAuthRequest } from "./types.js";

/** Events emitted by {@link TrustlineAuthHandler}. */
export interface TrustlineAuthHandlerEventMap {
  trustlineAuthRequired: TrustlineAuthRequest;
  trustlineAuthGranted: TrustlineAuthRequest;
  [key: string]: unknown;
}

/** Asset descriptor identifying a non-native Stellar asset. */
export interface TrustlineAuthAsset {
  /** Asset code (e.g. "USDC"). */
  code: string;
  /** Asset issuer's Stellar address. */
  issuer: string;
}

/**
 * Detects when a recipient's trustline needs issuer approval, and
 * facilitates the approval transaction on the issuer's behalf.
 *
 * @example
 * ```typescript
 * const handler = new TrustlineAuthHandler(horizonServer, networkPassphrase);
 * handler.on("trustlineAuthRequired", ({ recipientId, assetIssuer }) => {
 *   notifyIssuer(assetIssuer, recipientId);
 * });
 *
 * const check = await handler.checkAndRequest(recipientId, { code: "USDC", issuer });
 * if (check.authRequired) {
 *   await handler.grantAuth(recipientId, { code: "USDC", issuer }, issuerKeypair);
 * }
 * ```
 */
export class TrustlineAuthHandler extends TypedEventEmitter<TrustlineAuthHandlerEventMap> {
  private readonly server: Horizon.Server;
  private readonly networkPassphrase: string;

  constructor(server: Horizon.Server, networkPassphrase: string) {
    super();
    this.server = server;
    this.networkPassphrase = networkPassphrase;
  }

  /**
   * Detect whether `asset` requires issuer authorization for `recipientId`'s
   * trustline. Emits `trustlineAuthRequired` (with the issuer's public key)
   * when it does.
   */
  async checkAndRequest(recipientId: string, asset: TrustlineAuthAsset): Promise<TrustlineAuthRequest> {
    const { authRequired } = await checkTrustlineAuthRequirement(this.server, asset.issuer);

    const request: TrustlineAuthRequest = {
      recipientId,
      assetCode: asset.code,
      assetIssuer: asset.issuer,
      authRequired,
      status: authRequired ? "required" : "not_required",
      requestedAt: Date.now(),
    };

    if (authRequired) {
      this.emit("trustlineAuthRequired", request);
    }

    return request;
  }

  /**
   * Build and submit the authorization operation for `recipientId`'s
   * trustline, signed by `issuerKeypair`.
   *
   * Uses `SetTrustLineFlags` (authorized) on protocol >= 18, and falls back
   * to the legacy `AllowTrust` operation on older networks. Emits
   * `trustlineAuthGranted` after successful submission.
   */
  async grantAuth(
    recipientId: string,
    asset: TrustlineAuthAsset,
    issuerKeypair: Keypair,
  ): Promise<TrustlineAuthRequest> {
    const protocolVersion = await detectProtocolVersion(this.server);
    const account = await this.server.loadAccount(issuerKeypair.publicKey());
    const sourceAccount = new Account(account.accountId(), account.sequenceNumber());

    const operationType = supportsSetTrustLineFlags(protocolVersion) ? "setTrustLineFlags" : "allowTrust";

    const operation =
      operationType === "setTrustLineFlags"
        ? Operation.setTrustLineFlags({
            trustor: recipientId,
            asset: new Asset(asset.code, asset.issuer),
            flags: { authorized: true },
          })
        : Operation.allowTrust({
            trustor: recipientId,
            assetCode: asset.code,
            authorize: true,
          });

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    tx.sign(issuerKeypair);
    const result = await this.server.submitTransaction(tx);

    const granted: TrustlineAuthRequest = {
      recipientId,
      assetCode: asset.code,
      assetIssuer: asset.issuer,
      authRequired: true,
      status: "granted",
      requestedAt: Date.now(),
      operationType,
      txHash: result.hash,
    };

    this.emit("trustlineAuthGranted", granted);
    return granted;
  }
}
