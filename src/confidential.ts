/**
 * Confidential payment helpers for Pedersen commitment-based privacy.
 *
 * Provides functions to:
 * - Generate Pedersen commitments for payment amounts
 * - Store/retrieve encrypted blinding factors
 * - Build reveal_payment transactions
 *
 * Uses secp256k1 curve with @noble/curves for cryptographic operations.
 */

import { secp256k1, secp256k1_hasher } from "@noble/curves/secp256k1.js";
import {
  Contract,
  nativeToScVal,
  TransactionBuilder,
  BASE_FEE,
  Account,
  Transaction,
} from "@stellar/stellar-sdk";
import type { StellarSplitClientConfig } from "./client.js";
import type {
  PedersenCommitment,
  BlindingFactorStorageConfig,
  StoredBlindingFactor,
  RevealPaymentOptions,
} from "./types.js";
import {
  CommitmentGenerationError,
  BlindingFactorStorageError,
  BlindingFactorNotFoundError,
  BlindingFactorDecryptionError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PEDERSEN_H_DOMAIN = "StellarSplit_Pedersen_H_v1";
const DB_NAME = "StellarSplitConfidential";
const STORE_NAME = "blindingFactors";
const DEFAULT_KEY_PREFIX = "stellarsplit:bf:";
const SESSION_KEY_NAME = "stellarsplit:encryption_key";

// ---------------------------------------------------------------------------
// Generator Point H (cached)
// ---------------------------------------------------------------------------

/** Cached H point for Pedersen commitments. */
let _cachedH: InstanceType<typeof secp256k1.Point> | null = null;

/**
 * Derive the secondary generator point H using hash-to-curve.
 * This is a "nothing up my sleeve" derivation ensuring H is
 * provably independent from G.
 */
function getGeneratorH(): InstanceType<typeof secp256k1.Point> {
  if (_cachedH) return _cachedH;

  // Use hash-to-curve with domain separator to derive H
  // This guarantees a valid point and is cryptographically sound
  const domainBytes = new TextEncoder().encode(PEDERSEN_H_DOMAIN);
  const point = secp256k1_hasher.hashToCurve(domainBytes);

  _cachedH = point;
  return point;
}

/**
 * Generate a random 32-byte blinding factor using cryptographically
 * secure random number generation.
 */
function generateBlindingFactor(): Buffer {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  // Ensure the scalar is valid (less than curve order) by using mod
  const n = secp256k1.Point.Fn.ORDER;
  let scalar = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  scalar = scalar % n;
  if (scalar === 0n) scalar = 1n; // Avoid zero

  const hexStr = scalar.toString(16).padStart(64, "0");
  return Buffer.from(hexStr, "hex");
}

// ---------------------------------------------------------------------------
// Pedersen Commitment Generation
// ---------------------------------------------------------------------------

/**
 * Generate a Pedersen commitment for a payment amount.
 *
 * The commitment C = aH + vG where:
 * - v is the value (amount)
 * - a is the random blinding factor
 * - G is the secp256k1 generator
 * - H is a secondary generator derived via hash-to-curve
 *
 * @param amount - The payment amount in stroops (must be >= 0)
 * @returns Commitment and blinding factor
 * @throws {CommitmentGenerationError} If generation fails
 */
export function generateCommitment(amount: bigint): PedersenCommitment {
  if (amount < 0n) {
    throw new CommitmentGenerationError("Amount must be non-negative");
  }

  try {
    const H = getGeneratorH();
    const G = secp256k1.Point.BASE;

    // Generate random blinding factor
    const blindingFactor = generateBlindingFactor();
    const a = BigInt("0x" + blindingFactor.toString("hex"));

    // Compute C = aH + vG
    const aH = H.multiply(a);
    // Handle zero amount specially - use identity point
    const vG = amount === 0n ? secp256k1.Point.ZERO : G.multiply(amount);
    const C = aH.add(vG);

    // Serialize commitment as compressed point (33 bytes)
    const commitment = Buffer.from(C.toBytes());

    return {
      commitment,
      blindingFactor,
    };
  } catch (err) {
    if (err instanceof CommitmentGenerationError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new CommitmentGenerationError(`Failed to generate commitment: ${message}`);
  }
}

/**
 * Verify that a commitment matches a given value and blinding factor.
 *
 * @param commitment - The commitment to verify
 * @param value - The claimed value
 * @param blindingFactor - The claimed blinding factor
 * @returns True if the commitment is valid for the given value and blinding factor
 */
export function verifyCommitment(
  commitment: Buffer,
  value: bigint,
  blindingFactor: Buffer
): boolean {
  try {
    const H = getGeneratorH();
    const G = secp256k1.Point.BASE;

    const a = BigInt("0x" + blindingFactor.toString("hex"));
    const aH = H.multiply(a);
    // Handle zero value specially - use identity point
    const vG = value === 0n ? secp256k1.Point.ZERO : G.multiply(value);
    const expectedC = aH.add(vG);

    // fromHex expects a hex string, not a Buffer
    const actualC = secp256k1.Point.fromHex(commitment.toString("hex"));
    return expectedC.equals(actualC);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Blinding Factor Storage (Session-based AES-256-GCM)
// ---------------------------------------------------------------------------

/** Global storage configuration. */
let globalStorageConfig: BlindingFactorStorageConfig = {};

/**
 * Configure blinding factor storage globally.
 *
 * @param config - Storage configuration options
 */
export function configureBlindingFactorStorage(config: BlindingFactorStorageConfig): void {
  globalStorageConfig = { ...globalStorageConfig, ...config };
}

/**
 * Reset storage configuration to defaults.
 */
export function resetBlindingFactorStorageConfig(): void {
  globalStorageConfig = {};
}

/**
 * Get or create encryption key stored in sessionStorage.
 */
async function getEncryptionKey(): Promise<CryptoKey> {
  // Check for stored key in sessionStorage (ephemeral)
  const storedKey = sessionStorage.getItem(SESSION_KEY_NAME);
  if (storedKey) {
    const keyData = Uint8Array.from(atob(storedKey), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  // Generate and store new key
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const exported = await crypto.subtle.exportKey("raw", key);
  sessionStorage.setItem(
    SESSION_KEY_NAME,
    btoa(String.fromCharCode(...new Uint8Array(exported)))
  );

  return key;
}

/**
 * Open IndexedDB connection with the blinding factors store.
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onerror = () =>
      reject(new BlindingFactorStorageError("Failed to open database"));

    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "invoiceId" });
      }
    };
  });
}

/**
 * Check if IndexedDB is available.
 */
function isIndexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

/**
 * Store a blinding factor encrypted with AES-GCM.
 *
 * @param invoiceId - Invoice ID to associate with the blinding factor
 * @param blindingFactor - The blinding factor to store
 * @param config - Optional storage configuration override
 * @throws {BlindingFactorStorageError} If storage fails
 */
export async function storeBlindingFactor(
  invoiceId: bigint,
  blindingFactor: Buffer,
  config?: BlindingFactorStorageConfig
): Promise<void> {
  const cfg = { ...globalStorageConfig, ...config };
  const keyPrefix = cfg.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const invoiceIdStr = invoiceId.toString();

  try {
    // Generate IV
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // Get encryption key
    const key = await getEncryptionKey();

    // Encrypt the blinding factor (convert Buffer to Uint8Array for Web Crypto API)
    const encryptedData = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new Uint8Array(blindingFactor)
    );

    const entry: StoredBlindingFactor = {
      encryptedData: new Uint8Array(encryptedData),
      iv,
      invoiceId: invoiceIdStr,
      storedAt: Date.now(),
    };

    if (isIndexedDBAvailable()) {
      // Use IndexedDB
      const db = await openDatabase();
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);

      await new Promise<void>((resolve, reject) => {
        const request = store.put(entry);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      db.close();
    } else {
      // Fall back to localStorage with Base64 encoding
      const serialized = JSON.stringify({
        encryptedData: btoa(String.fromCharCode(...entry.encryptedData)),
        iv: btoa(String.fromCharCode(...entry.iv)),
        invoiceId: entry.invoiceId,
        storedAt: entry.storedAt,
      });
      localStorage.setItem(`${keyPrefix}${invoiceIdStr}`, serialized);
    }
  } catch (err) {
    if (err instanceof BlindingFactorStorageError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new BlindingFactorStorageError(
      `Failed to store blinding factor: ${message}`,
      invoiceIdStr
    );
  }
}

/**
 * Load and decrypt a blinding factor for an invoice.
 *
 * @param invoiceId - Invoice ID to retrieve blinding factor for
 * @param config - Optional storage configuration override
 * @returns The decrypted blinding factor, or null if not found
 * @throws {BlindingFactorDecryptionError} If decryption fails
 */
export async function loadBlindingFactor(
  invoiceId: bigint,
  config?: BlindingFactorStorageConfig
): Promise<Buffer | null> {
  const cfg = { ...globalStorageConfig, ...config };
  const keyPrefix = cfg.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const invoiceIdStr = invoiceId.toString();

  try {
    let entry: StoredBlindingFactor | null = null;

    if (isIndexedDBAvailable()) {
      const db = await openDatabase();
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);

      entry = await new Promise<StoredBlindingFactor | null>((resolve, reject) => {
        const request = store.get(invoiceIdStr);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });

      db.close();
    } else {
      // Load from localStorage
      const serialized = localStorage.getItem(`${keyPrefix}${invoiceIdStr}`);
      if (serialized) {
        const parsed = JSON.parse(serialized);
        entry = {
          encryptedData: Uint8Array.from(atob(parsed.encryptedData), (c) =>
            c.charCodeAt(0)
          ),
          iv: Uint8Array.from(atob(parsed.iv), (c) => c.charCodeAt(0)),
          invoiceId: parsed.invoiceId,
          storedAt: parsed.storedAt,
        };
      }
    }

    if (!entry) {
      return null;
    }

    // Get decryption key
    const key = await getEncryptionKey();

    // Decrypt the blinding factor (ensure we pass ArrayBuffer for Web Crypto API)
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(entry.iv) },
      key,
      new Uint8Array(entry.encryptedData)
    );

    return Buffer.from(decrypted);
  } catch (err) {
    if (err instanceof BlindingFactorDecryptionError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new BlindingFactorDecryptionError(
      `Failed to decrypt blinding factor: ${message}`,
      invoiceIdStr
    );
  }
}

/**
 * Delete a stored blinding factor.
 *
 * @param invoiceId - Invoice ID to delete blinding factor for
 * @param config - Optional storage configuration override
 */
export async function deleteBlindingFactor(
  invoiceId: bigint,
  config?: BlindingFactorStorageConfig
): Promise<void> {
  const cfg = { ...globalStorageConfig, ...config };
  const keyPrefix = cfg.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const invoiceIdStr = invoiceId.toString();

  try {
    if (isIndexedDBAvailable()) {
      const db = await openDatabase();
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);

      await new Promise<void>((resolve, reject) => {
        const request = store.delete(invoiceIdStr);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      db.close();
    } else {
      localStorage.removeItem(`${keyPrefix}${invoiceIdStr}`);
    }
  } catch {
    // Silently ignore deletion errors
  }
}

// ---------------------------------------------------------------------------
// Transaction Building
// ---------------------------------------------------------------------------

/**
 * Build a reveal_payment transaction for the StellarSplit contract.
 *
 * This transaction reveals a previously committed payment by providing
 * the original value and blinding factor.
 *
 * @param options - Reveal payment options
 * @param config - Client configuration
 * @returns An unsigned Transaction ready for signing
 */
export function buildRevealTransaction(
  options: RevealPaymentOptions,
  config: StellarSplitClientConfig
): Transaction {
  const { invoiceId, value, blindingFactor, payer } = options;

  // Create contract instance
  const contract = new Contract(config.contractId);

  // Build the reveal_payment operation
  // Contract signature: reveal_payment(invoice_id: u64, value: i128, blinding_factor: BytesN<32>, payer: Address)
  const op = contract.call(
    "reveal_payment",
    nativeToScVal(invoiceId, { type: "u64" }),
    nativeToScVal(value, { type: "i128" }),
    nativeToScVal(blindingFactor, { type: "bytes" }),
    nativeToScVal(payer, { type: "address" })
  );

  // Create a fallback source account for offline building
  const sourceAccount = {
    accountId: () => payer,
    sequenceNumber: () => "0",
    incrementSequenceNumber: () => {
      /* no-op */
    },
  } as unknown as Account;

  const builder = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  });

  builder.addOperation(op);
  builder.setTimeout(30);

  return builder.build();
}

// ---------------------------------------------------------------------------
// Convenience Functions
// ---------------------------------------------------------------------------

/**
 * Generate a commitment and store the blinding factor atomically.
 *
 * This is a convenience function that combines commitment generation
 * with secure storage of the blinding factor.
 *
 * @param invoiceId - Invoice ID to associate with the commitment
 * @param amount - Payment amount in stroops
 * @param storageConfig - Optional storage configuration
 * @returns The generated commitment (blinding factor is stored internally)
 */
export async function generateAndStoreCommitment(
  invoiceId: bigint,
  amount: bigint,
  storageConfig?: BlindingFactorStorageConfig
): Promise<Buffer> {
  const { commitment, blindingFactor } = generateCommitment(amount);

  await storeBlindingFactor(invoiceId, blindingFactor, storageConfig);

  return commitment;
}

/**
 * Load blinding factor and build reveal transaction.
 *
 * This is a convenience function for the full reveal flow.
 *
 * @param invoiceId - Invoice ID to reveal
 * @param value - The original committed value
 * @param payer - Payer's Stellar address
 * @param config - Client configuration
 * @param storageConfig - Optional storage configuration
 * @returns An unsigned Transaction ready for signing
 * @throws {BlindingFactorNotFoundError} If no blinding factor is stored
 */
export async function buildRevealTransactionFromStorage(
  invoiceId: bigint,
  value: bigint,
  payer: string,
  config: StellarSplitClientConfig,
  storageConfig?: BlindingFactorStorageConfig
): Promise<Transaction> {
  const blindingFactor = await loadBlindingFactor(invoiceId, storageConfig);

  if (!blindingFactor) {
    throw new BlindingFactorNotFoundError(invoiceId.toString());
  }

  return buildRevealTransaction(
    {
      invoiceId,
      value,
      blindingFactor,
      payer,
    },
    config
  );
}
