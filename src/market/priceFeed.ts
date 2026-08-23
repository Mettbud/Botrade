import { EventEmitter } from "node:events";
import type { Connection, PublicKey } from "@solana/web3.js";
import type { BotConfig } from "../config/index.js";
import type { JupiterClient } from "../jupiter/client.js";
import { getQuote, priceImpactBps } from "../jupiter/quote.js";
import type { Logger } from "../logger/index.js";
import { getMintDecimals } from "../wallet/balances.js";
import { nextPollDelayMs } from "./backoff.js";
import { PriceHistoryBuffer } from "./history.js";
import { detectMovements, type MovementEvent } from "./movementDetector.js";
import type { SolPriceTracker } from "./solPrice.js";
import type { PriceSample } from "./types.js";

const SOL_DECIMALS = 9;

export interface PriceFeedEvents {
  sample: (sample: PriceSample) => void;
  movement: (events: MovementEvent[]) => void;
  error: (err: unknown) => void;
}

/**
 * Polls Jupiter for a matched buy/sell reference quote on a fixed interval,
 * turning it into an executable price sample. Deliberately interval-based
 * (not a tight loop) so it never spams the API faster than configured.
 */
export class PriceFeed extends EventEmitter {
  readonly history = new PriceHistoryBuffer();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private consecutiveErrors = 0;
  private tokenDecimals: number | undefined;

  constructor(
    private readonly client: JupiterClient,
    private readonly config: BotConfig,
    private readonly solPrice: SolPriceTracker,
    private readonly connection: Connection,
    private readonly tokenMint: PublicKey,
    private readonly logger: Logger,
  ) {
    super();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => void this.runTick(), delayMs);
  }

  // Self-scheduling (setTimeout, not setInterval) so the next poll is only
  // ever queued once the previous one finished - that alone prevents ticks
  // piling up on a slow response, and it lets a failed tick wait longer
  // than a successful one (backoff) instead of firing on a fixed clock.
  private async runTick(): Promise<void> {
    if (!this.running) return;
    await this.tick();
    if (!this.running) return;
    this.scheduleNext(
      nextPollDelayMs(this.config.price.pollIntervalMs, this.consecutiveErrors),
    );
  }

  private async tick(): Promise<void> {
    try {
      const sample = await this.fetchSample();
      this.consecutiveErrors = 0;
      this.history.push(sample);
      this.emit("sample", sample);

      const events = detectMovements(this.history, sample, this.config);
      if (events.length > 0) this.emit("movement", events);
    } catch (err) {
      this.consecutiveErrors += 1;
      this.logger.warn("price feed tick failed", {
        err: String(err),
        consecutiveErrors: this.consecutiveErrors,
      });
      this.emit("error", err);
    }
  }

  private async fetchSample(): Promise<PriceSample> {
    if (this.tokenDecimals === undefined) {
      this.tokenDecimals = await getMintDecimals(
        this.connection,
        this.tokenMint,
      );
    }

    const solUsdPrice = await this.solPrice.getPrice();
    const referenceSolAmount = this.config.price.referenceSolAmount;
    const amountLamports = Math.round(referenceSolAmount * 10 ** SOL_DECIMALS);

    const buyQuote = await getQuote(this.client, {
      inputMint: this.config.token.solMint,
      outputMint: this.config.token.mint,
      amount: amountLamports,
      slippageBps: this.config.risk.maxSlippageBps,
    });

    const tokenOutRaw = BigInt(buyQuote.outAmount);
    const referenceTokenAmountUi =
      Number(tokenOutRaw) / 10 ** this.tokenDecimals;

    const sellQuote = await getQuote(this.client, {
      inputMint: this.config.token.mint,
      outputMint: this.config.token.solMint,
      amount: tokenOutRaw,
      slippageBps: this.config.risk.maxSlippageBps,
    });

    const solBackUi = Number(sellQuote.outAmount) / 10 ** SOL_DECIMALS;

    const buyPriceUsd =
      (referenceSolAmount * solUsdPrice) / referenceTokenAmountUi;
    const sellPriceUsd = (solBackUi * solUsdPrice) / referenceTokenAmountUi;
    const spread = (buyPriceUsd - sellPriceUsd) / buyPriceUsd;

    return {
      timestampMs: Date.now(),
      buyPriceUsd,
      sellPriceUsd,
      spread,
      priceImpactBuyBps: priceImpactBps(buyQuote),
      priceImpactSellBps: priceImpactBps(sellQuote),
      referenceSolAmount,
      referenceTokenAmountUi,
      solUsdPrice,
    };
  }
}
