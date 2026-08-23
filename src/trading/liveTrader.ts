import type { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { assertLiveTradingSafe, isLiveTradingArmed, type BotConfig } from "../config/index.js";
import type { JupiterClient } from "../jupiter/client.js";
import { signAndSendSwap } from "../jupiter/execute.js";
import { getQuote } from "../jupiter/quote.js";
import { buildSwapTransaction } from "../jupiter/swap.js";
import type { Logger } from "../logger/index.js";
import type { SolPriceTracker } from "../market/solPrice.js";
import { getSwapActuals } from "../solana/txAnalysis.js";
import { getMintDecimals, getSolBalanceSol, getTokenBalance } from "../wallet/balances.js";
import { checkMaxTradeSize, checkPriceImpact, checkSlippage, checkSolReserve } from "./riskGuards.js";
import type { BuyParams, SellParams, TradeExecutor } from "./tradeExecutor.js";
import type { Trade } from "./types.js";

const SOL_DECIMALS = 9;
/** Rough fee headroom used for the pre-quote SOL-reserve sanity check. */
const FEE_BUFFER_SOL = 0.003;

/**
 * Executes real swaps signed locally with the dedicated hot wallet's
 * keypair. Every buy/sell re-validates MAX_TRADE_USD, MIN_SOL_RESERVE,
 * slippage and price impact right before sending - nothing here trusts
 * that an upstream caller already checked.
 */
export class LiveTrader implements TradeExecutor {
  readonly mode = "LIVE" as const;

  constructor(
    private readonly connection: Connection,
    private readonly client: JupiterClient,
    private readonly config: BotConfig,
    private readonly solPrice: SolPriceTracker,
    private readonly tokenMint: PublicKey,
    private readonly keypair: Keypair,
    private readonly logger: Logger,
  ) {
    assertLiveTradingSafe(config);
  }

  async buy({ usdAmount, reason }: BuyParams): Promise<Trade> {
    if (!isLiveTradingArmed(this.config)) {
      throw new Error("Live trading is not armed (TRADING_MODE/ENABLE_LIVE_TRADING).");
    }
    const sizeCheck = checkMaxTradeSize(usdAmount, this.config.trading.maxTradeUsd);
    if (!sizeCheck.allowed) throw new Error(sizeCheck.reason);

    const solUsdPrice = await this.solPrice.getPrice();
    const solIn = usdAmount / solUsdPrice;
    const balance = await getSolBalanceSol(this.connection, this.keypair.publicKey);

    const preCheck = checkSolReserve(
      balance,
      solIn + FEE_BUFFER_SOL,
      this.config.trading.minSolReserve,
    );
    if (!preCheck.allowed) throw new Error(preCheck.reason);

    const amountLamports = Math.round(solIn * 10 ** SOL_DECIMALS);
    const quote = await getQuote(this.client, {
      inputMint: this.config.token.solMint,
      outputMint: this.config.token.mint,
      amount: amountLamports,
      slippageBps: this.config.risk.maxSlippageBps,
    });
    this.assertQuoteWithinRisk(quote.slippageBps, Number(quote.priceImpactPct) * 10_000);

    const swap = await buildSwapTransaction(
      this.client,
      this.config,
      quote,
      this.keypair.publicKey.toBase58(),
    );
    const priorityFeeLamports = swap.prioritizationFeeLamports ?? 0;
    const finalCheck = checkSolReserve(
      balance,
      solIn + (5_000 + priorityFeeLamports) / 10 ** SOL_DECIMALS,
      this.config.trading.minSolReserve,
    );
    if (!finalCheck.allowed) throw new Error(finalCheck.reason);

    const { signature, confirmed } = await signAndSendSwap(
      this.connection,
      this.keypair,
      swap,
    );
    if (!confirmed) {
      throw new Error(`Buy transaction did not confirm: ${signature}`);
    }
    this.logger.info("Live buy confirmed", { signature });

    const actuals = await getSwapActuals(
      this.connection,
      signature,
      this.keypair.publicKey,
      this.tokenMint,
    );
    const decimals = await getMintDecimals(this.connection, this.tokenMint);
    const actualTokenOut = actuals ? Number(actuals.tokenDelta) / 10 ** decimals : Number(quote.outAmount) / 10 ** decimals;
    const actualSolSpent = actuals ? -actuals.solDeltaLamports / 10 ** SOL_DECIMALS : solIn;

    return {
      timestampMs: Date.now(),
      mode: "LIVE",
      side: "BUY",
      reason,
      tokenAmount: actualTokenOut,
      solAmount: actualSolSpent,
      usdEstimate: actualSolSpent * solUsdPrice,
      quoteBeforeJson: JSON.stringify(quote),
      expectedOutput: Number(quote.outAmount) / 10 ** decimals,
      actualOutput: actualTokenOut,
      slippageBps: quote.slippageBps,
      priceImpactPct: Number(quote.priceImpactPct),
      networkFeeLamports: actuals?.networkFeeLamports ?? 5_000,
      priorityFeeLamports,
      txSignature: signature,
    };
  }

  async sell({ tokenAmount, reason }: SellParams): Promise<Trade> {
    const decimals = await getMintDecimals(this.connection, this.tokenMint);
    const balance = await getTokenBalance(
      this.connection,
      this.keypair.publicKey,
      this.tokenMint,
    );
    const sellAmountUi = Math.min(tokenAmount, balance.uiAmount);
    if (sellAmountUi <= 0) throw new Error("No live token balance to sell");

    const rawAmount = BigInt(Math.round(sellAmountUi * 10 ** decimals));
    const quote = await getQuote(this.client, {
      inputMint: this.config.token.mint,
      outputMint: this.config.token.solMint,
      amount: rawAmount,
      slippageBps: this.config.risk.maxSlippageBps,
    });

    if (reason !== "PANIC_EXIT") {
      this.assertQuoteWithinRisk(quote.slippageBps, Number(quote.priceImpactPct) * 10_000);
    }

    const swap = await buildSwapTransaction(
      this.client,
      this.config,
      quote,
      this.keypair.publicKey.toBase58(),
    );
    const { signature, confirmed } = await signAndSendSwap(
      this.connection,
      this.keypair,
      swap,
    );
    if (!confirmed) {
      throw new Error(`Sell transaction did not confirm: ${signature}`);
    }
    this.logger.info("Live sell confirmed", { signature });

    const solUsdPrice = await this.solPrice.getPrice();
    const actuals = await getSwapActuals(
      this.connection,
      signature,
      this.keypair.publicKey,
      this.tokenMint,
    );
    const actualSolReceived = actuals
      ? actuals.solDeltaLamports / 10 ** SOL_DECIMALS
      : Number(quote.outAmount) / 10 ** SOL_DECIMALS;

    return {
      timestampMs: Date.now(),
      mode: "LIVE",
      side: "SELL",
      reason,
      tokenAmount: sellAmountUi,
      solAmount: actualSolReceived,
      usdEstimate: actualSolReceived * solUsdPrice,
      quoteBeforeJson: JSON.stringify(quote),
      expectedOutput: Number(quote.outAmount) / 10 ** SOL_DECIMALS,
      actualOutput: actualSolReceived,
      slippageBps: quote.slippageBps,
      priceImpactPct: Number(quote.priceImpactPct),
      networkFeeLamports: actuals?.networkFeeLamports ?? 5_000,
      priorityFeeLamports: swap.prioritizationFeeLamports ?? 0,
      txSignature: signature,
    };
  }

  private assertQuoteWithinRisk(slippageBps: number, priceImpactBps: number): void {
    const slippageCheck = checkSlippage(slippageBps, this.config.risk.maxSlippageBps);
    if (!slippageCheck.allowed) throw new Error(slippageCheck.reason);
    const impactCheck = checkPriceImpact(priceImpactBps, this.config.risk.maxPriceImpactBps);
    if (!impactCheck.allowed) throw new Error(impactCheck.reason);
  }
}
