import { describe, expect, it } from "vitest";
import { resolveAutoBuyDipThreshold } from "../src/strategy/autoBuyDipThreshold.js";

describe("resolveAutoBuyDipThreshold", () => {
  it("uses the base threshold below the peak run-up trigger", () => {
    expect(
      resolveAutoBuyDipThreshold({
        baseDipPercent: 2,
        peakProtectionEnabled: true,
        recentRunUpPercent: 9.99,
        peakRunUpPercent: 10,
        peakDipPercent: 8,
        volatilityProtectionEnabled: false,
        realizedVolatilityPercent: 0,
        volatilityMultiplier: 2,
        volatilityMaxDipPercent: 12,
      }),
    ).toEqual({
      effectiveDipPercent: 2,
      peakProtectionActive: false,
      volatilityProtectionActive: false,
      volatilityDipPercent: 0,
    });
  });

  it("uses the wider threshold once the peak trigger is reached", () => {
    expect(
      resolveAutoBuyDipThreshold({
        baseDipPercent: 2,
        peakProtectionEnabled: true,
        recentRunUpPercent: 10,
        peakRunUpPercent: 10,
        peakDipPercent: 8,
        volatilityProtectionEnabled: false,
        realizedVolatilityPercent: 0,
        volatilityMultiplier: 2,
        volatilityMaxDipPercent: 12,
      }),
    ).toEqual({
      effectiveDipPercent: 8,
      peakProtectionActive: true,
      volatilityProtectionActive: false,
      volatilityDipPercent: 0,
    });
  });

  it("can be disabled without changing the base strategy", () => {
    expect(
      resolveAutoBuyDipThreshold({
        baseDipPercent: 2,
        peakProtectionEnabled: false,
        recentRunUpPercent: 25,
        peakRunUpPercent: 10,
        peakDipPercent: 8,
        volatilityProtectionEnabled: false,
        realizedVolatilityPercent: 0,
        volatilityMultiplier: 2,
        volatilityMaxDipPercent: 12,
      }),
    ).toEqual({
      effectiveDipPercent: 2,
      peakProtectionActive: false,
      volatilityProtectionActive: false,
      volatilityDipPercent: 0,
    });
  });

  it("uses volatility when it is stricter than base and peak protection", () => {
    expect(
      resolveAutoBuyDipThreshold({
        baseDipPercent: 2,
        peakProtectionEnabled: true,
        recentRunUpPercent: 12,
        peakRunUpPercent: 10,
        peakDipPercent: 8,
        volatilityProtectionEnabled: true,
        realizedVolatilityPercent: 5,
        volatilityMultiplier: 2,
        volatilityMaxDipPercent: 12,
      }),
    ).toEqual({
      effectiveDipPercent: 10,
      peakProtectionActive: true,
      volatilityProtectionActive: true,
      volatilityDipPercent: 10,
    });
  });

  it("caps the volatility-derived threshold", () => {
    expect(
      resolveAutoBuyDipThreshold({
        baseDipPercent: 2,
        peakProtectionEnabled: false,
        recentRunUpPercent: 0,
        peakRunUpPercent: 10,
        peakDipPercent: 8,
        volatilityProtectionEnabled: true,
        realizedVolatilityPercent: 20,
        volatilityMultiplier: 2,
        volatilityMaxDipPercent: 12,
      }),
    ).toMatchObject({
      effectiveDipPercent: 12,
      volatilityProtectionActive: true,
      volatilityDipPercent: 12,
    });
  });
});
