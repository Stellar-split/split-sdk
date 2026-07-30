/**
 * SEP-31 cross-border direct payment initiator for StellarSplit.
 *
 * Abstracts the full initiator-side SEP-31 protocol flow: resolving the
 * receiving anchor's `DIRECT_PAYMENT_SERVER` from its stellar.toml, reading
 * required fields from `/info`, submitting the payment via `/send`, and
 * polling `/transaction/:id` for status until a terminal state is reached.
 *
 * Follows the same typed-event-emitter and anchor-polling patterns used by
 * {@link ./sep24Handler.js} (`Sep24Handler`).
 *
 * @see https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0031.md
 */

import { StellarToml } from "@stellar/stellar-sdk";
import { TypedEventEmitter } from "../events/TypedEventEmitter.js";
import type {
  Sep31FieldSpec,
  Sep31PaymentRecord,
  Sep31RequiredFields,
  Sep31Status,
  Sep31StatusChangedEvent,
} from "../types.js";

// ---------------------------------------------------------------------------
// Event map
// ---------------------------------------------------------------------------

/** Events emitted by {@link Sep31Initiator}. */
export interface Sep31InitiatorEventMap {
  sep31StatusChanged: Sep31StatusChangedEvent;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Asset descriptor for the payment. */
export interface Sep31Asset {
  /** Asset code (e.g. "USDC"). */
  code: string;
  /** Asset issuer's Stellar address. */
  issuer: string;
}

/**
 * Party information for the sender or receiver of a SEP-31 payment.
 *
 * `id`, when present, is a SEP-12 customer ID for this party already known
 * to the anchor. Any other keys are sent as anchor-required transaction
 * fields (as discovered via {@link Sep31Initiator.getRequiredFields}).
 */
export type Sep31PartyInfo = Record<string, string>;

/** Parameters for {@link Sep31Initiator.initiate}. */
export interface Sep31InitiateParams {
  /** Asset to send. */
  asset: Sep31Asset;
  /** Payment amount as a decimal string (e.g. "100.00"). */
  amount: string;
  /** Information about the receiving party. */
  receiverInfo: Sep31PartyInfo;
  /** Information about the sending party. */
  senderInfo: Sep31PartyInfo;
  /** Home domain of the receiving anchor (e.g. "anchor.example.com"). */
  receiverAnchorDomain: string;
  /** SEP-10 JWT for the receiving anchor, attached to every request. */
  jwt: string;
}

interface Sep31InfoResponse {
  receive?: Record<
    string,
    {
      min_amount?: number;
      max_amount?: number;
      fields?: { transaction?: Record<string, { description: string; choices?: string[]; optional?: boolean }> };
    }
  >;
}

interface Sep31SendResponse {
  id: string;
  stellar_account_id?: string;
  stellar_memo?: string;
  stellar_memo_type?: string;
}

interface Sep31TransactionResponse {
  transaction: {
    id: string;
    status: string;
    amount_in?: string;
    stellar_transaction_id?: string | null;
    started_at?: string;
    updated_at?: string;
    required_info_message?: string | null;
    message?: string | null;
  };
}

const TERMINAL_STATUSES: Sep31Status[] = ["completed", "error"];

const VALID_STATUSES: Sep31Status[] = [
  "pending_sender",
  "pending_receiver",
  "pending_transaction_info_update",
  "pending_stellar",
  "pending_external",
  "completed",
  "error",
];

// ---------------------------------------------------------------------------
// Initiator
// ---------------------------------------------------------------------------

/**
 * Drives the initiator side of a SEP-31 cross-border direct payment.
 *
 * @example
 * ```typescript
 * const initiator = new Sep31Initiator();
 * initiator.on("sep31StatusChanged", (e) => console.log(e.payment.status));
 *
 * const fields = await initiator.getRequiredFields("anchor.example.com", { code: "USDC", issuer: "G..." });
 * const payment = await initiator.initiate({
 *   asset: { code: "USDC", issuer: "G..." },
 *   amount: "100.00",
 *   receiverInfo: { routing_number: "121122676" },
 *   senderInfo: {},
 *   receiverAnchorDomain: "anchor.example.com",
 *   jwt: sep10Token,
 * });
 *
 * for await (const update of initiator.pollStatus(payment.id, "anchor.example.com")) {
 *   if (update.status === "completed") break;
 * }
 * ```
 */
export class Sep31Initiator extends TypedEventEmitter<Sep31InitiatorEventMap> {
  private payment: Sep31PaymentRecord | null = null;
  private jwt = "";

  /**
   * Fetch the receiving anchor's `/info` endpoint and return the typed field
   * schema required to send `asset`.
   */
  async getRequiredFields(anchorDomain: string, asset: Sep31Asset): Promise<Sep31RequiredFields> {
    const serverUrl = await resolveDirectPaymentServer(anchorDomain);
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/info`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`SEP-31 /info request failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as Sep31InfoResponse;
    const assetInfo = data.receive?.[asset.code];
    if (!assetInfo) {
      throw new Error(`Asset ${asset.code} is not supported for receive by anchor ${anchorDomain}`);
    }

    const transactionFields: Record<string, Sep31FieldSpec> = {};
    for (const [key, spec] of Object.entries(assetInfo.fields?.transaction ?? {})) {
      transactionFields[key] = {
        description: spec.description,
        choices: spec.choices,
        optional: spec.optional,
      };
    }

    return {
      minAmount: assetInfo.min_amount,
      maxAmount: assetInfo.max_amount,
      transactionFields,
    };
  }

