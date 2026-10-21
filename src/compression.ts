/**
 * Compression utilities for the StellarSplit SDK.
 *
 * Supports gzip, deflate, and brotli compression with automatic
 * content-negotiation and transparent decompression.
 */

import zlib from "node:zlib";
import { promisify } from "node:util";
import type { RequestInterceptor, ResponseInterceptor } from "./interceptors.js";
import { SdkError } from "./errors.js";

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);
const deflateAsync = promisify(zlib.deflate);
const inflateAsync = promisify(zlib.inflate);
const brotliCompressAsync = promisify(zlib.brotliCompress);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);

export type CompressionAlgorithm = "gzip" | "deflate" | "brotli" | "br" | "identity";
export type CompressionLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface CompressionOptions {
  algorithm?: CompressionAlgorithm;
  level?: CompressionLevel;
  /** Minimum payload size in bytes before compression is applied. Default: 1024 */
  minSizeBytes?: number;
}

export interface CompressionMetrics {
  originalSize: number;
  compressedSize: number;
  ratio: number;
  algorithm: CompressionAlgorithm;
  durationMs: number;
}

export interface CompressedPayload {
  data: Buffer;
  encoding: CompressionAlgorithm;
  metrics: CompressionMetrics;
}

export function isCompressedPayload(data: unknown): data is CompressedPayload {
  return (
    typeof data === "object" &&
    data !== null &&
    "data" in data &&
    "encoding" in data &&
    Buffer.isBuffer((data as CompressedPayload).data)
  );
}

/**
 * Parse Accept-Encoding header and return the best supported algorithm.
 * Priority: brotli > gzip > deflate > identity
 */
export function detectCompressionSupport(
  acceptEncoding: string
): "brotli" | "gzip" | "deflate" | "identity" {
  if (!acceptEncoding) return "identity";

  const entries = acceptEncoding
    .split(",")
    .map((entry) => {
      const [enc, qPart] = entry.trim().split(";");
      const q = qPart ? parseFloat(qPart.trim().replace("q=", "")) : 1.0;
      return { enc: enc.trim().toLowerCase(), q };
    })
    .filter((e) => e.q > 0);

  // Assign tie-break priority: brotli=3, gzip=2, deflate=1
  const priority: Record<string, number> = { br: 3, brotli: 3, gzip: 2, deflate: 1 };

  let best: { enc: string; q: number; p: number } | null = null;
  for (const e of entries) {
    const p = priority[e.enc] ?? 0;
    if (!best || e.q > best.q || (e.q === best.q && p > best.p)) {
      best = { enc: e.enc, q: e.q, p };
    }
  }

  if (!best) return "identity";
  if (best.enc === "br" || best.enc === "brotli") return "brotli";
  if (best.enc === "gzip") return "gzip";
  if (best.enc === "deflate") return "deflate";
  return "identity";
}

/**
 * Compress data using the specified algorithm.
 */
export async function compress(
  data: Buffer | string,
  options: CompressionOptions = {}
): Promise<CompressedPayload> {
  const { algorithm = "gzip", level = 6, minSizeBytes = 1024 } = options;
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");

  if (input.byteLength < minSizeBytes) {
    return {
      data: input,
      encoding: "identity",
      metrics: {
        originalSize: input.byteLength,
        compressedSize: input.byteLength,
        ratio: 1,
        algorithm: "identity",
        durationMs: 0,
      },
    };
  }

  const start = Date.now();
  let compressed: Buffer;
  const algo = algorithm === "br" ? "brotli" : algorithm;

  switch (algo) {
    case "brotli":
      compressed = await brotliCompressAsync(input, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: level },
      });
      break;
    case "deflate":
      compressed = await deflateAsync(input, { level });
      break;
    case "gzip":
    default:
      compressed = await gzipAsync(input, { level });
      break;
  }

  const durationMs = Date.now() - start;
  return {
    data: compressed,
    encoding: algo as CompressionAlgorithm,
    metrics: {
      originalSize: input.byteLength,
      compressedSize: compressed.byteLength,
      ratio: compressed.byteLength / input.byteLength,
      algorithm: algo as CompressionAlgorithm,
      durationMs,
    },
  };
}

