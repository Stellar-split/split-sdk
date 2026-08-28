import { describe, it, expect, beforeEach } from "vitest";
import {
  updateTemplate,
  getTemplate,
  getTemplateHistory,
} from "../src/templateManager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a unique template ID per test to avoid cross-test state bleed. */
let _counter = 0;
function uniqueId(): string {
  return `tmpl-test-${++_counter}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// updateTemplate
// ---------------------------------------------------------------------------

describe("updateTemplate", () => {
  it("returns version 1 on first call", () => {
    const id = uniqueId();
    const v = updateTemplate(id, "content v1");
    expect(v).toBe(1);
  });

  it("increments the version number on each call", () => {
    const id = uniqueId();
    expect(updateTemplate(id, "v1")).toBe(1);
    expect(updateTemplate(id, "v2")).toBe(2);
    expect(updateTemplate(id, "v3")).toBe(3);
  });

  it("retains the previous version after an update", () => {
    const id = uniqueId();
    updateTemplate(id, "original content");
    updateTemplate(id, "updated content");

    // v1 should still be accessible
    const v1 = getTemplate(id, 1);
    expect(v1).not.toBeNull();
    expect(v1!.content).toBe("original content");
  });
});

// ---------------------------------------------------------------------------
// getTemplate
// ---------------------------------------------------------------------------

describe("getTemplate", () => {
  it("returns null for a template that does not exist", () => {
    expect(getTemplate("nonexistent-template-id")).toBeNull();
  });

  it("returns the latest version when no version argument is provided", () => {
    const id = uniqueId();
    updateTemplate(id, "first");
    updateTemplate(id, "second");
    updateTemplate(id, "third");

    const latest = getTemplate(id);
    expect(latest).not.toBeNull();
    expect(latest!.version).toBe(3);
    expect(latest!.content).toBe("third");
  });

  it("retrieves a specific version by number", () => {
    const id = uniqueId();
    updateTemplate(id, "alpha");
    updateTemplate(id, "beta");
    updateTemplate(id, "gamma");

    expect(getTemplate(id, 1)!.content).toBe("alpha");
    expect(getTemplate(id, 2)!.content).toBe("beta");
    expect(getTemplate(id, 3)!.content).toBe("gamma");
  });

  it("returns null for an out-of-range version", () => {
    const id = uniqueId();
    updateTemplate(id, "only version");

    expect(getTemplate(id, 99)).toBeNull();
  });

  it("version field on the returned object matches the requested version", () => {
    const id = uniqueId();
    updateTemplate(id, "v1 content");
    updateTemplate(id, "v2 content");

    const result = getTemplate(id, 1);
    expect(result!.version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getTemplateHistory
// ---------------------------------------------------------------------------

describe("getTemplateHistory", () => {
  it("returns an empty array for an unknown template", () => {
    expect(getTemplateHistory("no-such-template")).toEqual([]);
  });

  it("returns all versions in ascending order", () => {
    const id = uniqueId();
    updateTemplate(id, "rev1");
    updateTemplate(id, "rev2");
    updateTemplate(id, "rev3");

    const history = getTemplateHistory(id);
    expect(history).toHaveLength(3);
    expect(history[0].version).toBe(1);
    expect(history[1].version).toBe(2);
    expect(history[2].version).toBe(3);
  });

  it("each entry in the history has the correct content for its version", () => {
    const id = uniqueId();
    updateTemplate(id, "content-a");
    updateTemplate(id, "content-b");

    const history = getTemplateHistory(id);
    expect(history[0].content).toBe("content-a");
    expect(history[1].content).toBe("content-b");
  });
});
