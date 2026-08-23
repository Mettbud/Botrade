import { describe, expect, it } from "vitest";
import { replayCascadeTracker } from "../src/trading/cascadeCycle.js";
import type { Trade } from "../src/trading/types.js";

function trade(overrides: Partial<Trade>): Trade {
  return {
    timestampMs: 1,
    mode: "PAPER",
    side: "BUY",
    reason: "AUTO_BUY",
    tokenAmount: 100,
    solAmount: 0,
    usdEstimate: 100,
    ...overrides,
  };
}

describe("cascade tracker replay", () => {
  it("restores a multi-threshold payout without duplicating tranches", () => {
    const state = replayCascadeTracker([
      trade({}),
      trade({
        timestampMs: 2,
        side: "SELL",
        reason: "CASCADE_TAKE_PROFIT",
        tokenAmount: 60,
        usdEstimate: 69,
        cascadeTranchesExecuted: 3,
        cascadeEntryPriceUsd: 1,
        cascadeInitialTokenAmount: 100,
      }),
    ]);

    expect(state.active).toMatchObject({
      entryPriceUsd: 1,
      initialTokenAmount: 100,
      completedTranches: 3,
      cascadeSoldTokenAmount: 60,
    });
    expect(state.lastExecution).toMatchObject({
      trancheNumber: 3,
      tranchesExecuted: 3,
      tokenAmount: 60,
      initialTokenAmount: 100,
      cumulativeSoldTokenAmount: 60,
    });
  });

  it("includes averaging buys before the first payout in the frozen opening size", () => {
    const state = replayCascadeTracker([
      trade({ tokenAmount: 100, usdEstimate: 100 }),
      trade({ timestampMs: 2, tokenAmount: 50, usdEstimate: 100 }),
    ]);

    expect(state.active?.initialTokenAmount).toBe(150);
    expect(state.active?.entryPriceUsd).toBeCloseTo(200 / 150, 12);
  });

  it("persists a partial cascade fill without inventing a completed tranche", () => {
    const state = replayCascadeTracker([
      trade({}),
      trade({
        timestampMs: 2,
        side: "SELL",
        reason: "CASCADE_TAKE_PROFIT",
        tokenAmount: 10,
        usdEstimate: 11.5,
        cascadeTranchesExecuted: 0,
        cascadeEntryPriceUsd: 1,
        cascadeInitialTokenAmount: 100,
      }),
    ]);

    expect(state.active).toMatchObject({
      completedTranches: 0,
      cascadeSoldTokenAmount: 10,
    });
    expect(state.lastExecution).toMatchObject({
      tranchesExecuted: 0,
      tokenAmount: 10,
      initialTokenAmount: 100,
    });
  });

  it("does not let a crash lot alter the regular cascade cycle", () => {
    const state = replayCascadeTracker([
      trade({}),
      trade({
        timestampMs: 2,
        reason: "CRASH_BUY",
        tokenAmount: 50,
        usdEstimate: 75,
        crashLotId: "crash-1",
        crashPreDropPriceUsd: 2,
      }),
    ]);

    expect(state.active).toMatchObject({
      initialTokenAmount: 100,
      entryPriceUsd: 1,
    });
  });

  it("fails closed when an old unlabelled TAKE_PROFIT exists in the active cycle", () => {
    const state = replayCascadeTracker([
      trade({}),
      trade({
        timestampMs: 2,
        side: "SELL",
        reason: "TAKE_PROFIT",
        tokenAmount: 20,
        usdEstimate: 24,
      }),
    ]);

    expect(state.active).toBeDefined();
    expect(state.legacyTakeProfitInActiveCycle).toBe(true);
  });

  it("clears the active cycle after the regular book is fully closed", () => {
    const state = replayCascadeTracker([
      trade({}),
      trade({
        timestampMs: 2,
        side: "SELL",
        reason: "PROFIT_LOCK",
        tokenAmount: 100,
        usdEstimate: 108,
      }),
    ]);

    expect(state.active).toBeUndefined();
  });
});
