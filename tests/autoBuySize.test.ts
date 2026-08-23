import { describe, expect, it } from "vitest";
import { resolveAutoBuySizeUsd } from "../src/trading/autoBuySize.js";

describe("resolveAutoBuySizeUsd", () => {
  it("LIVE sizes as a percent of available balance, same formula as PAPER", () => {
    expect(resolveAutoBuySizeUsd("LIVE", 100, 1000, 5)).toBeCloseTo(5, 9);
    expect(resolveAutoBuySizeUsd("LIVE", 100, 1000, 10)).toBeCloseTo(10, 9);
  });

  it("LIVE is capped at maxTradeUsd even when the percent would size higher", () => {
    expect(resolveAutoBuySizeUsd("LIVE", 1000, 50, 10)).toBe(50); // 10% of 1000 = 100, capped to 50
  });

  it("LIVE below the cap is unaffected by maxTradeUsd", () => {
    expect(resolveAutoBuySizeUsd("LIVE", 100, 50, 10)).toBeCloseTo(10, 9); // 10% of 100 = 10, under the 50 cap
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

  it("never goes negative on a negative available balance", () => {
    expect(resolveAutoBuySizeUsd("LIVE", -10, 50, 10)).toBe(0);
    expect(resolveAutoBuySizeUsd("PAPER", -10, 50, 10)).toBe(0);
  });
});
