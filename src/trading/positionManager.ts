import { randomUUID } from "node:crypto";
import type { BotConfig, TakeProfitLevel } from "../config/index.js";
import type { TrailingStateRepo } from "../database/trailingStateRepo.js";
import type { TradesRepo } from "../database/tradesRepo.js";
import type { Logger } from "../logger/index.js";
import {
  evaluateCascadeTakeProfit,
  type CascadeTakeProfitStatus,
} from "../strategy/cascadeTakeProfit.js";
import { TriggerConfirmation } from "../strategy/confirmation.js";
import {
  averageEntryPriceUsd,
  type CostBasisState,
  unrealizedPnl,
} from "../strategy/costBasis.js";
import {
  evaluatePosition,
  type PositionEvaluation,
} from "../strategy/evaluatePosition.js";
import {
  checkProfitLock,
  type ProfitLockStatus,
} from "../strategy/profitLock.js";
import { checkTakeProfit } from "../strategy/takeProfit.js";
import {
  initTrailingStop,
  type TrailingStopState,
} from "../strategy/trailingStop.js";
import {
  EMPTY_CASCADE_TRACKER,
  replayCascadeTracker,
  updateCascadeTracker,
  type CascadeCycle,
  type CascadeExecution,
  type CascadeTrackerState,
} from "./cascadeCycle.js";
import {
  aggregateBooks,
  applyTradeToBooks,
  crashBuyRealizedPnlUsd,
  EMPTY_POSITION_BOOKS,
  getActiveCrashLot as findActiveCrashLot,
  replayPositionBooks,
  type CrashLotState,
  type PositionBooksState,
} from "./positionBooks.js";
import { checkPriceImpact, checkSpread } from "./riskGuards.js";
import { resolveMaxSpreadBps } from "./spreadGuard.js";
import type { TradeExecutor } from "./tradeExecutor.js";
import type { Trade, TradeReason } from "./types.js";

const POSITION_EPSILON = 1e-12;
const EMPTY_TRIGGERED_GAINS: ReadonlySet<number> = new Set();
const REGULAR_TRAILING_KEY = "regular";
type SellScope = "aggregate" | "regular" | "crash";

interface AutomaticSellRequest {
  reason: TradeReason;
  scope: SellScope;
  currentImpactBps: number;
  currentSpreadBps: number;
  unrealizedGainPercent: number | undefined;
  percentOfScope?: number;
  exactTokenAmount?: number;
  takeProfitGainLevel?: number;
  crashLotId?: string;
  cascade?: {
    tranchesExecuted: number;
    entryPriceUsd: number;
    initialTokenAmount: number;
  };
}

interface PriceSampleInput {
  sellPriceUsd: number;
  sellImpactBps: number;
  nowMs: number;
  spreadFraction: number;
  positionGeneration: number;
}

/**
 * Owns durable regular/crash books and serializes every trade. Strategy exits
 * stay inside their own book; only an explicit PANIC_EXIT closes both.
 */
export class PositionManager {
  private books: PositionBooksState = EMPTY_POSITION_BOOKS;
  private cascadeTracker: CascadeTrackerState = EMPTY_CASCADE_TRACKER;
  private regularPositionIdentity: string | undefined;
  /** High-water for the regular book only. */
  private trailingState: TrailingStopState | undefined;
  /** High-water for the one isolated active crash lot. */
  private crashTrailingState: TrailingStopState | undefined;
  private readonly triggeredTakeProfitGains = new Set<number>();
  private readonly stopLossConfirm: TriggerConfirmation;
  private readonly trailingConfirm: TriggerConfirmation;
  private readonly crashStopLossConfirm: TriggerConfirmation;
  private readonly crashTrailingConfirm: TriggerConfirmation;
  private readonly profitLockConfirm: TriggerConfirmation;
  private automaticSellInFlight = false;
  private readonly pendingPriceSamples: PriceSampleInput[] = [];
  private tradeQueue: Promise<void> = Promise.resolve();
  private tradeOperationsPending = 0;
  private positionGeneration = 0;
  private lastBlockedLogMs = 0;
  private lastSellPriceUsd: number | undefined;
  private latestCrashTrade: Trade | undefined;

