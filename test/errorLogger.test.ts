import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ErrorLogger,
  MemoryLogStorage,
  ConsoleLogStorage,
  MultiLogStorage,
  TextLogFormatter,
  JsonLogFormatter,
  LogLevelPriority,
  isLogLevelEnabled,
  parseLogLevel,
  getDefaultErrorLogger,
  setDefaultErrorLogger,
  resetDefaultErrorLogger,
  logError,
  getLogStats,
  type LogEntry,
} from "../src/errorLogger.js";
import { StellarSplitError } from "../src/errors.js";

describe("Issue #1069 — Error Logging", () => {
  beforeEach(() => {
    resetDefaultErrorLogger();
  });

  describe("Log Levels", () => {
    it("has clear numeric priorities", () => {
      expect(LogLevelPriority.debug).toBeLessThan(LogLevelPriority.info);
      expect(LogLevelPriority.info).toBeLessThan(LogLevelPriority.warn);
      expect(LogLevelPriority.warn).toBeLessThan(LogLevelPriority.error);
      expect(LogLevelPriority.error).toBeLessThan(LogLevelPriority.fatal);
    });

    it("evaluates isLogLevelEnabled correctly", () => {
      expect(isLogLevelEnabled("warn", "debug")).toBe(false);
      expect(isLogLevelEnabled("warn", "info")).toBe(false);
      expect(isLogLevelEnabled("warn", "warn")).toBe(true);
      expect(isLogLevelEnabled("warn", "error")).toBe(true);
      expect(isLogLevelEnabled("warn", "fatal")).toBe(true);
    });

    it("parses log level strings with fallback", () => {
      expect(parseLogLevel("DEBUG")).toBe("debug");
      expect(parseLogLevel(" warn ")).toBe("warn");
      expect(parseLogLevel("invalid", "error")).toBe("error");
      expect(parseLogLevel(null)).toBe("info");
    });
  });

  describe("Formatting", () => {
    const sampleEntry: LogEntry = {
      timestamp: 1700000000000,
      isoTimestamp: new Date(1700000000000).toISOString(),
      level: "error",
      message: "Transaction failed",
      traceId: "trace-xyz",
      tags: ["stellar", "rpc"],
      error: {
        name: "StellarSplitError",
        message: "Deadline passed",
        code: "DEADLINE_PASSED",
      },
      context: {
        invoiceId: "inv-123",
        amount: 1000n, // BigInt handling
      },
    };

    it("TextLogFormatter produces a clear human-readable string", () => {
      const text = TextLogFormatter(sampleEntry);
      expect(text).toContain("[ERROR]");
      expect(text).toContain("[trace-xyz]");
      expect(text).toContain("[stellar,rpc]");
      expect(text).toContain("Transaction failed");
      expect(text).toContain("code=DEADLINE_PASSED");
      expect(text).toContain("Deadline passed");
      expect(text).toContain("inv-123");
    });

    it("JsonLogFormatter produces valid JSON and handles BigInt and circular structures", () => {
      const circular: Record<string, unknown> = { key: "value" };
      circular.self = circular;

      const entryWithCircular: LogEntry = {
        ...sampleEntry,
        context: circular,
      };

      const jsonStr = JsonLogFormatter(entryWithCircular);
      const parsed = JSON.parse(jsonStr);

      expect(parsed.level).toBe("error");
      expect(parsed.message).toBe("Transaction failed");
      expect(parsed.traceId).toBe("trace-xyz");
      expect(parsed.context.key).toBe("value");
      expect(parsed.context.self).toBe("[Circular]");
    });
  });

  describe("Storage Reliability", () => {
    it("MemoryLogStorage reliably stores entries and respects maxEntries capacity", () => {
      const storage = new MemoryLogStorage(3);

      storage.write({
        timestamp: 1000,
        isoTimestamp: new Date(1000).toISOString(),
        level: "info",
        message: "Entry 1",
      });
      storage.write({
        timestamp: 2000,
        isoTimestamp: new Date(2000).toISOString(),
        level: "warn",
        message: "Entry 2",
      });
      storage.write({
        timestamp: 3000,
        isoTimestamp: new Date(3000).toISOString(),
        level: "error",
        message: "Entry 3",
      });

      expect(storage.count()).toBe(3);

      // Add a 4th entry; entry 1 should be evicted
      storage.write({
        timestamp: 4000,
        isoTimestamp: new Date(4000).toISOString(),
        level: "fatal",
        message: "Entry 4",
      });

      expect(storage.count()).toBe(3);
      const logs = storage.getLogs();
      expect(logs.map((l) => l.message)).toEqual(["Entry 2", "Entry 3", "Entry 4"]);
    });

    it("MemoryLogStorage filters by level, minLevel, time, search, and pagination", () => {
      const storage = new MemoryLogStorage(10);
      storage.write({
        timestamp: 100,
        isoTimestamp: new Date(100).toISOString(),
        level: "debug",
        message: "Cache hit",
        tags: ["cache"],
      });
      storage.write({
        timestamp: 200,
        isoTimestamp: new Date(200).toISOString(),
        level: "info",
        message: "Payment processed",
        tags: ["payment"],
      });
      storage.write({
        timestamp: 300,
        isoTimestamp: new Date(300).toISOString(),
        level: "error",
        message: "Horizon RPC unreachable",
        tags: ["network", "rpc"],
      });

      // Filter by minLevel
      expect(storage.getLogs({ minLevel: "warn" })).toHaveLength(1);
      expect(storage.getLogs({ minLevel: "warn" })[0].level).toBe("error");

      // Filter by search
      expect(storage.getLogs({ search: "payment" })).toHaveLength(1);
      expect(storage.getLogs({ search: "horizon" })).toHaveLength(1);

      // Filter by tags
      expect(storage.getLogs({ tags: ["cache"] })).toHaveLength(1);

      // Filter by time range
      expect(storage.getLogs({ since: 150, until: 250 })).toHaveLength(1);

      // Pagination
      expect(storage.getLogs({ limit: 1, offset: 1 })[0].message).toBe("Payment processed");

      // Clear
      storage.clear();
      expect(storage.count()).toBe(0);
    });

    it("ConsoleLogStorage formats and outputs to console methods", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const storage = new ConsoleLogStorage(TextLogFormatter, true, true);

      storage.write({
        timestamp: 1000,
        isoTimestamp: new Date(1000).toISOString(),
        level: "error",
        message: "System failure",
      });

      expect(consoleSpy).toHaveBeenCalled();
      expect(storage.count()).toBe(1);
      consoleSpy.mockRestore();
    });

    it("MultiLogStorage multiplexes to multiple sinks", () => {
      const mem1 = new MemoryLogStorage(5);
      const mem2 = new MemoryLogStorage(5);
      const multi = new MultiLogStorage([mem1, mem2]);

      multi.write({
        timestamp: 1000,
        isoTimestamp: new Date(1000).toISOString(),
        level: "info",
        message: "Multicast test",
      });

      expect(mem1.count()).toBe(1);
      expect(mem2.count()).toBe(1);
    });
  });

  describe("ErrorLogger Class & API", () => {
    it("logs messages and filters below minimum level", () => {
      const logger = new ErrorLogger({ minLevel: "warn" });

      const d = logger.debug("Should be filtered");
      const i = logger.info("Should be filtered");
      const w = logger.warn("Warning logged");
      const e = logger.error("Error logged");

      expect(d).toBeNull();
      expect(i).toBeNull();
      expect(w).not.toBeNull();
      expect(e).not.toBeNull();
      expect(logger.count()).toBe(2);
    });

    it("logs StellarSplitError with code, raw, and context", () => {
      const logger = new ErrorLogger({ minLevel: "debug" });
      const splitErr = new StellarSplitError("Invoice not found", "INVOICE_NOT_FOUND", { id: "inv-1" }, "raw-panic");

      const entry = logger.error("Fetch invoice failed", splitErr, { attempt: 3 });

      expect(entry).not.toBeNull();
      expect(entry!.error?.name).toBe("StellarSplitError");
      expect(entry!.error?.code).toBe("INVOICE_NOT_FOUND");
      expect(entry!.error?.raw).toBe("raw-panic");
      expect(entry!.context).toEqual({ attempt: 3 });
    });

    it("creates child loggers with inherited settings and merged context", () => {
      const parent = new ErrorLogger({
        minLevel: "info",
        defaultContext: { service: "split-sdk" },
        defaultTags: ["base"],
      });

      const child = parent.child({ component: "txBuilder" }, ["tx"]);

      const entry = child.info("Building tx");
      expect(entry!.context).toEqual({ service: "split-sdk", component: "txBuilder" });
      expect(entry!.tags).toEqual(["base", "tx"]);
    });

    it("uses default global logger and logError helper", () => {
      const logger = getDefaultErrorLogger();
      logger.setLevel("debug");

      const entry = logError(new Error("Database disconnected"), "Fatal DB crash", { host: "db1" });
      expect(entry).not.toBeNull();
      expect(entry!.level).toBe("error");
      expect(entry!.message).toBe("Fatal DB crash");
      expect(logger.count()).toBe(1);
    });
  });

  describe("Error Log Stats (#1265)", () => {
    it("returns zero counts and undefined timestamps for an empty logger", () => {
      const logger = new ErrorLogger({ minLevel: "debug" });
      const stats = logger.getStats();

      expect(stats.total).toBe(0);
      expect(stats.byLevel.debug).toBe(0);
      expect(stats.byLevel.info).toBe(0);
      expect(stats.byLevel.warn).toBe(0);
      expect(stats.byLevel.error).toBe(0);
      expect(stats.byLevel.fatal).toBe(0);
      expect(stats.oldestTimestamp).toBeUndefined();
      expect(stats.newestTimestamp).toBeUndefined();
      expect(stats.spanMs).toBe(0);
    });

    it("counts entries correctly per level", () => {
      const storage = new MemoryLogStorage(20);
      const logger = new ErrorLogger({ minLevel: "debug", storage });

      logger.debug("d1");
      logger.debug("d2");
      logger.info("i1");
      logger.warn("w1");
      logger.error("e1");
      logger.fatal("f1");

      const stats = logger.getStats();
      expect(stats.total).toBe(6);
      expect(stats.byLevel.debug).toBe(2);
      expect(stats.byLevel.info).toBe(1);
      expect(stats.byLevel.warn).toBe(1);
      expect(stats.byLevel.error).toBe(1);
      expect(stats.byLevel.fatal).toBe(1);
    });

    it("reports correct oldest/newest timestamps and span from MemoryLogStorage", () => {
      const storage = new MemoryLogStorage(10);

      storage.write({ timestamp: 1000, isoTimestamp: new Date(1000).toISOString(), level: "info",  message: "first"  });
      storage.write({ timestamp: 5000, isoTimestamp: new Date(5000).toISOString(), level: "warn",  message: "middle" });
      storage.write({ timestamp: 9000, isoTimestamp: new Date(9000).toISOString(), level: "error", message: "last"   });

      const stats = storage.getStats();
      expect(stats.oldestTimestamp).toBe(1000);
      expect(stats.newestTimestamp).toBe(9000);
      expect(stats.spanMs).toBe(8000);
    });

    it("spanMs is 0 when only one entry is stored", () => {
      const storage = new MemoryLogStorage(10);
      storage.write({ timestamp: 4000, isoTimestamp: new Date(4000).toISOString(), level: "info", message: "solo" });

      const stats = storage.getStats();
      expect(stats.total).toBe(1);
      expect(stats.spanMs).toBe(0);
    });

    it("module-level getLogStats delegates to the default logger", () => {
      const logger = getDefaultErrorLogger();
      logger.setLevel("debug");

      logError(new Error("boom"), "err1");
      logger.warn("w1");
      logger.info("i1");

      const stats = getLogStats();
      expect(stats.total).toBe(3);
      expect(stats.byLevel.error).toBe(1);
      expect(stats.byLevel.warn).toBe(1);
      expect(stats.byLevel.info).toBe(1);
    });
  });
});
