export interface JumpCheck {
  jumped: boolean;
  changePercent: number | undefined;
}

/**
 * Tracks a rolling window of (timestamp, price) samples for one pool and
 * flags when price has moved by at least `thresholdPercent` (either
 * direction) within `windowMs`. This is the fast "something just moved"
 * trigger only - never the price a trade is actually decided on.
 */
export class JumpDetector {
  private samples: { t: number; price: number }[] = [];

  constructor(
    private readonly windowMs: number,
    private readonly thresholdPercent: number,
  ) {}

  update(timestampMs: number, price: number): JumpCheck {
    this.samples.push({ t: timestampMs, price });
    const cutoff = timestampMs - this.windowMs;
    while (this.samples[0] && this.samples[0].t < cutoff) {
      this.samples.shift();
    }

    const oldest = this.samples[0];
    const latest = this.samples[this.samples.length - 1]!;
    if (!oldest || oldest === latest || oldest.price === 0) {
      return { jumped: false, changePercent: undefined };
    }

    const changePercent = ((latest.price - oldest.price) / oldest.price) * 100;
    return {
      jumped: Math.abs(changePercent) >= this.thresholdPercent,
      changePercent,
    };
  }
}
