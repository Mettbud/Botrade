export interface TakeProfitLevel {
  /** Unrealized gain (percent) at which this level triggers. */
  gainPercent: number;
  /** Percent of the currently remaining position to sell when triggered. */
  sellPercent: number;
}

/**
 * Parses "20:20,40:20,70:100" into an ascending list of take-profit levels.
 * Throws on malformed input so bad config fails fast at startup.
 */
export function parseTakeProfitLevels(raw: string): TakeProfitLevel[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  const levels = trimmed.split(",").map((entry) => {
    const [gainStr, sellStr] = entry.trim().split(":");
    const gainPercent = Number(gainStr);
    const sellPercent = Number(sellStr);
    if (!Number.isFinite(gainPercent) || !Number.isFinite(sellPercent)) {
      throw new Error(`Invalid TAKE_PROFIT_LEVELS entry: "${entry}"`);
    }
    if (sellPercent <= 0 || sellPercent > 100) {
      throw new Error(
        `TAKE_PROFIT_LEVELS sellPercent must be in (0, 100]: "${entry}"`,
      );
    }
    return { gainPercent, sellPercent };
  });

  return [...levels].sort((a, b) => a.gainPercent - b.gainPercent);
}
