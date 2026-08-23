import { describe, expect, it } from "vitest";
import { resolveCrashBuySizeUsd } from "../src/trading/crashBuySize.js";

describe("resolveCrashBuySizeUsd", () => {
  it("PAPER: uses portfolioPercent of the paper balance, capped by maxUsd", () => {
    expect(resolveCrashBuySizeUsd("PAPER", 1000, 0, 50, 50)).toBe(50); // 50% of 1000 = 500, capped to 50
    expect(resolveCrashBuySizeUsd("PAPER", 60, 0, 50, 50)).toBe(30); // 50% of 60 = 30, under the cap
  });

  it("LIVE: uses portfolioPercent of the live-available balance, capped by maxUsd", () => {
    expect(resolveCrashBuySizeUsd("LIVE", 0, 1000, 50, 50)).toBe(50);
    expect(resolveCrashBuySizeUsd("LIVE", 0, 20, 50, 50)).toBe(10);
  });

  it("never exceeds what's actually available, even below the % size", () => {
    expect(resolveCrashBuySizeUsd("LIVE", 0, 5, 50, 50)).toBe(2.5);
    expect(resolveCrashBuySizeUsd("PAPER", 1, 0, 200, 50)).toBe(1); // 200% would be $2, but only $1 exists
  });

  it("never goes negative", () => {
    expect(resolveCrashBuySizeUsd("PAPER", -10, 0, 50, 50)).toBe(0);
  });
});
