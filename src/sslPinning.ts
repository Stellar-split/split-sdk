/**
 * SSL/TLS certificate pinning for the StellarSplit SDK (#1323).
 *
 * Provides a pin registry (add / retire / rotate / export / import), strict
 * validation of peer certificates against the registered pins, and a bounded
 * tracking trail.
 *
 * Pins are SHA-256 digests of either the certificate's SubjectPublicKeyInfo
 * (`spki`, the default — survives certificate renewal) or of the DER-encoded
 * certificate (`certificate`), encoded as base64. Validation fails closed:
 * unknown hosts, mismatched hashes, retired pins and expired pins are all
 * rejected, which is what prevents a MITM proxy from impersonating an
 * SDK endpoint with its own certificate.
 *
 * The validator is transport-agnostic. Feed it the peer certificate that the
 * HTTP/TLS stack exposes (Node `tls.TLSSocket#getPeerCertificate()`, Deno
 * `Deno.connectTls`, an undici connector, ...) or precomputed hashes when the
 * platform cannot export DER bytes.
 *
 * @example
 * ```ts
 * const pinning = new SslPinningManager({
 *   pins: [{ hostname: "horizon.stellar.org", hash: SPKI_SHA256_BASE64 }],
 * });
 *
 * const peer = socket.getPeerCertificate(false);
 * await pinning.assertValid({
 *   hostname: "horizon.stellar.org",
 *   certificate: peer.raw,
 *   spki: peer.pubkey,
 * });
 * ```
 */

import { CertificatePinningError } from "./errors.js";

/** Version of the exported pin bundle format. */
export const SSL_PIN_FORMAT_VERSION = 1 as const;
/** SHA-256 digest length in bytes. */
export const PIN_HASH_BYTES = 32;

/** What a pin hashes: the public key (`spki`) or the whole certificate. */
export type PinKind = "spki" | "certificate";

/**
 * Lifecycle state of a pin.
 * - `active` — trusted for validation.
 * - `backup` — trusted during a rotation overlap window.
 * - `retired` — never trusted again.
 */
export type PinStatus = "active" | "backup" | "retired";

/** Why a peer certificate was rejected. */
export type PinFailureReason =
  | "no-pins-for-host"
  | "pinning-not-enforced"
  | "missing-peer-hashes"
  | "hash-mismatch"
  | "pin-retired"
  | "pin-expired"
  | "pin-not-yet-valid";

/** A registered certificate pin. */
export interface CertificatePin {
  /** Stable identifier used by management operations. */
  readonly id: string;
  /** Normalized hostname (optionally a single-label `*.` wildcard). */
  readonly hostname: string;
  /** Hash target. */
  readonly kind: PinKind;
  /** Base64 SHA-256 digest. */
  readonly hash: string;
  /** Lifecycle state. */
  readonly status: PinStatus;
  /** When the pin was registered (epoch ms). */
  readonly createdAt: number;
  /** Optional start of the pin's validity window (epoch ms). */
  readonly notBefore?: number;
  /** Optional end of the pin's validity window (epoch ms). */
  readonly notAfter?: number;
  /** When the pin stops being trusted after a rotation (epoch ms). */
  readonly retireAt?: number;
  /** When the pin was retired (epoch ms). */
  readonly retiredAt?: number;
  /** Optional non-sensitive labels for operators. */
  readonly metadata?: Record<string, string>;
}

/** Caller-supplied pin definition for {@link SslPinningManager.addPin}. */
export interface CertificatePinInput {
  /** Optional explicit id; generated when omitted. */
  id?: string;
  hostname: string;
  kind?: PinKind;
  hash: string;
  status?: PinStatus;
  notBefore?: number;
  notAfter?: number;
  metadata?: Record<string, string>;
}

