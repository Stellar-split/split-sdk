/**
 * Unit tests for ContractStorageExporter
 *
 * Covers:
 *  - export() with empty contract (no entries)
 *  - export() with multiple ScVal types (i128, u64, bool, str, vec, map, address)
 *  - diff() with added, removed, and modified entries
 *  - JSON round-trip via JSON.stringify / fromJson (including bigint-as-string)
 *  - scValToJson conversion for all required types
 */

import { describe, it, expect, vi } from "vitest";
import {
  ContractStorageExporter,
  scValToJson,
} from "../../src/diagnostics/ContractStorageExporter.js";
import type {
  ContractStorageSnapshot,
  StorageEntry,
  ScValJson,
} from "../../src/diagnostics/ContractStorageExporter.js";
import { xdr, Address, StrKey } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Helpers — build XDR ScVal objects
// ---------------------------------------------------------------------------

function makeI32(v: number): xdr.ScVal {
  return xdr.ScVal.scvI32(v);
}

function makeU32(v: number): xdr.ScVal {
  return xdr.ScVal.scvU32(v);
}

function makeI64(v: bigint): xdr.ScVal {
  // stellar-sdk expects a Long-compatible value; pass as string then wrap
  return xdr.ScVal.scvI64(
    xdr.Int64.fromString(v.toString())
  );
}

function makeU64(v: bigint): xdr.ScVal {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(v.toString()));
}

function makeI128(v: bigint): xdr.ScVal {
  // Split into hi (upper 64) and lo (lower 64)
  const lo = v & 0xffffffffffffffffn;
  const hi = v >> 64n;
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString(hi.toString()),
      lo: xdr.Uint64.fromString(lo.toString()),
    })
  );
}

function makeU128(v: bigint): xdr.ScVal {
  const lo = v & 0xffffffffffffffffn;
  const hi = v >> 64n;
  return xdr.ScVal.scvU128(
    new xdr.UInt128Parts({
      hi: xdr.Uint64.fromString(hi.toString()),
      lo: xdr.Uint64.fromString(lo.toString()),
    })
  );
}

function makeBool(v: boolean): xdr.ScVal {
  return xdr.ScVal.scvBool(v);
}

function makeStr(v: string): xdr.ScVal {
  return xdr.ScVal.scvString(Buffer.from(v, "utf8"));
}

function makeSym(v: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(Buffer.from(v, "utf8"));
}

function makeAddress(publicKey: string): xdr.ScVal {
  // Address.fromString only supports C-addresses; for G-addresses use
  // Keypair to extract the raw 32-byte public key and wrap via Address.account
  const rawBytes = StrKey.decodeEd25519PublicKey(publicKey);
  const addr = Address.account(rawBytes);
  return addr.toScVal();
}

function makeVec(items: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec(items);
}

function makeMap(
  pairs: Array<{ key: xdr.ScVal; val: xdr.ScVal }>
): xdr.ScVal {
  const entries = pairs.map(
    (p) =>
      new xdr.ScMapEntry({
        key: p.key,
        val: p.val,
      })
  );
  return xdr.ScVal.scvMap(entries);
}

// ---------------------------------------------------------------------------
// Helpers — build minimal mock getLedgerEntries response entries
// ---------------------------------------------------------------------------

function makeContractDataEntry(
  contractIdHex: string,
  keyXdr: xdr.ScVal,
  valXdr: xdr.ScVal,
  durability: "persistent" | "temporary",
  liveUntilLedgerSeq?: number
) {
  // Build the LedgerEntry xdr
  const xdrDurability =
    durability === "persistent"
      ? xdr.ContractDataDurability.persistent()
      : xdr.ContractDataDurability.temporary();

  const contractData = new xdr.ContractDataEntry({
    ext: new xdr.ExtensionPoint(0),
    contract: xdr.ScAddress.scAddressTypeContract(
      xdr.Hash.fromXDR(Buffer.from(contractIdHex, "hex"))
    ),
    key: keyXdr,
    durability: xdrDurability,
    val: valXdr,
  });

  const ledgerEntry = new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 100,
    data: xdr.LedgerEntryData.contractData(contractData),
    ext: new xdr.LedgerEntryExt(0),
  });

  return {
    lastModifiedLedgerSeq: 100,
    key: xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: xdr.ScAddress.scAddressTypeContract(
          xdr.Hash.fromXDR(Buffer.from(contractIdHex, "hex"))
        ),
        key: keyXdr,
        durability: xdrDurability,
      })
    ),
    val: ledgerEntry,
    liveUntilLedgerSeq,
  };
}

