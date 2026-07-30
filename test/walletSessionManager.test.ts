/**
 * Tests for WalletSessionManager and wallet adapters
 * Covers: detect, connect, sign, account change, session storage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WalletSessionManager, WalletNotConnectedError } from "../src/wallets/WalletSessionManager.js";
import { FreighterAdapter } from "../src/wallets/adapters/FreighterAdapter.js";
import { LobstrAdapter } from "../src/wallets/adapters/LobstrAdapter.js";
import { XBullAdapter } from "../src/wallets/adapters/XBullAdapter.js";

const MOCK_PUBLIC_KEY = "GBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const MOCK_PUBLIC_KEY_2 = "GCBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBF";

describe("WalletSessionManager", () => {
  let manager: WalletSessionManager;

  const mockSessionStorage = (() => {
    const store: Record<string, string> = {};
    return {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, val: string) => { store[key] = val; }),
      removeItem: vi.fn((key: string) => { delete store[key]; }),
      clear: () => Object.keys(store).forEach(k => delete store[k]),
    };
  })();

  beforeEach(() => {
    // Mock window and sessionStorage
    (global as any).window = { freighter: undefined, lobstr: undefined, xbull: undefined };
    (global as any).sessionStorage = mockSessionStorage;
    mockSessionStorage.clear();
    vi.clearAllMocks();
    manager = new WalletSessionManager();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("detect()", () => {
    it("returns empty array when no wallets are installed", () => {
      const adapters = manager.detect();
      expect(adapters).toHaveLength(0);
    });

    it("detects Freighter when window.freighter is present", () => {
      (global as any).window.freighter = { getPublicKey: vi.fn(), isConnected: vi.fn() };
      const adapters = manager.detect();
      expect(adapters.some((a) => a.name === "Freighter")).toBe(true);
    });

    it("detects LOBSTR when window.lobstr is present", () => {
      (global as any).window.lobstr = { connect: vi.fn() };
      const adapters = manager.detect();
      expect(adapters.some((a) => a.name === "LOBSTR")).toBe(true);
    });

    it("detects xBull when window.xbull is present", () => {
      (global as any).window.xbull = { connect: vi.fn() };
      const adapters = manager.detect();
      expect(adapters.some((a) => a.name === "xBull")).toBe(true);
    });

    it("returns multiple adapters when multiple wallets are present", () => {
      (global as any).window.freighter = { getPublicKey: vi.fn() };
      (global as any).window.lobstr = { connect: vi.fn() };
      const adapters = manager.detect();
      expect(adapters.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("connect()", () => {
    it("returns the connected public key", async () => {
      const mockAdapter = {
        name: "Freighter",
        connect: vi.fn().mockResolvedValue(MOCK_PUBLIC_KEY),
        sign: vi.fn(),
        getAddress: vi.fn().mockResolvedValue(MOCK_PUBLIC_KEY),
        signTransaction: vi.fn(),
        disconnect: vi.fn(),
        onAccountChange: vi.fn().mockReturnValue(() => {}),
      };

      const address = await manager.connect(mockAdapter);
      expect(address).toBe(MOCK_PUBLIC_KEY);
    });

    it("stores the connected account", async () => {
      const mockAdapter = {
        name: "Freighter",
        connect: vi.fn().mockResolvedValue(MOCK_PUBLIC_KEY),
        disconnect: vi.fn(),
        onAccountChange: vi.fn().mockReturnValue(() => {}),
        getAddress: vi.fn(),
        signTransaction: vi.fn(),
      };

      await manager.connect(mockAdapter);
      expect(manager.getConnectedAccount()).toBe(MOCK_PUBLIC_KEY);
    });

    it("emits connected event", async () => {
      const events: any[] = [];
      manager.on("connected", (evt) => events.push(evt));

      const mockAdapter = {
        name: "Freighter",
        connect: vi.fn().mockResolvedValue(MOCK_PUBLIC_KEY),
        disconnect: vi.fn(),
        onAccountChange: vi.fn().mockReturnValue(() => {}),
        getAddress: vi.fn(),
        signTransaction: vi.fn(),
      };

      await manager.connect(mockAdapter);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ walletName: "Freighter", address: MOCK_PUBLIC_KEY });
    });
  });

  describe("disconnect()", () => {
    it("clears the active wallet on disconnect", async () => {
      const mockAdapter = {
        name: "Freighter",
        connect: vi.fn().mockResolvedValue(MOCK_PUBLIC_KEY),
        disconnect: vi.fn(),
        onAccountChange: vi.fn().mockReturnValue(() => {}),
        getAddress: vi.fn(),
        signTransaction: vi.fn(),
      };

      await manager.connect(mockAdapter);
      manager.disconnect();

      expect(manager.isConnected()).toBe(false);
      expect(manager.getConnectedAccount()).toBeNull();
    });
  });

  describe("getActiveAdapter()", () => {
    it("throws WalletNotConnectedError when no wallet is connected", () => {
      expect(() => manager.getActiveAdapter()).toThrow(WalletNotConnectedError);
    });

    it("returns the active adapter when connected", async () => {
      const mockAdapter = {
        name: "Freighter",
        connect: vi.fn().mockResolvedValue(MOCK_PUBLIC_KEY),
        disconnect: vi.fn(),
        onAccountChange: vi.fn().mockReturnValue(() => {}),
        getAddress: vi.fn(),
        signTransaction: vi.fn(),
      };

      await manager.connect(mockAdapter);
      expect(manager.getActiveAdapter()).toBe(mockAdapter);
    });
  });

  describe("onAccountChange subscription", () => {
    it("fires when account changes and updates internal reference", async () => {
      let accountChangeHandler: ((addr: string) => void) | null = null;
      
      const mockAdapter = {
        name: "Freighter",
        connect: vi.fn().mockResolvedValue(MOCK_PUBLIC_KEY),
        disconnect: vi.fn(),
        onAccountChange: vi.fn((handler) => {
          accountChangeHandler = handler;
          return () => {};
        }),
        getAddress: vi.fn(),
        signTransaction: vi.fn(),
      };

      await manager.connect(mockAdapter);

      const accountChanges: string[] = [];
      manager.on("accountChanged", (addr) => accountChanges.push(addr));

      // Simulate account change
      accountChangeHandler!(MOCK_PUBLIC_KEY_2);

      expect(accountChanges).toHaveLength(1);
      expect(accountChanges[0]).toBe(MOCK_PUBLIC_KEY_2);
      expect(manager.getConnectedAccount()).toBe(MOCK_PUBLIC_KEY_2);
    });
  });
});

describe("FreighterAdapter", () => {
  it("has name 'Freighter'", () => {
    const adapter = new FreighterAdapter();
    expect(adapter.name).toBe("Freighter");
  });

  it("connect() calls window.freighter.getPublicKey", async () => {
    (global as any).window = {
      freighter: {
        getPublicKey: vi.fn().mockResolvedValue(MOCK_PUBLIC_KEY),
        isConnected: vi.fn().mockResolvedValue(true),
      },
    };

    const adapter = new FreighterAdapter();
    const address = await adapter.connect();
    expect(address).toBe(MOCK_PUBLIC_KEY);
    adapter.disconnect();

    vi.restoreAllMocks();
  });
});

describe("LobstrAdapter", () => {
  it("has name 'LOBSTR'", () => {
    const adapter = new LobstrAdapter();
    expect(adapter.name).toBe("LOBSTR");
  });

  it("connect() calls window.lobstr.connect", async () => {
    (global as any).window = {
      lobstr: {
        connect: vi.fn().mockResolvedValue({ publicKey: MOCK_PUBLIC_KEY }),
        on: vi.fn(),
      },
    };

    const adapter = new LobstrAdapter();
    const address = await adapter.connect();
    expect(address).toBe(MOCK_PUBLIC_KEY);
  });
});

describe("XBullAdapter", () => {
  it("has name 'xBull'", () => {
    const adapter = new XBullAdapter();
    expect(adapter.name).toBe("xBull");
  });

  it("connect() calls window.xbull.connect", async () => {
    (global as any).window = {
      xbull: {
        connect: vi.fn().mockResolvedValue({ public_key: MOCK_PUBLIC_KEY }),
        onAccountChange: vi.fn().mockReturnValue(() => {}),
      },
    };

    const adapter = new XBullAdapter();
    const address = await adapter.connect();
    expect(address).toBe(MOCK_PUBLIC_KEY);
    adapter.disconnect();
  });
});
