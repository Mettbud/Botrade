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
import { PoolWatcher, type WatchedPool } from "./onchain/poolWatcher.js";
import { getConnection } from "./solana/connection.js";
import { checkCrashBuyRebound } from "./strategy/crashBuyExit.js";
import { AutoBuyManager } from "./trading/autoBuyManager.js";
import { resolveAutoBuySizeUsd } from "./trading/autoBuySize.js";
import { CrashBuyManager } from "./trading/crashBuyManager.js";
import { resolveCrashBuySizeUsd } from "./trading/crashBuySize.js";
import { LiveTrader } from "./trading/liveTrader.js";
import { PaperTrader } from "./trading/paperTrader.js";
import { PositionManager } from "./trading/positionManager.js";
import type { TradeExecutor } from "./trading/tradeExecutor.js";
import { getMintDecimals, getSolBalanceSol, getTokenBalance } from "./wallet/balances.js";
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
    if (config.autoBuy.peakProtectionEnabled) {
      logger.info(
        `AUTO_BUY_PEAK_PROTECTION: after a ${config.autoBuy.peakRunUpPercent}%+ run-up within ${config.autoBuy.peakLookbackMs}ms, the required dip widens to ${Math.max(config.autoBuy.dipPercent, config.autoBuy.peakDipPercent)}%.`,
      );
    }
    if (config.autoBuy.volatilityProtectionEnabled) {
      logger.info(
        `AUTO_BUY_VOLATILITY_PROTECTION: ${config.autoBuy.volatilityLookbackMs}ms realized volatility x${config.autoBuy.volatilityMultiplier}, capped at a ${config.autoBuy.volatilityMaxDipPercent}% dip threshold.`,
      );
    }
  }
  const crashBuyManager = new CrashBuyManager(config);
  let crashBuyInFlight = false;
  let crashExitInFlight = false;
  if (config.crashBuy.enabled) {
    logger.info(
      `CRASH_BUY_ENABLED: watching for a ${config.crashBuy.dropPercent}%+ drop within ${config.crashBuy.windowMs}ms, buying immediately up to $${config.crashBuy.maxUsd} (${config.crashBuy.portfolioPercent}% of available).`,
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
    void positionManager
      .handlePriceSample(
        sample.sellPriceUsd,
        sample.priceImpactSellBps,
        sample.timestampMs,
        sample.spread,
      )
      .catch((err) => {
        // EventEmitter does not await async listeners. Without an explicit
        // catch, a transient Jupiter 429 becomes an unhandled rejection and
        // Node terminates the whole bot, taking the interactive `reset`
        // command down with it.
        const message = String((err as Error)?.message ?? err);
        lastErrorMessage = `strategy: ${message}`;
        logger.error("automatic position action failed; bot remains running", {
          err: message,
        });
      });

    if (
      autoBuyManager.evaluate(
        priceFeed.history,
        positionManager.hasOpenPosition(),
        sample.timestampMs,
        positionManager.getLastSellPriceUsd(),
      )
    ) {
      void (async () => {
        try {
          const availableUsd =
            executor instanceof PaperTrader
              ? executor.usdBalance
              : await computeLiveAvailableUsd(config, solBalance, solPrice);
          const sizeUsd = resolveAutoBuySizeUsd(
            executor.mode,
            availableUsd,
            config.trading.maxTradeUsd,
            config.trading.paperPositionSizePercent,
          );
          if (sizeUsd <= 0) {
            logger.warn("AUTO_BUY signal fired but computed size was $0 - skipped.");
            return;
          }
          logger.info(`AUTO_BUY: dip rebound detected, buying $${sizeUsd.toFixed(2)}`);
          await positionManager.manualBuy(sizeUsd, "AUTO_BUY");
        } catch (err) {
          logger.error("AUTO_BUY failed", { err: String(err) });
        }
      })();
    }

    // Crash-buy exit: if a crash-buy position is open and price has
    // recovered to within tolerance of its pre-crash reference, sell in
    // full right away rather than waiting on the normal stop-loss/trailing
    // machinery. Checked after handlePriceSample so a position that just
    // got closed by stop-loss/trailing this same tick correctly no-ops here.
    const activePreDropPriceUsd = crashBuyManager.getActivePreDropPriceUsd();
    if (!positionManager.hasOpenPosition()) {
      crashBuyManager.clearActivePosition();
    } else if (
      !crashExitInFlight &&
      activePreDropPriceUsd !== undefined &&
      checkCrashBuyRebound(
        sample.sellPriceUsd,
        activePreDropPriceUsd,
        config.crashBuy.reboundTolerancePercent,
      )
    ) {
      crashExitInFlight = true;
      logger.info(
        `CRASH_BUY_EXIT: price recovered to $${sample.sellPriceUsd.toFixed(8)} (within ${config.crashBuy.reboundTolerancePercent}% of pre-crash $${activePreDropPriceUsd.toFixed(8)}) - selling in full.`,
      );
      positionManager
        .manualSell(100, "CRASH_BUY_EXIT", sample.priceImpactSellBps)
        .then(() => crashBuyManager.clearActivePosition())
        .catch((err) => logger.error("CRASH_BUY_EXIT failed", { err: String(err) }))
        .finally(() => {
          crashExitInFlight = false;
        });
    }

    if (!crashBuyInFlight) {
      const crashSignal = crashBuyManager.evaluate(
        priceFeed.history,
        positionManager.hasOpenPosition(),
        sample.timestampMs,
      );
      if (crashSignal.shouldBuy) {
        crashBuyInFlight = true;
        void (async () => {
          try {
            const liveAvailableUsd = await computeLiveAvailableUsd(config, solBalance, solPrice);
            const sizeUsd = resolveCrashBuySizeUsd(
              executor.mode,
              executor instanceof PaperTrader ? executor.usdBalance : 0,
              liveAvailableUsd,
              config.crashBuy.portfolioPercent,
              config.crashBuy.maxUsd,
            );
            if (sizeUsd <= 0) {
              logger.warn("CRASH_BUY signal fired but computed size was $0 - skipped.");
              return;
            }
            logger.info(
              `🔻 CRASH_BUY: ${config.crashBuy.dropPercent}%+ drop detected, buying $${sizeUsd.toFixed(2)} (pre-drop $${crashSignal.preDropPriceUsd?.toFixed(8)})`,
            );
            await positionManager.manualBuy(sizeUsd, "CRASH_BUY");
          } catch (err) {
            logger.error("CRASH_BUY failed", { err: String(err) });
            crashBuyManager.clearActivePosition();
          } finally {
            crashBuyInFlight = false;
          }
        })();
      }
    }
  });
  priceFeed.on("error", (err) => {
    // Full detail already went to the log file via PriceFeed's own
    // logger.warn call - this is just the short version that stays visible
    // on the dashboard instead of flashing away on the next screen clear.
    lastErrorMessage = `⚠️ price feed: ${String((err as Error)?.message ?? err)}`;
  });

  const poolWatcher = await startPoolWatcherIfEnabled(config, connection, tokenMint, priceFeed, logger);

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
    void poolWatcher?.stop();
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
    executor,
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