  constructor(
    private readonly executor: TradeExecutor,
    private readonly tradesRepo: TradesRepo,
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly trailingStateRepo?: TrailingStateRepo,
  ) {
    this.stopLossConfirm = new TriggerConfirmation(
      config.strategy.stopConfirmationEnabled,
      config.strategy.stopConfirmationMs,
    );
    this.trailingConfirm = new TriggerConfirmation(
      config.strategy.stopConfirmationEnabled,
      config.strategy.stopConfirmationMs,
    );
    this.crashStopLossConfirm = new TriggerConfirmation(
      config.strategy.stopConfirmationEnabled,
      config.strategy.stopConfirmationMs,
    );
    this.crashTrailingConfirm = new TriggerConfirmation(
      config.strategy.stopConfirmationEnabled,
      config.strategy.stopConfirmationMs,
    );
    this.profitLockConfirm = new TriggerConfirmation(
      config.strategy.cascadeProfitLockConfirmationEnabled,
      config.strategy.cascadeProfitLockConfirmationMs,
    );

    const trades = tradesRepo.findAll().filter((t) => t.mode === executor.mode);
    this.books = replayPositionBooks(trades);
    this.cascadeTracker = replayCascadeTracker(trades);
    this.latestCrashTrade = replayLatestCrashTrade(trades);
    this.regularPositionIdentity = replayRegularPositionIdentity(trades);

    const regularEntry = averageEntryPriceUsd(this.books.regular);
    if (regularEntry !== undefined && this.regularPositionIdentity) {
      this.trailingState = this.restoreOrInitializeTrailingState(
        REGULAR_TRAILING_KEY,
        this.regularPositionIdentity,
        regularEntry,
      );
    } else {
      this.trailingStateRepo?.delete(this.executor.mode, REGULAR_TRAILING_KEY);
    }
    const activeCrashLot = findActiveCrashLot(this.books);
    const crashEntry = activeCrashLot
      ? averageEntryPriceUsd(activeCrashLot)
      : undefined;
    if (crashEntry !== undefined) {
      this.crashTrailingState = this.restoreOrInitializeTrailingState(
        crashTrailingKey(activeCrashLot!.crashLotId),
        activeCrashLot!.crashLotId,
        crashEntry,
      );
    }

    if (this.books.warnings.legacyCrashBuyWithoutMetadata) {
      this.logger.warn(
        "Legacy CRASH_BUY has no lot metadata; it remains regular and no exact crash exit will be guessed. PAPER users should run reset.",
      );
    }
    if (
      this.books.warnings.unroutableCrashBuyExit ||
      this.books.warnings.sellAmountExceededTargetBook
    ) {
      this.logger.warn(
        "Crash-lot accounting required reconciliation; exact automatic crash exits are paused until the position is reset or manually reconciled.",
      );
    }
    if (
      config.strategy.takeProfitMode === "cascade" &&
      this.cascadeTracker.legacyTakeProfitInActiveCycle
    ) {
      this.logger.warn(
        "Open position has legacy TAKE_PROFIT rows without cascade counters; new cascade payouts are paused. In PAPER mode run reset.",
      );
    }
  }

  getCostBasis(): CostBasisState {
    return aggregateBooks(this.books);
  }

  getRegularCostBasis(): CostBasisState {
    return this.books.regular;
  }

  getActiveCrashLot(crashLotId?: string): CrashLotState | undefined {
    return findActiveCrashLot(this.books, crashLotId);
  }

  getCrashBuyRealizedPnlUsd(): number {
    return crashBuyRealizedPnlUsd(this.books);
  }

  hasActiveCrashLot(): boolean {
    return this.books.crashLots.some(
      (lot) => lot.tokenAmount > POSITION_EPSILON,
    );
  }

  isCrashAutomationPaused(): boolean {
    return (
      this.books.warnings.unroutableCrashBuyExit ||
      this.books.warnings.sellAmountExceededTargetBook
    );
  }

  getLatestCrashTrade(): Trade | undefined {
    return this.latestCrashTrade;
  }

  getLastCascadeExecution(): CascadeExecution | undefined {
    return this.cascadeTracker.lastExecution;
  }

  getCascadeCycle(): CascadeCycle | undefined {
    return this.cascadeTracker.active
      ? { ...this.cascadeTracker.active }
      : undefined;
  }

  hasLegacyCascadeState(): boolean {
    return this.cascadeTracker.legacyTakeProfitInActiveCycle;
  }

  getCascadeStatus(
    currentSellPriceUsd: number,
  ): CascadeTakeProfitStatus | undefined {
    const cycle = this.cascadeTracker.active;
    if (
      this.config.strategy.takeProfitMode !== "cascade" ||
      !cycle ||
      this.books.regular.tokenAmount <= POSITION_EPSILON
    ) {
      return undefined;
    }
    return evaluateCascadeTakeProfit({
      currentPriceUsd: currentSellPriceUsd,
      entryPriceUsd: cycle.entryPriceUsd,
      completedTranches: cycle.completedTranches,
      gainStepPercent: this.config.strategy.cascadeTakeProfitPercent,
      sellPercentOfInitial:
        this.config.strategy.cascadeTakeProfitSellPercent,
      initialTokenAmount: cycle.initialTokenAmount,
      cascadeSoldTokenAmount: cycle.cascadeSoldTokenAmount,
      remainingTokenAmount: this.books.regular.tokenAmount,
    });
  }

  getProfitLockStatus(currentSellPriceUsd: number): ProfitLockStatus | undefined {
    const cycle = this.cascadeTracker.active;
    if (
      this.config.strategy.takeProfitMode !== "cascade" ||
      !cycle ||
      this.books.regular.tokenAmount <= POSITION_EPSILON
    ) {
      return undefined;
    }
    return checkProfitLock(
      currentSellPriceUsd,
      cycle.entryPriceUsd,
      cycle.completedTranches,
      this.config.strategy.cascadeProfitLockAfterTranches,
      this.config.strategy.cascadeProfitLockGainPercent,
    );
  }

