import { describe, it, expect, vi } from "vitest";
import { aggregateEffects } from "../src/effectAggregator.js";
import type { CollectionPage } from "../src/types.js";

function makePage<T>(records: T[], nextPage: CollectionPage<T> | null = null): CollectionPage<T> {
  return { records, next: vi.fn().mockResolvedValue(nextPage) };
}

function makeServer(effects: unknown[], pageSize = effects.length) {
  const pages: CollectionPage<unknown>[] = [];
  for (let i = 0; i < effects.length; i += pageSize) {
    pages.push(makePage(effects.slice(i, i + pageSize)));
  }
  if (pages.length === 0) pages.push(makePage([]));
  for (let i = 0; i < pages.length - 1; i++) {
    (pages[i].next as ReturnType<typeof vi.fn>).mockResolvedValue(pages[i + 1]);
  }

  return {
    effects: () => ({
      forTransaction: () => ({
        call: () => Promise.resolve(pages[0]),
      }),
    }),
  } as any;
}

describe("aggregateEffects", () => {
  it("aggregates a simple credit/debit pair into net deltas", async () => {
    const server = makeServer([
      { type: "account_debited", account: "GPAYER", asset_type: "native", amount: "10.0000000" },
      { type: "account_credited", account: "GRECIPIENT", asset_type: "native", amount: "10.0000000" },
    ]);

    const summaries = await aggregateEffects(server, "txhash1");

    expect(summaries).toEqual([
      { accountId: "GPAYER", assetDeltas: [{ asset: "native", delta: -100_000_000n }] },
      { accountId: "GRECIPIENT", assetDeltas: [{ asset: "native", delta: 100_000_000n }] },
    ]);
  });

  it("sums deltas across multiple operations for the same account and asset", async () => {
    const server = makeServer([
      { type: "account_debited", account: "GPAYER", asset_type: "native", amount: "6.0000000" },
      { type: "account_debited", account: "GPAYER", asset_type: "native", amount: "4.0000000" },
      { type: "account_credited", account: "GRECIPIENT_A", asset_type: "native", amount: "6.0000000" },
      { type: "account_credited", account: "GRECIPIENT_B", asset_type: "native", amount: "4.0000000" },
    ]);

    const summaries = await aggregateEffects(server, "txhash2");

    expect(summaries).toEqual([
      { accountId: "GPAYER", assetDeltas: [{ asset: "native", delta: -100_000_000n }] },
      { accountId: "GRECIPIENT_A", assetDeltas: [{ asset: "native", delta: 60_000_000n }] },
      { accountId: "GRECIPIENT_B", assetDeltas: [{ asset: "native", delta: 40_000_000n }] },
    ]);
  });

  it("handles a two-recipient payment with path conversion across two credited assets", async () => {
    const server = makeServer([
      { type: "account_debited", account: "GPAYER", asset_type: "native", amount: "20.0000000" },
      { type: "trade", account: "GPAYER", offer_id: "1" },
      {
        type: "account_credited",
        account: "GRECIPIENT_A",
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GISSUER",
        amount: "5.0000000",
      },
      {
        type: "account_credited",
        account: "GRECIPIENT_B",
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GISSUER",
        amount: "5.0000000",
      },
    ], 2);

    const summaries = await aggregateEffects(server, "txhash3");

    expect(summaries).toEqual([
      { accountId: "GPAYER", assetDeltas: [{ asset: "native", delta: -200_000_000n }] },
      { accountId: "GRECIPIENT_A", assetDeltas: [{ asset: "USDC:GISSUER", delta: 50_000_000n }] },
      { accountId: "GRECIPIENT_B", assetDeltas: [{ asset: "USDC:GISSUER", delta: 50_000_000n }] },
    ]);
  });

  it("omits accounts whose deltas net to zero", async () => {
    const server = makeServer([
      { type: "account_credited", account: "GROUNDTRIP", asset_type: "native", amount: "5.0000000" },
      { type: "account_debited", account: "GROUNDTRIP", asset_type: "native", amount: "5.0000000" },
    ]);

    const summaries = await aggregateEffects(server, "txhash4");

    expect(summaries).toEqual([]);
  });

  it("walks multiple pages via the horizon paginator", async () => {
    const server = makeServer(
      [
        { type: "account_debited", account: "GPAYER", asset_type: "native", amount: "1.0000000" },
        { type: "account_credited", account: "GRECIPIENT", asset_type: "native", amount: "1.0000000" },
      ],
      1,
    );

    const summaries = await aggregateEffects(server, "txhash5");

    expect(summaries).toEqual([
      { accountId: "GPAYER", assetDeltas: [{ asset: "native", delta: -10_000_000n }] },
      { accountId: "GRECIPIENT", assetDeltas: [{ asset: "native", delta: 10_000_000n }] },
    ]);
  });
});
