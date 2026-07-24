/**
 * Tests for confidential payment helpers.
 *
 * Coverage:
 * - Pedersen commitment generation
 * - Commitment/reveal roundtrip verification
 * - Blinding factor storage and retrieval
 * - Tampered value detection
 * - Missing blinding factor handling
 * - Transaction building for reveal_payment
 * - Error scenarios
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import {
  generateCommitment,
  verifyCommitment,
  storeBlindingFactor,
  loadBlindingFactor,
  deleteBlindingFactor,
  configureBlindingFactorStorage,
  resetBlindingFactorStorageConfig,
  buildRevealTransaction,
  generateAndStoreCommitment,
  buildRevealTransactionFromStorage,
} from "../src/confidential.js";
import {
  CommitmentGenerationError,
  BlindingFactorStorageError,
  BlindingFactorNotFoundError,
  BlindingFactorDecryptionError,
  isCommitmentGenerationError,
  isBlindingFactorStorageError,
  isBlindingFactorNotFoundError,
  isBlindingFactorDecryptionError,
} from "../src/errors.js";
import type { StellarSplitClientConfig } from "../src/client.js";

// Test configuration
const TEST_CONFIG: StellarSplitClientConfig = {
  contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
};

// Mock sessionStorage for Node.js test environment
const mockSessionStorage: Record<string, string> = {};
vi.stubGlobal("sessionStorage", {
  getItem: (key: string) => mockSessionStorage[key] ?? null,
  setItem: (key: string, value: string) => {
    mockSessionStorage[key] = value;
  },
  removeItem: (key: string) => {
    delete mockSessionStorage[key];
  },
  clear: () => {
    Object.keys(mockSessionStorage).forEach((key) => delete mockSessionStorage[key]);
  },
});

// Mock localStorage for fallback testing
const mockLocalStorage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: (key: string) => mockLocalStorage[key] ?? null,
  setItem: (key: string, value: string) => {
    mockLocalStorage[key] = value;
  },
  removeItem: (key: string) => {
    delete mockLocalStorage[key];
  },
  clear: () => {
    Object.keys(mockLocalStorage).forEach((key) => delete mockLocalStorage[key]);
  },
});

describe("Pedersen Commitment Generation", () => {
  it("generates valid commitment for positive amount", () => {
    const amount = 1000000000n; // 100 XLM in stroops
    const result = generateCommitment(amount);

    expect(result.commitment).toBeInstanceOf(Buffer);
    expect(result.commitment.length).toBe(33); // Compressed point
    expect(result.blindingFactor).toBeInstanceOf(Buffer);
    expect(result.blindingFactor.length).toBe(32);
  });

  it("generates different commitments for same amount", () => {
    const amount = 1000000000n;
    const result1 = generateCommitment(amount);
    const result2 = generateCommitment(amount);

    // Commitments should differ due to random blinding factors
    expect(result1.commitment.equals(result2.commitment)).toBe(false);
    expect(result1.blindingFactor.equals(result2.blindingFactor)).toBe(false);
  });

  it("generates commitment for zero amount", () => {
    const result = generateCommitment(0n);

    expect(result.commitment).toBeInstanceOf(Buffer);
    expect(result.commitment.length).toBe(33);
  });

  it("throws for negative amount", () => {
    expect(() => generateCommitment(-100n)).toThrow(CommitmentGenerationError);
  });

  it("handles very large amounts", () => {
    const largeAmount = BigInt("9223372036854775807"); // Max i64
    const result = generateCommitment(largeAmount);

    expect(result.commitment).toBeInstanceOf(Buffer);
    expect(result.commitment.length).toBe(33);
  });

  it("commitment starts with valid prefix byte", () => {
    const result = generateCommitment(1000n);
    // Compressed point prefix is 0x02 or 0x03
    expect([0x02, 0x03]).toContain(result.commitment[0]);
  });
});

describe("Commitment Verification", () => {
  it("verifies correct value and blinding factor", () => {
    const amount = 500000000n;
    const { commitment, blindingFactor } = generateCommitment(amount);

    const isValid = verifyCommitment(commitment, amount, blindingFactor);
    expect(isValid).toBe(true);
  });

  it("detects tampered value", () => {
    const amount = 500000000n;
    const { commitment, blindingFactor } = generateCommitment(amount);

    // Try to verify with wrong amount
    const wrongAmount = 600000000n;
    const isValid = verifyCommitment(commitment, wrongAmount, blindingFactor);
    expect(isValid).toBe(false);
  });

  it("detects wrong blinding factor", () => {
    const amount = 500000000n;
    const { commitment } = generateCommitment(amount);

    // Generate different blinding factor
    const { blindingFactor: wrongBlindingFactor } = generateCommitment(amount);

    const isValid = verifyCommitment(commitment, amount, wrongBlindingFactor);
    expect(isValid).toBe(false);
  });

  it("returns false for invalid commitment buffer", () => {
    const invalidCommitment = Buffer.alloc(33, 0);
    const blindingFactor = Buffer.alloc(32, 1);

    const isValid = verifyCommitment(invalidCommitment, 100n, blindingFactor);
    expect(isValid).toBe(false);
  });

  it("returns false for truncated commitment", () => {
    const { blindingFactor } = generateCommitment(100n);
    const truncatedCommitment = Buffer.alloc(16, 0x02);

    const isValid = verifyCommitment(truncatedCommitment, 100n, blindingFactor);
    expect(isValid).toBe(false);
  });

  it("verifies multiple roundtrips", () => {
    for (let i = 0; i < 5; i++) {
      const amount = BigInt(Math.floor(Math.random() * 1000000000));
      const { commitment, blindingFactor } = generateCommitment(amount);
      expect(verifyCommitment(commitment, amount, blindingFactor)).toBe(true);
    }
  });
});

describe("Blinding Factor Storage", () => {
  beforeEach(() => {
    resetBlindingFactorStorageConfig();
    // Clear IndexedDB
    indexedDB.deleteDatabase("StellarSplitConfidential");
    // Clear mock storage
    Object.keys(mockSessionStorage).forEach((key) => delete mockSessionStorage[key]);
    Object.keys(mockLocalStorage).forEach((key) => delete mockLocalStorage[key]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores and retrieves blinding factor", async () => {
    const invoiceId = 12345n;
    const { blindingFactor } = generateCommitment(1000000n);

    await storeBlindingFactor(invoiceId, blindingFactor);
    const loaded = await loadBlindingFactor(invoiceId);

    expect(loaded).not.toBeNull();
    expect(loaded!.equals(blindingFactor)).toBe(true);
  });

  it("returns null for non-existent blinding factor", async () => {
    const loaded = await loadBlindingFactor(99999n);
    expect(loaded).toBeNull();
  });

  it("overwrites existing blinding factor", async () => {
    const invoiceId = 12345n;
    const { blindingFactor: bf1 } = generateCommitment(1000000n);
    const { blindingFactor: bf2 } = generateCommitment(2000000n);

    await storeBlindingFactor(invoiceId, bf1);
    await storeBlindingFactor(invoiceId, bf2);

    const loaded = await loadBlindingFactor(invoiceId);
    expect(loaded!.equals(bf2)).toBe(true);
  });

  it("deletes blinding factor", async () => {
    const invoiceId = 12345n;
    const { blindingFactor } = generateCommitment(1000000n);

    await storeBlindingFactor(invoiceId, blindingFactor);
    await deleteBlindingFactor(invoiceId);

    const loaded = await loadBlindingFactor(invoiceId);
    expect(loaded).toBeNull();
  });

  it("stores multiple blinding factors independently", async () => {
    const { blindingFactor: bf1 } = generateCommitment(1000000n);
    const { blindingFactor: bf2 } = generateCommitment(2000000n);

    await storeBlindingFactor(1n, bf1);
    await storeBlindingFactor(2n, bf2);

    const loaded1 = await loadBlindingFactor(1n);
    const loaded2 = await loadBlindingFactor(2n);

    expect(loaded1!.equals(bf1)).toBe(true);
    expect(loaded2!.equals(bf2)).toBe(true);
  });

  it("uses global configuration", async () => {
    configureBlindingFactorStorage({ keyPrefix: "custom:" });

    const invoiceId = 12345n;
    const { blindingFactor } = generateCommitment(1000000n);

    await storeBlindingFactor(invoiceId, blindingFactor);
    const loaded = await loadBlindingFactor(invoiceId);

    expect(loaded!.equals(blindingFactor)).toBe(true);
  });
});

describe("Transaction Building", () => {
  it("builds reveal_payment transaction", () => {
    const { blindingFactor } = generateCommitment(1000000n);

    const tx = buildRevealTransaction(
      {
        invoiceId: 42n,
        value: 1000000n,
        blindingFactor,
        payer: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
      },
      TEST_CONFIG
    );

    expect(tx).toBeDefined();
    expect(tx.operations).toHaveLength(1);
  });

  it("builds transaction with correct network passphrase", () => {
    const { blindingFactor } = generateCommitment(1000000n);

    const tx = buildRevealTransaction(
      {
        invoiceId: 42n,
        value: 1000000n,
        blindingFactor,
        payer: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
      },
      TEST_CONFIG
    );

    expect(tx.networkPassphrase).toBe(TEST_CONFIG.networkPassphrase);
  });

  it("builds transaction for different invoice IDs", () => {
    const { blindingFactor } = generateCommitment(1000000n);

    const tx1 = buildRevealTransaction(
      {
        invoiceId: 1n,
        value: 1000000n,
        blindingFactor,
        payer: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
      },
      TEST_CONFIG
    );

    const tx2 = buildRevealTransaction(
      {
        invoiceId: 2n,
        value: 1000000n,
        blindingFactor,
        payer: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
      },
      TEST_CONFIG
    );

    // Transactions should be different
    expect(tx1.toXDR()).not.toBe(tx2.toXDR());
  });
});

describe("Convenience Functions", () => {
  beforeEach(() => {
    resetBlindingFactorStorageConfig();
    indexedDB.deleteDatabase("StellarSplitConfidential");
    Object.keys(mockSessionStorage).forEach((key) => delete mockSessionStorage[key]);
    Object.keys(mockLocalStorage).forEach((key) => delete mockLocalStorage[key]);
  });

  it("generateAndStoreCommitment stores blinding factor", async () => {
    const invoiceId = 42n;
    const amount = 1000000n;

    const commitment = await generateAndStoreCommitment(invoiceId, amount);

    expect(commitment).toBeInstanceOf(Buffer);
    expect(commitment.length).toBe(33);

    // Verify blinding factor was stored
    const loaded = await loadBlindingFactor(invoiceId);
    expect(loaded).not.toBeNull();

    // Verify roundtrip
    const isValid = verifyCommitment(commitment, amount, loaded!);
    expect(isValid).toBe(true);
  });

  it("buildRevealTransactionFromStorage loads and builds", async () => {
    const invoiceId = 42n;
    const amount = 1000000n;
    const payer = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

    await generateAndStoreCommitment(invoiceId, amount);

    const tx = await buildRevealTransactionFromStorage(
      invoiceId,
      amount,
      payer,
      TEST_CONFIG
    );

    expect(tx).toBeDefined();
    expect(tx.operations).toHaveLength(1);
  });

  it("throws BlindingFactorNotFoundError when not stored", async () => {
    const invoiceId = 99999n;
    const payer = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

    await expect(
      buildRevealTransactionFromStorage(invoiceId, 1000000n, payer, TEST_CONFIG)
    ).rejects.toThrow(BlindingFactorNotFoundError);
  });
});

describe("Error Type Guards", () => {
  it("isCommitmentGenerationError identifies correctly", () => {
    expect(isCommitmentGenerationError(new CommitmentGenerationError("test"))).toBe(true);
    expect(isCommitmentGenerationError(new Error("test"))).toBe(false);
  });

  it("isBlindingFactorStorageError identifies correctly", () => {
    expect(isBlindingFactorStorageError(new BlindingFactorStorageError("test"))).toBe(true);
    expect(isBlindingFactorStorageError(new Error("test"))).toBe(false);
  });

  it("isBlindingFactorNotFoundError identifies correctly", () => {
    expect(isBlindingFactorNotFoundError(new BlindingFactorNotFoundError("123"))).toBe(true);
    expect(isBlindingFactorNotFoundError(new Error("test"))).toBe(false);
  });

  it("isBlindingFactorDecryptionError identifies correctly", () => {
    expect(isBlindingFactorDecryptionError(new BlindingFactorDecryptionError("test"))).toBe(true);
    expect(isBlindingFactorDecryptionError(new Error("test"))).toBe(false);
  });
});

describe("Commitment/Reveal Roundtrip", () => {
  beforeEach(() => {
    resetBlindingFactorStorageConfig();
    indexedDB.deleteDatabase("StellarSplitConfidential");
    Object.keys(mockSessionStorage).forEach((key) => delete mockSessionStorage[key]);
    Object.keys(mockLocalStorage).forEach((key) => delete mockLocalStorage[key]);
  });

  it("full commitment/reveal cycle succeeds", async () => {
    const invoiceId = 42n;
    const amount = 1000000000n;
    const payer = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

    // Step 1: Generate commitment
    const commitment = await generateAndStoreCommitment(invoiceId, amount);

    // Step 2: Load blinding factor
    const blindingFactor = await loadBlindingFactor(invoiceId);
    expect(blindingFactor).not.toBeNull();

    // Step 3: Verify the commitment
    const isValid = verifyCommitment(commitment, amount, blindingFactor!);
    expect(isValid).toBe(true);

    // Step 4: Build reveal transaction
    const tx = await buildRevealTransactionFromStorage(
      invoiceId,
      amount,
      payer,
      TEST_CONFIG
    );
    expect(tx).toBeDefined();

    // Step 5: Clean up
    await deleteBlindingFactor(invoiceId);
    const loaded = await loadBlindingFactor(invoiceId);
    expect(loaded).toBeNull();
  });

  it("detects tampered value in reveal", async () => {
    const invoiceId = 42n;
    const originalAmount = 1000000000n;
    const tamperedAmount = 2000000000n;

    const commitment = await generateAndStoreCommitment(invoiceId, originalAmount);
    const blindingFactor = await loadBlindingFactor(invoiceId);

    // Verification with tampered amount should fail
    const isValid = verifyCommitment(commitment, tamperedAmount, blindingFactor!);
    expect(isValid).toBe(false);
  });

  it("detects tampered blinding factor in reveal", async () => {
    const invoiceId = 42n;
    const amount = 1000000000n;

    const commitment = await generateAndStoreCommitment(invoiceId, amount);

    // Generate a different blinding factor
    const { blindingFactor: tamperedBf } = generateCommitment(amount);

    // Verification with tampered blinding factor should fail
    const isValid = verifyCommitment(commitment, amount, tamperedBf);
    expect(isValid).toBe(false);
  });
});
