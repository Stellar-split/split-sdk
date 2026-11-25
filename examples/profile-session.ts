/**
 * examples/profile-session.ts
 *
 * Demonstrates ProfilerSession against a mock StellarSplitClient.
 *
 * This file doubles as the runnable companion to the SDK performance
 * profiling guide (docs/performance-profiling.md). It shows how to:
 *   - wrap SDK calls in a ProfilerSession
 *   - read the legacy per-session summary
 *   - build a speedscope flame-graph report
 *   - export the report for offline analysis
 *   - run a simple micro-benchmark of a hot path
 *
 * Run with:
 *   npx vite-node examples/profile-session.ts
 * or after building:
 *   node --loader ts-node/esm examples/profile-session.ts
 */

import { ProfilerSession, StellarSplitClient } from "../src/index.js";
import type {
  Invoice,
  InvoiceReceipt,
  Payment,
  CreateInvoiceParams,
  PayParams,
  PaginatedResult,
  PaginationOptions,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Build a mock RPC client that resolves instantly without a real network call
// ---------------------------------------------------------------------------

const MOCK_INVOICE_ID = "42";
const MOCK_TX_HASH = "abc123deadbeef";

/** Minimal fake invoice for demonstration purposes. */
function fakeinvoice(id = MOCK_INVOICE_ID): Invoice {
  return {
    id,
    creator: "GCREATOR" + "X".repeat(49),
    recipients: [{ address: "GRECIPIENT" + "Y".repeat(47), amount: 100_000_000n }],
    token: "GUSDC" + "Z".repeat(52),
    deadline: Math.floor(Date.now() / 1000) + 86_400,
    funded: 100_000_000n,
    status: "Released",
    payments: [{ payer: "GPAYER" + "W".repeat(51), amount: 100_000_000n }],
  };
}

// ---------------------------------------------------------------------------
// Patch StellarSplitClient with mock implementations
// ---------------------------------------------------------------------------

// We monkey-patch the prototype so the profiler can capture the calls.

StellarSplitClient.prototype.createInvoice = async (
  _params: CreateInvoiceParams
): Promise<{ invoiceId: string; txHash: string }> => {
  // Simulate a small delay representative of an RPC round-trip
  await new Promise((r) => setTimeout(r, 5));
  return { invoiceId: MOCK_INVOICE_ID, txHash: MOCK_TX_HASH };
};

StellarSplitClient.prototype.pay = async (
  _params: PayParams
): Promise<{ txHash: string }> => {
  await new Promise((r) => setTimeout(r, 3));
  return { txHash: MOCK_TX_HASH };
};

StellarSplitClient.prototype.getInvoice = async (
  _id: string
): Promise<Invoice> => {
  await new Promise((r) => setTimeout(r, 2));
  return fakeinvoice();
};

StellarSplitClient.prototype.getPayments = async (
  _invoiceId: string,
  _options?: PaginationOptions
): Promise<PaginatedResult<Payment>> => {
  await new Promise((r) => setTimeout(r, 2));
  return {
    items: [{ payer: "GPAYER" + "W".repeat(51), amount: 100_000_000n }],
    nextCursor: null,
    total: 1,
  };
};

// ---------------------------------------------------------------------------
// Micro-benchmark helper
// ---------------------------------------------------------------------------

/**
 * Run `fn` `iterations` times and return basic latency statistics.
 *
 * This is intentionally dependency-free so the example can be copied into
 * any project. For statistically rigorous benchmarks prefer a dedicated
 * harness (see docs/performance-profiling.md → Benchmarking).
 */
async function benchmark(
  label: string,
  iterations: number,
  fn: () => Promise<unknown>
): Promise<void> {
  // Warm-up pass so JIT compilation does not skew the first samples.
  for (let i = 0; i < Math.min(iterations, 5); i++) {
    await fn();
  }

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }

  samples.sort((a, b) => a - b);
  const sum = samples.reduce((acc, v) => acc + v, 0);
  const mean = sum / samples.length;
  const p50 = samples[Math.floor(samples.length * 0.5)]!;
  const p95 = samples[Math.floor(samples.length * 0.95)]!;
  const max = samples[samples.length - 1]!;

  console.log(
    `  ${label.padEnd(24)} n=${String(iterations).padStart(4)}  ` +
      `mean=${mean.toFixed(2)}ms  p50=${p50.toFixed(2)}ms  ` +
      `p95=${p95.toFixed(2)}ms  max=${max.toFixed(2)}ms`
  );
}

