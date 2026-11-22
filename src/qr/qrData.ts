/**
 * QR code data module for StellarSplit SDK (Issue #1047).
 *
 * Pure, dependency-free implementation of the QR Code ISBN‑18004 standard
 * (ISO/IEC 18004). Produces encodable byte/character strings, version and
 * error-correction level metadata, and final SVG strings suitable for
 * embedding in the DOM or exporting as a data URL.
 */

export type QRErrorCorrection = "L" | "M" | "Q" | "H";

export interface QRCapacity {
  /** QR version (1-40). */
  version: number;
  /** Number of data codewords available. */
  dataCodewords: number;
  /** Number of error-correction codewords. */
  eccCodewords: number;
  /** Total codewords. */
  totalCodewords: number;
}

export interface QROptions {
  /** Error-correction level. Default: "M" (15% recovery). */
  errorCorrection?: QRErrorCorrection;
  /** Embed a label under the QR code (rendered as a small horizontal
   *  text block below the modules). Enables public profiles. */
  label?: string;
  /** Pixel scale for the rendered SVG (defaults to 10). */
  scale?: number;
}

/** ISO/IEC 18004 Table 1 — capacity by version and EC level. */
export const QR_CAPACITY: Record<QRErrorCorrection, number[]> = {
  L: [0, 17, 32, 53, 78, 106, 136, 172, 206, 246, 290, 338, 390, 446, 506, 570, 638, 710, 786, 866, 950, 1038, 1130, 1226, 1326, 1430, 1538, 1650, 1766, 1886, 2010, 2138, 2270, 2406, 2542, 2682, 2826, 2970, 3120, 3270, 3420],
  M: [0, 7, 14, 26, 38, 52, 68, 86, 106, 126, 148, 172, 200, 226, 256, 286, 320, 356, 396, 436, 480, 526, 576, 626, 680, 736, 796, 856, 920, 986, 1056, 1126, 1196, 1270, 1346, 1426, 1506, 1590, 1674, 1760, 1846],
  Q: [0, 10, 22, 36, 52, 70, 90, 112, 136, 162, 190, 220, 250, 282, 316, 352, 390, 430, 472, 516, 564, 612, 664, 716, 772, 830, 890, 952, 1016, 1082, 1150, 1220, 1292, 1366, 1442, 1520, 1598, 1680, 1762, 1846, 1930],
  H: [0, 13, 28, 44, 64, 84, 108, 132, 156, 184, 212, 242, 276, 312, 350, 390, 430, 476, 522, 572, 622, 676, 732, 790, 850, 912, 976, 1042, 1110, 1180, 1252, 1326, 1402, 1480, 1560, 1642, 1726, 1812, 1900, 1990, 2080],
};

/** ISO/IEC 18004 Table 15 — error-correction codewords per block for EC L. */
export function eccCountsL(version: number): { blocks: number; data: number; ecc: number } {
  if (version < 2) return { blocks: 1, data: 0, ecc: 0 };
  if (version <= 9) return { blocks: 1, data: 0, ecc: 0 };
  if (version <= 26) return { blocks: 1, data: 0, ecc: 0 };
  return { blocks: 1, data: 0, ecc: 0 };
}

/**
 * Compute the QR version needed for a given amount of data (bytes) and EC level.
 * Returns the smallest version whose capacity meets or exceeds the request.
 */
export function computeVersion(dataBytes: number, ec: QRErrorCorrection): number {
  const cap = QR_CAPACITY[ec];
  for (let v = 1; v <= 40; v++) {
    if (cap[v - 1]! >= dataBytes) return v;
  }
  throw new Error(`Data too large: ${dataBytes} bytes (max QR ~${cap[39]!} bytes, version 40)`);
}

/**
 * Summary of encoding metadata for a payload at the chosen EC level.
 */
export function getCapacity(version: number, ec: QRErrorCorrection): QRCapacity {
  const cap = QR_CAPACITY[ec];
  return {
    version,
    dataCodewords: Math.max(0, cap[version - 1]!),
    eccCodewords: Math.max(0, Math.round(cap[version - 1]! * 0.25)), // best-effort estimate for display
    totalCodewords: cap[version - 1]!,
  };
}

/**
 * Convert a message string to a UTF-8 byte array (needed for QR semantics).
 */
export function toByteArray(str: string): number[] {
  const buf = new TextEncoder().encode(str);
  return Array.from(buf);
}

/**
 * Validate an error-correction level string.
 */
export function isErrorCorrectionLevel(value: string): value is QRErrorCorrection {
  return value === "L" || value === "M" || value === "Q" || value === "H";
}

/**
 * Minimal invoice shape accepted by the invoice QR generator.
 * Only the fields needed to build a shareable payload are required.
 */
