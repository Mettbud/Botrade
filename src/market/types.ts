export interface PriceSample {
  timestampMs: number;
  /** USD price if you bought `referenceSolAmount` worth of SOL right now. */
  buyPriceUsd: number;
  /** USD price if you immediately sold that same token amount back to SOL. */
  sellPriceUsd: number;
  /**
   * True when sellPriceUsd/priceImpactSellBps are estimated from the last
   * real sell quote's spread rather than freshly fetched - only happens
   * while flat (no open position), to cut API load in half when there's
   * nothing to actually sell. Always false while holding a position.
   */
  sellIsEstimated: boolean;
  /** Round-trip spread as a fraction of buyPriceUsd (0.02 = 2%). */
  spread: number;
  priceImpactBuyBps: number;
  priceImpactSellBps: number;
  referenceSolAmount: number;
  referenceTokenAmountUi: number;
  solUsdPrice: number;
}

export interface PriceChangeWindow {
  windowMs: number;
  label: string;
  changePercent: number | undefined;
}
