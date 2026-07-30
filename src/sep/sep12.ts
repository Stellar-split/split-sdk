/**
 * SEP-12 KYC field submission handler for StellarSplit.
 *
 * Wraps the anchor `PUT /customer` and `GET /customer` endpoints used by
 * SEP-31 cross-border payment flows: derives the `KYC_SERVER` URL from
 * the anchor's stellar.toml, uploads text fields and binary documents in
 * a single multipart request, attaches the SEP-10 bearer token
 * automatically, and polls for approval status.
 *
 * @see https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md
 */

import { StellarTomlResolver } from "@stellar/stellar-sdk";
import { KycNeedsInfoError } from "../types.js";
import type { KycFields, KycDocument, KycStatus } from "../types.js";

/** Configuration for {@link Sep12Client}. */
export interface Sep12ClientOptions {
  /** Anchor home domain used to resolve stellar.toml, e.g. "anchor.example.com". */
  homeDomain: string;
  /** SEP-10 JWT, attached automatically as `Authorization: Bearer <jwt>`. */
  jwt: string;
  /** Stellar account being KYC'd. */
  account: string;
  /** Optional memo identifying the account (for shared/omnibus accounts). */
  memo?: string;
  /** Memo type, required alongside `memo` when set. */
  memoType?: string;
}

/** Options for {@link Sep12Client.pollUntilResolved}. */
export interface Sep12PollOptions {
  /** Interval between status checks in milliseconds. Default: 3000. */
  intervalMs?: number;
  /** Maximum time to poll before giving up in milliseconds. Default: 120000. */
  timeoutMs?: number;
}

interface Sep12PutCustomerResponse {
  id: string;
}

interface Sep12GetCustomerResponse {
  id?: string;
  status: string;
  fields?: Record<string, unknown>;
  message?: string;
}

/**
 * Client for the SEP-12 KYC submission and status-check flow.
 *
 * @example
 * ```typescript
 * const kyc = new Sep12Client({ homeDomain: "anchor.example.com", jwt, account });
 * const { id } = await kyc.putCustomer({ first_name: "Ada", last_name: "Lovelace" });
 * const accepted = await kyc.pollUntilResolved(id);
 * ```
 */
export class Sep12Client {
  private readonly homeDomain: string;
  private readonly jwt: string;
  private readonly account: string;
  private readonly memo?: string;
  private readonly memoType?: string;
  private kycServerUrl: string | null = null;

  constructor(options: Sep12ClientOptions) {
    this.homeDomain = options.homeDomain;
    this.jwt = options.jwt;
    this.account = options.account;
    this.memo = options.memo;
    this.memoType = options.memoType;
  }

  /**
   * Submits KYC text fields and optional binary documents to the anchor
   * in a single `multipart/form-data` PUT request.
   *
   * @param fields - SEP-9 text fields, e.g. `{ first_name, last_name, email_address }`.
   * @param docs - Optional binary attachments, e.g. photo ID scans.
   * @param customerId - Existing customer id, when updating a prior submission.
   * @returns The anchor-assigned customer id.
   */
  async putCustomer(
    fields: KycFields,
    docs: KycDocument[] = [],
    customerId?: string
  ): Promise<{ id: string }> {
    const base = await this.resolveKycServer();
    const form = new FormData();

    form.append("account", this.account);
    if (this.memo) form.append("memo", this.memo);
    if (this.memoType) form.append("memo_type", this.memoType);
    if (customerId) form.append("id", customerId);

    for (const [key, value] of Object.entries(fields)) {
      form.append(key, value);
    }

    for (const doc of docs) {
      const blob =
        doc.content instanceof Blob ? doc.content : new Blob([doc.content], { type: doc.contentType });
      form.append(doc.field, blob, doc.filename);
    }

    const response = await fetch(`${base}/customer`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.jwt}`,
      },
      body: form,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`SEP-12 putCustomer failed (${response.status}): ${errorText}`);
    }

    return (await response.json()) as Sep12PutCustomerResponse;
  }

  /**
   * Fetches the current KYC status for a customer.
   *
   * Always resolves to a typed {@link KycStatus}; use
   * {@link pollUntilResolved} if you want `NEEDS_INFO` / `REJECTED` to be
   * raised as a {@link KycNeedsInfoError} instead.
   */
  async getCustomer(id: string): Promise<KycStatus> {
    const base = await this.resolveKycServer();
    const url = new URL(`${base}/customer`);
    url.searchParams.set("id", id);
    url.searchParams.set("account", this.account);
    if (this.memo) url.searchParams.set("memo", this.memo);
    if (this.memoType) url.searchParams.set("memo_type", this.memoType);

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.jwt}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`SEP-12 getCustomer failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as Sep12GetCustomerResponse;
    return toKycStatus(id, data);
  }

  /**
   * Polls {@link getCustomer} until the status is terminal.
   *
   * @throws {KycNeedsInfoError} when the anchor reports `NEEDS_INFO` or `REJECTED`.
   * @returns The accepted status once approved.
   */
  async pollUntilResolved(
    id: string,
    options: Sep12PollOptions = {}
  ): Promise<Extract<KycStatus, { status: "ACCEPTED" }>> {
    const intervalMs = options.intervalMs ?? 3000;
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);

    for (;;) {
      const status = await this.getCustomer(id);

      if (status.status === "ACCEPTED") {
        return status;
      }
      if (status.status === "NEEDS_INFO" || status.status === "REJECTED") {
        throw new KycNeedsInfoError(status);
      }

      if (Date.now() >= deadline) {
        throw new Error(`SEP-12 customer ${id} did not resolve within the polling timeout`);
      }

      await sleep(intervalMs);
    }
  }

  private async resolveKycServer(): Promise<string> {
    if (this.kycServerUrl) return this.kycServerUrl;

    const toml = await StellarTomlResolver.resolve(this.homeDomain);
    const kycServer = (toml.KYC_SERVER as string | undefined) ?? (toml.TRANSFER_SERVER_SEP0024 as string | undefined);
    if (!kycServer) {
      throw new Error(`No KYC_SERVER found in stellar.toml for ${this.homeDomain}`);
    }

    this.kycServerUrl = kycServer.replace(/\/$/, "");
    return this.kycServerUrl;
  }
}

/** Maps a raw anchor response body to the typed {@link KycStatus} union. */
function toKycStatus(id: string, data: Sep12GetCustomerResponse): KycStatus {
  const status = data.status.toUpperCase().trim();

  switch (status) {
    case "ACCEPTED":
      return { status: "ACCEPTED", id: data.id ?? id };
    case "NEEDS_INFO":
      return {
        status: "NEEDS_INFO",
        id: data.id ?? id,
        missingFields: data.fields ? Object.keys(data.fields) : [],
        message: data.message,
      };
    case "REJECTED":
      return { status: "REJECTED", id: data.id ?? id, message: data.message };
    case "PROCESSING":
    default:
      return { status: "PROCESSING", id: data.id ?? id, message: data.message };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
