export interface TrailingStopState {
  /** Highest executable sell price observed since entry. */
  highestPriceUsd: number;
  /** Whether the trailing stop has met its activation threshold yet. */
  armed: boolean;
}

export function initTrailingStop(entryPriceUsd: number): TrailingStopState {
  return { highestPriceUsd: entryPriceUsd, armed: false };
}

export interface TrailingStopCheck {
  state: TrailingStopState;
  triggered: boolean;
  drawdownFromHighPercent: number;
}

/**
 * Updates the trailing high-water mark and checks whether the current
 * executable sell price has fallen far enough from it to trigger a sell.
 * Activation is gated by `activationPercent` so a trailing stop doesn't
 * fire on noise before the position is meaningfully in profit.
 */
export function updateTrailingStop(
  state: TrailingStopState,
  currentSellPriceUsd: number,
  entryPriceUsd: number,
  trailingStopPercent: number,
  activationPercent: number,
): TrailingStopCheck {
  const highestPriceUsd = Math.max(state.highestPriceUsd, currentSellPriceUsd);

  const gainFromEntryPercent =
    entryPriceUsd > 0
      ? ((highestPriceUsd - entryPriceUsd) / entryPriceUsd) * 100
      : 0;
  const armed = state.armed || gainFromEntryPercent >= activationPercent;

  const drawdownFromHighPercent =
    highestPriceUsd > 0
      ? ((highestPriceUsd - currentSellPriceUsd) / highestPriceUsd) * 100
      : 0;

  const triggered = armed && drawdownFromHighPercent >= trailingStopPercent;

  return {
    state: { highestPriceUsd, armed },
    triggered,
    drawdownFromHighPercent,
  };
}
