import type { TradeMode } from "./types.js";

/**
 * How much to spend on an auto-buy, in USD.
 *
 * LIVE always uses maxTradeUsd, full stop - this is the real-money safety
 * cap and nothing about this function ever raises it. PAPER instead sizes
 * as a percent of the current paper balance, so it can realistically show
 * how a $100 pool grows/shrinks over many trades - deliberately NOT capped
 * by maxTradeUsd, since paper trades risk nothing real.
 */
export function resolveAutoBuySizeUsd(
  mode: TradeMode,
  paperBalanceUsd: number,
  maxTradeUsd: number,
  paperPositionSizePercent: number,
): number {
  if (mode === "LIVE") return maxTradeUsd;
  return paperBalanceUsd * (paperPositionSizePercent / 100);
}
