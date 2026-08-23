/**
 * Generation token for asynchronous strategy work.
 *
 * PAPER reset cannot cancel an HTTP request already inside fetch(), but it can
 * make every continuation from the old session harmless. Callers capture the
 * epoch before awaiting and verify it again before committing a trade or UI
 * state. Invalidating also prevents an old finally block from clearing a newer
 * session's in-flight flag.
 */
export class AutomationEpoch {
  private value = 0;

  capture(): number {
    return this.value;
  }

  isCurrent(token: number): boolean {
    return token === this.value;
  }

  invalidate(): void {
    this.value += 1;
  }
}
