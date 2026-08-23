export interface CostBasisState {
  tokenAmount: number;
  totalCostUsd: number;
  realizedPnlUsd: number;
}

export const EMPTY_COST_BASIS: CostBasisState = {
  tokenAmount: 0,
  totalCostUsd: 0,
  realizedPnlUsd: 0,
};

export interface CostBasisTradeInput {
  side: "BUY" | "SELL";
  /** Token amount involved, in UI units (already fee/slippage adjusted). */
  tokenAmount: number;
  /** Net USD spent (BUY) or received (SELL), fees already deducted. */
  usdEstimate: number;
}

/**
 * Folds one trade into a running weighted-average cost basis.
 * Pure and side-effect free: the caller owns persistence, this only owns math.
 */
export function applyTrade(
  state: CostBasisState,
  trade: CostBasisTradeInput,
): CostBasisState {
  if (trade.side === "BUY") {
    return {
      tokenAmount: state.tokenAmount + trade.tokenAmount,
      totalCostUsd: state.totalCostUsd + trade.usdEstimate,
      realizedPnlUsd: state.realizedPnlUsd,
    };
  }

  if (state.tokenAmount <= 0) {
    // Selling with no tracked position (shouldn't happen if callers guard
    // against it) - treat proceeds as pure realized gain, no cost to net out.
    return {
      tokenAmount: Math.max(0, state.tokenAmount - trade.tokenAmount),
      totalCostUsd: state.totalCostUsd,
      realizedPnlUsd: state.realizedPnlUsd + trade.usdEstimate,
    };
  }

  const sellAmount = Math.min(trade.tokenAmount, state.tokenAmount);
  const proportionSold = sellAmount / state.tokenAmount;
  const costOfSoldPortion = state.totalCostUsd * proportionSold;
  const realizedPnl = trade.usdEstimate - costOfSoldPortion;

  return {
    tokenAmount: Math.max(0, state.tokenAmount - sellAmount),
    totalCostUsd: state.totalCostUsd - costOfSoldPortion,
    realizedPnlUsd: state.realizedPnlUsd + realizedPnl,
  };
}

/** Rebuilds the current cost basis by replaying the full trade history. */
export function replayTrades(trades: CostBasisTradeInput[]): CostBasisState {
  return trades.reduce(applyTrade, EMPTY_COST_BASIS);
}

export function averageEntryPriceUsd(
  state: CostBasisState,
): number | undefined {
  if (state.tokenAmount <= 0) return undefined;
  return state.totalCostUsd / state.tokenAmount;
}

export interface UnrealizedPnl {
  usd: number;
  percent: number;
}

/** Mark-to-market P&L of the remaining position at a given executable sell price. */
export function unrealizedPnl(
  state: CostBasisState,
  currentSellPriceUsd: number,
): UnrealizedPnl | undefined {
  if (state.tokenAmount <= 0) return undefined;
  const marketValueUsd = state.tokenAmount * currentSellPriceUsd;
  const usd = marketValueUsd - state.totalCostUsd;
  const percent = state.totalCostUsd > 0 ? (usd / state.totalCostUsd) * 100 : 0;
  return { usd, percent };
}
