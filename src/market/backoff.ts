/**
 * Delay before the next poll, given how many consecutive failures just
 * happened. Doubles per failure (capped) so a rate-limited or flaky API
 * gets breathing room instead of being hammered again a second later -
 * which on a 429 just makes the rate limit worse.
 */
export function nextPollDelayMs(
  baseIntervalMs: number,
  consecutiveErrors: number,
  maxDelayMs = 30_000,
): number {
  if (consecutiveErrors <= 0) return baseIntervalMs;
  const backoff = baseIntervalMs * 2 ** consecutiveErrors;
  return Math.min(backoff, maxDelayMs);
}
