/**
 * Tests for StellarTomlParser and AnchorVerifier (#487)
 *
 * All HTTP and Horizon calls are intercepted with vi.spyOn / vi.stubGlobal
 * so no real network traffic is produced.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Horizon } from "@stellar/stellar-sdk";
import { StellarTomlParser } from "../src/anchors/StellarTomlParser.js";
import { AnchorVerifier } from "../src/anchors/AnchorVerifier.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const DOMAIN  = "example.com";
const TOML_URL = `https://${DOMAIN}/.well-known/stellar.toml`;

/** Minimal stellar.toml covering all SEP-1 top-level sections. */
// NOTE: In TOML, bare keys before the first section header are at the top level.
// ACCOUNTS must appear before any [SECTION] header to be top-level.
const FULL_TOML = `
ACCOUNTS=["${ISSUER}"]

[DOCUMENTATION]
ORG_NAME="Example Org"
ORG_URL="https://example.com"
OP_EMAIL="ops@example.com"

[[CURRENCIES]]
code="USDC"
issuer="${ISSUER}"
name="USD Coin"
decimals=7
is_asset_anchored=true
anchor_asset_type="fiat"
anchor_asset="USD"

[[CURRENCIES]]
code="EURT"
issuer="${ISSUER}"
name="Euro Token"

[[VALIDATORS]]
alias="example-validator"
public_key="${ISSUER}"
host="https://validator.example.com"
history="https://history.example.com"
`;

