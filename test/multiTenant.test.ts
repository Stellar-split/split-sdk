import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { StrKey } from "@stellar/stellar-base";
import { MultiTenantClient } from "../src/multiTenant.js";

interface DummyConfig {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
}

describe("MultiTenantClient", () => {
  it("returns the same client instance for repeated tenant IDs and recreates after eviction", () => {
    const contractId = StrKey.encodeContract(randomBytes(32));
    const factory = vi.fn((tenantId: string): DummyConfig => ({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId,
    }));

    const multiTenant = new MultiTenantClient(factory);
    const first = multiTenant.getClient("tenant-a");
    const second = multiTenant.getClient("tenant-a");

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);

    const other = multiTenant.getClient("tenant-b");
    expect(other).not.toBe(first);
    expect(factory).toHaveBeenCalledTimes(2);

    expect(multiTenant.evict("tenant-a")).toBe(true);
    const third = multiTenant.getClient("tenant-a");
    expect(third).not.toBe(first);
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it("evicts all cached tenant clients", () => {
    const contractId = StrKey.encodeContract(randomBytes(32));
    const factory = vi.fn((tenantId: string): DummyConfig => ({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId,
    }));

    const multiTenant = new MultiTenantClient(factory);
    const first = multiTenant.getClient("tenant-a");
    const second = multiTenant.getClient("tenant-b");

    multiTenant.evictAll();

    const third = multiTenant.getClient("tenant-a");
    const fourth = multiTenant.getClient("tenant-b");

    expect(third).not.toBe(first);
    expect(fourth).not.toBe(second);
    expect(factory).toHaveBeenCalledTimes(4);
  });
});
