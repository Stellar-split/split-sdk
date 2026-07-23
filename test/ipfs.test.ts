/**
 * Tests for IPFS invoice metadata functionality.
 *
 * Coverage:
 * - pinInvoiceMetadata with gateway and kubo backends
 * - verifyCID detects tampering
 * - fetchFromIPFS retrieves content correctly
 * - enrichInvoice merges on-chain + IPFS data
 * - Error handling for all failure scenarios
 * - parseIPFSCid extracts CIDs from various formats
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  pinInvoiceMetadata,
  verifyCID,
  verifyCIDOrThrow,
  fetchFromIPFS,
  fetchInvoiceMetadata,
  parseIPFSCid,
  configureIPFS,
  resetIPFSConfig,
  createLineItem,
  createInvoiceMetadata,
  deserializeMetadata,
  DEFAULT_IPFS_CONFIG,
} from "../src/ipfs.js";
import {
  enrichInvoice,
  enrichInvoices,
  hasIPFSMetadata,
  getInvoiceMetadataCID,
} from "../src/enricher.js";
import {
  IPFSPinError,
  IPFSFetchError,
  CIDMismatchError,
  IPFSConfigError,
  isIPFSPinError,
  isIPFSFetchError,
  isCIDMismatchError,
  isIPFSConfigError,
} from "../src/errors.js";
import type { InvoiceMetadata, Invoice } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock IPFS Server
// ---------------------------------------------------------------------------

interface MockIPFSStore {
  [cid: string]: string;
}

class MockIPFSServer {
  private store: MockIPFSStore = {};
  private pinCount = 0;

  /**
   * Add content to the mock IPFS store.
   */
  addContent(cid: string, content: string): void {
    this.store[cid] = content;
  }

  /**
   * Get content from the mock IPFS store.
   */
  getContent(cid: string): string | undefined {
    return this.store[cid];
  }

  /**
   * Generate a mock CID for content.
   */
  generateCID(): string {
    this.pinCount++;
    return `QmMockCID${this.pinCount.toString().padStart(40, "0")}`;
  }

  /**
   * Clear the mock store.
   */
  clear(): void {
    this.store = {};
    this.pinCount = 0;
  }

  /**
   * Create a mock fetch implementation for testing.
   */
  createMockFetch(options?: {
    pinShouldFail?: boolean;
    fetchShouldFail?: boolean;
    returnTampered?: boolean;
  }) {
    return async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();

      // Handle Kubo add endpoint
      if (urlStr.includes("/api/v0/add")) {
        if (options?.pinShouldFail) {
          return {
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
            text: async () => "Pin failed",
            json: async () => ({ error: "Pin failed" }),
          };
        }

        const cid = this.generateCID();
        // Store the content from FormData
        if (init?.body instanceof FormData) {
          const file = init.body.get("file") as Blob;
          if (file) {
            const content = await file.text();
            this.store[cid] = content;
          }
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({ Hash: cid }),
        };
      }

      // Handle Kubo cat endpoint
      if (urlStr.includes("/api/v0/cat")) {
        const match = urlStr.match(/arg=([^&]+)/);
        const cid = match ? decodeURIComponent(match[1]) : "";

        if (options?.fetchShouldFail || !this.store[cid]) {
          return {
            ok: false,
            status: 404,
            statusText: "Not Found",
            text: async () => "Not found",
          };
        }

        let content = this.store[cid];
        if (options?.returnTampered) {
          content = JSON.stringify({ tampered: true });
        }

        return {
          ok: true,
          status: 200,
          text: async () => content,
        };
      }

      // Handle HTTP gateway fetch
      if (urlStr.includes("/ipfs/")) {
        const cidMatch = urlStr.match(/\/ipfs\/([^/?]+)/);
        const cid = cidMatch ? cidMatch[1] : "";

        if (options?.fetchShouldFail || !this.store[cid]) {
          return {
            ok: false,
            status: 404,
            statusText: "Not Found",
            text: async () => "Not found",
          };
        }

        let content = this.store[cid];
        if (options?.returnTampered) {
          content = JSON.stringify({ tampered: true });
        }

        return {
          ok: true,
          status: 200,
          text: async () => content,
          json: async () => JSON.parse(content),
        };
      }

      // Handle Pinata-style pin endpoint
      if (urlStr.includes("/pinning/pinJSONToIPFS")) {
        if (options?.pinShouldFail) {
          return {
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
          };
        }

        const cid = this.generateCID();
        if (typeof init?.body === "string") {
          this.store[cid] = init.body;
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({ IpfsHash: cid }),
        };
      }

      // Default: not found
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "Not found",
        json: async () => ({ error: "Not found" }),
      };
    };
  }
}

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function createTestMetadata(): InvoiceMetadata {
  return {
    title: "Test Invoice",
    description: "A test invoice for development work",
    lineItems: [
      createLineItem("Development", 10, 100000000n),
      createLineItem("Testing", 5, 50000000n),
    ],
    attachmentCIDs: ["QmAttachment1", "QmAttachment2"],
  };
}

