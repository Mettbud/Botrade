import { describe, expect, it } from "vitest";
import {
  aggregateBooks,
  applyTradeToBooks,
  EMPTY_POSITION_BOOKS,
  getActiveCrashLot,
  replayPositionBooks,
} from "../src/trading/positionBooks.js";
import type { Trade, TradeReason, TradeSide } from "../src/trading/types.js";

let timestampMs = 1_000;

function trade(
  side: TradeSide,
  reason: TradeReason,
  tokenAmount: number,
  usdEstimate: number,
  extra: Partial<Trade> = {},
): Trade {
  return {
    timestampMs: timestampMs++,
    mode: "PAPER",
    side,
    reason,
    tokenAmount,
    solAmount: 0,
    usdEstimate,
    ...extra,
  };
}

function crashBuy(
  id: string,
  tokenAmount: number,
  usdEstimate: number,
  preDropPriceUsd = 3,
): Trade {
  return trade("BUY", "CRASH_BUY", tokenAmount, usdEstimate, {
    crashLotId: id,
    crashPreDropPriceUsd: preDropPriceUsd,
  });
}

describe("positionBooks", () => {
  it("separates regular buys from a metadata-backed crash lot", () => {
    const state = replayPositionBooks([
      trade("BUY", "AUTO_BUY", 100, 100),
      crashBuy("crash-1", 40, 80, 2.5),
    ]);

    expect(state.regular).toMatchObject({ tokenAmount: 100, totalCostUsd: 100 });
    expect(state.crashLots).toHaveLength(1);
    expect(state.crashLots[0]).toMatchObject({
      crashLotId: "crash-1",
      tokenAmount: 40,
      totalCostUsd: 80,
      initialTokenAmount: 40,
      initialCostUsd: 80,
      preDropPriceUsd: 2.5,
    });
    expect(state.crashLots[0]?.openedAtMs).toBeGreaterThan(0);
    expect(aggregateBooks(state)).toMatchObject({
      tokenAmount: 140,
      totalCostUsd: 180,
      realizedPnlUsd: 0,
    });
    expect(getActiveCrashLot(state)?.crashLotId).toBe("crash-1");
  });

  it("routes CRASH_BUY_EXIT only to its named lot and retains the closed audit record", () => {
    const state = replayPositionBooks([
      trade("BUY", "MANUAL", 100, 100),
      crashBuy("crash-1", 40, 80, 2.5),
      trade("SELL", "CRASH_BUY_EXIT", 40, 100, { crashLotId: "crash-1" }),
    ]);

    expect(state.regular).toMatchObject({ tokenAmount: 100, totalCostUsd: 100 });
    expect(state.crashLots[0]).toMatchObject({
      crashLotId: "crash-1",
      tokenAmount: 0,
      totalCostUsd: 0,
      realizedPnlUsd: 20,
      initialTokenAmount: 40,
      initialCostUsd: 80,
      preDropPriceUsd: 2.5,
    });
    expect(state.crashLots[0]?.closedAtMs).toBeDefined();
    expect(getActiveCrashLot(state)).toBeUndefined();
    expect(aggregateBooks(state).realizedPnlUsd).toBeCloseTo(20, 9);
  });

  it("fails closed for a legacy CRASH_BUY without complete metadata", () => {
    const state = replayPositionBooks([
      trade("BUY", "CRASH_BUY", 20, 30, { crashLotId: "missing-price" }),
    ]);

    expect(state.regular).toMatchObject({ tokenAmount: 20, totalCostUsd: 30 });
    expect(state.crashLots).toHaveLength(0);
    expect(state.warnings.legacyCrashBuyWithoutMetadata).toBe(true);
    expect(getActiveCrashLot(state)).toBeUndefined();
  });

  it("reconciles a legacy crash buy and exit that both lack lot metadata", () => {
    const state = replayPositionBooks([
      trade("BUY", "CRASH_BUY", 20, 30),
      trade("SELL", "CRASH_BUY_EXIT", 20, 40),
    ]);

    expect(state.regular).toMatchObject({
      tokenAmount: 0,
      totalCostUsd: 0,
      realizedPnlUsd: 10,
    });
    expect(aggregateBooks(state).tokenAmount).toBe(0);
    expect(state.warnings.legacyCrashBuyWithoutMetadata).toBe(true);
    expect(state.warnings.unroutableCrashBuyExit).toBe(true);
  });

  it("does not drop a confirmed exit carrying an unknown lot ID", () => {
    let state = replayPositionBooks([crashBuy("known", 20, 20)]);
    state = applyTradeToBooks(
      state,
      trade("SELL", "CRASH_BUY_EXIT", 20, 40, { crashLotId: "unknown" }),
    );

    expect(getActiveCrashLot(state, "known")).toBeUndefined();
    expect(state.warnings.unroutableCrashBuyExit).toBe(true);
    expect(aggregateBooks(state)).toMatchObject({
      tokenAmount: 0,
      totalCostUsd: 0,
      realizedPnlUsd: 20,
    });
  });

  it.each<TradeReason>([
    "TAKE_PROFIT",
    "CASCADE_TAKE_PROFIT",
    "PROFIT_LOCK",
  ])("routes %s exclusively to the regular book", (reason) => {
    const state = replayPositionBooks([
      trade("BUY", "AUTO_BUY", 100, 100),
      crashBuy("crash-1", 50, 100),
      trade("SELL", reason, 20, 40),
    ]);

    expect(state.regular).toMatchObject({
      tokenAmount: 80,
      totalCostUsd: 80,
      realizedPnlUsd: 20,
    });
    expect(state.crashLots[0]).toMatchObject({
      tokenAmount: 50,
      totalCostUsd: 100,
      realizedPnlUsd: 0,
    });
  });

  it("splits global exits and their USD proceeds proportionally by tokens", () => {
    const state = replayPositionBooks([
      trade("BUY", "AUTO_BUY", 100, 100),
      crashBuy("crash-1", 100, 200),
      trade("SELL", "STOP_LOSS", 100, 200),
    ]);

    expect(state.regular).toMatchObject({
      tokenAmount: 50,
      totalCostUsd: 50,
      realizedPnlUsd: 50,
    });
    expect(state.crashLots[0]).toMatchObject({
      tokenAmount: 50,
      totalCostUsd: 100,
      realizedPnlUsd: 0,
    });
    expect(aggregateBooks(state)).toMatchObject({
      tokenAmount: 100,
      totalCostUsd: 150,
      realizedPnlUsd: 50,
    });
  });

  it("uses regular-first routing for MANUAL and sends only overflow to crash lots", () => {
    const state = replayPositionBooks([
      trade("BUY", "AUTO_BUY", 60, 60),
      crashBuy("crash-1", 40, 80),
      trade("SELL", "MANUAL", 80, 160),
    ]);

    expect(state.regular).toMatchObject({
      tokenAmount: 0,
      totalCostUsd: 0,
      realizedPnlUsd: 60,
    });
    expect(state.crashLots[0]).toMatchObject({
      tokenAmount: 20,
      totalCostUsd: 40,
      realizedPnlUsd: 0,
    });
    expect(aggregateBooks(state)).toMatchObject({
      tokenAmount: 20,
      totalCostUsd: 40,
      realizedPnlUsd: 60,
    });
  });

  it("keeps multiple active lots explicit and never guesses between them", () => {
    const state = replayPositionBooks([
      crashBuy("first", 10, 10),
      crashBuy("second", 20, 20),
    ]);

    expect(getActiveCrashLot(state)).toBeUndefined();
    expect(getActiveCrashLot(state, "first")?.tokenAmount).toBe(10);
    expect(getActiveCrashLot(state, "second")?.tokenAmount).toBe(20);
  });

  it("combines multiple fills under one crash ID while preserving initial totals", () => {
    const first = crashBuy("one-order", 10, 15, 2.8);
    const second = crashBuy("one-order", 5, 10, 2.8);
    const state = replayPositionBooks([first, second]);

    expect(state.crashLots).toHaveLength(1);
    expect(state.crashLots[0]).toMatchObject({
      tokenAmount: 15,
      totalCostUsd: 25,
      initialTokenAmount: 15,
      initialCostUsd: 25,
      openedAtMs: first.timestampMs,
      preDropPriceUsd: 2.8,
    });
  });

  it("never spills a regular-only take profit into a crash lot", () => {
    const state = replayPositionBooks([
      trade("BUY", "AUTO_BUY", 10, 10),
      crashBuy("protected", 90, 90),
      trade("SELL", "CASCADE_TAKE_PROFIT", 20, 40),
    ]);

    expect(state.regular.tokenAmount).toBe(0);
    expect(state.crashLots[0]?.tokenAmount).toBe(90);
    expect(state.warnings.sellAmountExceededTargetBook).toBe(true);
    // Only the proceeds corresponding to the ten actually routed tokens apply.
    expect(state.regular.realizedPnlUsd).toBeCloseTo(10, 9);
  });
});
