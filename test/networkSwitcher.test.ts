import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  StellarSplitClient,
  NetworkEnvironment,
  NETWORK_PRESETS,
  NetworkMismatchError,
  StellarSplitError,
} from "../src/index.js";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";

describe("Multi-Network Environment Configuration Switcher (#587)", () => {
  const TEST_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should successfully switch to TESTNET when passphrase matches", async () => {
    const preset = NETWORK_PRESETS[NetworkEnvironment.TESTNET];

    const client = new StellarSplitClient({
      contractId: TEST_CONTRACT_ID,
      rpcUrl: NETWORK_PRESETS[NetworkEnvironment.MAINNET].rpcUrl,
      horizonUrl: NETWORK_PRESETS[NetworkEnvironment.MAINNET].horizonUrl,
      networkPassphrase: NETWORK_PRESETS[NetworkEnvironment.MAINNET].networkPassphrase,
      validateNetwork: false,
    });

    const getNetworkSpy = vi
      .spyOn(SorobanRpc.Server.prototype, "getNetwork")
      .mockResolvedValue({
        passphrase: preset.networkPassphrase,
        protocolVersion: 20,
      });

    await client.switchNetwork(NetworkEnvironment.TESTNET);

    expect(getNetworkSpy).toHaveBeenCalled();
    expect(client.getConfig().rpcUrl).toBe(preset.rpcUrl);
    expect(client.getConfig().horizonUrl).toBe(preset.horizonUrl);
    expect(client.getConfig().networkPassphrase).toBe(preset.networkPassphrase);
  });

  it("should throw NetworkMismatchError when RPC reported passphrase does not match preset", async () => {
    const testnetPreset = NETWORK_PRESETS[NetworkEnvironment.TESTNET];
    const expectedPassphrase = testnetPreset.networkPassphrase;

    const client = new StellarSplitClient({
      contractId: TEST_CONTRACT_ID,
      rpcUrl: NETWORK_PRESETS[NetworkEnvironment.MAINNET].rpcUrl,
      horizonUrl: NETWORK_PRESETS[NetworkEnvironment.MAINNET].horizonUrl,
      networkPassphrase: NETWORK_PRESETS[NetworkEnvironment.MAINNET].networkPassphrase,
      validateNetwork: false,
    });

    vi.spyOn(SorobanRpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: "Wrong Passphrase ; December 2025",
      protocolVersion: 20,
    });

    await expect(client.switchNetwork(NetworkEnvironment.TESTNET)).rejects.toThrow(
      NetworkMismatchError,
    );

    try {
      await client.switchNetwork(NetworkEnvironment.TESTNET);
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkMismatchError);
      const mismatchErr = err as NetworkMismatchError;
      expect(mismatchErr.expected).toBe(expectedPassphrase);
      expect(mismatchErr.actual).toBe("Wrong Passphrase ; December 2025");
      expect(mismatchErr.code).toBe("NETWORK_MISMATCH");
    }

    expect(client.getConfig().rpcUrl).toBe(NETWORK_PRESETS[NetworkEnvironment.MAINNET].rpcUrl);
  });

  it("should support CUSTOM environment with a full NetworkPreset object", async () => {
    const customPreset = {
      horizonUrl: "https://custom-horizon.example.com",
      rpcUrl: "https://custom-rpc.example.com",
      networkPassphrase: "Custom Private Network ; 2026",
    };

    const client = new StellarSplitClient({
      contractId: TEST_CONTRACT_ID,
      rpcUrl: NETWORK_PRESETS[NetworkEnvironment.TESTNET].rpcUrl,
      networkPassphrase: NETWORK_PRESETS[NetworkEnvironment.TESTNET].networkPassphrase,
      validateNetwork: false,
    });

    vi.spyOn(SorobanRpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: customPreset.networkPassphrase,
      protocolVersion: 20,
    });

    await client.switchNetwork(NetworkEnvironment.CUSTOM, customPreset);

    expect(client.getConfig().rpcUrl).toBe(customPreset.rpcUrl);
    expect(client.getConfig().horizonUrl).toBe(customPreset.horizonUrl);
    expect(client.getConfig().networkPassphrase).toBe(customPreset.networkPassphrase);
  });

  it("should support passing NetworkPreset object directly", async () => {
    const customPreset = {
      horizonUrl: "https://direct-horizon.example.com",
      rpcUrl: "https://direct-rpc.example.com",
      networkPassphrase: "Direct Network Passphrase",
    };

    const client = new StellarSplitClient({
      contractId: TEST_CONTRACT_ID,
      rpcUrl: NETWORK_PRESETS[NetworkEnvironment.TESTNET].rpcUrl,
      networkPassphrase: NETWORK_PRESETS[NetworkEnvironment.TESTNET].networkPassphrase,
      validateNetwork: false,
    });

    vi.spyOn(SorobanRpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: customPreset.networkPassphrase,
      protocolVersion: 20,
    });

    await client.switchNetwork(customPreset);

    expect(client.getConfig().rpcUrl).toBe(customPreset.rpcUrl);
    expect(client.getConfig().horizonUrl).toBe(customPreset.horizonUrl);
  });

  it("should throw StellarSplitError when CUSTOM environment is passed without preset", async () => {
    const client = new StellarSplitClient({
      contractId: TEST_CONTRACT_ID,
      rpcUrl: NETWORK_PRESETS[NetworkEnvironment.TESTNET].rpcUrl,
      networkPassphrase: NETWORK_PRESETS[NetworkEnvironment.TESTNET].networkPassphrase,
      validateNetwork: false,
    });

    // @ts-expect-error Testing runtime check for CUSTOM without preset
    await expect(client.switchNetwork(NetworkEnvironment.CUSTOM)).rejects.toThrow(
      StellarSplitError,
    );
  });

  it("should preserve in-flight requests during network switchover window", async () => {
    let resolveGetNetwork: (val: any) => void;
    const getNetworkPromise = new Promise((resolve) => {
      resolveGetNetwork = resolve;
    });

    const testnetPreset = NETWORK_PRESETS[NetworkEnvironment.TESTNET];

    const client = new StellarSplitClient({
      contractId: TEST_CONTRACT_ID,
      rpcUrl: NETWORK_PRESETS[NetworkEnvironment.MAINNET].rpcUrl,
      horizonUrl: NETWORK_PRESETS[NetworkEnvironment.MAINNET].horizonUrl,
      networkPassphrase: NETWORK_PRESETS[NetworkEnvironment.MAINNET].networkPassphrase,
      validateNetwork: false,
    });

    vi.spyOn(SorobanRpc.Server.prototype, "getNetwork").mockImplementation(() => {
      return getNetworkPromise as Promise<any>;
    });

    // Capture initial server reference for in-flight operation
    const inFlightServer = client.server;
    const initialRpcUrl = client.getConfig().rpcUrl;

    // Trigger asynchronous switchNetwork (starts pending network call)
    const switchPromise = client.switchNetwork(NetworkEnvironment.TESTNET);

    // Requests issued during switchover window still see current active server reference until resolved
    expect(inFlightServer.serverURL.toString()).toContain("mainnet");

    // Resolve network check
    resolveGetNetwork!({
      passphrase: testnetPreset.networkPassphrase,
      protocolVersion: 20,
    });

    await switchPromise;

    // After switch completes, client.server points to new endpoint
    expect(client.getConfig().rpcUrl).toBe(testnetPreset.rpcUrl);
    // In-flight server reference retained original URL
    expect(inFlightServer.serverURL.toString()).not.toBe(client.server.serverURL.toString());
    expect(initialRpcUrl).not.toBe(client.getConfig().rpcUrl);
  });
});
