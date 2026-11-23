/**
 * Example Application: Plugins and RPC Interceptors
 *
 * Demonstrates the SDK's two extension points without any network access:
 * 1. A `StellarSplitPlugin` with `install`, `onInit` and `onDestroy` lifecycle hooks.
 * 2. Global RPC request/response interceptors.
 * 3. Handling `PluginAlreadyRegisteredError` for duplicate registrations.
 *
 * Run with:
 *   npx tsx examples/plugin-and-interceptors.ts
 */

import {
  StellarSplitClient,
  PluginAlreadyRegisteredError,
  type StellarSplitPlugin,
} from "../src/index.js";
import { addRequestInterceptor, addResponseInterceptor } from "../src/interceptors.js";

const auditPlugin: StellarSplitPlugin = {
  name: "audit-log",
  install(client) {
    console.log("[audit-log] installed on", client.constructor.name);
  },
  onInit() {
    console.log("[audit-log] client ready");
  },
  onDestroy() {
    console.log("[audit-log] client shutting down");
  },
};

async function main() {
  // Interceptors run for every RPC call made by any client in this process.
  addRequestInterceptor((req) => {
    console.log(`[rpc] -> ${req.method}`);
    return { ...req, headers: { ...req.headers, "x-example": "plugin-and-interceptors" } };
  });
  addResponseInterceptor((res) => {
    console.log(`[rpc] <- ${res.method} (${res.durationMs}ms)`);
    return res;
  });

  const client = new StellarSplitClient({
    rpcUrl: process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org",
    networkPassphrase:
      process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015",
    contractId:
      process.env.CONTRACT_ID || "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
    validatePassphrase: false,
    plugins: [auditPlugin],
  });

  try {
    client.registerPlugin(auditPlugin);
  } catch (err) {
    if (err instanceof PluginAlreadyRegisteredError) {
      console.log("Duplicate plugin rejected:", err.code);
    } else {
      throw err;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
