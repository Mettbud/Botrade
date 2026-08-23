import { createInterface } from "node:readline";
import type { Connection, PublicKey } from "@solana/web3.js";
import type { BotConfig } from "../config/index.js";
import { getQuote } from "../jupiter/quote.js";
import type { JupiterClient } from "../jupiter/client.js";
import type { Logger } from "../logger/index.js";
import type { PriceFeed } from "../market/priceFeed.js";
import { PaperTrader } from "../trading/paperTrader.js";
import type { PositionManager } from "../trading/positionManager.js";
import type { TradeExecutor } from "../trading/tradeExecutor.js";
import { getMintDecimals } from "../wallet/balances.js";

export interface CommandDeps {
  positionManager: PositionManager;
  priceFeed: PriceFeed;
  client: JupiterClient;
  connection: Connection;
  tokenMint: PublicKey;
  config: BotConfig;
  logger: Logger;
  executor: TradeExecutor;
  onExit: () => void;
}

/** Wires up interactive stdin commands: buy/sell/panic/status/quit. */
export function startCommandLoop(deps: CommandDeps): void {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    void handleLine(line.trim(), deps).catch((err) => {
      deps.logger.error(`command failed: ${String((err as Error).message ?? err)}`);
    });
  });
}

async function handleLine(line: string, deps: CommandDeps): Promise<void> {
  const [cmd, arg] = line.split(/\s+/);
  const { positionManager, priceFeed, config, logger, executor } = deps;

  switch (cmd?.toLowerCase()) {
    case "buy": {
      const usdAmount = Number(arg ?? "1");
      const trade = await positionManager.manualBuy(usdAmount);
      logger.info(
        `BUY ${trade.tokenAmount.toFixed(4)} ${config.token.symbol} for ~$${trade.usdEstimate.toFixed(4)}`,
      );
      return;
    }
    case "sell": {
      const percent = Number(arg ?? "100");
      const impactBps = priceFeed.history.latest()?.priceImpactSellBps ?? 0;
      const trade = await positionManager.manualSell(percent, "MANUAL", impactBps);
      logger.info(
        `SELL ${trade.tokenAmount.toFixed(4)} ${config.token.symbol} for ~$${trade.usdEstimate.toFixed(4)}`,
      );
      return;
    }
    case "panic": {
      await runPanic(deps);
      return;
    }
    case "reset": {
      if (config.trading.mode === "live" || !(executor instanceof PaperTrader)) {
        console.log("reset: refused - not available in live mode (safety).");
        return;
      }
      positionManager.reset();
      executor.usdBalance = config.trading.paperBalanceUsd;
      executor.tokenAmount = 0;
      logger.info(
        `PAPER trade history and position reset - fresh balance $${config.trading.paperBalanceUsd.toFixed(2)}.`,
      );
      return;
    }
    case "status":
      return; // dashboard redraws on its own timer
    case "help":
      console.log(
        "commands: buy <usd>  sell <25|50|100>  panic  reset  status  quit",
      );
      return;
    case "quit":
    case "exit":
      deps.onExit();
      return;
    default:
      if (cmd) console.log(`unknown command: ${cmd} (try "help")`);
  }
}

async function runPanic(deps: CommandDeps): Promise<void> {
  const { positionManager, client, connection, tokenMint, config, logger } = deps;
  const costBasis = positionManager.getCostBasis();
  if (costBasis.tokenAmount <= 0) {
    logger.warn("panic: no position to exit");
    return;
  }

  const decimals = await getMintDecimals(connection, tokenMint);
  const quote = await getQuote(client, {
    inputMint: config.token.mint,
    outputMint: config.token.solMint,
    amount: Math.round(costBasis.tokenAmount * 10 ** decimals),
    slippageBps: config.risk.maxSlippageBps,
  }).catch(() => undefined);

  if (quote) {
    console.log("PANIC EXIT preview:");
    console.log(`  expected SOL out: ${(Number(quote.outAmount) / 1e9).toFixed(6)}`);
    console.log(`  price impact:     ${(Number(quote.priceImpactPct) * 100).toFixed(2)}%`);
    console.log(`  slippage bps:     ${quote.slippageBps}`);
  }

  const impactBps = deps.priceFeed.history.latest()?.priceImpactSellBps ?? 0;
  const trade = await positionManager.panicSell(impactBps);
  logger.info(
    `PANIC_EXIT sold ${trade.tokenAmount.toFixed(4)} ${config.token.symbol} for ~$${trade.usdEstimate.toFixed(4)}`,
  );
}
