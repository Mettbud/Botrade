import type { BotConfig } from "../config/index.js";
import type { JupiterClient } from "./client.js";
import type { QuoteResponse, SwapResponse } from "./types.js";

/** POST /swap/v1/swap - builds a signable transaction for a given quote. */
export async function buildSwapTransaction(
  client: JupiterClient,
  config: BotConfig,
  quote: QuoteResponse,
  userPublicKey: string,
): Promise<SwapResponse> {
  return client.post<SwapResponse>("/swap/v1/swap", {
    quoteResponse: quote,
    userPublicKey,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: config.execution.priorityMaxLamports,
        priorityLevel: config.execution.priorityLevel,
      },
    },
  });
}