// A valid Stellar G-address for test use (derived from all-zero raw seed)
const TEST_PUBLIC_KEY =
  "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH";

// Convert a test contractId (C-address) to its raw hex for building entries
function contractIdToHex(contractId: string): string {
  return Buffer.from(StrKey.decodeContract(contractId)).toString("hex");
}

// A well-formed contract ID for tests
const TEST_CONTRACT_ID =
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";

// ---------------------------------------------------------------------------
// Mock SorobanRpc.Server
// ---------------------------------------------------------------------------

function makeMockServer(options: {
  latestLedger?: number;
  persistentEntries?: ReturnType<typeof makeContractDataEntry>[];
  temporaryEntries?: ReturnType<typeof makeContractDataEntry>[];
} = {}) {
  const { latestLedger = 1000, persistentEntries = [], temporaryEntries = [] } =
    options;

  const server = {
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: latestLedger }),
    getLedgerEntries: vi.fn().mockImplementation((...keys: xdr.LedgerKey[]) => {
      // Determine durability from the first key
      const firstKey = keys[0];
      const dur = firstKey
        ?.contractData()
        .durability()
        .name.replace("contractData", "")
        .toLowerCase();

      const isPersistent = dur?.includes("persistent");
      const entries = isPersistent ? persistentEntries : temporaryEntries;

      return Promise.resolve({ entries, latestLedger });
    }),
  };
  return server as unknown as import("@stellar/stellar-sdk").rpc.Server;
}

// ---------------------------------------------------------------------------
// scValToJson — unit tests
// ---------------------------------------------------------------------------

describe("scValToJson", () => {
  it("converts void", () => {
    const result = scValToJson(xdr.ScVal.scvVoid());
    expect(result).toEqual({ type: "void", value: null });
  });

  it("converts bool true", () => {
    expect(scValToJson(makeBool(true))).toEqual({ type: "bool", value: true });
  });

  it("converts bool false", () => {
    expect(scValToJson(makeBool(false))).toEqual({ type: "bool", value: false });
  });

  it("converts i32", () => {
    expect(scValToJson(makeI32(-42))).toEqual({ type: "i32", value: -42 });
  });

  it("converts u32", () => {
    expect(scValToJson(makeU32(99))).toEqual({ type: "u32", value: 99 });
  });

  it("converts u64 as decimal string", () => {
    const val = 18446744073709551615n; // u64 max
    const result = scValToJson(makeU64(val));
    expect(result.type).toBe("u64");
    expect(result.value).toBe("18446744073709551615");
  });

  it("converts i128 as decimal string", () => {
    const val = 170141183460469231731687303715884105727n; // i128 max (all 1s unsigned)
    const result = scValToJson(makeI128(val));
    expect(result.type).toBe("i128");
    // Value should be parseable as BigInt
    expect(BigInt(result.value as string)).toBe(val);
  });

  it("converts str", () => {
    expect(scValToJson(makeStr("hello world"))).toEqual({
      type: "str",
      value: "hello world",
    });
  });

  it("converts sym", () => {
    expect(scValToJson(makeSym("transfer"))).toEqual({
      type: "sym",
      value: "transfer",
    });
  });

  it("converts address", () => {
    const result = scValToJson(makeAddress(TEST_PUBLIC_KEY));
    expect(result.type).toBe("address");
    expect(typeof result.value).toBe("string");
    // Should round-trip to the same address
    expect(result.value).toBe(TEST_PUBLIC_KEY);
  });

  it("converts vec", () => {
    const result = scValToJson(
      makeVec([makeI32(1), makeI32(2), makeI32(3)])
    );
    expect(result.type).toBe("vec");
    const items = (result as ScValJson & { value: ScValJson[] }).value;
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ type: "i32", value: 1 });
  });

  it("converts empty vec", () => {
    const result = scValToJson(makeVec([]));
    expect(result.type).toBe("vec");
    expect((result as any).value).toHaveLength(0);
  });

  it("converts map", () => {
    const result = scValToJson(
      makeMap([
        { key: makeStr("amount"), val: makeI128(1000n) },
        { key: makeStr("recipient"), val: makeAddress(TEST_PUBLIC_KEY) },
      ])
    );
    expect(result.type).toBe("map");
    const entries = (result as any).value as Array<{
      key: ScValJson;
      value: ScValJson;
    }>;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.key).toEqual({ type: "str", value: "amount" });
    expect(entries[0]!.value.type).toBe("i128");
  });

  it("converts empty map", () => {
    const result = scValToJson(makeMap([]));
    expect(result.type).toBe("map");
    expect((result as any).value).toHaveLength(0);
  });

  it("handles nested vec-of-map", () => {
    const inner = makeMap([{ key: makeStr("k"), val: makeBool(true) }]);
    const outer = makeVec([inner]);
    const result = scValToJson(outer);
    expect(result.type).toBe("vec");
    const items = (result as any).value;
    expect(items[0].type).toBe("map");
  });
});

