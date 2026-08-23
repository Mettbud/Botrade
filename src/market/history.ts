import type { PriceSample } from "./types.js";

export const CHANGE_WINDOWS_MS = [
  { label: "5s", windowMs: 5_000 },
  { label: "15s", windowMs: 15_000 },
  { label: "30s", windowMs: 30_000 },
  { label: "1m", windowMs: 60_000 },
  { label: "5m", windowMs: 300_000 },
] as const;

const MAX_AGE_MS = 10 * 60_000;

/** In-memory ring buffer of recent price samples used for % change math. */
export class PriceHistoryBuffer {
  private samples: PriceSample[] = [];

  push(sample: PriceSample): void {
    this.samples.push(sample);
    const cutoff = sample.timestampMs - MAX_AGE_MS;
    while (this.samples[0] && this.samples[0].timestampMs < cutoff) {
      this.samples.shift();
    }
  }

  latest(): PriceSample | undefined {
    return this.samples[this.samples.length - 1];
  }

  /**
   * % change of sellPriceUsd (the price you could actually exit at) from
   * the oldest sample within `windowMs` up to the latest sample.
   */
  changePercent(windowMs: number): number | undefined {
    const latest = this.latest();
    if (!latest) return undefined;

    const cutoff = latest.timestampMs - windowMs;
    const reference = this.samples.find((s) => s.timestampMs >= cutoff);
    if (!reference || reference === latest) return undefined;
    if (reference.sellPriceUsd === 0) return undefined;

    return (
      ((latest.sellPriceUsd - reference.sellPriceUsd) /
        reference.sellPriceUsd) *
      100
    );
  }

  allChanges(): { label: string; windowMs: number; changePercent: number | undefined }[] {
    return CHANGE_WINDOWS_MS.map((w) => ({
      ...w,
      changePercent: this.changePercent(w.windowMs),
    }));
  }

  /** Highest sellPriceUsd seen within the last `windowMs`, including now. */
  maxPrice(windowMs: number): number | undefined {
    const latest = this.latest();
    if (!latest) return undefined;
    const cutoff = latest.timestampMs - windowMs;
    let max: number | undefined;
    for (const s of this.samples) {
      if (s.timestampMs < cutoff) continue;
      if (max === undefined || s.sellPriceUsd > max) max = s.sellPriceUsd;
    }
    return max;
  }
}
