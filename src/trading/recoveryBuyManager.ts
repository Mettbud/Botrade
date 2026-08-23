import type { BotConfig } from "../config/index.js";
import type { PriceHistoryBuffer } from "../market/history.js";
import {
  averageEntryPriceUsd,
  type CostBasisState,
} from "../strategy/costBasis.js";
import {
  IDLE_DIP_WATCH,
  updateDipWatch,
  type DipWatchState,
} from "../strategy/dipRebound.js";

const POSITION_EPSILON = 1e-12;

export type RecoveryBuyPhase =
  | "OFF"
  | "WAITING"
  | "WATCHING"
  | "CONFIRMING"
  | "TRIGGERED"
  | "BUYING"
  | "BLOCKED"
  | "MAXED";

export interface RecoveryBuyContext {
  regularCostBasis: CostBasisState;
  cascadeSoldTokenAmount: number;
  addsUsed: number;
  hasActiveCrashLot: boolean;
  nowMs: number;
}

export interface RecoveryBuyStatus {
  enabled: boolean;
  phase: RecoveryBuyPhase;
  reason?: string;
  lossPercent?: number;
  dropPercentFromHigh?: number;
  lowPriceUsd?: number;
  reboundPercentFromLow?: number;
  confirmationProgressPercent?: number;
  addsUsed: number;
  maxAdds: number;
  plannedPortfolioPercent: number;
  dropTriggerPercent: number;
  reboundTriggerPercent: number;
}

/**
 * Allows one tightly-gated add to an existing regular position after a deep
 * drawdown has produced a meaningful, time-confirmed rebound. This is not
 * unrestricted averaging and never runs after a cascade payout.
 */
export class RecoveryBuyManager {
  private state: DipWatchState = IDLE_DIP_WATCH;
  private currentStatus: RecoveryBuyStatus;

  constructor(private readonly config: BotConfig) {
    this.currentStatus = this.baseStatus(
      config.recoveryBuy.enabled ? "WAITING" : "OFF",
      0,
    );
  }

  reset(): void {
    this.state = IDLE_DIP_WATCH;
    this.currentStatus = this.baseStatus(
      this.config.recoveryBuy.enabled ? "WAITING" : "OFF",
      0,
    );
  }

