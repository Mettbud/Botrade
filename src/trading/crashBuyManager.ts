import type { BotConfig } from "../config/index.js";
import type { PriceHistoryBuffer } from "../market/history.js";

export interface CrashBuySignal {
  shouldBuy: boolean;
  /** Price right before the crash (the window's high) - the reference for
   *  the rebound-exit rule. Only set when shouldBuy is true. */
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
  private lastBuyAtMs = 0;
  private activePreDropPriceUsd: number | undefined;

  constructor(private readonly config: BotConfig) {}

  evaluate(
    history: PriceHistoryBuffer,
    hasOpenPosition: boolean,
    nowMs: number,
  ): CrashBuySignal {
    if (!this.config.crashBuy.enabled || hasOpenPosition) {
      return { shouldBuy: false, preDropPriceUsd: undefined };
    }

    const latest = history.latest();
    if (!latest) return { shouldBuy: false, preDropPriceUsd: undefined };

    const preDropPriceUsd = history.maxPrice(this.config.crashBuy.windowMs);
    if (preDropPriceUsd === undefined || preDropPriceUsd <= 0) {
      return { shouldBuy: false, preDropPriceUsd: undefined };
    }

    const dropPercent =
      ((preDropPriceUsd - latest.sellPriceUsd) / preDropPriceUsd) * 100;
    if (dropPercent < this.config.crashBuy.dropPercent) {
      return { shouldBuy: false, preDropPriceUsd: undefined };
    }

    // A genuine crash naturally widens spread - CRASH_BUY_MAX_SPREAD_BPS is
    // deliberately loose (see schema.ts) and only meant to reject the
    // pathological case (a near-drained/rugged pool), not normal volatility.
    const spreadBps = latest.spread * 10_000;
    if (spreadBps > this.config.crashBuy.maxSpreadBps) {
      return { shouldBuy: false, preDropPriceUsd: undefined };
    }

    this.lastBuyAtMs = nowMs;
    this.activePreDropPriceUsd = preDropPriceUsd;
    return { shouldBuy: true, preDropPriceUsd };
  }

  /** P0 for the active crash-buy position's rebound-exit rule, if any. */
  getActivePreDropPriceUsd(): number | undefined {
    return this.activePreDropPriceUsd;
  }

  /** Called once the crash-buy position is fully closed (either exit). */
  clearActivePosition(): void {
    this.activePreDropPriceUsd = undefined;
  }

  getLastBuyAtMs(): number {
    return this.lastBuyAtMs;
  }
}
