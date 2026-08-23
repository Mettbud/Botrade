/**
 * Approximate price from a simple constant-product pool's two vault
 * balances. This is intentionally NOT the precise, executable price
 * (that always comes from a real Jupiter quote before any trade) - it's
 * only good enough to power the fast "something just moved" trigger.
 */
export function priceFromReserves(
  baseReserveRaw: bigint,
  baseDecimals: number,
  quoteReserveRaw: bigint,
  quoteDecimals: number,
): number {
  if (baseReserveRaw <= 0n) return 0;
  const base = Number(baseReserveRaw) / 10 ** baseDecimals;
  const quote = Number(quoteReserveRaw) / 10 ** quoteDecimals;
  return quote / base;
}
