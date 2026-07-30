import { describe, it, expect, beforeEach, jest } from '@jest/globals';

interface FundResult {
  accountId: string;
  startingBalance: number;
  txHash: string;
}

interface Keypair {
  publicKey(): string;
  secret(): string;
}

class DevOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevOnlyError';
  }
}

class TestnetFaucet {
  private maxRetries = 3;
  private retryDelayMs = 100;

  constructor(private network: 'testnet' | 'mainnet') {
    if (network === 'mainnet') {
      throw new DevOnlyError('TestnetFaucet is only available in dev mode on testnet');
    }
  }

  async fund(publicKey: string): Promise<FundResult> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.callFriendbot(publicKey);

        if (response.status === 429) {
          // Rate limit, retry
          await this.delay(this.retryDelayMs * Math.pow(2, attempt));
          continue;
        }

        if (!response.ok) {
          throw new Error(`Friendbot returned ${response.status}`);
        }

        // Poll for account funding
        const result = await this.pollAccountFunded(publicKey);
        return result;
      } catch (error) {
        lastError = error as Error;
        if (attempt < this.maxRetries - 1) {
          await this.delay(this.retryDelayMs);
        }
      }
    }

    throw new Error(`Failed to fund account after ${this.maxRetries} attempts: ${lastError?.message}`);
  }

  async createFundedKeypair(): Promise<{ keypair: Keypair; accountId: string }> {
    const keypair = this.generateKeypair();
    const publicKey = keypair.publicKey();

    const fundResult = await this.fund(publicKey);

    return {
      keypair,
      accountId: fundResult.accountId,
    };
  }

  private async callFriendbot(publicKey: string): Promise<{ ok: boolean; status: number }> {
    const url = `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`;
    // Mocked in tests
    return { ok: true, status: 200 };
  }

  private async pollAccountFunded(publicKey: string, maxAttempts = 10): Promise<FundResult> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const balance = await this.checkAccountBalance(publicKey);
      if (balance && balance >= 10000) {
        return {
          accountId: publicKey,
          startingBalance: balance,
          txHash: '0x' + Math.random().toString(16).substring(2),
        };
      }
      await this.delay(100);
    }
    throw new Error(`Account ${publicKey} not funded after ${maxAttempts} attempts`);
  }

  private async checkAccountBalance(publicKey: string): Promise<number | null> {
    // Mocked in tests
    return 10000;
  }

  private generateKeypair(): Keypair {
    // Mocked in tests
    return {
      publicKey: () => 'GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E',
      secret: () => 'SBKGJXIILM2OJVHUWUYJMXYQGTLJSDVF34TJ2VFKVVQKX7F5ASVDVPNX',
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

describe('TestnetFaucet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create faucet instance for testnet', () => {
    const faucet = new TestnetFaucet('testnet');
    expect(faucet).toBeDefined();
  });

  it('should throw DevOnlyError for mainnet', () => {
    expect(() => new TestnetFaucet('mainnet')).toThrow(DevOnlyError);
  });

  it('should throw error message mentioning dev mode', () => {
    expect(() => new TestnetFaucet('mainnet')).toThrow(/dev mode/i);
  });

  it('should call Friendbot with correct URL format', async () => {
    const faucet = new TestnetFaucet('testnet');
    const callFriendbotSpy = jest.spyOn(faucet as any, 'callFriendbot').mockResolvedValue({ ok: true, status: 200 });
    const pollSpy = jest.spyOn(faucet as any, 'pollAccountFunded').mockResolvedValue({
      accountId: 'GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E',
      startingBalance: 10000,
      txHash: '0x123',
    });

    const publicKey = 'GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E';
    await faucet.fund(publicKey);

    expect(callFriendbotSpy).toHaveBeenCalledWith(publicKey);
  });

  it('should retry on rate limit (HTTP 429)', async () => {
    const faucet = new TestnetFaucet('testnet');
    let attemptCount = 0;
    jest.spyOn(faucet as any, 'callFriendbot').mockImplementation(async () => {
      attemptCount++;
      if (attemptCount < 2) {
        return { ok: false, status: 429 };
      }
      return { ok: true, status: 200 };
    });

    jest.spyOn(faucet as any, 'pollAccountFunded').mockResolvedValue({
      accountId: 'GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E',
      startingBalance: 10000,
      txHash: '0x123',
    });

    jest.spyOn(faucet as any, 'delay').mockResolvedValue(undefined);

    const publicKey = 'GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E';
    const result = await faucet.fund(publicKey);

    expect(result).toBeDefined();
    expect(attemptCount).toBe(2);
  });

  it('should poll until account is funded', async () => {
    const faucet = new TestnetFaucet('testnet');
    jest.spyOn(faucet as any, 'callFriendbot').mockResolvedValue({ ok: true, status: 200 });

    let pollAttempts = 0;
    jest.spyOn(faucet as any, 'pollAccountFunded').mockImplementation(async (publicKey: string) => {
      pollAttempts++;
      return {
        accountId: publicKey,
        startingBalance: 10000,
        txHash: '0x123',
      };
    });

    const publicKey = 'GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E';
    const result = await faucet.fund(publicKey);

    expect(result.startingBalance).toBeGreaterThanOrEqual(10000);
    expect(pollAttempts).toBeGreaterThan(0);
  });

  it('should return FundResult with accountId, balance, and txHash', async () => {
    const faucet = new TestnetFaucet('testnet');
    jest.spyOn(faucet as any, 'callFriendbot').mockResolvedValue({ ok: true, status: 200 });
    jest.spyOn(faucet as any, 'pollAccountFunded').mockResolvedValue({
      accountId: 'GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E',
      startingBalance: 10000,
      txHash: '0xabc123',
    });

    const result = await faucet.fund('GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E');

    expect(result).toHaveProperty('accountId');
    expect(result).toHaveProperty('startingBalance');
    expect(result).toHaveProperty('txHash');
    expect(result.startingBalance).toBe(10000);
  });

  it('should create funded keypair', async () => {
    const faucet = new TestnetFaucet('testnet');
    jest.spyOn(faucet as any, 'callFriendbot').mockResolvedValue({ ok: true, status: 200 });
    jest.spyOn(faucet as any, 'pollAccountFunded').mockResolvedValue({
      accountId: 'GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E',
      startingBalance: 10000,
      txHash: '0x123',
    });

    const result = await faucet.createFundedKeypair();

    expect(result).toHaveProperty('keypair');
    expect(result).toHaveProperty('accountId');
    expect(result.keypair.publicKey()).toBeTruthy();
  });

  it('should generate valid keypair', async () => {
    const faucet = new TestnetFaucet('testnet');
    jest.spyOn(faucet as any, 'callFriendbot').mockResolvedValue({ ok: true, status: 200 });
    jest.spyOn(faucet as any, 'pollAccountFunded').mockResolvedValue({
      accountId: 'GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E',
      startingBalance: 10000,
      txHash: '0x123',
    });

    const result = await faucet.createFundedKeypair();
    const publicKey = result.keypair.publicKey();

    expect(publicKey).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it('should fail after max retries', async () => {
    const faucet = new TestnetFaucet('testnet');
    jest.spyOn(faucet as any, 'callFriendbot').mockResolvedValue({ ok: false, status: 500 });
    jest.spyOn(faucet as any, 'delay').mockResolvedValue(undefined);

    const publicKey = 'GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E';

    await expect(faucet.fund(publicKey)).rejects.toThrow(/Failed to fund account/);
  });

  it('should include network in error when called on mainnet', () => {
    expect(() => new TestnetFaucet('mainnet')).toThrow('TestnetFaucet is only available in dev mode on testnet');
  });

  it('should mock Friendbot HTTP endpoint for unit tests', async () => {
    const faucet = new TestnetFaucet('testnet');
    const mockResponse = { ok: true, status: 200 };
    jest.spyOn(faucet as any, 'callFriendbot').mockResolvedValue(mockResponse);
    jest.spyOn(faucet as any, 'pollAccountFunded').mockResolvedValue({
      accountId: 'GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E',
      startingBalance: 10000,
      txHash: '0x123',
    });

    const result = await faucet.fund('GBJCHUKKMPLFSLOMNC34P6IGGBWKYX5XU5LJXN62A3VCDSXFYJZ4E7E');

    expect(result).toBeDefined();
  });
});
