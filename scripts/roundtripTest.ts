/**
 * $1 live round-trip test: buy ~$1 of the target token, wait, sell it all
 * back to SOL, then report exactly what the round trip cost in fees,
 * slippage and price impact. Requires live trading to be fully armed -
 * this spends real money from the dedicated hot wallet.
 *
 * Usage: npm run roundtrip [usdAmount] [waitSeconds]
 */
import { PublicKey } from "@solana/web3.js";
import { assertLiveTradingSafe, getConfig, isLiveTradingArmed } from "../src/config/index.js";
import { JupiterClient } from "../src/jupiter/client.js";
import { createLogger } from "../src/logger/index.js";
import { SolPriceTracker } from "../src/market/solPrice.js";
import { getConnection } from "../src/solana/connection.js";
import { LiveTrader } from "../src/trading/liveTrader.js";
import { getSolBalanceSol } from "../src/wallet/balances.js";
import { loadWalletKeypair } from "../src/wallet/keypair.js";

const usdAmount = Number(process.argv[2] ?? "1");
const waitSeconds = Number(process.argv[3] ?? "30");

async function main(): Promise<void> {
  const config = getConfig();
  const logger = createLogger(config.logging.level);
  assertLiveTradingSafe(config);

  if (!isLiveTradingArmed(config)) {
    console.error(
      "Refusing to run: this test spends real money and requires\n" +
        "TRADING_MODE=live AND ENABLE_LIVE_TRADING=true in .env.",
    );
    process.exit(1);
  }
  if (usdAmount > config.trading.maxTradeUsd) {
    console.error(
      `Requested $${usdAmount} exceeds MAX_TRADE_USD=$${config.trading.maxTradeUsd}. Aborting.`,
    );
    process.exit(1);
  }

  const connection = getConnection(config);
  const keypair = loadWalletKeypair(config);
  const tokenMint = new PublicKey(config.token.mint);
  const client = new JupiterClient(config);
  const solPrice = new SolPriceTracker(client, config);
  const trader = new LiveTrader(connection, client, config, solPrice, tokenMint, keypair, logger);

  const solBalanceBefore = await getSolBalanceSol(connection, keypair.publicKey);
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`SOL balance: ${solBalanceBefore.toFixed(6)}`);
  console.log(`Buying ~$${usdAmount} of ${config.token.symbol}...`);

  const buyTrade = await trader.buy({ usdAmount, reason: "MANUAL" });
  console.log(
    `Bought ${buyTrade.actualOutput?.toFixed(6)} ${config.token.symbol} ` +
      `(expected ${buyTrade.expectedOutput?.toFixed(6)}) for ${buyTrade.solAmount.toFixed(6)} SOL, tx ${buyTrade.txSignature}`,
  );

  console.log(`Waiting ${waitSeconds}s before selling back...`);
  await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1_000));

  const sellTrade = await trader.sell({ tokenAmount: buyTrade.actualOutput ?? buyTrade.tokenAmount, reason: "MANUAL" });
  console.log(
    `Sold ${sellTrade.tokenAmount.toFixed(6)} ${config.token.symbol} ` +
      `for ${sellTrade.actualOutput?.toFixed(6)} SOL (expected ${sellTrade.expectedOutput?.toFixed(6)}), tx ${sellTrade.txSignature}`,
  );

  report(buyTrade, sellTrade, config.token.symbol);
}

interface FeeSummary {
  usdEstimate: number;
  networkFeeLamports?: number;
  priorityFeeLamports?: number;
  slippageBps?: number;
  priceImpactPct?: number;
  expectedOutput?: number;
  actualOutput?: number;
}

function report(buy: FeeSummary, sell: FeeSummary, symbol: string): void {
  const startingValue = buy.usdEstimate;
  const endingValue = sell.usdEstimate;
  const totalCostUsd = startingValue - endingValue;
  const totalCostPercent = (totalCostUsd / startingValue) * 100;

  const totalNetworkFeeLamports =
    (buy.networkFeeLamports ?? 0) + (sell.networkFeeLamports ?? 0);
  const totalPriorityFeeLamports =
    (buy.priorityFeeLamports ?? 0) + (sell.priorityFeeLamports ?? 0);

  console.log("\n===== ROUND-TRIP REPORT =====");
  console.log(`Starting value:        $${startingValue.toFixed(4)}`);
  console.log(`Ending value:          $${endingValue.toFixed(4)}`);
  console.log(
    `Buy expected/actual:   ${buy.expectedOutput?.toFixed(6)} / ${buy.actualOutput?.toFixed(6)} ${symbol}`,
  );
  console.log(
    `Sell expected/actual:  ${sell.expectedOutput?.toFixed(6)} / ${sell.actualOutput?.toFixed(6)} SOL`,
  );
  console.log(`Network fees:          ${totalNetworkFeeLamports} lamports`);
  console.log(`Priority fees:         ${totalPriorityFeeLamports} lamports`);
  console.log(
    `Slippage (buy/sell):   ${buy.slippageBps ?? "-"}bps / ${sell.slippageBps ?? "-"}bps`,
  );
  console.log(
    `Price impact (buy/sell): ${((buy.priceImpactPct ?? 0) * 100).toFixed(3)}% / ${((sell.priceImpactPct ?? 0) * 100).toFixed(3)}%`,
  );
  console.log(`Total round-trip cost:   $${totalCostUsd.toFixed(4)}`);
  console.log(`Total round-trip cost %: ${totalCostPercent.toFixed(2)}%`);
  console.log("==============================\n");
}

main().catch((err) => {
  console.error("Round-trip test failed:", err);
  process.exit(1);
});
