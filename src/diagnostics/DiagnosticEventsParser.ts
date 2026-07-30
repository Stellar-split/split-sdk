/**
 * DiagnosticEventsParser — parse raw XDR diagnostic event bytes emitted by
 * Soroban contracts and map them to structured SDK error types.
 *
 * Re-exports the `ScValJson` type from ContractStorageExporter so that both
 * diagnostic modules share a single canonical definition.
 */

export type { ScValJson } from "./ContractStorageExporter.js";

// ---------------------------------------------------------------------------
// DiagnosticEvent
// ---------------------------------------------------------------------------

export interface DiagnosticEvent {
  /** Event origin: "contract" | "system" | "diagnostic" */
  type: "contract" | "system" | "diagnostic";
  /** Stellar contract ID (C… StrKey) that emitted the event. */
  contractId: string;
  /** Ordered list of topic ScVals. */
  topics: import("./ContractStorageExporter.js").ScValJson[];
  /** Primary data payload. */
  data: import("./ContractStorageExporter.js").ScValJson;
  /** Whether the event occurred inside a successful contract call. */
  inSuccessfulContractCall: boolean;
}
