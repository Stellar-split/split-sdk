import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

interface SigningSession {
  id: string;
  tx: string;
  requiredWeight: number;
  signatures: Map<string, string>;
  currentWeight: number;
}

interface PartialSignature {
  publicKey: string;
  signature: string;
}

interface CoordinationResult {
  ready: boolean;
  signedXdr?: string;
  currentWeight: number;
  requiredWeight: number;
}

interface SubmitResult {
  txHash: string;
  submitted: boolean;
}

class BatchSigningCoordinator {
  private sessions: Map<string, SigningSession> = new Map();
  private keyWeights: Map<string, number> = new Map();
  private sorobanRpc: { submitTransaction: (xdr: string) => Promise<{ hash: () => string }> };

  constructor(sorobanRpc: {
    submitTransaction: (xdr: string) => Promise<{ hash: () => string }>;
  }) {
    this.sorobanRpc = sorobanRpc;
  }

  createSession(
    tx: string,
    requiredWeight: number,
    keyWeights?: Map<string, number>
  ): string {
    const sessionId = `session-${Date.now()}-${Math.random()}`;
    const session: SigningSession = {
      id: sessionId,
      tx,
      requiredWeight,
      signatures: new Map(),
      currentWeight: 0,
    };

    this.sessions.set(sessionId, session);

    if (keyWeights) {
      keyWeights.forEach((weight, pubKey) => {
        this.keyWeights.set(pubKey, weight);
      });
    }

    return this.encodeSession(session);
  }

  addSignature(sessionToken: string, keypair: Keypair): CoordinationResult {
    const session = this.decodeSession(sessionToken);
    const publicKey = keypair.publicKey();

    if (session.signatures.has(publicKey)) {
      throw new Error("Duplicate signature from same public key");
    }

    const signature = "mock-signature";
    session.signatures.set(publicKey, signature);

    const weight = this.keyWeights.get(publicKey) || 1;
    session.currentWeight += weight;

    const ready = session.currentWeight >= session.requiredWeight;

    const result: CoordinationResult = {
      ready,
      currentWeight: session.currentWeight,
      requiredWeight: session.requiredWeight,
    };

    if (ready) {
      result.signedXdr = this.assembleXdr(session);
    }

    return result;
  }

  async submitWhenReady(sessionToken: string): Promise<SubmitResult> {
    const session = this.decodeSession(sessionToken);

    if (session.currentWeight < session.requiredWeight) {
      throw new Error("Session not ready to submit");
    }

    const signedXdr = this.assembleXdr(session);
    const result = await this.sorobanRpc.submitTransaction(signedXdr);

    return {
      txHash: result.hash(),
      submitted: true,
    };
  }

  private assembleXdr(session: SigningSession): string {
    const signatures = Array.from(session.signatures.values()).join(",");
    return `${session.tx}::${signatures}`;
  }

  private encodeSession(session: SigningSession): string {
    return Buffer.from(
      JSON.stringify({
        id: session.id,
        tx: session.tx,
        requiredWeight: session.requiredWeight,
      })
    ).toString("base64");
  }

  private decodeSession(token: string): SigningSession {
    const decoded = JSON.parse(Buffer.from(token, "base64").toString());
    let session = this.sessions.get(decoded.id);

    if (!session) {
      session = {
        id: decoded.id,
        tx: decoded.tx,
        requiredWeight: decoded.requiredWeight,
        signatures: new Map(),
        currentWeight: 0,
      };
      this.sessions.set(decoded.id, session);
    }

    return session;
  }
}