  /** Read-only strategy snapshot for the dashboard - never mutates state. */
  peek(currentSellPriceUsd: number): PositionEvaluation {
    const aggregateEvaluation = evaluatePosition(
      this.getCostBasis(),
      currentSellPriceUsd,
      initTrailingStop(currentSellPriceUsd),
      this.triggeredTakeProfitGains,
      this.config,
    );
    const activeCrashLot = findActiveCrashLot(this.books);
    const riskBasis =
      this.books.regular.tokenAmount > POSITION_EPSILON
        ? this.books.regular
        : (activeCrashLot ?? this.getCostBasis());
    const riskTrailingState =
      this.books.regular.tokenAmount > POSITION_EPSILON
        ? this.trailingState
        : this.crashTrailingState;
    const riskEvaluation = evaluatePosition(
      riskBasis,
      currentSellPriceUsd,
      riskTrailingState ?? initTrailingStop(currentSellPriceUsd),
      EMPTY_TRIGGERED_GAINS,
      this.config,
    );
    return {
      ...aggregateEvaluation,
      stopLoss: riskEvaluation.stopLoss,
      trailing: riskEvaluation.trailing,
      dueTakeProfitLevels: this.dueEntryTakeProfitLevels(currentSellPriceUsd),
      cascadeTakeProfit: undefined,
    };
  }

  /** Called on every fresh sample; may trigger at most one automatic sell. */
  async handlePriceSample(
    sellPriceUsd: number,
    sellImpactBps: number,
    nowMs: number,
    spreadFraction = 0,
  ): Promise<void> {
    this.pendingPriceSamples.push({
      sellPriceUsd,
      sellImpactBps,
      nowMs,
      spreadFraction,
      positionGeneration: this.positionGeneration,
    });
    if (this.automaticSellInFlight) return;

    this.automaticSellInFlight = true;
    try {
      while (this.pendingPriceSamples.length > 0) {
        await this.enqueueTrade(async () => {
          const samples = this.pendingPriceSamples.splice(0);
          for (let index = 0; index < samples.length; index += 1) {
            await this.processPriceSampleLocked(
              samples[index]!,
              index === samples.length - 1,
            );
          }
        });
      }
    } finally {
      this.automaticSellInFlight = false;
    }
  }

