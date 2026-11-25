import { webcrypto } from "node:crypto";
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import {
  SslPinningManager,
  SslPinningValidationError,
  PinManagementError,
  sha256Base64,
  normalizePinHostname,
  isValidPinHash,
  SSL_PIN_FORMAT_VERSION,
  PIN_HASH_BYTES,
} from "../src/sslPinning.js";
import { CertificatePinningError } from "../src/errors.js";

const crypto = webcrypto as unknown as Crypto;
const bytes = (text: string) => new TextEncoder().encode(text);
const HOST = "horizon.stellar.org";
const HOUR = 60 * 60 * 1000;

let spkiA: string;
let spkiB: string;
let certA: string;

beforeAll(async () => {
  spkiA = await sha256Base64(bytes("spki-a"), crypto);
  spkiB = await sha256Base64(bytes("spki-b"), crypto);
  certA = await sha256Base64(bytes("cert-a"), crypto);
});

describe("ssl pinning helpers", () => {
  it("computes base64 SHA-256 digests", async () => {
    // SHA-256 of the empty string, well-known vector.
    expect(await sha256Base64(new Uint8Array(0), crypto)).toBe(
      "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    );
    const digest = await sha256Base64(bytes("spki-a"), crypto);
    expect(digest).toBe(spkiA);
    expect(Buffer.from(digest, "base64")).toHaveLength(PIN_HASH_BYTES);
  });

  it("recognises valid base64 and base64url SHA-256 hashes", () => {
    expect(isValidPinHash(spkiA)).toBe(true);
    expect(isValidPinHash(spkiA.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"))).toBe(true);
    expect(isValidPinHash("not-a-hash")).toBe(false);
    expect(isValidPinHash(Buffer.from("short").toString("base64"))).toBe(false);
    expect(isValidPinHash("")).toBe(false);
  });

  it("normalizes and strictly validates hostnames", () => {
    expect(normalizePinHostname("  Horizon.Stellar.ORG. ")).toBe(HOST);
    expect(normalizePinHostname("*.Example.com")).toBe("*.example.com");
    expect(normalizePinHostname("[::1]")).toBe("[::1]");

    expect(() => normalizePinHostname("")).toThrow(PinManagementError);
    expect(() => normalizePinHostname("https://example.com")).toThrow(PinManagementError);
    expect(() => normalizePinHostname("example.com:443")).toThrow(PinManagementError);
    expect(() => normalizePinHostname("example.com/path")).toThrow(PinManagementError);
    expect(() => normalizePinHostname("user@example.com")).toThrow(PinManagementError);
    expect(() => normalizePinHostname("api.*.example.com")).toThrow(PinManagementError);
  });
});

describe("SslPinningManager pin management", () => {
  let manager: SslPinningManager;
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    manager = new SslPinningManager({ now: () => now });
  });

  it("registers pins with safe defaults", () => {
    const pin = manager.addPin({ hostname: HOST, hash: spkiA });

    expect(pin.kind).toBe("spki");
    expect(pin.status).toBe("active");
    expect(pin.hostname).toBe(HOST);
    expect(pin.hash).toBe(spkiA);
    expect(pin.createdAt).toBe(now);
    expect(pin.id).toMatch(/^pin-/);
    expect(manager.listPins()).toHaveLength(1);

    // base64url and unpadded spellings of the same digest are the same pin.
    const base64url = spkiA.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    expect(() => manager.addPin({ hostname: HOST, hash: base64url })).toThrow(PinManagementError);
    expect(manager.validateHashes({ hostname: HOST, spkiHashes: [base64url] }).valid).toBe(true);
  });

  it("rejects malformed and duplicated pins", () => {
    expect(() => manager.addPin({ hostname: HOST, hash: "nope" })).toThrow(PinManagementError);
    expect(() => manager.addPin({ hostname: HOST, hash: spkiA, notBefore: 10, notAfter: 5 })).toThrow(
      PinManagementError,
    );
    expect(() => manager.addPin({ hostname: HOST, hash: spkiA, kind: "chain" as never })).toThrow(
      PinManagementError,
    );

    manager.addPin({ hostname: HOST, hash: spkiA, id: "primary" });
    expect(() => manager.addPin({ hostname: HOST, hash: spkiA })).toThrow(PinManagementError);
    expect(() => manager.addPin({ hostname: HOST, hash: spkiB, id: "primary" })).toThrow(
      PinManagementError,
    );
    // Same hash on a different host is a different pin.
    expect(() => manager.addPin({ hostname: "api.stellar.org", hash: spkiA })).not.toThrow();
  });

  it("adds pin batches atomically", () => {
    expect(() =>
      manager.addPins([
        { hostname: HOST, hash: spkiA },
        { hostname: HOST, hash: "invalid" },
      ]),
    ).toThrow(PinManagementError);
    expect(manager.listPins()).toHaveLength(0);

    expect(
      manager.addPins([
        { hostname: HOST, hash: spkiA },
        { hostname: HOST, hash: certA, kind: "certificate" },
      ]),
    ).toHaveLength(2);
  });

  it("refuses to remove the last usable pin without force", () => {
    const pin = manager.addPin({ hostname: HOST, hash: spkiA });

    expect(() => manager.removePin(pin.id)).toThrow(PinManagementError);
    expect(() => manager.removePin("missing")).toThrow(PinManagementError);

    manager.addPin({ hostname: HOST, hash: spkiB });
    expect(manager.removePin(pin.id).id).toBe(pin.id);
    expect(manager.listPins()).toHaveLength(1);

    expect(() => manager.removePin(manager.listPins()[0]!.id, { force: true })).not.toThrow();
    expect(manager.listPins()).toHaveLength(0);
  });

  it("retires pins immediately or after a grace window", () => {
    const primary = manager.addPin({ hostname: HOST, hash: spkiA });
    const backup = manager.addPin({ hostname: HOST, hash: spkiB });

    const retired = manager.retirePin(primary.id);
    expect(retired.status).toBe("retired");
    expect(retired.retiredAt).toBe(now);

    const demoted = manager.retirePin(backup.id, { graceMs: HOUR });
    expect(demoted.status).toBe("backup");
    expect(demoted.retireAt).toBe(now + HOUR);

    now += HOUR;
    const afterGrace = manager.listPins().find((pin) => pin.id === backup.id)!;
    expect(afterGrace.status).toBe("retired");
  });
});

describe("SslPinningManager validation", () => {
  let manager: SslPinningManager;
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    manager = new SslPinningManager({ now: () => now });
  });

  it("accepts a peer whose SPKI hash matches a pin", async () => {
    manager.addPin({ hostname: HOST, hash: spkiA });

    const byHash = manager.validateHashes({ hostname: HOST, spkiHashes: [spkiA] });
    expect(byHash).toMatchObject({ valid: true, matchedKind: "spki", checkedPins: 1 });

    const byDer = await manager.validate({ hostname: HOST, spki: bytes("spki-a") });
    expect(byDer.valid).toBe(true);
  });

  it("validates certificate-kind pins against DER certificates", async () => {
    manager.addPin({ hostname: HOST, hash: certA, kind: "certificate" });

    expect((await manager.validate({ hostname: HOST, certificate: bytes("cert-a") })).valid).toBe(true);
    expect((await manager.validate({ hostname: HOST, spki: bytes("spki-a") })).reason).toBe(
      "missing-peer-hashes",
    );
  });

  it("rejects mismatched peers and reports the failure", async () => {
    manager.addPin({ hostname: HOST, hash: spkiA });

    const result = await manager.validate({ hostname: HOST, spki: bytes("spki-b") });
    expect(result).toMatchObject({ valid: false, reason: "hash-mismatch" });

    await expect(manager.assertValid({ hostname: HOST, spki: bytes("spki-b") })).rejects.toBeInstanceOf(
      SslPinningValidationError,
    );

    try {
      await manager.assertValid({ hostname: HOST, spkiHashes: [spkiB] });
      expect.fail("expected pinning failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CertificatePinningError);
      const pinningError = error as SslPinningValidationError;
      expect(pinningError.domain).toBe(HOST);
      expect(pinningError.reason).toBe("hash-mismatch");
      expect(pinningError.expectedFingerprint).toContain(spkiA);
      expect(pinningError.actualFingerprint).toContain(spkiB);
    }
  });

  it("fails closed for unpinned hosts unless enforcement is disabled", () => {
    expect(manager.validateHashes({ hostname: HOST, spkiHashes: [spkiA] })).toMatchObject({
      valid: false,
      reason: "no-pins-for-host",
    });

    const permissive = new SslPinningManager({ enforce: false, now: () => now });
    expect(permissive.validateHashes({ hostname: HOST, spkiHashes: [spkiA] })).toMatchObject({
      valid: true,
      reason: "pinning-not-enforced",
    });
  });

  it("rejects peers with no usable hashes", () => {
    manager.addPin({ hostname: HOST, hash: spkiA });

    expect(manager.validateHashes({ hostname: HOST })).toMatchObject({
      valid: false,
      reason: "missing-peer-hashes",
    });
  });

  it("ignores expired, not-yet-valid and retired pins even when the hash matches", () => {
    manager.addPin({ hostname: HOST, hash: spkiA, notAfter: now + HOUR });
    expect(manager.validateHashes({ hostname: HOST, spkiHashes: [spkiA] }).valid).toBe(true);

    now += HOUR;
    expect(manager.validateHashes({ hostname: HOST, spkiHashes: [spkiA] })).toMatchObject({
      valid: false,
      reason: "pin-expired",
    });

    const future = new SslPinningManager({ now: () => now });
    future.addPin({ hostname: HOST, hash: spkiB, notBefore: now + HOUR });
    expect(future.validateHashes({ hostname: HOST, spkiHashes: [spkiB] })).toMatchObject({
      valid: false,
      reason: "pin-not-yet-valid",
    });

    const retired = new SslPinningManager({ now: () => now });
    const pin = retired.addPin({ hostname: HOST, hash: spkiA });
    retired.retirePin(pin.id);
    expect(retired.validateHashes({ hostname: HOST, spkiHashes: [spkiA] })).toMatchObject({
      valid: false,
      reason: "pin-retired",
    });
  });

  it("matches wildcard pins for exactly one extra label", () => {
    manager.addPin({ hostname: "*.stellar.org", hash: spkiA });

    expect(manager.validateHashes({ hostname: "api.stellar.org", spkiHashes: [spkiA] }).valid).toBe(
      true,
    );
    expect(manager.validateHashes({ hostname: "stellar.org", spkiHashes: [spkiA] }).valid).toBe(
      false,
    );
    expect(
      manager.validateHashes({ hostname: "a.b.stellar.org", spkiHashes: [spkiA] }).valid,
    ).toBe(false);
  });

  it("normalizes the validated hostname", () => {
    manager.addPin({ hostname: HOST, hash: spkiA });

    expect(
      manager.validateHashes({ hostname: "HORIZON.STELLAR.ORG.", spkiHashes: [spkiA] }).valid,
    ).toBe(true);
  });
});

