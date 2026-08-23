import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { assertLiveTradingSafe, getConfig, isLiveTradingArmed } from "./config/index.js";
import { findMissingEnvKeys } from "./config/envDrift.js";
import {
  renderDashboard,
  type CascadeDashboardStatus,
  type CrashBuyDashboardStatus,
  type ProfitLockDashboardStatus,
} from "./cli/dashboard.js";
import {
  startCommandLoop,
  type CrashLotSnapshot,
} from "./cli/commands.js";
import { openDatabase } from "./database/index.js";
import { PriceHistoryRepo } from "./database/priceHistoryRepo.js";
import { TrailingStateRepo } from "./database/trailingStateRepo.js";
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
import { AutomationEpoch } from "./trading/automationEpoch.js";
import { CrashBuyManager } from "./trading/crashBuyManager.js";
import { resolveCrashBuySizeUsd } from "./trading/crashBuySize.js";
import { LiveTrader } from "./trading/liveTrader.js";
import { PaperTrader } from "./trading/paperTrader.js";
import { PositionManager } from "./trading/positionManager.js";
import type { TradeExecutor } from "./trading/tradeExecutor.js";
import type { Trade } from "./trading/types.js";
import { getMintDecimals, getSolBalanceSol, getTokenBalance } from "./wallet/balances.js";
import { loadWalletKeypair } from "./wallet/keypair.js";

interface RetainedCrashEvent {
  message: string;
  timestampMs: number;
}

const POSITION_EPSILON = 1e-12;

