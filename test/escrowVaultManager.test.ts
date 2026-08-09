import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EscrowVaultManager, _clearVaultStoreForTesting } from "../src/escrowVaultManager.js";
import { ValidationError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const INVOICE_ID = "invoice-001";
const ASSET = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const AMOUNT = 100_000_000n; // 10 USDC
const RECIPIENT = "GCZST3XVCDTUJ76ZAV2HA72KYTZ4KXX52HRXVWWRWXH2NBDXZWQS2FB2";
// Real Stellar testnet keypair (generated via Keypair.random())
const SIGNER_SECRET = "SACMTNNDGFQ3VHH626GZHSMYP4IXFHNXALFJGH2N7EIWWWYCPVERWGWY";
const SIGNER_PUBLIC = "GACGEUOKM4DH3W24QYRONGWCFWAZ4OGYVAKCFB26WFM2VEWC6ETCSBLS";

const PAST_DATE = new Date(Date.now() - 60_000);    // 1 minute ago
const FUTURE_DATE = new Date(Date.now() + 60_000);  // 1 minute from now

// Fake vault creation response
const FAKE_TX_HASH = "abc123deadbeef";
// Stellar claimable balance IDs must be 72 hex chars (8 type prefix + 64 hash)
const FAKE_BALANCE_ID = "00000000da0d57da7d4850e7fc10d2a9d0ebc731f7afb40574c03395b17d49149b91f5be";

/**
 * Build a fake Horizon server object returned by _getServer().
 */
function mockHorizonServer(overrides: {
  loadAccount?: () => Promise<unknown>;
  submitTransaction?: () => Promise<unknown>;
  claimableBalance?: () => Promise<unknown>;
  operations?: () => Promise<unknown>;
} = {}) {
  const fakeAccount = {
    accountId: () => SIGNER_PUBLIC,
    sequenceNumber: () => "0",
    incrementSequenceNumber: vi.fn(),
  };

  return {
    loadAccount: overrides.loadAccount ?? vi.fn().mockResolvedValue(fakeAccount),
    submitTransaction: overrides.submitTransaction ??
      vi.fn().mockResolvedValue({ hash: FAKE_TX_HASH }),
    claimableBalance: overrides.claimableBalance ??
      vi.fn().mockReturnValue({ call: vi.fn().mockResolvedValue({}) }),
    operations: overrides.operations ??
      vi.fn().mockReturnValue({
        forTransaction: vi.fn().mockReturnThis(),
        call: vi.fn().mockResolvedValue({
          records: [{ balance_id: FAKE_BALANCE_ID }],
        }),
      }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EscrowVaultManager", () => {
  let manager: EscrowVaultManager;

  beforeEach(() => {
    _clearVaultStoreForTesting();
    manager = new EscrowVaultManager({
      horizonUrl: HORIZON_URL,
      networkPassphrase: NETWORK_PASSPHRASE,
      pollIntervalMs: 0, // disable auto-polling in tests
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── create() ─────────────────────────────────────────────────────────────

  describe("create()", () => {
    it("creates a vault and returns a holding EscrowVault record", async () => {
      const fakeServer = mockHorizonServer();
      vi.spyOn(manager as any, "_extractBalanceId").mockResolvedValue(FAKE_BALANCE_ID);
      vi.spyOn(manager as any, "_getServer").mockReturnValue(fakeServer);

      const vault = await manager.create(
        INVOICE_ID,
        AMOUNT,
        ASSET,
        FUTURE_DATE,
        SIGNER_SECRET,
      );

      expect(vault.invoiceId).toBe(INVOICE_ID);
      expect(vault.amount).toBe(AMOUNT);
      expect(vault.asset).toBe(ASSET);
      expect(vault.status).toBe("holding");
      expect(vault.balanceId).toBe(FAKE_BALANCE_ID);
      expect(vault.vaultId).toBeTruthy();
    });

    it("emits escrowFunded event after creation", async () => {
      vi.spyOn(manager as any, "_getServer").mockReturnValue(mockHorizonServer());
      vi.spyOn(manager as any, "_extractBalanceId").mockResolvedValue(FAKE_BALANCE_ID);

      const listener = vi.fn();
      manager.on("escrowFunded", listener);

      await manager.create(INVOICE_ID, AMOUNT, ASSET, FUTURE_DATE, SIGNER_SECRET);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: INVOICE_ID, status: "holding" }),
      );
    });

    it("throws ValidationError when amount is zero", async () => {
      await expect(
        manager.create(INVOICE_ID, 0n, ASSET, FUTURE_DATE, SIGNER_SECRET),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError for invalid asset format", async () => {
      await expect(
        manager.create(INVOICE_ID, AMOUNT, "INVALID_ASSET", FUTURE_DATE, SIGNER_SECRET),
      ).rejects.toThrow(ValidationError);
    });
  });

  // ── getStatus() ───────────────────────────────────────────────────────────

  describe("getStatus()", () => {
    it("returns holding for a newly-created vault before holdUntil", async () => {
      vi.spyOn(manager as any, "_getServer").mockReturnValue(mockHorizonServer());
      vi.spyOn(manager as any, "_extractBalanceId").mockResolvedValue(FAKE_BALANCE_ID);

      const vault = await manager.create(
        INVOICE_ID,
        AMOUNT,
        ASSET,
        FUTURE_DATE,
        SIGNER_SECRET,
      );

      const status = await manager.getStatus(vault.vaultId);
      expect(status).toBe("holding");
    });

    it("returns expired when holdUntil has passed and balance is not claimed", async () => {
      // Balance still exists on-chain (not claimed) → expired
      const fakeServer = {
        ...mockHorizonServer(),
        claimableBalance: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue({}), // balance exists
        }),
      };
      vi.spyOn(manager as any, "_getServer").mockReturnValue(fakeServer);
      vi.spyOn(manager as any, "_extractBalanceId").mockResolvedValue(FAKE_BALANCE_ID);

      const vault = await manager.create(
        INVOICE_ID,
        AMOUNT,
        ASSET,
        PAST_DATE, // already in the past
        SIGNER_SECRET,
      );

      // Advance time past holdUntil
      vi.setSystemTime(Date.now() + 120_000);

      const status = await manager.getStatus(vault.vaultId);
      expect(status).toBe("expired");
    });

    it("returns released for a vault that was already released", async () => {
      vi.spyOn(manager as any, "_getServer").mockReturnValue(mockHorizonServer());
      vi.spyOn(manager as any, "_extractBalanceId").mockResolvedValue(FAKE_BALANCE_ID);

      const vault = await manager.create(
        INVOICE_ID,
        AMOUNT,
        ASSET,
        PAST_DATE,
        SIGNER_SECRET,
      );

      // Manually mark as released
      vault.status = "released";

      const status = await manager.getStatus(vault.vaultId);
      expect(status).toBe("released");
    });

    it("throws ValidationError for unknown vault ID", async () => {
      await expect(manager.getStatus("nonexistent-vault-id")).rejects.toThrow(
        ValidationError,
      );
    });
  });

  // ── release() ─────────────────────────────────────────────────────────────

  describe("release()", () => {
    it("transitions vault to released and emits escrowReleased", async () => {
      vi.spyOn(manager as any, "_getServer").mockReturnValue(mockHorizonServer());
      vi.spyOn(manager as any, "_extractBalanceId").mockResolvedValue(FAKE_BALANCE_ID);

      const vault = await manager.create(
        INVOICE_ID,
        AMOUNT,
        ASSET,
        PAST_DATE, // holdUntil already passed
        SIGNER_SECRET,
      );

      const releasedListener = vi.fn();
      manager.on("escrowReleased", releasedListener);

      const result = await manager.release(vault.vaultId, RECIPIENT, SIGNER_SECRET);

      expect(result.txHash).toBe(FAKE_TX_HASH);
      expect(manager.getVault(vault.vaultId)?.status).toBe("released");
      expect(releasedListener).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientId: RECIPIENT,
          txHash: FAKE_TX_HASH,
        }),
      );
    });

    it("throws ValidationError when attempting to release before holdUntil", async () => {
      vi.spyOn(manager as any, "_getServer").mockReturnValue(mockHorizonServer());
      vi.spyOn(manager as any, "_extractBalanceId").mockResolvedValue(FAKE_BALANCE_ID);

      const vault = await manager.create(
        INVOICE_ID,
        AMOUNT,
        ASSET,
        FUTURE_DATE, // holdUntil is in the future
        SIGNER_SECRET,
      );

      await expect(
        manager.release(vault.vaultId, RECIPIENT, SIGNER_SECRET),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError for an already-released vault", async () => {
      vi.spyOn(manager as any, "_getServer").mockReturnValue(mockHorizonServer());
      vi.spyOn(manager as any, "_extractBalanceId").mockResolvedValue(FAKE_BALANCE_ID);

      const vault = await manager.create(
        INVOICE_ID,
        AMOUNT,
        ASSET,
        PAST_DATE,
        SIGNER_SECRET,
      );

      await manager.release(vault.vaultId, RECIPIENT, SIGNER_SECRET);

      // Second release should fail
      await expect(
        manager.release(vault.vaultId, RECIPIENT, SIGNER_SECRET),
      ).rejects.toThrow(ValidationError);
    });
  });

  // ── escrowExpired event ───────────────────────────────────────────────────

  describe("escrowExpired event", () => {
    it("emits escrowExpired when balance is not claimed after holdUntil", async () => {
      // claimableBalance call returns success (balance still exists → expired, not claimed)
      const fakeServer = {
        ...mockHorizonServer(),
        claimableBalance: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue({}),
        }),
      };
      vi.spyOn(manager as any, "_getServer").mockReturnValue(fakeServer);
      vi.spyOn(manager as any, "_extractBalanceId").mockResolvedValue(FAKE_BALANCE_ID);

      const vault = await manager.create(
        INVOICE_ID,
        AMOUNT,
        ASSET,
        PAST_DATE,
        SIGNER_SECRET,
      );

      const expiredListener = vi.fn();
      manager.on("escrowExpired", expiredListener);

      vi.setSystemTime(Date.now() + 120_000);
      await manager.getStatus(vault.vaultId);

      expect(expiredListener).toHaveBeenCalledWith(
        expect.objectContaining({ vaultId: vault.vaultId }),
      );
    });
  });
});
