import { describe, expect, it } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  parseAmountToStroops,
  validateAssetAmount,
  validateAssetCode,
  validateAssetIssuer,
  validateCustomToken,
  validateStellarAsset,
} from "../stellarAssetValidation";

const ISSUER = Keypair.random().publicKey();
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));

describe("stellarAssetValidation", () => {
  it("classifies valid asset codes by length", () => {
    expect(validateAssetCode("USDC")).toEqual({ valid: true, type: "credit_alphanum4" });
    expect(validateAssetCode("LONGTOKEN12")).toEqual({ valid: true, type: "credit_alphanum12" });
  });

  it("rejects empty, too long and non-alphanumeric asset codes", () => {
    expect(validateAssetCode("").valid).toBe(false);
    expect(validateAssetCode("THIRTEENCHARS").valid).toBe(false);
    expect(validateAssetCode("US-D").valid).toBe(false);
  });

  it("verifies issuer accounts are valid G-addresses", () => {
    expect(validateAssetIssuer(ISSUER)).toBeNull();
    expect(validateAssetIssuer("GNOTAREALKEY")).toMatch(/not a valid Stellar public key/);
    expect(validateAssetIssuer(CONTRACT)).not.toBeNull();
  });

  it("supports custom tokens identified by contract address", () => {
    expect(validateCustomToken(CONTRACT)).toBeNull();
    expect(validateCustomToken(ISSUER)).toMatch(/not a valid contract address/);

    const result = validateStellarAsset({ contractId: CONTRACT, code: "MYTOKEN" });
    expect(result).toEqual({ valid: true, type: "contract", errors: [] });
  });

  it("accepts native XLM without an issuer", () => {
    expect(validateStellarAsset({ code: "XLM" })).toEqual({ valid: true, type: "native", errors: [] });
    expect(validateStellarAsset({ code: "native" }).type).toBe("native");
  });

  it("validates classic assets and enforces allowed issuers", () => {
    expect(validateStellarAsset({ code: "USDC", issuer: ISSUER }).valid).toBe(true);

    const missingIssuer = validateStellarAsset({ code: "USDC" });
    expect(missingIssuer.valid).toBe(false);
    expect(missingIssuer.type).toBeNull();

    const other = Keypair.random().publicKey();
    const disallowed = validateStellarAsset({ code: "USDC", issuer: ISSUER }, { allowedIssuers: [other] });
    expect(disallowed.valid).toBe(false);
    expect(disallowed.errors[0]).toMatch(/allowed issuers/);
  });

  it("parses amounts with Stellar precision", () => {
    expect(parseAmountToStroops("1")).toBe(10_000_000n);
    expect(parseAmountToStroops("0.0000001")).toBe(1n);
    expect(parseAmountToStroops("1.00000001")).toBeNull();
    expect(parseAmountToStroops("-1")).toBeNull();
  });

  it("enforces amount and trustline limits", () => {
    expect(validateAssetAmount("10", "100")).toEqual([]);
    expect(validateAssetAmount("0")).toContain("Amount must be greater than zero");
    expect(validateAssetAmount("922337203685.4775808")[0]).toMatch(/exceeds the maximum/);
    expect(validateAssetAmount("101", "100")[0]).toMatch(/exceeds the asset limit/);

    const result = validateStellarAsset({ code: "USDC", issuer: ISSUER }, { amount: "500", limit: "100" });
    expect(result.valid).toBe(false);
  });
});
