import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { assertLiveTradingSafe, getConfig, isLiveTradingArmed } from "./config/index.js";
import { findMissingEnvKeys } from "./config/envDrift.js";
import { renderDashboard } from "./cli/dashboard.js";
import { startCommandLoop } from "./cli/commands.js";
import { openDatabase } from "./database/index.js";
import { PriceHistoryRepo } from "./database/priceHistoryRepo.js";
import { TradesRepo } from "./database/tradesRepo.js";
import { JupiterClient } from "./jupiter/client.js";
import { createLogger, type Logger } from "./logger/index.js";
import { PriceFeed } from "./market/priceFeed.js";
import { SolPriceTracker } from "./market/solPrice.js";
import { getConnection } from "./solana/connection.js";
import { AutoBuyManager } from "./trading/autoBuyManager.js";
import { LiveTrader } from "./trading/liveTrader.js";
import { PaperTrader } from "./trading/paperTrader.js";
import { PositionManager } from "./trading/positionManager.js";
import type { TradeExecutor } from "./trading/tradeExecutor.js";
import { getSolBalanceSol, getTokenBalance } from "./wallet/balances.js";
import { loadWalletKeypair } from "./wallet/keypair.js";

async function main(): Promise<void> {
  const config = getConfig();
  const logger = createLogger(config.logging.level, config.logging.filePath);
  assertLiveTradingSafe(config);
  logger.info(`Logging to ${config.logging.filePath} (dashboard clears the screen, this file doesn't)`);
  warnAboutStaleEnvFile(logger);

  const db = openDatabase(config);
  const tradesRepo = new TradesRepo(db);
  const priceHistoryRepo = new PriceHistoryRepo(db);

  const connection = getConnection(config);
  const keypair = loadWalletKeypair(config);
  const tokenMint = new PublicKey(config.token.mint);

  const client = new JupiterClient(config);
  const solPrice = new SolPriceTracker(client, config);
  const priceFeed = new PriceFeed(client, config, solPrice, connection, tokenMint, logger);

  const live = isLiveTradingArmed(config);
  const executor: TradeExecutor = live
    ? new LiveTrader(connection, client, config, solPrice, tokenMint, keypair, logger)
    : new PaperTrader(
        client,
        config,
        solPrice,
        connection,
        tokenMint,
        keypair.publicKey,
        replayPaperUsdBalance(tradesRepo, config.trading.paperBalanceUsd),
        replayPaperTokenBalance(tradesRepo),
      );

  logger.info(`Starting CYBERLEEK bot in ${executor.mode} mode`, {
    wallet: keypair.publicKey.toBase58(),
  });

  const positionManager = new PositionManager(executor, tradesRepo, config, logger);
  const autoBuyManager = new AutoBuyManager(config);
  if (config.autoBuy.enabled) {
    logger.info(
      `AUTO_BUY_ENABLED: watching for a ${config.autoBuy.dipPercent}%+ drop within ${config.autoBuy.lookbackMs}ms, then buying on the first rebound tick.`,
    );
  }

  let lastMovementMessage: string | undefined;
  let lastErrorMessage: string | undefined;
  priceFeed.on("movement", (events) => {
    for (const e of events) {
      logger.info(e.message);
      lastMovementMessage = e.message;
    }
  });
  priceFeed.on("sample", (sample) => {
    lastErrorMessage = undefined; // connectivity recovered
    // Decides whether the *next* tick fetches a real sell quote or an
    // estimate - reflecting current state here is fine since it only
    // needs to be right before the next fetch, not synchronously now.
    priceFeed.setHasOpenPosition(positionManager.hasOpenPosition());
    priceHistoryRepo.insert(sample, {
      change5s: priceFeed.history.changePercent(5_000),
      change15s: priceFeed.history.changePercent(15_000),
      change30s: priceFeed.history.changePercent(30_000),
      change1m: priceFeed.history.changePercent(60_000),
      change5m: priceFeed.history.changePercent(300_000),
    });
    void positionManager.handlePriceSample(
      sample.sellPriceUsd,
      sample.priceImpactSellBps,
      sample.timestampMs,
    );

    if (
      autoBuyManager.evaluate(
        priceFeed.history,
        positionManager.hasOpenPosition(),
        sample.timestampMs,
      )
    ) {
      logger.info(
        `AUTO_BUY: dip rebound detected, buying $${config.trading.maxTradeUsd}`,
      );
      positionManager
        .manualBuy(config.trading.maxTradeUsd, "AUTO_BUY")
        .catch((err) =>
          logger.error("AUTO_BUY failed", { err: String(err) }),
        );
    }
  });
  priceFeed.on("error", (err) => {
    // Full detail already went to the log file via PriceFeed's own
    // logger.warn call - this is just the short version that stays visible
    // on the dashboard instead of flashing away on the next screen clear.
    lastErrorMessage = `⚠️ price feed: ${String((err as Error)?.message ?? err)}`;
  });

  let solBalance = 0;
  let tokenBalance = 0;
  const refreshBalances = async () => {
    try {
      [solBalance, tokenBalance] = await Promise.all([
        getSolBalanceSol(connection, keypair.publicKey),
        getTokenBalance(connection, keypair.publicKey, tokenMint).then((b) => b.uiAmount),
      ]);
    } catch (err) {
      logger.warn("failed to refresh wallet balances", { err: String(err) });
    }
  };
  await refreshBalances();
  const balanceTimer = setInterval(() => void refreshBalances(), 5_000);

  priceFeed.start();

  const dashboardTimer = setInterval(() => {
    const sample = priceFeed.history.latest();
    const evaluation = sample ? positionManager.peek(sample.sellPriceUsd) : undefined;
    renderDashboard({
      tokenSymbol: config.token.symbol,
      mode: executor.mode,
      sample,
      changes: priceFeed.history.allChanges(),
      costBasis: positionManager.getCostBasis(),
      evaluation,
      solBalance,
      tokenBalance,
      paperUsdBalance: executor instanceof PaperTrader ? executor.usdBalance : undefined,
      lastMovementMessage,
      lastErrorMessage,
      autoBuy: autoBuyManager.status(),
      stopLossPercent: config.strategy.stopLossPercent,
      trailingStopPercent: config.strategy.trailingStopPercent,
    });
  }, config.cli.dashboardRefreshMs);

  const shutdown = () => {
    clearInterval(dashboardTimer);
    clearInterval(balanceTimer);
    priceFeed.stop();
    db.close();
    logger.info("Bot stopped.");
    process.exit(0);
  };

  startCommandLoop({
    positionManager,
    priceFeed,
    client,
    connection,
    tokenMint,
    config,
    logger,
    onExit: shutdown,
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * .env is git-ignored and never touched by `git pull` - a .env created
 * before some new option was added to .env.example just silently lacks
 * it (the schema default kicks in, so nothing breaks), which reads as
 * "I set this and it's being ignored" instead of "this line isn't there
 * at all". Loud but non-fatal: defaults still work fine either way.
 */
function warnAboutStaleEnvFile(logger: Logger): void {
  try {
    const exampleContent = readFileSync(
      new URL("../.env.example", import.meta.url),
      "utf-8",
    );
    const missing = findMissingEnvKeys(exampleContent, process.env);
    if (missing.length > 0) {
      logger.warn(
        `.env is missing ${missing.length} newer setting(s) from .env.example (using defaults): ${missing.join(", ")}`,
      );
    }
  } catch {
    // .env.example not found next to the build (e.g. some deploy layouts) - not fatal.
  }
}

function replayPaperUsdBalance(repo: TradesRepo, startingUsd: number): number {
  let usdBalance = startingUsd;
  for (const t of repo.findAll()) {
    if (t.mode !== "PAPER") continue;
    usdBalance += t.side === "BUY" ? -t.usdEstimate : t.usdEstimate;
  }
  return usdBalance;
}

function replayPaperTokenBalance(repo: TradesRepo): number {
  let tokenAmount = 0;
  for (const t of repo.findAll()) {
    if (t.mode !== "PAPER") continue;
    tokenAmount += t.side === "BUY" ? t.tokenAmount : -t.tokenAmount;
  }
  return Math.max(0, tokenAmount);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
