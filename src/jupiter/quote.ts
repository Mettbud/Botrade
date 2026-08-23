import type { JupiterClient } from "./client.js";
import type { QuoteParams, QuoteResponse } from "./types.js";

/** GET /swap/v1/quote - the executable quote for a given exact-in swap. */
export async function getQuote(
  client: JupiterClient,
  params: QuoteParams,
): Promise<QuoteResponse> {
  return client.get<QuoteResponse>("/swap/v1/quote", {
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: String(params.amount),
    slippageBps: String(params.slippageBps),
    swapMode: "ExactIn",
  });
}

/** Price impact of a quote, as a plain fraction (0.01 = 1%). */
export function priceImpactFraction(quote: QuoteResponse): number {
  return Number(quote.priceImpactPct);
}

/** Price impact of a quote, in basis points. */
export function priceImpactBps(quote: QuoteResponse): number {
  return priceImpactFraction(quote) * 10_000;
}
