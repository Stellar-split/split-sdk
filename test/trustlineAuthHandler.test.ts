import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Stellar SDK mock (hoisting-safe — no top-level vi.fn() refs in factory)
// ---------------------------------------------------------------------------

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual("@stellar/stellar-sdk");
  return {
    ...(actual as Record<string, unknown>),
    Account: vi.fn().mockImplementation((id: string, seq: string) => ({
      accountId: () => id,
      sequenceNumber: () => seq,
      incrementSequenceNumber: vi.fn(),
    })),
    TransactionBuilder: vi.fn().mockImplementation(() => ({
      addOperation: vi.fn().mockReturnThis(),
      setTimeout: vi.fn().mockReturnThis(),
      build: vi.fn().mockReturnValue({ sign: vi.fn() }),
    })),
    BASE_FEE: "100",
    Asset: vi.fn().mockImplementation((code: string, issuer: string) => ({ code, issuer })),
    Keypair: {
      fromSecret: vi.fn().mockImplementation((secret: string) => ({
        publicKey: () => `PUB_${secret}`,
        secret: () => secret,
      })),
    },
    Operation: {
      setTrustLineFlags: vi.fn().mockReturnValue({ type: "setTrustLineFlags" }),
      allowTrust: vi.fn().mockReturnValue({ type: "allowTrust" }),
    },
    Horizon: { Server: vi.fn() },
  };
});

import { TrustlineAuthHandler } from "../src/trustlineAuthHandler.js";
import { Operation, Keypair } from "@stellar/stellar-sdk";
import type { TrustlineAuthRequest } from "../src/types.js";

const RECIPIENT = "GBRECIPIENT000000000000000000000000000000000000000000000000";
const ISSUER = "GBISSUER0000000000000000000000000000000000000000000000000000";
const ASSET = { code: "USDC", issuer: ISSUER };

function buildMockHorizonServer({
  authRequired = true,
  currentProtocolVersion = 21,
  submitHash = "abc123hash",
} = {}) {
  return {
    loadAccount: vi.fn().mockResolvedValue({
      accountId: () => ISSUER,
      sequenceNumber: () => "100",
      flags: { auth_required: authRequired, auth_revocable: true, auth_immutable: false },
    }),
    root: vi.fn().mockResolvedValue({ current_protocol_version: currentProtocolVersion }),
    submitTransaction: vi.fn().mockResolvedValue({ hash: submitHash }),
  };
}

describe("TrustlineAuthHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("checkAndRequest detects AUTH_REQUIRED and emits trustlineAuthRequired with the issuer's public key", async () => {
    const server = buildMockHorizonServer({ authRequired: true });
    const handler = new TrustlineAuthHandler(server as never, "Test SDF Network ; September 2015");

    const events: TrustlineAuthRequest[] = [];
    handler.on("trustlineAuthRequired", (e) => events.push(e));

    const result = await handler.checkAndRequest(RECIPIENT, ASSET);

    expect(result.authRequired).toBe(true);
    expect(result.status).toBe("required");
    expect(events).toHaveLength(1);
    expect(events[0]!.assetIssuer).toBe(ISSUER);
    expect(events[0]!.recipientId).toBe(RECIPIENT);
  });

  it("checkAndRequest does not emit when the issuer does not require authorization", async () => {
    const server = buildMockHorizonServer({ authRequired: false });
    const handler = new TrustlineAuthHandler(server as never, "Test SDF Network ; September 2015");

    const events: TrustlineAuthRequest[] = [];
    handler.on("trustlineAuthRequired", (e) => events.push(e));

    const result = await handler.checkAndRequest(RECIPIENT, ASSET);

    expect(result.authRequired).toBe(false);
    expect(result.status).toBe("not_required");
    expect(events).toHaveLength(0);
  });

  it("grantAuth submits SetTrustLineFlags on protocol >= 18 and emits trustlineAuthGranted", async () => {
    const server = buildMockHorizonServer({ currentProtocolVersion: 21, submitHash: "hash-settrustlineflags" });
    const handler = new TrustlineAuthHandler(server as never, "Test SDF Network ; September 2015");

    const events: TrustlineAuthRequest[] = [];
    handler.on("trustlineAuthGranted", (e) => events.push(e));

    const issuerKeypair = Keypair.fromSecret("SISSUERSECRET");
    const result = await handler.grantAuth(RECIPIENT, ASSET, issuerKeypair as never);

    expect(Operation.setTrustLineFlags).toHaveBeenCalledWith(
      expect.objectContaining({ trustor: RECIPIENT, flags: { authorized: true } }),
    );
    expect(Operation.allowTrust).not.toHaveBeenCalled();
    expect(result.status).toBe("granted");
    expect(result.operationType).toBe("setTrustLineFlags");
    expect(result.txHash).toBe("hash-settrustlineflags");
    expect(events).toHaveLength(1);
  });

  it("grantAuth falls back to AllowTrust on protocol < 18", async () => {
    const server = buildMockHorizonServer({ currentProtocolVersion: 17, submitHash: "hash-allowtrust" });
    const handler = new TrustlineAuthHandler(server as never, "Test SDF Network ; September 2015");

    const issuerKeypair = Keypair.fromSecret("SISSUERSECRET");
    const result = await handler.grantAuth(RECIPIENT, ASSET, issuerKeypair as never);

    expect(Operation.allowTrust).toHaveBeenCalledWith(
      expect.objectContaining({ trustor: RECIPIENT, assetCode: ASSET.code, authorize: true }),
    );
    expect(Operation.setTrustLineFlags).not.toHaveBeenCalled();
    expect(result.status).toBe("granted");
    expect(result.operationType).toBe("allowTrust");
    expect(result.txHash).toBe("hash-allowtrust");
  });
});
