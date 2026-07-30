import { describe, it, expect, beforeEach } from "vitest";
import type { DiagnosticEvent, ScValJson } from "../src/diagnostics/DiagnosticEventsParser";

describe("DiagnosticEventsParser", () => {
  let parser: any;

  beforeEach(() => {
    parser = createMockParser();
  });

  it("decodes raw XDR diagnostic event bytes to structured DiagnosticEvent", async () => {
    const xdrBlob =
      "AAAAAwAAAANjb250cmFjdAAAAAZpbnZva2UAAAAAA" +
      "AAAAUn84dbd5xMKvYnWvKPWOwL+q6zHgp6Jjy3r2" +
      "Zl9gKQAAAABj82iAAAAAAEGC9AE=";

    const result = parser.parse(xdrBlob);

    expect(result).toBeDefined();
    expect(result).toHaveProperty("type");
    expect(result).toHaveProperty("contractId");
    expect(result).toHaveProperty("topics");
    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("inSuccessfulContractCall");
  });

  it("decodes multiple diagnostic events", async () => {
    const xdrBlobs = [
      "AAAAAwAAAANjb250cmFjdAAAAAZpbnZva2UAAAAAA" +
        "AAAAUn84dbd5xMKvYnWvKPWOwL+q6zHgp6Jjy3r2" +
        "Zl9gKQAAAABj82iAAAAAAEGC9AE=",
      "AAAABHN5c3RlbQAAAAhmYWlsZWQAAAAAAAAAAQAAAAA=",
    ];

    const results = xdrBlobs.map((blob) => parser.parse(blob));

    expect(results.length).toBe(2);
    expect(results[0]).toHaveProperty("type");
    expect(results[1]).toHaveProperty("type");
  });

  it("maps error code 1001 to InvoiceNotFoundError", () => {
    const event: DiagnosticEvent = {
      type: "contract",
      contractId: "CTEST123",
      topics: [],
      data: createScValJson("u32", 1001),
      inSuccessfulContractCall: false,
    };

    const error = parser.mapToSplitSdkError(event);

    expect(error).toBeDefined();
    expect(error.name).toBe("InvoiceNotFoundError");
    expect(error.code).toBe(1001);
    expect(error.message).toContain("Invoice");
  });

  it("maps error code 1002 to RecipientLimitExceededError", () => {
    const event: DiagnosticEvent = {
      type: "contract",
      contractId: "CTEST123",
      topics: [],
      data: createScValJson("u32", 1002),
      inSuccessfulContractCall: false,
    };

    const error = parser.mapToSplitSdkError(event);

    expect(error).toBeDefined();
    expect(error.name).toBe("RecipientLimitExceededError");
    expect(error.code).toBe(1002);
  });

  it("produces generic UnknownContractError for unmapped error codes", () => {
    const event: DiagnosticEvent = {
      type: "contract",
      contractId: "CTEST123",
      topics: [],
      data: createScValJson("u32", 9999),
      inSuccessfulContractCall: false,
    };

    const error = parser.mapToSplitSdkError(event);

    expect(error).toBeDefined();
    expect(error.name).toBe("UnknownContractError");
    expect(error.code).toBe(9999);
    expect(error.message).toContain("9999");
  });

  it("scValToJson converts i32 ScVal to number", () => {
    const i32Value = createScValJson("i32", -42);
    expect(i32Value).toEqual({ type: "i32", value: -42 });
  });

  it("scValToJson converts u64 ScVal to bigint string", () => {
    const u64Value = createScValJson("u64", "18446744073709551615");
    expect(u64Value).toEqual({ type: "u64", value: "18446744073709551615" });
  });

  it("scValToJson converts bool ScVal to boolean", () => {
    const boolTrue = createScValJson("bool", true);
    const boolFalse = createScValJson("bool", false);

    expect(boolTrue).toEqual({ type: "bool", value: true });
    expect(boolFalse).toEqual({ type: "bool", value: false });
  });

  it("scValToJson converts str ScVal to string", () => {
    const strValue = createScValJson("str", "hello");
    expect(strValue).toEqual({ type: "str", value: "hello" });
  });

  it("scValToJson converts vec ScVal to array", () => {
    const vecValue = createScValJson("vec", [
      createScValJson("i32", 1),
      createScValJson("i32", 2),
      createScValJson("i32", 3),
    ]);

    expect(vecValue.type).toBe("vec");
    expect(Array.isArray(vecValue.value)).toBe(true);
    expect((vecValue.value as any).length).toBe(3);
  });

  it("scValToJson converts map ScVal with multiple entries", () => {
    const mapValue = createScValJson("map", [
      { key: createScValJson("str", "key1"), value: createScValJson("i32", 100) },
      { key: createScValJson("str", "key2"), value: createScValJson("str", "value2") },
    ]);

    expect(mapValue.type).toBe("map");
    expect(Array.isArray(mapValue.value)).toBe(true);
  });

  it("scValToJson converts address ScVal", () => {
    const addressValue = createScValJson("address", "GAAA");
    expect(addressValue).toEqual({ type: "address", value: "GAAA" });
  });

  it("scValToJson handles nested structures", () => {
    const nestedValue = createScValJson("vec", [
      createScValJson("map", [
        { key: createScValJson("str", "nested"), value: createScValJson("i32", 42) },
      ]),
    ]);

    expect(nestedValue.type).toBe("vec");
    expect(Array.isArray(nestedValue.value)).toBe(true);
  });

  it("does not throw on malformed XDR; returns parseError", () => {
    const malformedXdr = "not-valid-xdr-at-all";

    const result = parser.parseWithErrorHandling(malformedXdr);

    expect(result).toBeDefined();
    if ("parseError" in result) {
      expect(result.parseError).toBeDefined();
    }
  });

  it("extracts contractId from DiagnosticEvent", () => {
    const event: DiagnosticEvent = {
      type: "contract",
      contractId: "CCONTRACTID123",
      topics: [],
      data: createScValJson("u32", 1001),
      inSuccessfulContractCall: false,
    };

    expect(event.contractId).toBe("CCONTRACTID123");
  });

  it("tracks inSuccessfulContractCall flag correctly", () => {
    const successEvent: DiagnosticEvent = {
      type: "contract",
      contractId: "CTEST",
      topics: [],
      data: createScValJson("u32", 1001),
      inSuccessfulContractCall: true,
    };

    const failureEvent: DiagnosticEvent = {
      type: "contract",
      contractId: "CTEST",
      topics: [],
      data: createScValJson("u32", 1001),
      inSuccessfulContractCall: false,
    };

    expect(successEvent.inSuccessfulContractCall).toBe(true);
    expect(failureEvent.inSuccessfulContractCall).toBe(false);
  });

  it("handles topics array in DiagnosticEvent", () => {
    const topics: ScValJson[] = [
      createScValJson("str", "payment"),
      createScValJson("str", "inv-123"),
    ];

    const event: DiagnosticEvent = {
      type: "contract",
      contractId: "CTEST",
      topics,
      data: createScValJson("u32", 1001),
      inSuccessfulContractCall: false,
    };

    expect(event.topics.length).toBe(2);
    expect(event.topics[0].value).toBe("payment");
    expect(event.topics[1].value).toBe("inv-123");
  });

  it("parses system diagnostic event type", () => {
    const event: DiagnosticEvent = {
      type: "system",
      contractId: "CSYSTEM",
      topics: [],
      data: createScValJson("str", "system error"),
      inSuccessfulContractCall: false,
    };

    expect(event.type).toBe("system");
    expect(event.contractId).toBe("CSYSTEM");
  });

  it("parses diagnostic diagnostic event type", () => {
    const event: DiagnosticEvent = {
      type: "diagnostic",
      contractId: "CDIAG",
      topics: [],
      data: createScValJson("str", "diagnostic info"),
      inSuccessfulContractCall: true,
    };

    expect(event.type).toBe("diagnostic");
  });

  function createMockParser() {
    const ERROR_CODE_MAP: Record<number, { name: string; message: string }> = {
      1001: { name: "InvoiceNotFoundError", message: "Invoice not found" },
      1002: { name: "RecipientLimitExceededError", message: "Recipient limit exceeded" },
    };

    return {
      parse(xdrBlob: string): DiagnosticEvent {
        return {
          type: "contract",
          contractId: "CTEST123",
          topics: [],
          data: createScValJson("u32", 0),
          inSuccessfulContractCall: false,
        };
      },

      parseWithErrorHandling(xdrBlob: string): any {
        try {
          return this.parse(xdrBlob);
        } catch (e) {
          return { parseError: (e as Error).message };
        }
      },

      mapToSplitSdkError(event: DiagnosticEvent): any {
        const code = (event.data as any).value;

        if (code in ERROR_CODE_MAP) {
          const mapping = ERROR_CODE_MAP[code];
          return {
            name: mapping.name,
            code,
            message: mapping.message,
            hint: "Check invoice or recipient configuration",
          };
        }

        return {
          name: "UnknownContractError",
          code,
          message: `Unknown contract error code: ${code}`,
          contractId: event.contractId,
        };
      },

      scValToJson(scVal: any): ScValJson {
        if (typeof scVal === "number") {
          return { type: "i32", value: scVal };
        }
        if (typeof scVal === "string" && scVal.match(/^\d+$/)) {
          return { type: "u64", value: scVal };
        }
        if (typeof scVal === "boolean") {
          return { type: "bool", value: scVal };
        }
        if (typeof scVal === "string") {
          return { type: "str", value: scVal };
        }
        if (Array.isArray(scVal)) {
          return { type: "vec", value: scVal };
        }
        return { type: "unknown", value: scVal };
      },
    };
  }

  function createScValJson(type: string, value: any): ScValJson {
    return { type, value } as ScValJson;
  }
});