  /**
   * Replays every sampled high/low into trailing and confirmation state, but
   * only lets the newest queued sample trade. The whole method runs inside
   * the same FIFO as manual buys/sells, so a stale decision can never execute
   * after another operation has changed the position.
   */
  private async processPriceSampleLocked(
    sample: PriceSampleInput,
    allowTrade: boolean,
  ): Promise<void> {
    if (sample.positionGeneration !== this.positionGeneration) return;
    if (this.getCostBasis().tokenAmount <= POSITION_EPSILON) return;

    const { sellPriceUsd, sellImpactBps, nowMs, spreadFraction } = sample;

    const regularEvaluation =
      this.books.regular.tokenAmount > POSITION_EPSILON
        ? evaluatePosition(
            this.books.regular,
            sellPriceUsd,
            this.trailingState ?? initTrailingStop(sellPriceUsd),
            this.triggeredTakeProfitGains,
            this.config,
          )
        : undefined;
    if (regularEvaluation) {
      const previous = this.trailingState;
      this.trailingState = regularEvaluation.trailing.state;
      this.persistTrailingStateIfChanged(
        REGULAR_TRAILING_KEY,
        this.regularPositionIdentity,
        previous,
        this.trailingState,
      );
    }
    const confirmedRegularStopLoss = this.stopLossConfirm.update(
      Boolean(regularEvaluation?.stopLoss.triggered),
      nowMs,
    );
    const confirmedRegularTrailing = this.trailingConfirm.update(
      Boolean(regularEvaluation?.trailing.triggered),
      nowMs,
    );

    const activeCrashLot = this.isCrashAutomationPaused()
      ? undefined
      : findActiveCrashLot(this.books);
    const crashEvaluation = activeCrashLot
      ? evaluatePosition(
          activeCrashLot,
          sellPriceUsd,
          this.crashTrailingState ?? initTrailingStop(sellPriceUsd),
          EMPTY_TRIGGERED_GAINS,
          this.config,
        )
        : undefined;
    if (crashEvaluation) {
      const previous = this.crashTrailingState;
      this.crashTrailingState = crashEvaluation.trailing.state;
      this.persistTrailingStateIfChanged(
        crashTrailingKey(activeCrashLot!.crashLotId),
        activeCrashLot!.crashLotId,
        previous,
        this.crashTrailingState,
      );
    }
    const confirmedCrashStopLoss = this.crashStopLossConfirm.update(
      Boolean(crashEvaluation?.stopLoss.triggered),
      nowMs,
    );
    const confirmedCrashTrailing = this.crashTrailingConfirm.update(
      Boolean(crashEvaluation?.trailing.triggered),
      nowMs,
    );

    const profitLock = this.getProfitLockStatus(sellPriceUsd);
    const confirmedProfitLock = this.profitLockConfirm.update(
      Boolean(
        this.config.strategy.cascadeProfitLockEnabled &&
          !this.cascadeTracker.legacyTakeProfitInActiveCycle &&
          profitLock?.triggered,
      ),
      nowMs,
    );
    const cascade = this.getCascadeStatus(sellPriceUsd);
    const dueTakeProfitLevels =
      this.dueEntryTakeProfitLevels(sellPriceUsd);
    const spreadBps = spreadFraction * 10_000;
    const aggregateGainPercent = unrealizedPnl(
      this.getCostBasis(),
      sellPriceUsd,
    )?.percent;
    const regularGainPercent = regularEvaluation?.unrealized?.percent;
    const crashGainPercent = crashEvaluation?.unrealized?.percent;

    if (!allowTrade) return;

    const regularFullExitConfirmed =
      confirmedRegularStopLoss ||
      confirmedProfitLock ||
      confirmedRegularTrailing;
    const crashFullExitConfirmed =
      confirmedCrashStopLoss || confirmedCrashTrailing;
    if (
      regularEvaluation &&
      activeCrashLot &&
      regularFullExitConfirmed &&
      crashFullExitConfirmed
    ) {
      // Every open book independently wants a full exit on this sample. One
      // aggregate swap is faster and uses fewer rate-limited requests; a
      // signal in only one book always remains quantity-isolated below.
      const hardSafetyExit =
        confirmedRegularStopLoss ||
        confirmedCrashStopLoss ||
        confirmedProfitLock;
      await this.autoSell({
        reason: hardSafetyExit ? "STOP_LOSS" : "TRAILING_STOP",
        scope: "aggregate",
        percentOfScope: 100,
        currentImpactBps: sellImpactBps,
        currentSpreadBps: spreadBps,
        unrealizedGainPercent: aggregateGainPercent,
      });
    } else if (confirmedRegularStopLoss) {
      await this.autoSell({
        reason: "REGULAR_STOP_LOSS",
        scope: "regular",
        percentOfScope: 100,
        currentImpactBps: sellImpactBps,
        currentSpreadBps: spreadBps,
        unrealizedGainPercent: regularGainPercent,
      });
    } else if (confirmedCrashStopLoss && activeCrashLot) {
      await this.autoSell({
        reason: "CRASH_STOP_LOSS",
        scope: "crash",
        exactTokenAmount: activeCrashLot.tokenAmount,
        crashLotId: activeCrashLot.crashLotId,
        currentImpactBps: sellImpactBps,
        currentSpreadBps: spreadBps,
        unrealizedGainPercent: crashGainPercent,
      });
    } else if (confirmedProfitLock) {
      await this.autoSell({
        reason: "PROFIT_LOCK",
        scope: "regular",
        percentOfScope: 100,
        currentImpactBps: sellImpactBps,
        currentSpreadBps: spreadBps,
        unrealizedGainPercent: regularGainPercent,
      });
    } else if (confirmedRegularTrailing) {
      await this.autoSell({
        reason: "REGULAR_TRAILING_STOP",
        scope: "regular",
        percentOfScope: 100,
        currentImpactBps: sellImpactBps,
        currentSpreadBps: spreadBps,
        unrealizedGainPercent: regularGainPercent,
      });
    } else if (confirmedCrashTrailing && activeCrashLot) {
      await this.autoSell({
        reason: "CRASH_TRAILING_STOP",
        scope: "crash",
        exactTokenAmount: activeCrashLot.tokenAmount,
        crashLotId: activeCrashLot.crashLotId,
        currentImpactBps: sellImpactBps,
        currentSpreadBps: spreadBps,
        unrealizedGainPercent: crashGainPercent,
      });
    } else if (
      cascade?.shouldSell &&
      !this.cascadeTracker.legacyTakeProfitInActiveCycle
    ) {
      const cycle = this.cascadeTracker.active!;
      await this.autoSell({
        reason: "CASCADE_TAKE_PROFIT",
        scope: "regular",
        exactTokenAmount: cascade.sellTokenAmount,
        currentImpactBps: sellImpactBps,
        currentSpreadBps: spreadBps,
        unrealizedGainPercent: regularGainPercent,
        cascade: {
          tranchesExecuted: cascade.tranchesDue,
          entryPriceUsd: cycle.entryPriceUsd,
          initialTokenAmount: cycle.initialTokenAmount,
        },
      });
    } else if (dueTakeProfitLevels.length > 0) {
      const level = dueTakeProfitLevels[0]!;
      await this.autoSell({
        reason: "TAKE_PROFIT",
        scope: "regular",
        percentOfScope: level.sellPercent,
        currentImpactBps: sellImpactBps,
        currentSpreadBps: spreadBps,
        unrealizedGainPercent: regularGainPercent,
        takeProfitGainLevel: level.gainPercent,
      });
    }
  }

