import type { Connection, PublicKey } from "@solana/web3.js";
import type { BotConfig } from "../config/index.js";
import { estimateSwapFees } from "../jupiter/feeEstimate.js";
import type { JupiterClient } from "../jupiter/client.js";
import { getQuote } from "../jupiter/quote.js";
import type { SolPriceTracker } from "../market/solPrice.js";
import {
  RaydiumTradeClient,
  validateDirectCrashQuote,
} from "../raydium/client.js";
import { getMintDecimals } from "../wallet/balances.js";
import type {
  BuyParams,
  DirectCrashBuyParams,
  SellParams,
  TradeExecutor,
} from "./tradeExecutor.js";
import type { Trade } from "./types.js";

const SOL_DECIMALS = 9;

/**
 * Simulates trades using real Jupiter quotes (so real price impact, spread
 * and dynamic fee estimates all flow through), against a virtual USD/token
 * balance instead of the real wallet. No transaction is ever built to send.
 */
export class PaperTrader implements TradeExecutor {
  readonly mode = "PAPER" as const;

  constructor(
    private readonly client: JupiterClient,
    private readonly config: BotConfig,
    private readonly solPrice: SolPriceTracker,
    private readonly connection: Connection,
    private readonly tokenMint: PublicKey,
    private readonly walletPublicKey: PublicKey,
    public usdBalance: number,
    public tokenAmount: number,
    private readonly raydiumClient?: RaydiumTradeClient,
  ) {}

  // No MAX_TRADE_USD check here on purpose: that guard exists to cap real
  // money at risk, and paper trades never touch real money. Enforcing it
  // here would also cap what paper mode can ever teach you about sizing
  // relative to a larger balance. LiveTrader.buy() still enforces it
  // unconditionally - this asymmetry is intentional, not an oversight.
  async buy({ usdAmount, reason }: BuyParams): Promise<Trade> {
    if (usdAmount > this.usdBalance) {
      throw new Error(
        `Paper balance $${this.usdBalance.toFixed(2)} is less than requested $${usdAmount}`,
      );
    }

    const solUsdPrice = await this.solPrice.getPrice();
    const solIn = usdAmount / solUsdPrice;
    const amountLamports = Math.round(solIn * 10 ** SOL_DECIMALS);

    const quote = await getQuote(this.client, {
      inputMint: this.config.token.solMint,
      outputMint: this.config.token.mint,
      amount: amountLamports,
      slippageBps: this.config.risk.maxSlippageBps,
    });

    const tokenDecimals = await getMintDecimals(this.connection, this.tokenMint);
    const tokenOut = Number(quote.outAmount) / 10 ** tokenDecimals;

    const fees = await estimateSwapFees(
      this.client,
      this.config,
      quote,
      this.walletPublicKey.toBase58(),
    );
    const feeUsd =
      ((fees.networkFeeLamports + fees.priorityFeeLamports) /
        10 ** SOL_DECIMALS) *
      solUsdPrice;
    const totalUsdCost = usdAmount + feeUsd;

    if (totalUsdCost > this.usdBalance) {
      throw new Error(
        `Paper balance $${this.usdBalance.toFixed(2)} can't cover $${usdAmount} + $${feeUsd.toFixed(4)} fees`,
      );
    }

    this.usdBalance -= totalUsdCost;
    this.tokenAmount += tokenOut;

    return {
      timestampMs: Date.now(),
      mode: "PAPER",
      side: "BUY",
      reason,
      tokenAmount: tokenOut,
      solAmount: solIn,
      usdEstimate: totalUsdCost,
      quoteBeforeJson: JSON.stringify(quote),
      expectedOutput: tokenOut,
      actualOutput: tokenOut,
      slippageBps: quote.slippageBps,
      priceImpactPct: Number(quote.priceImpactPct),
      networkFeeLamports: fees.networkFeeLamports,
      priorityFeeLamports: fees.priorityFeeLamports,
    };
  }

