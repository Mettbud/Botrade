import type { BotConfig } from "../config/index.js";
import type { PriceHistoryBuffer } from "../market/history.js";

export interface CrashBuySignal {
  shouldBuy: boolean;
  /** Price right before the crash (the window's high) - the reference for
   *  the rebound-exit rule. Only set when shouldBuy is true; the caller
   *  stores it with the crash lot only after the buy succeeds. */
  preDropPriceUsd: number | undefined;
}

/**
 * CRASH_BUY_ENABLED: detects a very fast, sharp drop (>= dropPercent within
 * windowMs) on the live executable USD price history and signals an
 * immediate buy - no dip->rebound wait like AutoBuyManager, since the whole
 * point is catching the crash itself. Still only ever a *signal*: the
 * caller executes through a real Jupiter quote, same as everything else.
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
      return { shouldBuy: false, preDropPriceUsd: undefined };
    }

    const latest = history.latest();
    if (!latest) return { shouldBuy: false, preDropPriceUsd: undefined };

    const preDropPriceUsd = history.maxPrice(this.config.crashBuy.windowMs);
    if (preDropPriceUsd === undefined || preDropPriceUsd <= 0) {
      return { shouldBuy: false, preDropPriceUsd: undefined };
    }

    if (
      !this.isSignalStillValid(
        latest.sellPriceUsd,
        latest.spread,
        preDropPriceUsd,
      )
    ) {
      return { shouldBuy: false, preDropPriceUsd: undefined };
    }

    return { shouldBuy: true, preDropPriceUsd };
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