  async manualBuy(
    usdAmount: number,
    reason: TradeReason = "MANUAL",
  ): Promise<Trade> {
    if (reason === "CRASH_BUY") {
      throw new Error("Use crashBuy(usdAmount, preDropPriceUsd) for an isolated crash lot");
    }
    return this.enqueueTrade(async () => {
      if (
        this.config.strategy.takeProfitMode === "cascade" &&
        this.books.regular.tokenAmount > POSITION_EPSILON &&
        (this.cascadeTracker.active?.cascadeSoldTokenAmount ?? 0) >
          POSITION_EPSILON
      ) {
        throw new Error(
          "Regular buy blocked: close the current cascade cycle before adding a new regular lot",
        );
      }
      const trade = await this.executor.buy({ usdAmount, reason });
      this.recordBuy(trade);
      return trade;
    });
  }

  async crashBuy(usdAmount: number, preDropPriceUsd: number): Promise<Trade> {
    if (!Number.isFinite(preDropPriceUsd) || preDropPriceUsd <= 0) {
      throw new Error("CRASH_BUY requires a positive pre-drop price");
    }
    return this.enqueueTrade(async () => {
      if (this.hasActiveCrashLot()) {
        throw new Error("CRASH_BUY skipped: an isolated crash lot is already active");
      }
      const trade = await this.executor.buy({ usdAmount, reason: "CRASH_BUY" });
      trade.crashLotId = randomUUID();
      trade.crashPreDropPriceUsd = preDropPriceUsd;
      this.recordBuy(trade);
      return trade;
    });
  }

  hasOpenPosition(): boolean {
    return this.getCostBasis().tokenAmount > POSITION_EPSILON;
  }

  getLastSellPriceUsd(): number | undefined {
    return this.lastSellPriceUsd;
  }

  async manualSell(
    percentOfPosition: number,
    reason: TradeReason,
    currentImpactBps: number,
    bypassImpactGuard = false,
  ): Promise<Trade> {
    if (reason === "CRASH_BUY_EXIT") {
      throw new Error("Use exitCrashLot() so only the isolated crash amount is sold");
    }
    if (
      !Number.isFinite(percentOfPosition) ||
      percentOfPosition <= 0 ||
      percentOfPosition > 100
    ) {
      throw new Error("Sell percent must be greater than 0 and at most 100");
    }
    if (!bypassImpactGuard) this.assertImpactAllowed(currentImpactBps);

    return this.enqueueTrade(async () => {
      const tokenAmount =
        this.getCostBasis().tokenAmount * (percentOfPosition / 100);
      if (tokenAmount <= POSITION_EPSILON) throw new Error("No position to sell");
      const trade = await this.executor.sell({ tokenAmount, reason });
      this.recordSell(trade);
      return trade;
    });
  }

  async exitCrashLot(
    currentImpactBps: number,
    crashLotId?: string,
  ): Promise<Trade | undefined> {
    this.assertImpactAllowed(currentImpactBps);
    return this.enqueueTrade(async () => {
      if (this.isCrashAutomationPaused()) {
        throw new Error(
          "CRASH_BUY_EXIT paused: persisted lot accounting needs manual reconciliation",
        );
      }
      const lot = findActiveCrashLot(this.books, crashLotId);
      if (!lot) {
        if (this.hasActiveCrashLot()) {
          throw new Error(
            "CRASH_BUY_EXIT refused: active crash lot is ambiguous; exact lot ID required",
          );
        }
        return undefined;
      }
      const trade = await this.executor.sell({
        tokenAmount: lot.tokenAmount,
        reason: "CRASH_BUY_EXIT",
      });
      trade.crashLotId = lot.crashLotId;
      trade.crashPreDropPriceUsd = lot.preDropPriceUsd;
      this.recordSell(trade);
      return trade;
    });
  }

  panicSell(currentImpactBps: number): Promise<Trade> {
    return this.manualSell(100, "PANIC_EXIT", currentImpactBps, true);
  }

  /** PAPER-only caller owns the mode check; never races an in-flight trade. */
  reset(): void {
    if (this.tradeOperationsPending > 0) {
      throw new Error("reset: wait for the current trade operation to finish, then retry");
    }
    this.books = EMPTY_POSITION_BOOKS;
    this.cascadeTracker = EMPTY_CASCADE_TRACKER;
    this.regularPositionIdentity = undefined;
    this.trailingState = undefined;
    this.crashTrailingState = undefined;
    this.lastSellPriceUsd = undefined;
    this.latestCrashTrade = undefined;
    this.triggeredTakeProfitGains.clear();
    this.stopLossConfirm.reset();
    this.trailingConfirm.reset();
    this.crashStopLossConfirm.reset();
    this.crashTrailingConfirm.reset();
    this.profitLockConfirm.reset();
    this.positionGeneration += 1;
    this.pendingPriceSamples.length = 0;
    this.tradesRepo.deleteByMode(this.executor.mode);
    this.trailingStateRepo?.deleteByMode(this.executor.mode);
  }

