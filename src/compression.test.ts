import { compressMetadata, decompressMetadata } from './compression';
import { SdkError, ErrorCode } from './errors';

describe('compression.ts', () => {
  const sampleObj = { id: '123', type: 'payment', amount: 100 };

  it('should perform a successful round-trip', () => {
    const compressed = compressMetadata(sampleObj);
    const decompressed = decompressMetadata(compressed);
    expect(decompressed).toEqual(sampleObj);
  });

  it('should handle empty objects', () => {
    const empty: Record<string, unknown> = {};
    const compressed = compressMetadata(empty);
    const decompressed = decompressMetadata(compressed);
    expect(decompressed).toEqual(empty);
  });

  it('should throw SdkError if payload exceeds maxBytes', () => {
    const largeObj = { data: 'a'.repeat(1000) };
    expect(() => {
      compressMetadata(largeObj, 512);
    }).toThrow(SdkError);
    
    try {
      compressMetadata(largeObj, 512);
    } catch (e: any) {
      expect(e.code).toBe(ErrorCode.CONTRACT_REJECTED);
    }
  });

  it('should throw SdkError on invalid base64 input during decompression', () => {
    const invalidInput = '!!!not-base64!!!';
    expect(() => {
      decompressMetadata(invalidInput);
    }).toThrow(SdkError);

    try {
      decompressMetadata(invalidInput);
    } catch (e: any) {
      expect(e.code).toBe(ErrorCode.CONTRACT_REJECTED);
    }
  });

  it('should throw SdkError on invalid JSON during decompression', () => {
    // Valid base64 but invalid JSON content
    const invalidJsonBase64 = Buffer.from('{ invalid json').toString('base64url');
    expect(() => {
      decompressMetadata(invalidJsonBase64);
    }).toThrow(SdkError);
  });
});
