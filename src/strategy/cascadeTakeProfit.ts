export interface CascadeTakeProfitCheck {
  shouldSell: boolean;
  /** % of the currently remaining position to sell, when shouldSell is true. */
  sellPercent: number;
  /** Gain (percent) from the reference price - always computed, even when not due. */
  gainPercent: number;
}

/**
 * TAKE_PROFIT_MODE=cascade: instead of a fixed ladder measured from the
 * original entry price (see takeProfit.ts), this repeats a single rule -
 * "+gainPercent from the last tranche's sell price (or entry, before the
 * first one) -> sell sellPercent of what's currently left" - indefinitely.
 * The reference price is NOT this function's job to update: the caller
 * (PositionManager) advances it to the executed sell price only after an
 * actual TAKE_PROFIT trade fires, and averaging-in buys never reset it.
 */
export function checkCascadeTakeProfit(
  currentPriceUsd: number,
  referencePriceUsd: number,
  gainPercentThreshold: number,
  sellPercent: number,
): CascadeTakeProfitCheck {
  if (referencePriceUsd <= 0) {
    return { shouldSell: false, sellPercent: 0, gainPercent: 0 };
  }
  const gainPercent =
    ((currentPriceUsd - referencePriceUsd) / referencePriceUsd) * 100;
  // Tiny epsilon guards the exact boundary (e.g. 1.2 - 1.0 in floating point
  // is 0.19999999999999996, not 0.2) - a real price landing exactly on the
  // threshold should still count as due, not miss by a rounding artifact.
  return {
    shouldSell: gainPercent >= gainPercentThreshold - 1e-9,
    sellPercent,
    gainPercent,
  };
}