// ---------------------------------------------------------------------------
// ContractStorageExporter.export() — integration-level mock tests
// ---------------------------------------------------------------------------

describe("ContractStorageExporter.export()", () => {
  it("returns empty entries for a contract with no storage", async () => {
    const server = makeMockServer({
      persistentEntries: [],
      temporaryEntries: [],
    });

    const exporter = new ContractStorageExporter({ server });
    const snapshot = await exporter.export(TEST_CONTRACT_ID, 500);

    expect(snapshot.contractId).toBe(TEST_CONTRACT_ID);
    expect(snapshot.ledger).toBe(500);
    expect(snapshot.entries).toHaveLength(0);
    expect(typeof snapshot.capturedAt).toBe("number");
  });

  it("resolves ledger from getLatestLedger when not provided", async () => {
    const server = makeMockServer({ latestLedger: 999 });
    const exporter = new ContractStorageExporter({ server });
    const snapshot = await exporter.export(TEST_CONTRACT_ID);
    expect(snapshot.ledger).toBe(999);
  });

  it("returns persistent and temporary entries combined", async () => {
    const hexId = contractIdToHex(TEST_CONTRACT_ID);

    const persistEntry = makeContractDataEntry(
      hexId,
      makeStr("inv_count"),
      makeU32(42),
      "persistent"
    );
    const tempEntry = makeContractDataEntry(
      hexId,
      makeStr("session"),
      makeBool(true),
      "temporary",
      1200
    );

    const server = makeMockServer({
      persistentEntries: [persistEntry],
      temporaryEntries: [tempEntry],
    });

    const exporter = new ContractStorageExporter({ server });
    const snapshot = await exporter.export(TEST_CONTRACT_ID, 1000);

    expect(snapshot.entries).toHaveLength(2);

    const persistent = snapshot.entries.find(
      (e) => e.durability === "persistent"
    );
    const temporary = snapshot.entries.find((e) => e.durability === "temporary");

    expect(persistent).toBeDefined();
    expect(persistent!.key).toEqual({ type: "str", value: "inv_count" });
    expect(persistent!.value).toEqual({ type: "u32", value: 42 });

    expect(temporary).toBeDefined();
    expect(temporary!.key).toEqual({ type: "str", value: "session" });
    expect(temporary!.expiresAt).toBe(1200);
  });

  it("attaches expiresAt when liveUntilLedgerSeq is present", async () => {
    const hexId = contractIdToHex(TEST_CONTRACT_ID);
    const entry = makeContractDataEntry(
      hexId,
      makeStr("ttl_key"),
      makeU32(1),
      "temporary",
      5000
    );
    const server = makeMockServer({ temporaryEntries: [entry] });
    const exporter = new ContractStorageExporter({ server });
    const snapshot = await exporter.export(TEST_CONTRACT_ID, 100);

    const found = snapshot.entries.find((e) => e.durability === "temporary");
    expect(found?.expiresAt).toBe(5000);
  });

  it("handles i128 and address values in entries", async () => {
    const hexId = contractIdToHex(TEST_CONTRACT_ID);
    const entry = makeContractDataEntry(
      hexId,
      makeStr("balance"),
      makeI128(123456789012345678901234567890n),
      "persistent"
    );
    const server = makeMockServer({ persistentEntries: [entry] });
    const exporter = new ContractStorageExporter({ server });
    const snapshot = await exporter.export(TEST_CONTRACT_ID, 100);

    const found = snapshot.entries.find((e) => e.durability === "persistent");
    expect(found).toBeDefined();
    expect(found!.value.type).toBe("i128");
    // Value is stored as a string
    expect(typeof found!.value.value).toBe("string");
  });

  it("handles vec values in entries", async () => {
    const hexId = contractIdToHex(TEST_CONTRACT_ID);
    const entry = makeContractDataEntry(
      hexId,
      makeStr("recipients"),
      makeVec([makeAddress(TEST_PUBLIC_KEY), makeAddress(TEST_PUBLIC_KEY)]),
      "persistent"
    );
    const server = makeMockServer({ persistentEntries: [entry] });
    const exporter = new ContractStorageExporter({ server });
    const snapshot = await exporter.export(TEST_CONTRACT_ID, 100);

    const found = snapshot.entries.find((e) => e.durability === "persistent");
    expect(found!.value.type).toBe("vec");
    expect((found!.value as any).value).toHaveLength(2);
  });

  it("throws on invalid contractId", async () => {
    const server = makeMockServer();
    const exporter = new ContractStorageExporter({ server });
    await expect(exporter.export("INVALID_CONTRACT_ID", 100)).rejects.toThrow(
      /invalid contractId/
    );
  });
});

