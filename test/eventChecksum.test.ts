import { describe, it, expect } from "vitest";
import { EventChecksumChain, verifyChain, findTamperedEvent } from "../src/eventChecksum.js";
import type { ContractEvent } from "../src/events.js";

// Helper to create a test event
function createEvent(
  invoiceId: string,
  type: "created" | "payment" | "released" | "refunded",
  ledger: number,
  timestamp: number,
  data: unknown = {}
): ContractEvent {
  return {
    type,
    invoiceId,
    data,
    ledger,
    timestamp,
  };
}

describe("EventChecksumChain", () => {
  it("initializes with genesis hash", () => {
    const chain = new EventChecksumChain();
    expect(chain.getEventCount()).toBe(0);
    expect(chain.getCurrentHash()).toBeDefined();
    expect(chain.getCurrentHash()).toHaveLength(64); // SHA256 hex is 64 chars
  });

  it("appends events and maintains chain hash", () => {
    const chain = new EventChecksumChain();
    const event1 = createEvent("inv-1", "created", 1, 100);

    const hash1 = chain.append(event1);
    expect(chain.getEventCount()).toBe(1);
    expect(hash1).toBe(chain.getCurrentHash());

    const event2 = createEvent("inv-1", "payment", 2, 101, { amount: 100 });
    const hash2 = chain.append(event2);

    expect(chain.getEventCount()).toBe(2);
    expect(hash2).toBe(chain.getCurrentHash());
    expect(hash1).not.toBe(hash2); // Different events produce different hashes
  });

  it("produces deterministic hashes for same events", () => {
    const event = createEvent("inv-1", "payment", 100, 12345, { amount: 500 });

    const chain1 = new EventChecksumChain();
    chain1.append(event);
    const hash1 = chain1.getCurrentHash();

    const chain2 = new EventChecksumChain();
    chain2.append(event);
    const hash2 = chain2.getCurrentHash();

    expect(hash1).toBe(hash2);
  });

  it("detects when event data is modified", () => {
    const event1 = createEvent("inv-1", "payment", 100, 12345, { amount: 500 });
    const event2 = createEvent("inv-1", "payment", 100, 12345, { amount: 501 }); // amount changed

    const chain1 = new EventChecksumChain();
    chain1.append(event1);
    const hash1 = chain1.getCurrentHash();

    const chain2 = new EventChecksumChain();
    chain2.append(event2);
    const hash2 = chain2.getCurrentHash();

    expect(hash1).not.toBe(hash2);
  });

  it("detects when event type is modified", () => {
    const event1 = createEvent("inv-1", "payment", 100, 12345);
    const event2 = createEvent("inv-1", "released", 100, 12345);

    const chain1 = new EventChecksumChain();
    chain1.append(event1);
    const hash1 = chain1.getCurrentHash();

    const chain2 = new EventChecksumChain();
    chain2.append(event2);
    const hash2 = chain2.getCurrentHash();

    expect(hash1).not.toBe(hash2);
  });

  it("detects when ledger sequence is modified", () => {
    const event1 = createEvent("inv-1", "payment", 100, 12345);
    const event2 = createEvent("inv-1", "payment", 101, 12345); // ledger changed

    const chain1 = new EventChecksumChain();
    chain1.append(event1);
    const hash1 = chain1.getCurrentHash();

    const chain2 = new EventChecksumChain();
    chain2.append(event2);
    const hash2 = chain2.getCurrentHash();

    expect(hash1).not.toBe(hash2);
  });

  it("detects when timestamp is modified", () => {
    const event1 = createEvent("inv-1", "payment", 100, 12345);
    const event2 = createEvent("inv-1", "payment", 100, 12346); // timestamp changed

    const chain1 = new EventChecksumChain();
    chain1.append(event1);
    const hash1 = chain1.getCurrentHash();

    const chain2 = new EventChecksumChain();
    chain2.append(event2);
    const hash2 = chain2.getCurrentHash();

    expect(hash1).not.toBe(hash2);
  });

  it("depends on previous hash (chain property)", () => {
    // Same events in different order should produce different final hashes
    const event1 = createEvent("inv-1", "payment", 100, 10000);
    const event2 = createEvent("inv-2", "payment", 101, 10001);

    // Order 1: event1 then event2
    const chain1 = new EventChecksumChain();
    chain1.append(event1);
    chain1.append(event2);
    const hash1 = chain1.getCurrentHash();

    // Order 2: event2 then event1
    const chain2 = new EventChecksumChain();
    chain2.append(event2);
    chain2.append(event1);
    const hash2 = chain2.getCurrentHash();

    expect(hash1).not.toBe(hash2);
  });

  it("handles many events", () => {
    const chain = new EventChecksumChain();
    const events: ContractEvent[] = [];

    for (let i = 0; i < 100; i++) {
      const event = createEvent(`inv-${i}`, "payment", i, 1000 + i);
      events.push(event);
      chain.append(event);
    }

    expect(chain.getEventCount()).toBe(100);
    expect(chain.getCurrentHash()).toBeDefined();
    expect(chain.getCurrentHash()).toHaveLength(64);
  });

  it("tracks event count accurately", () => {
    const chain = new EventChecksumChain();
    expect(chain.getEventCount()).toBe(0);

    chain.append(createEvent("inv-1", "created", 1, 100));
    expect(chain.getEventCount()).toBe(1);

    chain.append(createEvent("inv-1", "payment", 2, 101));
    expect(chain.getEventCount()).toBe(2);

    chain.append(createEvent("inv-1", "released", 3, 102));
    expect(chain.getEventCount()).toBe(3);
  });
});

