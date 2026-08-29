import { describe, it, expect } from "vitest";
import { generateMerkleProof, verifyMerkleProof, type MerkleProof } from "../src/merkle.js";
import type { Payment } from "../src/types.js";

function makePayments(count: number): Payment[] {
  return Array.from({ length: count }, (_, i) => ({
    payer: `GPAYER${i}`,
    amount: BigInt(100 + i),
    timestamp: 1_700_000_000 + i,
  })) as unknown as Payment[];
}

describe("verifyMerkleProof", () => {
  it("returns true for a valid proof of a leaf in a known tree", async () => {
    const payments = makePayments(5);
    const proof = await generateMerkleProof("invoice-1", 2, payments);

    expect(verifyMerkleProof(proof)).toBe(true);
  });

  it("returns true for every leaf index in a known tree", async () => {
    const payments = makePayments(7);

    for (let i = 0; i < payments.length; i++) {
      const proof = await generateMerkleProof("invoice-2", i, payments);
      expect(verifyMerkleProof(proof)).toBe(true);
    }
  });

  it("returns false for a tampered proof (wrong hash at one level)", async () => {
    const payments = makePayments(5);
    const proof = await generateMerkleProof("invoice-1", 2, payments);

    const tampered: MerkleProof = {
      ...proof,
      path: [...proof.path],
    };
    // Corrupt the first sibling hash on the path.
    tampered.path[0] = "0".repeat(64);

    expect(verifyMerkleProof(tampered)).toBe(false);
  });

  it("returns false when the leaf itself is tampered", async () => {
    const payments = makePayments(5);
    const proof = await generateMerkleProof("invoice-1", 2, payments);

    const tampered: MerkleProof = { ...proof, leaf: "f".repeat(64) };

    expect(verifyMerkleProof(tampered)).toBe(false);
  });

  it("returns false when the root is tampered", async () => {
    const payments = makePayments(5);
    const proof = await generateMerkleProof("invoice-1", 2, payments);

    const tampered: MerkleProof = { ...proof, root: "a".repeat(64) };

    expect(verifyMerkleProof(tampered)).toBe(false);
  });

  it("returns false for a leaf index out of range during generation", async () => {
    const payments = makePayments(3);

    await expect(generateMerkleProof("invoice-3", 99, payments)).rejects.toThrow(
      /out of range/i,
    );
    await expect(generateMerkleProof("invoice-3", -1, payments)).rejects.toThrow(
      /out of range/i,
    );
  });

  it("returns false for a malformed proof missing required fields", () => {
    expect(verifyMerkleProof({} as MerkleProof)).toBe(false);
    expect(verifyMerkleProof({ leaf: "", path: [], root: "" } as MerkleProof)).toBe(false);
    expect(
      verifyMerkleProof({ leaf: "abc", path: null as unknown as string[], root: "def" } as MerkleProof),
    ).toBe(false);
  });

  it("validates a single-leaf tree where the leaf is the root", async () => {
    const payments = makePayments(1);
    const proof = await generateMerkleProof("invoice-4", 0, payments);

    expect(proof.path).toHaveLength(0);
    expect(verifyMerkleProof(proof)).toBe(true);
  });
});