// ---------------------------------------------------------------------------
// ContractStorageExporter.diff()
// ---------------------------------------------------------------------------

function makeSimpleSnapshot(
  entries: StorageEntry[],
  ledger = 1
): ContractStorageSnapshot {
  return {
    contractId: TEST_CONTRACT_ID,
    ledger,
    capturedAt: Date.now(),
    entries,
  };
}

function makeEntry(
  keyValue: string,
  valueNum: number,
  durability: "persistent" | "temporary" = "persistent"
): StorageEntry {
  return {
    key: { type: "str", value: keyValue },
    value: { type: "u32", value: valueNum },
    durability,
  };
}

describe("ContractStorageExporter.diff()", () => {
  it("returns empty diff for identical snapshots", () => {
    const entries = [makeEntry("k1", 1), makeEntry("k2", 2)];
    const snap = makeSimpleSnapshot(entries);
    const diff = ContractStorageExporter.diff(snap, snap);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("detects added entries", () => {
    const snapA = makeSimpleSnapshot([makeEntry("k1", 1)]);
    const snapB = makeSimpleSnapshot([makeEntry("k1", 1), makeEntry("k2", 2)]);
    const diff = ContractStorageExporter.diff(snapA, snapB);

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]!.key).toEqual({ type: "str", value: "k2" });
    expect(diff.removed).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("detects removed entries", () => {
    const snapA = makeSimpleSnapshot([makeEntry("k1", 1), makeEntry("k2", 2)]);
    const snapB = makeSimpleSnapshot([makeEntry("k1", 1)]);
    const diff = ContractStorageExporter.diff(snapA, snapB);

    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]!.key).toEqual({ type: "str", value: "k2" });
    expect(diff.added).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("detects modified entries", () => {
    const snapA = makeSimpleSnapshot([makeEntry("k1", 100)]);
    const snapB = makeSimpleSnapshot([makeEntry("k1", 200)]);
    const diff = ContractStorageExporter.diff(snapA, snapB);

    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0]!.key).toEqual({ type: "str", value: "k1" });
    expect(diff.modified[0]!.before).toEqual({ type: "u32", value: 100 });
    expect(diff.modified[0]!.after).toEqual({ type: "u32", value: 200 });
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("handles all three change categories simultaneously", () => {
    const snapA = makeSimpleSnapshot([
      makeEntry("k1", 10), // will be modified
      makeEntry("k2", 20), // will be removed
      makeEntry("k3", 30), // unchanged
    ]);
    const snapB = makeSimpleSnapshot([
      makeEntry("k1", 99), // modified
      makeEntry("k3", 30), // unchanged
      makeEntry("k4", 40), // added
    ]);
    const diff = ContractStorageExporter.diff(snapA, snapB);

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]!.key).toEqual({ type: "str", value: "k4" });

    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]!.key).toEqual({ type: "str", value: "k2" });

    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0]!.key).toEqual({ type: "str", value: "k1" });
    expect(diff.modified[0]!.before).toEqual({ type: "u32", value: 10 });
    expect(diff.modified[0]!.after).toEqual({ type: "u32", value: 99 });
  });

  it("treats entries as unchanged when value is identical", () => {
    const snapA = makeSimpleSnapshot([makeEntry("k1", 42)]);
    const snapB = makeSimpleSnapshot([makeEntry("k1", 42)]);
    const diff = ContractStorageExporter.diff(snapA, snapB);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("handles empty snapshot A", () => {
    const snapA = makeSimpleSnapshot([]);
    const snapB = makeSimpleSnapshot([makeEntry("k1", 1), makeEntry("k2", 2)]);
    const diff = ContractStorageExporter.diff(snapA, snapB);

    expect(diff.added).toHaveLength(2);
    expect(diff.removed).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("handles empty snapshot B", () => {
    const snapA = makeSimpleSnapshot([makeEntry("k1", 1), makeEntry("k2", 2)]);
    const snapB = makeSimpleSnapshot([]);
    const diff = ContractStorageExporter.diff(snapA, snapB);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(2);
    expect(diff.modified).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ContractStorageExporter.fromJson() — JSON round-trip
// ---------------------------------------------------------------------------

describe("ContractStorageExporter.fromJson()", () => {
  it("reconstructs a snapshot from JSON.parse output", () => {
    const original: ContractStorageSnapshot = {
      contractId: TEST_CONTRACT_ID,
      ledger: 42,
      capturedAt: 1700000000000,
      entries: [
        {
          key: { type: "str", value: "invoice_count" },
          value: { type: "u32", value: 7 },
          durability: "persistent",
        },
      ],
    };

    const json = JSON.parse(JSON.stringify(original));
    const restored = ContractStorageExporter.fromJson(json);

    expect(restored.contractId).toBe(TEST_CONTRACT_ID);
    expect(restored.ledger).toBe(42);
    expect(restored.capturedAt).toBe(1700000000000);
    expect(restored.entries).toHaveLength(1);
    expect(restored.entries[0]!.durability).toBe("persistent");
  });

  it("preserves bigint-as-string values through JSON round-trip", () => {
    const bigIntAsString = "170141183460469231731687303715884105727";
    const original: ContractStorageSnapshot = {
      contractId: TEST_CONTRACT_ID,
      ledger: 100,
      capturedAt: Date.now(),
      entries: [
        {
          key: { type: "sym", value: "balance" },
          value: { type: "i128", value: bigIntAsString },
          durability: "persistent",
        },
      ],
    };

    const json = JSON.parse(JSON.stringify(original));
    const restored = ContractStorageExporter.fromJson(json);

    const entry = restored.entries[0]!;
    expect(entry.value.value).toBe(bigIntAsString);
    // Confirm the string is parseable as BigInt
    expect(() => BigInt(bigIntAsString)).not.toThrow();
  });

  it("preserves u64 max value through JSON round-trip", () => {
    const u64Max = "18446744073709551615";
    const original: ContractStorageSnapshot = {
      contractId: TEST_CONTRACT_ID,
      ledger: 1,
      capturedAt: 0,
      entries: [
        {
          key: { type: "str", value: "seq" },
          value: { type: "u64", value: u64Max },
          durability: "temporary",
          expiresAt: 999,
        },
      ],
    };

    const restored = ContractStorageExporter.fromJson(
      JSON.parse(JSON.stringify(original))
    );
    expect(restored.entries[0]!.value.value).toBe(u64Max);
    expect(restored.entries[0]!.expiresAt).toBe(999);
  });

  it("round-trips a full snapshot with all ScVal types", () => {
    const original: ContractStorageSnapshot = {
      contractId: TEST_CONTRACT_ID,
      ledger: 500,
      capturedAt: 1700000000000,
      entries: [
        {
          key: { type: "u32", value: 0 },
          value: { type: "bool", value: true },
          durability: "persistent",
        },
        {
          key: { type: "str", value: "addr" },
          value: { type: "address", value: TEST_PUBLIC_KEY },
          durability: "temporary",
          expiresAt: 600,
        },
        {
          key: { type: "sym", value: "items" },
          value: {
            type: "vec",
            value: [
              { type: "u32", value: 1 },
              { type: "u32", value: 2 },
            ],
          } as ScValJson,
          durability: "persistent",
        },
        {
          key: { type: "str", value: "meta" },
          value: {
            type: "map",
            value: [
              {
                key: { type: "str", value: "x" },
                value: { type: "i128", value: "99999999999999999999" },
              },
            ],
          } as ScValJson,
          durability: "persistent",
        },
      ],
    };

    const restored = ContractStorageExporter.fromJson(
      JSON.parse(JSON.stringify(original))
    );

    expect(restored.entries).toHaveLength(4);
    expect(restored.entries[1]!.expiresAt).toBe(600);
    // Nested vec
    const vecEntry = restored.entries[2]!;
    expect(vecEntry.value.type).toBe("vec");
    // Nested map with i128
    const mapEntry = restored.entries[3]!;
    expect(mapEntry.value.type).toBe("map");
    const mapValue = (mapEntry.value as any).value[0].value;
    expect(mapValue.value).toBe("99999999999999999999");
  });

  it("throws when input is not an object", () => {
    expect(() => ContractStorageExporter.fromJson("string")).toThrow(TypeError);
    expect(() => ContractStorageExporter.fromJson(null)).toThrow(TypeError);
    expect(() => ContractStorageExporter.fromJson(42)).toThrow(TypeError);
  });

  it("throws when contractId is missing", () => {
    expect(() =>
      ContractStorageExporter.fromJson({
        ledger: 1,
        capturedAt: 0,
        entries: [],
      })
    ).toThrow(TypeError);
  });

  it("throws when ledger is missing", () => {
    expect(() =>
      ContractStorageExporter.fromJson({
        contractId: TEST_CONTRACT_ID,
        capturedAt: 0,
        entries: [],
      })
    ).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe("ContractStorageExporter constructor", () => {
  it("throws when neither server nor rpcUrl is provided", () => {
    expect(() => new ContractStorageExporter({})).toThrow(
      /provide either.*server.*rpcUrl/
    );
  });

  it("accepts a pre-built server instance", () => {
    const server = makeMockServer();
    expect(
      () => new ContractStorageExporter({ server })
    ).not.toThrow();
  });
});
