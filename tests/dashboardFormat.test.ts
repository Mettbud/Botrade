import { describe, expect, it } from "vitest";
import { formatStopLossMargin } from "../src/cli/dashboard.js";

describe("formatStopLossMargin", () => {
  it("labels a positive lossPercent as an actual loss", () => {
    expect(formatStopLossMargin(5.36)).toBe("5.36% loss");
  });

  it("labels a negative lossPercent (position in profit) as no loss, not '-X% loss'", () => {
    expect(formatStopLossMargin(-5.36)).toBe("no loss (+5.36% above entry)");
  });

  it("treats exactly 0 as no loss", () => {
    expect(formatStopLossMargin(0)).toBe("no loss (+0.00% above entry)");
  });
});