/** Minimal account mock with home_domain. */
function makeAccountWithDomain(domain: string | undefined) {
  return {
    sequenceNumber: () => "100",
    home_domain: domain,
    balances: [],
  };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof vi.fn>;
let loadAccountSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Stub global fetch
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);

  // Default: fetch returns the full TOML
  fetchSpy.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(FULL_TOML),
  });

  // Stub Horizon loadAccount
  loadAccountSpy = vi.spyOn(
    Horizon.Server.prototype,
    "loadAccount",
  ) as ReturnType<typeof vi.spyOn>;
  loadAccountSpy.mockResolvedValue(makeAccountWithDomain(DOMAIN) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// StellarTomlParser tests
// ---------------------------------------------------------------------------

describe("StellarTomlParser — fetch and parse", () => {
  it("fetches from the correct well-known URL", async () => {
    const parser = new StellarTomlParser();
    await parser.fetch(DOMAIN);
    expect(fetchSpy).toHaveBeenCalledWith(TOML_URL, expect.any(Object));
  });

  it("parses the DOCUMENTATION section correctly", async () => {
    const parser = new StellarTomlParser();
    const meta = await parser.fetch(DOMAIN);
    expect(meta.DOCUMENTATION?.ORG_NAME).toBe("Example Org");
    expect(meta.DOCUMENTATION?.OP_EMAIL).toBe("ops@example.com");
  });

  it("parses the CURRENCIES array correctly", async () => {
    const parser = new StellarTomlParser();
    const meta = await parser.fetch(DOMAIN);
    expect(meta.CURRENCIES).toHaveLength(2);
    const usdc = meta.CURRENCIES!.find((c) => c.code === "USDC");
    expect(usdc).toBeDefined();
    expect(usdc!.issuer).toBe(ISSUER);
    expect(usdc!.is_asset_anchored).toBe(true);
    expect(usdc!.anchor_asset).toBe("USD");
  });

  it("parses the VALIDATORS array correctly", async () => {
    const parser = new StellarTomlParser();
    const meta = await parser.fetch(DOMAIN);
    expect(meta.VALIDATORS).toHaveLength(1);
    expect(meta.VALIDATORS![0]!.alias).toBe("example-validator");
  });

  it("parses the ACCOUNTS array correctly", async () => {
    const parser = new StellarTomlParser();
    const meta = await parser.fetch(DOMAIN);
    expect(meta.ACCOUNTS).toContain(ISSUER);
  });

  it("attaches domain and tomlUrl to the result", async () => {
    const parser = new StellarTomlParser();
    const meta = await parser.fetch(DOMAIN);
    expect(meta.domain).toBe(DOMAIN);
    expect(meta.tomlUrl).toBe(TOML_URL);
  });
});

describe("StellarTomlParser — caching", () => {
  it("returns cached result on a second fetch within TTL without hitting network", async () => {
    const parser = new StellarTomlParser({ tomlCacheTtlMs: 60_000 });

    await parser.fetch(DOMAIN);
    await parser.fetch(DOMAIN); // second call

    // Fetch should only have been called once
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("isCached returns true after a successful fetch", async () => {
    const parser = new StellarTomlParser({ tomlCacheTtlMs: 60_000 });
    expect(parser.isCached(DOMAIN)).toBe(false);
    await parser.fetch(DOMAIN);
    expect(parser.isCached(DOMAIN)).toBe(true);
  });

  it("makes a fresh HTTP request after TTL expires", async () => {
    vi.useFakeTimers();
    const parser = new StellarTomlParser({ tomlCacheTtlMs: 1_000 });

    await parser.fetch(DOMAIN);
    // Advance time past the TTL
    vi.advanceTimersByTime(2_000);

    await parser.fetch(DOMAIN);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("clearCache invalidates the entry so the next fetch goes to the network", async () => {
    const parser = new StellarTomlParser({ tomlCacheTtlMs: 60_000 });

    await parser.fetch(DOMAIN);
    parser.clearCache(DOMAIN);
    await parser.fetch(DOMAIN);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("StellarTomlParser — error handling", () => {
  it("throws StellarTomlFetchError on non-OK HTTP response", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: () => Promise.resolve(""),
    });

    const parser = new StellarTomlParser();
    await expect(parser.fetch(DOMAIN)).rejects.toMatchObject({
      code: "STELLAR_TOML_FETCH_ERROR",
      domain: DOMAIN,
    });
  });

  it("throws StellarTomlFetchError on network failure", async () => {
    fetchSpy.mockRejectedValue(new Error("Network unreachable"));

    const parser = new StellarTomlParser();
    await expect(parser.fetch(DOMAIN)).rejects.toMatchObject({
      code: "STELLAR_TOML_FETCH_ERROR",
    });
  });
});

// ---------------------------------------------------------------------------
// AnchorVerifier tests
// ---------------------------------------------------------------------------

describe("AnchorVerifier — verify()", () => {
  it("returns verified: true when issuer home_domain TOML has matching CURRENCIES entry", async () => {
    const verifier = new AnchorVerifier();
    const result = await verifier.verify(ISSUER, "USDC");

    expect(result.verified).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.currencyEntry?.code).toBe("USDC");
    expect(result.currencyEntry?.issuer).toBe(ISSUER);
    expect(result.tomlUrl).toBe(TOML_URL);
  });

  it("returns { verified: false, issues: ['no_home_domain'] } when account has no home_domain", async () => {
    loadAccountSpy.mockResolvedValue(makeAccountWithDomain(undefined) as any);

    const verifier = new AnchorVerifier();
    const result = await verifier.verify(ISSUER, "USDC");

    expect(result.verified).toBe(false);
    expect(result.issues).toContain("no_home_domain");
  });

  it("returns { verified: false, issues: ['currency_not_found'] } when TOML has no matching entry", async () => {
    const verifier = new AnchorVerifier();
    const result = await verifier.verify(ISSUER, "XLMT"); // unknown asset code

    expect(result.verified).toBe(false);
    expect(result.issues).toContain("currency_not_found");
  });

  it("returns { verified: false, issues: ['toml_fetch_failed'] } when TOML cannot be fetched", async () => {
    fetchSpy.mockRejectedValue(new Error("Connection refused"));

    const verifier = new AnchorVerifier();
    const result = await verifier.verify(ISSUER, "USDC");

    expect(result.verified).toBe(false);
    expect(result.issues).toContain("toml_fetch_failed");
  });

  it("returns { verified: false, issues: [...] } when account load fails", async () => {
    loadAccountSpy.mockRejectedValue(new Error("Not Found"));

    const verifier = new AnchorVerifier();
    const result = await verifier.verify(ISSUER, "USDC");

    expect(result.verified).toBe(false);
    expect(result.issues.some((i) => i.startsWith("account_load_failed"))).toBe(true);
  });
});

describe("AnchorVerifier — TOML cache integration", () => {
  it("reuses the cached TOML on a second verify() call for the same domain", async () => {
    const verifier = new AnchorVerifier();

    await verifier.verify(ISSUER, "USDC");
    await verifier.verify(ISSUER, "EURT"); // same domain, different asset

    // fetch should only have been called once (parser cache hit on 2nd call)
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("exposes parser so callers can clear the cache", async () => {
    const verifier = new AnchorVerifier();
    await verifier.verify(ISSUER, "USDC");

    verifier.parser.clearCache();
    await verifier.verify(ISSUER, "USDC");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
