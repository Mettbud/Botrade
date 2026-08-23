export interface RaydiumRouteStep {
  poolId: string;
  inputMint: string;
  outputMint: string;
  feeMint: string;
  feeRate: number;
  feeAmount: string;
}

export interface RaydiumSwapQuote {
  id: string;
  success: true;
  version: string;
  data: {
    swapType: "BaseIn";
    inputMint: string;
    inputAmount: string;
    actualInputAmount?: string;
    outputMint: string;
    outputAmount: string;
    otherAmountThreshold: string;
    slippageBps: number;
    priceImpactPct: number;
    routePlan: RaydiumRouteStep[];
  };
}

export interface RaydiumBuiltTransaction {
  transaction: string;
}

export class RaydiumTradeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 8_000,
  ) {}

  async computeDirectBuy(params: {
    inputMint: string;
    outputMint: string;
    amount: number;
    slippageBps: number;
  }): Promise<RaydiumSwapQuote> {
    const query = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: Math.trunc(params.amount).toString(),
      slippageBps: Math.trunc(params.slippageBps).toString(),
      txVersion: "V0",
    });
    const response = await this.requestJson(
      `/compute/swap-base-in?${query.toString()}`,
      { method: "GET" },
    );
    if (!isRaydiumSwapQuote(response)) {
      throw new Error("Raydium compute returned an invalid swap quote");
    }
    return response;
  }

  async buildDirectBuyTransactions(params: {
    quote: RaydiumSwapQuote;
    wallet: string;
    priorityFeeMicroLamports: number;
  }): Promise<RaydiumBuiltTransaction[]> {
    const response = await this.requestJson("/transaction/swap-base-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        computeUnitPriceMicroLamports: Math.trunc(
          params.priorityFeeMicroLamports,
        ).toString(),
        swapResponse: params.quote,
        txVersion: "V0",
        wallet: params.wallet,
        wrapSol: true,
        unwrapSol: false,
      }),
    });
    if (!isBuiltTransactionResponse(response)) {
      throw new Error("Raydium transaction builder returned invalid data");
    }
    return response.data;
  }

  private async requestJson(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        signal: controller.signal,
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw new Error(
          `Raydium HTTP ${response.status}: ${JSON.stringify(body)}`,
        );
      }
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function validateDirectCrashQuote(params: {
  quote: RaydiumSwapQuote;
  requiredPoolId: string;
  expectedInputMint: string;
  expectedOutputMint: string;
  expectedInputAmountRaw: number;
  inputDecimals: number;
  outputDecimals: number;
  maxPriceInInputToken: number;
  maxPriceImpactBps: number;
}): { inputAmountUi: number; outputAmountUi: number; worstPrice: number } {
  const { quote } = params;
  if (
    quote.data.inputMint !== params.expectedInputMint ||
    quote.data.outputMint !== params.expectedOutputMint ||
    quote.data.inputAmount !== Math.trunc(params.expectedInputAmountRaw).toString()
  ) {
    throw new Error("Raydium direct quote does not match the requested swap");
  }
  if (
    quote.data.routePlan.length !== 1 ||
    quote.data.routePlan[0]?.poolId !== params.requiredPoolId ||
    quote.data.routePlan[0]?.inputMint !== params.expectedInputMint ||
    quote.data.routePlan[0]?.outputMint !== params.expectedOutputMint
  ) {
    throw new Error(
      `Raydium direct quote did not use only required pool ${params.requiredPoolId}`,
    );
  }
  const inputAmountUi =
    Number(quote.data.actualInputAmount ?? quote.data.inputAmount) /
    10 ** params.inputDecimals;
  const outputAmountUi =
    Number(quote.data.outputAmount) / 10 ** params.outputDecimals;
  const minimumOutputUi =
    Number(quote.data.otherAmountThreshold) / 10 ** params.outputDecimals;
  if (
    !Number.isFinite(inputAmountUi) ||
    !Number.isFinite(outputAmountUi) ||
    !Number.isFinite(minimumOutputUi) ||
    inputAmountUi <= 0 ||
    outputAmountUi <= 0 ||
    minimumOutputUi <= 0
  ) {
    throw new Error("Raydium direct quote contains invalid token amounts");
  }
  const worstPrice = inputAmountUi / minimumOutputUi;
  if (worstPrice > params.maxPriceInInputToken) {
    throw new Error(
      `Raydium crash price disappeared: worst executable price ${worstPrice} exceeds limit ${params.maxPriceInInputToken}`,
    );
  }
  const priceImpactBps = Number(quote.data.priceImpactPct) * 100;
  if (
    !Number.isFinite(priceImpactBps) ||
    priceImpactBps > params.maxPriceImpactBps
  ) {
    throw new Error(
      `Raydium direct price impact ${priceImpactBps.toFixed(0)} bps exceeds ${params.maxPriceImpactBps} bps`,
    );
  }
  return { inputAmountUi, outputAmountUi, worstPrice };
}

function isRaydiumSwapQuote(value: unknown): value is RaydiumSwapQuote {
  if (!value || typeof value !== "object") return false;
  const root = value as Record<string, unknown>;
  if (root.success !== true || typeof root.id !== "string") return false;
  const data = root.data as Record<string, unknown> | undefined;
  return Boolean(
    data &&
      data.swapType === "BaseIn" &&
      typeof data.inputAmount === "string" &&
      typeof data.outputAmount === "string" &&
      typeof data.otherAmountThreshold === "string" &&
      typeof data.slippageBps === "number" &&
      typeof data.priceImpactPct === "number" &&
      Array.isArray(data.routePlan),
  );
}

function isBuiltTransactionResponse(
  value: unknown,
): value is { success: true; data: RaydiumBuiltTransaction[] } {
  if (!value || typeof value !== "object") return false;
  const root = value as Record<string, unknown>;
  return (
    root.success === true &&
    Array.isArray(root.data) &&
    root.data.length > 0 &&
    root.data.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).transaction === "string",
    )
  );
}