async function main(): Promise<void> {
  const config = getConfig();
  const logger = createLogger(config.logging.level, config.logging.filePath);
  assertLiveTradingSafe(config);
  logger.info(`Logging to ${config.logging.filePath} (dashboard clears the screen, this file doesn't)`);
  warnAboutStaleEnvFile(logger);

  const db = openDatabase(config);
  const tradesRepo = new TradesRepo(db);
  const trailingStateRepo = new TrailingStateRepo(db);
  const priceHistoryRepo = new PriceHistoryRepo(db);

  const connection = getConnection(config);
  const keypair = loadWalletKeypair(config);
  const tokenMint = new PublicKey(config.token.mint);

  const client = new JupiterClient(config);
  const solPrice = new SolPriceTracker(client, config);
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
  logger.info(
    `Jupiter queue: one request every >=${config.jupiter.minRequestIntervalMs}ms, up to ${config.jupiter.max429Retries} retries after HTTP 429.`,
  );

  const positionManager = new PositionManager(
    executor,
    tradesRepo,
    config,
    logger,
    trailingStateRepo,
  );
  const priceFeed = new PriceFeed(
    client,
    config,
    solPrice,
    connection,
    tokenMint,
    logger,
    { hasOpenPosition: () => positionManager.hasOpenPosition() },
  );
  const autoBuyManager = new AutoBuyManager(config);
  const automationEpoch = new AutomationEpoch();
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
  let autoBuyInFlight = false;
  let crashBuyInFlight = false;
  let crashExitInFlight = false;
  let lastCrashError: { message: string; timestampMs: number } | undefined;
  let retainedCrashEvent: RetainedCrashEvent | undefined;
  if (config.crashBuy.enabled) {
    const sizeLimit =
      config.trading.mode === "paper"
        ? "without a PAPER dollar cap"
        : `up to $${config.crashBuy.maxUsd}`;
    logger.info(
      `CRASH_BUY_ENABLED: watching for a ${config.crashBuy.dropPercent}%+ drop within ${config.crashBuy.windowMs}ms, buying immediately ${sizeLimit} (${config.crashBuy.portfolioPercent}% of available).`,
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
    priceHistoryRepo.insert(sample, {
      change5s: priceFeed.history.changePercent(5_000),
      change15s: priceFeed.history.changePercent(15_000),
      change30s: priceFeed.history.changePercent(30_000),
      change1m: priceFeed.history.changePercent(60_000),
      change5m: priceFeed.history.changePercent(300_000),
    });
    const strategyEpoch = automationEpoch.capture();
    const crashLotBeforeStrategy = snapshotActiveCrashLot(positionManager);
    const latestTradeIdBeforeStrategy = crashLotBeforeStrategy
      ? latestTradeId(tradesRepo, executor.mode)
      : 0;
    void positionManager
      .handlePriceSample(
        sample.sellPriceUsd,
        sample.priceImpactSellBps,
        sample.timestampMs,
        sample.spread,
      )
      .then(() => {
        if (!automationEpoch.isCurrent(strategyEpoch)) return;
        const globalSell = crashLotBeforeStrategy
          ? tradesRepo
              .findAll()
              .find(
                (trade) =>
                  trade.id > latestTradeIdBeforeStrategy &&
                  trade.mode === executor.mode &&
                  trade.side === "SELL",
              )
          : undefined;
        retainedCrashEvent = retainCrashReductionEvent(
          positionManager,
          crashLotBeforeStrategy,
          globalSell,
          retainedCrashEvent,
        );
      })
      .catch((err) => {
        // EventEmitter does not await async listeners. Without an explicit
        // catch, a transient Jupiter 429 becomes an unhandled rejection and
        // Node terminates the whole bot, taking the interactive `reset`
        // command down with it.
        if (!automationEpoch.isCurrent(strategyEpoch)) return;
        const message = String((err as Error)?.message ?? err);
        lastErrorMessage = `strategy: ${message}`;
        logger.error("automatic position action failed; bot remains running", {
          err: message,
        });
      });

    if (
      !autoBuyInFlight &&
      !crashBuyInFlight &&
      autoBuyManager.evaluate(
        priceFeed.history,
        positionManager.hasOpenPosition(),
        sample.timestampMs,
        positionManager.getLastSellPriceUsd(),
      )
    ) {
      autoBuyInFlight = true;
      const operationEpoch = automationEpoch.capture();
      void (async () => {
        try {
          const availableUsd =
            executor instanceof PaperTrader
              ? executor.usdBalance
              : await computeLiveAvailableUsd(config, solBalance, solPrice);
          if (!automationEpoch.isCurrent(operationEpoch)) return;
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
          if (!automationEpoch.isCurrent(operationEpoch)) return;
          logger.error("AUTO_BUY failed", { err: String(err) });
        } finally {
          if (automationEpoch.isCurrent(operationEpoch)) {
            autoBuyInFlight = false;
          }
        }
      })();
    }

    // Crash rebound exits are quantity-exact and serialized behind any
    // regular strategy action from this sample. A regular position sharing
    // the wallet is never included in this sell.
    const activeCrashLot = positionManager.getActiveCrashLot();
    if (
      !crashExitInFlight &&
      !positionManager.isCrashAutomationPaused() &&
      activeCrashLot !== undefined &&
      checkCrashBuyRebound(
        sample.sellPriceUsd,
        activeCrashLot.preDropPriceUsd,
        config.crashBuy.reboundTolerancePercent,
      )
    ) {
      crashExitInFlight = true;
      const operationEpoch = automationEpoch.capture();
      logger.info(
        `CRASH_BUY_EXIT: recovered to $${sample.sellPriceUsd.toFixed(8)} near P0 $${activeCrashLot.preDropPriceUsd.toFixed(8)} - selling only isolated lot ${activeCrashLot.tokenAmount.toFixed(4)}.`,
      );
      positionManager
        .exitCrashLot(sample.priceImpactSellBps, activeCrashLot.crashLotId)
        .then(() => {
          if (!automationEpoch.isCurrent(operationEpoch)) return;
          lastCrashError = undefined;
        })
        .catch((err) => {
          if (!automationEpoch.isCurrent(operationEpoch)) return;
          const message = String((err as Error)?.message ?? err);
          lastCrashError = { message, timestampMs: Date.now() };
          logger.error("CRASH_BUY_EXIT failed", { err: message });
        })
        .finally(() => {
          if (automationEpoch.isCurrent(operationEpoch)) {
            crashExitInFlight = false;
          }
        });
    }

    if (
      !crashBuyInFlight &&
      !autoBuyInFlight &&
      !crashExitInFlight &&
      !positionManager.isCrashAutomationPaused()
    ) {
      const crashSignal = crashBuyManager.evaluate(
        priceFeed.history,
        positionManager.hasActiveCrashLot(),
        sample.timestampMs,
      );
      if (crashSignal.shouldBuy) {
        crashBuyInFlight = true;
        const operationEpoch = automationEpoch.capture();
        void (async () => {
          try {
            const preDropPriceUsd = crashSignal.preDropPriceUsd;
            if (preDropPriceUsd === undefined) {
              throw new Error("CRASH_BUY signal is missing its pre-drop reference");
            }
            if (sample.sellIsEstimated) {
              const freshSample = await priceFeed.fetchFreshRoundTripSample();
              if (!automationEpoch.isCurrent(operationEpoch)) return;
              if (
                !crashBuyManager.isSignalStillValid(
                  freshSample.sellPriceUsd,
                  freshSample.spread,
                  preDropPriceUsd,
                )
              ) {
                logger.warn(
                  "CRASH_BUY signal disappeared or fresh spread was too wide - skipped after round-trip preflight.",
                );
                return;
              }
            }
            const liveAvailableUsd =
              executor instanceof PaperTrader
                ? 0
                : await computeLiveAvailableUsd(config, solBalance, solPrice);
            if (!automationEpoch.isCurrent(operationEpoch)) return;
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
            await positionManager.crashBuy(sizeUsd, preDropPriceUsd);
            if (!automationEpoch.isCurrent(operationEpoch)) return;
            lastCrashError = undefined;
          } catch (err) {
            if (!automationEpoch.isCurrent(operationEpoch)) return;
            const message = String((err as Error)?.message ?? err);
            lastCrashError = { message, timestampMs: Date.now() };
            logger.error("CRASH_BUY failed", { err: message });
          } finally {
            if (automationEpoch.isCurrent(operationEpoch)) {
              crashBuyInFlight = false;
            }
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
    const nowMs = Date.now();
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
      cascade: buildCascadeDashboardStatus(
        config,
        positionManager,
        sample?.sellPriceUsd,
        nowMs,
      ),
      profitLock: buildProfitLockDashboardStatus(
        config,
        positionManager,
        sample?.sellPriceUsd,
      ),
      crashBuy: buildCrashBuyDashboardStatus(
        config,
        positionManager,
        sample?.sellPriceUsd,
        crashBuyInFlight,
        crashExitInFlight,
        lastCrashError,
        retainedCrashEvent,
        nowMs,
      ),
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
    onPaperReset: () => {
      automationEpoch.invalidate();
      autoBuyInFlight = false;
      crashBuyInFlight = false;
      crashExitInFlight = false;
      autoBuyManager.reset();
      priceFeed.resetSession();
      lastMovementMessage = undefined;
      lastErrorMessage = undefined;
      lastCrashError = undefined;
      retainedCrashEvent = undefined;
    },
    onTradeCompleted: (trade, crashLotBefore) => {
      retainedCrashEvent = retainCrashReductionEvent(
        positionManager,
        crashLotBefore,
        trade,
        retainedCrashEvent,
      );
    },
    onExit: shutdown,
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function buildCascadeDashboardStatus(
  config: ReturnType<typeof getConfig>,
  positionManager: PositionManager,
  currentSellPriceUsd: number | undefined,
  nowMs: number,
): CascadeDashboardStatus {
  const configured = config.strategy.takeProfitMode === "cascade";
  const cycle = positionManager.getCascadeCycle();
  const status = currentSellPriceUsd === undefined
    ? undefined
    : positionManager.getCascadeStatus(currentSellPriceUsd);
  const lastExecution = positionManager.getLastCascadeExecution();
  const sellPercent = config.strategy.cascadeTakeProfitSellPercent;
  const completedTranches =
    cycle?.completedTranches ?? lastExecution?.trancheNumber ?? 0;

  return {
    enabled: configured && !positionManager.hasLegacyCascadeState(),
    completedTranches,
    maxTranches: sellPercent > 0 ? Math.ceil(100 / sellPercent) : undefined,
    soldInitialPercent:
      cycle && cycle.initialTokenAmount > 0
        ? Math.min(
            100,
            (cycle.cascadeSoldTokenAmount / cycle.initialTokenAmount) * 100,
          )
        : lastExecution && lastExecution.initialTokenAmount > 0
          ? Math.min(
              100,
              (lastExecution.cumulativeSoldTokenAmount /
                lastExecution.initialTokenAmount) * 100,
            )
          : Math.min(100, completedTranches * Math.max(0, sellPercent)),
    nextGainPercent: status?.nextGainPercent,
    nextTargetPriceUsd: status?.nextTargetPriceUsd,
    nextProgressPercent: status?.progressPercent,
    lastExecution: lastExecution
      ? {
          trancheNumber: lastExecution.trancheNumber,
          soldInitialPercent: lastExecution.initialTokenAmount > 0
            ? Math.min(
                100,
                (lastExecution.tokenAmount /
                  lastExecution.initialTokenAmount) * 100,
              )
            : 0,
          priceUsd: lastExecution.priceUsd,
          gainFromEntryPercent: lastExecution.gainFromEntryPercent,
          ageMs: Math.max(0, nowMs - lastExecution.timestampMs),
        }
      : undefined,
  };
}

function buildProfitLockDashboardStatus(
  config: ReturnType<typeof getConfig>,
  positionManager: PositionManager,
  currentSellPriceUsd: number | undefined,
): ProfitLockDashboardStatus {
  const cycle = positionManager.getCascadeCycle();
  const status = currentSellPriceUsd === undefined
    ? undefined
    : positionManager.getProfitLockStatus(currentSellPriceUsd);
  const enabled =
    config.strategy.takeProfitMode === "cascade" &&
    config.strategy.cascadeProfitLockEnabled &&
    !positionManager.hasLegacyCascadeState();
  return {
    enabled,
    completedTranches: cycle?.completedTranches ?? 0,
    armed:
      enabled &&
      (status?.armed ??
        (cycle?.completedTranches ?? 0) >=
          config.strategy.cascadeProfitLockAfterTranches),
    activationTrancheCount:
      config.strategy.cascadeProfitLockAfterTranches,
    floorGainPercent: config.strategy.cascadeProfitLockGainPercent,
    floorPriceUsd: cycle
      ? cycle.entryPriceUsd *
        (1 + config.strategy.cascadeProfitLockGainPercent / 100)
      : undefined,
  };
}

function buildCrashBuyDashboardStatus(
  config: ReturnType<typeof getConfig>,
  positionManager: PositionManager,
  currentSellPriceUsd: number | undefined,
  buyInFlight: boolean,
  exitInFlight: boolean,
  lastError: { message: string; timestampMs: number } | undefined,
  retainedEvent: RetainedCrashEvent | undefined,
  nowMs: number,
): CrashBuyDashboardStatus {
  const realizedPnlUsd = positionManager.getCrashBuyRealizedPnlUsd();
  if (!config.crashBuy.enabled) return { phase: "OFF", realizedPnlUsd };

  const activeLot = positionManager.getActiveCrashLot();
  const latestTrade = positionManager.getLatestCrashTrade();
  const persistedEvent: RetainedCrashEvent | undefined = latestTrade
    ? {
        message:
          latestTrade.reason === "CRASH_BUY"
            ? `BUY ${latestTrade.tokenAmount.toFixed(4)} for ~$${latestTrade.usdEstimate.toFixed(2)}`
            : `EXIT ${latestTrade.tokenAmount.toFixed(4)} for ~$${latestTrade.usdEstimate.toFixed(2)}`,
        timestampMs: latestTrade.timestampMs,
      }
    : undefined;
  const newestEvent = newerCrashEvent(persistedEvent, retainedEvent);
  const eventAgeMs = newestEvent
    ? Math.max(0, nowMs - newestEvent.timestampMs)
    : undefined;
  const lastEvent =
    newestEvent &&
    eventAgeMs !== undefined &&
    eventAgeMs <= config.crashBuy.statusHoldMs
      ? { message: newestEvent.message, ageMs: eventAgeMs }
      : undefined;
  const recentError =
    lastError && nowMs - lastError.timestampMs <= config.crashBuy.statusHoldMs
      ? lastError
      : undefined;
  const activeLotEntryPriceUsd =
    activeLot && activeLot.tokenAmount > POSITION_EPSILON
      ? activeLot.totalCostUsd / activeLot.tokenAmount
      : undefined;
  const activeLotPnlUsd =
    activeLot && currentSellPriceUsd !== undefined
      ? activeLot.tokenAmount * currentSellPriceUsd - activeLot.totalCostUsd
      : undefined;
  const pnlSummary = {
    realizedPnlUsd,
    totalPnlUsd:
      activeLotPnlUsd === undefined
        ? undefined
        : realizedPnlUsd + activeLotPnlUsd,
  };
  const activeLotStatus = activeLot
    ? {
        tokenAmount: activeLot.tokenAmount,
        costUsd: activeLot.totalCostUsd,
        preDropPriceUsd: activeLot.preDropPriceUsd,
        reboundTargetPriceUsd:
          activeLot.preDropPriceUsd *
          (1 - config.crashBuy.reboundTolerancePercent / 100),
        entryPriceUsd: activeLotEntryPriceUsd,
        pnlUsd: activeLotPnlUsd,
        pnlPercent:
          activeLotEntryPriceUsd !== undefined &&
          currentSellPriceUsd !== undefined
            ? ((currentSellPriceUsd - activeLotEntryPriceUsd) /
                activeLotEntryPriceUsd) * 100
            : undefined,
        stopLossPriceUsd:
          activeLotEntryPriceUsd === undefined
            ? undefined
            : activeLotEntryPriceUsd *
              (1 - config.strategy.stopLossPercent / 100),
        trailingStopPercent: config.strategy.trailingStopPercent,
      }
    : undefined;

  if (positionManager.isCrashAutomationPaused()) {
    return {
      phase: "PAUSED",
      ...pnlSummary,
      detail: "persisted crash-lot accounting needs manual reconciliation",
      activeLot: activeLotStatus,
      lastEvent,
    };
  }

  if (buyInFlight) {
    return {
      phase: "BUYING",
      ...pnlSummary,
      detail: "isolated lot order in progress",
      lastEvent,
    };
  }
  if (activeLot) {
    return {
      phase: "ACTIVE",
      ...pnlSummary,
      detail: exitInFlight
        ? "rebound exit in progress"
        : recentError?.message,
      activeLot: activeLotStatus,
      lastEvent,
    };
  }
  if (positionManager.hasActiveCrashLot()) {
    return {
      phase: "PAUSED",
      ...pnlSummary,
      detail: "multiple active crash lots require manual review",
      lastEvent,
    };
  }
  if (recentError) {
    return {
      phase: "ERROR",
      ...pnlSummary,
      detail: recentError.message,
      lastEvent,
    };
  }
  if (lastEvent) return { phase: "RECENT", ...pnlSummary, lastEvent };
  return {
    phase: "ARMED",
    ...pnlSummary,
    detail: `trigger -${config.crashBuy.dropPercent}% / ${Math.round(config.crashBuy.windowMs / 1000)}s, size ${config.crashBuy.portfolioPercent}% (${config.trading.mode === "paper" ? "no dollar cap in PAPER" : `max $${config.crashBuy.maxUsd}`})`,
  };
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
      : "price check already queued/in progress or backing off; no duplicate check added";
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

function snapshotActiveCrashLot(
  positionManager: PositionManager,
): CrashLotSnapshot | undefined {
  const lot = positionManager.getActiveCrashLot();
  return lot
    ? { crashLotId: lot.crashLotId, tokenAmount: lot.tokenAmount }
    : undefined;
}

function latestTradeId(
  repo: TradesRepo,
  mode: Trade["mode"],
): number {
  let latestId = 0;
  for (const trade of repo.findAll()) {
    if (trade.mode === mode) latestId = Math.max(latestId, trade.id);
  }
  return latestId;
}

/** Retains a visible event when a global/manual sell consumed crash tokens. */
function retainCrashReductionEvent(
  positionManager: PositionManager,
  before: CrashLotSnapshot | undefined,
  trade: Trade | undefined,
  current: RetainedCrashEvent | undefined,
): RetainedCrashEvent | undefined {
  if (!before) return current;

  const remaining =
    positionManager.getActiveCrashLot(before.crashLotId)?.tokenAmount ?? 0;
  const sold = Math.max(0, before.tokenAmount - remaining);
  if (sold <= POSITION_EPSILON || trade?.reason === "CRASH_BUY_EXIT") {
    return current;
  }

  const action = remaining <= POSITION_EPSILON ? "CLOSED" : "REDUCED";
  const reason = trade?.reason ?? "GLOBAL_EXIT";
  return {
    message: `${action} by ${reason}: ${sold.toFixed(4)} tokens`,
    timestampMs: trade?.timestampMs ?? Date.now(),
  };
}

function newerCrashEvent(
  first: RetainedCrashEvent | undefined,
  second: RetainedCrashEvent | undefined,
): RetainedCrashEvent | undefined {
  if (!first) return second;
  if (!second) return first;
  return second.timestampMs >= first.timestampMs ? second : first;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
