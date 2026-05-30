import { describe, expect, it } from "vitest";
import { randomBytes } from "crypto";
import { StrKey } from "@stellar/stellar-base";
import { ProfilerSession } from "../src/profiler.js";
import { StellarSplitClient } from "../src/client.js";

describe("ProfilerSession", () => {
  it("records three SDK calls in the report", async () => {
    const profiler = new ProfilerSession();
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(randomBytes(32)),
    });

    profiler.start();

    client.registerPlugin({
      name: "plugin-a",
      install() {
        /* noop */
      },
    });

    client.registerPlugin({
      name: "plugin-b",
      install() {
        /* noop */
      },
    });

    client.registerPlugin({
      name: "plugin-c",
      install() {
        /* noop */
      },
    });

    const report = profiler.stop();

    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]!.entries).toHaveLength(3);
    expect(report.sessions[0]!.entries.every((entry) => entry.method === "registerPlugin")).toBe(true);
    expect(report.sessions[0]!.entries.every((entry) => entry.durationMs >= 0)).toBe(true);
    expect(report.sessions[0]!.entries.every((entry) => typeof entry.timestamp === "number")).toBe(true);
  });
});