  async buyCrashDirect({
    usdAmount,
    reason,
    solUsdPrice,
    maxPriceInSol,
    requiredPoolId,
  }: DirectCrashBuyParams): Promise<Trade> {
    if (!this.raydiumClient) {
      throw new Error("Raydium direct client is not configured");
    }
    if (usdAmount > this.usdBalance) {
      throw new Error(
        `Paper balance $${this.usdBalance.toFixed(2)} is less than requested $${usdAmount}`,
      );
    }
    if (!Number.isFinite(solUsdPrice) || solUsdPrice <= 0) {
      throw new Error("Direct crash-buy requires a cached positive SOL/USD price");
    }
    const solIn = usdAmount / solUsdPrice;
    const amountLamports = Math.round(solIn * 10 ** SOL_DECIMALS);
    const tokenDecimals = await getMintDecimals(this.connection, this.tokenMint);
    const quote = await this.raydiumClient.computeDirectBuy({
      inputMint: this.config.token.solMint,
      outputMint: this.config.token.mint,
      amount: amountLamports,
      slippageBps: this.config.risk.maxSlippageBps,
    });
    const validated = validateDirectCrashQuote({
      quote,
      requiredPoolId,
      expectedInputMint: this.config.token.solMint,
      expectedOutputMint: this.config.token.mint,
      expectedInputAmountRaw: amountLamports,
      inputDecimals: SOL_DECIMALS,
      outputDecimals: tokenDecimals,
      maxPriceInInputToken: maxPriceInSol,
      maxPriceImpactBps: this.config.risk.maxPriceImpactBps,
    });
    const networkFeeLamports = 5_000;
    const totalUsdCost =
      validated.inputAmountUi * solUsdPrice +
      (networkFeeLamports / 10 ** SOL_DECIMALS) * solUsdPrice;
    if (totalUsdCost > this.usdBalance) {
      throw new Error(
        `Paper balance $${this.usdBalance.toFixed(2)} can't cover direct crash-buy cost $${totalUsdCost.toFixed(4)}`,
      );
    }
    this.usdBalance -= totalUsdCost;
    this.tokenAmount += validated.outputAmountUi;

    return {
      timestampMs: Date.now(),
      mode: "PAPER",
      side: "BUY",
      reason,
      tokenAmount: validated.outputAmountUi,
      solAmount: validated.inputAmountUi,
      usdEstimate: totalUsdCost,
      quoteBeforeJson: JSON.stringify(quote),
      expectedOutput: validated.outputAmountUi,
      actualOutput: validated.outputAmountUi,
      slippageBps: quote.data.slippageBps,
      priceImpactPct: Number(quote.data.priceImpactPct),
      networkFeeLamports,
      priorityFeeLamports: 0,
    };
  }

  async sell({ tokenAmount, reason }: SellParams): Promise<Trade> {
    const sellAmount = Math.min(tokenAmount, this.tokenAmount);
    if (sellAmount <= 0) {
      throw new Error("No paper position to sell");
    }

    const tokenDecimals = await getMintDecimals(this.connection, this.tokenMint);
    const rawAmount = BigInt(Math.round(sellAmount * 10 ** tokenDecimals));

    const quote = await getQuote(this.client, {
      inputMint: this.config.token.mint,
      outputMint: this.config.token.solMint,
      amount: rawAmount,
      slippageBps: this.config.risk.maxSlippageBps,
    });

    const solOut = Number(quote.outAmount) / 10 ** SOL_DECIMALS;
    const solUsdPrice = await this.solPrice.getPrice();

    const fees = await estimateSwapFees(
      this.client,
      this.config,
      quote,
      this.walletPublicKey.toBase58(),
    );
    const feeSol =
      (fees.networkFeeLamports + fees.priorityFeeLamports) / 10 ** SOL_DECIMALS;
    const usdReceived = (solOut - feeSol) * solUsdPrice;

    this.usdBalance += usdReceived;
    this.tokenAmount -= sellAmount;

    return {
      timestampMs: Date.now(),
      mode: "PAPER",
      side: "SELL",
      reason,
      tokenAmount: sellAmount,
      solAmount: solOut,
      usdEstimate: usdReceived,
      quoteBeforeJson: JSON.stringify(quote),
      expectedOutput: solOut,
      actualOutput: solOut,
      slippageBps: quote.slippageBps,
      priceImpactPct: Number(quote.priceImpactPct),
      networkFeeLamports: fees.networkFeeLamports,
      priorityFeeLamports: fees.priorityFeeLamports,
    };
  }
}
