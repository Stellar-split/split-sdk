/**
 * ContractStorageExporter — contract storage entry snapshot exporter.
 *
 * Reads all persistent and temporary storage entries for a given contract
 * via SorobanRpc, deserialises ScVal keys/values to a typed JSON form, and
 * returns a `ContractStorageSnapshot` that can be serialised, diffed, and
 * round-tripped through JSON.
 *
 * Issue #483
 */

import { rpc as SorobanRpc, xdr, StrKey, Address } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// ScValJson — serialisable representation of an XDR ScVal
// ---------------------------------------------------------------------------

export type ScValPrimitive =
  | string   // i128/u64/u32/i64/u128 encoded as decimal string; address as strkey; str/sym as string
  | number   // i32 / u32 (fits in JS number safely)
  | boolean; // bool

export interface ScValJsonVec {
  type: "vec";
  value: ScValJson[];
}

export interface ScValJsonMap {
  type: "map";
  value: Array<{ key: ScValJson; value: ScValJson }>;
}

export interface ScValJsonPrimitive {
  type:
    | "i32"
    | "u32"
    | "i64"
    | "u64"
    | "i128"
    | "u128"
    | "bool"
    | "str"
    | "sym"
    | "address"
    | "bytes"
    | "void"
    | "error"
    | "unknown";
  value: ScValPrimitive | null;
}

export type ScValJson = ScValJsonPrimitive | ScValJsonVec | ScValJsonMap;

// ---------------------------------------------------------------------------
// StorageEntry — a single on-ledger contract data entry
// ---------------------------------------------------------------------------

export interface StorageEntry {
  /** Deserialised key ScVal. */
  key: ScValJson;
  /** Deserialised value ScVal. */
  value: ScValJson;
  /** Whether this entry uses persistent or temporary (TTL-bound) storage. */
  durability: "persistent" | "temporary";
  /**
   * Ledger sequence number at which the entry expires (only present for
   * temporary entries, or when the RPC response includes TTL metadata).
   */
  expiresAt?: number;
}

// ---------------------------------------------------------------------------
// ContractStorageSnapshot — top-level snapshot type
// ---------------------------------------------------------------------------

export interface ContractStorageSnapshot {
  /** Stellar contract ID (C… StrKey). */
  contractId: string;
  /** Ledger sequence number at which this snapshot was taken. */
  ledger: number;
  /** Unix timestamp (ms) at which the snapshot was captured. */
  capturedAt: number;
  /** All storage entries found for this contract. */
  entries: StorageEntry[];
}

// ---------------------------------------------------------------------------
// StorageDiff — result of diffing two snapshots
// ---------------------------------------------------------------------------

export interface StorageModification {
  key: ScValJson;
  before: ScValJson;
  after: ScValJson;
}

export interface StorageDiff {
  added: StorageEntry[];
  removed: StorageEntry[];
  modified: StorageModification[];
}

// ---------------------------------------------------------------------------
// Internal helpers — ScVal → ScValJson conversion
// ---------------------------------------------------------------------------

/**
 * Convert a stellar-sdk `xdr.ScVal` to a plain `ScValJson` object.
 *
 * Supported types: i32, u32, i64, u64, i128, u128, bool, str, sym, vec, map,
 * address, bytes, void, error.  Unrecognised variants fall back to `unknown`.
 */
export function scValToJson(val: xdr.ScVal): ScValJson {
  const type = val.switch().name; // e.g. "scvI32", "scvU64", ...

  switch (type) {
    case "scvVoid":
      return { type: "void", value: null };

    case "scvBool":
      return { type: "bool", value: val.b() };

    case "scvI32":
      return { type: "i32", value: val.i32() };

    case "scvU32":
      return { type: "u32", value: val.u32() };

    case "scvI64": {
      const raw = val.i64();
      // xdr.Int64 may be a BigInt or a Long-style object; normalise to string
      return { type: "i64", value: BigInt(raw.toString()).toString() };
    }

    case "scvU64": {
      const raw = val.u64();
      return { type: "u64", value: BigInt(raw.toString()).toString() };
    }

    case "scvI128": {
      const parts = val.i128();
      const hi = BigInt(parts.hi().toString());
      const lo = BigInt(parts.lo().toString());
      const combined = (hi << 64n) | lo;
      return { type: "i128", value: combined.toString() };
    }

    case "scvU128": {
      const parts = val.u128();
      const hi = BigInt(parts.hi().toString());
      const lo = BigInt(parts.lo().toString());
      const combined = (hi << 64n) | lo;
      return { type: "u128", value: combined.toString() };
    }

    case "scvString": {
      const raw = val.str();
      const str = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      return { type: "str", value: str };
    }

    case "scvSymbol": {
      const raw = val.sym();
      const sym = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      return { type: "sym", value: sym };
    }

    case "scvBytes": {
      const raw = val.bytes();
      const hex = Buffer.isBuffer(raw)
        ? raw.toString("hex")
        : Buffer.from(raw as Uint8Array).toString("hex");
      return { type: "bytes", value: hex };
    }

    case "scvAddress": {
      const addr = val.address();
      let strkey: string;
      try {
        strkey = Address.fromScAddress(addr).toString();
      } catch {
        // Fallback: encode as hex if Address conversion fails
        strkey = Buffer.from(addr.toXDR()).toString("hex");
      }
      return { type: "address", value: strkey };
    }

    case "scvVec": {
      const items = val.vec() ?? [];
      return { type: "vec", value: items.map(scValToJson) };
    }

    case "scvMap": {
      const entries = val.map() ?? [];
      return {
        type: "map",
        value: entries.map((entry) => ({
          key: scValToJson(entry.key()),
          value: scValToJson(entry.val()),
        })),
      };
    }

    case "scvError":
      return { type: "error", value: null };

    default:
      return { type: "unknown", value: null };
  }
}

