import { describe, expect, it } from "vitest";
import { buildPathQuery } from "../src/pathQueryBuilder.js";
import { InvalidPathQueryError } from "../src/errors.js";

describe("buildPathQuery", () => {
  it("includes source_asset_type when provided", () => {
    expect(buildPathQuery({ sourceAssetType: "native", limit: 10 })).toBe(
      "source_asset_type=native&limit=10",
    );
  });

  it("omits source_asset_type when not provided", () => {
    expect(buildPathQuery({ limit: 10 })).toBe("limit=10");
  });

  it("throws for an invalid source asset type", () => {
    expect(() =>
      buildPathQuery({ sourceAssetType: "unsupported" as never }),
    ).toThrow(InvalidPathQueryError);
  });
});