describe("SslPinningManager rotation", () => {
  let manager: SslPinningManager;
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    manager = new SslPinningManager({ now: () => now, rotationOverlapMs: HOUR });
  });

  it("keeps the old pin valid during the overlap and retires it afterwards", () => {
    const oldPin = manager.addPin({ hostname: HOST, hash: spkiA, id: "old" });

    const rotation = manager.rotate(HOST, [{ hash: spkiB, id: "new" }]);
    expect(rotation.hostname).toBe(HOST);
    expect(rotation.added.map((pin) => pin.id)).toEqual(["new"]);
    expect(rotation.previous.map((pin) => pin.id)).toEqual([oldPin.id]);
    expect(rotation.previous[0]!.status).toBe("backup");

    // Both certificates are accepted while clients pick up the new pin.
    expect(manager.validateHashes({ hostname: HOST, spkiHashes: [spkiA] }).valid).toBe(true);
    expect(manager.validateHashes({ hostname: HOST, spkiHashes: [spkiB] }).valid).toBe(true);

    now += HOUR;
    expect(manager.validateHashes({ hostname: HOST, spkiHashes: [spkiA] })).toMatchObject({
      valid: false,
      reason: "pin-retired",
    });
    expect(manager.validateHashes({ hostname: HOST, spkiHashes: [spkiB] }).valid).toBe(true);
  });

  it("retires previous pins immediately when the overlap is zero", () => {
    manager.addPin({ hostname: HOST, hash: spkiA });
    manager.rotate(HOST, [{ hash: spkiB }], { overlapMs: 0 });

    expect(manager.validateHashes({ hostname: HOST, spkiHashes: [spkiA] })).toMatchObject({
      valid: false,
      reason: "pin-retired",
    });
    expect(manager.validateHashes({ hostname: HOST, spkiHashes: [spkiB] }).valid).toBe(true);
  });

  it("leaves the registry untouched when the new pin set is invalid", () => {
    manager.addPin({ hostname: HOST, hash: spkiA });

    expect(() => manager.rotate(HOST, [{ hash: "invalid" }])).toThrow(PinManagementError);
    expect(manager.listPins()).toHaveLength(1);
    expect(manager.listPins()[0]!.status).toBe("active");
    expect(manager.validateHashes({ hostname: HOST, spkiHashes: [spkiA] }).valid).toBe(true);
  });
});

