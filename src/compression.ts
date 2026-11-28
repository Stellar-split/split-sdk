/**
 * Compression utilities for the StellarSplit SDK.
 *
 * Supports gzip, deflate, and brotli compression with automatic
 * content-negotiation and transparent decompression.
 */

import zlib from "node:zlib";
import { promisify } from "node:util";
import type { RequestInterceptor, ResponseInterceptor } from "./interceptors.js";
import { SdkError, SdkErrorCode } from "./errors.js";

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

/** Client-level configuration for the request/response compression interceptors. */
export interface CompressionConfig extends CompressionOptions {
  /** Whether compression interceptors are installed. Defaults to `false`. */
  enabled?: boolean;
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
      const [enc = "", qPart] = entry.trim().split(";");
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

/** A compressed payload paired with the algorithm used to produce it. */
export interface CompressedData {
  body: Buffer;
  algorithm: CompressionAlgorithm;
}

/** Compress a string/buffer payload with the given algorithm, unconditionally. */
export async function compressPayload(
  data: Buffer | string,
  algorithm: CompressionAlgorithm = "gzip"
): Promise<CompressedData> {
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const algo = algorithm === "br" ? "brotli" : algorithm;
  let body: Buffer;
  switch (algo) {
    case "brotli":
      body = await brotliCompressAsync(input);
      break;
    case "deflate":
      body = await deflateAsync(input);
      break;
    case "identity":
      body = input;
      break;
    case "gzip":
    default:
      body = await gzipAsync(input);
      break;
  }
  return { body, algorithm: algo as CompressionAlgorithm };
}

/** Decompress a payload previously produced by {@link compressPayload}. */
export async function decompressPayload(payload: CompressedData): Promise<Buffer> {
  return decompress(payload.body, payload.algorithm);
}

/**
 * Create a request interceptor that compresses outgoing RPC params whose
 * serialized size exceeds `minSizeBytes`, leaving small params untouched.
 */
export function createCompressionRequestInterceptor(
  options: CompressionConfig = {}
): RequestInterceptor {
  const { enabled = false, algorithm = "gzip", minSizeBytes = 1024 } = options;
  return async (request) => {
    if (!enabled || !request.params?.length) return request;

    const params = await Promise.all(
      request.params.map(async (param) => {
        const serialized = typeof param === "string" ? param : JSON.stringify(param);
        if (Buffer.byteLength(serialized) < minSizeBytes) return param;
        const compressed = await compressPayload(serialized, algorithm);
        return {
          compressed: true,
          algorithm: compressed.algorithm,
          data: compressed.body.toString("base64"),
        };
      })
    );

    return { ...request, params };
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
      SdkErrorCode.CONTRACT_REJECTED,
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
      SdkErrorCode.CONTRACT_REJECTED,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SdkError(
      "Invalid JSON in decoded metadata",
      SdkErrorCode.CONTRACT_REJECTED,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SdkError(
      "Decoded metadata is not a plain object",
      SdkErrorCode.CONTRACT_REJECTED,
    );
  }

  return parsed as Record<string, unknown>;
}
