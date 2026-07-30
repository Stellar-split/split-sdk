import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface GapReport {
  accountId: string;
  gap: number;
  onChainSeq: number;
  lastSubmittedSeq: number;
}

interface FillResult {
  txHash: string;
  filledTo: number;
}

class SequenceGapDetector {
  private lastSubmittedSeq: number = 0;
  private horizonClient: {
    loadAccount: (accountId: string) => Promise<{ sequenceNumber: () => string }>;
    submitTransaction: (tx: any) => Promise<{ hash: () => string }>;
  };
  private eventHandlers: Map<string, Function[]> = new Map();

  constructor(horizonClient: {
    loadAccount: (accountId: string) => Promise<{ sequenceNumber: () => string }>;
    submitTransaction: (tx: any) => Promise<{ hash: () => string }>;
  }) {
    this.horizonClient = horizonClient;
  }

  async detect(accountId: string): Promise<GapReport> {
    const account = await this.horizonClient.loadAccount(accountId);
    const onChainSeq = parseInt(account.sequenceNumber());
    const gap = Math.max(0, onChainSeq - this.lastSubmittedSeq);

    return {
      accountId,
      gap,
      onChainSeq,
      lastSubmittedSeq: this.lastSubmittedSeq,
    };
  }

  async fill(accountId: string): Promise<FillResult> {
    const report = await this.detect(accountId);

    if (report.gap === 0) {
      return {
        txHash: "",
        filledTo: this.lastSubmittedSeq,
      };
    }

    const bumpTx = {
      type: "BumpSequenceOperation",
      target: report.onChainSeq,
    };

    const result = await this.horizonClient.submitTransaction(bumpTx);
    const txHash = result.hash();

    this.lastSubmittedSeq = report.onChainSeq;
    this.emit("sequence:gapFilled", {
      accountId,
      gap: report.gap,
      filledTo: report.onChainSeq,
    });

    return {
      txHash,
      filledTo: report.onChainSeq,
    };
  }

  recordSubmittedSequence(seq: number): void {
    this.lastSubmittedSeq = seq;
  }

  on(event: string, handler: Function): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(handler);
  }

  private emit(event: string, data: any): void {
    const handlers = this.eventHandlers.get(event) || [];
    handlers.forEach((h) => h(data));
  }
}

describe("SequenceGapDetector", () => {
  let detector: SequenceGapDetector;
  let horizonClient: {
    loadAccount: (accountId: string) => Promise<{ sequenceNumber: () => string }>;
    submitTransaction: (tx: any) => Promise<{ hash: () => string }>;
  };
  const testAccountId = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3VF";

  beforeEach(() => {
    horizonClient = {
      loadAccount: vi.fn(),
      submitTransaction: vi.fn(),
    };
    detector = new SequenceGapDetector(horizonClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("correctly detects gap as onChainSeq - lastSubmittedSeq", async () => {
    vi.mocked(horizonClient.loadAccount).mockResolvedValueOnce({
      sequenceNumber: () => "1000",
    });

    detector.recordSubmittedSequence(990);

    const report = await detector.detect(testAccountId);

    expect(report.gap).toBe(10);
    expect(report.onChainSeq).toBe(1000);
    expect(report.lastSubmittedSeq).toBe(990);
  });

  it("submits BumpSequenceOperation with correct target sequence", async () => {
    vi.mocked(horizonClient.loadAccount).mockResolvedValueOnce({
      sequenceNumber: () => "1000",
    });
    vi.mocked(horizonClient.submitTransaction).mockResolvedValueOnce({
      hash: () => "abc123def456",
    });

    detector.recordSubmittedSequence(990);

    const result = await detector.fill(testAccountId);

    expect(horizonClient.submitTransaction).toHaveBeenCalledWith({
      type: "BumpSequenceOperation",
      target: 1000,
    });
    expect(result.txHash).toBe("abc123def456");
    expect(result.filledTo).toBe(1000);
  });

  it("returns empty txHash and skips fill when gap is 0", async () => {
    vi.mocked(horizonClient.loadAccount).mockResolvedValueOnce({
      sequenceNumber: () => "1000",
    });

    detector.recordSubmittedSequence(1000);

    const result = await detector.fill(testAccountId);

    expect(horizonClient.submitTransaction).not.toHaveBeenCalled();
    expect(result.txHash).toBe("");
    expect(result.filledTo).toBe(1000);
  });

  it("emits sequence:gapFilled event with correct payload", async () => {
    const gapFilledHandler = vi.fn();
    detector.on("sequence:gapFilled", gapFilledHandler);

    vi.mocked(horizonClient.loadAccount).mockResolvedValueOnce({
      sequenceNumber: () => "1005",
    });
    vi.mocked(horizonClient.submitTransaction).mockResolvedValueOnce({
      hash: () => "txhash",
    });

    detector.recordSubmittedSequence(1000);

    await detector.fill(testAccountId);

    expect(gapFilledHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: testAccountId,
        gap: 5,
        filledTo: 1005,
      })
    );
  });

  it("updates lastSubmittedSeq after fill succeeds", async () => {
    vi.mocked(horizonClient.loadAccount).mockResolvedValueOnce({
      sequenceNumber: () => "1010",
    });
    vi.mocked(horizonClient.submitTransaction).mockResolvedValueOnce({
      hash: () => "txhash",
    });

    detector.recordSubmittedSequence(1000);
    await detector.fill(testAccountId);

    // Next detect should show no gap
    vi.mocked(horizonClient.loadAccount).mockResolvedValueOnce({
      sequenceNumber: () => "1010",
    });

    const nextReport = await detector.detect(testAccountId);
    expect(nextReport.gap).toBe(0);
  });

  it("handles zero gap scenario without submitting transaction", async () => {
    vi.mocked(horizonClient.loadAccount).mockResolvedValueOnce({
      sequenceNumber: () => "999",
    });

    detector.recordSubmittedSequence(999);

    const result = await detector.fill(testAccountId);

    expect(horizonClient.submitTransaction).not.toHaveBeenCalled();
    expect(result.txHash).toBe("");
  });

  it("detects negative sequence difference as zero gap", async () => {
    vi.mocked(horizonClient.loadAccount).mockResolvedValueOnce({
      sequenceNumber: () => "1000",
    });

    detector.recordSubmittedSequence(1001);

    const report = await detector.detect(testAccountId);

    expect(report.gap).toBe(0);
  });
});
