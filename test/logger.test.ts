import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  LogLevel,
  parseLogLevel,
  logLevelToString,
  sanitizeLogValue,
  defaultLogFormatter,
  SdkLogger,
  type LogEntry,
} from "../src/logger.js";

describe("SdkLogger", () => {
  let entries: LogEntry[];
  let formattedMessages: string[];

  const testSink = (entry: LogEntry, formatted: string) => {
    entries.push(entry);
    formattedMessages.push(formatted);
  };

  beforeEach(() => {
    entries = [];
    formattedMessages = [];
  });

  describe("parseLogLevel", () => {
    it("parses numeric values correctly", () => {
      expect(parseLogLevel(LogLevel.DEBUG)).toBe(LogLevel.DEBUG);
      expect(parseLogLevel(LogLevel.INFO)).toBe(LogLevel.INFO);
      expect(parseLogLevel(LogLevel.WARN)).toBe(LogLevel.WARN);
      expect(parseLogLevel(LogLevel.ERROR)).toBe(LogLevel.ERROR);
      expect(parseLogLevel(LogLevel.NONE)).toBe(LogLevel.NONE);
    });

    it("parses string representations case-insensitively", () => {
      expect(parseLogLevel("debug")).toBe(LogLevel.DEBUG);
      expect(parseLogLevel("DEBUG" as any)).toBe(LogLevel.DEBUG);
      expect(parseLogLevel("info")).toBe(LogLevel.INFO);
      expect(parseLogLevel("warn")).toBe(LogLevel.WARN);
      expect(parseLogLevel("warning" as any)).toBe(LogLevel.WARN);
      expect(parseLogLevel("error")).toBe(LogLevel.ERROR);
      expect(parseLogLevel("none")).toBe(LogLevel.NONE);
      expect(parseLogLevel("silent" as any)).toBe(LogLevel.NONE);
    });

    it("defaults to NONE for invalid strings or numbers", () => {
      expect(parseLogLevel("invalid" as any)).toBe(LogLevel.NONE);
      expect(parseLogLevel(99 as any)).toBe(LogLevel.NONE);
    });
  });

  describe("logLevelToString", () => {
    it("maps enum values to strings", () => {
      expect(logLevelToString(LogLevel.DEBUG)).toBe("DEBUG");
      expect(logLevelToString(LogLevel.INFO)).toBe("INFO");
      expect(logLevelToString(LogLevel.WARN)).toBe("WARN");
      expect(logLevelToString(LogLevel.ERROR)).toBe("ERROR");
      expect(logLevelToString(LogLevel.NONE)).toBe("NONE");
    });
  });

  describe("Level filtering", () => {
    it("emits all levels when set to DEBUG", () => {
      const logger = new SdkLogger({
        level: LogLevel.DEBUG,
        sink: testSink,
      });

      logger.debug("Debug msg");
      logger.info("Info msg");
      logger.warn("Warn msg");
      logger.error("Error msg");

      expect(entries).toHaveLength(4);
      expect(entries.map((e) => e.level)).toEqual([
        LogLevel.DEBUG,
        LogLevel.INFO,
        LogLevel.WARN,
        LogLevel.ERROR,
      ]);
    });

    it("filters out DEBUG when set to INFO", () => {
      const logger = new SdkLogger({
        level: LogLevel.INFO,
        sink: testSink,
      });

      logger.debug("Debug msg");
      logger.info("Info msg");
      logger.warn("Warn msg");
      logger.error("Error msg");

      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.levelName)).toEqual(["INFO", "WARN", "ERROR"]);
    });

    it("filters out DEBUG and INFO when set to WARN", () => {
      const logger = new SdkLogger({
        level: LogLevel.WARN,
        sink: testSink,
      });

      logger.debug("Debug msg");
      logger.info("Info msg");
      logger.warn("Warn msg");
      logger.error("Error msg");

      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.levelName)).toEqual(["WARN", "ERROR"]);
    });

    it("emits only ERROR when set to ERROR", () => {
      const logger = new SdkLogger({
        level: LogLevel.ERROR,
        sink: testSink,
      });

      logger.debug("Debug msg");
      logger.info("Info msg");
      logger.warn("Warn msg");
      logger.error("Error msg");

      expect(entries).toHaveLength(1);
      expect(entries[0]?.levelName).toBe("ERROR");
    });

    it("emits nothing when set to NONE", () => {
      const logger = new SdkLogger({
        level: LogLevel.NONE,
        sink: testSink,
      });

      logger.debug("Debug msg");
      logger.info("Info msg");
      logger.warn("Warn msg");
      logger.error("Error msg");

      expect(entries).toHaveLength(0);
    });

    it("supports dynamic level updates via setLevel", () => {
      const logger = new SdkLogger({
        level: LogLevel.NONE,
        sink: testSink,
      });

      logger.info("Should not appear");
      expect(entries).toHaveLength(0);

      logger.setLevel("info");
      expect(logger.getLevel()).toBe(LogLevel.INFO);

      logger.info("Should appear");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.message).toBe("Should appear");
    });
  });

  describe("Sensitive data redaction", () => {
    it("redacts Stellar secret seeds from strings", () => {
      const secret = "SBTEST00000000000000000000000000000000000000000000000000";
      const sanitized = sanitizeLogValue(`Connecting with key ${secret}`);
      expect(sanitized).toBe("Connecting with key SBTE...[REDACTED]");
    });

    it("redacts sensitive context dictionary keys", () => {
      const sanitized = sanitizeLogValue({
        publicKey: "GBTEST...",
        secretKey: "SBTEST00000000000000000000000000000000000000000000000000",
        password: "SuperSecretPassword123",
        token: "jwt-token-val",
        nested: {
          apiKey: "my-key",
          amount: 100n,
        },
      }) as Record<string, any>;

      expect(sanitized.publicKey).toBe("GBTEST...");
      expect(sanitized.secretKey).toBe("[REDACTED]");
      expect(sanitized.password).toBe("[REDACTED]");
      expect(sanitized.token).toBe("[REDACTED]");
      expect(sanitized.nested.apiKey).toBe("[REDACTED]");
      expect(sanitized.nested.amount).toBe("100");
    });

    it("applies redaction during logger.log execution", () => {
      const logger = new SdkLogger({
        level: LogLevel.DEBUG,
        sink: testSink,
        redactSensitive: true,
      });

      logger.debug("User logged in", {
        account: "GABC...",
        secretSeed: "SBTEST00000000000000000000000000000000000000000000000000",
      });

      expect(entries[0]?.context?.secretSeed).toBe("[REDACTED]");
    });
  });

  describe("Formatting and Child Loggers", () => {
    it("formats messages with timestamp, level, namespace, and context", () => {
      const logger = new SdkLogger({
        level: LogLevel.INFO,
        namespace: "TestClient",
        sink: testSink,
      });

      logger.info("Invoice processed", { id: 42 });

      expect(formattedMessages[0]).toMatch(/\[\d{4}-\d{2}-\d{2}T.*\] \[INFO\] \[TestClient\] Invoice processed {"id":42}/);
    });

    it("allows custom log formatters", () => {
      const logger = new SdkLogger({
        level: LogLevel.DEBUG,
        formatter: (entry) => `CUSTOM: ${entry.levelName} - ${entry.message}`,
        sink: testSink,
      });

      logger.debug("Hello world");
      expect(formattedMessages[0]).toBe("CUSTOM: DEBUG - Hello world");
    });

    it("creates child loggers with hierarchical namespaces", () => {
      const parent = new SdkLogger({
        level: LogLevel.DEBUG,
        namespace: "Parent",
        sink: testSink,
      });

      const child = parent.child("Child");
      child.info("From child");

      expect(entries[0]?.namespace).toBe("Parent:Child");
    });
  });

  describe("StellarSplitClient integration", () => {
    it("initializes with default LogLevel.NONE", async () => {
      const { StellarSplitClient } = await import("../src/client.js");
      const client = new StellarSplitClient({
        rpcUrl: "https://example.com",
        networkPassphrase: "Test SDF Network ; September 2015",
        contractId: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
        validatePassphrase: false,
      });

      expect(client.logger.getLevel()).toBe(LogLevel.NONE);
    });

    it("respects logger config and captures startup log", async () => {
      const { StellarSplitClient } = await import("../src/client.js");
      const client = new StellarSplitClient({
        rpcUrl: "https://example.com",
        networkPassphrase: "Test SDF Network ; September 2015",
        contractId: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
        validatePassphrase: false,
        logger: {
          level: LogLevel.DEBUG,
          sink: testSink,
        },
      });

      expect(client.logger.getLevel()).toBe(LogLevel.DEBUG);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0]?.message).toBe("StellarSplitClient initialized");
    });

    it("allows dynamic log level switching on client", async () => {
      const { StellarSplitClient } = await import("../src/client.js");
      const client = new StellarSplitClient({
        rpcUrl: "https://example.com",
        networkPassphrase: "Test SDF Network ; September 2015",
        contractId: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
        validatePassphrase: false,
        logger: {
          level: LogLevel.NONE,
          sink: testSink,
        },
      });

      expect(client.logger.getLevel()).toBe(LogLevel.NONE);
      client.setLogLevel("info");
      expect(client.logger.getLevel()).toBe(LogLevel.INFO);

      client.enableDebugLogging(true);
      expect(client.logger.getLevel()).toBe(LogLevel.DEBUG);

      client.enableDebugLogging(false);
      expect(client.logger.getLevel()).toBe(LogLevel.NONE);
    });
  });
});
