import type { BotConfig } from "../config/index.js";
import type { PriceHistoryBuffer } from "../market/history.js";
import {
  IDLE_DIP_WATCH,
  updateDipWatch,
  type DipWatchState,
} from "../strategy/dipRebound.js";
import { resolveAutoBuyDipThreshold } from "../strategy/autoBuyDipThreshold.js";

export interface AutoBuyStatus {
  enabled: boolean;
  watching: boolean;
  /** Current drop from the recent high, while not yet watching. */
  dropPercentFromHigh: number | undefined;
  /** The low being tracked while watching, waiting for an uptick past it. */
  watchingLowUsd: number | undefined;
  /** Dip threshold currently applied after peak protection is considered. */
  effectiveDipPercent: number;
  peakProtectionActive: boolean;
  /** Largest ordered low-to-high rise in the peak-protection window. */
  recentRunUpPercent: number | undefined;
  volatilityProtectionActive: boolean;
  /** Rolling realized volatility calculated from consecutive price moves. */
  realizedVolatilityPercent: number | undefined;
}

/**
 * Wires the dip/rebound heuristic to live price history. By default only
 * watches for a buy signal while flat (no open position); with
 * AUTO_BUY_ALLOW_AVERAGING=true it also fires while already holding a
 * position, buying more on each new qualifying dip ("averaging in") -
 * meaningfully more risk, since it can keep buying into a token that keeps
 * falling. AUTO_BUY_MIN_GAP_MS spaces out consecutive buys regardless.
 * See strategy/dipRebound.ts for the actual signal logic.
 */
export class AutoBuyManager {
  private state: DipWatchState = IDLE_DIP_WATCH;
  // -Infinity, not 0: the gap check is `nowMs - lastBuyAtMs >= minGapMs`,
  // and 0 would wrongly block a first buy if nowMs is ever small (e.g. in
  // a test using timestamps from epoch 0 rather than Date.now()).
  private lastBuyAtMs = -Infinity;
  private lastDropPercentFromHigh: number | undefined;
  private effectiveDipPercent: number;
  private peakProtectionActive = false;
  private recentRunUpPercent: number | undefined;
  private volatilityProtectionActive = false;
  private realizedVolatilityPercent: number | undefined;

  constructor(private readonly config: BotConfig) {
    this.effectiveDipPercent = config.autoBuy.dipPercent;
  }

  /**
   * Returns true exactly on the tick a buy should fire.
   * `lastSellPriceUsd` (PositionManager.getLastSellPriceUsd()) gates the
   * final decision when AUTO_BUY_REQUIRE_BELOW_LAST_SELL is on: never
   * re-enter at or above the price of the most recent sell this run.
   */
  evaluate(
    history: PriceHistoryBuffer,
    hasOpenPosition: boolean,
    nowMs: number,
    lastSellPriceUsd?: number,
  ): boolean {
    const blockedByPosition = hasOpenPosition && !this.config.autoBuy.allowAveraging;
    if (!this.config.autoBuy.enabled || blockedByPosition) {
      this.state = IDLE_DIP_WATCH;
      return false;
    }

    const latest = history.latest();
    if (!latest) return false;

    this.recentRunUpPercent = history.maxRunUpPercent(
      this.config.autoBuy.peakLookbackMs,
    );
    this.realizedVolatilityPercent = history.realizedVolatilityPercent(
      this.config.autoBuy.volatilityLookbackMs,
    );
    const threshold = resolveAutoBuyDipThreshold({
      baseDipPercent: this.config.autoBuy.dipPercent,
      peakProtectionEnabled: this.config.autoBuy.peakProtectionEnabled,
      recentRunUpPercent: this.recentRunUpPercent ?? 0,
      peakRunUpPercent: this.config.autoBuy.peakRunUpPercent,
      peakDipPercent: this.config.autoBuy.peakDipPercent,
      volatilityProtectionEnabled:
        this.config.autoBuy.volatilityProtectionEnabled,
      realizedVolatilityPercent: this.realizedVolatilityPercent ?? 0,
      volatilityMultiplier: this.config.autoBuy.volatilityMultiplier,
      volatilityMaxDipPercent: this.config.autoBuy.volatilityMaxDipPercent,
    });
    this.effectiveDipPercent = threshold.effectiveDipPercent;
    this.peakProtectionActive = threshold.peakProtectionActive;
    this.volatilityProtectionActive =
      threshold.volatilityProtectionActive;

    const highLookbackMs = Math.max(
      this.config.autoBuy.lookbackMs,
      this.peakProtectionActive ? this.config.autoBuy.peakLookbackMs : 0,
      this.volatilityProtectionActive
        ? this.config.autoBuy.volatilityLookbackMs
        : 0,
    );
    const recentHigh = history.maxPrice(highLookbackMs);
    const result = updateDipWatch(
      this.state,
      latest.sellPriceUsd,
      recentHigh,
      this.effectiveDipPercent,
    );
    this.state = result.state;
    this.lastDropPercentFromHigh = result.dropPercentFromHigh;

    if (!result.shouldBuy) return false;
    if (nowMs - this.lastBuyAtMs < this.config.autoBuy.minGapMs) return false;
    if (
      this.config.autoBuy.requireBelowLastSell &&
      lastSellPriceUsd !== undefined &&
      latest.sellPriceUsd >= lastSellPriceUsd
    ) {
      return false;
    }

    this.lastBuyAtMs = nowMs;
    return true;
  }

  status(): AutoBuyStatus {
    return {
      enabled: this.config.autoBuy.enabled,
      watching: this.state.watching,
      dropPercentFromHigh: this.lastDropPercentFromHigh,
      watchingLowUsd: this.state.watching ? this.state.lowestPriceUsd : undefined,
      effectiveDipPercent: this.effectiveDipPercent,
      peakProtectionActive: this.peakProtectionActive,
      recentRunUpPercent: this.recentRunUpPercent,
      volatilityProtectionActive: this.volatilityProtectionActive,
      realizedVolatilityPercent: this.realizedVolatilityPercent,
    };
  }
}
