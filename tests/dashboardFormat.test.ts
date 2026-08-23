import { describe, expect, it } from "vitest";
import { formatPriceImpactLine, formatStopLossMargin } from "../src/cli/dashboard.js";
import type { PriceSample } from "../src/market/types.js";

function sample(overrides: Partial<PriceSample> = {}): PriceSample {
  return {
    timestampMs: 0,
    buyPriceUsd: 1,
    sellPriceUsd: 1,
    sellIsEstimated: false,
    spread: 0.005,
    priceImpactBuyBps: 44.457776396648256,
    priceImpactSellBps: 5.5237881334204986,
    referenceSolAmount: 0.01,
    referenceTokenAmountUi: 100,
    solUsdPrice: 150,
    ...overrides,
  };
}

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

describe("formatPriceImpactLine", () => {
  it("rounds buy/sell price impact to 2 decimals instead of printing raw float precision", () => {
    // Regression: these used to print with full float precision (e.g.
    // "0.44457776396648256%") because unlike spread, they had no .toFixed().
    expect(formatPriceImpactLine(sample())).toBe(
      "Price impact: buy 0.44%  sell 0.06%  spread 0.50%",
    );
  });

  it("falls back to 0 for every field when there is no sample yet", () => {
    expect(formatPriceImpactLine(undefined)).toBe(
      "Price impact: buy 0.00%  sell 0.00%  spread 0.00%",
    );
  });
});
