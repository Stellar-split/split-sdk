# Add SDK encryption utilities with key management and rotation (#1320)

## Summary

Adds a self-contained, Web Crypto based encryption layer for sensitive SDK data. Unlike the payment-specific
`PaymentEncryptor`, these utilities are generic, browser-compatible, versioned, and designed around safe key
rotation with a bounded, secret-free tracking trail.

## What changed

- **New module `src/encryptionUtils.ts`**
  - `SdkEncryptor` encrypts strings and JSON values with **AES-256-GCM**, generating a fresh 12-byte IV per payload and emitting a versioned `EncryptedEnvelope` (`version`, `keyVersion`, `iv`, `ciphertext`, `tag`).
  - Authenticated additional data binds the envelope/version header to the ciphertext, so swapping a `keyVersion` or envelope version fails authentication instead of silently decrypting with the wrong key.
  - `deriveEncryptionKey()` derives a 256-bit key from a passphrase with **PBKDF2-SHA256** (configurable iterations, 16-byte minimum salt); `generateSalt()` creates random salts.
  - `EncryptionKeyManager` provides versioned key registration, activation, retirement and atomic `rotate()`. Retired keys remain readable for old ciphertext but can never be used for new encryption or re-activated.
  - `reencrypt()` migrates ciphertext to the current key after rotation without exposing plaintext in logs.
  - Typed errors (`EncryptionUtilityError`, `KeyNotFoundError`, `DecryptionFailedError`) and strict key-length/version validation.
  - `stats()` and `eventsTrail()` expose bounded, **key-material-free** operation counters for tracking; never payloads or key bytes.
- **Exports** added to `src/index.ts` for the encryptor, key manager, helpers, errors, constants and public types.
- **Tests** in `test/encryptionUtils.test.ts` cover deterministic key derivation, validation, retirement rules, round-trips, JSON helpers, tamper/wrong-key rejection, rotation and migration, and bounded tracking.

## Acceptance criteria addressed

- **Encryption works** — AES-256-GCM round-trips for text and JSON.
- **Algorithms secure** — authenticated encryption, random IVs, PBKDF2 derivation, header binding via AAD.
- **Key management safe** — versioned registry, no key material in logs/events, validation of key sizes and versions.
- **Rotation smooth** — atomic rotation plus transparent `reencrypt()` of existing payloads while old keys stay readable.
- **All tests pass** — 8 new tests using the injected Web Crypto implementation.
- **No data leaks** — envelopes contain no plaintext, tracking records contain no key bytes or payloads, and header tampering is rejected.

## Tests and typecheck

```bash
npx vitest run test/encryptionUtils.test.ts
```

The repository's `npm run lint` was already failing before this change due to pre-existing syntax errors and merge-conflict markers in unrelated files (`src/abiCache.ts`, `src/priceOracle.ts`, `src/upgradeMigrationRunner.ts`, `src/validators/deadlineValidator.ts`, `src/types/templates.ts`). This change introduces no new TypeScript errors.

## Backwards compatibility

Additive only; no existing module or API is modified.

closes #1320