function createTestInvoice(memo?: string): Invoice {
  return {
    id: "1",
    creator: "GABC123",
    recipients: [{ address: "GDEF456", amount: 1000000000n }],
    token: "USDC",
    deadline: Math.floor(Date.now() / 1000) + 86400,
    funded: 0n,
    status: "Pending",
    payments: [],
    memo,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IPFS Configuration", () => {
  afterEach(() => {
    resetIPFSConfig();
    vi.restoreAllMocks();
  });

  it("uses default configuration", () => {
    const config = DEFAULT_IPFS_CONFIG;
    expect(config.backend).toBe("gateway");
    expect(config.url).toBe("https://ipfs.io");
    expect(config.timeout).toBe(30000);
  });

  it("configures IPFS globally", () => {
    configureIPFS({
      backend: "kubo",
      url: "http://localhost:5001",
      timeout: 60000,
    });

    // The configuration is used internally by the module
    // We test this indirectly through the pin/fetch functions
  });

  it("resets to default configuration", () => {
    configureIPFS({ backend: "kubo", url: "http://custom.url" });
    resetIPFSConfig();
    // Default config restored - tested via function behavior
  });
});

describe("parseIPFSCid", () => {
  it("parses ipfs: prefix with CIDv0", () => {
    expect(parseIPFSCid("ipfs:QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toBe(
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"
    );
  });

  it("parses ipfs: prefix with CIDv1", () => {
    expect(parseIPFSCid("ipfs:bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")).toBe(
      "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
    );
  });

  it("parses bare CIDv0", () => {
    expect(parseIPFSCid("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toBe(
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"
    );
  });

  it("parses bare CIDv1", () => {
    expect(parseIPFSCid("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")).toBe(
      "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
    );
  });

  it("parses CID in text with other content", () => {
    expect(
      parseIPFSCid("Invoice metadata: ipfs:QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")
    ).toBe("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
  });

  it("returns null for empty string", () => {
    expect(parseIPFSCid("")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseIPFSCid(undefined)).toBeNull();
  });

  it("returns null for string without CID", () => {
    expect(parseIPFSCid("No IPFS reference here")).toBeNull();
  });

  it("handles case-insensitive ipfs: prefix", () => {
    expect(parseIPFSCid("IPFS:QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toBe(
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"
    );
  });
});

describe("createLineItem", () => {
  it("creates a line item with automatic total", () => {
    const item = createLineItem("Service", 3, 100n);
    expect(item.description).toBe("Service");
    expect(item.quantity).toBe(3);
    expect(item.unitPrice).toBe(100n);
    expect(item.total).toBe(300n);
  });

  it("handles zero quantity", () => {
    const item = createLineItem("Free item", 0, 100n);
    expect(item.total).toBe(0n);
  });

  it("handles large values", () => {
    const item = createLineItem("Big job", 1000000, 10000000000n);
    expect(item.total).toBe(10000000000000000n);
  });
});

describe("createInvoiceMetadata", () => {
  it("creates metadata with all fields", () => {
    const lineItems = [createLineItem("Work", 1, 1000n)];
    const metadata = createInvoiceMetadata(
      "Invoice Title",
      "Invoice Description",
      lineItems,
      ["QmCID1", "QmCID2"]
    );

    expect(metadata.title).toBe("Invoice Title");
    expect(metadata.description).toBe("Invoice Description");
    expect(metadata.lineItems).toHaveLength(1);
    expect(metadata.attachmentCIDs).toEqual(["QmCID1", "QmCID2"]);
  });

  it("defaults attachmentCIDs to empty array", () => {
    const metadata = createInvoiceMetadata("Title", "Desc", []);
    expect(metadata.attachmentCIDs).toEqual([]);
  });
});

describe("deserializeMetadata", () => {
  it("deserializes JSON with bigint strings", () => {
    const json = JSON.stringify({
      title: "Test",
      description: "Desc",
      lineItems: [
        { description: "Item", quantity: 2, unitPrice: "1000000000", total: "2000000000" },
      ],
      attachmentCIDs: [],
    });

    const metadata = deserializeMetadata(json);
    expect(metadata.title).toBe("Test");
    expect(metadata.lineItems[0].unitPrice).toBe(1000000000n);
    expect(metadata.lineItems[0].total).toBe(2000000000n);
  });

  it("handles missing total field", () => {
    const json = JSON.stringify({
      title: "Test",
      description: "Desc",
      lineItems: [{ description: "Item", quantity: 2, unitPrice: "1000000000" }],
      attachmentCIDs: [],
    });

    const metadata = deserializeMetadata(json);
    expect(metadata.lineItems[0].total).toBeUndefined();
  });

  it("handles missing optional fields", () => {
    const json = JSON.stringify({
      title: "Test",
      description: "Desc",
    });

    const metadata = deserializeMetadata(json);
    expect(metadata.lineItems).toEqual([]);
    expect(metadata.attachmentCIDs).toEqual([]);
  });
});

describe("pinInvoiceMetadata", () => {
  let mockServer: MockIPFSServer;

  beforeEach(() => {
    mockServer = new MockIPFSServer();
    resetIPFSConfig();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pins metadata via Kubo backend and returns CID", async () => {
    vi.stubGlobal("fetch", mockServer.createMockFetch());
    configureIPFS({ backend: "kubo", url: "http://localhost:5001" });

    const metadata = createTestMetadata();
    const cid = await pinInvoiceMetadata(metadata);

    expect(cid).toMatch(/^QmMockCID/);
    expect(mockServer.getContent(cid)).toBeDefined();
  });

  it("pins metadata via gateway backend and returns CID", async () => {
    vi.stubGlobal("fetch", mockServer.createMockFetch());
    configureIPFS({ backend: "gateway", url: "http://mock-gateway.io" });

    const metadata = createTestMetadata();
    const cid = await pinInvoiceMetadata(metadata);

    expect(cid).toMatch(/^QmMockCID/);
  });

  it("throws IPFSPinError on failure", async () => {
    vi.stubGlobal("fetch", mockServer.createMockFetch({ pinShouldFail: true }));
    configureIPFS({ backend: "kubo", url: "http://localhost:5001" });

    const metadata = createTestMetadata();
    await expect(pinInvoiceMetadata(metadata)).rejects.toThrow(IPFSPinError);
  });

  it("uses config override parameter", async () => {
    vi.stubGlobal("fetch", mockServer.createMockFetch());

    const metadata = createTestMetadata();
    const cid = await pinInvoiceMetadata(metadata, {
      backend: "kubo",
      url: "http://custom-kubo:5001",
    });

    expect(cid).toMatch(/^QmMockCID/);
  });
});

describe("fetchFromIPFS", () => {
  let mockServer: MockIPFSServer;
  const testCid = "QmTestCid123456789012345678901234567890123";
  const testContent = JSON.stringify({ test: "content" });

  beforeEach(() => {
    mockServer = new MockIPFSServer();
    mockServer.addContent(testCid, testContent);
    resetIPFSConfig();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches content via gateway", async () => {
    vi.stubGlobal("fetch", mockServer.createMockFetch());
    configureIPFS({ backend: "gateway", url: "http://mock-gateway.io" });

    const content = await fetchFromIPFS(testCid);
    expect(content).toBe(testContent);
  });

  it("fetches content via Kubo", async () => {
    vi.stubGlobal("fetch", mockServer.createMockFetch());
    configureIPFS({ backend: "kubo", url: "http://localhost:5001" });

    const content = await fetchFromIPFS(testCid);
    expect(content).toBe(testContent);
  });

  it("throws IPFSFetchError on failure", async () => {
    vi.stubGlobal("fetch", mockServer.createMockFetch({ fetchShouldFail: true }));

    await expect(fetchFromIPFS("QmNonexistent")).rejects.toThrow(IPFSFetchError);
  });

  it("throws IPFSFetchError for non-existent CID", async () => {
    vi.stubGlobal("fetch", mockServer.createMockFetch());

    await expect(fetchFromIPFS("QmDoesNotExist")).rejects.toThrow(IPFSFetchError);
  });
});

describe("fetchInvoiceMetadata", () => {
  let mockServer: MockIPFSServer;
  const testCid = "QmMetadataCid12345678901234567890123456789";

  beforeEach(() => {
    mockServer = new MockIPFSServer();
    resetIPFSConfig();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches and parses InvoiceMetadata", async () => {
    const metadata = createTestMetadata();
    const json = JSON.stringify({
      ...metadata,
      lineItems: metadata.lineItems.map((item) => ({
        ...item,
        unitPrice: item.unitPrice.toString(),
        total: item.total?.toString(),
      })),
    });
    mockServer.addContent(testCid, json);
    vi.stubGlobal("fetch", mockServer.createMockFetch());

    const result = await fetchInvoiceMetadata(testCid);
    expect(result.title).toBe("Test Invoice");
    expect(result.lineItems).toHaveLength(2);
    expect(typeof result.lineItems[0].unitPrice).toBe("bigint");
  });
});

describe("verifyCID", () => {
  let mockServer: MockIPFSServer;
  const testCid = "QmVerifyCid123456789012345678901234567890";
  const testContent = { test: "data", value: 123 };

  beforeEach(() => {
    mockServer = new MockIPFSServer();
    mockServer.addContent(testCid, JSON.stringify(testContent));
    resetIPFSConfig();
    vi.stubGlobal("fetch", mockServer.createMockFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true for matching content", async () => {
    const result = await verifyCID(testCid, testContent);
    expect(result).toBe(true);
  });

  it("returns false for mismatched content", async () => {
    const result = await verifyCID(testCid, { different: "content" });
    expect(result).toBe(false);
  });

  it("works with string content", async () => {
    const stringContent = JSON.stringify(testContent);
    const result = await verifyCID(testCid, stringContent);
    expect(result).toBe(true);
  });
});

describe("verifyCIDOrThrow", () => {
  let mockServer: MockIPFSServer;
  const testCid = "QmVerifyThrow12345678901234567890123456789";
  const testContent = { verify: "me" };

  beforeEach(() => {
    mockServer = new MockIPFSServer();
    mockServer.addContent(testCid, JSON.stringify(testContent));
    resetIPFSConfig();
    vi.stubGlobal("fetch", mockServer.createMockFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not throw for matching content", async () => {
    await expect(verifyCIDOrThrow(testCid, testContent)).resolves.not.toThrow();
  });

  it("throws CIDMismatchError for tampered content", async () => {
    await expect(verifyCIDOrThrow(testCid, { tampered: true })).rejects.toThrow(
      CIDMismatchError
    );
  });
});

describe("CID tampering detection", () => {
  let mockServer: MockIPFSServer;
  const testCid = "QmTamperTest12345678901234567890123456789";

  beforeEach(() => {
    mockServer = new MockIPFSServer();
    resetIPFSConfig();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("detects when content has been tampered with", async () => {
    const originalContent = { secure: "data", important: true };
    mockServer.addContent(testCid, JSON.stringify(originalContent));
    vi.stubGlobal("fetch", mockServer.createMockFetch({ returnTampered: true }));

    const result = await verifyCID(testCid, originalContent);
    expect(result).toBe(false);
  });
});

describe("enrichInvoice", () => {
  let mockServer: MockIPFSServer;
  const testCid = "QmEnrichTest12345678901234567890123456789";

  beforeEach(() => {
    mockServer = new MockIPFSServer();
    resetIPFSConfig();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("enriches invoice with IPFS metadata", async () => {
    const metadata = { name: "Invoice metadata", amount: 1000 };
    mockServer.addContent(testCid, JSON.stringify(metadata));
    vi.stubGlobal("fetch", mockServer.createMockFetch());

    const invoice = createTestInvoice(`ipfs:${testCid}`);
    const fetcher = async () => invoice;

    const enriched = await enrichInvoice("1", fetcher);

    expect(enriched.id).toBe("1");
    expect(enriched.metadata).toEqual(metadata);
    expect(enriched.metadataCID).toBe(testCid);
  });

  it("returns null metadata when no IPFS CID in memo", async () => {
    vi.stubGlobal("fetch", mockServer.createMockFetch());

    const invoice = createTestInvoice("Regular memo without IPFS");
    const fetcher = async () => invoice;

    const enriched = await enrichInvoice("1", fetcher);

    expect(enriched.metadata).toBeNull();
    expect(enriched.metadataCID).toBeUndefined();
  });

  it("returns null metadata when memo is undefined", async () => {
    vi.stubGlobal("fetch", mockServer.createMockFetch());

    const invoice = createTestInvoice(undefined);
    const fetcher = async () => invoice;

    const enriched = await enrichInvoice("1", fetcher);

    expect(enriched.metadata).toBeNull();
  });

  it("handles fetch failures gracefully", async () => {
    vi.stubGlobal("fetch", mockServer.createMockFetch({ fetchShouldFail: true }));

    const invoice = createTestInvoice(`ipfs:${testCid}`);
    const fetcher = async () => invoice;

    const enriched = await enrichInvoice("1", fetcher);

    // Legacy path (no ipfsConfig) returns null metadata on failure
    // but still reports the CID that was attempted
    expect(enriched.metadata).toBeNull();
    expect(enriched.metadataCID).toBe(testCid);
    // metadataVerified is undefined when not using verifyContent option
    expect(enriched.metadataVerified).toBeUndefined();
  });

  it("throws error when throwOnError is true", async () => {
    vi.stubGlobal("fetch", mockServer.createMockFetch({ fetchShouldFail: true }));
    configureIPFS({ backend: "kubo", url: "http://localhost:5001" });

    const invoice = createTestInvoice(`ipfs:${testCid}`);
    const fetcher = async () => invoice;

    await expect(
      enrichInvoice("1", fetcher, { throwOnError: true, ipfsConfig: { backend: "kubo", url: "http://localhost:5001" } })
    ).rejects.toThrow();
  });

  it("verifies content when verifyContent is true", async () => {
    const metadata = createTestMetadata();
    const json = JSON.stringify({
      ...metadata,
      lineItems: metadata.lineItems.map((item) => ({
        ...item,
        unitPrice: item.unitPrice.toString(),
        total: item.total?.toString(),
      })),
    });
    mockServer.addContent(testCid, json);
    vi.stubGlobal("fetch", mockServer.createMockFetch());

    const invoice = createTestInvoice(`ipfs:${testCid}`);
    const fetcher = async () => invoice;

    const enriched = await enrichInvoice("1", fetcher, {
      verifyContent: true,
      ipfsConfig: { backend: "gateway", url: "http://mock-gateway.io" },
    });

    expect(enriched.metadataVerified).toBeDefined();
  });
});

describe("enrichInvoices", () => {
  beforeEach(() => {
    resetIPFSConfig();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("enriches multiple invoices in parallel", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({ batch: true }),
    }));

    const invoices = [
      createTestInvoice("ipfs:QmTest1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"),
      createTestInvoice("ipfs:QmTest2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"),
      createTestInvoice(undefined),
    ];

    const fetcher = async (id: string) => invoices[parseInt(id) - 1];
    const results = await enrichInvoices(["1", "2", "3"], fetcher);

    expect(results).toHaveLength(3);
    expect(results[0].metadata).toEqual({ batch: true });
    expect(results[1].metadata).toEqual({ batch: true });
    expect(results[2].metadata).toBeNull();
  });
});

describe("hasIPFSMetadata", () => {
  it("returns true for invoice with IPFS CID", () => {
    const invoice = createTestInvoice("ipfs:QmTestCidxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(hasIPFSMetadata(invoice)).toBe(true);
  });

  it("returns false for invoice without IPFS CID", () => {
    const invoice = createTestInvoice("Regular memo");
    expect(hasIPFSMetadata(invoice)).toBe(false);
  });

  it("returns false for invoice with undefined memo", () => {
    const invoice = createTestInvoice(undefined);
    expect(hasIPFSMetadata(invoice)).toBe(false);
  });
});

describe("getInvoiceMetadataCID", () => {
  it("extracts CID from invoice memo", () => {
    const cid = "QmExtractTest12345678901234567890123456789";
    const invoice = createTestInvoice(`ipfs:${cid}`);
    expect(getInvoiceMetadataCID(invoice)).toBe(cid);
  });

  it("returns null when no CID present", () => {
    const invoice = createTestInvoice("No IPFS here");
    expect(getInvoiceMetadataCID(invoice)).toBeNull();
  });
});

describe("Error type guards", () => {
  it("isIPFSPinError identifies IPFSPinError", () => {
    expect(isIPFSPinError(new IPFSPinError("test"))).toBe(true);
    expect(isIPFSPinError(new Error("test"))).toBe(false);
    expect(isIPFSPinError(null)).toBe(false);
  });

  it("isIPFSFetchError identifies IPFSFetchError", () => {
    expect(isIPFSFetchError(new IPFSFetchError("test", "cid"))).toBe(true);
    expect(isIPFSFetchError(new Error("test"))).toBe(false);
  });

  it("isCIDMismatchError identifies CIDMismatchError", () => {
    expect(isCIDMismatchError(new CIDMismatchError("cid"))).toBe(true);
    expect(isCIDMismatchError(new Error("test"))).toBe(false);
  });

  it("isIPFSConfigError identifies IPFSConfigError", () => {
    expect(isIPFSConfigError(new IPFSConfigError("test"))).toBe(true);
    expect(isIPFSConfigError(new Error("test"))).toBe(false);
  });

  it("CIDMismatchError includes expected and computed CID", () => {
    const err = new CIDMismatchError("expected", "computed");
    expect(err.expectedCID).toBe("expected");
    expect(err.computedCID).toBe("computed");
    expect(err.message).toContain("expected");
    expect(err.message).toContain("computed");
  });

  it("IPFSFetchError includes CID", () => {
    const err = new IPFSFetchError("Failed to fetch", "QmTestCid");
    expect(err.cid).toBe("QmTestCid");
  });

  it("IPFSPinError includes URL", () => {
    const err = new IPFSPinError("Pin failed", "http://example.com");
    expect(err.url).toBe("http://example.com");
  });
});
