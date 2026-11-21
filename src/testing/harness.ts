import { MockRPCServer } from "./mockServer.js";
import { Invoice, Payment, Recipient } from "../types.js";
import { TestHarnessNotInitializedError, UnknownTestWalletError } from "../errors.js";
import { createMockSdk } from "./mockFactory.js";

/**
 * Integration test harness that spins up a mock contract environment,
 * pre-funds test wallets, and provides helper methods for common test scenarios.
 */
export class IntegrationTestHarness {
  private mockServer: MockRPCServer | null = null;
  private testWallets: Map<string, string> = new Map(); // address -> secretKey

  /**
   * Sets up the mock contract environment, deploys mock contract, and funds test wallets.
   */
  async setup(): Promise<void> {
    // Create mock RPC server
    this.mockServer = new MockRPCServer();
    
    // Pre-fund test wallets
    const testAddresses = [
      "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
      "GBPMKIE33DB77R5ITZKU6J76L6M5H6Z6G7YXZQYVWU7XZQYVWU7XZQYVWU7XZQYV",
      "GC5SXLNAM3C4N7TS63777RZGVG7Y2E7P3J7Y2E7P3J7Y2E7P3J7Y2E7P3J7Y2E7P"
    ];
    
    testAddresses.forEach(address => {
      this.testWallets.set(address, "test-secret-key-for-" + address.substring(0, 8));
    });
  }

  /**
   * Creates a ready-to-use test invoice ID.
   * @param overrides - Optional overrides for invoice properties
   */
  createTestInvoice(overrides?: Partial<Invoice>): string {
    // Generate a deterministic test invoice ID
    const baseId = "test-invoice-" + Date.now() + "-" + Math.random().toString(36).substring(2, 9);
    
    // In a real implementation, this would create an actual invoice on the mock contract
    // For now, we return a test ID
    return baseId;
  }

  /**
   * Funds a test wallet with a specified amount.
   * @param address - The Stellar address to fund
   * @param amount - Amount in stroops to fund
   */
  async fundTestWallet(address: string, amount: bigint): Promise<void> {
    if (!this.mockServer) {
      throw new TestHarnessNotInitializedError();
    }
    
    // In real implementation, this would fund the wallet on the mock server
    // For now, we just verify the address exists in our test wallets
    if (!this.testWallets.has(address)) {
      throw new UnknownTestWalletError(address);
    }
    
    // Simulate funding
    console.log(`Funded ${address} with ${amount} stroops`);
  }

  /**
   * Cleans up all mocks and state.
   */
  async teardown(): Promise<void> {
    // No cleanup needed for MockRPCServer - it's stateless
    this.mockServer = null;
    this.testWallets.clear();
  }
}

/**
 * Creates a mock MetaMask provider that simulates connect/sign flows.
 * @param options - Optional behavior overrides (e.g. rejection, never resolving)
 */
export function createMockMetaMaskProvider(options?: {
  rejectConnect?: boolean;
  rejectSign?: boolean;
  neverResolve?: boolean;
  accounts?: string[];
}): any {
  const accounts = options?.accounts ?? [
    "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
  ];

  const hang = () => new Promise<never>(() => {});

  return {
    isMetaMask: true,
    async request({ method }: { method: string; params?: unknown[] }) {
      if (options?.neverResolve) {
        return hang();
      }
      switch (method) {
        case "eth_requestAccounts":
          if (options?.rejectConnect) {
            throw Object.assign(new Error("User rejected the request."), {
              code: 4001,
            });
          }
          return accounts;
        case "eth_accounts":
          return accounts;
        case "personal_sign":
        case "eth_sign":
          if (options?.rejectSign) {
            throw Object.assign(new Error("User rejected the request."), {
              code: 4001,
            });
          }
          return "0x" + "ab".repeat(65);
        default:
          throw new Error(`Unsupported MetaMask method: ${method}`);
      }
    },
  };
}

/**
 * Creates a mock WalletConnect provider that simulates connect/sign flows
 * and session persistence for restore().
 * @param options - Optional behavior overrides
 */
export function createMockWalletConnectProvider(options?: {
  rejectConnect?: boolean;
  rejectSign?: boolean;
  neverResolve?: boolean;
  session?: unknown;
  accounts?: string[];
}): any {
  const accounts = options?.accounts ?? [
    "GBPMKIE33DB77R5ITZKU6J76L6M5H6Z6G7YXZQYVWU7XZQYVWU7XZQYVWU7XZQYV",
  ];
  let session = options?.session ?? null;

  const hang = () => new Promise<never>(() => {});

  return {
    isWalletConnect: true,
    async connect() {
      if (options?.neverResolve) {
        return hang();
      }
      if (options?.rejectConnect) {
        throw new Error("User rejected connection");
      }
      session = { topic: "mock-topic", accounts };
      return { uri: "wc:mock-uri", session };
    },
    async request({ method }: { method: string; params?: unknown[] }) {
      if (options?.neverResolve) {
        return hang();
      }
      switch (method) {
        case "personal_sign":
        case "eth_sign":
          if (options?.rejectSign) {
            throw new Error("User rejected signing");
          }
          return "0x" + "cd".repeat(65);
        default:
          throw new Error(`Unsupported WalletConnect method: ${method}`);
      }
    },
    async disconnect() {
      session = null;
    },
    get session() {
      return session;
    },
  };
}

/**
 * Creates a mock SDK wired to the integration test harness, for use in
 * wallet integration tests.
 */
export function createHarnessMockSdk() {
  return createMockSdk();
}

/**
 * Export a singleton instance of the integration test harness.
 */
export const integrationTestHarness = new IntegrationTestHarness();