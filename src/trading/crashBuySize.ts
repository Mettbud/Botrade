import type { TradeMode } from "./types.js";

/**
 * How much to spend on a crash-buy, in USD. Unlike normal auto-buy (which
 * never uses more than MAX_TRADE_USD on LIVE), crash-buy is deliberately
 * sized as a real chunk of the wallet - portfolioPercent of whatever's
 * available - because the whole point is to catch a rare, sharp crash, and
 * a $1 nibble wouldn't be worth chasing it for. maxUsd is still a hard
 * ceiling on both PAPER and LIVE, and the result never exceeds what's
 * actually available either.
 */
export function resolveCrashBuySizeUsd(
  mode: TradeMode,
  paperBalanceUsd: number,
  liveAvailableUsd: number,
  portfolioPercent: number,
  maxUsd: number,
): number {
  const available = mode === "LIVE" ? liveAvailableUsd : paperBalanceUsd;
  const sized = available * (portfolioPercent / 100);
  return Math.max(0, Math.min(sized, maxUsd, available));
}
