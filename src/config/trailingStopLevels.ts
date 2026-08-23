export interface TrailingStopLevel {
  /** Peak gain from entry (percent) at which this trailing-stop % kicks in. */
  gainPercent: number;
  /** Trailing-stop tolerance (percent drawdown from peak) at this level. */
  trailingStopPercent: number;
}

/**
 * Parses "gainPercent:trailingStopPercent" pairs, comma separated - same
 * format as TAKE_PROFIT_LEVELS. Empty string disables scaling entirely
 * (flat TRAILING_STOP_PERCENT is used, unchanged from before this existed).
 */
export function parseTrailingStopLevels(raw: string): TrailingStopLevel[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  const levels = trimmed.split(",").map((entry) => {
    const [gainStr, trailingStr] = entry.trim().split(":");
    const gainPercent = Number(gainStr);
    const trailingStopPercent = Number(trailingStr);
    if (!Number.isFinite(gainPercent) || !Number.isFinite(trailingStopPercent)) {
      throw new Error(`Invalid TRAILING_STOP_LEVELS entry: "${entry}"`);
    }
    if (trailingStopPercent <= 0) {
      throw new Error(
        `TRAILING_STOP_LEVELS trailingStopPercent must be > 0: "${entry}"`,
      );
    }
    return { gainPercent, trailingStopPercent };
  });

  return [...levels].sort((a, b) => a.gainPercent - b.gainPercent);
}
