import type { TrailingStopLevel } from "../config/trailingStopLevels.js";

/**
 * Picks the trailing-stop tolerance for the current peak gain: the highest
 * level whose threshold the peak has reached, or `defaultPercent` if no
 * level applies yet (including when `levels` is empty - scaling off).
 * Bigger peak gain -> looser tolerance, so normal volatility near a big
 * pump doesn't shake out a position that's still hugely in profit.
 */
export function resolveTrailingStopPercent(
  peakGainPercent: number,
  levels: TrailingStopLevel[],
  defaultPercent: number,
): number {
  let resolved = defaultPercent;
  for (const level of levels) {
    if (peakGainPercent >= level.gainPercent) {
      resolved = level.trailingStopPercent;
    }
  }
  return resolved;
}
