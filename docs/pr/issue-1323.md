# Implement SDK SSL pinning (#1323)

## Summary

Adds a certificate pinning subsystem to `@stellar-split/sdk`: a pin registry with safe lifecycle management,
strict validation of peer certificates, rotation with an overlap window, export/import of pin sets, and bounded
tracking. Validation fails closed, so a MITM proxy presenting its own certificate for an SDK endpoint is rejected.

## What changed

- **New module `src/sslPinning.ts`**
  - `SslPinningManager` stores `CertificatePin` records keyed by normalized hostname. A pin is the base64 SHA-256
    of either the SubjectPublicKeyInfo (`kind: "spki"`, the default — survives certificate renewal) or the
    DER-encoded certificate (`kind: "certificate"`).
  - **Validation** — `validate(peer)` hashes DER bytes with Web Crypto; `validateHashes(...)` validates precomputed
    hashes synchronously (for Node `checkServerIdentity`-style hooks that hash with `node:crypto`).
    `assertValid(peer)` throws `SslPinningValidationError` (a `CertificatePinningError` subclass) carrying the
    failure reason, expected pins and actual peer hashes.
  - **Strictness** — hosts without pins fail closed (`enforce: true` by default); retired, expired and not-yet-valid
    pins never match even when the hash is correct; a peer that only provides hashes of the wrong kind is rejected
    as `missing-peer-hashes`; wildcards match exactly one extra label; hostnames must be bare DNS names (no scheme,
    port, path, credentials).
  - **Certificate management** — `addPin`/`addPins` (atomic batches), `removePin` (refuses to remove the last usable
    pin of a host unless `force`), `retirePin` (immediate or with a grace window), `listPins`, `pinsFor`, `hasPins`.
  - **Rotation** — `rotate(hostname, nextPins, { overlapMs })` adds the new pins and demotes the previous ones to
    `backup` for the overlap, after which they are lazily retired. The operation is atomic: an invalid new pin leaves
    the registry untouched.
  - **Pin sets** — `exportPins()` produces a versioned, JSON-safe `PinBundle`; `importPins(bundle, { replace })`
    validates the whole bundle before touching the registry and rejects unsupported versions.
  - **Tracking** — `stats()` counts validations/successes/failures and registry size; `eventsTrail()` keeps a bounded
    trail of add/remove/retire/rotate/import/validate events with no key material.
- **Exports** added to `src/index.ts` for the manager, errors, constants and public types.
- **Tests** in `test/sslPinning.test.ts` (25 tests) covering hashing vectors, hostname normalization, pin management
  and atomicity, SPKI/certificate validation, mismatch/retired/expired/not-yet-valid/unpinned rejection, wildcards,
  rotation overlap, export/import, and bounded tracking.

## Acceptance criteria addressed

- **Pinning works** — peers are accepted only when a usable pin of the matching kind hashes to the presented
  certificate/public key.
- **Validation strict** — fail-closed by default; retired, expired and not-yet-valid pins are never accepted;
  hostnames and hashes are validated on registration; wildcards are limited to one label.
- **Management safe** — malformed pins, duplicate ids/hashes and unsafe removals are rejected, and batches/rotations
  are atomic.
- **Rotation smooth** — old pins stay trusted for the configured overlap while clients adopt the new set, then expire
  automatically.
- **Track pins** — bounded, payload-free event trail plus counters for observability.
- **MITM protected** — `assertValid()` is designed to run on every connection so a proxy with an untrusted certificate
  cannot impersonate an SDK endpoint.
- **All tests pass** — `npx vitest run test/sslPinning.test.ts`.

## Testing

```bash
npx vitest run test/sslPinning.test.ts
npx tsc --noEmit
```

## Backwards compatibility

Additive only; no existing module or API is modified. The pre-existing `AnchorVerifier.pinnedCertFingerprints`
option (#780) is untouched.

closes #1323
