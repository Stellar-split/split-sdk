import { ApprovalTimeoutError } from "./errors.js";
import { emitSdkEvent } from "./events.js";
import type { ApprovalSessionResult, MultiSigPolicy } from "./types.js";

export type NotificationAdapter = (signerPublicKey: string, txXdr: string) => void | Promise<void>;
export type SignatureApplier = (
  txXdr: string,
  signatures: ReadonlyMap<string, string>,
) => string;

export interface ApprovalWorkflowOptions {
  notifySigner?: NotificationAdapter;
  applySignatures?: SignatureApplier;
}

export class ApprovalSession {
  private readonly signatures = new Map<string, string>();
  private readonly signerWeights = new Map<string, number>();
  private readonly expiresAt: number;
  private completed = false;
  private timer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly txXdr: string,
    private readonly policy: MultiSigPolicy,
    private readonly applySignatures: SignatureApplier,
  ) {
    for (const signer of policy.signers) {
      this.signerWeights.set(signer.publicKey, signer.weight);
    }
    this.expiresAt = Date.now() + policy.timeoutMs;
    this.timer = setTimeout(() => undefined, policy.timeoutMs);
  }

  submitSignature(signerPublicKey: string, signatureBase64: string): ApprovalSessionResult {
    this.assertActive();
    if (!this.signerWeights.has(signerPublicKey)) {
      throw new Error(`Signer is not authorized: ${signerPublicKey}`);
    }

    this.signatures.set(signerPublicKey, signatureBase64);
    emitSdkEvent("approvalReceived", { signerPublicKey });

    if (this.weight >= this.policy.threshold) {
      this.completed = true;
      clearTimeout(this.timer);
      emitSdkEvent("approvalWorkflowComplete", { signerCount: this.signatures.size });
    }

    return { complete: this.completed, weight: this.weight };
  }

  getSignedXdr(): string {
    this.assertActive();
    if (!this.completed) {
      throw new Error("Approval threshold has not been reached");
    }
    return this.applySignatures(this.txXdr, this.signatures);
  }

  private get weight(): number {
    let total = 0;
    for (const publicKey of this.signatures.keys()) {
      total += this.signerWeights.get(publicKey) ?? 0;
    }
    return total;
  }

  private assertActive(): void {
    if (this.completed) return;
    if (Date.now() > this.expiresAt) {
      clearTimeout(this.timer);
      throw new ApprovalTimeoutError(this.policy.timeoutMs);
    }
  }
}

export class ApprovalWorkflowSequencer {
  constructor(private readonly options: ApprovalWorkflowOptions = {}) {}

  initiate(txXdr: string, policy: MultiSigPolicy): ApprovalSession {
    const session = new ApprovalSession(
      txXdr,
      policy,
      this.options.applySignatures ?? ((xdr) => xdr),
    );

    for (const signer of policy.signers) {
      emitSdkEvent("approvalRequested", { signerPublicKey: signer.publicKey });
      void this.options.notifySigner?.(signer.publicKey, txXdr);
    }

    return session;
  }
}
