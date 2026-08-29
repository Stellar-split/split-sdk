import type { InvoiceTemplate } from "./types.js";

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

const isBrowser = typeof window !== "undefined" && typeof window.localStorage !== "undefined";

// ---------------------------------------------------------------------------
// Node.js helpers (lazy-loaded to avoid bundler issues in browser)
// ---------------------------------------------------------------------------

function getNodeStorePath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os") as typeof import("os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path") as typeof import("path");
  return path.join(os.homedir(), ".stellar-split", "templates.json");
}

function readNodeStore(): Record<string, InvoiceTemplate> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs") as typeof import("fs");
  const filePath = getNodeStorePath();
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, InvoiceTemplate>;
  } catch {
    return {};
  }
}

const bigintReplacer = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

function writeNodeStore(store: Record<string, InvoiceTemplate>): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path") as typeof import("path");
  const filePath = getNodeStorePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, bigintReplacer, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = "stellar-split:templates";

function readBrowserStore(): Record<string, InvoiceTemplate> {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, InvoiceTemplate>;
  } catch {
    return {};
  }
}

function writeBrowserStore(store: Record<string, InvoiceTemplate>): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store, bigintReplacer));
}

// ---------------------------------------------------------------------------
// Version history (in-memory; no persistence layer)
// ---------------------------------------------------------------------------

/**
 * A single versioned snapshot of a template's content.
 */
export interface TemplateVersion {
  /** Monotonically increasing version number, starting at 1. */
  version: number;
  /** The template content at this version. */
  content: string;
}

/**
 * In-memory store mapping template ID → ordered list of {@link TemplateVersion}s.
 * Index 0 holds v1, index N-1 holds the latest version.
 */
const _versionHistory = new Map<string, TemplateVersion[]>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Save an invoice template by name. Overwrites if name already exists. */
export function saveTemplate(name: string, template: InvoiceTemplate): void {
  if (isBrowser) {
    const store = readBrowserStore();
    store[name] = template;
    writeBrowserStore(store);
  } else {
    const store = readNodeStore();
    store[name] = template;
    writeNodeStore(store);
  }
}

/** Load a template by name. Returns null if not found. */
export function loadTemplate(name: string): InvoiceTemplate | null {
  const store = isBrowser ? readBrowserStore() : readNodeStore();
  return store[name] ?? null;
}

/** List all saved template names. */
export function listTemplates(): string[] {
  const store = isBrowser ? readBrowserStore() : readNodeStore();
  return Object.keys(store);
}

/** Delete a template by name. No-op if not found. */
export function deleteTemplate(name: string): void {
  if (isBrowser) {
    const store = readBrowserStore();
    delete store[name];
    writeBrowserStore(store);
  } else {
    const store = readNodeStore();
    delete store[name];
    writeNodeStore(store);
  }
}

// ---------------------------------------------------------------------------
// Versioned template API
// ---------------------------------------------------------------------------

/**
 * Update a template's content.
 *
 * - The new content is stored as the next version (version 1 on first call).
 * - All previous versions are retained in {@link _versionHistory} so they can
 *   be retrieved via {@link getTemplate}.
 * - Version numbers are integers starting at 1 and increment by 1 on every
 *   call regardless of whether the content actually changed.
 *
 * @param id      - Unique template identifier.
 * @param content - New template content string.
 * @returns The new version number assigned to this content.
 */
export function updateTemplate(id: string, content: string): number {
  const history = _versionHistory.get(id) ?? [];
  const nextVersion = history.length + 1;
  history.push({ version: nextVersion, content });
  _versionHistory.set(id, history);
  return nextVersion;
}

/**
 * Retrieve a template's content by ID and optional version.
 *
 * @param id      - Unique template identifier.
 * @param version - Specific version to retrieve.  When omitted (or 0), the
 *                  latest version is returned.
 * @returns The {@link TemplateVersion} for the requested version, or `null` if
 *          the template does not exist or the version is out of range.
 */
export function getTemplate(id: string, version?: number): TemplateVersion | null {
  const history = _versionHistory.get(id);
  if (!history || history.length === 0) return null;

  if (!version) {
    // Return the latest version when no version is specified.
    return history[history.length - 1];
  }

  // Versions are 1-indexed; array is 0-indexed.
  const entry = history[version - 1];
  return entry ?? null;
}

/**
 * Retrieve the full version history for a template.
 *
 * @param id - Unique template identifier.
 * @returns Ordered list of {@link TemplateVersion}s (oldest first), or an
 *          empty array when the template has no recorded history.
 */
export function getTemplateHistory(id: string): TemplateVersion[] {
  return _versionHistory.get(id) ?? [];
}