  private dueEntryTakeProfitLevels(
    currentSellPriceUsd: number,
  ): TakeProfitLevel[] {
    if (
      this.config.strategy.takeProfitMode !== "entry" ||
      this.books.regular.tokenAmount <= POSITION_EPSILON
    ) {
      return [];
    }
    const pnl = unrealizedPnl(this.books.regular, currentSellPriceUsd);
    return pnl
      ? checkTakeProfit(
          pnl.percent,
          this.config.strategy.takeProfitLevels,
          this.triggeredTakeProfitGains,
        )
      : [];
  }

  private async autoSell(request: AutomaticSellRequest): Promise<void> {
    const impactGuard = checkPriceImpact(
      request.currentImpactBps,
      this.config.risk.maxPriceImpactBps,
    );
    if (!impactGuard.allowed) {
      this.logBlocked(`${impactGuard.reason} (${request.reason} held back)`);
      return;
    }

    const maxSpreadBps = resolveMaxSpreadBps(
      request.reason,
      request.unrealizedGainPercent,
      {
        maxSpreadBps: this.config.risk.maxSpreadBps,
        maxSpreadHighGainBps: this.config.risk.maxSpreadHighGainBps,
        maxSpreadHighGainThresholdPercent:
          this.config.risk.maxSpreadHighGainThresholdPercent,
      },
    );
    if (maxSpreadBps !== undefined) {
      const spreadGuard = checkSpread(request.currentSpreadBps, maxSpreadBps);
      if (!spreadGuard.allowed) {
        this.logBlocked(`${spreadGuard.reason} (${request.reason} held back)`);
        return;
      }
    }

    const crashLot =
      request.scope === "crash"
        ? findActiveCrashLot(this.books, request.crashLotId)
        : undefined;
    if (request.scope === "crash" && !crashLot) return;
    const scopedAmount =
      request.scope === "regular"
        ? this.books.regular.tokenAmount
        : request.scope === "crash"
          ? crashLot!.tokenAmount
          : this.getCostBasis().tokenAmount;
    const requestedAmount =
      request.exactTokenAmount ??
      scopedAmount * ((request.percentOfScope ?? 0) / 100);
    const tokenAmount = Math.min(scopedAmount, requestedAmount);
    if (tokenAmount <= POSITION_EPSILON) return;

    const trade = await this.executor.sell({
      tokenAmount,
      reason: request.reason,
    });
    if (crashLot) {
      trade.crashLotId = crashLot.crashLotId;
      trade.crashPreDropPriceUsd = crashLot.preDropPriceUsd;
    }
    if (request.cascade) {
      trade.cascadeTranchesExecuted = this.completedCascadeTranchesForFill(
        request.cascade.tranchesExecuted,
        trade.tokenAmount,
      );
      trade.cascadeEntryPriceUsd = request.cascade.entryPriceUsd;
      trade.cascadeInitialTokenAmount = request.cascade.initialTokenAmount;
    }
    this.recordSell(trade);
    if (request.takeProfitGainLevel !== undefined) {
      this.triggeredTakeProfitGains.add(request.takeProfitGainLevel);
    }
    this.logger.info(
      `${request.reason} executed: sold ${trade.tokenAmount.toFixed(4)} for ~$${trade.usdEstimate.toFixed(4)}`,
    );
  }

  private completedCascadeTranchesForFill(
    requestedTranches: number,
    executedTokenAmount: number,
  ): number {
    const cycle = this.cascadeTracker.active;
    if (!cycle) return 0;
    const singleTrancheTokenAmount =
      cycle.initialTokenAmount *
      (this.config.strategy.cascadeTakeProfitSellPercent / 100);
    if (singleTrancheTokenAmount <= POSITION_EPSILON) return 0;

    const regularFill = Math.min(
      this.books.regular.tokenAmount,
      Math.max(0, executedTokenAmount),
    );
    const cumulativeSold = cycle.cascadeSoldTokenAmount + regularFill;
    const fillEpsilon = singleTrancheTokenAmount * 1e-9;
    const maxTranches = Math.ceil(
      100 / this.config.strategy.cascadeTakeProfitSellPercent,
    );
    const completedAfterFill =
      cumulativeSold + fillEpsilon >= cycle.initialTokenAmount
        ? maxTranches
        : Math.floor(
            (cumulativeSold + fillEpsilon) / singleTrancheTokenAmount,
          );
    return Math.min(
      Math.max(0, Math.floor(requestedTranches)),
      Math.max(0, completedAfterFill - cycle.completedTranches),
    );
  }

  private restoreOrInitializeTrailingState(
    positionKey: string,
    positionIdentity: string,
    entryPriceUsd: number,
  ): TrailingStopState {
    const persisted = this.trailingStateRepo?.get(
      this.executor.mode,
      positionKey,
      positionIdentity,
    );
    const state = persisted
      ? {
          highestPriceUsd: Math.max(entryPriceUsd, persisted.highestPriceUsd),
          armed: persisted.armed,
        }
      : initTrailingStop(entryPriceUsd);

    if (!sameTrailingState(persisted, state)) {
      this.trailingStateRepo?.upsert(
        this.executor.mode,
        positionKey,
        positionIdentity,
        state,
      );
    }
    return state;
  }