describe("verifyChain", () => {
  it("verifies a valid chain", () => {
    const events = [
      createEvent("inv-1", "created", 1, 100),
      createEvent("inv-1", "payment", 2, 101),
      createEvent("inv-1", "released", 3, 102),
    ];

    const chain = new EventChecksumChain();
    for (const event of events) {
      chain.append(event);
    }
    const expectedHash = chain.getCurrentHash();

    const isValid = verifyChain(events, expectedHash);
    expect(isValid).toBe(true);
  });

  it("detects tampering in middle event", () => {
    const events = [
      createEvent("inv-1", "created", 1, 100),
      createEvent("inv-1", "payment", 2, 101),
      createEvent("inv-1", "released", 3, 102),
    ];

    const chain = new EventChecksumChain();
    for (const event of events) {
      chain.append(event);
    }
    const expectedHash = chain.getCurrentHash();

    // Tamper with middle event
    events[1] = createEvent("inv-1", "payment", 2, 101, { amount: 999 });

    const isValid = verifyChain(events, expectedHash);
    expect(isValid).toBe(false);
  });

  it("detects tampering in first event", () => {
    const events = [
      createEvent("inv-1", "created", 1, 100),
      createEvent("inv-1", "payment", 2, 101),
    ];

    const chain = new EventChecksumChain();
    for (const event of events) {
      chain.append(event);
    }
    const expectedHash = chain.getCurrentHash();

    // Tamper with first event
    events[0] = createEvent("inv-99", "created", 1, 100); // Changed invoice ID

    const isValid = verifyChain(events, expectedHash);
    expect(isValid).toBe(false);
  });

  it("detects tampering in last event", () => {
    const events = [
      createEvent("inv-1", "created", 1, 100),
      createEvent("inv-1", "payment", 2, 101),
    ];

    const chain = new EventChecksumChain();
    for (const event of events) {
      chain.append(event);
    }
    const expectedHash = chain.getCurrentHash();

    // Tamper with last event
    events[1] = createEvent("inv-1", "refunded", 2, 101); // Changed type

    const isValid = verifyChain(events, expectedHash);
    expect(isValid).toBe(false);
  });

  it("detects reordered events", () => {
    const event1 = createEvent("inv-1", "created", 1, 100);
    const event2 = createEvent("inv-1", "payment", 2, 101);
    const event3 = createEvent("inv-1", "released", 3, 102);
    const events = [event1, event2, event3];

    const chain = new EventChecksumChain();
    for (const event of events) {
      chain.append(event);
    }
    const expectedHash = chain.getCurrentHash();

    // Reorder events
    const reorderedEvents = [event1, event3, event2]; // Swap event2 and event3

    const isValid = verifyChain(reorderedEvents, expectedHash);
    expect(isValid).toBe(false);
  });

  it("rejects chain with extra event", () => {
    const events = [
      createEvent("inv-1", "created", 1, 100),
      createEvent("inv-1", "payment", 2, 101),
    ];

    const chain = new EventChecksumChain();
    for (const event of events) {
      chain.append(event);
    }
    const expectedHash = chain.getCurrentHash();

    // Add extra event
    events.push(createEvent("inv-1", "released", 3, 102));

    const isValid = verifyChain(events, expectedHash);
    expect(isValid).toBe(false);
  });

  it("rejects chain with missing event", () => {
    const events = [
      createEvent("inv-1", "created", 1, 100),
      createEvent("inv-1", "payment", 2, 101),
      createEvent("inv-1", "released", 3, 102),
    ];

    const chain = new EventChecksumChain();
    for (const event of events) {
      chain.append(event);
    }
    const expectedHash = chain.getCurrentHash();

    // Remove middle event
    events.splice(1, 1);

    const isValid = verifyChain(events, expectedHash);
    expect(isValid).toBe(false);
  });

  it("verifies empty chain", () => {
    const events: ContractEvent[] = [];
    const chain = new EventChecksumChain();
    const expectedHash = chain.getCurrentHash();

    const isValid = verifyChain(events, expectedHash);
    expect(isValid).toBe(true);
  });

  it("rejects wrong hash", () => {
    const events = [createEvent("inv-1", "created", 1, 100)];

    const chain = new EventChecksumChain();
    chain.append(events[0]);

    const wrongHash = "0000000000000000000000000000000000000000000000000000000000000000";
    const isValid = verifyChain(events, wrongHash);
    expect(isValid).toBe(false);
  });
});

