export interface RoutePlanStep {
  swapInfo: {
    ammKey: string;
    label?: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
  };
  percent: number;
}

/** Trimmed shape of Jupiter's /swap/v1/quote response - only fields we use. */
export interface QuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: "ExactIn" | "ExactOut";
  slippageBps: number;
  priceImpactPct: string;
  routePlan: RoutePlanStep[];
  contextSlot?: number;
  timeTaken?: number;
}

export interface SwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
}

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  /** Raw base-unit amount as a string/bigint-safe number. */
  amount: string | number | bigint;
  slippageBps: number;
}