/**
 * Decompress data using the specified encoding.
 */
export async function decompress(
  data: Buffer,
  encoding: string
): Promise<Buffer> {
  const enc = encoding.toLowerCase().trim();
  switch (enc) {
    case "br":
    case "brotli":
      return brotliDecompressAsync(data);
    case "deflate":
      return inflateAsync(data);
    case "gzip":
      return gunzipAsync(data);
    default:
      return data;
  }
}

/**
 * Transparently decompress a response payload and parse as JSON.
 */
export async function transparentDecompress<T>(
  data: Buffer | string,
  encoding: string
): Promise<T> {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as string, "binary");
  const decompressed = await decompress(buf, encoding);
  return JSON.parse(decompressed.toString("utf8")) as T;
}

/**
 * Create a request interceptor that compresses outgoing request bodies.
 */
export function createCompressionRequestInterceptor(
  options: CompressionOptions = {}
): RequestInterceptor {
  return async (request) => {
    if (!request.body) return request;
    const payload = compress(JSON.stringify(request.body), options);
    const result = await payload;
    if (result.encoding === "identity") return request;
    return {
      ...request,
      body: result.data,
      headers: {
        ...request.headers,
        "Content-Encoding": result.encoding,
        "Content-Type": "application/octet-stream",
      },
    };
  };
}

/**
 * Create a response interceptor that decompresses incoming response bodies.
 */
export function createCompressionResponseInterceptor(): ResponseInterceptor {
  return async (response) => {
    const encoding = (response.headers?.["content-encoding"] as string) ?? "";
    if (!encoding || encoding === "identity") return response;
    try {
      const body = await transparentDecompress(response.body as Buffer, encoding);
      return { ...response, body };
    } catch {
      return response;
    }
  };
}

/**
 * Serialize an object to JSON and encode as base64url (no padding).
 *
 * Throws {@link SdkError} with code `CONTRACT_REJECTED` if the resulting
 * base64 string exceeds `maxBytes` (default 512 bytes).
 *
 * @param obj - The object to compress.
 * @param maxBytes - Maximum allowed encoded size in bytes (default 512).
 * @returns The base64url-encoded JSON string (no padding).
 * @throws {SdkError} with code `CONTRACT_REJECTED` if the encoded string
 *   exceeds `maxBytes`.
 */
export function compressMetadata(
  obj: Record<string, unknown>,
  maxBytes: number = 512,
): string {
  const json = JSON.stringify(obj);
  const encoded = Buffer.from(json).toString("base64url");

  if (encoded.length > maxBytes) {
    throw new SdkError(
      `Encoded metadata exceeds ${maxBytes} bytes (got ${encoded.length})`,
      "CONTRACT_REJECTED",
    );
  }

  return encoded;
}

/**
 * Decode a base64url-encoded string and parse as JSON.
 *
 * Throws {@link SdkError} with code `CONTRACT_REJECTED` if the input is
 * not valid base64url or does not contain valid JSON.
 *
 * @param encoded - The base64url-encoded string to decode.
 * @returns The parsed object.
 * @throws {SdkError} with code `CONTRACT_REJECTED` if decoding or parsing
 *   fails.
 */
export function decompressMetadata(encoded: string): Record<string, unknown> {
  let json: string;
  try {
    json = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new SdkError(
      "Invalid base64url input",
      "CONTRACT_REJECTED",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SdkError(
      "Invalid JSON in decoded metadata",
      "CONTRACT_REJECTED",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SdkError(
      "Decoded metadata is not a plain object",
      "CONTRACT_REJECTED",
    );
  }

  return parsed as Record<string, unknown>;
}
