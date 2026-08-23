import type { BotConfig } from "../config/index.js";
import type { JupiterClient } from "../jupiter/client.js";
import { getQuote } from "../jupiter/quote.js";

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;
const REFERENCE_SOL_FOR_PRICE = 1;

/**
 * Tracks the SOL/USD price via a small reference quote against USDC.
 * Refreshed on its own slower interval since it's a secondary input, not
 * the asset being traded, and doesn't need to be polled every tick.
 */
export class SolPriceTracker {
  private lastPrice: number | undefined;
  private lastFetchMs = 0;
  private inFlight: Promise<number> | undefined;

  constructor(
    private readonly client: JupiterClient,
    private readonly config: BotConfig,
  ) {}

  async getPrice(): Promise<number> {
    const now = Date.now();
    if (
      this.lastPrice !== undefined &&
      now - this.lastFetchMs < this.config.price.solPriceRefreshMs
    ) {
      return this.lastPrice;
    }

    // A price-feed tick and a trade can ask for SOL/USD at the same time.
    // Reuse the same network request instead of consuming two Jupiter quota
    // slots before either caller has had a chance to populate the cache.
    if (this.inFlight) return this.inFlight;

    const request = this.fetchFreshPrice();
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) this.inFlight = undefined;
    }
  }

  private async fetchFreshPrice(): Promise<number> {
    const amountLamports = REFERENCE_SOL_FOR_PRICE * 10 ** SOL_DECIMALS;
    const quote = await getQuote(this.client, {
      inputMint: this.config.token.solMint,
      outputMint: this.config.token.usdcMint,
      amount: amountLamports,
      slippageBps: 50,
    });

    const usdcOut = Number(quote.outAmount) / 10 ** USDC_DECIMALS;
    this.lastPrice = usdcOut / REFERENCE_SOL_FOR_PRICE;
    this.lastFetchMs = Date.now();
    return this.lastPrice;
  }
}
