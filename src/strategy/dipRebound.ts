export interface DipWatchState {
  /** true once an extreme drop has been seen and we're waiting for a rebound. */
  watching: boolean;
  /** Lowest executable sell price seen since we started watching. */
  lowestPriceUsd: number;
  /** Effective dip threshold that armed the current watch. */
  armedDipPercent: number;
  /** When this dip watch started; used to expire stale rebounds. */
  armedAtMs: number;
  /** When the configured rebound first held above its trigger. */
  reboundStartedAtMs?: number;
}

export const IDLE_DIP_WATCH: DipWatchState = {
  watching: false,
  lowestPriceUsd: 0,
  armedDipPercent: 0,
  armedAtMs: 0,
};

export interface DipReboundOptions {
  nowMs: number;
  /** Required rise from the observed low. Zero preserves legacy first-uptick behavior. */
  reboundPercent: number;
  /** How long the rebound must remain above its trigger. */
  confirmationMs: number;
  /** Expire an armed dip that never confirms; zero disables expiry. */
  timeoutMs: number;
}

export interface DipReboundResult {
  state: DipWatchState;
  /** true exactly once, on the tick the rebound is confirmed - buy now. */
  shouldBuy: boolean;
  /** Current drop from the recent high, for display, while not yet watching. */
  dropPercentFromHigh: number | undefined;
}

/**
 * Watches for CYBERLEEK's known pattern: a sudden, extreme wick down
 * (someone dumping to re-enter cheaper) followed by an immediate bounce.
 * Not a prediction - a specific, honest heuristic: once price has dropped
 * `dipPercent`+ from its recent high, wait for the configured rebound from
 * its lowest point and optional confirmation period. It will
 * sometimes buy into a fall that keeps going; there is no way to know in
 * advance which dip is "the" dip.
 */
export function updateDipWatch(
  state: DipWatchState,
  currentPriceUsd: number,
  recentHighUsd: number | undefined,
  dipPercent: number,
  options: DipReboundOptions = {
    nowMs: 0,
    reboundPercent: 0,
    confirmationMs: 0,
    timeoutMs: 0,
  },
): DipReboundResult {
  if (!state.watching) {
    if (recentHighUsd === undefined || recentHighUsd <= 0) {
      return { state, shouldBuy: false, dropPercentFromHigh: undefined };
    }
    const dropPercentFromHigh =
      ((recentHighUsd - currentPriceUsd) / recentHighUsd) * 100;

    if (dropPercentFromHigh >= dipPercent) {
      return {
        state: {
          watching: true,
          lowestPriceUsd: currentPriceUsd,
          armedDipPercent: dipPercent,
          armedAtMs: options.nowMs,
        },
        shouldBuy: false,
        dropPercentFromHigh,
      };
    }
    return { state, shouldBuy: false, dropPercentFromHigh };
  }

  if (
    options.timeoutMs > 0 &&
    options.nowMs - state.armedAtMs >= options.timeoutMs
  ) {
    return {
      state: IDLE_DIP_WATCH,
      shouldBuy: false,
      dropPercentFromHigh: undefined,
    };
  }

  // Volatility/peak protection may tighten while a dip is already being
  // watched. If the current drawdown has not reached that newer threshold,
  // disarm instead of buying on a small uptick under stale calm-market rules.
  if (dipPercent > state.armedDipPercent) {
    if (recentHighUsd === undefined || recentHighUsd <= 0) {
      return {
        state: IDLE_DIP_WATCH,
        shouldBuy: false,
        dropPercentFromHigh: undefined,
      };
    }
    const currentDropPercent =
      ((recentHighUsd - currentPriceUsd) / recentHighUsd) * 100;
    if (currentDropPercent < dipPercent) {
      return {
        state: IDLE_DIP_WATCH,
        shouldBuy: false,
        dropPercentFromHigh: currentDropPercent,
      };
    }
    state = { ...state, armedDipPercent: dipPercent };
  }

  if (currentPriceUsd < state.lowestPriceUsd) {
    return {
      state: {
        ...state,
        lowestPriceUsd: currentPriceUsd,
        reboundStartedAtMs: undefined,
      },
      shouldBuy: false,
      dropPercentFromHigh: undefined,
    };
  }

  const reboundTriggerPrice =
    state.lowestPriceUsd * (1 + Math.max(0, options.reboundPercent) / 100);
  const reboundReached =
    options.reboundPercent <= 0
      ? currentPriceUsd > state.lowestPriceUsd
      : currentPriceUsd >= reboundTriggerPrice;
  if (!reboundReached) {
    return {
      state: { ...state, reboundStartedAtMs: undefined },
      shouldBuy: false,
      dropPercentFromHigh: undefined,
    };
  }

  if (options.confirmationMs <= 0) {
    return {
      state: IDLE_DIP_WATCH,
      shouldBuy: true,
      dropPercentFromHigh: undefined,
    };
  }

  const reboundStartedAtMs = state.reboundStartedAtMs ?? options.nowMs;
  if (options.nowMs - reboundStartedAtMs >= options.confirmationMs) {
    return {
      state: IDLE_DIP_WATCH,
      shouldBuy: true,
      dropPercentFromHigh: undefined,
    };
  }

  return {
    state: {
      ...state,
      reboundStartedAtMs,
    },
    shouldBuy: false,
    dropPercentFromHigh: undefined,
  };
}
