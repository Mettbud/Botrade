import type { BotConfig } from "../config/index.js";
import type { TradesRepo } from "../database/tradesRepo.js";
import type { Logger } from "../logger/index.js";
import {
  applyTrade,
  averageEntryPriceUsd,
  EMPTY_COST_BASIS,
  type CostBasisState,
} from "../strategy/costBasis.js";
import { TriggerConfirmation } from "../strategy/confirmation.js";
import { evaluatePosition, type PositionEvaluation } from "../strategy/evaluatePosition.js";
import { initTrailingStop, type TrailingStopState } from "../strategy/trailingStop.js";
import { checkPriceImpact } from "./riskGuards.js";
import type { TradeExecutor } from "./tradeExecutor.js";
import type { Trade, TradeReason } from "./types.js";

/**
 * Owns the running cost basis, trailing-stop high-water mark and
 * confirmation timers for the bot's single position, and turns strategy
 * decisions into executed trades. One instance per trading mode (paper vs
 * live each have their own book, replayed from their own trades).
 */
export class PositionManager {
  private costBasis: CostBasisState = EMPTY_COST_BASIS;
  private trailingState: TrailingStopState | undefined;
  private readonly triggeredTakeProfitGains = new Set<number>();
  private readonly stopLossConfirm: TriggerConfirmation;
  private readonly trailingConfirm: TriggerConfirmation;
  private lastBlockedLogMs = 0;
  /**
   * Executable price of the most recent STOP_LOSS/TRAILING_STOP/PANIC_EXIT/
   * MANUAL sell this run - undefined until the first one. Deliberately NOT
   * updated by TAKE_PROFIT sells (either mode): those happen because price
   * went UP, so treating them as "don't rebuy above this" would ratchet the
   * gate higher on every take-profit tranche and eventually block auto-buy/
   * averaging from ever firing again. See AUTO_BUY_REQUIRE_BELOW_LAST_SELL.
   */
  private lastSellPriceUsd: number | undefined;
  /**
   * TAKE_PROFIT_MODE=cascade only: the price the next tranche's +gain% is
   * measured from. Set to the entry price when a position opens, then
   * advanced to each cascade tranche's executed sell price - never reset
   * by an averaging-in buy (see PositionManager's "one merged pool" design).
   */
  private cascadeReferencePriceUsd: number | undefined;

  constructor(
    private readonly executor: TradeExecutor,
    private readonly tradesRepo: TradesRepo,
    private readonly config: BotConfig,
    private readonly logger: Logger,
  ) {
    this.stopLossConfirm = new TriggerConfirmation(
      config.strategy.stopConfirmationEnabled,
      config.strategy.stopConfirmationMs,
    );
    this.trailingConfirm = new TriggerConfirmation(
      config.strategy.stopConfirmationEnabled,
      config.strategy.stopConfirmationMs,
    );

    const trades = tradesRepo
      .findAll()
      .filter((t) => t.mode === executor.mode);
    this.costBasis = trades.reduce(
      (state, t) => applyTrade(state, t),
      EMPTY_COST_BASIS,
    );
    const entry = averageEntryPriceUsd(this.costBasis);
    if (entry !== undefined) {
      this.trailingState = initTrailingStop(entry);
      // Reconstructed from full trade replay on restart, not from a live
      // cascade in progress - a bot restart mid-cascade resets the next
      // tranche's threshold back to entry rather than the last live sell.
      // Acceptable: it only makes the next tranche a little more/less
      // generous, it never loses or duplicates a trade.
      this.cascadeReferencePriceUsd = entry;
    }
  }

  getCostBasis(): CostBasisState {
    return this.costBasis;
  }

  /** Read-only strategy snapshot for the dashboard - never mutates state. */
  peek(currentSellPriceUsd: number): PositionEvaluation {
    return evaluatePosition(
      this.costBasis,
      currentSellPriceUsd,
      this.trailingState ?? initTrailingStop(currentSellPriceUsd),
      this.triggeredTakeProfitGains,
      this.config,
      this.cascadeReferencePriceUsd,
    );
  }

  /** Called on every fresh price sample; may trigger at most one automatic sell. */
  async handlePriceSample(
    sellPriceUsd: number,
    sellImpactBps: number,
    nowMs: number,
  ): Promise<void> {
    if (this.costBasis.tokenAmount <= 0) return;

    const evaluation = evaluatePosition(
      this.costBasis,
      sellPriceUsd,
      this.trailingState ?? initTrailingStop(sellPriceUsd),
      this.triggeredTakeProfitGains,
      this.config,
      this.cascadeReferencePriceUsd,
    );
    this.trailingState = evaluation.trailing.state;

    const confirmedStopLoss = this.stopLossConfirm.update(
      evaluation.stopLoss.triggered,
      nowMs,
    );
    const confirmedTrailing = this.trailingConfirm.update(
      evaluation.trailing.triggered,
      nowMs,
    );

    if (confirmedStopLoss) {
      await this.autoSell(100, "STOP_LOSS", sellImpactBps);
    } else if (confirmedTrailing) {
      await this.autoSell(100, "TRAILING_STOP", sellImpactBps);
    } else if (evaluation.cascadeTakeProfit) {
      await this.autoSell(
        evaluation.cascadeTakeProfit.sellPercent,
        "TAKE_PROFIT",
        sellImpactBps,
      );
    } else if (evaluation.dueTakeProfitLevels.length > 0) {
      const level = evaluation.dueTakeProfitLevels[0]!;
      await this.autoSell(
        level.sellPercent,
        "TAKE_PROFIT",
        sellImpactBps,
        level.gainPercent,
      );
    }
  }

