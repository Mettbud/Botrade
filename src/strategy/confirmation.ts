/**
 * Wick protection: a trigger (stop loss / trailing stop) must stay true
 * continuously for `confirmMs` before it is treated as confirmed. This
 * stops a single fast wick from forcing a sell that reverses a second later.
 * Disabled entirely via `enabled: false`, in which case every trigger is
 * confirmed immediately.
 */
export class TriggerConfirmation {
  private triggeredSinceMs: number | undefined;

  constructor(
    private readonly enabled: boolean,
    private readonly confirmMs: number,
  ) {}

  /** Feed the current trigger state; returns whether it's now confirmed. */
  update(isTriggered: boolean, nowMs: number): boolean {
    if (!this.enabled) return isTriggered;

    if (!isTriggered) {
      this.triggeredSinceMs = undefined;
      return false;
    }
    if (this.triggeredSinceMs === undefined) {
      this.triggeredSinceMs = nowMs;
    }
    return nowMs - this.triggeredSinceMs >= this.confirmMs;
  }

  reset(): void {
    this.triggeredSinceMs = undefined;
  }
}
