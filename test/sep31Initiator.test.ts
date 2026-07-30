import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual("@stellar/stellar-sdk");
  return {
    ...(actual as Record<string, unknown>),
    StellarToml: {
      Resolver: {
        resolve: vi.fn(),
      },
    },
  };
});

import { Sep31Initiator, resolveDirectPaymentServer } from "../src/sep/sep31Initiator.js";
import { StellarToml } from "@stellar/stellar-sdk";
import type { Sep31PaymentRecord } from "../src/types.js";

const ANCHOR_DOMAIN = "anchor.example.com";
const DIRECT_PAYMENT_SERVER = "https://anchor.example.com/sep31";
const ASSET = { code: "USDC", issuer: "GISSUER00000000000000000000000000000000000000000000000000000" };

function mockToml() {
  (StellarToml.Resolver.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
    DIRECT_PAYMENT_SERVER: DIRECT_PAYMENT_SERVER,
  });
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let callIndex = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const resp = responses[Math.min(callIndex, responses.length - 1)]!;
    callIndex++;
    return {
      ok: resp.status < 400,
      status: resp.status,
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    };
  });
  return calls;
}

describe("Sep31Initiator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getRequiredFields calls the anchor /info endpoint and returns the typed field schema", async () => {
    mockToml();
    mockFetchSequence([
      {
        status: 200,
        body: {
          receive: {
            USDC: {
              min_amount: 1,
              max_amount: 10000,
              fields: {
                transaction: {
                  routing_number: { description: "Routing number", optional: false },
                },
              },
            },
          },
        },
      },
    ]);

    const initiator = new Sep31Initiator();
    const fields = await initiator.getRequiredFields(ANCHOR_DOMAIN, ASSET);

    expect(fields.minAmount).toBe(1);
    expect(fields.maxAmount).toBe(10000);
    expect(fields.transactionFields.routing_number).toEqual({
      description: "Routing number",
      choices: undefined,
      optional: false,
    });
  });

  it("resolveDirectPaymentServer throws when the anchor does not publish DIRECT_PAYMENT_SERVER", async () => {
    (StellarToml.Resolver.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({});
    await expect(resolveDirectPaymentServer(ANCHOR_DOMAIN)).rejects.toThrow("DIRECT_PAYMENT_SERVER");
  });

  it("initiate completes the /send call, stores the transaction ID, and attaches the SEP-10 JWT", async () => {
    mockToml();
    const calls = mockFetchSequence([{ status: 200, body: { id: "txn-abc123" } }]);

    const initiator = new Sep31Initiator();
    const payment = await initiator.initiate({
      asset: ASSET,
      amount: "100.00",
      receiverInfo: { routing_number: "121122676" },
      senderInfo: {},
      receiverAnchorDomain: ANCHOR_DOMAIN,
      jwt: "test-jwt",
    });

    expect(payment.id).toBe("txn-abc123");
    expect(payment.status).toBe("pending_receiver");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${DIRECT_PAYMENT_SERVER}/send`);
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer test-jwt");
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.amount).toBe("100.00");
    expect(body.asset_code).toBe("USDC");
    expect(body.fields.transaction.routing_number).toBe("121122676");
  });

  it("pollStatus yields status updates until a terminal state, reusing the stored JWT", async () => {
    mockToml();
    const calls = mockFetchSequence([
      { status: 200, body: { id: "txn-abc123" } }, // /send
      { status: 200, body: { transaction: { id: "txn-abc123", status: "pending_receiver" } } },
      { status: 200, body: { transaction: { id: "txn-abc123", status: "pending_stellar" } } },
      {
        status: 200,
        body: {
          transaction: { id: "txn-abc123", status: "completed", stellar_transaction_id: "stellar-tx-1" },
        },
      },
    ]);

    const initiator = new Sep31Initiator();
    const events: Sep31PaymentRecord[] = [];
    initiator.on("sep31StatusChanged", (e) => events.push(e.payment));

    const payment = await initiator.initiate({
      asset: ASSET,
      amount: "50",
      receiverInfo: {},
      senderInfo: {},
      receiverAnchorDomain: ANCHOR_DOMAIN,
      jwt: "test-jwt",
    });

    const updates: Sep31PaymentRecord[] = [];
    for await (const update of initiator.pollStatus(payment.id, ANCHOR_DOMAIN, 1)) {
      updates.push(update);
    }

    expect(updates.map((u) => u.status)).toEqual(["pending_stellar", "completed"]);
    expect(updates.at(-1)!.stellarTxId).toBe("stellar-tx-1");

    // initiate's creation event + 2 status-change events during polling
    expect(events).toHaveLength(3);

    const pollCall = calls.find((c) => c.url.includes("/transaction/txn-abc123"));
    expect(pollCall).toBeDefined();
    expect((pollCall!.init!.headers as Record<string, string>).Authorization).toBe("Bearer test-jwt");
  });
});