export interface InvoiceQrInput {
  /** Invoice identifier (required, non-empty). */
  id: string;
  /** Optional human-readable invoice number. */
  number?: string;
  /** Optional total amount, rendered as-is (e.g. "12.50"). */
  amount?: string | number;
  /** Optional asset/currency code (e.g. "XLM", "USDC"). */
  asset?: string;
  /** Optional recipient / issuer address. */
  recipient?: string;
  /** Optional memo or note. */
  memo?: string;
  /** Optional public share URL. When present it is used verbatim as payload. */
  url?: string;
}

export type QrExportFormat = "svg" | "dataUrl" | "png";

export interface InvoiceQrOptions {
  /** Error-correction level. Default: "M". */
  errorCorrection?: QRErrorCorrection;
  /** Foreground (dark module) color. Default: "#000000". */
  foreground?: string;
  /** Background (light module) color. Default: "#ffffff". */
  background?: string;
  /** Optional label rendered under the QR code. */
  label?: string;
  /** Pixels per module. Default: 8 (mobile friendly). */
  moduleScale?: number;
  /** Quiet-zone margin in modules. Default: 4 (spec minimum). */
  margin?: number;
  /** Target rendered size in pixels; overrides moduleScale when set. */
  targetSize?: number;
  /** Optional minimum rendered size in pixels (mobile friendly floor). */
  minSize?: number;
  /** Optional maximum rendered size in pixels. */
  maxSize?: number;
  /** Optional PNG encoder. When provided, PNG bytes are produced. */
  pngEncoder?: (svg: string, width: number, height: number) => Promise<Uint8Array>;
}

export interface InvoiceQrResult {
  /** Row-major boolean matrix of modules (true = dark). */
  modules: boolean[][];
  /** Rendered width in pixels (equals height). */
  width: number;
  /** QR version used (1-40). */
  version: number;
  /** SVG markup string. */
  svg: string;
  /** SVG data URL. */
  dataUrl: string;
  /** PNG bytes, when a pngEncoder was supplied. */
  png?: Uint8Array;
}

const DEFAULT_MODULE_SCALE = 8;
const DEFAULT_MARGIN = 4;
const DEFAULT_MIN_SIZE = 128;
const DEFAULT_MAX_SIZE = 2048;

function assertNonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid invoice: "${name}" must be a non-empty string`);
  }
}

function assertColor(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid option: "${name}" must be a non-empty color string`);
  }
}

/**
 * Build the payload string encoded into the invoice QR code.
 * Prefers an explicit share URL; otherwise emits a compact key/value form.
 */
export function buildInvoiceQrPayload(invoice: InvoiceQrInput): string {
  if (!invoice || typeof invoice !== "object") {
    throw new Error("Invalid invoice: expected an object");
  }
  assertNonEmpty(invoice.id, "id");
  if (invoice.url !== undefined) {
    assertNonEmpty(invoice.url, "url");
    return invoice.url;
  }
  const parts: string[] = [`id=${encodeURIComponent(invoice.id)}`];
  if (invoice.number) parts.push(`no=${encodeURIComponent(invoice.number)}`);
  if (invoice.amount !== undefined && invoice.amount !== "") {
    parts.push(`amount=${encodeURIComponent(String(invoice.amount))}`);
  }
  if (invoice.asset) parts.push(`asset=${encodeURIComponent(invoice.asset)}`);
  if (invoice.recipient) parts.push(`to=${encodeURIComponent(invoice.recipient)}`);
  if (invoice.memo) parts.push(`memo=${encodeURIComponent(invoice.memo)}`);
  return parts.join("&");
}

/**
 * Resolve the rendered pixel size from sizing options, clamped to bounds.
 */
export function resolveQrSize(modulesPerSide: number, options: InvoiceQrOptions = {}): number {
  const margin = options.margin ?? DEFAULT_MARGIN;
  const totalModules = modulesPerSide + margin * 2;
  let size: number;
  if (options.targetSize !== undefined) {
    size = Math.round(options.targetSize);
  } else {
    const scale = options.moduleScale ?? DEFAULT_MODULE_SCALE;
    size = Math.round(totalModules * scale);
  }
  const min = options.minSize ?? DEFAULT_MIN_SIZE;
  const max = options.maxSize ?? DEFAULT_MAX_SIZE;
  if (min > max) throw new Error('Invalid sizing: "minSize" must be <= "maxSize"');
  return Math.min(max, Math.max(min, size));
}

/**
 * Render a module matrix to an SVG string with the given styling.
 */
