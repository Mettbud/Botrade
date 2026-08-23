import type { Connection, PublicKey } from "@solana/web3.js";
import type { BotConfig } from "../config/index.js";
import { estimateSwapFees } from "../jupiter/feeEstimate.js";
import type { JupiterClient } from "../jupiter/client.js";
import { getQuote } from "../jupiter/quote.js";
import type { SolPriceTracker } from "../market/solPrice.js";
import { getMintDecimals } from "../wallet/balances.js";
import { checkMaxTradeSize } from "./riskGuards.js";
import type { BuyParams, SellParams, TradeExecutor } from "./tradeExecutor.js";
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
  ) {}

  async buy({ usdAmount, reason }: BuyParams): Promise<Trade> {
    const sizeCheck = checkMaxTradeSize(usdAmount, this.config.trading.maxTradeUsd);
    if (!sizeCheck.allowed) throw new Error(sizeCheck.reason);
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
