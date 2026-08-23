import type { TradeReason } from "./types.js";

export interface SpreadGuardConfig {
  maxSpreadBps: number;
  maxSpreadHighGainBps: number;
  maxSpreadHighGainThresholdPercent: number;
}

/**
 * Which spread cap (if any) applies to an automatic sell, given why it's
 * firing and the position's current unrealized gain. Returns undefined to
 * mean "no cap" - used for STOP_LOSS/PANIC_EXIT, where getting out of a bad
 * position matters more than the spread it costs (same reasoning as
 * PANIC_EXIT already bypassing the price-impact guard). TAKE_PROFIT/
 * TRAILING_STOP/MANUAL get the tighter base cap normally, or the looser
 * "high gain" cap once unrealized gain clears maxSpreadHighGainThresholdPercent
 * - don't block locking in a big win over a slightly wider spread.
 */
export function resolveMaxSpreadBps(
  reason: TradeReason,
  unrealizedGainPercent: number | undefined,
  config: SpreadGuardConfig,
): number | undefined {
  if (reason === "STOP_LOSS" || reason === "PANIC_EXIT") return undefined;

  const gain = unrealizedGainPercent ?? 0;
  return gain > config.maxSpreadHighGainThresholdPercent
    ? config.maxSpreadHighGainBps
    : config.maxSpreadBps;
}
