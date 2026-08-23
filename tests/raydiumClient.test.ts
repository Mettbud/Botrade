import { describe, expect, it } from "vitest";
import {
  validateDirectCrashQuote,
  type RaydiumSwapQuote,
} from "../src/raydium/client.js";

const POOL = "G8kgi7aUpeX8EVR8VMkrth9SKEv5BietWC33UjAiiMGh";

function quote(overrides: Partial<RaydiumSwapQuote["data"]> = {}): RaydiumSwapQuote {
  return {
    id: "quote-id",
    success: true,
    version: "V0",
    data: {
      swapType: "BaseIn",
      inputMint: "SOL",
      inputAmount: "1000000000",
      outputMint: "TOKEN",
      outputAmount: "100000000",
      otherAmountThreshold: "98000000",
      slippageBps: 150,
      priceImpactPct: 0.25,
      routePlan: [{
        poolId: POOL,
        inputMint: "SOL",
        outputMint: "TOKEN",
        feeMint: "SOL",
        feeRate: 2500,
        feeAmount: "2500000",
      }],
      ...overrides,
    },
  };
}

describe("validateDirectCrashQuote", () => {
  it("accepts only the configured direct pool below the hard maximum price", () => {
    expect(validateDirectCrashQuote({
      quote: quote(),
      requiredPoolId: POOL,
      expectedInputMint: "SOL",
      expectedOutputMint: "TOKEN",
      expectedInputAmountRaw: 1_000_000_000,
      inputDecimals: 9,
      outputDecimals: 6,
      maxPriceInInputToken: 0.011,
      maxPriceImpactBps: 300,
    })).toMatchObject({ inputAmountUi: 1, outputAmountUi: 100 });
  });

  it("rejects a route that uses another pool or an intermediary", () => {
    expect(() => validateDirectCrashQuote({
      quote: quote({ routePlan: [
        { ...quote().data.routePlan[0]!, poolId: "other" },
      ] }),
      requiredPoolId: POOL,
      expectedInputMint: "SOL",
      expectedOutputMint: "TOKEN",
      expectedInputAmountRaw: 1_000_000_000,
      inputDecimals: 9,
      outputDecimals: 6,
      maxPriceInInputToken: 0.011,
      maxPriceImpactBps: 300,
    })).toThrow(/required pool/);
  });

  it("rejects the trade when the crash price disappeared before execution", () => {
    expect(() => validateDirectCrashQuote({
      quote: quote(),
      requiredPoolId: POOL,
      expectedInputMint: "SOL",
      expectedOutputMint: "TOKEN",
      expectedInputAmountRaw: 1_000_000_000,
      inputDecimals: 9,
      outputDecimals: 6,
      maxPriceInInputToken: 0.009,
      maxPriceImpactBps: 300,
    })).toThrow(/price disappeared/);
  });

  it("rejects excessive price impact", () => {
    expect(() => validateDirectCrashQuote({
      quote: quote({ priceImpactPct: 4 }),
      requiredPoolId: POOL,
      expectedInputMint: "SOL",
      expectedOutputMint: "TOKEN",
      expectedInputAmountRaw: 1_000_000_000,
      inputDecimals: 9,
      outputDecimals: 6,
      maxPriceInInputToken: 0.011,
      maxPriceImpactBps: 300,
    })).toThrow(/price impact/);
  });

  it("rejects a quote for another mint or input amount", () => {
    expect(() => validateDirectCrashQuote({
      quote: quote({ inputAmount: "2000000000" }),
      requiredPoolId: POOL,
      expectedInputMint: "SOL",
      expectedOutputMint: "TOKEN",
      expectedInputAmountRaw: 1_000_000_000,
      inputDecimals: 9,
      outputDecimals: 6,
      maxPriceInInputToken: 0.011,
      maxPriceImpactBps: 300,
    })).toThrow(/requested swap/);
  });
});
