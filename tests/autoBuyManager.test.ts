import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config/schema.js";
import { PriceHistoryBuffer } from "../src/market/history.js";
import type { PriceSample } from "../src/market/types.js";
import { AutoBuyManager } from "../src/trading/autoBuyManager.js";

function sample(timestampMs: number, sellPriceUsd: number): PriceSample {
  return {
    timestampMs,
    buyPriceUsd: sellPriceUsd,
    sellPriceUsd,
    sellIsEstimated: false,
    spread: 0,
    priceImpactBuyBps: 10,
    priceImpactSellBps: 10,
    referenceSolAmount: 0.01,
    referenceTokenAmountUi: 100,
    solUsdPrice: 150,
  };
}

function enabledConfig(overrides: Record<string, string> = {}) {
  return buildConfig({
    TARGET_TOKEN_MINT: "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg",
    AUTO_BUY_ENABLED: "true",
    AUTO_BUY_DIP_PERCENT: "50",
    AUTO_BUY_DIP_LOOKBACK_MS: "60000",
    ...overrides,
  } as unknown as NodeJS.ProcessEnv);
}

describe("AutoBuyManager", () => {
  it("does nothing when disabled", () => {
    const config = buildConfig({
      TARGET_TOKEN_MINT: "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg",
    } as unknown as NodeJS.ProcessEnv);
    const manager = new AutoBuyManager(config);
    const history = new PriceHistoryBuffer();
    history.push(sample(0, 1.0));
    history.push(sample(10_000, 0.3)); // -70%, would trigger if enabled

    expect(manager.evaluate(history, false, 10_000)).toBe(false);
  });

  it("does not watch while a position is already open", () => {
    const manager = new AutoBuyManager(enabledConfig());
    const history = new PriceHistoryBuffer();
    history.push(sample(0, 1.0));
    history.push(sample(10_000, 0.3));

    expect(manager.evaluate(history, true, 10_000)).toBe(false);
    expect(manager.status().watching).toBe(false);
  });

  it("fires a buy on the full dip -> rebound sequence, end to end", () => {
    const manager = new AutoBuyManager(enabledConfig());
    const history = new PriceHistoryBuffer();

    history.push(sample(0, 1.0)); // recent high
    expect(manager.evaluate(history, false, 0)).toBe(false);

    history.push(sample(1_000, 0.4)); // -60%, crosses the 50% threshold
    expect(manager.evaluate(history, false, 1_000)).toBe(false);
    expect(manager.status().watching).toBe(true);

    history.push(sample(2_000, 0.35)); // still falling
    expect(manager.evaluate(history, false, 2_000)).toBe(false);

    history.push(sample(10_000, 0.36)); // ticks up -> buy signal
    expect(manager.evaluate(history, false, 10_000)).toBe(true);
    expect(manager.status().watching).toBe(false);
  });

  it("keeps the base dip threshold when there was no preceding pump", () => {
    const manager = new AutoBuyManager(
      enabledConfig({
        AUTO_BUY_DIP_PERCENT: "2",
        AUTO_BUY_VOLATILITY_PROTECTION_ENABLED: "false",
      }),
    );
    const history = new PriceHistoryBuffer();

    history.push(sample(0, 1.0));
    manager.evaluate(history, false, 0);
    history.push(sample(1_000, 0.979)); // -2.1%, with no earlier run-up
    expect(manager.evaluate(history, false, 1_000)).toBe(false);
    expect(manager.status()).toMatchObject({
      watching: true,
      effectiveDipPercent: 2,
      peakProtectionActive: false,
    });

    history.push(sample(2_000, 0.98));
    expect(manager.evaluate(history, false, 2_000)).toBe(true);
  });

  it("widens a 2% dip threshold to 8% after a 10% five-minute run-up", () => {
    const manager = new AutoBuyManager(
      enabledConfig({
        AUTO_BUY_DIP_PERCENT: "2",
        AUTO_BUY_VOLATILITY_PROTECTION_ENABLED: "false",
      }),
    );
    const history = new PriceHistoryBuffer();

    history.push(sample(0, 1.0));
    manager.evaluate(history, false, 0);
    history.push(sample(60_000, 1.1)); // +10% pump
    manager.evaluate(history, false, 60_000);

    history.push(sample(90_000, 1.04)); // only -5.45% from the peak
    expect(manager.evaluate(history, false, 90_000)).toBe(false);
    expect(manager.status()).toMatchObject({
      watching: false,
      effectiveDipPercent: 8,
      peakProtectionActive: true,
    });

    history.push(sample(120_000, 1.012)); // -8% from the $1.10 peak
    expect(manager.evaluate(history, false, 120_000)).toBe(false);
    expect(manager.status().watching).toBe(true);

    history.push(sample(121_000, 1.013)); // first rebound tick
    expect(manager.evaluate(history, false, 121_000)).toBe(true);
  });

  it("peak protection never lowers a more conservative base threshold", () => {
    const manager = new AutoBuyManager(
      enabledConfig({
        AUTO_BUY_DIP_PERCENT: "12",
        AUTO_BUY_VOLATILITY_PROTECTION_ENABLED: "false",
      }),
    );
    const history = new PriceHistoryBuffer();

    history.push(sample(0, 1.0));
    manager.evaluate(history, false, 0);
    history.push(sample(60_000, 1.1));
    manager.evaluate(history, false, 60_000);

    expect(manager.status()).toMatchObject({
      effectiveDipPercent: 12,
      peakProtectionActive: true,
    });
  });

  it("widens the dip continuously when realized volatility increases", () => {
    const manager = new AutoBuyManager(
      enabledConfig({
        AUTO_BUY_DIP_PERCENT: "2",
        AUTO_BUY_PEAK_PROTECTION_ENABLED: "false",
      }),
    );
    const history = new PriceHistoryBuffer();

    history.push(sample(0, 1.0));
    manager.evaluate(history, false, 0);
    history.push(sample(1_000, 1.03));
    manager.evaluate(history, false, 1_000);
    history.push(sample(2_000, 1.0));
    manager.evaluate(history, false, 2_000);

    const status = manager.status();
    expect(status.volatilityProtectionActive).toBe(true);
    expect(status.realizedVolatilityPercent).toBeGreaterThan(4);
    expect(status.effectiveDipPercent).toBeCloseTo(
      Math.min(status.realizedVolatilityPercent! * 2, 12),
      9,
    );
  });

  it("AUTO_BUY_ALLOW_AVERAGING=true lets it buy more while already holding a position", () => {
    const manager = new AutoBuyManager(
      enabledConfig({ AUTO_BUY_ALLOW_AVERAGING: "true" }),
    );
    const history = new PriceHistoryBuffer();

    history.push(sample(0, 1.0));
    manager.evaluate(history, true, 0); // already holding a position
    history.push(sample(1_000, 0.4)); // -60%
    manager.evaluate(history, true, 1_000);
    expect(manager.status().watching).toBe(true); // watches despite hasOpenPosition=true

    history.push(sample(2_000, 0.41)); // rebound
    expect(manager.evaluate(history, true, 2_000)).toBe(true);
  });

  it("AUTO_BUY_MIN_GAP_MS is configurable (default 3000 too short here)", () => {
    const manager = new AutoBuyManager(
      enabledConfig({ AUTO_BUY_ALLOW_AVERAGING: "true", AUTO_BUY_MIN_GAP_MS: "60000" }),
    );
    const history = new PriceHistoryBuffer();

    history.push(sample(0, 1.0));
    manager.evaluate(history, true, 0);
    history.push(sample(1_000, 0.4));
    manager.evaluate(history, true, 1_000);
    history.push(sample(2_000, 0.41));
    expect(manager.evaluate(history, true, 2_000)).toBe(true); // first buy

    // Second dip/rebound only 10s later - within the configured 60s gap.
    history.push(sample(2_100, 1.0));
    manager.evaluate(history, true, 2_100);
    history.push(sample(2_200, 0.4));
    manager.evaluate(history, true, 2_200);
    history.push(sample(12_000, 0.41));
    expect(manager.evaluate(history, true, 12_000)).toBe(false); // still too soon
  });

  it("blocks a rebound buy at/above the last sell price when AUTO_BUY_REQUIRE_BELOW_LAST_SELL is on (default)", () => {
    const manager = new AutoBuyManager(
      enabledConfig({ AUTO_BUY_ALLOW_AVERAGING: "true" }),
    );
    const history = new PriceHistoryBuffer();

    history.push(sample(0, 1.0));
    manager.evaluate(history, true, 0, 1.1); // last sell was at $1.10
    history.push(sample(1_000, 0.4)); // -60% dip
    manager.evaluate(history, true, 1_000, 1.1);
    history.push(sample(2_000, 1.2)); // rebounds, but to $1.20 - ABOVE the last sell ($1.10)

    expect(manager.evaluate(history, true, 2_000, 1.1)).toBe(false);
  });

  it("allows a rebound buy below the last sell price", () => {
    const manager = new AutoBuyManager(
      enabledConfig({ AUTO_BUY_ALLOW_AVERAGING: "true" }),
    );
    const history = new PriceHistoryBuffer();

    history.push(sample(0, 1.0));
    manager.evaluate(history, true, 0, 1.1); // last sell was at $1.10
    history.push(sample(1_000, 0.4));
    manager.evaluate(history, true, 1_000, 1.1);
    history.push(sample(2_000, 0.41)); // rebounds to $0.41 - well below $1.10

    expect(manager.evaluate(history, true, 2_000, 1.1)).toBe(true);
  });

  it("ignores the last-sell gate when there is no recorded sell yet (undefined)", () => {
    const manager = new AutoBuyManager(enabledConfig());
    const history = new PriceHistoryBuffer();

    history.push(sample(0, 1.0));
    manager.evaluate(history, false, 0, undefined);
    history.push(sample(1_000, 0.4));
    manager.evaluate(history, false, 1_000, undefined);
    history.push(sample(2_000, 0.41));

    expect(manager.evaluate(history, false, 2_000, undefined)).toBe(true);
  });

  it("respects the technical minimum gap between two buy signals", () => {
    const manager = new AutoBuyManager(enabledConfig());
    const history = new PriceHistoryBuffer();

    history.push(sample(0, 1.0));
    manager.evaluate(history, false, 0);
    history.push(sample(1_000, 0.4));
    manager.evaluate(history, false, 1_000); // starts watching
    history.push(sample(2_000, 0.41));
    expect(manager.evaluate(history, false, 2_000)).toBe(true); // rebound #1

    // Immediately set up a second dip/rebound within the min-gap window.
    history.push(sample(2_100, 1.0));
    manager.evaluate(history, false, 2_100);
    history.push(sample(2_200, 0.4));
    manager.evaluate(history, false, 2_200); // starts watching again
    history.push(sample(2_300, 0.41));
    expect(manager.evaluate(history, false, 2_300)).toBe(false); // too soon
  });

  it("reset clears the dip watch, adaptive flags, and previous-buy cooldown", () => {
    const manager = new AutoBuyManager(enabledConfig({
      AUTO_BUY_MIN_GAP_MS: "60000",
    }));
    const first = new PriceHistoryBuffer();
    first.push(sample(0, 1));
    manager.evaluate(first, false, 0);
    first.push(sample(1_000, 0.4));
    manager.evaluate(first, false, 1_000);
    first.push(sample(2_000, 0.41));
    expect(manager.evaluate(first, false, 2_000)).toBe(true);

    manager.reset();

    expect(manager.status()).toMatchObject({
      watching: false,
      dropPercentFromHigh: undefined,
      effectiveDipPercent: enabledConfig().autoBuy.dipPercent,
      peakProtectionActive: false,
      recentRunUpPercent: undefined,
      volatilityProtectionActive: false,
      realizedVolatilityPercent: undefined,
    });

    const fresh = new PriceHistoryBuffer();
    fresh.push(sample(2_100, 1));
    manager.evaluate(fresh, false, 2_100);
    fresh.push(sample(2_200, 0.4));
    manager.evaluate(fresh, false, 2_200);
    fresh.push(sample(2_300, 0.41));
    expect(manager.evaluate(fresh, false, 2_300)).toBe(true);
  });
});