describe("SslPinningManager export and import", () => {
  let manager: SslPinningManager;

  beforeEach(() => {
    manager = new SslPinningManager({ now: () => 5_000 });
  });

  it("round-trips pins through a versioned bundle", () => {
    manager.addPin({ hostname: HOST, hash: spkiA, id: "primary" });
    manager.addPin({ hostname: HOST, hash: certA, kind: "certificate", id: "cert" });

    const bundle = manager.exportPins();
    expect(bundle.version).toBe(SSL_PIN_FORMAT_VERSION);
    expect(bundle.pins).toHaveLength(2);

    const restored = new SslPinningManager({ now: () => 5_000 });
    const imported = restored.importPins(JSON.parse(JSON.stringify(bundle)));
    expect(imported.map((pin) => pin.id)).toEqual(["primary", "cert"]);
    expect(restored.validateHashes({ hostname: HOST, spkiHashes: [spkiA] }).valid).toBe(true);
  });

  it("rejects unsupported or malformed bundles without changing the registry", () => {
    manager.addPin({ hostname: HOST, hash: spkiA });

    expect(() => manager.importPins({ version: 99, pins: [] })).toThrow(PinManagementError);
    expect(() =>
      manager.importPins({ version: SSL_PIN_FORMAT_VERSION, pins: [{ hostname: HOST, hash: "bad" }] }),
    ).toThrow(PinManagementError);
    expect(manager.listPins()).toHaveLength(1);
  });

  it("replaces the registry only when asked to", () => {
    manager.addPin({ hostname: HOST, hash: spkiA });
    const bundle = {
      version: SSL_PIN_FORMAT_VERSION,
      exportedAt: 5_000,
      pins: [
        {
          id: "replacement",
          hostname: HOST,
          kind: "spki" as const,
          hash: spkiB,
          status: "active" as const,
          createdAt: 5_000,
        },
      ],
    };

    manager.importPins(bundle, { replace: true });
    expect(manager.listPins().map((pin) => pin.id)).toEqual(["replacement"]);
    expect(manager.validateHashes({ hostname: HOST, spkiHashes: [spkiB] }).valid).toBe(true);
  });
});

