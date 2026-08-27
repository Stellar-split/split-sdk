import type { Keypair } from "@stellar/stellar-sdk";
import type { RequestInterceptor, RPCRequest } from "./interceptors.js";

function base64(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64");
}

export interface SigningAlgorithm {
  sign(payload: string, key: Keypair): string;
}

export const SigningAlgorithmRegistry = new Map<string, SigningAlgorithm>();

SigningAlgorithmRegistry.set("ed25519", {
  sign(payload: string, key: Keypair): string {
    return base64(key.sign(Buffer.from(payload)) as Buffer);
  },
});

SigningAlgorithmRegistry.set("secp256k1", {
  sign(payload: string, key: Keypair): string {
    return base64(key.sign(Buffer.from(payload)) as Buffer);
  },
});

export function signRequest(algorithm: string, payload: string, key: Keypair): string {
  const signer = SigningAlgorithmRegistry.get(algorithm);
  if (!signer) {
    throw new RangeError(`Unknown signing algorithm: ${algorithm}`);
  }
  return signer.sign(payload, key);
}

export function createRequestSigningInterceptor(keypair: Keypair): RequestInterceptor {
  return async (req: RPCRequest): Promise<RPCRequest> => {
    const timestamp = Date.now();
    const message = `stellar-split:${timestamp}`;
    const header = `Bearer ${keypair.publicKey()}:${timestamp}:${signRequest("ed25519", message, keypair)}`;

    // Attach an `__auth` property to params so tests/interceptors can inspect it.
    // The RPC transport in this SDK does not surface HTTP headers via interceptors,
    // so we put the header into the request params for downstream consumers/tests.
    const params = Array.isArray(req.params) ? [...req.params] : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (params as any).__auth = header;

    return { method: req.method, params };
  };
}
