const DEFAULT_CREATOR = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const DEFAULT_PAYER = "GCFX3XM4DW6W46YMETX2NV7NZA3V4FS3RJV7G6J4HZ7LTQH5Y4TTWF3T";
const DEFAULT_RECIPIENT = "GDDGZXEOB43ZIYH3FQ6LSQPYBS3K5ZOVBSWJQW3NMOK6PW6JQ5TPK5Y7";
const DEFAULT_TOKEN = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const SECONDS_PER_DAY = 86_400;

export function createMockRecipient(overrides = {}) {
  return {
    address: DEFAULT_RECIPIENT,
    amount: 25_000_000n,
    ...overrides,
  };
}

export function createMockPayment(overrides = {}) {
  return {
    payer: DEFAULT_PAYER,
    amount: 10_000_000n,
    ...overrides,
  };
}

export function createMockInvoice(overrides = {}) {
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
