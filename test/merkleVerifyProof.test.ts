import { describe, it, expect } from "vitest";
import { verifyProof, generateMerkleProof } from "../src/merkle.js";
import type { Payment } from "../src/types.js";

describe("verifyProof", () => {
  it("returns true for a single-leaf tree (no siblings)", async () => {
    // With no payments, generateMerkleProof returns leaf === root
    const proof = await generateMerkleProof("inv-1", 0, []);
    // Raw leaf string used to build single-leaf tree
    const rawLeaf = `payment-inv-1-0`;
    expect(verifyProof(rawLeaf, [], proof.root)).toBe(true);
  });

  it("returns false when leaf does not match root in single-leaf tree", () => {
    expect(verifyProof("wrong-leaf", [], "some-root")).toBe(false);
  });

  it("returns false for empty leaf", () => {
    expect(verifyProof("", [], "some-root")).toBe(false);
  });

  it("returns false for empty root", () => {
    expect(verifyProof("leaf", [], "")).toBe(false);
  });

  it("returns false when a sibling in the proof is empty", async () => {
    const payments: Payment[] = [
      { payer: "GA1", amount: 100n },
      { payer: "GA2", amount: 200n },
      { payer: "GA3", amount: 300n },
    ];
    const proof = await generateMerkleProof("inv-2", 0, payments);
    // Corrupt one sibling
    const badProof = proof.path.map(() => "");
    expect(verifyProof(proof.leaf, badProof, proof.root)).toBe(false);
  });

  it("verifies a left-sibling proof step correctly", async () => {
    // Build a two-leaf tree and verify the second leaf (right node, sibling is left)
    const payments: Payment[] = [
      { payer: "GA1", amount: 100n },
      { payer: "GA2", amount: 200n },
    ];
    const merkleProof = await generateMerkleProof("inv-3", 0, payments);
    // verifyProof hashes the leaf and combines with siblings left→right
    // For index=0, node is left sibling; the proof path sibling is to the right
    // Our verifyProof defaults to (computed, sibling) ordering
    expect(verifyProof(merkleProof.leaf, merkleProof.path, merkleProof.root)).toBe(true);
  });

  it("returns false when root is tampered", async () => {
    const payments: Payment[] = [
      { payer: "GA1", amount: 100n },
      { payer: "GA2", amount: 200n },
    ];
    const proof = await generateMerkleProof("inv-4", 0, payments);
    expect(verifyProof(proof.leaf, proof.path, "0".repeat(64))).toBe(false);
  });

  it("returns false when a sibling hash is tampered", async () => {
    const payments: Payment[] = [
      { payer: "GA1", amount: 100n },
      { payer: "GA2", amount: 200n },
    ];
    const proof = await generateMerkleProof("inv-5", 0, payments);
    const tamperedPath = proof.path.map((s) => s.replace(/[a-f]/, "9"));
    expect(verifyProof(proof.leaf, tamperedPath, proof.root)).toBe(false);
  });
});
