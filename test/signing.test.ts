import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { KeypairSigner } from "../src/signing/adapters/KeypairSigner.js";
import { CloudKmsSigner, isRegionError } from "../src/signing/adapters/CloudKmsSigner.js";
import type { KmsClient } from "../src/signing/adapters/CloudKmsSigner.js";
import {
  EncryptedFileSigner,
  writeEncryptedSigningKeyFile,
  encryptSigningKeyToPem,
} from "../src/signing/adapters/EncryptedFileSigner.js";

import {
  InvalidKeypairError,
  isInvalidKeypairError,
  StellarSplitError,
} from "../src/errors.js";

const TX_HASH = randomBytes(32);

describe("KeypairSigner", () => {
  it("produces a 64-byte ed25519 signature verifiable by Keypair.verify when initialized with Keypair", async () => {
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

  it("constructs and signs correctly when initialized with a valid secret key string", async () => {
    const keypair = Keypair.random();
    const secret = keypair.secret();
    const signer = new KeypairSigner(secret);

    expect(signer.keypair.publicKey()).toBe(keypair.publicKey());
    const signature = await signer.sign(TX_HASH);
    expect(signature).toHaveLength(64);
    expect(keypair.verify(TX_HASH, signature)).toBe(true);
  });

  it("throws InvalidKeypairError when secret key does not start with 'S' (e.g. public key)", () => {
    const publicKey = "GBYVQHUDHLWQMS5GZZ7W4P6OCBW5MVAOUXCTFB7VOVLIKGOOQT5ATOZ4";
    expect(() => new KeypairSigner(publicKey)).toThrow(InvalidKeypairError);
    expect(() => new KeypairSigner(publicKey)).toThrow(/Invalid secret key format/);
  });

  it("throws InvalidKeypairError when secret key has invalid length or base32 encoding", () => {
    expect(() => new KeypairSigner("S123")).toThrow(InvalidKeypairError);
    expect(() => new KeypairSigner("S123")).toThrow(/Invalid secret key format/);
    expect(() => new KeypairSigner("not-a-secret-key")).toThrow(InvalidKeypairError);
  });

  it("throws InvalidKeypairError when secret key has invalid checksum", () => {
    const invalidChecksumKey = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(() => new KeypairSigner(invalidChecksumKey)).toThrow(InvalidKeypairError);
    expect(() => new KeypairSigner(invalidChecksumKey)).toThrow(/invalid checksum/i);
  });

  it("throws InvalidKeypairError when secret key is empty string", () => {
    expect(() => new KeypairSigner("")).toThrow(InvalidKeypairError);
  });

  it("throws InvalidKeypairError when Keypair cannot sign (public key only)", () => {
    const pubKeypair = Keypair.fromPublicKey("GBYVQHUDHLWQMS5GZZ7W4P6OCBW5MVAOUXCTFB7VOVLIKGOOQT5ATOZ4");
    expect(() => new KeypairSigner(pubKeypair)).toThrow(InvalidKeypairError);
    expect(() => new KeypairSigner(pubKeypair)).toThrow(/Keypair does not contain a secret key for signing/);
  });

  it("throws InvalidKeypairError for invalid input types", () => {
    expect(() => new KeypairSigner(null as unknown as string)).toThrow(InvalidKeypairError);
    expect(() => new KeypairSigner(undefined as unknown as string)).toThrow(InvalidKeypairError);
    expect(() => new KeypairSigner(12345 as unknown as string)).toThrow(InvalidKeypairError);
    expect(() => new KeypairSigner({} as unknown as Keypair)).toThrow(InvalidKeypairError);
  });

  it("InvalidKeypairError has correct code, name, and prototype hierarchy", () => {
    const err = new InvalidKeypairError("format error");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(StellarSplitError);
    expect(err).toBeInstanceOf(InvalidKeypairError);
    expect(err.name).toBe("InvalidKeypairError");
    expect(err.code).toBe("INVALID_KEYPAIR");
    expect(err.message).toBe("format error");
  });

  it("isInvalidKeypairError correctly identifies InvalidKeypairError instances", () => {
    const err = new InvalidKeypairError("test");
    expect(isInvalidKeypairError(err)).toBe(true);
    expect(isInvalidKeypairError(new Error("test"))).toBe(false);
    expect(isInvalidKeypairError(null)).toBe(false);
    expect(isInvalidKeypairError(undefined)).toBe(false);
    expect(isInvalidKeypairError({ name: "InvalidKeypairError" })).toBe(false);
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

  it("stores configured region and fallbackRegions", () => {
    const fakeKms = { sign: vi.fn(async () => Buffer.alloc(64, 1)) };
    const signer = new CloudKmsSigner(fakeKms, "key-id", {
      region: "us-east-1",
      fallbackRegions: ["us-west-2", "eu-central-1"],
    });
    expect(signer.region).toBe("us-east-1");
    expect(signer.fallbackRegions).toEqual(["us-west-2", "eu-central-1"]);
  });

  it("signs successfully in primary region when region is configured", async () => {
    const signature = randomBytes(64);
    const kmsClient: KmsClient = {
      sign: vi.fn(async (_keyId, _digest, options) => {
        expect(options?.region).toBe("us-east-1");
        return signature;
      }),
    };
    const signer = new CloudKmsSigner(kmsClient, "alias/split-key", {
      region: "us-east-1",
      fallbackRegions: ["us-west-2"],
    });

    const result = await signer.sign(TX_HASH);
    expect(result).toEqual(signature);
    expect(kmsClient.sign).toHaveBeenCalledTimes(1);
    expect(kmsClient.sign).toHaveBeenCalledWith("alias/split-key", TX_HASH, { region: "us-east-1" });
  });

  it("retries in fallback region on HTTP 503 error and emits regionFallback event", async () => {
    const signature = randomBytes(64);
    const fallbackEvents: Array<{ from: string; to: string }> = [];

    const kmsClient: KmsClient = {
      sign: vi.fn(async (_keyId, _digest, options) => {
        if (options?.region === "us-east-1") {
          const err = new Error("503 Service Unavailable");
          (err as unknown as { statusCode: number }).statusCode = 503;
          throw err;
        }
        if (options?.region === "us-west-2") {
          return signature;
        }
        throw new Error("unexpected region");
      }),
    };

    const signer = new CloudKmsSigner(kmsClient, "alias/split-key", {
      region: "us-east-1",
      fallbackRegions: ["us-west-2"],
    });
    signer.on("regionFallback", (event) => fallbackEvents.push(event));

    const result = await signer.sign(TX_HASH);
    expect(result).toEqual(signature);
    expect(kmsClient.sign).toHaveBeenCalledTimes(2);
    expect(kmsClient.sign).toHaveBeenNthCalledWith(1, "alias/split-key", TX_HASH, { region: "us-east-1" });
    expect(kmsClient.sign).toHaveBeenNthCalledWith(2, "alias/split-key", TX_HASH, { region: "us-west-2" });
    expect(fallbackEvents).toEqual([{ from: "us-east-1", to: "us-west-2" }]);
  });

  it("retries in fallback region on timeout error and emits regionFallback event", async () => {
    const signature = randomBytes(64);
    const fallbackEvents: Array<{ from: string; to: string }> = [];

    const kmsClient: KmsClient = {
      sign: vi.fn(async (_keyId, _digest, options) => {
        if (options?.region === "us-east-1") {
          const timeoutErr = new Error("Request timed out after 5000ms");
          timeoutErr.name = "TimeoutError";
          throw timeoutErr;
        }
        if (options?.region === "us-west-2") {
          return signature;
        }
        throw new Error("unexpected region");
      }),
    };

    const signer = new CloudKmsSigner(kmsClient, "alias/split-key", {
      region: "us-east-1",
      fallbackRegions: ["us-west-2"],
    });
    signer.on("regionFallback", (event) => fallbackEvents.push(event));

    const result = await signer.sign(TX_HASH);
    expect(result).toEqual(signature);
    expect(fallbackEvents).toEqual([{ from: "us-east-1", to: "us-west-2" }]);
  });

  it("retries through multiple fallback regions in order and emits regionFallback event for each switch", async () => {
    const signature = randomBytes(64);
    const fallbackEvents: Array<{ from: string; to: string }> = [];

    const kmsClient: KmsClient = {
      sign: vi.fn(async (_keyId, _digest, options) => {
        if (options?.region === "us-east-1") {
          const err = new Error("KMS unavailable in region us-east-1");
          (err as unknown as { statusCode: number }).statusCode = 503;
          throw err;
        }
        if (options?.region === "us-west-2") {
          const err = new Error("Connection reset by peer");
          (err as unknown as { code: string }).code = "ECONNRESET";
          throw err;
        }
        if (options?.region === "eu-central-1") {
          return signature;
        }
        throw new Error("unexpected region");
      }),
    };

    const signer = new CloudKmsSigner(kmsClient, "alias/split-key", {
      region: "us-east-1",
      fallbackRegions: ["us-west-2", "eu-central-1"],
    });
    signer.on("regionFallback", (event) => fallbackEvents.push(event));

    const result = await signer.sign(TX_HASH);
    expect(result).toEqual(signature);
    expect(kmsClient.sign).toHaveBeenCalledTimes(3);
    expect(fallbackEvents).toEqual([
      { from: "us-east-1", to: "us-west-2" },
      { from: "us-west-2", to: "eu-central-1" },
    ]);
  });

  it("throws last region error when all fallback regions fail", async () => {
    const fallbackEvents: Array<{ from: string; to: string }> = [];

    const kmsClient: KmsClient = {
      sign: vi.fn(async (_keyId, _digest, options) => {
        const err = new Error(`503 unavailable in ${options?.region}`);
        (err as unknown as { statusCode: number }).statusCode = 503;
        throw err;
      }),
    };

    const signer = new CloudKmsSigner(kmsClient, "alias/split-key", {
      region: "us-east-1",
      fallbackRegions: ["us-west-2"],
    });
    signer.on("regionFallback", (event) => fallbackEvents.push(event));

    await expect(signer.sign(TX_HASH)).rejects.toThrow("503 unavailable in us-west-2");
    expect(kmsClient.sign).toHaveBeenCalledTimes(2);
    expect(fallbackEvents).toEqual([{ from: "us-east-1", to: "us-west-2" }]);
  });

  it("does NOT trigger fallback on non-region errors (e.g. PermissionDenied, 403, 401)", async () => {
    const fallbackEvents: Array<{ from: string; to: string }> = [];

    const kmsClient: KmsClient = {
      sign: vi.fn(async () => {
        const err = new Error("AccessDenied: User is not authorized to perform: kms:Sign");
        (err as unknown as { statusCode: number }).statusCode = 403;
        throw err;
      }),
    };

    const signer = new CloudKmsSigner(kmsClient, "alias/split-key", {
      region: "us-east-1",
      fallbackRegions: ["us-west-2", "eu-central-1"],
    });
    signer.on("regionFallback", (event) => fallbackEvents.push(event));

    await expect(signer.sign(TX_HASH)).rejects.toThrow(/AccessDenied/);
    expect(kmsClient.sign).toHaveBeenCalledTimes(1);
    expect(fallbackEvents).toHaveLength(0);
  });

  it("does NOT trigger fallback on validation or key not found errors", async () => {
    const kmsClient: KmsClient = {
      sign: vi.fn(async () => {
        throw new Error("ValidationException: 1 validation error detected");
      }),
    };

    const signer = new CloudKmsSigner(kmsClient, "alias/split-key", {
      region: "us-east-1",
      fallbackRegions: ["us-west-2"],
    });

    await expect(signer.sign(TX_HASH)).rejects.toThrow(/ValidationException/);
    expect(kmsClient.sign).toHaveBeenCalledTimes(1);
  });

  it("isRegionError correctly classifies region vs non-region errors", () => {
    expect(isRegionError(null)).toBe(false);
    expect(isRegionError(undefined)).toBe(false);

    // Region errors
    expect(isRegionError({ statusCode: 503 })).toBe(true);
    expect(isRegionError({ status: 502 })).toBe(true);
    expect(isRegionError({ statusCode: 504 })).toBe(true);
    expect(isRegionError({ statusCode: 408 })).toBe(true);
    expect(isRegionError({ statusCode: 429 })).toBe(true);
    expect(isRegionError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isRegionError({ code: "ECONNRESET" })).toBe(true);
    expect(isRegionError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isRegionError({ name: "TimeoutError" })).toBe(true);
    expect(isRegionError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isRegionError(new Error("Gateway Timeout"))).toBe(true);
    expect(isRegionError(new Error("Request timed out"))).toBe(true);
    expect(isRegionError(new Error("KMS region unavailable"))).toBe(true);

    // Non-region errors
    expect(isRegionError({ statusCode: 403 })).toBe(false);
    expect(isRegionError({ statusCode: 401 })).toBe(false);
    expect(isRegionError({ statusCode: 400 })).toBe(false);
    expect(isRegionError({ statusCode: 404 })).toBe(false);
    expect(isRegionError(new Error("AccessDenied: User not authorized"))).toBe(false);
    expect(isRegionError(new Error("PermissionDenied"))).toBe(false);
    expect(isRegionError(new Error("Unauthorized"))).toBe(false);
    expect(isRegionError(new Error("KeyNotFound: Key does not exist"))).toBe(false);
    expect(isRegionError(new Error("ValidationException: Invalid parameter"))).toBe(false);
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
