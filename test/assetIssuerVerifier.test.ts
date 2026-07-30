import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @stellar/stellar-sdk at module level
vi.mock("@stellar/stellar-sdk", () => {
  return {
    Server: vi.fn(),
    StellarTomlResolver: {
      resolve: vi.fn(),
    },
  };
});

import { Server, StellarTomlResolver } from "@stellar/stellar-sdk";
import { verifyAssetIssuer } from "../src/assetIssuerVerifier.js";

const ISS = "GISSUER1234567890123456789012345678901234567";
const HOR = "https://horizon-testnet.stellar.org";

describe("verifyAssetIssuer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns verified: true when all checks pass", async () => {
    const mockServer = {
      loadAccount: vi.fn().mockResolvedValue({
        home_domain: "anchor.example.com",
        flags: {},
      }),
    };
    (Server as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockServer);
    (StellarTomlResolver.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      CURRENCIES: [
        { code: "USDC", issuer: ISS },
      ],
    });

    const result = await verifyAssetIssuer(HOR, ISS, "USDC");
    expect(result.verified).toBe(true);
    expect(result.accountExists).toBe(true);
    expect(result.homeDomain).toBe("anchor.example.com");
    expect(result.tomlFound).toBe(true);
    expect(result.assetInToml).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns verified: false when account not found", async () => {
    const mockServer = {
      loadAccount: vi.fn().mockRejectedValue(new Error("Not Found")),
    };
    (Server as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockServer);

    const result = await verifyAssetIssuer(HOR, "GNONEXISTENT123456789012345678", "USDC");
    expect(result.verified).toBe(false);
    expect(result.accountExists).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("not found"))).toBe(true);
  });

  it("returns verified: false when no home domain", async () => {
    const mockServer = {
      loadAccount: vi.fn().mockResolvedValue({
        flags: {},
      }),
    };
    (Server as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockServer);

    const result = await verifyAssetIssuer(HOR, ISS, "USDC");
    expect(result.verified).toBe(false);
    expect(result.accountExists).toBe(true);
    expect(result.homeDomain).toBeNull();
    expect(result.errors.some((e) => e.toLowerCase().includes("home_domain"))).toBe(true);
  });

  it("returns verified: false when asset not in toml CURRENCIES", async () => {
    const mockServer = {
      loadAccount: vi.fn().mockResolvedValue({
        home_domain: "anchor.example.com",
        flags: {},
      }),
    };
    (Server as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockServer);
    (StellarTomlResolver.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      CURRENCIES: [{ code: "EURT", issuer: "GOTHERISSUER" }],
    });

    const result = await verifyAssetIssuer(HOR, ISS, "USDC");
    expect(result.verified).toBe(false);
    expect(result.tomlFound).toBe(true);
    expect(result.assetInToml).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("currencies"))).toBe(true);
  });

  it("detects frozen/deauthorised issuer flags", async () => {
    const mockServer = {
      loadAccount: vi.fn().mockResolvedValue({
        home_domain: "anchor.example.com",
        flags: {
          auth_required: true,
          auth_immutable: true,
          auth_clawback_enabled: true,
        },
      }),
    };
    (Server as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockServer);
    (StellarTomlResolver.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      CURRENCIES: [{ code: "USDC", issuer: ISS }],
    });

    const result = await verifyAssetIssuer(HOR, ISS, "USDC");
    expect(result.verified).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("auth_required"))).toBe(true);
    expect(result.errors.some((e) => e.toLowerCase().includes("auth_immutable"))).toBe(true);
    expect(result.errors.some((e) => e.toLowerCase().includes("clawback"))).toBe(true);
  });
});
