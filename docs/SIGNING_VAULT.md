# Pluggable Signing Key Vault Adapter

> **Issue #589**: Pluggable Signing Key Vault Adapter

## Overview

The SDK ships with a narrow, pluggable `Signer` contract that decouples
transaction signing from key storage. Callers can inject any backend that
conforms to the interface — a hardware security module (HSM), a cloud KMS
(AWS KMS, GCP Cloud KMS, Azure Key Vault, HashiCorp Vault), or an
AES-encrypted keystore on disk — without modifying SDK internals.

The adapter can be passed to `StellarSplitClient` via the `signer` constructor
option and is exposed at runtime through `client.signer`.

## Features

- ✅ Narrow `Signer` contract — `sign(txHash: Buffer): Promise<Buffer>`
- ✅ `KeypairSigner` — wraps an in-memory `Keypair` from `@stellar/stellar-sdk`
- ✅ `EncryptedFileSigner` — AES-256-GCM encrypted PEM keystore, decrypted lazily
- ✅ `CloudKmsSigner` — delegates to any injected `KmsClient` implementation
- ✅ Plaintext key material held in a `WeakRef` — GC pressure clears it, and the
  next `sign` call transparently re-reads + re-decrypts the key file
- ✅ No vendor SDK dependencies for cloud KMS — clients are injected by the caller

## Installation

All adapters are exported from the SDK's public API surface:

```typescript
import { KeypairSigner, EncryptedFileSigner, CloudKmsSigner } from "@stellar-split/sdk";
import type { Signer, KmsClient } from "@stellar-split/sdk";
```

## API Reference

### `interface Signer`

```typescript
interface Signer {
  sign(txHash: Buffer): Promise<Buffer>;
}
```

Produces an ed25519 signature over a transaction hash. The input is the raw
32-byte transaction hash (the same bytes produced by `Transaction.hash()` /
`signatureBase()`); the returned value is the raw 64-byte ed25519 signature,
verifiable with `Keypair.verify(txHash, signature)` against the corresponding
public key.

### `class KeypairSigner`

Wraps an in-memory `Keypair` from `@stellar/stellar-sdk`. Useful for local
development and for the common case where the secret seed already lives in the
process (e.g. loaded from an environment variable).

```typescript
import { Keypair } from "@stellar/stellar-sdk";
import { KeypairSigner } from "@stellar-split/sdk";

const keypair = Keypair.fromSecret(process.env.SIGNING_SECRET!);
const signer = new KeypairSigner(keypair);

const signature = await signer.sign(txHash);
```

### `class EncryptedFileSigner`

Reads an AES-256-GCM encrypted PEM key file, decrypts it on first use, and
holds the derived `Keypair` in a `WeakRef`. If the cached keypair has been
collected (or `clearCache()` was called), the next `sign` call re-reads and
re-decrypts the file — so key rotation on disk takes effect without restarting
the process.

**Options:**

| Field | Type | Description |
|-------|------|-------------|
| `aesKey` | `Buffer \| Uint8Array` | AES-256 key (exactly 32 bytes). In production this should be derived from a passphrase or fetched from a secrets manager — never stored next to the encrypted file. |

**Helpers:**

- `encryptSigningKeyToPem(secret, aesKey)` — encrypts a Stellar secret seed
  (`S...`) with AES-256-GCM and returns a PEM-style payload.
- `writeEncryptedSigningKeyFile(filePath, secret, aesKey)` — writes the
  encrypted PEM payload to disk (provisioning convenience).

```typescript
import { Keypair } from "@stellar/stellar-sdk";
import { EncryptedFileSigner, writeEncryptedSigningKeyFile } from "@stellar-split/sdk";
import { randomBytes } from "node:crypto";

const keypair = Keypair.random();
const aesKey = randomBytes(32);
await writeEncryptedSigningKeyFile("./vault.pem", keypair.secret(), aesKey);

const signer = new EncryptedFileSigner("./vault.pem", { aesKey });
const signature = await signer.sign(txHash); // decrypts on first use

signer.clearCache(); // force re-read on the next sign (e.g. after key rotation)
```

### `class CloudKmsSigner`

Delegates signing to an injected `KmsClient`. The SDK deliberately carries no
vendor SDK dependency — implementations are left entirely to the caller, which
also makes the client trivially mockable in tests.

```typescript
interface KmsClient {
  sign(keyId: string, digest: Buffer): Promise<Buffer>;
}
```

```typescript
import { CloudKmsSigner } from "@stellar-split/sdk";
import type { KmsClient } from "@stellar-split/sdk";

const awsKmsClient: KmsClient = {
  async sign(keyId, digest) {
    // ... call AWS KMS Sign API, return raw signature bytes ...
  },
};

const signer = new CloudKmsSigner(awsKmsClient, "alias/split-signing-key");
const signature = await signer.sign(txHash);
```

### `StellarSplitClient` integration

Pass any `Signer` to the client constructor; it is exposed via
`client.signer`:

```typescript
import { Keypair } from "@stellar/stellar-sdk";
import { KeypairSigner, StellarSplitClient } from "@stellar-split/sdk";

const client = new StellarSplitClient({
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: "YOUR_CONTRACT_ID",
  signer: new KeypairSigner(Keypair.fromSecret(process.env.SIGNING_SECRET!)),
});

console.log(client.signer); // KeypairSigner instance (or null when not configured)
```

## Usage Examples

### Custom KMS client for testing

```typescript
import { CloudKmsSigner } from "@stellar-split/sdk";
import { randomBytes } from "node:crypto";

const mockKms = {
  sign: async (keyId: string, digest: Buffer) => randomBytes(64),
};

const signer = new CloudKmsSigner(mockKms, "test-key-id");
```

### Swappable signers

```typescript
let signer: Signer;

if (process.env.KMS_KEY_ID) {
  signer = new CloudKmsSigner(createKmsClient(), process.env.KMS_KEY_ID);
} else {
  signer = new KeypairSigner(Keypair.fromSecret(process.env.SIGNING_SECRET!));
}
```

## Security Notes

- The AES key for `EncryptedFileSigner` must never be stored next to the
  encrypted key file.
- `EncryptedFileSigner` holds the decrypted keypair in a `WeakRef` — it can be
  reclaimed by GC when nothing else references it, minimizing the window in
  which plaintext key material is resident.
- For cloud KMS, the raw key material never enters the SDK process at all.

## Related Issues

- [#589: Pluggable Signing Key Vault Adapter](https://github.com/Stellar-split/split-sdk/issues/589)

## License

MIT
