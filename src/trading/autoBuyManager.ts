import type { BotConfig } from "../config/index.js";
import type { PriceHistoryBuffer } from "../market/history.js";
import {
  IDLE_DIP_WATCH,
  updateDipWatch,
  type DipWatchState,
} from "../strategy/dipRebound.js";

/**
 * A purely technical minimum gap between an auto-buy and the previous one -
 * not a strategy choice (the user explicitly wants no deliberate cooldown),
 * just a guard against a bug causing back-to-back buys in the same instant.
 */
const MIN_GAP_MS = 3_000;

export interface AutoBuyStatus {
  enabled: boolean;
  watching: boolean;
  /** Current drop from the recent high, while not yet watching. */
  dropPercentFromHigh: number | undefined;
  /** The low being tracked while watching, waiting for an uptick past it. */
  watchingLowUsd: number | undefined;
}

/**
 * Wires the dip/rebound heuristic to live price history: only watches for
 * a buy signal while the bot is flat (no open position) and AUTO_BUY_ENABLED
 * is on. See strategy/dipRebound.ts for the actual signal logic.
 */
export class AutoBuyManager {
  private state: DipWatchState = IDLE_DIP_WATCH;
  // -Infinity, not 0: the gap check is `nowMs - lastBuyAtMs >= MIN_GAP_MS`,
  // and 0 would wrongly block a first buy if nowMs is ever small (e.g. in
  // a test using timestamps from epoch 0 rather than Date.now()).
  private lastBuyAtMs = -Infinity;
  private lastDropPercentFromHigh: number | undefined;

  constructor(private readonly config: BotConfig) {}

  /** Returns true exactly on the tick a buy should fire. */
  evaluate(
    history: PriceHistoryBuffer,
    hasOpenPosition: boolean,
    nowMs: number,
  ): boolean {
    if (!this.config.autoBuy.enabled || hasOpenPosition) {
      this.state = IDLE_DIP_WATCH;
      return false;
    }

    const latest = history.latest();
    if (!latest) return false;

    const recentHigh = history.maxPrice(this.config.autoBuy.lookbackMs);
    const result = updateDipWatch(
      this.state,
      latest.sellPriceUsd,
      recentHigh,
      this.config.autoBuy.dipPercent,
    );
    this.state = result.state;
    this.lastDropPercentFromHigh = result.dropPercentFromHigh;

    if (result.shouldBuy && nowMs - this.lastBuyAtMs >= MIN_GAP_MS) {
      this.lastBuyAtMs = nowMs;
      return true;
    }
    return false;
  }

  status(): AutoBuyStatus {
    return {
      enabled: this.config.autoBuy.enabled,
      watching: this.state.watching,
      dropPercentFromHigh: this.lastDropPercentFromHigh,
      watchingLowUsd: this.state.watching ? this.state.lowestPriceUsd : undefined,
    };
  }
}