/** A peer certificate (or precomputed hashes) to validate. */
export interface PeerCertificateInput {
  hostname: string;
  /** DER-encoded leaf certificate. */
  certificate?: Uint8Array | ArrayBuffer;
  /** DER-encoded SubjectPublicKeyInfo of the leaf certificate. */
  spki?: Uint8Array | ArrayBuffer;
  /** Precomputed base64 SHA-256 of the SubjectPublicKeyInfo. */
  spkiHashes?: string[];
  /** Precomputed base64 SHA-256 of the DER certificate. */
  certificateHashes?: string[];
  /** Override the manager clock for this validation. */
  now?: number;
}

/** Hash-only validation input for environments without DER access. */
export interface PinValidationInput {
  hostname: string;
  spkiHashes?: string[];
  certificateHashes?: string[];
  now?: number;
}

/** Outcome of a pin validation. */
export interface PinValidationResult {
  valid: boolean;
  /** Normalized hostname that was validated. */
  hostname: string;
  matchedPinId?: string;
  matchedKind?: PinKind;
  reason?: PinFailureReason;
  /** Number of usable pins considered. */
  checkedPins: number;
}

/** Bounded diagnostic record of a pin operation (never includes key material). */
export interface PinEvent {
  timestamp: number;
  operation: "add" | "remove" | "retire" | "rotate" | "import" | "validate";
  hostname: string;
  pinId?: string;
  outcome: "success" | "failure";
  reason?: PinFailureReason;
}

/** Counters describing pin manager activity. */
export interface SslPinningStats {
  validations: number;
  successes: number;
  failures: number;
  pinsTracked: number;
  eventsTracked: number;
  eventsTruncated: boolean;
}

/** Serialized pin set, suitable for storage or distribution. */
export interface PinBundle {
  version: typeof SSL_PIN_FORMAT_VERSION;
  exportedAt: number;
  pins: CertificatePin[];
}

/** Configuration for {@link SslPinningManager}. */
export interface SslPinningOptions {
  /** Pins registered at construction time. */
  pins?: CertificatePinInput[];
  /**
   * Fail closed when a host has no pins. Defaults to `true`; disable only for
   * staged rollouts where some hosts are not pinned yet.
   */
  enforce?: boolean;
  /** Default overlap applied by {@link SslPinningManager.rotate}. Defaults to 0. */
  rotationOverlapMs?: number;
  /** Maximum number of retained tracking events. Defaults to 100. */
  maxTrackedEvents?: number;
  /** Injectable clock. */
  now?: () => number;
}

/** Options for {@link SslPinningManager.rotate}. */
export interface RotateOptions {
  /**
   * How long previous pins stay trusted while clients pick up the new set.
   * Defaults to the manager's `rotationOverlapMs`.
   */
  overlapMs?: number;
}

/** Result of a rotation. */
export interface RotationResult {
  hostname: string;
  added: CertificatePin[];
  /** Pins demoted to `backup` (or `retired` when the overlap is zero). */
  previous: CertificatePin[];
}

/** Options for {@link SslPinningManager.removePin}. */
export interface RemovePinOptions {
  /** Allow removing the last usable pin of a host. Defaults to false. */
  force?: boolean;
}

/** Options for {@link SslPinningManager.retirePin}. */
export interface RetirePinOptions {
  /** Keep trusting the pin for this long before retiring it. Defaults to 0. */
  graceMs?: number;
}

/** Thrown when a pin operation would leave the registry in an unsafe state. */
export class PinManagementError extends Error {
  readonly pinId?: string;

