import { webcrypto } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  EncryptionKeyManager,
  SdkEncryptor,
  DecryptionFailedError,
  EncryptionUtilityError,
  deriveEncryptionKey,
  generateSalt,
  ENCRYPTION_KEY_BYTES,
} from "../src/encryptionUtils.js";
import type { EncryptedEnvelope } from "../src/encryptionUtils.js";

const crypto = webcrypto as unknown as Crypto;

describe("encryption utilities", () => {
  let keys: EncryptionKeyManager;
  let encryptor: SdkEncryptor;

  beforeEach(() => {
    keys = new EncryptionKeyManager(crypto);
    keys.addKey(1, keys.generateKeyBytes());
    encryptor = new SdkEncryptor(keys, { crypto, maxTrackedEvents: 4 });
  });

  describe("key derivation and management", () => {
    it("derives deterministic 32-byte keys with a salt", async () => {
      const salt = generateSalt(16, crypto);
      const first = await deriveEncryptionKey("passphrase", salt, 1000, crypto);
      const second = await deriveEncryptionKey("passphrase", salt, 1000, crypto);
      const other = await deriveEncryptionKey("passphrase", generateSalt(16, crypto), 1000, crypto);

      expect(first).toHaveLength(ENCRYPTION_KEY_BYTES);
      expect(first).toEqual(second);
      expect(first).not.toEqual(other);
    });

    it("rejects short salts, invalid keys and duplicate versions", async () => {
      await expect(deriveEncryptionKey("p", new Uint8Array(8), 10, crypto)).rejects.toThrow(
        EncryptionUtilityError,
      );
      expect(() => keys.addKey(1, new Uint8Array(4))).toThrow(EncryptionUtilityError);
      expect(() => keys.addKey(0, keys.generateKeyBytes())).toThrow(EncryptionUtilityError);
      expect(() => keys.addKey(1, keys.generateKeyBytes())).toThrow(EncryptionUtilityError);
    });

    it("keeps retired keys readable but never activates them", () => {
      keys.addKey(2, keys.generateKeyBytes());
      keys.setActiveKey(2);
      keys.retireKey(1);

      expect(keys.isRetired(1)).toBe(true);
      expect(keys.getKey(1)).toHaveLength(ENCRYPTION_KEY_BYTES);
      expect(() => keys.setActiveKey(1)).toThrow(EncryptionUtilityError);
      expect(() => keys.retireKey(2)).toThrow(EncryptionUtilityError);
      expect(keys.versions()).toEqual([1, 2]);
    });
  });

  describe("encryption and decryption", () => {
    it("round-trips text and JSON without leaking plaintext into the envelope", async () => {
      const secret = "student-credential:ABC123";
      const envelope = await encryptor.encrypt(secret);

      expect(envelope.version).toBe(1);
      expect(envelope.keyVersion).toBe(1);
      expect(JSON.stringify(envelope)).not.toContain("student-credential");
      expect(await encryptor.decrypt(envelope)).toBe(secret);

      const payload = { amount: 42, memo: "invoice-7" };
      const jsonEnvelope = await encryptor.encryptJson(payload);
      expect(await encryptor.decryptJson<typeof payload>(jsonEnvelope)).toEqual(payload);
    });

    it("rejects tampered ciphertext, tags, versions and header swapping", async () => {
      const envelope = await encryptor.encrypt("original");

      const tamperedCiphertext: EncryptedEnvelope = {
        ...envelope,
        ciphertext: Buffer.from("corrupted").toString("base64"),
      };
      await expect(encryptor.decrypt(tamperedCiphertext)).rejects.toThrow(DecryptionFailedError);

      const tamperedVersion = { ...envelope, version: 99 } as EncryptedEnvelope;
      await expect(encryptor.decrypt(tamperedVersion)).rejects.toThrow(EncryptionUtilityError);

      const wrongTag = { ...envelope, tag: Buffer.alloc(16).toString("base64") };
      await expect(encryptor.decrypt(wrongTag)).rejects.toThrow(DecryptionFailedError);

      keys.addKey(2, keys.generateKeyBytes());
      const falseHeader: EncryptedEnvelope = { ...envelope, keyVersion: 2 };
      await expect(encryptor.decrypt(falseHeader)).rejects.toThrow(DecryptionFailedError);
    });

    it("fails to decrypt when the underlying key is replaced", async () => {
      const envelope = await encryptor.encrypt("secret");
      const rotated = new EncryptionKeyManager(crypto);
      rotated.addKey(1, rotated.generateKeyBytes());
      const other = new SdkEncryptor(rotated, { crypto });
      await expect(other.decrypt(envelope)).rejects.toThrow(DecryptionFailedError);
    });
  });

  describe("rotation", () => {
    it("rotates keys, decrypts old data and re-encrypts under the new key", async () => {
      const envelope = await encryptor.encrypt("migrate me");
      const previous = keys.rotate(2, keys.generateKeyBytes());

      expect(previous).toBe(1);
      expect(keys.getActiveVersion()).toBe(2);
      expect(keys.isRetired(1)).toBe(true);
      expect(await encryptor.decrypt(envelope)).toBe("migrate me");

      const migrated = await encryptor.reencrypt(envelope);
      expect(migrated.keyVersion).toBe(2);
      expect(await encryptor.decrypt(migrated)).toBe("migrate me");
    });
  });

  describe("tracking", () => {
    it("records bounded operation events without key material", async () => {
      for (let i = 0; i < 6; i += 1) {
        await encryptor.encrypt(`value-${i}`);
      }

      const stats = encryptor.stats();
      expect(stats.encrypted).toBe(6);
      expect(stats.eventsTracked).toBe(4);
      expect(stats.eventsTruncated).toBe(true);
      expect(encryptor.eventsTrail()).toHaveLength(4);
      expect(JSON.stringify(encryptor.eventsTrail())).not.toContain("value-");
    });
  });
});
