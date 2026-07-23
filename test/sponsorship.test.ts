import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildSponsoredOnboarding,
  MissingSponsorAccountError,
  InsufficientReserveError,
} from "../src/sponsorship.js";

// ---------------------------------------------------------------------------
// Stellar SDK mock
// vi.mock factories are hoisted — no top-level vi.fn() refs allowed inside.
// We push operation objects into a module-level array instead.
// ---------------------------------------------------------------------------

const _ops: unknown[] = [];

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual("@stellar/stellar-sdk");

  const addOperation = vi.fn().mockImplementation(function (
    this: unknown,
    op: unknown
  ) {
    _ops.push(op);
    return this;
  });

  return {
    ...(actual as Record<string, unknown>),
    Account: vi.fn().mockImplementation(() => ({})),
    TransactionBuilder: vi.fn().mockImplementation(() => ({
      addOperation,
      setTimeout: vi.fn().mockReturnThis(),
      build: vi.fn().mockReturnValue({ _builtTx: true }),
    })),
    BASE_FEE: "100",
    Operation: {
      beginSponsoringFutureReserves: vi
        .fn()
        .mockImplementation((opts: unknown) => ({
          type: "beginSponsoring",
          opts,
        })),
      endSponsoringFutureReserves: vi
        .fn()
        .mockImplementation((opts: unknown) => ({
          type: "endSponsoring",
          opts,
        })),
      createAccount: vi
        .fn()
        .mockImplementation((opts: unknown) => ({ type: "createAccount", opts })),
      changeTrust: vi
        .fn()
        .mockImplementation((opts: unknown) => ({ type: "changeTrust", opts })),
    },
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: vi.fn(),
      })),
    },
    xdr: (actual as Record<string, unknown>).xdr,
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SPONSOR = "GBSPONSOR0000000000000000000000000000000000000000000000000";
const NEW_ACCOUNT = "GBNEWACCOUNT000000000000000000000000000000000000000000000";
const PASSPHRASE = "Test SDF Network ; September 2015";

const BASE_CONFIG = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: PASSPHRASE,
  contractId: "CCTEST00000000000000000000000000000000000000000000000000000",
  sponsorAccount: SPONSOR,
};

/** Set the Horizon loadAccount mock to return the given XLM balance. */
async function mockSponsorBalance(xlm: string) {
  const { Horizon } = await import("@stellar/stellar-sdk");
  (Horizon.Server as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    loadAccount: vi.fn().mockResolvedValue({
      balances: [{ asset_type: "native", balance: xlm }],
    }),
  }));
}