  constructor(message: string, pinId?: string) {
    super(message);
    this.name = "PinManagementError";
    this.pinId = pinId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown by {@link SslPinningManager.assertValid} with the failure reason. */
export class SslPinningValidationError extends CertificatePinningError {
  readonly reason: PinFailureReason;
  readonly result: PinValidationResult;

  constructor(
    hostname: string,
    expectedFingerprint: string,
    actualFingerprint: string,
    result: PinValidationResult,
  ) {
    super(hostname, expectedFingerprint, actualFingerprint);
    this.name = "SslPinningValidationError";
    this.reason = result.reason ?? "hash-mismatch";
    this.result = result;
  }
}

// ---------------------------------------------------------------------------
// Hashing / hostname helpers
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/** Canonical form used for hash comparison: base64url → base64, no padding. */
function canonicalHash(hash: string): string {
  return hash.trim().replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
}

/**
 * Normalize and strictly validate a pin hostname.
 *
 * Accepts exact hostnames, IPv4/IPv6 literals and a single-label `*.` wildcard
 * (`*.example.com` matches `api.example.com` but not `a.b.example.com`).
 * Schemes, ports, paths, credentials and embedded whitespace are rejected.
 *
 * @throws {PinManagementError} when the hostname is malformed.
 */
export function normalizePinHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (!trimmed) {
    throw new PinManagementError("Pin hostname must not be empty");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed)) {
    throw new PinManagementError(`Pin hostname must not include a scheme: "${hostname}"`);
  }
  if (/[/\\?#@\s]/.test(trimmed)) {
    throw new PinManagementError(
      `Pin hostname must not include a path, query or credentials: "${hostname}"`,
    );
  }

  const isIpv6 = trimmed.startsWith("[") && trimmed.endsWith("]");
  if (isIpv6) {
    return trimmed;
  }
  if (trimmed.includes(":")) {
    throw new PinManagementError(`Pin hostname must not include a port: "${hostname}"`);
  }

  const withoutTrailingDot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  const wildcard = withoutTrailingDot.startsWith("*.");
  const label = wildcard ? withoutTrailingDot.slice(2) : withoutTrailingDot;

  if (!label) {
    throw new PinManagementError(`Pin hostname is missing a domain: "${hostname}"`);
  }
  if (label.includes("*")) {
    throw new PinManagementError(
      `Only a leading "*." wildcard is supported: "${hostname}"`,
    );
  }
  if (label.length > 253) {
    throw new PinManagementError(`Pin hostname is too long: "${hostname}"`);
  }
  const labelPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
  if (!labelPattern.test(label)) {
    throw new PinManagementError(`Pin hostname is not a valid DNS name: "${hostname}"`);
  }

  return wildcard ? `*.${label}` : label;
}

/** True when `hash` is a base64 (or base64url) SHA-256 digest. */
export function isValidPinHash(hash: string): boolean {
  if (typeof hash !== "string") {
    return false;
  }
  const canonical = canonicalHash(hash);
  if (canonical.length === 0 || !/^[A-Za-z0-9+/]+$/.test(canonical)) {
    return false;
  }
  try {
    return base64ToBytes(canonical).length === PIN_HASH_BYTES;
  } catch {
    return false;
  }
}

/** Compute the base64 SHA-256 digest of `data` using Web Crypto. */
export async function sha256Base64(
  data: Uint8Array | ArrayBuffer,
  crypto: Crypto = globalThis.crypto,
): Promise<string> {
  if (!crypto || !crypto.subtle) {
    throw new PinManagementError(
      "Web Crypto is unavailable; pass precomputed hashes to validateHashes() instead",
    );
  }
  const bytes = toBytes(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return bytesToBase64(new Uint8Array(digest));
}

function pinMatchesHostname(pinHostname: string, hostname: string): boolean {
  if (pinHostname === hostname) {
    return true;
  }
  if (!pinHostname.startsWith("*.")) {
    return false;
  }
  const parent = pinHostname.slice(2);
  if (!hostname.endsWith(`.${parent}`)) {
    return false;
  }
  const label = hostname.slice(0, hostname.length - parent.length - 1);
  return label.length > 0 && !label.includes(".");
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

type StoredPin = { -readonly [K in keyof CertificatePin]: CertificatePin[K] };

function clonePin(pin: StoredPin): CertificatePin {
  return {
    ...pin,
    ...(pin.metadata ? { metadata: { ...pin.metadata } } : {}),
  };
}

/**
 * Registry and validator for TLS certificate pins.
 *
 * Validation is strict: a peer is accepted only when at least one usable pin
 * (active or within its rotation overlap) of the matching kind hashes to the
 * same value. Retired, expired and not-yet-valid pins never match, and hosts
 * without pins are rejected unless `enforce` is disabled.
 */
export class SslPinningManager {
  private readonly pins: StoredPin[] = [];
  private readonly events: PinEvent[] = [];
  private readonly enforce: boolean;
  private readonly rotationOverlapMs: number;
  private readonly maxTrackedEvents: number;
  private readonly nowFn: () => number;
  private sequence = 0;
  private eventsTruncated = false;
  private validations = 0;
  private successes = 0;
  private failures = 0;

  constructor(options: SslPinningOptions = {}) {
    this.enforce = options.enforce ?? true;
    this.rotationOverlapMs = options.rotationOverlapMs ?? 0;
    this.maxTrackedEvents = options.maxTrackedEvents ?? 100;
    this.nowFn = options.now ?? (() => Date.now());

    for (const pin of options.pins ?? []) {
      this.addPin(pin);
    }
  }

  // -- management ---------------------------------------------------------

  /** Register a pin. Throws when the pin is malformed or duplicated. */
  addPin(input: CertificatePinInput): CertificatePin {
    const now = this.now();
    const pin = this.buildPin(input, now);
    this.assertNoConflict(pin, this.pins);
    this.pins.push(pin);
    this.track({
      timestamp: now,
      operation: "add",
      hostname: pin.hostname,
      pinId: pin.id,
      outcome: "success",
    });
    return clonePin(pin);
  }

  /** Register several pins atomically (nothing is added if one is invalid). */
  addPins(inputs: CertificatePinInput[]): CertificatePin[] {
    const now = this.now();
    const pending: StoredPin[] = [];
    for (const input of inputs) {
      const pin = this.buildPin(input, now);
      this.assertNoConflict(pin, [...this.pins, ...pending]);
      pending.push(pin);
    }
    this.pins.push(...pending);
    for (const pin of pending) {
      this.track({
        timestamp: now,
        operation: "add",
        hostname: pin.hostname,
        pinId: pin.id,
        outcome: "success",
      });
    }
    return pending.map(clonePin);
  }

  /**
   * Remove a pin. Refuses to remove the last usable pin of a host unless
   * `force` is set, so a rotation mistake cannot silently disable pinning.
   */
  removePin(id: string, options: RemovePinOptions = {}): CertificatePin {
    const index = this.pins.findIndex((pin) => pin.id === id);
    const target = index >= 0 ? this.pins[index] : undefined;
    if (!target) {
      throw new PinManagementError(`No pin registered with id "${id}"`, id);
    }

    const now = this.now();
    if (this.isUsable(target, now) && !options.force) {
      const remaining = this.pins.filter(
        (pin) => pin.id !== id && pin.hostname === target.hostname && this.isUsable(pin, now),
      );
      if (remaining.length === 0) {
        throw new PinManagementError(
          `Refusing to remove the last usable pin for "${target.hostname}"; ` +
            `pass { force: true } to remove it anyway`,
          id,
        );
      }
    }

    this.pins.splice(index, 1);
    this.track({
      timestamp: now,
      operation: "remove",
      hostname: target.hostname,
      pinId: id,
      outcome: "success",
    });
    return clonePin(target);
  }

  /**
   * Retire a pin. With a grace period the pin is demoted to `backup` and stays
   * trusted until the window closes, which allows smooth rollouts.
   */
  retirePin(id: string, options: RetirePinOptions = {}): CertificatePin {
    const pin = this.pins.find((candidate) => candidate.id === id);
    if (!pin) {
      throw new PinManagementError(`No pin registered with id "${id}"`, id);
    }

    const now = this.now();
    if (this.effectiveStatus(pin, now) === "retired") {
      return clonePin(pin);
    }

    const graceMs = options.graceMs ?? 0;
    if (graceMs > 0) {
      pin.status = "backup";
      pin.retireAt = now + graceMs;
    } else {
      pin.status = "retired";
      pin.retiredAt = now;
      delete pin.retireAt;
    }

    this.track({
      timestamp: now,
      operation: "retire",
      hostname: pin.hostname,
      pinId: pin.id,
      outcome: "success",
    });
    return clonePin(pin);
  }

  /**
   * Rotate the pin set of a host: add the new pins and demote the previous
   * ones to `backup` for `overlapMs`, after which they stop being trusted.
   *
   * The operation is atomic: if any new pin is invalid nothing changes.
   */
  rotate(
    hostname: string,
    nextPins: Array<Omit<CertificatePinInput, "hostname"> & { hostname?: string }>,
    options: RotateOptions = {},
  ): RotationResult {
    const now = this.now();
    const normalized = normalizePinHostname(hostname);
    const overlapMs = options.overlapMs ?? this.rotationOverlapMs;
    if (!Number.isFinite(overlapMs) || overlapMs < 0) {
      throw new PinManagementError(`Rotation overlap must be >= 0, received ${overlapMs}`);
    }

    const pending: StoredPin[] = [];
    for (const input of nextPins) {
      const pin = this.buildPin({ ...input, hostname: input.hostname ?? normalized }, now);
      this.assertNoConflict(pin, [...this.pins, ...pending]);
      pending.push(pin);
    }

    const previous = this.pins.filter(
      (pin) =>
        pinMatchesHostname(pin.hostname, normalized) &&
        this.effectiveStatus(pin, now) !== "retired",
    );

    this.pins.push(...pending);
    for (const pin of previous) {
      pin.status = overlapMs > 0 ? "backup" : "retired";
      if (overlapMs > 0) {
        pin.retireAt = now + overlapMs;
        delete pin.retiredAt;
      } else {
        pin.retiredAt = now;
        delete pin.retireAt;
      }
    }

    this.track({
      timestamp: now,
      operation: "rotate",
      hostname: normalized,
      pinId: pending[0]?.id,
      outcome: "success",
    });

    return {
      hostname: normalized,
      added: pending.map(clonePin),
      previous: previous.map(clonePin),
    };
  }

  /** Serialize the pin set for storage or distribution. */
  exportPins(): PinBundle {
    const now = this.now();
    this.refreshStatuses(now);
    return {
      version: SSL_PIN_FORMAT_VERSION,
      exportedAt: now,
      pins: this.pins.map(clonePin),
    };
  }

  /**
   * Load a pin bundle produced by {@link exportPins}. The bundle is validated
   * as a whole; nothing is imported when any entry is malformed.
   */
  importPins(bundle: unknown, options: { replace?: boolean } = {}): CertificatePin[] {
    if (!bundle || typeof bundle !== "object") {
      throw new PinManagementError("Pin bundle must be an object");
    }
    const candidate = bundle as Partial<PinBundle>;
    if (candidate.version !== SSL_PIN_FORMAT_VERSION) {
      throw new PinManagementError(
        `Unsupported pin bundle version "${String(candidate.version)}"; ` +
          `expected ${SSL_PIN_FORMAT_VERSION}`,
      );
    }
    if (!Array.isArray(candidate.pins)) {
      throw new PinManagementError("Pin bundle is missing a pins array");
    }

    const now = this.now();
    const pending: StoredPin[] = [];
    for (const entry of candidate.pins as CertificatePin[]) {
      if (!entry || typeof entry !== "object") {
        throw new PinManagementError("Pin bundle contains a malformed pin");
      }
      pending.push(this.buildPin(entry, now));
    }

    const existing = options.replace ? [] : this.pins;
    pending.forEach((pin, index) => {
      this.assertNoConflict(pin, [...existing, ...pending.slice(0, index)]);
    });

    if (options.replace) {
      this.pins.length = 0;
    }
    this.pins.push(...pending);
    this.track({
      timestamp: now,
      operation: "import",
      hostname: pending[0]?.hostname ?? "(none)",
      outcome: "success",
    });
    return pending.map(clonePin);
  }

  // -- inspection ---------------------------------------------------------

  /** Copy of every registered pin, with lazily expired pins resolved. */
  listPins(): CertificatePin[] {
    this.refreshStatuses(this.now());
    return this.pins.map(clonePin);
  }

  /** Copy of the pins that apply to a host (exact and wildcard matches). */
  pinsFor(hostname: string): CertificatePin[] {
    const normalized = normalizePinHostname(hostname);
    this.refreshStatuses(this.now());
    return this.pins
      .filter((pin) => pinMatchesHostname(pin.hostname, normalized))
      .map(clonePin);
  }

  /** True when at least one pin applies to the host (usable or not). */
  hasPins(hostname: string): boolean {
    return this.pinsFor(hostname).length > 0;
  }

  /** Operation counters and registry size. */
  stats(): SslPinningStats {
    return {
      validations: this.validations,
      successes: this.successes,
      failures: this.failures,
      pinsTracked: this.pins.length,
      eventsTracked: this.events.length,
      eventsTruncated: this.eventsTruncated,
    };
  }

  /** Copy of the bounded, key-material-free operation trail. */
  eventsTrail(): PinEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  // -- validation ---------------------------------------------------------

  /** Validate a peer certificate, hashing its DER bytes with Web Crypto. */
  async validate(peer: PeerCertificateInput): Promise<PinValidationResult> {
    const hashes = await this.collectPeerHashes(peer);
    return this.validateHashes({
      hostname: peer.hostname,
      spkiHashes: hashes.spkiHashes,
      certificateHashes: hashes.certificateHashes,
      now: peer.now,
    });
  }

  /**
   * Validate precomputed peer hashes. Synchronous, so it can be called from a
   * Node `checkServerIdentity` hook that hashes with `node:crypto`.
   */
  validateHashes(input: PinValidationInput): PinValidationResult {
    const now = input.now ?? this.now();
    const hostname = normalizePinHostname(input.hostname);
    const spkiHashes = input.spkiHashes ?? [];
    const certificateHashes = input.certificateHashes ?? [];

    const matching = this.pins.filter((pin) => pinMatchesHostname(pin.hostname, hostname));

    if (matching.length === 0) {
      return this.finish(
        {
          valid: !this.enforce,
          hostname,
          reason: this.enforce ? "no-pins-for-host" : "pinning-not-enforced",
          checkedPins: 0,
        },
        now,
      );
    }

    const usable = matching.filter((pin) => this.isUsable(pin, now));
    if (usable.length === 0) {
      return this.finish(
        {
          valid: false,
          hostname,
          reason:
            this.unusableReason(matching, spkiHashes, certificateHashes, now) ?? "hash-mismatch",
          checkedPins: 0,
        },
        now,
      );
    }

    const candidates = usable.map((pin) => ({
      pin,
      hashes: pin.kind === "spki" ? spkiHashes : certificateHashes,
    }));

    if (!candidates.some((candidate) => candidate.hashes.length > 0)) {
      return this.finish(
        { valid: false, hostname, reason: "missing-peer-hashes", checkedPins: usable.length },
        now,
      );
    }

    for (const candidate of candidates) {
      const expected = canonicalHash(candidate.pin.hash);
      if (candidate.hashes.some((hash) => canonicalHash(hash) === expected)) {
        return this.finish(
          {
            valid: true,
            hostname,
            matchedPinId: candidate.pin.id,
            matchedKind: candidate.pin.kind,
            checkedPins: usable.length,
          },
          now,
        );
      }
    }

    return this.finish(
      {
        valid: false,
        hostname,
        reason:
          this.unusableReason(matching, spkiHashes, certificateHashes, now) ?? "hash-mismatch",
        checkedPins: usable.length,
      },
      now,
    );
  }

  /**
   * Validate a peer and throw {@link SslPinningValidationError} on failure.
   * Use this on every connection to an SDK endpoint to block MITM proxies.
   */
  async assertValid(peer: PeerCertificateInput): Promise<PinValidationResult> {
    const hostname = normalizePinHostname(peer.hostname);
    const hashes = await this.collectPeerHashes(peer);
    const result = this.validateHashes({
      hostname,
      spkiHashes: hashes.spkiHashes,
      certificateHashes: hashes.certificateHashes,
      now: peer.now,
    });

    if (!result.valid) {
      const expected =
        this.pins
          .filter((pin) => pinMatchesHostname(pin.hostname, hostname))
          .map((pin) => `${pin.kind}:${pin.hash}`)
          .join(", ") || "(none)";
      const actual =
        [
          ...hashes.spkiHashes.map((hash) => `spki:${hash}`),
          ...hashes.certificateHashes.map((hash) => `certificate:${hash}`),
        ].join(", ") || "(none)";
      throw new SslPinningValidationError(hostname, expected, actual, result);
    }

    return result;
  }

  // -- internals ----------------------------------------------------------

  private async collectPeerHashes(peer: PeerCertificateInput): Promise<{
    spkiHashes: string[];
    certificateHashes: string[];
  }> {
    const spkiHashes = [...(peer.spkiHashes ?? [])];
    const certificateHashes = [...(peer.certificateHashes ?? [])];
    if (peer.spki) {
      spkiHashes.push(await sha256Base64(peer.spki));
    }
    if (peer.certificate) {
      certificateHashes.push(await sha256Base64(peer.certificate));
    }
    return { spkiHashes, certificateHashes };
  }

  private buildPin(
    input: CertificatePinInput & { createdAt?: number; retireAt?: number; retiredAt?: number },
    now: number,
  ): StoredPin {
    const hostname = normalizePinHostname(input.hostname);
    const kind = input.kind ?? "spki";
    if (kind !== "spki" && kind !== "certificate") {
      throw new PinManagementError(`Unsupported pin kind "${String(kind)}"`, input.id);
    }
    if (!isValidPinHash(input.hash)) {
      throw new PinManagementError(
        `Pin hash must be a base64 SHA-256 digest (${PIN_HASH_BYTES} bytes)`,
        input.id,
      );
    }

    const status = input.status ?? "active";
    if (status !== "active" && status !== "backup" && status !== "retired") {
      throw new PinManagementError(`Unsupported pin status "${String(status)}"`, input.id);
    }

    for (const [name, value] of [
      ["notBefore", input.notBefore],
      ["notAfter", input.notAfter],
      ["createdAt", input.createdAt],
      ["retireAt", input.retireAt],
      ["retiredAt", input.retiredAt],
    ] as const) {
      if (value !== undefined && !Number.isFinite(value)) {
        throw new PinManagementError(`Pin ${name} must be a finite timestamp`, input.id);
      }
    }
    if (
      input.notBefore !== undefined &&
      input.notAfter !== undefined &&
      input.notAfter <= input.notBefore
    ) {
      throw new PinManagementError(
        "Pin notAfter must be later than notBefore",
        input.id,
      );
    }

    const id = input.id ?? `pin-${hostname}-${kind}-${++this.sequence}`;
    const pin: StoredPin = {
      id,
      hostname,
      kind,
      hash: input.hash.trim(),
      status,
      createdAt: input.createdAt ?? now,
      ...(input.notBefore !== undefined ? { notBefore: input.notBefore } : {}),
      ...(input.notAfter !== undefined ? { notAfter: input.notAfter } : {}),
      ...(input.retireAt !== undefined ? { retireAt: input.retireAt } : {}),
      ...(input.retiredAt !== undefined ? { retiredAt: input.retiredAt } : {}),
      ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
    };
    if (pin.status === "retired" && pin.retiredAt === undefined) {
      pin.retiredAt = now;
    }
    return pin;
  }

  private assertNoConflict(pin: StoredPin, others: StoredPin[]): void {
    if (others.some((candidate) => candidate.id === pin.id)) {
      throw new PinManagementError(`Pin id "${pin.id}" is already registered`, pin.id);
    }
    const duplicate = others.some(
      (candidate) =>
        candidate.hostname === pin.hostname &&
        candidate.kind === pin.kind &&
        canonicalHash(candidate.hash) === canonicalHash(pin.hash) &&
        this.effectiveStatus(candidate, this.now()) !== "retired" &&
        pin.status !== "retired",
    );
    if (duplicate) {
      throw new PinManagementError(
        `An equivalent pin already exists for "${pin.hostname}"`,
        pin.id,
      );
    }
  }

  /** True when a pin may authenticate a peer at `now`. */
  private isUsable(pin: StoredPin, now: number): boolean {
    if (this.effectiveStatus(pin, now) === "retired") {
      return false;
    }
    if (pin.notBefore !== undefined && now < pin.notBefore) {
      return false;
    }
    if (pin.notAfter !== undefined && now >= pin.notAfter) {
      return false;
    }
    return true;
  }

  /**
   * Explain a rejection when the presented hash matches a pin that is no
   * longer (or not yet) usable, so operators can tell rotation from an attack.
   */
  private unusableReason(
    matching: StoredPin[],
    spkiHashes: string[],
    certificateHashes: string[],
    now: number,
  ): PinFailureReason | undefined {
    const matches = (predicate: (pin: StoredPin) => boolean): boolean =>
      matching.some((pin) => {
        if (this.isUsable(pin, now) || !predicate(pin)) {
          return false;
        }
        const hashes = pin.kind === "spki" ? spkiHashes : certificateHashes;
        const expected = canonicalHash(pin.hash);
        return hashes.some((hash) => canonicalHash(hash) === expected);
      });

    if (matches((pin) => this.effectiveStatus(pin, now) === "retired")) {
      return "pin-retired";
    }
    if (matches((pin) => pin.notAfter !== undefined && now >= pin.notAfter)) {
      return "pin-expired";
    }
    if (matches((pin) => pin.notBefore !== undefined && now < pin.notBefore)) {
      return "pin-not-yet-valid";
    }
    return undefined;
  }

  /** Resolve lazily expired rotation windows across the registry. */
  private refreshStatuses(now: number): void {
    for (const pin of this.pins) {
      this.effectiveStatus(pin, now);
    }
  }

  /** Resolve the effective status, lazily retiring pins past their window. */
  private effectiveStatus(pin: StoredPin, now: number): PinStatus {
    if (pin.status === "retired") {
      return "retired";
    }
    if (pin.retireAt !== undefined && now >= pin.retireAt) {
      pin.status = "retired";
      pin.retiredAt = pin.retireAt;
      delete pin.retireAt;
      return "retired";
    }
    return pin.status;
  }

  private finish(result: PinValidationResult, now: number): PinValidationResult {
    this.validations += 1;
    if (result.valid) {
      this.successes += 1;
    } else {
      this.failures += 1;
    }
    this.track({
      timestamp: now,
      operation: "validate",
      hostname: result.hostname,
      pinId: result.matchedPinId,
      outcome: result.valid ? "success" : "failure",
      reason: result.reason,
    });
    return result;
  }

  private track(event: PinEvent): void {
    if (this.events.length >= this.maxTrackedEvents) {
      this.events.shift();
      this.eventsTruncated = true;
    }
    this.events.push(event);
  }

  private now(): number {
    return this.nowFn();
  }
}
