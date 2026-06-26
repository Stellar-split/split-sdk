import { describe, expect, it } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  validateClientConfig,
  validateOrThrow,
  ConfigValidationError,
} from "../src/configValidator.js";
import type { StellarSplitClientConfig } from "../src/client.js";

function validConfig(): StellarSplitClientConfig {
  return {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
  };
}

describe("validateClientConfig", () => {
  it("returns valid for a minimal correct config", () => {
    const result = validateClientConfig(validConfig());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("catches missing rpcUrl", () => {
    const config = validConfig();
    delete (config as { rpcUrl?: unknown }).rpcUrl;
    const result = validateClientConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "rpcUrl")).toBe(true);
  });

  it("catches invalid rpcUrl format", () => {
    const config = validConfig();
    config.rpcUrl = "not-a-url";
    const result = validateClientConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "rpcUrl")).toBe(true);
  });

  it("catches empty rpcUrl array", () => {
    const config = validConfig();
    config.rpcUrl = [];
    const result = validateClientConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "rpcUrl")).toBe(true);
  });

  it("accepts array of rpcUrls", () => {
    const config = validConfig();
    config.rpcUrl = [
      "https://soroban-testnet.stellar.org",
      "https://soroban-testnet2.stellar.org",
    ];
    const result = validateClientConfig(config);
    expect(result.valid).toBe(true);
  });

  it("catches missing networkPassphrase", () => {
    const config = validConfig();
    delete (config as { networkPassphrase?: unknown }).networkPassphrase;
    const result = validateClientConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "networkPassphrase")).toBe(
      true
    );
  });

  it("catches missing contractId", () => {
    const config = validConfig();
    delete (config as { contractId?: unknown }).contractId;
    const result = validateClientConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "contractId")).toBe(true);
  });

  it("catches invalid contractId format", () => {
    const config = validConfig();
    config.contractId = "not-a-valid-contract-id";
    const result = validateClientConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "contractId")).toBe(true);
  });

  it("catches invalid horizonUrl", () => {
    const config = validConfig();
    config.horizonUrl = "bad-url";
    const result = validateClientConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "horizonUrl")).toBe(true);
  });

  it("accepts valid horizonUrl", () => {
    const config = validConfig();
    config.horizonUrl = "https://horizon.stellar.org";
    const result = validateClientConfig(config);
    expect(result.valid).toBe(true);
  });

  it("catches invalid sponsorAccount", () => {
    const config = validConfig();
    config.sponsorAccount = "invalid-address";
    const result = validateClientConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "sponsorAccount")).toBe(true);
  });

  it("accepts valid sponsorAccount", () => {
    const config = validConfig();
    config.sponsorAccount =
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    const result = validateClientConfig(config);
    expect(result.valid).toBe(true);
  });

  it("catches invalid cache.ttlMs", () => {
    const config = validConfig();
    config.cache = { ttlMs: "1000" as unknown as number };
    const result = validateClientConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "cache.ttlMs")).toBe(true);
  });

  it("warns about unusual network passphrase", () => {
    const config = validConfig();
    config.networkPassphrase = "custom";
    const result = validateClientConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors.some((e) => e.field === "networkPassphrase")).toBe(
      true
    );
    expect(
      result.errors.filter((e) => e.field === "networkPassphrase")[0]!.severity
    ).toBe("warning");
  });

  it("warns about adapter + signingKeypair", () => {
    const config = validConfig();
    config.adapter = {
      getAddress: async () => "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      signTransaction: async (xdr: string) => xdr,
    };
    config.signingKeypair = Keypair.random();
    const result = validateClientConfig(config);
    expect(result.valid).toBe(true);
    expect(
      result.errors.some(
        (e) =>
          e.field === "signingKeypair" && e.severity === "warning"
      )
    ).toBe(true);
  });

  it("catches adapter without getAddress", () => {
    const config = validConfig();
    config.adapter = {
      signTransaction: async (xdr: string) => xdr,
    } as unknown as StellarSplitClientConfig["adapter"];
    const result = validateClientConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "adapter")).toBe(true);
  });
});

describe("validateOrThrow", () => {
  it("does not throw for valid config", () => {
    expect(() => validateOrThrow(validConfig())).not.toThrow();
  });

  it("throws ConfigValidationError for invalid config", () => {
    const config = validConfig();
    delete (config as { contractId?: unknown }).contractId;
    expect(() => validateOrThrow(config)).toThrow(ConfigValidationError);
  });

  it("includes actionable messages in the error", () => {
    const config = validConfig();
    config.rpcUrl = "";
    const config2 = validConfig();
    delete (config2 as { rpcUrl?: unknown }).rpcUrl;

    expect(() => validateOrThrow(config)).toThrow(/rpcUrl/);
    expect(() => validateOrThrow(config2)).toThrow(/rpcUrl/);
  });
});
