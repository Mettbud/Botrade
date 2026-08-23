import type { BotConfig } from "../config/index.js";
import type { PriceHistoryBuffer } from "../market/history.js";

export interface CrashBuySignal {
  shouldBuy: boolean;
  /** Price right before the crash (the window's high) - the reference for
   *  the rebound-exit rule. Only set when shouldBuy is true; the caller
   *  stores it with the crash lot only after the buy succeeds. */
  preDropPriceUsd: number | undefined;
  reason:
    | "DISABLED"
    | "ACTIVE_LOT"
    | "NO_SAMPLE"
    | "NO_REFERENCE"
    | "DROP_TOO_SMALL"
    | "SPREAD_TOO_WIDE"
    | "TRIGGERED";
  dropPercent?: number;
  spreadBps?: number;
  sellWasEstimated?: boolean;
}

/**
 * CRASH_BUY_ENABLED: detects a very fast, sharp drop (>= dropPercent within
 * windowMs) on the live executable USD price history and signals an
 * immediate buy - no dip->rebound wait like AutoBuyManager, since the whole
 * point is catching the crash itself. This detector drives Jupiter mode;
 * direct Raydium mode has its separate on-chain vault trigger.
 *
 * Granularity is bounded by how often a real price sample actually lands
 * (PRICE_POLL_INTERVAL_MS, sped up by ONCHAIN_WATCH_ENABLED jumps if on) -
 * windowMs isn't a promise of sub-poll-interval detection, just the window
 * the drop is measured over once samples do land.
 */
export class CrashBuyManager {
  constructor(private readonly config: BotConfig) {}

  evaluate(
    history: PriceHistoryBuffer,
    /** Dedicated crash-buy lot, not an unrelated regular position. */
    hasActiveCrashLot: boolean,
    _nowMs: number,
  ): CrashBuySignal {
    if (!this.config.crashBuy.enabled || hasActiveCrashLot) {
      return {
        shouldBuy: false,
        preDropPriceUsd: undefined,
        reason: this.config.crashBuy.enabled ? "ACTIVE_LOT" : "DISABLED",
      };
    }

    const latest = history.latest();
    if (!latest) {
      return {
        shouldBuy: false,
        preDropPriceUsd: undefined,
        reason: "NO_SAMPLE",
      };
    }

    const preDropPriceUsd = history.maxPrice(this.config.crashBuy.windowMs);
    if (preDropPriceUsd === undefined || preDropPriceUsd <= 0) {
      return {
        shouldBuy: false,
        preDropPriceUsd: undefined,
        reason: "NO_REFERENCE",
        sellWasEstimated: latest.sellIsEstimated,
      };
    }
    const dropPercent =
      ((preDropPriceUsd - latest.sellPriceUsd) / preDropPriceUsd) * 100;
    const spreadBps = latest.spread * 10_000;
    if (dropPercent < this.config.crashBuy.dropPercent) {
      return {
        shouldBuy: false,
        preDropPriceUsd,
        reason: "DROP_TOO_SMALL",
        dropPercent,
        spreadBps,
        sellWasEstimated: latest.sellIsEstimated,
      };
    }
    if (
      !Number.isFinite(spreadBps) ||
      spreadBps > this.config.crashBuy.maxSpreadBps
    ) {
      return {
        shouldBuy: false,
        preDropPriceUsd,
        reason: "SPREAD_TOO_WIDE",
        dropPercent,
        spreadBps,
        sellWasEstimated: latest.sellIsEstimated,
      };
    }

    return {
      shouldBuy: true,
      preDropPriceUsd,
      reason: "TRIGGERED",
      dropPercent,
      spreadBps,
      sellWasEstimated: latest.sellIsEstimated,
    };
  }

  /** Rechecks a signal against a forced fresh round-trip quote before buy. */
  isSignalStillValid(
    currentSellPriceUsd: number,
    spreadFraction: number,
    preDropPriceUsd: number,
  ): boolean {
    if (
      !Number.isFinite(currentSellPriceUsd) ||
      currentSellPriceUsd <= 0 ||
      !Number.isFinite(preDropPriceUsd) ||
      preDropPriceUsd <= 0
    ) {
      return false;
    }
    const dropPercent =
      ((preDropPriceUsd - currentSellPriceUsd) / preDropPriceUsd) * 100;
    if (dropPercent < this.config.crashBuy.dropPercent) return false;

    // A genuine crash naturally widens spread. This only rejects the
    // pathological/rugged case and is deliberately looser than normal TP.
    const spreadBps = spreadFraction * 10_000;
    return Number.isFinite(spreadBps) &&
      spreadBps <= this.config.crashBuy.maxSpreadBps;
  }
}
