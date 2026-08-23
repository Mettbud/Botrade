import { describe, expect, it } from "vitest";
import { resolveTrailingStopPercent } from "../src/strategy/trailingStopScale.js";
import { parseTrailingStopLevels } from "../src/config/trailingStopLevels.js";

const levels = parseTrailingStopLevels("50:18,200:25");

describe("resolveTrailingStopPercent", () => {
  it("uses the default percent below the first level", () => {
    expect(resolveTrailingStopPercent(10, levels, 12)).toBe(12);
  });

  it("uses the default percent when levels is empty (scaling disabled)", () => {
    expect(resolveTrailingStopPercent(500, [], 12)).toBe(12);
  });

  it("uses the matching level once its threshold is reached", () => {
    expect(resolveTrailingStopPercent(50, levels, 12)).toBe(18);
    expect(resolveTrailingStopPercent(120, levels, 12)).toBe(18);
  });

  it("uses the highest level whose threshold is reached", () => {
    expect(resolveTrailingStopPercent(200, levels, 12)).toBe(25);
    expect(resolveTrailingStopPercent(1000, levels, 12)).toBe(25);
  });
});
