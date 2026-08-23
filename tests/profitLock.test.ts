import { describe, expect, it } from "vitest";
import { checkProfitLock } from "../src/strategy/profitLock.js";

describe("checkProfitLock", () => {
  it("is not armed before the configured tranche count", () => {
    const status = checkProfitLock(1.2, 1, 2, 3, 8);
    expect(status.armed).toBe(false);
    expect(status.triggered).toBe(false);
    expect(status.floorPriceUsd).toBeUndefined();
  });

  it("arms after three completed tranches and exposes entry +8% floor", () => {
    const status = checkProfitLock(1.15, 1, 3, 3, 8);
    expect(status.armed).toBe(true);
    expect(status.triggered).toBe(false);
    expect(status.floorPriceUsd).toBeCloseTo(1.08, 12);
    expect(status.currentGainPercent).toBeCloseTo(15, 12);
  });

  it("triggers exactly at the profit floor", () => {
    const status = checkProfitLock(1.08, 1, 3, 3, 8);
    expect(status.triggered).toBe(true);
    expect(status.distanceAboveFloorPercent).toBeCloseTo(0, 12);
  });

  it("triggers below the profit floor", () => {
    expect(checkProfitLock(1.07, 1, 3, 3, 8).triggered).toBe(true);
  });

  it("does not trigger above the profit floor", () => {
    expect(checkProfitLock(1.081, 1, 3, 3, 8).triggered).toBe(false);
  });

  it("supports parameterized activation and locked gain", () => {
    const status = checkProfitLock(1.12, 1, 2, 2, 12);
    expect(status.armed).toBe(true);
    expect(status.floorPriceUsd).toBeCloseTo(1.12, 12);
    expect(status.triggered).toBe(true);
  });

  it("never arms with an invalid entry price", () => {
    const status = checkProfitLock(1, 0, 10, 3, 8);
    expect(status.armed).toBe(false);
    expect(status.triggered).toBe(false);
  });
});
