import { describe, expect, it } from "vitest";
import { checkStopLoss } from "../src/strategy/stopLoss.js";

describe("stopLoss", () => {
  it("does not trigger below the configured loss percent", () => {
    const result = checkStopLoss(0.009, 0.01, 15); // -10%
    expect(result.triggered).toBe(false);
    expect(result.lossPercent).toBeCloseTo(10, 9);
  });

  it("triggers once the executable sell price implies a loss >= threshold", () => {
    const result = checkStopLoss(0.0084, 0.01, 15); // -16%
    expect(result.triggered).toBe(true);
    expect(result.lossPercent).toBeCloseTo(16, 9);
  });

  it("triggers right at the boundary", () => {
    // Compute a price that is precisely stopLossPercent below entry, then
    // nudge a hair further so float rounding never flips this to just-under.
    const result = checkStopLoss(0.01 * (1 - 0.15) - 1e-9, 0.01, 15);
    expect(result.triggered).toBe(true);
  });

  it("is inert when there is no entry price", () => {
    const result = checkStopLoss(0.5, 0, 15);
    expect(result.triggered).toBe(false);
  });
});
