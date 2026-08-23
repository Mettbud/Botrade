import "dotenv/config";
import { buildConfig, type BotConfig } from "./schema.js";

export type { BotConfig } from "./schema.js";
export * from "./takeProfitLevels.js";

let cached: BotConfig | undefined;

/** Loads and validates config once per process. */
export function getConfig(): BotConfig {
  if (!cached) {
    cached = buildConfig(process.env);
  }
  return cached;
}

/**
 * Whether the bot is actually allowed to place real on-chain trades.
 * Both TRADING_MODE=live and ENABLE_LIVE_TRADING=true are required -
 * either one alone keeps the bot in paper mode. This is intentional
 * defense in depth against a single accidental config change.
 */
export function isLiveTradingArmed(config: BotConfig): boolean {
  return config.trading.mode === "live" && config.trading.liveEnabled;
}

/** Throws with a clear message if live mode is requested but not fully armed. */
export function assertLiveTradingSafe(config: BotConfig): void {
  const wantsLive =
    config.trading.mode === "live" || config.trading.liveEnabled;
  if (!wantsLive) return;

  if (!isLiveTradingArmed(config)) {
    throw new Error(
      "Live trading requires BOTH TRADING_MODE=live AND ENABLE_LIVE_TRADING=true. " +
        `Currently TRADING_MODE=${config.trading.mode}, ENABLE_LIVE_TRADING=${config.trading.liveEnabled}. ` +
        "Falling back to paper trading is not automatic here - fix your .env.",
    );
  }

  if (!config.wallet.privateKey) {
    throw new Error(
      "Live trading is armed but WALLET_PRIVATE_KEY is empty in .env.",
    );
  }
}
