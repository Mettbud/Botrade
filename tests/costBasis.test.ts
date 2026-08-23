import { describe, expect, it } from "vitest";
import {
  applyTrade,
  averageEntryPriceUsd,
  EMPTY_COST_BASIS,
  replayTrades,
  unrealizedPnl,
} from "../src/strategy/costBasis.js";

describe("costBasis", () => {
  it("computes weighted average entry across multiple buys", () => {
    // $1 for 100 tokens, $1 for 50 tokens, $2 for 150 tokens => $4 for 300 tokens
    const state = replayTrades([
      { side: "BUY", tokenAmount: 100, usdEstimate: 1 },
      { side: "BUY", tokenAmount: 50, usdEstimate: 1 },
      { side: "BUY", tokenAmount: 150, usdEstimate: 2 },
    ]);

    expect(state.tokenAmount).toBeCloseTo(300, 9);
    expect(state.totalCostUsd).toBeCloseTo(4, 9);
    expect(averageEntryPriceUsd(state)).toBeCloseTo(4 / 300, 9);
  });

  it("handles a partial sell proportionally against cost basis", () => {
    let state = applyTrade(EMPTY_COST_BASIS, {
      side: "BUY",
      tokenAmount: 100,
      usdEstimate: 10,
    });
    // Sell 25% (25 tokens) for $3.50 (up from $2.50 cost => $1 realized gain)
    state = applyTrade(state, { side: "SELL", tokenAmount: 25, usdEstimate: 3.5 });

    expect(state.tokenAmount).toBeCloseTo(75, 9);
    expect(state.totalCostUsd).toBeCloseTo(7.5, 9);
    expect(state.realizedPnlUsd).toBeCloseTo(1, 9);
  });

  it("accumulates realized P&L across several partial sells", () => {
    let state = applyTrade(EMPTY_COST_BASIS, {
      side: "BUY",
      tokenAmount: 100,
      usdEstimate: 10,
    });
    state = applyTrade(state, { side: "SELL", tokenAmount: 20, usdEstimate: 3 }); // cost 2, gain 1
    state = applyTrade(state, { side: "SELL", tokenAmount: 20, usdEstimate: 2 }); // cost 2, gain 0

    expect(state.realizedPnlUsd).toBeCloseTo(1, 9);
    expect(state.tokenAmount).toBeCloseTo(60, 9);
    expect(state.totalCostUsd).toBeCloseTo(6, 9);
  });

  it("never lets tokenAmount go negative from a full/over sell", () => {
    let state = applyTrade(EMPTY_COST_BASIS, {
      side: "BUY",
      tokenAmount: 10,
      usdEstimate: 1,
    });
    state = applyTrade(state, { side: "SELL", tokenAmount: 999, usdEstimate: 5 });
    expect(state.tokenAmount).toBe(0);
  });

  it("computes unrealized P&L from the current executable sell price", () => {
    const state = applyTrade(EMPTY_COST_BASIS, {
      side: "BUY",
      tokenAmount: 100,
      usdEstimate: 10,
    });
    // entry = $0.10/token; market moves to $0.15/token => +50%
    const result = unrealizedPnl(state, 0.15);
    expect(result?.usd).toBeCloseTo(5, 9);
    expect(result?.percent).toBeCloseTo(50, 9);
  });

  it("returns undefined P&L when there is no position", () => {
    expect(unrealizedPnl(EMPTY_COST_BASIS, 1)).toBeUndefined();
    expect(averageEntryPriceUsd(EMPTY_COST_BASIS)).toBeUndefined();
  });
});
