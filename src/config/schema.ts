import { z } from "zod";
import { parseTakeProfitLevels } from "./takeProfitLevels.js";
import { parseTrailingStopLevels } from "./trailingStopLevels.js";
import { parseWatchPools } from "./watchPools.js";

const boolFromString = z
  .string()
  .default("false")
  .transform((v) => v.trim().toLowerCase() === "true");

const numFromString = (fallback: number) =>
  z
    .string()
    .default(String(fallback))
    .transform((v) => Number(v))
    .pipe(z.number().finite());

const boundedNumberFromString = (
  fallback: number,
  minimum: number,
  maximum: number,
) =>
  z
    .string()
    .default(String(fallback))
    .transform((v) => Number(v))
    .pipe(z.number().finite().min(minimum).max(maximum));

const percentFromString = (fallback: number) =>
  boundedNumberFromString(fallback, 0, 100);

const positiveMillisecondsFromString = (fallback: number) =>
  z
    .string()
    .default(String(fallback))
    .transform((v) => Number(v))
    .pipe(z.number().int().positive());

const trueByDefaultBoolFromString = z
  .string()
  .default("true")
  .transform((v) => v.trim().toLowerCase() === "true");

const rawEnvSchema = z.object({
  WALLET_PRIVATE_KEY: z.string().default(""),
  RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  RPC_WS_URL: z.string().default(""),

  // .trim() for the same reason as the mint addresses above: a stray
  // newline/space pasted from a text editor makes the key non-empty (so it
  // silently "activates") but invalid, so requests still fall back to the
  // anonymous rate limit with no obvious error pointing at the key itself.
  JUPITER_API_KEY: z.string().trim().default(""),
  JUPITER_BASE_URL: z.string().trim().url().default("https://lite-api.jup.ag"),

  // .trim() guards against a stray trailing space/newline sneaking in when
  // an address is pasted from a text editor - Jupiter rejects those with an
  // opaque "cannot be parsed: WrongSize" instead of anything obviously
  // pointing at whitespace.
  TARGET_TOKEN_MINT: z.string().trim().min(32),
  TARGET_TOKEN_SYMBOL: z.string().trim().default("TOKEN"),
  SOL_MINT: z
    .string()
    .trim()
    .default("So11111111111111111111111111111111111111112"),
  USDC_MINT: z
    .string()
    .trim()
    .default("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),

  TRADING_MODE: z.enum(["paper", "live"]).default("paper"),
  ENABLE_LIVE_TRADING: boolFromString,

  MAX_TRADE_USD: numFromString(1),
  MIN_SOL_RESERVE: numFromString(0.05),
  PAPER_BALANCE_USD: numFromString(100),
  // Auto-buy sizing in PAPER mode only: percent of the current paper
  // balance to spend per auto-buy. Never applies to LIVE - live auto-buys
  // always use MAX_TRADE_USD, no matter what this is set to.
  PAPER_POSITION_SIZE_PERCENT: numFromString(5),

  MAX_SLIPPAGE_BPS: numFromString(150),
  MAX_PRICE_IMPACT_BPS: numFromString(300),
  // Blocks an automatic TAKE_PROFIT/TRAILING_STOP sell if the current
  // spread exceeds this. Deliberately does NOT apply to STOP_LOSS or
  // PANIC_EXIT - getting out of a bad position matters more than the
  // spread it costs, same reasoning as PANIC_EXIT already bypassing the
  // price-impact guard.
  MAX_SPREAD_BPS: numFromString(50),
  // A looser cap used instead of MAX_SPREAD_BPS once the position's
  // unrealized gain exceeds MAX_SPREAD_HIGH_GAIN_THRESHOLD_PERCENT - don't
  // block locking in a big win over a slightly wider spread.
  MAX_SPREAD_HIGH_GAIN_BPS: numFromString(100),
  MAX_SPREAD_HIGH_GAIN_THRESHOLD_PERCENT: numFromString(10),

  PRICE_POLL_INTERVAL_MS: numFromString(2000),
  PRICE_REFERENCE_SOL_AMOUNT: numFromString(0.01),
  SOL_PRICE_REFRESH_MS: numFromString(10000),

  MOMENTUM_UP_10S_PCT: numFromString(5),
  MOMENTUM_UP_30S_PCT: numFromString(10),
  MOMENTUM_DOWN_10S_PCT: numFromString(5),
  MOMENTUM_DOWN_30S_PCT: numFromString(10),
  PRICE_IMPACT_SPIKE_BPS: numFromString(200),

  TAKE_PROFIT_LEVELS: z.string().default("20:20,40:20,70:100"),
  // "entry" (default): TAKE_PROFIT_LEVELS is a fixed ladder measured from
  // the original entry price - unchanged legacy behavior. "cascade": ignores
  // TAKE_PROFIT_LEVELS and instead repeats one rule forever - "+X% from the
  // last tranche's sell price -> sell Y% of what's left" - so gains keep
  // compounding with the trend instead of stopping after a fixed 3 levels.
  TAKE_PROFIT_MODE: z.enum(["entry", "cascade"]).default("entry"),
  CASCADE_TAKE_PROFIT_PERCENT: numFromString(20),
  CASCADE_TAKE_PROFIT_SELL_PERCENT: numFromString(20),
  STOP_LOSS_PERCENT: numFromString(15),
  TRAILING_STOP_PERCENT: numFromString(12),
  TRAILING_STOP_ACTIVATION_PERCENT: numFromString(0),
  // "gainPercent:trailingStopPercent" pairs, comma separated. Empty (default)
  // disables scaling - flat TRAILING_STOP_PERCENT is used regardless of gain.
  TRAILING_STOP_LEVELS: z.string().default(""),

  STOP_CONFIRMATION_ENABLED: boolFromString,
  STOP_CONFIRMATION_MS: numFromString(2000),

  // Off by default - a deliberate opt-in separate from TRADING_MODE/
  // ENABLE_LIVE_TRADING, since this decides WHEN to enter a position at
  // all rather than just how to exit one. Only ever buys while flat (no
  // open position), and always still through MAX_TRADE_USD.
  AUTO_BUY_ENABLED: boolFromString,
  // How far price must drop from its recent high, within AUTO_BUY_DIP_LOOKBACK_MS,
  // before the bot starts watching for a rebound to buy into.
  AUTO_BUY_DIP_PERCENT: numFromString(50),
  AUTO_BUY_DIP_LOOKBACK_MS: numFromString(60_000),
  // A 2% dip is useful in calm trading but too sensitive immediately after
  // a pump. When the low-to-high run-up crosses this threshold inside the
  // peak lookback, require the wider peak dip before watching for a rebound.
  AUTO_BUY_PEAK_PROTECTION_ENABLED: trueByDefaultBoolFromString,
  AUTO_BUY_PEAK_LOOKBACK_MS: positiveMillisecondsFromString(300_000),
  AUTO_BUY_PEAK_RUNUP_PERCENT: percentFromString(10),
  AUTO_BUY_PEAK_DIP_PERCENT: percentFromString(8),
  // Continuous volatility protection. Realized volatility is calculated
  // from consecutive price returns, doubled into a dip threshold and capped
  // at 12%. The final threshold is the strictest of base/peak/volatility.
  AUTO_BUY_VOLATILITY_PROTECTION_ENABLED: trueByDefaultBoolFromString,
  AUTO_BUY_VOLATILITY_LOOKBACK_MS: positiveMillisecondsFromString(60_000),
  AUTO_BUY_VOLATILITY_MULTIPLIER: boundedNumberFromString(2, 0, 10),
  AUTO_BUY_VOLATILITY_MAX_DIP_PERCENT: percentFromString(12),
  // Off by default: auto-buy only fires while completely flat. When true,
  // it also fires while already holding a position (averaging in on each
  // new qualifying dip) - meaningfully more risk (can keep buying into a
  // token that keeps falling), off by default for that reason.
  AUTO_BUY_ALLOW_AVERAGING: boolFromString,
  // Minimum time between two auto-buys, regardless of how often the dip
  // signal fires. Low default is a technical safety minimum, not a
  // strategy choice - raise it for deliberate spacing between buys.
  AUTO_BUY_MIN_GAP_MS: numFromString(3_000),
  // On by default: a rebound buy is only executed if the price is below
  // the most recent sell's executable price this run - never re-enter
  // worse than where you just exited. No effect until at least one sell
  // has happened (nothing to compare against yet).
  AUTO_BUY_REQUIRE_BELOW_LAST_SELL: z
    .string()
    .default("true")
    .transform((v) => v.trim().toLowerCase() === "true"),

  // Off by default - a deliberate, separate opt-in from AUTO_BUY. Detects a
  // very fast, sharp drop (CRASH_BUY_DROP_PERCENT within CRASH_BUY_WINDOW_MS,
  // measured on the live executable USD price history) and buys immediately
  // instead of waiting for a dip->rebound like normal auto-buy - still
  // always through a real Jupiter quote, never a raw on-chain swap. Only
  // buys while flat. Sized as a real chunk of the wallet on purpose (see
  // CRASH_BUY_PORTFOLIO_PERCENT/CRASH_BUY_MAX_USD) since the whole point is
  // to catch a real, rare crash - a $1 nibble wouldn't be worth chasing it for.
  CRASH_BUY_ENABLED: boolFromString,
  CRASH_BUY_DROP_PERCENT: numFromString(20),
  CRASH_BUY_WINDOW_MS: numFromString(1000),
  // Hard USD ceiling for a single crash-buy - a separate, higher cap from
  // MAX_TRADE_USD (which stays the normal per-trade limit everywhere else).
  CRASH_BUY_MAX_USD: numFromString(50),
  CRASH_BUY_PORTFOLIO_PERCENT: numFromString(50),
  // Exit rule for a crash-buy position: sell in full once price recovers to
  // within this tolerance of the price right before the crash (P0) - i.e.
  // price >= P0 * (1 - tolerance/100). Until then the position just sits
  // under the normal STOP_LOSS_PERCENT/TRAILING_STOP_PERCENT protection.
  CRASH_BUY_REBOUND_TOLERANCE_PERCENT: numFromString(3),
  // A genuine crash naturally widens spread - too tight a limit would
  // block crash-buy right when it's meant to fire. This ceiling exists to
  // reject the extreme, pathological case (a near-drained/rugged pool),
  // not normal crash volatility - deliberately looser than everyday
  // trading would tolerate.
  CRASH_BUY_MAX_SPREAD_BPS: numFromString(500),

  // Off by default. Watches raw pool reserve accounts directly over RPC as
  // a fast "something moved" trigger - never the price a trade is decided
  // on (that's always a fresh Jupiter quote). See src/onchain/.
  ONCHAIN_WATCH_ENABLED: boolFromString,
  ONCHAIN_JUMP_PERCENT: numFromString(5),
  ONCHAIN_JUMP_WINDOW_MS: numFromString(3_000),
  // "label:baseVault:quoteVault:baseDecimals:quoteDecimals" per pool, comma separated.
  WATCH_POOLS: z.string().default(""),

  PRIORITY_LEVEL: z
    .enum(["low", "medium", "high", "veryHigh"])
    .default("medium"),
  PRIORITY_MAX_LAMPORTS: numFromString(2_000_000),

  DB_PATH: z.string().default("./data/cyberleek.sqlite"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // The live dashboard clears the terminal every second, so anything only
  // printed to the console can flash and disappear - this file is the
  // durable, always-readable copy of every log line.
  LOG_FILE: z.string().default("./data/bot.log"),
  DASHBOARD_REFRESH_MS: numFromString(1000),
});

export type RawEnv = z.infer<typeof rawEnvSchema>;

export function parseRawEnv(env: NodeJS.ProcessEnv): RawEnv {
  return rawEnvSchema.parse(env);
}

export function buildConfig(env: NodeJS.ProcessEnv) {
  const raw = parseRawEnv(env);

  return {
    wallet: {
      privateKey: raw.WALLET_PRIVATE_KEY,
    },
    rpc: {
      url: raw.RPC_URL,
      wsUrl: raw.RPC_WS_URL || deriveWsUrl(raw.RPC_URL),
    },
    jupiter: {
      apiKey: raw.JUPITER_API_KEY,
      baseUrl: raw.JUPITER_API_KEY
        ? raw.JUPITER_BASE_URL.replace("lite-api.jup.ag", "api.jup.ag")
        : raw.JUPITER_BASE_URL,
    },
    token: {
      mint: raw.TARGET_TOKEN_MINT,
      symbol: raw.TARGET_TOKEN_SYMBOL,
      solMint: raw.SOL_MINT,
      usdcMint: raw.USDC_MINT,
    },
    trading: {
      mode: raw.TRADING_MODE,
      liveEnabled: raw.ENABLE_LIVE_TRADING,
      maxTradeUsd: raw.MAX_TRADE_USD,
      minSolReserve: raw.MIN_SOL_RESERVE,
      paperBalanceUsd: raw.PAPER_BALANCE_USD,
      paperPositionSizePercent: raw.PAPER_POSITION_SIZE_PERCENT,
    },
    risk: {
      maxSlippageBps: raw.MAX_SLIPPAGE_BPS,
      maxPriceImpactBps: raw.MAX_PRICE_IMPACT_BPS,
      maxSpreadBps: raw.MAX_SPREAD_BPS,
      maxSpreadHighGainBps: raw.MAX_SPREAD_HIGH_GAIN_BPS,
      maxSpreadHighGainThresholdPercent: raw.MAX_SPREAD_HIGH_GAIN_THRESHOLD_PERCENT,
    },
    price: {
      pollIntervalMs: raw.PRICE_POLL_INTERVAL_MS,
      referenceSolAmount: raw.PRICE_REFERENCE_SOL_AMOUNT,
      solPriceRefreshMs: raw.SOL_PRICE_REFRESH_MS,
    },
    movement: {
      up10sPct: raw.MOMENTUM_UP_10S_PCT,
      up30sPct: raw.MOMENTUM_UP_30S_PCT,
      down10sPct: raw.MOMENTUM_DOWN_10S_PCT,
      down30sPct: raw.MOMENTUM_DOWN_30S_PCT,
      priceImpactSpikeBps: raw.PRICE_IMPACT_SPIKE_BPS,
    },
    strategy: {
      takeProfitLevels: parseTakeProfitLevels(raw.TAKE_PROFIT_LEVELS),
      takeProfitMode: raw.TAKE_PROFIT_MODE,
      cascadeTakeProfitPercent: raw.CASCADE_TAKE_PROFIT_PERCENT,
      cascadeTakeProfitSellPercent: raw.CASCADE_TAKE_PROFIT_SELL_PERCENT,
      stopLossPercent: raw.STOP_LOSS_PERCENT,
      trailingStopPercent: raw.TRAILING_STOP_PERCENT,
      trailingStopActivationPercent: raw.TRAILING_STOP_ACTIVATION_PERCENT,
      trailingStopLevels: parseTrailingStopLevels(raw.TRAILING_STOP_LEVELS),
      stopConfirmationEnabled: raw.STOP_CONFIRMATION_ENABLED,
      stopConfirmationMs: raw.STOP_CONFIRMATION_MS,
    },
    autoBuy: {
      enabled: raw.AUTO_BUY_ENABLED,
      dipPercent: raw.AUTO_BUY_DIP_PERCENT,
      lookbackMs: raw.AUTO_BUY_DIP_LOOKBACK_MS,
      peakProtectionEnabled: raw.AUTO_BUY_PEAK_PROTECTION_ENABLED,
      peakLookbackMs: raw.AUTO_BUY_PEAK_LOOKBACK_MS,
      peakRunUpPercent: raw.AUTO_BUY_PEAK_RUNUP_PERCENT,
      peakDipPercent: raw.AUTO_BUY_PEAK_DIP_PERCENT,
      volatilityProtectionEnabled:
        raw.AUTO_BUY_VOLATILITY_PROTECTION_ENABLED,
      volatilityLookbackMs: raw.AUTO_BUY_VOLATILITY_LOOKBACK_MS,
      volatilityMultiplier: raw.AUTO_BUY_VOLATILITY_MULTIPLIER,
      volatilityMaxDipPercent: raw.AUTO_BUY_VOLATILITY_MAX_DIP_PERCENT,
      allowAveraging: raw.AUTO_BUY_ALLOW_AVERAGING,
      minGapMs: raw.AUTO_BUY_MIN_GAP_MS,
      requireBelowLastSell: raw.AUTO_BUY_REQUIRE_BELOW_LAST_SELL,
    },
    crashBuy: {
      enabled: raw.CRASH_BUY_ENABLED,
      dropPercent: raw.CRASH_BUY_DROP_PERCENT,
      windowMs: raw.CRASH_BUY_WINDOW_MS,
      maxUsd: raw.CRASH_BUY_MAX_USD,
      portfolioPercent: raw.CRASH_BUY_PORTFOLIO_PERCENT,
      reboundTolerancePercent: raw.CRASH_BUY_REBOUND_TOLERANCE_PERCENT,
      maxSpreadBps: raw.CRASH_BUY_MAX_SPREAD_BPS,
    },
    onchain: {
      watchEnabled: raw.ONCHAIN_WATCH_ENABLED,
      jumpPercent: raw.ONCHAIN_JUMP_PERCENT,
      jumpWindowMs: raw.ONCHAIN_JUMP_WINDOW_MS,
      watchPools: parseWatchPools(raw.WATCH_POOLS),
    },
    execution: {
      priorityLevel: raw.PRIORITY_LEVEL,
      priorityMaxLamports: raw.PRIORITY_MAX_LAMPORTS,
    },
    storage: {
      dbPath: raw.DB_PATH,
    },
    logging: {
      level: raw.LOG_LEVEL,
      filePath: raw.LOG_FILE,
    },
    cli: {
      dashboardRefreshMs: raw.DASHBOARD_REFRESH_MS,
    },
  };
}

export type BotConfig = ReturnType<typeof buildConfig>;

function deriveWsUrl(rpcUrl: string): string {
  return rpcUrl.replace(/^http/, "ws");
}
