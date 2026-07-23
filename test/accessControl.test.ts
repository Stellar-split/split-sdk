import { describe, expect, it, vi } from "vitest";
import { AclManager, type AsyncAclStore } from "../src/accessControl.js";

describe("AclManager", () => {
  it("grants and revokes access", async () => {
    const manager = new AclManager();
    const resourceId = "invoice-001";
    const address = "GCZST3XVCDTUJ76ZAV2HA72KYTZ4KXX52HRXVWWRWXH2NBDXZWQS2FB2";

    await manager.grant(resourceId, address);
    expect(await manager.check(resourceId, address)).toBe(true);

    await manager.revoke(resourceId, address);
    expect(await manager.check(resourceId, address)).toBe(false);
  });

  it("denies access to ungranteed addresses", async () => {
    const manager = new AclManager();
    const resourceId = "invoice-001";
    const address1 = "GCZST3XVCDTUJ76ZAV2HA72KYTZ4KXX52HRXVWWRWXH2NBDXZWQS2FB2";
    const address2 = "GBRPYHIL2CI3WHSCULNJJMA3CJBYWR5LK662LFXISKW3P7UKDXTX";

    await manager.grant(resourceId, address1);
    expect(await manager.check(resourceId, address1)).toBe(true);
    expect(await manager.check(resourceId, address2)).toBe(false);
  });

  it("supports custom storage backends", async () => {
    const mockStore: AsyncAclStore = {
      grant: vi.fn().mockResolvedValue(undefined),
      revoke: vi.fn().mockResolvedValue(undefined),
      check: vi.fn().mockResolvedValue(true),
    };

    const manager = new AclManager(mockStore);
    const resourceId = "invoice-001";
    const address = "GCZST3XVCDTUJ76ZAV2HA72KYTZ4KXX52HRXVWWRWXH2NBDXZWQS2FB2";

    await manager.grant(resourceId, address);
    expect(mockStore.grant).toHaveBeenCalledWith(resourceId, address);

    await manager.check(resourceId, address);
    expect(mockStore.check).toHaveBeenCalledWith(resourceId, address);

    await manager.revoke(resourceId, address);
    expect(mockStore.revoke).toHaveBeenCalledWith(resourceId, address);
  });

  it("handles multiple grants and revokes on same resource", async () => {
    const manager = new AclManager();
    const resourceId = "invoice-001";
    const address1 = "GCZST3XVCDTUJ76ZAV2HA72KYTZ4KXX52HRXVWWRWXH2NBDXZWQS2FB2";
    const address2 = "GBRPYHIL2CI3WHSCULNJJMA3CJBYWR5LK662LFXISKW3P7UKDXTX";

    await manager.grant(resourceId, address1);
    await manager.grant(resourceId, address2);

    expect(await manager.check(resourceId, address1)).toBe(true);
    expect(await manager.check(resourceId, address2)).toBe(true);

    await manager.revoke(resourceId, address1);
    expect(await manager.check(resourceId, address1)).toBe(false);
    expect(await manager.check(resourceId, address2)).toBe(true);
  });
});
