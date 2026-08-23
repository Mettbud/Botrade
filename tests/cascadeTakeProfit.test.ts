import { describe, expect, it } from "vitest";
import { checkCascadeTakeProfit } from "../src/strategy/cascadeTakeProfit.js";

describe("checkCascadeTakeProfit", () => {
  it("does not fire below the threshold", () => {
    const r = checkCascadeTakeProfit(1.15, 1.0, 20, 20);
    expect(r.shouldSell).toBe(false);
    expect(r.gainPercent).toBeCloseTo(15, 6);
  });

  it("fires exactly at the threshold", () => {
    const r = checkCascadeTakeProfit(1.2, 1.0, 20, 20);
    expect(r.shouldSell).toBe(true);
    expect(r.sellPercent).toBe(20);
    expect(r.gainPercent).toBeCloseTo(20, 6);
  });

  it("measures from whatever reference price is passed in, not a fixed entry", () => {
    // Second tranche: reference is the first tranche's sell price, not the
    // original entry - the caller advances this between calls.
    const r = checkCascadeTakeProfit(1.44, 1.2, 20, 20);
    expect(r.shouldSell).toBe(true);
    expect(r.gainPercent).toBeCloseTo(20, 6);
  });

  it("treats an invalid (<=0) reference price as never due", () => {
    const r = checkCascadeTakeProfit(1.5, 0, 20, 20);
    expect(r.shouldSell).toBe(false);
    expect(r.gainPercent).toBe(0);
  });
});
