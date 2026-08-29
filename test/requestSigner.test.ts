import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { signRequest } from "../src/requestSigner.js";

describe("signRequest", () => {
  it("signs using the built-in registry algorithms", () => {
    const keypair = Keypair.random();
    const signature = signRequest("ed25519", "payload", keypair);

    expect(typeof signature).toBe("string");
    expect(signature.length).toBeGreaterThan(0);
  });
});
