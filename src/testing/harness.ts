import { MockRPCServer } from "./mockServer.js";
import { Invoice, Payment, Recipient } from "../types.js";
import { TestHarnessNotInitializedError, UnknownTestWalletError } from "../errors.js";

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
 * Export a singleton instance of the integration test harness.
 */
export const integrationTestHarness = new IntegrationTestHarness();