export interface WatchPoolConfig {
  label: string;
  baseVault: string;
  quoteVault: string;
}

/**
 * Parses "label:baseVault:quoteVault" entries, comma-separated - same
 * style as TAKE_PROFIT_LEVELS, no JSON to hand-edit. Decimals aren't part
 * of this config: every watched pool is assumed to be TARGET_TOKEN_MINT
 * vs SOL_MINT, so decimals are read from the chain once at startup
 * instead of asking the user to type them in (and risk a wrong guess).
 */
export function parseWatchPools(raw: string): WatchPoolConfig[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  return trimmed.split(",").map((entry) => {
    const parts = entry.trim().split(":");
    if (parts.length !== 3) {
      throw new Error(
        `Invalid WATCH_POOLS entry (expected label:baseVault:quoteVault): "${entry}"`,
      );
    }
    const [label, baseVault, quoteVault] = parts;
    return { label: label!, baseVault: baseVault!, quoteVault: quoteVault! };
  });
}