  private persistTrailingStateIfChanged(
    positionKey: string,
    positionIdentity: string | undefined,
    previous: TrailingStopState | undefined,
    next: TrailingStopState,
  ): void {
    if (!positionIdentity || sameTrailingState(previous, next)) return;
    this.trailingStateRepo?.upsert(
      this.executor.mode,
      positionKey,
      positionIdentity,
      next,
    );
  }

  private enqueueTrade<T>(operation: () => Promise<T>): Promise<T> {
    this.tradeOperationsPending += 1;
    const started = this.tradeQueue.then(operation);
    const tracked = started.then(
      (value) => {
        this.tradeOperationsPending -= 1;
        return value;
      },
      (error: unknown) => {
        this.tradeOperationsPending -= 1;
        throw error;
      },
    );
    this.tradeQueue = tracked.then(
      () => undefined,
      () => undefined,
    );
    return tracked;
  }

  private recordBuy(trade: Trade): void {
    const regularBefore = this.books.regular;
    let trailingKeyToPersist: string | undefined;
    let trailingIdentityToPersist: string | undefined;
    this.books = applyTradeToBooks(this.books, trade);
    this.cascadeTracker = updateCascadeTracker(
      this.cascadeTracker,
      trade,
      regularBefore,
      this.books.regular,
    );
    if (trade.reason === "CRASH_BUY") {
      const lot = trade.crashLotId
        ? findActiveCrashLot(this.books, trade.crashLotId)
        : undefined;
      const entry = lot ? averageEntryPriceUsd(lot) : undefined;
      if (entry !== undefined) {
        this.crashTrailingState = initTrailingStop(entry);
        trailingKeyToPersist = crashTrailingKey(lot!.crashLotId);
        trailingIdentityToPersist = lot!.crashLotId;
      }
      this.crashStopLossConfirm.reset();
      this.crashTrailingConfirm.reset();
      this.latestCrashTrade = trade;
    } else {
      const entry = averageEntryPriceUsd(this.books.regular);
      if (
        entry !== undefined &&
        (regularBefore.tokenAmount <= POSITION_EPSILON || !this.trailingState)
      ) {
        this.trailingState = initTrailingStop(entry);
        trailingKeyToPersist = REGULAR_TRAILING_KEY;
      }
      this.stopLossConfirm.reset();
    }
    this.positionGeneration += 1;
    const tradeId = this.tradesRepo.insert(trade);
    if (
      trade.reason !== "CRASH_BUY" &&
      regularBefore.tokenAmount <= POSITION_EPSILON &&
      this.books.regular.tokenAmount > POSITION_EPSILON
    ) {
      this.regularPositionIdentity = regularTradeIdentity(tradeId);
    }
    if (trailingKeyToPersist === REGULAR_TRAILING_KEY) {
      trailingIdentityToPersist = this.regularPositionIdentity;
    }
    const initializedState =
      trailingKeyToPersist === REGULAR_TRAILING_KEY
        ? this.trailingState
        : this.crashTrailingState;
    if (trailingKeyToPersist && trailingIdentityToPersist && initializedState) {
      this.trailingStateRepo?.upsert(
        this.executor.mode,
        trailingKeyToPersist,
        trailingIdentityToPersist,
        initializedState,
      );
    }
  }

