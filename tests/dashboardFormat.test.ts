import { describe, expect, it } from "vitest";
import {
  formatCascadeStatusLines,
  formatCrashBuyStatusLines,
  formatDashboardAge,
  formatPriceImpactLine,
  formatProfitLockStatusLines,
  formatRecoveryBuyStatusLine,
  formatStopLossMargin,
} from "../src/cli/dashboard.js";
import type { PriceSample } from "../src/market/types.js";

function sample(overrides: Partial<PriceSample> = {}): PriceSample {
  return {
    timestampMs: 0,
    buyPriceUsd: 1,
    sellPriceUsd: 1,
    sellIsEstimated: false,
    spread: 0.005,
    priceImpactBuyBps: 44.457776396648256,
    priceImpactSellBps: 5.5237881334204986,
    referenceSolAmount: 0.01,
    referenceTokenAmountUi: 100,
    solUsdPrice: 150,
    ...overrides,
  };
}

describe("formatStopLossMargin", () => {
  it("labels a positive lossPercent as an actual loss", () => {
    expect(formatStopLossMargin(5.36)).toBe("5.36% loss");
  });

  it("labels a negative lossPercent (position in profit) as no loss, not '-X% loss'", () => {
    expect(formatStopLossMargin(-5.36)).toBe("no loss (+5.36% above entry)");
  });

  it("treats exactly 0 as no loss", () => {
    expect(formatStopLossMargin(0)).toBe("no loss (+0.00% above entry)");
  });
});

describe("formatPriceImpactLine", () => {
  it("rounds buy/sell price impact to 2 decimals instead of printing raw float precision", () => {
    // Regression: these used to print with full float precision (e.g.
    // "0.44457776396648256%") because unlike spread, they had no .toFixed().
    expect(formatPriceImpactLine(sample())).toBe(
      "Price impact: buy 0.44%  sell 0.06%  spread 0.50%",
    );
  });

  it("falls back to 0 for every field when there is no sample yet", () => {
    expect(formatPriceImpactLine(undefined)).toBe(
      "Price impact: buy 0.00%  sell 0.00%  spread 0.00%",
    );
  });
});

describe("strategy dashboard status formatting", () => {
  it("shows recovery-buy confirmation progress", () => {
    expect(stripAnsi(formatRecoveryBuyStatusLine({
      enabled: true,
      phase: "CONFIRMING",
      lossPercent: 8.5,
      reboundPercentFromLow: 3.2,
      confirmationProgressPercent: 50,
      addsUsed: 0,
      maxAdds: 1,
      plannedPortfolioPercent: 5,
      dropTriggerPercent: 8,
      reboundTriggerPercent: 3,
    }))).toContain("Recovery-buy: CONFIRMING");
  });
  it("shows cascade payout count, initial-position share, next target, and last payout", () => {
    expect(formatCascadeStatusLines({
      enabled: true,
      completedTranches: 3,
      maxTranches: 5,
      soldInitialPercent: 60,
      nextGainPercent: 20,
      nextTargetPriceUsd: 0.03,
      nextProgressPercent: 62.345,
      lastExecution: {
        trancheNumber: 3,
        soldInitialPercent: 20,
        priceUsd: 0.028,
        gainFromEntryPercent: 15,
        ageMs: 12_500,
      },
    })).toEqual([
      "Cascade TP: 3/5 payouts | sold 60.00% of initial",
      "  Next: +20.00% @ $0.03000000 | progress 62.3%",
      "  Last: #3 sold 20.00% of initial @ $0.02800000 (+15.00%), 12s ago",
    ]);
  });

  it("shows the profit-lock arming rule and floor", () => {
    const [line] = formatProfitLockStatusLines({
      enabled: true,
      armed: true,
      activationTrancheCount: 3,
      floorGainPercent: 8,
      floorPriceUsd: 0.026,
    });

    expect(stripAnsi(line ?? "")).toBe(
      "Profit lock: ARMED after 3 payouts | floor +8.00% @ $0.02600000",
    );
  });

  it("keeps an active crash lot and its most recent event readable", () => {
    const lines = formatCrashBuyStatusLines({
      phase: "ACTIVE",
      realizedPnlUsd: 12.5,
      totalPnlUsd: 15,
      activeLot: {
        tokenAmount: 1_234.56789,
        costUsd: 50,
        preDropPriceUsd: 0.03,
        reboundTargetPriceUsd: 0.0249,
        entryPriceUsd: 0.02,
        pnlUsd: 2.5,
        pnlPercent: 5,
        stopLossPriceUsd: 0.017,
        trailingStopPercent: 12,
      },
      lastEvent: {
        message: "bought isolated crash lot",
        ageMs: 65_000,
      },
    }, "CYBERLEEK").map(stripAnsi);

    expect(lines).toEqual([
      "Crash-buy: ACTIVE",
      "  Crash PnL: realized $12.50 | open $2.50 | total $15.00",
      "  Lot: 1,234.56789 CYBERLEEK | cost $50.00 | P0 $0.03000000 | rebound $0.02490000",
      "  Risk: entry $0.02000000 | PnL +5.00% | hard stop $0.01700000 | trailing 12.00% (isolated)",
      "  Last: bought isolated crash lot (1m ago)",
    ]);
  });

  it("keeps cumulative crash profit visible after the lot closes", () => {
    expect(formatCrashBuyStatusLines({
      phase: "RECENT",
      realizedPnlUsd: -3.25,
    }, "CYBERLEEK").map(stripAnsi)).toEqual([
      "Crash-buy: RECENT",
      "  Crash PnL: realized $-3.25",
    ]);
  });

  it("formats event age without depending on the wall clock", () => {
    expect(formatDashboardAge(-1)).toBe("now");
    expect(formatDashboardAge(999)).toBe("now");
    expect(formatDashboardAge(59_999)).toBe("59s ago");
    expect(formatDashboardAge(3_600_000)).toBe("1h ago");
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}
