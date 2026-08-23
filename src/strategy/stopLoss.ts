export interface StopLossCheck {
  triggered: boolean;
  lossPercent: number;
}

/**
 * Compares the current *executable* sell price (not a chart price) against
 * the weighted average entry price.
 */
export function checkStopLoss(
  currentSellPriceUsd: number,
  averageEntryPriceUsd: number,
  stopLossPercent: number,
): StopLossCheck {
  if (averageEntryPriceUsd <= 0) {
    return { triggered: false, lossPercent: 0 };
  }
  const lossPercent =
    ((averageEntryPriceUsd - currentSellPriceUsd) / averageEntryPriceUsd) *
    100;
  return { triggered: lossPercent >= stopLossPercent, lossPercent };
}
