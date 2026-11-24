import {
  validate,
  string,
  number,
  address,
  amount,
  enumOf,
  object,
  array,
  allOf,
  optional,
  registerRule,
  getValidationStats,
  resetValidationStats,
  ValidationError,
} from "../validation";

describe("SDK input validation framework", () => {
  beforeEach(() => {
    resetValidationStats();
  });

  describe("built-in validators", () => {
    it("validates strings with constraints", () => {
      const v = string({ minLength: 2, maxLength: 4 });
      expect(validate(v, "abc").ok).toBe(true);
      expect(validate(v, "a").ok).toBe(false);
      expect(validate(v, "abcde").ok).toBe(false);
      expect(validate(v, 123).ok).toBe(false);
    });

    it("validates numbers with bounds", () => {
      const v = number({ min: 0, max: 10, integer: true });
      expect(validate(v, 5).ok).toBe(true);
      expect(validate(v, 5.5).ok).toBe(false);
      expect(validate(v, -1).ok).toBe(false);
      expect(validate(v, 11).ok).toBe(false);
      expect(validate(v, "5").ok).toBe(false);
    });

    it("validates addresses", () => {
      const v = address();
      expect(validate(v, "0x1234567890abcdef1234567890abcdef12345678").ok).toBe(
        true
      );
      expect(validate(v, "0x1234").ok).toBe(false);
      expect(validate(v, "not-an-address").ok).toBe(false);
    });

    it("validates amounts", () => {
      const v = amount({ min: 0, max: 1000 });
      expect(validate(v, 100).ok).toBe(true);
      expect(validate(v, -5).ok).toBe(false);
      expect(validate(v, 5000).ok).toBe(false);
      expect(validate(v, NaN).ok).toBe(false);
    });

    it("validates enums", () => {
      const v = enumOf(["a", "b", "c"] as const);
      expect(validate(v, "a").ok).toBe(true);
      expect(validate(v, "z").ok).toBe(false);
    });
  });

  describe("composition", () => {
    it("validates objects safely", () => {
      const v = object({
        name: string({ minLength: 1 }),
        age: number({ min: 0 }),
      });
      expect(validate(v, { name: "alice", age: 30 }).ok).toBe(true);
      expect(validate(v, { name: "", age: 30 }).ok).toBe(false);
      expect(validate(v, { name: "alice" }).ok).toBe(false);
      expect(validate(v, null).ok).toBe(false);
    });

    it("validates arrays", () => {
      const v = array(number({ min: 0 }), { minItems: 1, maxItems: 3 });
      expect(validate(v, [1, 2]).ok).toBe(true);
      expect(validate(v, []).ok).toBe(false);
      expect(validate(v, [1, 2, 3, 4]).ok).toBe(false);
      expect(validate(v, [1, -1]).ok).toBe(false);
    });

    it("supports allOf composition", () => {
      const v = allOf(string({ minLength: 3 }), string({ maxLength: 5 }));
      expect(validate(v, "abcd").ok).toBe(true);
      expect(validate(v, "ab").ok).toBe(false);
      expect(validate(v, "abcdef").ok).toBe(false);
    });

    it("supports optional composition", () => {
      const v = optional(string({ minLength: 1 }));
      expect(validate(v, undefined).ok).toBe(true);
      expect(validate(v, "x").ok).toBe(true);
      expect(validate(v, "").ok).toBe(false);
    });
  });

  describe("custom rules", () => {
    it("registers and applies custom rules", () => {
      registerRule("even", (value: unknown) =>
        typeof value === "number" && value % 2 === 0
          ? null
          : "must be even"
      );
      const v = number({ rules: ["even"] });
      expect(validate(v, 4).ok).toBe(true);
      const result = validate(v, 3);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0].message).toBe("must be even");
      }
    });
  });

  describe("tracking", () => {
    it("tracks validation counts", () => {
      const v = string({ minLength: 1 });
      validate(v, "ok");
      validate(v, "");
      const stats = getValidationStats();
      expect(stats.total).toBe(2);
      expect(stats.passed).toBe(1);
      expect(stats.failed).toBe(1);
    });
  });

  describe("injection prevention", () => {
    it("rejects prototype pollution keys", () => {
      const v = object({ name: string() });
      const payload = JSON.parse('{"__proto__": {"polluted": true}}');
      const result = validate(v, payload);
      expect(result.ok).toBe(false);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("throws ValidationError on assert", () => {
      const v = string({ minLength: 1 });
      expect(() => {
        const r = validate(v, "");
        if (!r.ok) throw new ValidationError(r.errors);
      }).toThrow(ValidationError);
    });
  });
});
