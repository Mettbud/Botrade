export interface WatchPoolConfig {
  label: string;
  baseVault: string;
  quoteVault: string;
  baseDecimals: number;
  quoteDecimals: number;
}

/**
 * Parses "label:baseVault:quoteVault:baseDecimals:quoteDecimals" entries,
 * comma-separated - same style as TAKE_PROFIT_LEVELS, no JSON to hand-edit.
 */
export function parseWatchPools(raw: string): WatchPoolConfig[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  return trimmed.split(",").map((entry) => {
    const parts = entry.trim().split(":");
    if (parts.length !== 5) {
      throw new Error(
        `Invalid WATCH_POOLS entry (expected label:baseVault:quoteVault:baseDecimals:quoteDecimals): "${entry}"`,
      );
    }
    const [label, baseVault, quoteVault, baseDecimalsStr, quoteDecimalsStr] = parts;
    const baseDecimals = Number(baseDecimalsStr);
    const quoteDecimals = Number(quoteDecimalsStr);
    if (!Number.isInteger(baseDecimals) || !Number.isInteger(quoteDecimals)) {
      throw new Error(`WATCH_POOLS decimals must be integers: "${entry}"`);
    }
    return { label: label!, baseVault: baseVault!, quoteVault: quoteVault!, baseDecimals, quoteDecimals };
  });
}
