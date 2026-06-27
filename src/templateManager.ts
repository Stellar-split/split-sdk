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
