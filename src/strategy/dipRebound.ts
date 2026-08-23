export interface DipWatchState {
  /** true once an extreme drop has been seen and we're waiting for a rebound. */
  watching: boolean;
  /** Lowest executable sell price seen since we started watching. */
  lowestPriceUsd: number;
  /** Effective dip threshold that armed the current watch. */
  armedDipPercent: number;
}

export const IDLE_DIP_WATCH: DipWatchState = {
  watching: false,
  lowestPriceUsd: 0,
  armedDipPercent: 0,
};

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
 * `dipPercent`+ from its recent high, wait until it ticks up even once from
 * its lowest point since then, and treat that as the buy signal. It will
 * sometimes buy into a fall that keeps going; there is no way to know in
 * advance which dip is "the" dip.
 */
export function updateDipWatch(
  state: DipWatchState,
  currentPriceUsd: number,
  recentHighUsd: number | undefined,
  dipPercent: number,
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
        },
        shouldBuy: false,
        dropPercentFromHigh,
      };
    }
    return { state, shouldBuy: false, dropPercentFromHigh };
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

  // Watching: the first uptick from the lowest point seen is the signal.
  if (currentPriceUsd > state.lowestPriceUsd) {
    return { state: IDLE_DIP_WATCH, shouldBuy: true, dropPercentFromHigh: undefined };
  }

  return {
    state: {
      watching: true,
      lowestPriceUsd: Math.min(state.lowestPriceUsd, currentPriceUsd),
      armedDipPercent: state.armedDipPercent,
    },
    shouldBuy: false,
    dropPercentFromHigh: undefined,
  };
}
