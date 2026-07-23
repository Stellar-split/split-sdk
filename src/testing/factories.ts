import type { Invoice, Payment, Recipient } from "../types.js";

const DEFAULT_CREATOR = "GBFJAELAYMIC4UMDNCQLPEFJSLGSE4RC45CZT75BWMUK4RVH4AVQ6OIJ";
const DEFAULT_PAYER = "GB3ZVLZQQO7YLZTXWZ3OUMLNRVTZKWY5WQHZPV6IDEGDNJZ65DBDOZX2";
const DEFAULT_RECIPIENT = "GC5SDV7FEXC7MCNFPIULV6MABV2NSX65BZKQFPW2ZLJIQKZ3R5HRTQW2";
const DEFAULT_TOKEN = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

const SECONDS_PER_DAY = 86_400;

export function createMockRecipient(overrides: Partial<Recipient> = {}): Recipient {
  return {
    address: DEFAULT_RECIPIENT,
    amount: 25_000_000n,
    ...overrides,
  };
}

export function createMockPayment(overrides: Partial<Payment> = {}): Payment {
  return {
    payer: DEFAULT_PAYER,
    amount: 10_000_000n,
    ...overrides,
  };
}

export function createMockInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const now = Math.floor(Date.now() / 1000);

  return {
    id: "123",
    creator: DEFAULT_CREATOR,
    recipients: [createMockRecipient()],
    token: DEFAULT_TOKEN,
    deadline: now + 30 * SECONDS_PER_DAY,
    funded: 10_000_000n,
    status: "Pending",
    payments: [createMockPayment()],
    ...overrides,
  };
}
