import { createHash } from "crypto";
import { Invoice, Payment } from "./types.js";

/**
 * Merkle proof structure for invoice payment verification.
 */
export interface MerkleProof {
  /** The leaf hash being proven (payment hash) */
  leaf: string;
  /** Sibling hashes along the path to the root, ordered leaf-to-root */
  path: string[];
  /** The Merkle root hash */
  root: string;
  /** Index of the leaf within the tree (used to determine sibling ordering) */
  index?: number;
}

/** SHA-256 hex digest of a UTF-8 string. */
function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Combine two sibling hashes (in tree order) into their parent hash. */
function hashPair(left: string, right: string): string {
  return sha256Hex(left + right);
}

/**
 * Build the layers of a Merkle tree (leaves through root) from an ordered
 * list of leaf hashes. Odd nodes at a layer are duplicated, matching the
 * common Bitcoin-style padding scheme.
 */
function buildLayers(leaves: string[]): string[][] {
  if (leaves.length === 0) {
    return [[sha256Hex("")]];
  }

  const layers: string[][] = [leaves.slice()];
  let current = leaves;

  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i]!;
      const right = i + 1 < current.length ? current[i + 1]! : current[i]!;
      next.push(hashPair(left, right));
    }
    layers.push(next);
    current = next;
  }

  return layers;
}

/**
 * Generate a Merkle proof for a specific payment within an invoice.
 *
 * Builds a Merkle tree over the SHA-256 hashes of every payment in the
 * invoice (in order) and returns the sibling path from the target leaf up
 * to the root, along with the leaf's index in the tree.
 *
 * @param invoiceId - The invoice ID
 * @param paymentIndex - The index of the payment in the invoice's payments array
 * @param payments - Ordered payments for the invoice (used to build the tree)
 * @returns A Merkle proof object
 */
export async function generateMerkleProof(
  invoiceId: string,
  paymentIndex: number,
  payments: Payment[] = [],
): Promise<MerkleProof> {
  if (payments.length === 0) {
    // Fall back to a single-leaf tree derived deterministically from the
    // invoice/index when no payment list is supplied.
    const leaf = sha256Hex(`payment-${invoiceId}-${paymentIndex}`);
    return { leaf, path: [], root: leaf, index: 0 };
  }

  if (paymentIndex < 0 || paymentIndex >= payments.length) {
    throw new Error(
      `paymentIndex ${paymentIndex} is out of range for invoice ${invoiceId} (0..${payments.length - 1})`,
    );
  }

  const leaves = payments.map((p, i) =>
    sha256Hex(
      `${invoiceId}:${i}:${JSON.stringify(p, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      )}`,
    ),
  );
  const layers = buildLayers(leaves);

  const path: string[] = [];
  let idx = paymentIndex;
  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level]!;
    const isRightNode = idx % 2 === 1;
    const siblingIndex = isRightNode ? idx - 1 : idx + 1;
    const sibling = siblingIndex < layer.length ? layer[siblingIndex]! : layer[idx]!;
    path.push(sibling);
    idx = Math.floor(idx / 2);
  }

  const root = layers[layers.length - 1]![0]!;

  return {
    leaf: leaves[paymentIndex]!,
    path,
    root,
    index: paymentIndex,
  };
}

/**
 * Verify a Merkle proof against its embedded root hash.
 *
 * Recomputes the root by combining the leaf with each sibling hash in
 * `proof.path` (using `proof.index` to determine left/right ordering at
 * each level) and compares the result against `proof.root`.
 *
 * @param proof - The Merkle proof to verify
 * @returns true if the proof is valid, false otherwise
 */
export function verifyMerkleProof(proof: MerkleProof): boolean {
  if (!proof || typeof proof.leaf !== "string" || typeof proof.root !== "string") {
    return false;
  }
  if (!Array.isArray(proof.path)) {
    return false;
  }
  if (proof.leaf.length === 0 || proof.root.length === 0) {
    return false;
  }

  // No siblings: this is only valid for a single-leaf tree where the leaf
  // itself is the root.
  if (proof.path.length === 0) {
    return proof.leaf === proof.root;
  }

  let index = proof.index ?? 0;
  if (index < 0) {
    return false;
  }

  let computed = proof.leaf;
  for (const sibling of proof.path) {
    if (typeof sibling !== "string" || sibling.length === 0) {
      return false;
    }
    const isRightNode = index % 2 === 1;
    computed = isRightNode ? hashPair(sibling, computed) : hashPair(computed, sibling);
    index = Math.floor(index / 2);
  }

  return computed === proof.root;
}

// Re-exported for callers that want to reference the Invoice type alongside
// Merkle proofs (kept for backward compatibility with existing imports).
export type { Invoice };
