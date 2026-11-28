import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarSplitClient } from "../src/client.js";

// `scValToNative` is a non-configurable getter on the real SDK namespace, so
// it can't be `vi.spyOn`/`vi.stubGlobal`-ed; override it via a partial module mock.
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    scValToNative: vi.fn((val: any) => val?._value),
  };
});
import {
  Attestation,
  CreatorRating,
  ExtensionStatus,
  GroupStats,
} from "../src/types.js";
import {
  AlreadyRatedError,
  NotEligibleToVoteError,
  InvoiceNotReleasedForRatingError,
} from "../src/errors.js";

const FAKE_ADDRESS = Keypair.random().publicKey();

describe("Issue #862: Attestation System", () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      _submitTx: vi.fn().mockResolvedValue({ txHash: "mock-tx-hash" }),
      _simulateView: vi.fn(),
      contract: { call: vi.fn() },
    };
  });

  it("should attest an invoice with a valid statement", async () => {
    const client = Object.create(StellarSplitClient.prototype);
    Object.assign(client, mockClient);

    const result = await client.attestInvoice("123", "Great work!", FAKE_ADDRESS);
    expect(result.txHash).toBe("mock-tx-hash");
  });

  it("should reject statements exceeding 256 characters", async () => {
    const client = Object.create(StellarSplitClient.prototype);
    Object.assign(client, mockClient);

    const longStatement = "x".repeat(257);
    await expect(
      client.attestInvoice("123", longStatement, FAKE_ADDRESS)
    ).rejects.toThrow();
  });

  it("should revoke an attestation", async () => {
    const client = Object.create(StellarSplitClient.prototype);
    Object.assign(client, mockClient);

    const result = await client.revokeAttestation("123", FAKE_ADDRESS);
    expect(result.txHash).toBe("mock-tx-hash");
  });

  it("should get attestations for an invoice", async () => {
    const client = Object.create(StellarSplitClient.prototype);
    Object.assign(client, mockClient);

    mockClient._simulateView.mockResolvedValue([
      { attester: "addr1", statement: "Good", timestamp: "1000", revoked: false },
      { attester: "addr2", statement: "Great", timestamp: "2000", revoked: true },
    ]);

    const attestations = await client.getAttestations("123");
    expect(attestations).toHaveLength(2);
    expect(attestations[0].statement).toBe("Good");
    expect(attestations[1].revoked).toBe(true);
  });
});

describe("Issue #863: Campaign Group Management", () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      _submitTx: vi.fn().mockResolvedValue({
        txHash: "mock-tx-hash",
        returnValue: { _value: "456" },
      }),
      _simulateView: vi.fn(),
      contract: { call: vi.fn() },
    };
  });

  it("should create a group", async () => {
    const client = Object.create(StellarSplitClient.prototype);
    Object.assign(client, mockClient);

    // Mock scValToNative
    vi.stubGlobal("scValToNative", (val: any) => val._value);

    const result = await client.createGroup(FAKE_ADDRESS, "My Group", "Description");
    expect(result.groupId).toBe("456");
    expect(result.txHash).toBe("mock-tx-hash");
  });

  it("should add invoice to a group", async () => {
    const client = Object.create(StellarSplitClient.prototype);
    Object.assign(client, mockClient);

    const result = await client.addInvoiceToGroup(FAKE_ADDRESS, "456", "789");
    expect(result.txHash).toBe("mock-tx-hash");
  });

  it("should get group statistics", async () => {
    const client = Object.create(StellarSplitClient.prototype);
    Object.assign(client, mockClient);

    mockClient._simulateView.mockResolvedValue({
      name: "Group 1",
      totalTarget: "1000000000",
      totalFunded: "500000000",
      invoiceCount: "5",
      fullyFundedCount: "2",
    });

    const stats = await client.getGroupStats("456");
    expect(stats.name).toBe("Group 1");
    expect(stats.invoiceCount).toBe(5n);
    expect(stats.fullyFundedCount).toBe(2n);
  });

  it("should get group invoices", async () => {
    const client = Object.create(StellarSplitClient.prototype);
    Object.assign(client, mockClient);

    mockClient._simulateView.mockResolvedValue(["1", "2", "3"]);

    const invoices = await client.getGroupInvoices("456");
    expect(invoices).toEqual([1n, 2n, 3n]);
  });
});

describe("Issue #864: Deadline Extension Voting", () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      _submitTx: vi.fn().mockResolvedValue({ txHash: "mock-tx-hash" }),
      _simulateView: vi.fn(),
      contract: { call: vi.fn() },
    };
  });

  it("should vote to extend deadline", async () => {
    const client = Object.create(StellarSplitClient.prototype);
    Object.assign(client, mockClient);

    const result = await client.voteExtendDeadline("123", FAKE_ADDRESS);
    expect(result.txHash).toBe("mock-tx-hash");
  });

  it("should get extension status", async () => {
    const client = Object.create(StellarSplitClient.prototype);
    Object.assign(client, mockClient);

    mockClient._simulateView.mockResolvedValue({
      voteCount: "3",
      quorumRequired: "5",
      extensionCount: "1",
      maxExtensions: "3",
      currentDeadline: "1700000000",
    });

    const status = await client.getExtensionStatus("123");
    expect(status.voteCount).toBe(3n);
    expect(status.quorumRequired).toBe(5n);
    expect(status.extensionCount).toBe(1n);
    expect(status.maxExtensions).toBe(3n);
  });
});

describe("Issue #865: Invoice Rating System", () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      _submitTx: vi.fn().mockResolvedValue({ txHash: "mock-tx-hash" }),
      _simulateView: vi.fn(),
      contract: { call: vi.fn() },
    };
  });

  it("should rate an invoice with valid stars (1-5)", async () => {
    const client = Object.create(StellarSplitClient.prototype);
    Object.assign(client, mockClient);

    for (const stars of [1, 2, 3, 4, 5] as const) {
      const result = await client.rateInvoice("123", stars, FAKE_ADDRESS);
      expect(result.txHash).toBe("mock-tx-hash");
    }
  });

  it("should get creator rating", async () => {
    const client = Object.create(StellarSplitClient.prototype);
    Object.assign(client, mockClient);

    mockClient._simulateView.mockResolvedValue({
      totalRatings: "10",
      totalStars: "43",
    });

    const rating = await client.getCreatorRating(FAKE_ADDRESS);
    expect(rating.totalRatings).toBe(10n);
    expect(rating.averageStars).toBeCloseTo(4.3, 1);
  });

  it("should compute average stars correctly", async () => {
    const client = Object.create(StellarSplitClient.prototype);
    Object.assign(client, mockClient);

    mockClient._simulateView.mockResolvedValue({
      totalRatings: "3",
      totalStars: "14",
    });

    const rating = await client.getCreatorRating(FAKE_ADDRESS);
    expect(rating.averageStars).toBeCloseTo(4.67, 1);
  });

  it("should handle zero ratings gracefully", async () => {
    const client = Object.create(StellarSplitClient.prototype);
    Object.assign(client, mockClient);

    mockClient._simulateView.mockResolvedValue({
      totalRatings: "0",
      totalStars: "0",
    });

    const rating = await client.getCreatorRating(FAKE_ADDRESS);
    expect(rating.totalRatings).toBe(0n);
    expect(rating.averageStars).toBe(0);
  });
});
