import type { BotConfig } from "../config/index.js";
import { buildSwapTransaction } from "./swap.js";
import type { JupiterClient } from "./client.js";
import type { QuoteResponse } from "./types.js";

/** Base Solana fee per signature (lamports) - constant network-level fee. */
export const BASE_SIGNATURE_FEE_LAMPORTS = 5_000;

export interface FeeEstimate {
  networkFeeLamports: number;
  priorityFeeLamports: number;
}

/**
 * Builds (but never signs or sends) a real swap transaction to read back
 * Jupiter's actual dynamic priority-fee estimate for this route/size, so
 * paper trading reflects real fee costs instead of a made-up flat number.
 */
export async function estimateSwapFees(
  client: JupiterClient,
  config: BotConfig,
  quote: QuoteResponse,
  userPublicKey: string,
): Promise<FeeEstimate> {
  try {
    const swap = await buildSwapTransaction(
      client,
      config,
      quote,
      userPublicKey,
    );
    return {
      networkFeeLamports: BASE_SIGNATURE_FEE_LAMPORTS,
      priorityFeeLamports:
        swap.prioritizationFeeLamports ?? config.execution.priorityMaxLamports,
    };
  } catch {
    // Fee estimation is best-effort; fall back to conservative constants
    // rather than blocking a paper trade or a price sample.
    return {
      networkFeeLamports: BASE_SIGNATURE_FEE_LAMPORTS,
      priorityFeeLamports: config.execution.priorityMaxLamports,
    };
  }
}
