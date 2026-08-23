import { describe, expect, it } from "vitest";
import { parseTrailingStopLevels } from "../src/config/trailingStopLevels.js";

describe("parseTrailingStopLevels", () => {
  it("returns an empty list for an empty string (scaling disabled)", () => {
    expect(parseTrailingStopLevels("")).toEqual([]);
    expect(parseTrailingStopLevels("  ")).toEqual([]);
  });

  it("parses levels in ascending gain order regardless of input order", () => {
    const levels = parseTrailingStopLevels("200:25,50:18");
    expect(levels).toEqual([
      { gainPercent: 50, trailingStopPercent: 18 },
      { gainPercent: 200, trailingStopPercent: 25 },
    ]);
  });

  it("throws on a malformed entry", () => {
    expect(() => parseTrailingStopLevels("fifty:18")).toThrow(/Invalid TRAILING_STOP_LEVELS/);
  });

  it("throws on a non-positive trailingStopPercent", () => {
    expect(() => parseTrailingStopLevels("50:0")).toThrow(/must be > 0/);
  });
});
