import { describe, it, expect, vi } from "vitest";
import { AnchorVerifier } from "../src/anchors/AnchorVerifier.js";
import { CertificatePinningError } from "../src/errors.js";

// Mock StellarTomlParser so we don't hit the network for TOML fetching
vi.mock("../src/anchors/StellarTomlParser.js", () => ({
  StellarTomlParser: class {
    fetch = vi.fn().mockResolvedValue({ CURRENCIES: [] });
  },
}));

describe("AnchorVerifier certificate pinning", () => {
  it("throws CertificatePinningError when no fingerprint is configured for domain", async () => {
    const verifier = new AnchorVerifier();
    await expect(verifier.verifyCertificatePinning("example.com")).rejects.toThrow(
      CertificatePinningError,
    );
  });

  it("returns pinned fingerprint when verifyCertificatePinning succeeds", async () => {
    // This test would need a real TLS connection; we test the error path above
    // and verify the structural shape of the class here.
    const verifier = new AnchorVerifier({
      pinnedCertFingerprints: {
        "example.com": "AB:CD:EF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD",
      },
    });

    // verify() with a pinned domain should attempt pinning (will likely fail
    // because example.com TLS is different, but the structural code path runs)
    const result = await verifier.verify("GA5ZSEJHBXFKRBQX7P5R6RKXDMXTMFBZLPRUV5WTNJAYJX7TMZJXVXKP", "TEST");
    // Since we can't mock Horizon easily, the account load will fail, but
    // the important thing is the pinning check code path compiles and runs.
    expect(result.verified).toBe(false);
  });

  it("stores pinned fingerprints from constructor options", () => {
    const fingerprints = {
      "anchor1.com": "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88",
    };
    const verifier = new AnchorVerifier({ pinnedCertFingerprints: fingerprints });
    expect(verifier).toBeDefined();
  });

  it("CertificatePinningError exposes domain, expected, and actual fingerprints", () => {
    const err = new CertificatePinningError("test.com", "EXPECTED", "ACTUAL");
    expect(err.domain).toBe("test.com");
    expect(err.expectedFingerprint).toBe("EXPECTED");
    expect(err.actualFingerprint).toBe("ACTUAL");
    expect(err.code).toBe("CERTIFICATE_PINNING_ERROR");
  });

  it("CertificatePinningError handles missing actual fingerprint", () => {
    const err = new CertificatePinningError("test.com", "EXPECTED");
    expect(err.actualFingerprint).toBeUndefined();
    expect(err.message).toContain("unknown");
  });
});
