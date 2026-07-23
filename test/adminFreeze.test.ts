/**
 * Tests for adminFreezeInvoice and adminUnfreezeInvoice.
 *
 * Coverage:
 *  - Successful freeze / unfreeze returns the correct result shape
 *  - Admin keypair verification rejects mismatched keypairs
 *  - Audit events are emitted on both success and failure
 *  - Submission errors are propagated to the caller
 *  - isAdminOperationError type guard
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { StellarSplitClient } from "../src/client.js";
import {
  AdminOperationError,
  isAdminOperationError,
} from "../src/errors.js";
import { AuditLogger } from "../src/auditLogger.js";
import type { AdminFreezeResult, AdminUnfreezeResult } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(adminKeypair?: Keypair): StellarSplitClient {
  return new StellarSplitClient({
    rpcUrl: "https://example.com",
    networkPassphrase: "Test Network",
    contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    ...(adminKeypair ? { adminKeypair } : {}),
  });
}

const MOCK_TX_HASH =
  "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

function mockSubmitSuccess(client: StellarSplitClient) {
  return vi
    .spyOn(client as any, "_submitTxWithKeypair")
    .mockResolvedValue({ txHash: MOCK_TX_HASH, returnValue: {} });
}

function mockSubmitFailure(client: StellarSplitClient, err: Error) {
  return vi
    .spyOn(client as any, "_submitTxWithKeypair")
    .mockRejectedValue(err);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// adminFreezeInvoice
// ---------------------------------------------------------------------------

describe("adminFreezeInvoice", () => {
  it("returns an AdminFreezeResult with correct fields on success", async () => {
    const adminKp = Keypair.random();
    const client = makeClient();
    mockSubmitSuccess(client);

    const result: AdminFreezeResult = await client.adminFreezeInvoice(
      "42",
      "suspected fraud",
      adminKp,
    );

    expect(result.txHash).toBe(MOCK_TX_HASH);
    expect(result.invoiceId).toBe("42");
    expect(result.adminAddress).toBe(adminKp.publicKey());
    expect(result.reason).toBe("suspected fraud");
    expect(typeof result.timestamp).toBe("number");
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it("passes the admin keypair and address to _submitTxWithKeypair", async () => {
    const adminKp = Keypair.random();
    const client = makeClient();
    const spy = mockSubmitSuccess(client);

    await client.adminFreezeInvoice("1", "test", adminKp);

    expect(spy).toHaveBeenCalledOnce();
    const [sourceAddress, , keypairArg] = spy.mock.calls[0] as [
      string,
      unknown,
      Keypair,
    ];
    expect(sourceAddress).toBe(adminKp.publicKey());
    expect(keypairArg.publicKey()).toBe(adminKp.publicKey());
  });

  it("propagates submission errors", async () => {
    const adminKp = Keypair.random();
    const client = makeClient();
    mockSubmitFailure(client, new Error("RPC unavailable"));

    await expect(
      client.adminFreezeInvoice("99", "reason", adminKp),
    ).rejects.toThrow("RPC unavailable");
  });

  it("throws AdminOperationError when config adminKeypair differs from passed keypair", async () => {
    const configKp = Keypair.random();
    const otherKp = Keypair.random();
    const client = makeClient(configKp);

    await expect(
      client.adminFreezeInvoice("5", "fraud", otherKp),
    ).rejects.toThrow(AdminOperationError);
  });

  it("AdminOperationError carries the mismatched adminAddress", async () => {
    const configKp = Keypair.random();
    const otherKp = Keypair.random();
    const client = makeClient(configKp);

    let caught: unknown;
    try {
      await client.adminFreezeInvoice("5", "fraud", otherKp);
    } catch (e) {
      caught = e;
    }

    expect(isAdminOperationError(caught)).toBe(true);
    expect((caught as AdminOperationError).adminAddress).toBe(
      otherKp.publicKey(),
    );
  });

  it("succeeds when the config adminKeypair matches the passed keypair", async () => {
    const adminKp = Keypair.random();
    const client = makeClient(adminKp);
    mockSubmitSuccess(client);

    await expect(
      client.adminFreezeInvoice("7", "consistent", adminKp),
    ).resolves.toMatchObject({ invoiceId: "7" });
  });

  it("accepts any keypair when no adminKeypair is configured", async () => {
    const client = makeClient(); // no config adminKeypair
    mockSubmitSuccess(client);

    await expect(
      client.adminFreezeInvoice("10", "ad-hoc", Keypair.random()),
    ).resolves.toBeDefined();
  });

  it("emits a success audit event", async () => {
    const adminKp = Keypair.random();
    const client = makeClient();
    mockSubmitSuccess(client);

    const entries: any[] = [];
    (client as any)._auditLogger = new AuditLogger((e) => entries.push(e));

    await client.adminFreezeInvoice("20", "audit test", adminKp);

    expect(entries).toHaveLength(1);
    expect(entries[0].method).toBe("adminFreezeInvoice");
    expect(entries[0].success).toBe(true);
    expect(entries[0].params.invoiceId).toBe("20");
    expect(entries[0].params.reason).toBe("audit test");
  });

  it("emits a failure audit event when submission fails", async () => {
    const adminKp = Keypair.random();
    const client = makeClient();
    mockSubmitFailure(client, new Error("network down"));

    const entries: any[] = [];
    (client as any)._auditLogger = new AuditLogger((e) => entries.push(e));

    await expect(
      client.adminFreezeInvoice("21", "fail", adminKp),
    ).rejects.toThrow("network down");

    expect(entries).toHaveLength(1);
    expect(entries[0].method).toBe("adminFreezeInvoice");
    expect(entries[0].success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// adminUnfreezeInvoice
// ---------------------------------------------------------------------------

describe("adminUnfreezeInvoice", () => {
  it("returns an AdminUnfreezeResult with correct fields on success", async () => {
    const adminKp = Keypair.random();
    const client = makeClient();
    mockSubmitSuccess(client);

    const result: AdminUnfreezeResult = await client.adminUnfreezeInvoice(
      "42",
      adminKp,
    );

    expect(result.txHash).toBe(MOCK_TX_HASH);
    expect(result.invoiceId).toBe("42");
    expect(result.adminAddress).toBe(adminKp.publicKey());
    expect(typeof result.timestamp).toBe("number");
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it("passes the admin keypair and address to _submitTxWithKeypair", async () => {
    const adminKp = Keypair.random();
    const client = makeClient();
    const spy = mockSubmitSuccess(client);

    await client.adminUnfreezeInvoice("2", adminKp);

    expect(spy).toHaveBeenCalledOnce();
    const [sourceAddress, , keypairArg] = spy.mock.calls[0] as [
      string,
      unknown,
      Keypair,
    ];
    expect(sourceAddress).toBe(adminKp.publicKey());
    expect(keypairArg.publicKey()).toBe(adminKp.publicKey());
  });

  it("propagates submission errors", async () => {
    const adminKp = Keypair.random();
    const client = makeClient();
    mockSubmitFailure(client, new Error("timeout"));

    await expect(
      client.adminUnfreezeInvoice("99", adminKp),
    ).rejects.toThrow("timeout");
  });

  it("throws AdminOperationError when config adminKeypair differs from passed keypair", async () => {
    const configKp = Keypair.random();
    const otherKp = Keypair.random();
    const client = makeClient(configKp);

    await expect(
      client.adminUnfreezeInvoice("5", otherKp),
    ).rejects.toThrow(AdminOperationError);
  });

  it("succeeds when the config adminKeypair matches the passed keypair", async () => {
    const adminKp = Keypair.random();
    const client = makeClient(adminKp);
    mockSubmitSuccess(client);

    await expect(
      client.adminUnfreezeInvoice("7", adminKp),
    ).resolves.toMatchObject({ invoiceId: "7" });
  });

  it("accepts any keypair when no adminKeypair is configured", async () => {
    const client = makeClient();
    mockSubmitSuccess(client);

    await expect(
      client.adminUnfreezeInvoice("10", Keypair.random()),
    ).resolves.toBeDefined();
  });

  it("emits a success audit event", async () => {
    const adminKp = Keypair.random();
    const client = makeClient();
    mockSubmitSuccess(client);

    const entries: any[] = [];
    (client as any)._auditLogger = new AuditLogger((e) => entries.push(e));

    await client.adminUnfreezeInvoice("30", adminKp);

    expect(entries).toHaveLength(1);
    expect(entries[0].method).toBe("adminUnfreezeInvoice");
    expect(entries[0].success).toBe(true);
    expect(entries[0].params.invoiceId).toBe("30");
  });

  it("emits a failure audit event when submission fails", async () => {
    const adminKp = Keypair.random();
    const client = makeClient();
    mockSubmitFailure(client, new Error("contract error"));

    const entries: any[] = [];
    (client as any)._auditLogger = new AuditLogger((e) => entries.push(e));

    await expect(
      client.adminUnfreezeInvoice("31", adminKp),
    ).rejects.toThrow("contract error");

    expect(entries).toHaveLength(1);
    expect(entries[0].method).toBe("adminUnfreezeInvoice");
    expect(entries[0].success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAdminOperationError type guard
// ---------------------------------------------------------------------------

describe("isAdminOperationError", () => {
  it("returns true for AdminOperationError instances", () => {
    expect(isAdminOperationError(new AdminOperationError("msg", "GADMIN"))).toBe(true);
  });

  it("returns false for plain Error instances", () => {
    expect(isAdminOperationError(new Error("plain"))).toBe(false);
  });

  it("returns false for null and undefined", () => {
    expect(isAdminOperationError(null)).toBe(false);
    expect(isAdminOperationError(undefined)).toBe(false);
  });

  it("exposes adminAddress and name on the error", () => {
    const err = new AdminOperationError("bad key", "GADMINADDRESS");
    expect(err.adminAddress).toBe("GADMINADDRESS");
    expect(err.name).toBe("AdminOperationError");
    expect(err.message).toContain("bad key");
  });
});
