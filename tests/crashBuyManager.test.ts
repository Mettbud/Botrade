import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config/schema.js";
import { PriceHistoryBuffer } from "../src/market/history.js";
import type { PriceSample } from "../src/market/types.js";
import { CrashBuyManager } from "../src/trading/crashBuyManager.js";

function sample(timestampMs: number, sellPriceUsd: number, spread = 0): PriceSample {
  return {
    timestampMs,
    buyPriceUsd: sellPriceUsd,
    sellPriceUsd,
    sellIsEstimated: false,
    spread,
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
    CRASH_BUY_ENABLED: "true",
    CRASH_BUY_DROP_PERCENT: "20",
    CRASH_BUY_WINDOW_MS: "1000",
    PRICE_POLL_INTERVAL_MS: "100",
    ...overrides,
  } as unknown as NodeJS.ProcessEnv);
}

describe("CrashBuyManager", () => {
  it("does nothing when disabled", () => {
    const config = buildConfig({
      TARGET_TOKEN_MINT: "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg",
    } as unknown as NodeJS.ProcessEnv);
    const manager = new CrashBuyManager(config);
    const history = new PriceHistoryBuffer();
    history.push(sample(0, 1.0));
    history.push(sample(500, 0.7)); // -30%, would trigger if enabled

    expect(manager.evaluate(history, false, 500).shouldBuy).toBe(false);
  });

  it("does not buy while a crash-buy lot is already active", () => {
    const manager = new CrashBuyManager(enabledConfig());
    const history = new PriceHistoryBuffer();
    history.push(sample(0, 1.0));
    history.push(sample(500, 0.7));

    expect(manager.evaluate(history, true, 500).shouldBuy).toBe(false);
  });

  it("fires immediately on a fast drop within the window, no rebound wait", () => {
    const manager = new CrashBuyManager(enabledConfig());
    const history = new PriceHistoryBuffer();
    history.push(sample(0, 1.0));
    history.push(sample(800, 0.75)); // -25% within 1000ms -> crosses the 20% threshold

    const signal = manager.evaluate(history, false, 800);
    expect(signal.shouldBuy).toBe(true);
    expect(signal.preDropPriceUsd).toBe(1.0);
  });

  it("allows a crash signal beside a regular position when no crash lot is active", () => {
    const manager = new CrashBuyManager(enabledConfig());
    const history = new PriceHistoryBuffer();
    history.push(sample(0, 1.0));
    history.push(sample(800, 0.75));

    // The second argument describes only a dedicated crash-buy lot. A
    // regular spot position may exist while this value remains false.
    expect(manager.evaluate(history, false, 800)).toMatchObject({
      shouldBuy: true,
      preDropPriceUsd: 1.0,
      reason: "TRIGGERED",
    });
  });

  it("does not fire on a drop below the threshold", () => {
    const manager = new CrashBuyManager(enabledConfig());
    const history = new PriceHistoryBuffer();
    history.push(sample(0, 1.0));
    history.push(sample(800, 0.85)); // -15%, under the 20% threshold

    expect(manager.evaluate(history, false, 800)).toMatchObject({
      shouldBuy: false,
      reason: "DROP_TOO_SMALL",
    });
  });

  it("does not fire on a drop that happened outside the window", () => {
    const manager = new CrashBuyManager(enabledConfig({ CRASH_BUY_WINDOW_MS: "500" }));
    const history = new PriceHistoryBuffer();
    history.push(sample(0, 1.0));
    history.push(sample(5_000, 0.7)); // -30%, but 5s later - out of the 500ms window

    expect(manager.evaluate(history, false, 5_000).shouldBuy).toBe(false);
  });

  it("does not fire when spread exceeds CRASH_BUY_MAX_SPREAD_BPS (pathological/rugged pool)", () => {
    const manager = new CrashBuyManager(enabledConfig({ CRASH_BUY_MAX_SPREAD_BPS: "500" }));
    const history = new PriceHistoryBuffer();
    history.push(sample(0, 1.0, 0));
    history.push(sample(800, 0.75, 0.08)); // -25% drop, but spread is 8% - above the 5% cap

    expect(manager.evaluate(history, false, 800)).toMatchObject({
      shouldBuy: false,
      reason: "SPREAD_TOO_WIDE",
    });
  });

  it("still fires when spread is elevated but within CRASH_BUY_MAX_SPREAD_BPS", () => {
    const manager = new CrashBuyManager(enabledConfig({ CRASH_BUY_MAX_SPREAD_BPS: "500" }));
    const history = new PriceHistoryBuffer();
    history.push(sample(0, 1.0, 0));
    history.push(sample(800, 0.75, 0.04)); // 4% spread, under the 5% cap

    expect(manager.evaluate(history, false, 800).shouldBuy).toBe(true);
  });

  it("can reject a stale estimated signal after a fresh spread/price recheck", () => {
    const manager = new CrashBuyManager(enabledConfig({
      CRASH_BUY_MAX_SPREAD_BPS: "500",
    }));

    expect(manager.isSignalStillValid(0.75, 0.04, 1)).toBe(true);
    expect(manager.isSignalStillValid(0.85, 0.04, 1)).toBe(false);
    expect(manager.isSignalStillValid(0.75, 0.08, 1)).toBe(false);
  });

  it("does not claim an active lot before the caller completes the trade", () => {
    const manager = new CrashBuyManager(enabledConfig());
    const history = new PriceHistoryBuffer();
    history.push(sample(0, 1.0));
    history.push(sample(800, 0.75));

    expect(manager.evaluate(history, false, 800).shouldBuy).toBe(true);

    // Until PositionManager reports a successfully opened crash lot, the
    // detector remains free to emit a retry signal.
    expect(manager.evaluate(history, false, 801).shouldBuy).toBe(true);
    expect(manager.evaluate(history, true, 802).shouldBuy).toBe(false);
  });
});
