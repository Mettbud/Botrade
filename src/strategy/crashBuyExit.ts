/**
 * CRASH_BUY exit rule: sell the whole crash-buy position once price
 * recovers to within `tolerancePercent` of P0 (the price right before the
 * crash) - i.e. strictly above P0 * (1 - tolerancePercent/100). Strictly
 * above, not >=, so landing exactly on the tolerance boundary does not yet
 * count as recovered (matches the worked example: P0=100, tolerance=3% ->
 * 97 does not sell, just above 97 does).
 */
export function checkCrashBuyRebound(
  currentPriceUsd: number,
  preDropPriceUsd: number,
  tolerancePercent: number,
): boolean {
  if (preDropPriceUsd <= 0) return false;
  const target = preDropPriceUsd * (1 - tolerancePercent / 100);
  return currentPriceUsd > target;
}
