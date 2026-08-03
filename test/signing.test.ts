import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { KeypairSigner } from "../src/signing/adapters/KeypairSigner.js";
import { CloudKmsSigner } from "../src/signing/adapters/CloudKmsSigner.js";
import type { KmsClient } from "../src/signing/adapters/CloudKmsSigner.js";
import {
  EncryptedFileSigner,
  writeEncryptedSigningKeyFile,
  encryptSigningKeyToPem,
} from "../src/signing/adapters/EncryptedFileSigner.js";

const TX_HASH = randomBytes(32);

describe("KeypairSigner", () => {
  it("produces a 64-byte ed25519 signature verifiable by Keypair.verify", async () => {
    const keypair = Keypair.random();
    const signer = new KeypairSigner(keypair);

    const signature = await signer.sign(TX_HASH);

    expect(signature).toHaveLength(64);
    expect(keypair.verify(TX_HASH, signature)).toBe(true);
  });

  it("does not verify against a different public key", async () => {
    const keypair = Keypair.random();
    const other = Keypair.random();
    const signer = new KeypairSigner(keypair);

    const signature = await signer.sign(TX_HASH);

    expect(other.verify(TX_HASH, signature)).toBe(false);
  });
});

describe("CloudKmsSigner", () => {
  it("delegates to the injected KmsClient with the configured keyId", async () => {
    const signature = randomBytes(64);
    const kmsClient: KmsClient = {
      sign: vi.fn(async (_keyId: string, digest: Buffer) => {
        expect(digest).toEqual(TX_HASH);
        return signature;
      }),
    };
    const signer = new CloudKmsSigner(kmsClient, "alias/split-key");

    const result = await signer.sign(TX_HASH);

    expect(result).toEqual(signature);
    expect(kmsClient.sign).toHaveBeenCalledWith("alias/split-key", TX_HASH);
  });

  it("accepts any structurally compatible object (easy test mocking)", () => {
    const fakeKms = { sign: vi.fn(async () => Buffer.alloc(64, 1)) };
    const signer = new CloudKmsSigner(fakeKms, "key-id");
    expect(signer.keyId).toBe("key-id");
    expect(() => new CloudKmsSigner(fakeKms, "key-id")).not.toThrow();
  });
});

describe("EncryptedFileSigner", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "split-signer-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function filePath(name: string): string {
    return join(dir, name);
  }

  it("decrypts the AES-256-GCM PEM file and signs with the embedded keypair", async () => {
    const keypair = Keypair.random();
    const aesKey = randomBytes(32);
    const path = filePath("vault.pem");
    await writeEncryptedSigningKeyFile(path, keypair.secret(), aesKey);

    const signer = new EncryptedFileSigner(path, { aesKey });
    const signature = await signer.sign(TX_HASH);

    expect(signature).toHaveLength(64);
    expect(keypair.verify(TX_HASH, signature)).toBe(true);
  });

  it("rejects a wrong AES key (auth tag mismatch)", async () => {
    const keypair = Keypair.random();
    const path = filePath("vault.pem");
    await writeEncryptedSigningKeyFile(path, keypair.secret(), randomBytes(32));

    const signer = new EncryptedFileSigner(path, { aesKey: randomBytes(32) });

    await expect(signer.sign(TX_HASH)).rejects.toThrow();
  });

  it("re-reads the file after clearCache (the explicit-null / collected-weakref path)", async () => {
    const first = Keypair.random();
    const second = Keypair.random();
    const aesKey = randomBytes(32);
    const path = filePath("vault.pem");
    await writeEncryptedSigningKeyFile(path, first.secret(), aesKey);

    const signer = new EncryptedFileSigner(path, { aesKey });
    const sig1 = await signer.sign(TX_HASH);
    expect(first.verify(TX_HASH, sig1)).toBe(true);

    // clearCache() simulates the WeakRef having been collected (explicit null):
    // the next sign must re-read + re-decrypt the file.
    signer.clearCache();
    await writeEncryptedSigningKeyFile(path, second.secret(), aesKey);
    const sig2 = await signer.sign(TX_HASH);
    expect(second.verify(TX_HASH, sig2)).toBe(true);
    expect(first.verify(TX_HASH, sig2)).toBe(false);
  });

  it("serves subsequent signs from cache without re-reading the file", async () => {
    const keypair = Keypair.random();
    const aesKey = randomBytes(32);
    const path = filePath("vault.pem");
    await writeEncryptedSigningKeyFile(path, keypair.secret(), aesKey);

    const signer = new EncryptedFileSigner(path, { aesKey });
    const sig1 = await signer.sign(TX_HASH);

    // Rewrite the file with a different secret WITHOUT clearing the cache:
    // the cached keypair must still be used.
    await writeEncryptedSigningKeyFile(path, Keypair.random().secret(), aesKey);
    const sig2 = await signer.sign(TX_HASH);

    expect(keypair.verify(TX_HASH, sig2)).toBe(true);
    expect(sig2).toEqual(sig1);
  });

  it("rejects a truncated / malformed file", async () => {
    const path = filePath("vault.pem");
    await writeFile(path, "not a pem block", "utf8");

    const signer = new EncryptedFileSigner(path, { aesKey: randomBytes(32) });

    await expect(signer.sign(TX_HASH)).rejects.toThrow(
      /does not contain a valid SPLIT ENCRYPTED SIGNING KEY block/,
    );
  });

  it("encryptSigningKeyToPem round-trips through a fresh signer", async () => {
    const keypair = Keypair.random();
    const aesKey = randomBytes(32);
    const pem = encryptSigningKeyToPem(keypair.secret(), aesKey);

    const path = filePath("vault.pem");
    await writeFile(path, pem, "utf8");

    const signer = new EncryptedFileSigner(path, { aesKey });
    const signature = await signer.sign(TX_HASH);
    expect(keypair.verify(TX_HASH, signature)).toBe(true);
  });

  it("validates the AES key length at construction", () => {
    const path = filePath("vault.pem");
    expect(() => new EncryptedFileSigner(path, { aesKey: randomBytes(16) })).toThrow(
      /aesKey must be exactly 32 bytes/,
    );
  });
});
