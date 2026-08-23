import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config/schema.js";
import { PriceHistoryBuffer } from "../src/market/history.js";
import type { PriceSample } from "../src/market/types.js";
import { RecoveryBuyManager } from "../src/trading/recoveryBuyManager.js";

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

function config() {
  return buildConfig({
    TARGET_TOKEN_MINT: "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg",
    RECOVERY_BUY_ENABLED: "true",
    RECOVERY_BUY_DROP_PERCENT: "8",
    RECOVERY_BUY_REBOUND_PERCENT: "3",
    RECOVERY_BUY_CONFIRMATION_MS: "8000",
    RECOVERY_BUY_TIMEOUT_MS: "60000",
    RECOVERY_BUY_MIN_LOSS_PERCENT: "4",
    RECOVERY_BUY_MAX_LOSS_PERCENT: "12",
  } as unknown as NodeJS.ProcessEnv);
}

const baseContext = {
  regularCostBasis: { tokenAmount: 100, totalCostUsd: 100, realizedPnlUsd: 0 },
  cascadeSoldTokenAmount: 0,
  addsUsed: 0,
  hasActiveCrashLot: false,
};

describe("RecoveryBuyManager", () => {
  it("fires once only after a deep dip and confirmed rebound in the loss zone", () => {
    const manager = new RecoveryBuyManager(config());
    const history = new PriceHistoryBuffer();
    history.push(sample(0, 1.05));
    manager.evaluate(history, { ...baseContext, nowMs: 0 });
    history.push(sample(1_000, 0.91));
    expect(manager.evaluate(history, { ...baseContext, nowMs: 1_000 })).toBe(false);
    history.push(sample(2_000, 0.938));
    expect(manager.evaluate(history, { ...baseContext, nowMs: 2_000 })).toBe(false);
    expect(manager.status().phase).toBe("CONFIRMING");
    history.push(sample(10_000, 0.94));
    expect(manager.evaluate(history, { ...baseContext, nowMs: 10_000 })).toBe(true);
  });

  it("blocks after a payout, while a crash lot is active, or after one add", () => {
    const history = new PriceHistoryBuffer();
    history.push(sample(0, 0.91));

    const afterPayout = new RecoveryBuyManager(config());
    expect(afterPayout.evaluate(history, {
      ...baseContext,
      cascadeSoldTokenAmount: 1,
      nowMs: 0,
    })).toBe(false);
    expect(afterPayout.status().phase).toBe("BLOCKED");

    const crashActive = new RecoveryBuyManager(config());
    crashActive.evaluate(history, { ...baseContext, hasActiveCrashLot: true, nowMs: 0 });
    expect(crashActive.status().phase).toBe("BLOCKED");

    const maxed = new RecoveryBuyManager(config());
    maxed.evaluate(history, { ...baseContext, addsUsed: 1, nowMs: 0 });
    expect(maxed.status().phase).toBe("MAXED");
  });

  it("does not average into a loss beyond the configured safety limit", () => {
    const manager = new RecoveryBuyManager(config());
    const history = new PriceHistoryBuffer();
    history.push(sample(0, 0.8));
    expect(manager.evaluate(history, { ...baseContext, nowMs: 0 })).toBe(false);
    expect(manager.status().phase).toBe("BLOCKED");
    expect(manager.status().lossPercent).toBeCloseTo(20, 9);
  });
});
