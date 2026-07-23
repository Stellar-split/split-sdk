import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { Keypair } from "@stellar/stellar-sdk";
import { isValidStellarAddress, deadlineFromDays } from "../src/utils.js";
import type { CreateInvoiceParams, Recipient } from "../src/types.js";

const ADDRESS_POOL = Array.from({ length: 30 }, () => Keypair.random().publicKey());

const validAddress = () => fc.constantFrom(...ADDRESS_POOL);

const validAmount = () => fc.bigInt({ min: 1n, max: 1_000_000_000_000n });

const validDeadline = () =>
  fc.integer({ min: 1, max: 3650 }).map((d) => deadlineFromDays(d));

const validRecipient = (): fc.Arbitrary<Recipient> =>
  fc.record({ address: validAddress(), amount: validAmount() });

describe("CreateInvoiceParams (property-based)", () => {
  it("creator address is always a valid Stellar address", () => {
    fc.assert(
      fc.property(validAddress(), (creator) => {
        expect(isValidStellarAddress(creator)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("all recipient addresses are valid Stellar addresses", () => {
    fc.assert(
      fc.property(
        fc.array(validRecipient(), { minLength: 1, maxLength: 10 }),
        (recipients) => {
          for (const r of recipients) {
            expect(isValidStellarAddress(r.address)).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("all recipient amounts are positive bigint", () => {
    fc.assert(
      fc.property(
        fc.array(validRecipient(), { minLength: 1, maxLength: 10 }),
        (recipients) => {
          for (const r of recipients) {
            expect(typeof r.amount).toBe("bigint");
            expect(r.amount).toBeGreaterThan(0n);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("token address is always a valid Stellar address", () => {
    fc.assert(
      fc.property(validAddress(), (token) => {
        expect(isValidStellarAddress(token)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("deadline is always in the future", () => {
    fc.assert(
      fc.property(validDeadline(), (deadline) => {
        const now = Math.floor(Date.now() / 1000);
        expect(deadline).toBeGreaterThan(now);
      }),
      { numRuns: 500 },
    );
  });

  it("recipients array is non-empty", () => {
    fc.assert(
      fc.property(
        fc.array(validRecipient(), { minLength: 1, maxLength: 20 }),
        (recipients) => {
          expect(recipients.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("no two recipients share the same address", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({ address: validAddress(), amount: validAmount() }),
          {
            minLength: 1,
            maxLength: 10,
            comparator: (a: Recipient, b: Recipient) => a.address === b.address,
          },
        ),
        (recipients) => {
          const addresses = recipients.map((r) => r.address);
          const unique = new Set(addresses);
          expect(unique.size).toBe(addresses.length);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("total funded amount fits in bigint range", () => {
    fc.assert(
      fc.property(
        fc.array(validRecipient(), { minLength: 1, maxLength: 10 }),
        (recipients) => {
          const total = recipients.reduce((sum, r) => sum + r.amount, 0n);
          expect(typeof total).toBe("bigint");
          expect(total).toBeGreaterThan(0n);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("CreateInvoiceParams structure has required fields", () => {
    fc.assert(
      fc.property(
        validAddress(),
        fc.array(validRecipient(), { minLength: 1, maxLength: 5 }),
        validAddress(),
        validDeadline(),
        (creator, recipients, token, deadline) => {
          const params: CreateInvoiceParams = {
            creator,
            recipients,
            token,
            deadline,
          };
          expect(params).toHaveProperty("creator");
          expect(params).toHaveProperty("recipients");
          expect(params).toHaveProperty("token");
          expect(params).toHaveProperty("deadline");
          expect(params.recipients.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 500 },
    );
  });
});
