import type { TradeMode } from "./types.js";

/**
 * How much to spend on an auto-buy, in USD. Both PAPER and LIVE size as
 * positionSizePercent% of `availableUsd` (PAPER's simulated balance, or
 * LIVE's real SOL balance above MIN_SOL_RESERVE converted to USD) - so
 * paper trading actually previews what live will do, not a different
 * strategy. The one asymmetry that remains: LIVE is additionally capped at
 * `maxTradeUsd` (the real-money safety ceiling - raise it in .env if you
 * want bigger live trades), while PAPER is deliberately left uncapped by
 * it, since paper trades risk nothing real and the whole point can be
 * previewing sizes larger than maxTradeUsd.
 */
export function resolveAutoBuySizeUsd(
  mode: TradeMode,
  availableUsd: number,
  maxTradeUsd: number,
  positionSizePercent: number,
): number {
  const sized = Math.max(0, availableUsd) * (positionSizePercent / 100);
  if (mode === "LIVE") return Math.min(sized, maxTradeUsd);
  return sized;
}