  /**
   * Complete the `/send` call to initiate a SEP-31 payment and store the
   * returned transaction record. The SEP-10 JWT passed here is reused
   * automatically by subsequent {@link pollStatus} calls.
   */
  async initiate(params: Sep31InitiateParams): Promise<Sep31PaymentRecord> {
    const serverUrl = await resolveDirectPaymentServer(params.receiverAnchorDomain);
    this.jwt = params.jwt;

    const { id: senderId, ...senderFields } = params.senderInfo;
    const { id: receiverId, ...receiverFields } = params.receiverInfo;

    const body: Record<string, unknown> = {
      amount: params.amount,
      asset_code: params.asset.code,
      asset_issuer: params.asset.issuer,
    };
    if (senderId) body.sender_id = senderId;
    if (receiverId) body.receiver_id = receiverId;
    if (Object.keys(senderFields).length || Object.keys(receiverFields).length) {
      body.fields = { transaction: { ...senderFields, ...receiverFields } };
    }

    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.jwt}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`SEP-31 /send request failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as Sep31SendResponse;
    const now = Date.now();

    const record: Sep31PaymentRecord = {
      id: data.id,
      status: "pending_receiver",
      assetCode: params.asset.code,
      assetIssuer: params.asset.issuer,
      amount: params.amount,
      anchorDomain: params.receiverAnchorDomain,
      stellarTxId: null,
      startedAt: now,
      updatedAt: now,
      requiredInfoMessage: null,
      errorMessage: null,
    };

    this.payment = record;
    this.emit("sep31StatusChanged", { payment: record, previousStatus: null });

    return record;
  }

  /**
   * Poll `/transaction/:id` until the payment reaches a terminal state
   * (`completed` or `error`), yielding a status update each time it changes.
   */
  async *pollStatus(
    transactionId: string,
    anchorDomain: string,
    intervalMs = 3000,
  ): AsyncIterableIterator<Sep31PaymentRecord> {
    const serverUrl = await resolveDirectPaymentServer(anchorDomain);
    const url = `${serverUrl.replace(/\/$/, "")}/transaction/${encodeURIComponent(transactionId)}`;

    let previousStatus: Sep31Status | null = this.payment?.status ?? null;

    while (true) {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.jwt}` },
      });

      if (response.ok) {
        const data = (await response.json()) as Sep31TransactionResponse;
        const record = this._applyTransaction(data.transaction, anchorDomain);

        if (record.status !== previousStatus) {
          this.emit("sep31StatusChanged", { payment: record, previousStatus });
          previousStatus = record.status;
          yield record;
        }

        if (TERMINAL_STATUSES.includes(record.status)) {
          return;
        }
      }

      await sleep(intervalMs);
    }
  }

  /** Get the current payment record, or null if {@link initiate} has not been called. */
  getPayment(): Sep31PaymentRecord | null {
    return this.payment;
  }

  private _applyTransaction(
    txn: Sep31TransactionResponse["transaction"],
    anchorDomain: string,
  ): Sep31PaymentRecord {
    const status = normalizeStatus(txn.status);
    const base = this.payment ?? {
      id: txn.id,
      status,
      assetCode: "",
      assetIssuer: "",
      amount: txn.amount_in ?? "0",
      anchorDomain,
      stellarTxId: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      requiredInfoMessage: null,
      errorMessage: null,
    };

    const record: Sep31PaymentRecord = {
      ...base,
      id: txn.id,
      status,
      stellarTxId: txn.stellar_transaction_id ?? base.stellarTxId,
      updatedAt: Date.now(),
      requiredInfoMessage: txn.required_info_message ?? null,
      errorMessage: status === "error" ? (txn.message ?? null) : null,
    };

    this.payment = record;
    return record;
  }
}

// ---------------------------------------------------------------------------
// Helper: resolve the receiving anchor's DIRECT_PAYMENT_SERVER
// ---------------------------------------------------------------------------

/**
 * Fetch the `DIRECT_PAYMENT_SERVER` URL from an anchor's stellar.toml.
 *
 * @param homeDomain - The anchor's home domain (e.g. "anchor.example.com").
 * @throws When the domain does not publish a `DIRECT_PAYMENT_SERVER`.
 */
export async function resolveDirectPaymentServer(homeDomain: string): Promise<string> {
  const toml = await StellarToml.Resolver.resolve(homeDomain);
  const server = (toml as Record<string, unknown>).DIRECT_PAYMENT_SERVER as string | undefined;
  if (!server) {
    throw new Error(`Anchor ${homeDomain} does not publish a DIRECT_PAYMENT_SERVER in stellar.toml`);
  }
  return server;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeStatus(raw: string): Sep31Status {
  const status = raw.toLowerCase().trim();
  return (VALID_STATUSES as string[]).includes(status) ? (status as Sep31Status) : "pending_receiver";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
