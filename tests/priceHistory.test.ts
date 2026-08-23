import { describe, expect, it } from "vitest";
import { PriceHistoryBuffer } from "../src/market/history.js";
import type { PriceSample } from "../src/market/types.js";

function sample(timestampMs: number, sellPriceUsd: number): PriceSample {
  return {
    timestampMs,
    buyPriceUsd: sellPriceUsd * 1.02,
    sellPriceUsd,
    sellIsEstimated: false,
    spread: 0.02,
    priceImpactBuyBps: 10,
    priceImpactSellBps: 10,
    referenceSolAmount: 0.01,
    referenceTokenAmountUi: 100,
    solUsdPrice: 150,
  };
}

describe("PriceHistoryBuffer", () => {
  it("computes % change over a window from the oldest in-window sample", () => {
    const buf = new PriceHistoryBuffer();
    const t0 = 1_000_000;
    buf.push(sample(t0, 1.0));
    buf.push(sample(t0 + 5_000, 1.05));
    buf.push(sample(t0 + 10_000, 1.1)); // +10% over the 10s window from t0

    expect(buf.changePercent(10_000)).toBeCloseTo(10, 6);
  });

  it("detects a negative change (dump)", () => {
    const buf = new PriceHistoryBuffer();
    const t0 = 2_000_000;
    buf.push(sample(t0, 1.0));
    buf.push(sample(t0 + 10_000, 0.9)); // -10%

    expect(buf.changePercent(30_000)).toBeCloseTo(-10, 6);
  });

  it("returns undefined when there is no sample old enough for the window", () => {
    const buf = new PriceHistoryBuffer();
    buf.push(sample(3_000_000, 1.0));
    expect(buf.changePercent(60_000)).toBeUndefined();
  });

  it("maxPrice finds the highest sellPriceUsd within the window", () => {
    const buf = new PriceHistoryBuffer();
    const t0 = 4_000_000;
    buf.push(sample(t0, 1.0));
    buf.push(sample(t0 + 5_000, 2.0)); // the peak
    buf.push(sample(t0 + 10_000, 0.5)); // crashed

    expect(buf.maxPrice(10_000)).toBeCloseTo(2.0, 9);
  });

  it("maxPrice ignores samples outside the window", () => {
    const buf = new PriceHistoryBuffer();
    const t0 = 5_000_000;
    buf.push(sample(t0, 5.0)); // old high, outside the 10s window below
    buf.push(sample(t0 + 20_000, 1.0));

    expect(buf.maxPrice(10_000)).toBeCloseTo(1.0, 9);
  });

  it("maxRunUpPercent measures an earlier low followed by a later high", () => {
    const buf = new PriceHistoryBuffer();
    const t0 = 6_000_000;
    buf.push(sample(t0, 1.0));
    buf.push(sample(t0 + 5_000, 1.1)); // +10% pump
    buf.push(sample(t0 + 10_000, 0.9)); // later crash does not erase the pump

    expect(buf.maxRunUpPercent(10_000)).toBeCloseTo(10, 9);
  });

  it("maxRunUpPercent does not mistake a high followed by a crash for a pump", () => {
    const buf = new PriceHistoryBuffer();
    const t0 = 7_000_000;
    buf.push(sample(t0, 1.1));
    buf.push(sample(t0 + 5_000, 1.0));
    buf.push(sample(t0 + 10_000, 0.9));

    expect(buf.maxRunUpPercent(10_000)).toBe(0);
  });

  it("maxRunUpPercent ignores a pump outside its lookback", () => {
    const buf = new PriceHistoryBuffer();
    const t0 = 8_000_000;
    buf.push(sample(t0, 1.0));
    buf.push(sample(t0 + 5_000, 1.2));
    buf.push(sample(t0 + 30_000, 1.1));
    buf.push(sample(t0 + 35_000, 1.11));

    expect(buf.maxRunUpPercent(10_000)).toBeCloseTo(
      (1.11 / 1.1 - 1) * 100,
      9,
    );
  });

  it("realizedVolatilityPercent aggregates consecutive price moves", () => {
    const buf = new PriceHistoryBuffer();
    const t0 = 9_000_000;
    buf.push(sample(t0, 100));
    buf.push(sample(t0 + 1_000, 101));
    buf.push(sample(t0 + 2_000, 100));

    const expected = Math.sqrt(
      (Math.log(101 / 100) * 100) ** 2 +
        (Math.log(100 / 101) * 100) ** 2,
    );
    expect(buf.realizedVolatilityPercent(10_000)).toBeCloseTo(expected, 9);
  });

  it("realizedVolatilityPercent is zero for a flat market", () => {
    const buf = new PriceHistoryBuffer();
    const t0 = 10_000_000;
    buf.push(sample(t0, 1));
    buf.push(sample(t0 + 1_000, 1));

    expect(buf.realizedVolatilityPercent(10_000)).toBe(0);
  });

  it("evicts samples older than the retention window", () => {
    const buf = new PriceHistoryBuffer();
    buf.push(sample(0, 1.0));
    buf.push(sample(11 * 60_000, 1.5)); // 11 minutes later, beyond MAX_AGE
    // The old sample should have been evicted, so a huge window still finds nothing that old.
    expect(buf.changePercent(20 * 60_000)).toBeUndefined();
  });
});