  evaluate(
    history: PriceHistoryBuffer,
    context: RecoveryBuyContext,
  ): boolean {
    const blocked = this.eligibilityBlock(context);
    if (blocked) {
      this.state = IDLE_DIP_WATCH;
      this.currentStatus = {
        ...this.baseStatus(blocked.phase, context.addsUsed),
        reason: blocked.reason,
        lossPercent: blocked.lossPercent,
      };
      return false;
    }

    const latest = history.latest();
    const entryPriceUsd = averageEntryPriceUsd(context.regularCostBasis);
    if (!latest || entryPriceUsd === undefined) {
      this.state = IDLE_DIP_WATCH;
      this.currentStatus = {
        ...this.baseStatus("WAITING", context.addsUsed),
        reason: "waiting for an executable price sample",
      };
      return false;
    }
    const lossPercent =
      ((entryPriceUsd - latest.sellPriceUsd) / entryPriceUsd) * 100;
    if (lossPercent < this.config.recoveryBuy.minLossPercent) {
      this.state = IDLE_DIP_WATCH;
      this.currentStatus = {
        ...this.baseStatus("WAITING", context.addsUsed),
        reason: `loss ${lossPercent.toFixed(2)}% is below the ${this.config.recoveryBuy.minLossPercent}% recovery zone`,
        lossPercent,
      };
      return false;
    }
    if (lossPercent > this.config.recoveryBuy.maxLossPercent) {
      this.state = IDLE_DIP_WATCH;
      this.currentStatus = {
        ...this.baseStatus("BLOCKED", context.addsUsed),
        reason: `loss ${lossPercent.toFixed(2)}% exceeds the ${this.config.recoveryBuy.maxLossPercent}% safety limit`,
        lossPercent,
      };
      return false;
    }
    const recentHigh = history.maxPrice(this.config.recoveryBuy.lookbackMs);
    const dropPercentFromHigh =
      recentHigh && recentHigh > 0
        ? ((recentHigh - latest.sellPriceUsd) / recentHigh) * 100
        : undefined;
    const result = updateDipWatch(
      this.state,
      latest.sellPriceUsd,
      recentHigh,
      this.config.recoveryBuy.dropPercent,
      {
        nowMs: context.nowMs,
        reboundPercent: this.config.recoveryBuy.reboundPercent,
        confirmationMs: this.config.recoveryBuy.confirmationMs,
        timeoutMs: this.config.recoveryBuy.timeoutMs,
      },
    );
    this.state = result.state;

    const reboundPercentFromLow = this.state.watching
      ? ((latest.sellPriceUsd - this.state.lowestPriceUsd) /
          this.state.lowestPriceUsd) *
        100
      : undefined;
    const confirmationProgressPercent =
      this.state.reboundStartedAtMs === undefined
        ? undefined
        : this.config.recoveryBuy.confirmationMs <= 0
          ? 100
          : Math.min(
              100,
              ((context.nowMs - this.state.reboundStartedAtMs) /
                this.config.recoveryBuy.confirmationMs) *
                100,
            );

    if (!result.shouldBuy) {
      this.currentStatus = {
        ...this.baseStatus(
          this.state.reboundStartedAtMs !== undefined
            ? "CONFIRMING"
            : this.state.watching
              ? "WATCHING"
              : "WAITING",
          context.addsUsed,
        ),
        lossPercent,
        dropPercentFromHigh,
        lowPriceUsd: this.state.watching
          ? this.state.lowestPriceUsd
          : undefined,
        reboundPercentFromLow,
        confirmationProgressPercent,
      };
      return false;
    }

    const spreadBps = latest.spread * 10_000;
    if (
      !Number.isFinite(spreadBps) ||
      spreadBps > this.config.recoveryBuy.maxSpreadBps
    ) {
      this.currentStatus = {
        ...this.baseStatus("BLOCKED", context.addsUsed),
        reason: `spread ${spreadBps.toFixed(0)} bps exceeds ${this.config.recoveryBuy.maxSpreadBps} bps`,
        lossPercent,
        dropPercentFromHigh,
      };
      return false;
    }
    if (latest.priceImpactBuyBps > this.config.risk.maxPriceImpactBps) {
      this.currentStatus = {
        ...this.baseStatus("BLOCKED", context.addsUsed),
        reason: `buy impact ${latest.priceImpactBuyBps.toFixed(0)} bps exceeds ${this.config.risk.maxPriceImpactBps} bps`,
        lossPercent,
        dropPercentFromHigh,
      };
      return false;
    }

    this.currentStatus = {
      ...this.baseStatus("TRIGGERED", context.addsUsed),
      lossPercent,
      dropPercentFromHigh,
    };
    return true;
  }

  status(buying = false): RecoveryBuyStatus {
    return buying
      ? { ...this.currentStatus, phase: "BUYING", reason: "order in progress" }
      : this.currentStatus;
  }

  private eligibilityBlock(context: RecoveryBuyContext): {
    phase: RecoveryBuyPhase;
    reason: string;
    lossPercent?: number;
  } | undefined {
    if (!this.config.recoveryBuy.enabled) {
      return { phase: "OFF", reason: "disabled" };
    }
    if (context.regularCostBasis.tokenAmount <= POSITION_EPSILON) {
      return { phase: "WAITING", reason: "no regular position" };
    }
    if (context.addsUsed >= this.config.recoveryBuy.maxAddsPerPosition) {
      return { phase: "MAXED", reason: "add limit reached" };
    }
    if (context.cascadeSoldTokenAmount > POSITION_EPSILON) {
      return { phase: "BLOCKED", reason: "cascade payout already executed" };
    }
    if (context.hasActiveCrashLot) {
      return { phase: "BLOCKED", reason: "isolated crash lot is active" };
    }
    const latest = context.regularCostBasis.tokenAmount > 0
      ? averageEntryPriceUsd(context.regularCostBasis)
      : undefined;
    if (latest === undefined) {
      return { phase: "BLOCKED", reason: "regular entry is unavailable" };
    }
    return undefined;
  }

  private baseStatus(
    phase: RecoveryBuyPhase,
    addsUsed: number,
  ): RecoveryBuyStatus {
    return {
      enabled: this.config.recoveryBuy.enabled,
      phase,
      addsUsed,
      maxAdds: this.config.recoveryBuy.maxAddsPerPosition,
      plannedPortfolioPercent: this.config.recoveryBuy.portfolioPercent,
      dropTriggerPercent: this.config.recoveryBuy.dropPercent,
      reboundTriggerPercent: this.config.recoveryBuy.reboundPercent,
    };
  }
}