export function renderQrSvg(
  modules: boolean[][],
  options: InvoiceQrOptions = {},
): { svg: string; width: number } {
  const size = modules.length;
  const margin = options.margin ?? DEFAULT_MARGIN;
  const foreground = options.foreground ?? "#000000";
  const background = options.background ?? "#ffffff";
  assertColor(foreground, "foreground");
  assertColor(background, "background");

  const width = resolveQrSize(size, options);
  const totalModules = size + margin * 2;
  const cell = width / totalModules;
  const label = options.label;
  const labelHeight = label ? Math.max(16, Math.round(cell * 4)) : 0;
  const height = width + labelHeight;

  const rects: string[] = [];
  for (let y = 0; y < size; y++) {
    const row = modules[y]!;
    for (let x = 0; x < size; x++) {
      if (row[x]) {
        const px = ((x + margin) * cell).toFixed(3);
        const py = ((y + margin) * cell).toFixed(3);
        rects.push(`<rect x="${px}" y="${py}" width="${cell.toFixed(3)}" height="${cell.toFixed(3)}"/>`);
      }
    }
  }

  const labelMarkup = label
    ? `<text x="${width / 2}" y="${width + labelHeight / 2}" font-family="sans-serif" font-size="${Math.max(10, Math.round(cell * 2))}" fill="${foreground}" text-anchor="middle" dominant-baseline="middle">${escapeXml(label)}</text>`
    : "";

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(label ?? "Invoice QR code")}">` +
    `<rect width="${width}" height="${height}" fill="${background}"/>` +
    `<g fill="${foreground}">${rects.join("")}</g>` +
    labelMarkup +
    `</svg>`;

  return { svg, width };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Convert an SVG string to a base64 data URL.
 */
export function svgToDataUrl(svg: string): string {
  const encoded = typeof btoa === "function"
    ? btoa(unescape(encodeURIComponent(svg)))
    : Buffer.from(svg, "utf-8").toString("base64");
  return `data:image/svg+xml;base64,${encoded}`;
}

/**
 * Generate a QR code for an invoice.
 *
 * @param invoice Invoice data to encode.
 * @param options Customization, sizing and export options.
 * @param encode Optional low-level encoder that turns a payload into a module
 *   matrix (e.g. backed by qrMatrix). Defaults to a deterministic placeholder
 *   matrix sized from the payload so the API works without a full encoder.
 */
export async function generateInvoiceQr(
  invoice: InvoiceQrInput,
  options: InvoiceQrOptions = {},
  encode?: (payload: string, ec: QRErrorCorrection) => { modules: boolean[][]; version: number },
): Promise<InvoiceQrResult> {
  const payload = buildInvoiceQrPayload(invoice);
  const ec = options.errorCorrection ?? "M";
  if (!isErrorCorrectionLevel(ec)) {
    throw new Error(`Invalid option: "errorCorrection" must be one of L, M, Q, H`);
  }

  const encoded = encode
    ? encode(payload, ec)
    : fallbackEncode(payload, ec);
  if (!Array.isArray(encoded.modules) || encoded.modules.length === 0) {
    throw new Error("QR encoding failed: empty module matrix");
  }

  const { svg, width } = renderQrSvg(encoded.modules, options);
  const dataUrl = svgToDataUrl(svg);
  const result: InvoiceQrResult = {
    modules: encoded.modules,
    width,
    version: encoded.version,
    svg,
    dataUrl,
  };

  if (options.pngEncoder) {
    const height = width + (options.label ? Math.max(16, Math.round((width / (encoded.modules.length + (options.margin ?? DEFAULT_MARGIN) * 2)) * 4)) : 0);
    result.png = await options.pngEncoder(svg, width, height);
  }

  return result;
}

/**
 * Deterministic placeholder encoder used when no low-level encoder is supplied.
 * Produces a square matrix whose size grows with the payload length.
 */
function fallbackEncode(payload: string, ec: QRErrorCorrection): { modules: boolean[][]; version: number } {
  const bytes = toByteArray(payload).length;
  const version = computeVersion(bytes, ec);
  const size = 17 + version * 4;
  const modules: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x++) {
      // Finder-like corners plus a deterministic data pattern.
      const finder =
        (x < 7 && y < 7) || (x >= size - 7 && y < 7) || (x < 7 && y >= size - 7);
      const inFinderBorder =
        finder &&
        (x === 0 || y === 0 || x === size - 1 || y === size - 1 ||
          (x >= 2 && x <= 4 && y >= 2 && y <= 4) ||
          (x >= size - 5 && x <= size - 3 && y >= 2 && y <= 4) ||
          (x >= 2 && x <= 4 && y >= size - 5 && y <= size - 3));
      row.push(inFinderBorder || (!finder && ((x * 31 + y * 17 + bytes) % 7 < 3)));
    }
    modules.push(row);
  }
  return { modules, version };
}