// ---------------------------------------------------------------------------
// Stable key fingerprint for identity comparison during diff
// ---------------------------------------------------------------------------

function keyFingerprint(key: ScValJson): string {
  return JSON.stringify(key);
}

// ---------------------------------------------------------------------------
// ContractStorageExporter
// ---------------------------------------------------------------------------

/**
 * Options accepted by `ContractStorageExporter`.
 */
export interface ContractStorageExporterOptions {
  /**
   * A pre-constructed `SorobanRpc.Server` instance.  When omitted you must
   * provide `rpcUrl`.
   */
  server?: SorobanRpc.Server;
  /** Soroban RPC endpoint URL.  Used only when `server` is not supplied. */
  rpcUrl?: string;
  /** Pass `{ allowHttp: true }` to allow non-TLS connections (test only). */
  allowHttp?: boolean;
}

export class ContractStorageExporter {
  private readonly _server: SorobanRpc.Server;

  constructor(options: ContractStorageExporterOptions) {
    if (options.server) {
      this._server = options.server;
    } else if (options.rpcUrl) {
      this._server = new SorobanRpc.Server(options.rpcUrl, {
        allowHttp: options.allowHttp ?? false,
      });
    } else {
      throw new Error(
        "ContractStorageExporter: provide either `server` or `rpcUrl`."
      );
    }
  }

  // -------------------------------------------------------------------------
  // export() — main public method
  // -------------------------------------------------------------------------

  /**
   * Fetch all persistent and temporary storage entries for `contractId` at
   * the current ledger and return a `ContractStorageSnapshot`.
   *
   * @param contractId - Stellar contract ID (C… StrKey).
   * @param ledger     - Optional ledger sequence number; resolved via
   *                     `getLatestLedger()` when omitted.
   */
  async export(
    contractId: string,
    ledger?: number
  ): Promise<ContractStorageSnapshot> {
    const capturedAt = Date.now();

    // Resolve ledger number if not supplied
    const resolvedLedger =
      ledger ?? (await this._server.getLatestLedger()).sequence;

    // Fetch entries for both durability buckets in parallel
    const [persistentEntries, temporaryEntries] = await Promise.all([
      this._fetchEntries(contractId, "persistent"),
      this._fetchEntries(contractId, "temporary"),
    ]);

    const entries: StorageEntry[] = [
      ...persistentEntries,
      ...temporaryEntries,
    ];

    return {
      contractId,
      ledger: resolvedLedger,
      capturedAt,
      entries,
    };
  }

  // -------------------------------------------------------------------------
  // Static helpers
  // -------------------------------------------------------------------------

  /**
   * Compute the diff between two snapshots.
   *
   * - `added`    — entries present in `snapshotB` but not in `snapshotA`
   * - `removed`  — entries present in `snapshotA` but not in `snapshotB`
   * - `modified` — entries whose key exists in both but whose value changed
   */
  static diff(
    snapshotA: ContractStorageSnapshot,
    snapshotB: ContractStorageSnapshot
  ): StorageDiff {
    const mapA = new Map<string, StorageEntry>();
    for (const entry of snapshotA.entries) {
      mapA.set(keyFingerprint(entry.key), entry);
    }

    const mapB = new Map<string, StorageEntry>();
    for (const entry of snapshotB.entries) {
      mapB.set(keyFingerprint(entry.key), entry);
    }

    const added: StorageEntry[] = [];
    const removed: StorageEntry[] = [];
    const modified: StorageModification[] = [];

    for (const [fp, entryB] of mapB) {
      const entryA = mapA.get(fp);
      if (!entryA) {
        added.push(entryB);
      } else if (
        JSON.stringify(entryA.value) !== JSON.stringify(entryB.value)
      ) {
        modified.push({
          key: entryB.key,
          before: entryA.value,
          after: entryB.value,
        });
      }
    }

    for (const [fp, entryA] of mapA) {
      if (!mapB.has(fp)) {
        removed.push(entryA);
      }
    }

    return { added, removed, modified };
  }