beforeEach(() => {
  _ops.length = 0;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Missing sponsor config
// ---------------------------------------------------------------------------

describe("buildSponsoredOnboarding — missing sponsor config", () => {
  it("throws MissingSponsorAccountError when config.sponsorAccount is absent", async () => {
    const { Operation } = await import("@stellar/stellar-sdk");
    const ops = [
      (Operation as unknown as Record<string, (o: unknown) => unknown>).createAccount({
        destination: NEW_ACCOUNT,
        startingBalance: "0",
      }),
    ] as never[];

    await expect(
      buildSponsoredOnboarding(SPONSOR, NEW_ACCOUNT, ops, {
        ...BASE_CONFIG,
        sponsorAccount: undefined,
      })
    ).rejects.toBeInstanceOf(MissingSponsorAccountError);
  });

  it("MissingSponsorAccountError message mentions config.sponsorAccount", async () => {
    const err = await buildSponsoredOnboarding(SPONSOR, NEW_ACCOUNT, [], {
      ...BASE_CONFIG,
      sponsorAccount: undefined,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MissingSponsorAccountError);
    expect((err as Error).message).toMatch(/config\.sponsorAccount/);
  });
});

// ---------------------------------------------------------------------------
// Insufficient balance
// ---------------------------------------------------------------------------

describe("buildSponsoredOnboarding — insufficient reserve", () => {
  it("throws InsufficientReserveError when sponsor balance is too low", async () => {
    // 0.5 XLM available; need 1 XLM (min) + 0.5 XLM (1 op) = 1.5 XLM
    await mockSponsorBalance("0.5000000");

    await expect(
      buildSponsoredOnboarding(SPONSOR, NEW_ACCOUNT, [{}] as never[], {
        ...BASE_CONFIG,
        horizonUrl: "https://horizon-testnet.stellar.org",
      })
    ).rejects.toBeInstanceOf(InsufficientReserveError);
  });

  it("InsufficientReserveError exposes available and required stroops", async () => {
    await mockSponsorBalance("0.5000000"); // 5_000_000 stroops

    const err = await buildSponsoredOnboarding(SPONSOR, NEW_ACCOUNT, [{}] as never[], {
      ...BASE_CONFIG,
      horizonUrl: "https://horizon-testnet.stellar.org",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InsufficientReserveError);
    const typed = err as InsufficientReserveError;
    expect(typed.availableStroops).toBe(5_000_000n);
    // 1 XLM (min) + 0.5 XLM × 1 op = 15_000_000 stroops
    expect(typed.requiredStroops).toBe(15_000_000n);
  });

  it("skips balance check when horizonUrl is not configured", async () => {
    // Even if loadAccount would return zero balance, no Horizon URL → no check
    await mockSponsorBalance("0.0000001");

    await expect(
      buildSponsoredOnboarding(SPONSOR, NEW_ACCOUNT, [], BASE_CONFIG)
    ).resolves.toBeDefined();

    // Horizon.Server should not have been instantiated
    const { Horizon } = await import("@stellar/stellar-sdk");
    const serverCalls = (Horizon.Server as ReturnType<typeof vi.fn>).mock.calls;
    expect(serverCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Correct operation ordering
// ---------------------------------------------------------------------------

describe("buildSponsoredOnboarding — operation ordering", () => {
  it("produces begin → inner ops → end ordering (2 inner ops)", async () => {
    await mockSponsorBalance("100.0000000");

    const { Operation } = await import("@stellar/stellar-sdk");
    const ops = await import("@stellar/stellar-sdk").then((m) => {
      const O = m.Operation as unknown as Record<string, (o: unknown) => unknown>;
      return [
        O.createAccount({ destination: NEW_ACCOUNT, startingBalance: "0" }),
        O.changeTrust({ asset: {} }),
      ] as never[];
    });

    await buildSponsoredOnboarding(SPONSOR, NEW_ACCOUNT, ops, {
      ...BASE_CONFIG,
      horizonUrl: "https://horizon-testnet.stellar.org",
    });

    // begin + 2 inner + end = 4
    expect(_ops).toHaveLength(4);
    expect((_ops[0] as { type: string }).type).toBe("beginSponsoring");
    expect((_ops[1] as { type: string }).type).toBe("createAccount");
    expect((_ops[2] as { type: string }).type).toBe("changeTrust");
    expect((_ops[3] as { type: string }).type).toBe("endSponsoring");

    void Operation; // suppress unused import warning
  });

  it("sets sponsoredId = newAccount on beginSponsoringFutureReserves", async () => {
    await mockSponsorBalance("100.0000000");

    const { Operation } = await import("@stellar/stellar-sdk");

    await buildSponsoredOnboarding(SPONSOR, NEW_ACCOUNT, [], {
      ...BASE_CONFIG,
      horizonUrl: "https://horizon-testnet.stellar.org",
    });

    expect(
      (Operation as unknown as Record<string, ReturnType<typeof vi.fn>>)
        .beginSponsoringFutureReserves
    ).toHaveBeenCalledWith(expect.objectContaining({ sponsoredId: NEW_ACCOUNT }));
  });

  it("sets source = newAccount on endSponsoringFutureReserves", async () => {
    await mockSponsorBalance("100.0000000");

    const { Operation } = await import("@stellar/stellar-sdk");

    await buildSponsoredOnboarding(SPONSOR, NEW_ACCOUNT, [], {
      ...BASE_CONFIG,
      horizonUrl: "https://horizon-testnet.stellar.org",
    });

    expect(
      (Operation as unknown as Record<string, ReturnType<typeof vi.fn>>)
        .endSponsoringFutureReserves
    ).toHaveBeenCalledWith(expect.objectContaining({ source: NEW_ACCOUNT }));
  });

  it("works with zero inner ops — begin + end only", async () => {
    await buildSponsoredOnboarding(SPONSOR, NEW_ACCOUNT, [], BASE_CONFIG);

    expect(_ops).toHaveLength(2);
    expect((_ops[0] as { type: string }).type).toBe("beginSponsoring");
    expect((_ops[1] as { type: string }).type).toBe("endSponsoring");
  });

  it("returns the built transaction object", async () => {
    const tx = await buildSponsoredOnboarding(SPONSOR, NEW_ACCOUNT, [], BASE_CONFIG);
    expect(tx).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Reserve math: required stroops scales with op count
// ---------------------------------------------------------------------------

describe("buildSponsoredOnboarding — reserve math", () => {
  it("requires 0.5 XLM per inner op on top of the 1 XLM sponsor minimum", async () => {
    // 3 ops → required = 10_000_000 + 3 × 5_000_000 = 25_000_000 stroops = 2.5 XLM
    const threeOps = [{}, {}, {}] as never[];

    // 2.4999999 XLM → fail
    await mockSponsorBalance("2.4999999");
    await expect(
      buildSponsoredOnboarding(SPONSOR, NEW_ACCOUNT, threeOps, {
        ...BASE_CONFIG,
        horizonUrl: "https://horizon-testnet.stellar.org",
      })
    ).rejects.toBeInstanceOf(InsufficientReserveError);

    // 2.5000000 XLM → pass
    await mockSponsorBalance("2.5000000");
    await expect(
      buildSponsoredOnboarding(SPONSOR, NEW_ACCOUNT, threeOps, {
        ...BASE_CONFIG,
        horizonUrl: "https://horizon-testnet.stellar.org",
      })
    ).resolves.toBeDefined();
  });
});