  private recordSell(trade: Trade): void {
    const aggregateBefore = this.getCostBasis();
    const regularBefore = this.books.regular;
    const crashTokensBefore = this.books.crashLots.reduce(
      (total, lot) => total + lot.tokenAmount,
      0,
    );
    const openCrashLotIdsBefore = this.books.crashLots
      .filter((lot) => lot.tokenAmount > POSITION_EPSILON)
      .map((lot) => lot.crashLotId);
    this.books = applyTradeToBooks(this.books, trade);
    this.cascadeTracker = updateCascadeTracker(
      this.cascadeTracker,
      trade,
      regularBefore,
      this.books.regular,
    );
    const aggregateAfter = this.getCostBasis();
    const crashTokensAfter = this.books.crashLots.reduce(
      (total, lot) => total + lot.tokenAmount,
      0,
    );
    const openCrashLotIdsAfter = new Set(
      this.books.crashLots
        .filter((lot) => lot.tokenAmount > POSITION_EPSILON)
        .map((lot) => lot.crashLotId),
    );
    trade.realizedPnlUsd =
      aggregateAfter.realizedPnlUsd - aggregateBefore.realizedPnlUsd;
    this.tradesRepo.insert(trade);

    const crashTokensSold = Math.max(0, crashTokensBefore - crashTokensAfter);
    if (crashTokensSold > POSITION_EPSILON) {
      const allocationFraction =
        trade.tokenAmount > POSITION_EPSILON
          ? crashTokensSold / trade.tokenAmount
          : 0;
      this.latestCrashTrade = {
        ...trade,
        reason: "CRASH_BUY_EXIT",
        tokenAmount: crashTokensSold,
        usdEstimate: trade.usdEstimate * allocationFraction,
      };
    } else if (
      trade.reason === "CRASH_BUY_EXIT" ||
      trade.reason === "CRASH_STOP_LOSS" ||
      trade.reason === "CRASH_TRAILING_STOP"
    ) {
      this.latestCrashTrade = trade;
    }
    if (trade.tokenAmount > 0) {
      const executedPriceUsd = trade.usdEstimate / trade.tokenAmount;
      if (
        trade.reason !== "TAKE_PROFIT" &&
        trade.reason !== "CASCADE_TAKE_PROFIT"
      ) {
        this.lastSellPriceUsd = executedPriceUsd;
      }
    }

    if (this.books.regular.tokenAmount <= POSITION_EPSILON) {
      this.trailingState = undefined;
      this.trailingStateRepo?.delete(
        this.executor.mode,
        REGULAR_TRAILING_KEY,
      );
      this.regularPositionIdentity = undefined;
      this.triggeredTakeProfitGains.clear();
      this.stopLossConfirm.reset();
      this.trailingConfirm.reset();
      this.profitLockConfirm.reset();
    }
    if (crashTokensAfter <= POSITION_EPSILON) {
      this.crashTrailingState = undefined;
      this.crashStopLossConfirm.reset();
      this.crashTrailingConfirm.reset();
    }
    for (const crashLotId of openCrashLotIdsBefore) {
      if (!openCrashLotIdsAfter.has(crashLotId)) {
        this.trailingStateRepo?.delete(
          this.executor.mode,
          crashTrailingKey(crashLotId),
        );
      }
    }
    if (
      aggregateAfter.tokenAmount <= POSITION_EPSILON ||
      (regularBefore.tokenAmount > POSITION_EPSILON &&
        this.books.regular.tokenAmount <= POSITION_EPSILON) ||
      Math.abs(crashTokensAfter - crashTokensBefore) > POSITION_EPSILON
    ) {
      this.positionGeneration += 1;
    }
  }

  private assertImpactAllowed(currentImpactBps: number): void {
    const guard = checkPriceImpact(
      currentImpactBps,
      this.config.risk.maxPriceImpactBps,
    );
    if (!guard.allowed) throw new Error(guard.reason);
  }

  private logBlocked(message: string): void {
    if (Date.now() - this.lastBlockedLogMs <= 10_000) return;
    this.logger.warn(message);
    this.lastBlockedLogMs = Date.now();
  }
}

function replayLatestCrashTrade(trades: readonly Trade[]): Trade | undefined {
  let books = EMPTY_POSITION_BOOKS;
  let latest: Trade | undefined;

  for (const trade of trades) {
    const crashTokensBefore = totalCrashTokens(books);
    books = applyTradeToBooks(books, trade);
    const crashTokensAfter = totalCrashTokens(books);
    const crashTokensSold = Math.max(0, crashTokensBefore - crashTokensAfter);

    if (trade.reason === "CRASH_BUY") {
      latest = trade;
    }
    if (crashTokensSold > POSITION_EPSILON) {
      const allocationFraction =
        trade.tokenAmount > POSITION_EPSILON
          ? crashTokensSold / trade.tokenAmount
          : 0;
      latest = {
        ...trade,
        reason: "CRASH_BUY_EXIT",
        tokenAmount: crashTokensSold,
        usdEstimate: trade.usdEstimate * allocationFraction,
      };
    } else if (
      trade.reason === "CRASH_BUY_EXIT" ||
      trade.reason === "CRASH_STOP_LOSS" ||
      trade.reason === "CRASH_TRAILING_STOP"
    ) {
      latest = trade;
    }
  }

  return latest;
}

function totalCrashTokens(books: PositionBooksState): number {
  return books.crashLots.reduce((total, lot) => total + lot.tokenAmount, 0);
}

function replayRegularPositionIdentity(
  trades: readonly Trade[],
): string | undefined {
  let books = EMPTY_POSITION_BOOKS;
  let identity: string | undefined;

  for (const trade of trades) {
    const regularTokensBefore = books.regular.tokenAmount;
    books = applyTradeToBooks(books, trade);
    if (
      regularTokensBefore <= POSITION_EPSILON &&
      books.regular.tokenAmount > POSITION_EPSILON
    ) {
      const id = (trade as Trade & { id?: unknown }).id;
      if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) {
        identity = regularTradeIdentity(id);
      } else {
        identity = `legacy:${trade.timestampMs}:${trade.txSignature ?? trade.reason}`;
      }
    }
    if (books.regular.tokenAmount <= POSITION_EPSILON) {
      identity = undefined;
    }
  }

  return identity;
}

function regularTradeIdentity(tradeId: number): string {
  return `trade:${tradeId}`;
}

function crashTrailingKey(crashLotId: string): string {
  return `crash:${crashLotId}`;
}

function sameTrailingState(
  left: TrailingStopState | undefined,
  right: TrailingStopState,
): boolean {
  return (
    left !== undefined &&
    left.highestPriceUsd === right.highestPriceUsd &&
    left.armed === right.armed
  );
}
