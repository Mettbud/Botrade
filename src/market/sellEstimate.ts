/**
 * Derives an estimated sell price from a real buy quote and the last
 * observed spread, for ticks where we skip the real sell-side quote call
 * (only done while flat - no position to protect, so precision matters
 * less than while it's live money on the line).
 */
export function estimateSellPriceUsd(
  buyPriceUsd: number,
  lastSpread: number,
): number {
  return buyPriceUsd * (1 - lastSpread);
}
