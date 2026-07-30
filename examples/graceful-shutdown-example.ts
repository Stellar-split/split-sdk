/**
 * Example: Graceful shutdown with in-flight request draining
 *
 * This example demonstrates how to use the GracefulShutdownHandler to
 * properly handle process termination signals (SIGTERM, SIGINT) and ensure
 * that:
 * 1. In-flight Soroban RPC calls complete before shutdown
 * 2. New transaction submissions are blocked during shutdown
 * 3. WebSocket subscriptions are cleanly torn down
 * 4. The process exits only when it's safe to do so
 */

import { StellarSplitClient, GracefulShutdownHandler } from "@stellar-split/sdk";

async function main() {
  // Initialize the SDK client
  const client = new StellarSplitClient({
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CA...EXAMPLE",
  });

  // Register the graceful shutdown handler with default options
  // (30s drain timeout, SIGTERM and SIGINT signals, force exit on timeout)
  const deregister = GracefulShutdownHandler.register(client);

  console.log("✓ Graceful shutdown handler registered");
  console.log("  Press Ctrl+C (SIGINT) to trigger graceful shutdown");

  // Alternatively, customize the shutdown behavior:
  /*
  const deregister = GracefulShutdownHandler.register(client, {
    // Maximum time to wait for in-flight requests (default: 30000ms)
    drainTimeoutMs: 60_000, // 60 seconds

    // OS signals that trigger shutdown (default: ["SIGTERM", "SIGINT"])
    signals: ["SIGTERM", "SIGINT", "SIGUSR2"],

    // What to do when timeout is exceeded:
    // - "force": exit anyway, abandoning pending requests (default)
    // - "error": reject shutdown promise with ShutdownTimeoutError
    onTimeout: "error",
  });
  */

  // Simulate some long-running work
  try {
    console.log("Starting invoice operations...");

    // Create an invoice
    const invoice = await client.createInvoice({
      amount: 100_0000000n, // 100 XLM (Stellar uses 7 decimals)
      creator: "GA...CREATOR",
      recipients: [
        { address: "GA...RECIPIENT1", share: 50 },
        { address: "GA...RECIPIENT2", share: 50 },
      ],
      description: "Test invoice with graceful shutdown",
    });

    console.log(`✓ Invoice created: ${invoice.id}`);

    // Subscribe to invoice events (WebSocket connection)
    client.subscribeToInvoice(invoice.id, (event) => {
      console.log(`Received event: ${event.type} for invoice ${event.invoiceId}`);
    });

    // Keep the process running to demonstrate shutdown
    await new Promise((resolve) => {
      // Wait for shutdown signal
      console.log("Waiting for shutdown signal...");
    });
  } catch (error: any) {
    if (error.name === "ShutdownInProgressError") {
      console.log("✗ Operation rejected: shutdown in progress");
    } else if (error.name === "ShutdownTimeoutError") {
      console.log("✗ Shutdown timeout: some requests did not complete in time");
      console.log(`  Pending requests: ${error.pendingRequests.length}`);
      for (const req of error.pendingRequests) {
        console.log(`    - ${req.method} (started ${Date.now() - req.startedAt}ms ago)`);
      }
    } else {
      console.error("Error:", error);
    }
  }

  // Optional: manually deregister the shutdown handler if needed
  // (usually not necessary as the handler is cleaned up on exit)
  // deregister();
}

// Advanced example: Handle shutdown manually
async function advancedExample() {
  const client = new StellarSplitClient({
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CA...EXAMPLE",
  });

  // Don't use the automatic handler; manage shutdown manually
  let shutdownRequested = false;

  process.on("SIGTERM", async () => {
    if (shutdownRequested) return;
    shutdownRequested = true;

    console.log("SIGTERM received, initiating graceful shutdown...");

    try {
      // 1. Stop accepting new requests
      client.beginGracefulShutdown();
      console.log("✓ Stopped accepting new requests");

      // 2. Wait for in-flight requests with custom timeout
      const timeoutMs = 10_000;
      const waitPromise = client.waitForInFlightRequests();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs)
      );

      try {
        await Promise.race([waitPromise, timeoutPromise]);
        console.log("✓ All in-flight requests completed");
      } catch {
        const pending = client.getInFlightRequests();
        console.log(`⚠ Timeout: ${pending.length} request(s) still in flight`);
        for (const req of pending) {
          console.log(`  - ${req.method} (${req.id})`);
        }
      }

      // 3. Finalize shutdown (tears down subscriptions, pools, etc.)
      await client.finalizeShutdown();
      console.log("✓ SDK shutdown complete");

      process.exit(0);
    } catch (error) {
      console.error("Error during shutdown:", error);
      process.exit(1);
    }
  });

  // Application logic here...
  console.log("Application running. Send SIGTERM to shut down gracefully.");
  await new Promise(() => {}); // Keep running
}

// Run the example (uncomment the one you want to try)
main().catch(console.error);
// advancedExample().catch(console.error);