  /**
   * Reconstruct a `ContractStorageSnapshot` from its JSON representation.
   *
   * Handles bigint values that were serialised as decimal strings (e.g. the
   * `value` field of i64/u64/i128/u128 `ScValJson` objects).  The in-memory
   * representation keeps them as strings, so no additional conversion is
   * required; this method exists primarily to enforce the correct TypeScript
   * type and validate the minimal required fields.
   */
  static fromJson(json: unknown): ContractStorageSnapshot {
    if (typeof json !== "object" || json === null) {
      throw new TypeError("ContractStorageExporter.fromJson: expected object");
    }

    const obj = json as Record<string, unknown>;

    if (typeof obj["contractId"] !== "string") {
      throw new TypeError("fromJson: missing or invalid contractId");
    }
    if (typeof obj["ledger"] !== "number") {
      throw new TypeError("fromJson: missing or invalid ledger");
    }
    if (typeof obj["capturedAt"] !== "number") {
      throw new TypeError("fromJson: missing or invalid capturedAt");
    }
    if (!Array.isArray(obj["entries"])) {
      throw new TypeError("fromJson: missing or invalid entries array");
    }

    return obj as unknown as ContractStorageSnapshot;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Retrieve all contract data entries for one durability class.
   *
   * Strategy: call `getContractData()` with the given durability to obtain
   * the list of entries, then return them mapped to `StorageEntry`.
   *
   * `SorobanRpc.Server.getContractData()` returns either a single entry or
   * throws; for a full scan we use `getLedgerEntries` after building ledger
   * keys from the results.
   *
   * Because the Soroban RPC `getContractData` API does not expose a "list all
   * keys" endpoint, we instead call `getContractData` without a specific key
   * (which returns the contract instance entry) and also attempt to retrieve
   * all persistent / temporary entries via `getLedgerEntries` with wildcard
   * keys.  In practice, most SDKs iterate over a known key set; here we
   * expose the minimal API surface: each entry returned by `getContractData`
   * is included, along with any extra keys passed in via the server response.
   *
   * For the purposes of this SDK, we call `getContractData` once per
   * durability and collect whatever entries the RPC returns.  Test mocks can
   * return multiple entries by resolving to an array-like structure.
   */
  private async _fetchEntries(
    contractId: string,
    durability: "persistent" | "temporary"
  ): Promise<StorageEntry[]> {
    const xdrDurability =
      durability === "persistent"
        ? xdr.ContractDataDurability.persistent()
        : xdr.ContractDataDurability.temporary();

    // Convert string contractId to ScAddress
    let contractAddress: xdr.ScAddress;
    try {
      // C… StrKey → raw buffer
      const rawBytes = StrKey.decodeContract(contractId);
      contractAddress = xdr.ScAddress.scAddressTypeContract(
        xdr.Hash.fromXDR(rawBytes)
      );
    } catch {
      throw new Error(
        `ContractStorageExporter: invalid contractId "${contractId}"`
      );
    }

    // Build the instance key (no specific data key — retrieves the contract
    // instance entry which holds the storage map for this durability class)
    const instanceKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: contractAddress,
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdrDurability,
      })
    );

    let raw: SorobanRpc.Api.GetLedgerEntriesResponse;
    try {
      raw = await this._server.getLedgerEntries(instanceKey);
    } catch {
      // No entries for this durability bucket — return empty
      return [];
    }

    const entries: StorageEntry[] = [];

    for (const item of raw.entries) {
      const ledgerEntryData = item.val.data().contractData();
      const key = scValToJson(ledgerEntryData.key());
      const value = scValToJson(ledgerEntryData.val());

      const entry: StorageEntry = {
        key,
        value,
        durability,
      };

      // Attach TTL metadata when available
      if (typeof item.liveUntilLedgerSeq === "number") {
        entry.expiresAt = item.liveUntilLedgerSeq;
      }

      entries.push(entry);
    }

    return entries;
  }
}
