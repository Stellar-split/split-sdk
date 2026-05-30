const textEncoder = new TextEncoder();

function normalizeHex(hex: string): string {
  return hex.toLowerCase();
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = normalizeHex(hex);
  if (normalized.length % 2 !== 0) {
    throw new Error("Invalid hex string");
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeCompare(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    diff |= ai ^ bi;
  }

  return diff === 0;
}

async function computeHmacSha256(secret: string, message: string): Promise<Uint8Array> {
  if (typeof globalThis.crypto !== "undefined" && "subtle" in globalThis.crypto) {
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      textEncoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signature = await globalThis.crypto.subtle.sign(
      "HMAC",
      key,
      textEncoder.encode(message)
    );

    return new Uint8Array(signature);
  }

  const crypto = await import("crypto");
  const digest = crypto.createHmac("sha256", secret).update(message).digest();
  return new Uint8Array(digest);
}

export async function validateWebhookSignature(
  payload: unknown,
  signature: string,
  secret: string
): Promise<boolean> {
  const payloadJson = JSON.stringify(payload);
  if (payloadJson === undefined) {
    return false;
  }

  let expectedBytes: Uint8Array;
  try {
    expectedBytes = await computeHmacSha256(secret, payloadJson);
  } catch {
    return false;
  }

  let providedBytes: Uint8Array;
  try {
    providedBytes = hexToBytes(signature);
  } catch {
    return false;
  }

  return constantTimeCompare(expectedBytes, providedBytes);
}