describe("findTamperedEvent", () => {
  it("returns -1 for valid chain", () => {
    const events = [
      createEvent("inv-1", "created", 1, 100),
      createEvent("inv-1", "payment", 2, 101),
      createEvent("inv-1", "released", 3, 102),
    ];

    const result = findTamperedEvent(events, events);
    expect(result).toBe(-1);
  });

  it("identifies tampered first event", () => {
    const referenceEvents = [
      createEvent("inv-1", "created", 1, 100),
      createEvent("inv-1", "payment", 2, 101),
      createEvent("inv-1", "released", 3, 102),
    ];

    const events = [
      createEvent("inv-99", "created", 1, 100), // Tampered
      createEvent("inv-1", "payment", 2, 101),
      createEvent("inv-1", "released", 3, 102),
    ];

    const result = findTamperedEvent(events, referenceEvents);
    expect(result).toBe(0);
  });

  it("identifies tampered middle event", () => {
    const referenceEvents = [
      createEvent("inv-1", "created", 1, 100),
      createEvent("inv-1", "payment", 2, 101),
      createEvent("inv-1", "released", 3, 102),
    ];

    const events = [
      createEvent("inv-1", "created", 1, 100),
      createEvent("inv-1", "payment", 2, 999), // Tampered
      createEvent("inv-1", "released", 3, 102),
    ];

    const result = findTamperedEvent(events, referenceEvents);
    expect(result).toBe(1);
  });

  it("identifies tampered last event", () => {
    const referenceEvents = [
      createEvent("inv-1", "created", 1, 100),
      createEvent("inv-1", "payment", 2, 101),
      createEvent("inv-1", "released", 3, 102),
    ];

    const events = [
      createEvent("inv-1", "created", 1, 100),
      createEvent("inv-1", "payment", 2, 101),
      createEvent("inv-1", "refunded", 3, 102), // Tampered
    ];

    const result = findTamperedEvent(events, referenceEvents);
    expect(result).toBe(2);
  });
});

describe("Integration scenarios", () => {
  it("handles complex event streams with mixed operations", () => {
    const events = [
      createEvent("inv-1", "created", 100, 1000),
      createEvent("inv-1", "payment", 101, 1001, { amount: 100 }),
      createEvent("inv-1", "payment", 102, 1002, { amount: 50 }),
      createEvent("inv-2", "created", 103, 1003),
      createEvent("inv-2", "payment", 104, 1004, { amount: 200 }),
      createEvent("inv-1", "released", 105, 1005),
    ];

    const chain = new EventChecksumChain();
    for (const event of events) {
      chain.append(event);
    }
    const finalHash = chain.getCurrentHash();

    // Verify the full chain
    expect(verifyChain(events, finalHash)).toBe(true);

    // Modify one event in the middle
    const tamperedEvents = [...events];
    tamperedEvents[3] = createEvent("inv-99", "created", 103, 1003);

    expect(verifyChain(tamperedEvents, finalHash)).toBe(false);
  });

  it("validates independent chains separately", () => {
    const events1 = [
      createEvent("inv-1", "created", 1, 100),
      createEvent("inv-1", "payment", 2, 101),
    ];

    const events2 = [
      createEvent("inv-2", "created", 100, 1000),
      createEvent("inv-2", "released", 101, 1001),
    ];

    const chain1 = new EventChecksumChain();
    for (const event of events1) {
      chain1.append(event);
    }
    const hash1 = chain1.getCurrentHash();

    const chain2 = new EventChecksumChain();
    for (const event of events2) {
      chain2.append(event);
    }
    const hash2 = chain2.getCurrentHash();

    // Hashes should be different (different events)
    expect(hash1).not.toBe(hash2);

    // Both chains should verify independently
    expect(verifyChain(events1, hash1)).toBe(true);
    expect(verifyChain(events2, hash2)).toBe(true);

    // Swapping hashes should fail
    expect(verifyChain(events1, hash2)).toBe(false);
    expect(verifyChain(events2, hash1)).toBe(false);
  });
});
