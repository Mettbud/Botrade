import { z } from "zod";
import { parseTakeProfitLevels } from "./takeProfitLevels.js";

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

const rawEnvSchema = z.object({
  WALLET_PRIVATE_KEY: z.string().default(""),
  RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  RPC_WS_URL: z.string().default(""),

  JUPITER_API_KEY: z.string().default(""),
  JUPITER_BASE_URL: z.string().url().default("https://lite-api.jup.ag"),

  TARGET_TOKEN_MINT: z.string().min(32),
  TARGET_TOKEN_SYMBOL: z.string().default("TOKEN"),
  SOL_MINT: z
    .string()
    .default("So11111111111111111111111111111111111111"),
  USDC_MINT: z
    .string()
    .default("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),

  TRADING_MODE: z.enum(["paper", "live"]).default("paper"),
  ENABLE_LIVE_TRADING: boolFromString,

  MAX_TRADE_USD: numFromString(1),
  MIN_SOL_RESERVE: numFromString(0.05),
  PAPER_BALANCE_USD: numFromString(100),

  MAX_SLIPPAGE_BPS: numFromString(150),
  MAX_PRICE_IMPACT_BPS: numFromString(300),

  PRICE_POLL_INTERVAL_MS: numFromString(2000),
  PRICE_REFERENCE_SOL_AMOUNT: numFromString(0.01),
  SOL_PRICE_REFRESH_MS: numFromString(10000),

  MOMENTUM_UP_10S_PCT: numFromString(5),
  MOMENTUM_UP_30S_PCT: numFromString(10),
  MOMENTUM_DOWN_10S_PCT: numFromString(5),
  MOMENTUM_DOWN_30S_PCT: numFromString(10),
  PRICE_IMPACT_SPIKE_BPS: numFromString(200),

  TAKE_PROFIT_LEVELS: z.string().default("20:20,40:20,70:100"),
  STOP_LOSS_PERCENT: numFromString(15),
  TRAILING_STOP_PERCENT: numFromString(12),
  TRAILING_STOP_ACTIVATION_PERCENT: numFromString(0),

  STOP_CONFIRMATION_ENABLED: boolFromString,
  STOP_CONFIRMATION_MS: numFromString(2000),

  PRIORITY_LEVEL: z
    .enum(["low", "medium", "high", "veryHigh"])
    .default("medium"),
  PRIORITY_MAX_LAMPORTS: numFromString(2_000_000),

  DB_PATH: z.string().default("./data/cyberleek.sqlite"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
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
    },
    risk: {
      maxSlippageBps: raw.MAX_SLIPPAGE_BPS,
      maxPriceImpactBps: raw.MAX_PRICE_IMPACT_BPS,
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
      stopLossPercent: raw.STOP_LOSS_PERCENT,
      trailingStopPercent: raw.TRAILING_STOP_PERCENT,
      trailingStopActivationPercent: raw.TRAILING_STOP_ACTIVATION_PERCENT,
      stopConfirmationEnabled: raw.STOP_CONFIRMATION_ENABLED,
      stopConfirmationMs: raw.STOP_CONFIRMATION_MS,
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
