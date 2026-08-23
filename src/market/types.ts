export interface PriceSample {
  timestampMs: number;
  /** USD price if you bought `referenceSolAmount` worth of SOL right now. */
  buyPriceUsd: number;
  /** USD price if you immediately sold that same token amount back to SOL. */
  sellPriceUsd: number;
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
