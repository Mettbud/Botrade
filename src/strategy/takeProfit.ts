import type { TakeProfitLevel } from "../config/index.js";

/**
 * Returns every configured take-profit level whose gain threshold is met
 * by `gainPercent` and that isn't in `triggeredGains` yet, ascending.
 * The caller executes them one at a time and adds each gainPercent to
 * `triggeredGains` so a level only ever fires once per position.
 */
export function checkTakeProfit(
  gainPercent: number,
  levels: TakeProfitLevel[],
  triggeredGains: ReadonlySet<number>,
): TakeProfitLevel[] {
  return levels.filter(
    (level) =>
      gainPercent >= level.gainPercent && !triggeredGains.has(level.gainPercent),
  );
}
