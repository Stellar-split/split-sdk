import { SdkError, ErrorCode } from './errors';

/**
 * Serializes an object to JSON and encodes it as a base64url string.
 * Throws SdkError if the resulting string exceeds maxBytes.
 * 
 * @param obj - The object to compress
 * @param maxBytes - Maximum allowed size in bytes (default 512)
 * @returns base64url encoded string
 */
export function compressMetadata(
  obj: Record<string, unknown>,
  maxBytes: number = 512
): string {
  try {
    const json = JSON.stringify(obj);
    const encoded = Buffer.from(json).toString('base64url');

    if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
      throw new SdkError(
        `Metadata exceeds maximum allowed size of ${maxBytes} bytes`,
        ErrorCode.CONTRACT_REJECTED
      );
    }

    return encoded;
  } catch (error) {
    if (error instanceof SdkError) throw error;
    throw new SdkError(
      `Failed to compress metadata: ${error instanceof Error ? error.message : String(error)}`,
      ErrorCode.CONTRACT_REJECTED
    );
  }
}

/**
 * Decodes a base64url string and parses it back into a JSON object.
 * Throws SdkError if the input is invalid.
 * 
 * @param encoded - The base64url encoded string
 * @returns The parsed object
 */
export function decompressMetadata(encoded: string): Record<string, unknown> {
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    return JSON.parse(decoded);
  } catch (error) {
    throw new SdkError(
      `Failed to decompress metadata: ${error instanceof Error ? error.message : String(error)}`,
      ErrorCode.CONTRACT_REJECTED
    );
  }
}