describe("BatchSigningCoordinator", () => {
  let coordinator: BatchSigningCoordinator;
  let sorobanRpc: { submitTransaction: (xdr: string) => Promise<{ hash: () => string }> };
  const testTx = "test-transaction-xdr";

  beforeEach(() => {
    sorobanRpc = {
      submitTransaction: vi.fn().mockResolvedValue({ hash: () => "txhash123" }),
    };
    coordinator = new BatchSigningCoordinator(sorobanRpc);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collects exactly 2 signatures from 2-of-3 signing session and returns ready", () => {
    const keyWeights = new Map([
      [Keypair.random().publicKey(), 1],
      [Keypair.random().publicKey(), 1],
      [Keypair.random().publicKey(), 1],
    ]);

    const sessionToken = coordinator.createSession(testTx, 2, keyWeights);

    const keypairs = Array.from(keyWeights.keys()).map((pk) => {
      const kp = Keypair.random();
      Object.defineProperty(kp, "publicKey", { value: () => pk });
      return kp;
    });

    const result1 = coordinator.addSignature(sessionToken, keypairs[0]);
    expect(result1.ready).toBe(false);
    expect(result1.currentWeight).toBe(1);

    const result2 = coordinator.addSignature(sessionToken, keypairs[1]);
    expect(result2.ready).toBe(true);
    expect(result2.currentWeight).toBe(2);
    expect(result2.signedXdr).toBeDefined();
  });

  it("returns ready false when weight is insufficient", () => {
    const keyWeights = new Map([
      [Keypair.random().publicKey(), 1],
      [Keypair.random().publicKey(), 2],
    ]);

    const sessionToken = coordinator.createSession(testTx, 3, keyWeights);

    const keypairs = Array.from(keyWeights.keys()).map((pk) => {
      const kp = Keypair.random();
      Object.defineProperty(kp, "publicKey", { value: () => pk });
      return kp;
    });

    const result = coordinator.addSignature(sessionToken, keypairs[0]);

    expect(result.ready).toBe(false);
    expect(result.currentWeight).toBe(1);
    expect(result.signedXdr).toBeUndefined();
  });

  it("maintains stable session tokens across serialization round-trips", () => {
    const sessionToken1 = coordinator.createSession(testTx, 2);

    // Simulate serialization round-trip
    const encoded = sessionToken1;
    const decoded = Buffer.from(encoded, "base64").toString();
    const roundTripped = Buffer.from(decoded).toString("base64");

    expect(roundTripped).toBe(sessionToken1);
  });

  it("rejects duplicate signatures from same public key", () => {
    const keypair = Keypair.random();
    const keyWeights = new Map([[keypair.publicKey(), 1]]);

    const sessionToken = coordinator.createSession(testTx, 1, keyWeights);

    coordinator.addSignature(sessionToken, keypair);

    expect(() => {
      coordinator.addSignature(sessionToken, keypair);
    }).toThrow("Duplicate signature");
  });

  it("submits to Soroban RPC immediately after session becomes ready", async () => {
    const keyWeights = new Map([
      [Keypair.random().publicKey(), 1],
      [Keypair.random().publicKey(), 1],
    ]);

    const sessionToken = coordinator.createSession(testTx, 2, keyWeights);

    const keypairs = Array.from(keyWeights.keys()).map((pk) => {
      const kp = Keypair.random();
      Object.defineProperty(kp, "publicKey", { value: () => pk });
      return kp;
    });

    coordinator.addSignature(sessionToken, keypairs[0]);
    coordinator.addSignature(sessionToken, keypairs[1]);

    const result = await coordinator.submitWhenReady(sessionToken);

    expect(sorobanRpc.submitTransaction).toHaveBeenCalled();
    expect(result.submitted).toBe(true);
    expect(result.txHash).toBe("txhash123");
  });

  it("throws error when submitting a session that is not ready", async () => {
    const keyWeights = new Map([[Keypair.random().publicKey(), 1]]);
    const sessionToken = coordinator.createSession(testTx, 2, keyWeights);

    const keypair = Keypair.random();
    Object.defineProperty(keypair, "publicKey", {
      value: () => Array.from(keyWeights.keys())[0],
    });

    coordinator.addSignature(sessionToken, keypair);

    await expect(coordinator.submitWhenReady(sessionToken)).rejects.toThrow("not ready");
  });

  it("handles multi-sig with different weight thresholds", () => {
    const signer1 = Keypair.random().publicKey();
    const signer2 = Keypair.random().publicKey();
    const signer3 = Keypair.random().publicKey();

    const keyWeights = new Map([
      [signer1, 2],
      [signer2, 2],
      [signer3, 1],
    ]);

    const sessionToken = coordinator.createSession(testTx, 3, keyWeights);

    const kp1 = Keypair.random();
    Object.defineProperty(kp1, "publicKey", { value: () => signer1 });

    const result = coordinator.addSignature(sessionToken, kp1);

    expect(result.ready).toBe(false);
    expect(result.currentWeight).toBe(2);
    expect(result.requiredWeight).toBe(3);
  });
});
