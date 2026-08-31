import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";

describe("public API surface (issues #586, #588, #589)", () => {
  it("exports the signing vault adapters", () => {
    expect(typeof sdk.KeypairSigner).toBe("function");
    expect(typeof sdk.InvalidKeypairError).toBe("function");
    expect(typeof sdk.isInvalidKeypairError).toBe("function");
    expect(typeof sdk.EncryptedFileSigner).toBe("function");
    expect(typeof sdk.CloudKmsSigner).toBe("function");
    expect(typeof sdk.encryptSigningKeyToPem).toBe("function");
    expect(typeof sdk.writeEncryptedSigningKeyFile).toBe("function");
  });

  it("exports the footprint optimizer utilities", () => {
    expect(typeof sdk.optimizeFootprint).toBe("function");
    expect(typeof sdk.footprintDiff).toBe("function");
    expect(typeof sdk.submitTransaction).toBe("function");
  });
});