describe("SslPinningManager tracking", () => {
  it("counts validations and keeps a bounded, payload-free trail", () => {
    const manager = new SslPinningManager({ now: () => 7_000, maxTrackedEvents: 3 });
    const pin = manager.addPin({ hostname: HOST, hash: spkiA });

    manager.validateHashes({ hostname: HOST, spkiHashes: [spkiA] });
    manager.validateHashes({ hostname: HOST, spkiHashes: [spkiB] });
    manager.validateHashes({ hostname: HOST, spkiHashes: [spkiA] });

    expect(manager.stats()).toEqual({
      validations: 3,
      successes: 2,
      failures: 1,
      pinsTracked: 1,
      eventsTracked: 3,
      eventsTruncated: true,
    });

    const trail = manager.eventsTrail();
    expect(trail).toHaveLength(3);
    expect(trail.every((event) => event.operation === "validate")).toBe(true);
    expect(trail[1]).toMatchObject({ outcome: "failure", reason: "hash-mismatch" });
    expect(trail[2]).toMatchObject({ outcome: "success", pinId: pin.id });
    expect(JSON.stringify(trail)).not.toContain(spkiA);
  });

  it("exposes pins for a host and resets nothing implicitly", () => {
    const manager = new SslPinningManager({ now: () => 7_000 });
    manager.addPin({ hostname: "*.stellar.org", hash: spkiA });

    expect(manager.hasPins("api.stellar.org")).toBe(true);
    expect(manager.hasPins("example.com")).toBe(false);
    expect(manager.pinsFor("api.stellar.org")).toHaveLength(1);
  });
});