  async manualBuy(usdAmount: number, reason: TradeReason = "MANUAL"): Promise<Trade> {
    const trade = await this.executor.buy({ usdAmount, reason });
    this.recordBuy(trade);
    return trade;
  }

  hasOpenPosition(): boolean {
    return this.costBasis.tokenAmount > 0;
  }

  /** Executable price of the most recent sell this run, if any - see AUTO_BUY_REQUIRE_BELOW_LAST_SELL. */
  getLastSellPriceUsd(): number | undefined {
    return this.lastSellPriceUsd;
  }

  async manualSell(
    percentOfPosition: number,
    reason: TradeReason,
    currentImpactBps: number,
    bypassImpactGuard = false,
  ): Promise<Trade> {
    if (!bypassImpactGuard) {
      const guard = checkPriceImpact(
        currentImpactBps,
        this.config.risk.maxPriceImpactBps,
      );
      if (!guard.allowed) throw new Error(guard.reason);
    }
    const tokenAmount = this.costBasis.tokenAmount * (percentOfPosition / 100);
    const trade = await this.executor.sell({ tokenAmount, reason });
    this.recordSell(trade);
    return trade;
  }

  panicSell(currentImpactBps: number): Promise<Trade> {
    return this.manualSell(100, "PANIC_EXIT", currentImpactBps, true);
  }

  /** Resets all in-memory state and wipes trade history for one mode - "reset" CLI command (PAPER only). */
  reset(): void {
    this.costBasis = EMPTY_COST_BASIS;
    this.trailingState = undefined;
    this.cascadeReferencePriceUsd = undefined;
    this.lastSellPriceUsd = undefined;
    this.triggeredTakeProfitGains.clear();
    this.stopLossConfirm.reset();
    this.trailingConfirm.reset();
    this.tradesRepo.deleteByMode(this.executor.mode);
  }

  private async autoSell(
    percentOfPosition: number,
    reason: TradeReason,
    currentImpactBps: number,
    takeProfitGainLevel?: number,
  ): Promise<void> {
    const guard = checkPriceImpact(
      currentImpactBps,
      this.config.risk.maxPriceImpactBps,
    );
    if (!guard.allowed) {
      if (Date.now() - this.lastBlockedLogMs > 10_000) {
        this.logger.warn(`${guard.reason} (${reason} held back)`);
        this.lastBlockedLogMs = Date.now();
      }
      return;
    }

    const tokenAmount = this.costBasis.tokenAmount * (percentOfPosition / 100);
    const trade = await this.executor.sell({ tokenAmount, reason });
    this.recordSell(trade);
    if (takeProfitGainLevel !== undefined) {
      this.triggeredTakeProfitGains.add(takeProfitGainLevel);
    }
    this.logger.info(
      `${reason} executed: sold ${trade.tokenAmount.toFixed(4)} for ~$${trade.usdEstimate.toFixed(4)}`,
    );
  }

  private recordBuy(trade: Trade): void {
    this.costBasis = applyTrade(this.costBasis, trade);
    if (!this.trailingState) {
      // First buy of a fresh position (flat -> open). An averaging-in buy
      // while already holding does NOT reach here - trailingState/
      // cascadeReferencePriceUsd both stay put, so the "one merged pool"
      // model applies: new tokens just join the existing thresholds rather
      // than restarting them.
      const entry = averageEntryPriceUsd(this.costBasis);
      if (entry !== undefined) {
        this.trailingState = initTrailingStop(entry);
        this.cascadeReferencePriceUsd = entry;
      }
    }
    this.tradesRepo.insert(trade);
  }

  private recordSell(trade: Trade): void {
    const before = this.costBasis.realizedPnlUsd;
    this.costBasis = applyTrade(this.costBasis, trade);
    trade.realizedPnlUsd = this.costBasis.realizedPnlUsd - before;
    this.tradesRepo.insert(trade);
    if (trade.tokenAmount > 0) {
      const executedPriceUsd = trade.usdEstimate / trade.tokenAmount;
      if (trade.reason === "TAKE_PROFIT") {
        // Advances the cascade's next-tranche reference only - deliberately
        // does NOT touch lastSellPriceUsd, see that field's comment.
        this.cascadeReferencePriceUsd = executedPriceUsd;
      } else {
        this.lastSellPriceUsd = executedPriceUsd;
      }
    }

    if (this.costBasis.tokenAmount <= 0) {
      this.trailingState = undefined;
      this.cascadeReferencePriceUsd = undefined;
      this.triggeredTakeProfitGains.clear();
      this.stopLossConfirm.reset();
      this.trailingConfirm.reset();
    }
  }
}