// ---------------------------------------------------------------------------
// Run the profiling session
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== ProfilerSession Example ===\n");

  // 1. Create the client (no real RPC — we patched the methods above)
  const client = new StellarSplitClient({
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CCJXQVNZQJHFWQKTQBDVUAGPJNIJFQB5DRPYTBRHQJB4KTWG2EVHQHX",
  });

  // 2. Start the profiling session
  const profiler = new ProfilerSession({ name: "StellarSplit Demo Session" });
  profiler.start();
  console.log("Profiling started …\n");

  // 3. Execute a sequence of SDK operations
  const { invoiceId } = await client.createInvoice({
    creator: "GCREATOR" + "X".repeat(49),
    recipients: [{ address: "GRECIPIENT" + "Y".repeat(47), amount: 100_000_000n }],
    token: "GUSDC" + "Z".repeat(52),
    deadline: Math.floor(Date.now() / 1000) + 86_400,
  });
  console.log(`  createInvoice → invoiceId=${invoiceId}`);

  await client.pay({
    payer: "GPAYER" + "W".repeat(51),
    invoiceId,
    amount: 100_000_000n,
  });
  console.log(`  pay → txHash=${MOCK_TX_HASH}`);

  const invoice = await client.getInvoice(invoiceId);
  console.log(`  getInvoice → status=${invoice.status}`);

  const payments = await client.getPayments(invoiceId);
  console.log(`  getPayments → ${payments.total} payment(s)\n`);

  // 4. Stop recording
  const report = profiler.stop();
  console.log("Profiling stopped.\n");

  // 5. Show the legacy per-session summary
  const session = report.sessions[0]!;
  console.log("── Legacy ProfileReport ──────────────────────────────────");
  console.log(`  Session started at : ${new Date(session.startedAt).toISOString()}`);
  console.log(`  Session stopped at : ${new Date(session.stoppedAt).toISOString()}`);
  console.log(`  Total entries      : ${session.entries.length}`);
  for (const entry of session.entries) {
    const status = entry.success ? "✓" : `✗ (${entry.error ?? "unknown"})`;
    console.log(`    ${entry.method.padEnd(20)} ${entry.durationMs.toFixed(2).padStart(8)} ms  ${status}`);
  }
  console.log();

  // 6. Build the speedscope flame-graph report
  const speedscope = profiler.report();
  console.log("── Speedscope v0.6 Report ────────────────────────────────");
  console.log(`  Schema   : ${speedscope.$schema}`);
  console.log(`  Version  : ${speedscope.version}`);
  console.log(`  Name     : ${speedscope.name}`);
  console.log(`  Profiles : ${speedscope.profiles.length}`);
  console.log(`  Frames   : ${speedscope.shared.frames.length}`);
  if (speedscope.profiles[0]) {
    console.log(`  Events   : ${speedscope.profiles[0].events.length}`);
    console.log(`  Time range: 0 – ${speedscope.profiles[0].endValue.toFixed(2)} ms`);
  }
  console.log();

  // 7. Export to a JSON file
  const outputPath = "/tmp/profile-session-demo.json";
  profiler.exportJSON(outputPath);
  console.log(`Speedscope JSON written to: ${outputPath}`);
  console.log("Open it at https://www.speedscope.app/ for a flame graph!\n");

  // 8. Micro-benchmark a hot path (see docs/performance-profiling.md)
  console.log("── Micro-benchmark ───────────────────────────────────────");
  await benchmark("getInvoice", 50, () => client.getInvoice(invoiceId));
  await benchmark("getPayments", 50, () => client.getPayments(invoiceId));
  console.log();
}

main().catch((err: unknown) => {
  console.error("Example failed:", err);
  process.exit(1);
});