/**
 * Off by default (ONCHAIN_WATCH_ENABLED=false). When on, watches each
 * configured pool's two reserve accounts directly over RPC as a fast
 * "something moved" trigger and pokes PriceFeed to check sooner - it never
 * decides a trade itself, only how soon the real Jupiter-quote check runs.
 */
async function startPoolWatcherIfEnabled(
  config: ReturnType<typeof getConfig>,
  connection: ReturnType<typeof getConnection>,
  tokenMint: PublicKey,
  priceFeed: PriceFeed,
  logger: Logger,
): Promise<PoolWatcher | undefined> {
  if (!config.onchain.watchEnabled) return undefined;
  if (config.onchain.watchPools.length === 0) {
    logger.warn("ONCHAIN_WATCH_ENABLED=true but WATCH_POOLS is empty - nothing to watch.");
    return undefined;
  }

  const solMint = new PublicKey(config.token.solMint);
  const [baseDecimals, quoteDecimals] = await Promise.all([
    getMintDecimals(connection, tokenMint),
    getMintDecimals(connection, solMint),
  ]);

  const watchedPools: WatchedPool[] = config.onchain.watchPools.map((p) => ({
    label: p.label,
    baseVault: new PublicKey(p.baseVault),
    quoteVault: new PublicKey(p.quoteVault),
  }));

  const watcher = new PoolWatcher(
    connection,
    watchedPools,
    baseDecimals,
    quoteDecimals,
    config.onchain.jumpWindowMs,
    config.onchain.jumpPercent,
  );
  watcher.on("jump", (event: { poolLabel: string; changePercent: number }) => {
    const triggered = priceFeed.triggerImmediateTick();
    const outcome = triggered
      ? "triggering an early price check"
      : "Jupiter is currently rate-limited/backing off, this jump was NOT acted on";
    logger.info(`⚡ on-chain jump: ${event.poolLabel} ${event.changePercent.toFixed(1)}% - ${outcome}`);
  });
  watcher.start();
  logger.info(
    `ONCHAIN_WATCH_ENABLED: watching ${watchedPools.length} pool(s) directly via RPC as a fast trigger.`,
  );
  return watcher;
}

/** LIVE-mode "available balance" for percent-of-balance sizing (auto-buy, crash-buy): the wallet's SOL above MIN_SOL_RESERVE, converted to USD. */
async function computeLiveAvailableUsd(
  config: ReturnType<typeof getConfig>,
  solBalance: number,
  solPrice: SolPriceTracker,
): Promise<number> {
  const solUsdPrice = await solPrice.getPrice();
  return Math.max(0, solBalance - config.trading.minSolReserve) * solUsdPrice;
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
