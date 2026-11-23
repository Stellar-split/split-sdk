import { describe, it, expect } from "vitest";
import { ValidationRunner, validators, all, any, rule } from "../validationFramework.js";

describe("validation framework", () => {
  it("runs rules and tracks stats", () => {
    const r = new ValidationRunner<string>().add(validators.minLength(3), validators.pattern(/^G/));
    expect(r.validate("Gabc").valid).toBe(true);
    const bad = r.validate("ab");
    expect(bad.issues.map((i) => i.rule)).toEqual(["minLength", "pattern"]);
    expect(r.getStats()).toMatchObject({ runs: 2, failures: 1, byRule: { minLength: 1, pattern: 1 } });
  });

  it("supports custom rules and composition", () => {
    const even = rule<number>("even", (n) => n % 2 === 0 || "must be even");
    expect(all(validators.range(0, 10), even).check(4)).toBe(true);
    expect(all(validators.range(0, 10), even).check(11)).toContain("even");
    expect(any(even, validators.range(100, 200)).check(150)).toBe(true);
  });
});
