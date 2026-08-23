import { describe, expect, it } from "vitest";
import { resolveAutoBuySizeUsd } from "../src/trading/autoBuySize.js";

describe("resolveAutoBuySizeUsd", () => {
  it("LIVE always uses maxTradeUsd, regardless of balance or percent", () => {
    expect(resolveAutoBuySizeUsd("LIVE", 100, 1, 50)).toBe(1);
    expect(resolveAutoBuySizeUsd("LIVE", 100000, 1, 100)).toBe(1);
  });

  it("PAPER sizes as a percent of the current paper balance", () => {
    expect(resolveAutoBuySizeUsd("PAPER", 100, 1, 5)).toBeCloseTo(5, 9);
    expect(resolveAutoBuySizeUsd("PAPER", 100, 1, 3)).toBeCloseTo(3, 9);
  });

  it("PAPER is NOT capped by maxTradeUsd - the whole point is testing bigger sizes", () => {
    const size = resolveAutoBuySizeUsd("PAPER", 100, 1, 5); // $5 > MAX_TRADE_USD=$1
    expect(size).toBe(5);
  });

  it("PAPER shrinks proportionally as the balance shrinks (a losing streak)", () => {
    const atFull = resolveAutoBuySizeUsd("PAPER", 100, 1, 5);
    const afterLosses = resolveAutoBuySizeUsd("PAPER", 40, 1, 5);
    expect(afterLosses).toBeLessThan(atFull);
    expect(afterLosses).toBeCloseTo(2, 9);
  });
});
