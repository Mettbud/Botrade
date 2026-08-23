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
import { estimateSellPriceUsd } from "./sellEstimate.js";
import type { SolPriceTracker } from "./solPrice.js";
import type { PriceSample } from "./types.js";

const SOL_DECIMALS = 9;

export interface PriceFeedEvents {
  sample: (sample: PriceSample) => void;
  movement: (events: MovementEvent[]) => void;
  error: (err: unknown) => void;
}

export interface PriceFeedOptions {
  /** Read at fetch time so a trade completed between ticks is never one tick stale. */
  hasOpenPosition?: () => boolean;
  /** Test seam; production reads the mint once from Solana and caches it. */
  getTokenDecimals?: () => Promise<number>;
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
  private ticking = false;
  private immediateTickQueued = false;
  private consecutiveErrors = 0;
  private sessionGeneration = 0;
  private tokenDecimals: number | undefined;
  private lastRealSpread: number | undefined;
  private lastRealSellImpactBps = 0;
  private readonly hasOpenPosition: () => boolean;
  private readonly getTokenDecimals: () => Promise<number>;

  constructor(
    private readonly client: JupiterClient,
    private readonly config: BotConfig,
    private readonly solPrice: SolPriceTracker,
    private readonly connection: Connection,
    private readonly tokenMint: PublicKey,
    private readonly logger: Logger,
    options: PriceFeedOptions = {},
  ) {
    super();
    this.hasOpenPosition = options.hasOpenPosition ?? (() => false);
    this.getTokenDecimals =
      options.getTokenDecimals ??
      (() => getMintDecimals(this.connection, this.tokenMint));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
  }

  /**
   * Skips the wait and ticks right now - used when an on-chain pool watch
   * (see onchain/poolWatcher.ts) flags a fast price jump. Never bypasses a
   * tick already in flight (no overlapping fetches), and cancels the
   * currently-scheduled wait so this doesn't cause an extra tick on top of
   * the immediate one.
   *
   * Also never overrides an active backoff: if recent ticks have been
   * failing (e.g. a 429), the whole point of backoff is to stop hammering
   * the API - an on-chain jump forcing an extra request right through that
   * would make the rate limit worse, not better. The regular (backed-off)
   * schedule still picks it up as soon as it's healthy again.
   * Returns whether an immediate tick was actually queued.
   */
  triggerImmediateTick(): boolean {
    if (!this.running || this.ticking || this.immediateTickQueued) return false;
    if (this.consecutiveErrors > 0) return false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.scheduleNext(0);
    return true;
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.immediateTickQueued = false;
  }

  /**
   * Clears every in-memory market signal used by PAPER automation. A quote
   * already in flight is allowed to finish, but its sample/error is discarded
   * through the generation check in tick().
   */
  resetSession(): void {
    this.sessionGeneration += 1;
    this.history.clear();
    this.consecutiveErrors = 0;
    this.lastRealSpread = undefined;
    this.lastRealSellImpactBps = 0;
  }

  /**
   * Rare crash-buy preflight. While flat, normal ticks may estimate the sell
   * side from the last spread; an actual crash signal must recheck a fresh
   * executable round trip before committing money.
   */
  fetchFreshRoundTripSample(): Promise<PriceSample> {
    return this.fetchSample(true);
  }

  private scheduleNext(delayMs: number): void {
    this.immediateTickQueued = delayMs <= 0;
    this.timer = setTimeout(() => void this.runTick(), delayMs);
  }

  // Self-scheduling (setTimeout, not setInterval) so the next poll is only
  // ever queued once the previous one finished - that alone prevents ticks
  // piling up on a slow response, and it lets a failed tick wait longer
  // than a successful one (backoff) instead of firing on a fixed clock.
  private async runTick(): Promise<void> {
    if (!this.running) return;
    this.timer = undefined;
    this.immediateTickQueued = false;
    this.ticking = true;
    try {
      await this.tick();
    } finally {
      this.ticking = false;
    }
    if (!this.running) return;
    this.scheduleNext(
      nextPollDelayMs(this.config.price.pollIntervalMs, this.consecutiveErrors),
    );
  }

  private async tick(): Promise<void> {
    const sessionGeneration = this.sessionGeneration;
    try {
      const sample = await this.fetchSample();
      if (sessionGeneration !== this.sessionGeneration) return;
      this.consecutiveErrors = 0;
      if (!sample.sellIsEstimated) {
        this.lastRealSpread = sample.spread;
        this.lastRealSellImpactBps = sample.priceImpactSellBps;
      }
      this.history.push(sample);
      this.emit("sample", sample);

      const events = detectMovements(this.history, sample, this.config);
      if (events.length > 0) this.emit("movement", events);
    } catch (err) {
      if (sessionGeneration !== this.sessionGeneration) return;
      this.consecutiveErrors += 1;
      this.logger.warn("price feed tick failed", {
        err: String(err),
        consecutiveErrors: this.consecutiveErrors,
      });
      this.emit("error", err);
    }
  }

  private async fetchSample(forceRealSellQuote = false): Promise<PriceSample> {
    if (this.tokenDecimals === undefined) {
      this.tokenDecimals = await this.getTokenDecimals();
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
    const buyPriceUsd =
      (referenceSolAmount * solUsdPrice) / referenceTokenAmountUi;

    // Only fetch a real sell-side quote while holding a position (or on
    // the very first tick, to seed a real spread) - while flat there's
    // nothing to actually sell, so this halves API load in the common
    // case at the cost of an estimated (not fresh-quoted) sell price.
    const needRealSellQuote =
      forceRealSellQuote ||
      this.hasOpenPosition() ||
      this.lastRealSpread === undefined;

    if (!needRealSellQuote) {
      return {
        timestampMs: Date.now(),
        buyPriceUsd,
        sellPriceUsd: estimateSellPriceUsd(buyPriceUsd, this.lastRealSpread!),
        sellIsEstimated: true,
        spread: this.lastRealSpread!,
        priceImpactBuyBps: priceImpactBps(buyQuote),
        priceImpactSellBps: this.lastRealSellImpactBps,
        referenceSolAmount,
        referenceTokenAmountUi,
        solUsdPrice,
      };
    }

    const sellQuote = await getQuote(this.client, {
      inputMint: this.config.token.mint,
      outputMint: this.config.token.solMint,
      amount: tokenOutRaw,
      slippageBps: this.config.risk.maxSlippageBps,
    });

    const solBackUi = Number(sellQuote.outAmount) / 10 ** SOL_DECIMALS;
    const sellPriceUsd = (solBackUi * solUsdPrice) / referenceTokenAmountUi;
    const spread = (buyPriceUsd - sellPriceUsd) / buyPriceUsd;

    const sellImpactBps = priceImpactBps(sellQuote);

    return {
      timestampMs: Date.now(),
      buyPriceUsd,
      sellPriceUsd,
      sellIsEstimated: false,
      spread,
      priceImpactBuyBps: priceImpactBps(buyQuote),
      priceImpactSellBps: sellImpactBps,
      referenceSolAmount,
      referenceTokenAmountUi,
      solUsdPrice,
    };
  }
}
