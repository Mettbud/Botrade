import { describe, expect, it } from "vitest";
import { estimateSellPriceUsd } from "../src/market/sellEstimate.js";

describe("estimateSellPriceUsd", () => {
  it("applies the last known spread to the current buy price", () => {
    // spread of 2% means sell is ~2% below buy
    expect(estimateSellPriceUsd(1.0, 0.02)).toBeCloseTo(0.98, 9);
  });

  it("returns the buy price unchanged when spread is zero", () => {
    expect(estimateSellPriceUsd(1.5, 0)).toBeCloseTo(1.5, 9);
  });

  it("tracks buy price movement proportionally", () => {
    const before = estimateSellPriceUsd(1.0, 0.05);
    const after = estimateSellPriceUsd(1.1, 0.05); // buy price up 10%
    expect((after - before) / before).toBeCloseTo(0.1, 6);
  });
});
