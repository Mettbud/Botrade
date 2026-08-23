import { PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildConfig } from "../src/config/schema.js";
import type { JupiterClient } from "../src/jupiter/client.js";
import type { QuoteResponse } from "../src/jupiter/types.js";
import { Logger } from "../src/logger/index.js";
import { PriceFeed } from "../src/market/priceFeed.js";
import type { SolPriceTracker } from "../src/market/solPrice.js";

const TOKEN_MINT = "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg";

function config() {
  return buildConfig({
    TARGET_TOKEN_MINT: TOKEN_MINT,
    PRICE_POLL_INTERVAL_MS: "100",
  } as NodeJS.ProcessEnv);
}

function quote(inputMint: string, outputMint: string, outAmount: string): QuoteResponse {
  return {
    inputMint,
    inAmount: "1",
    outputMint,
    outAmount,
    otherAmountThreshold: outAmount,
    swapMode: "ExactIn",
    slippageBps: 150,
    priceImpactPct: "0",
    routePlan: [],
  };
}

function makeFeed(
  get: ReturnType<typeof vi.fn>,
  hasOpenPosition: () => boolean,
): PriceFeed {
  const cfg = config();
  const client = { get } as unknown as JupiterClient;
  const solPrice = {
    getPrice: vi.fn().mockResolvedValue(100),
  } as unknown as SolPriceTracker;
  return new PriceFeed(
    client,
    cfg,
    solPrice,
    {} as never,
    new PublicKey(TOKEN_MINT),
    new Logger("error"),
    {
      hasOpenPosition,
      getTokenDecimals: async () => 6,
    },
  );
}

describe("PriceFeed session and position integration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads position state at fetch time, so the first tick after a buy uses a real sell quote", async () => {
    vi.useFakeTimers();
    let positionOpen = false;
    const cfg = config();
    const get = vi.fn(async (_path: string, query: Record<string, string>) =>
      query.inputMint === cfg.token.solMint
        ? quote(cfg.token.solMint, TOKEN_MINT, "1000000")
        : quote(TOKEN_MINT, cfg.token.solMint, "9000000"),
    );
    const feed = makeFeed(get, () => positionOpen);
    feed.on("error", () => undefined);
    feed.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(feed.history.latest()?.sellIsEstimated).toBe(false);
    expect(get).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(100);
    expect(feed.history.latest()?.sellIsEstimated).toBe(true);
    expect(get).toHaveBeenCalledTimes(3);

    positionOpen = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(feed.history.latest()?.sellIsEstimated).toBe(false);
    expect(get).toHaveBeenCalledTimes(5);
    feed.stop();
  });

  it("coalesces repeated on-chain immediate triggers", async () => {
    vi.useFakeTimers();
    const cfg = config();
    const get = vi.fn(async (_path: string, query: Record<string, string>) =>
      query.inputMint === cfg.token.solMint
        ? quote(cfg.token.solMint, TOKEN_MINT, "1000000")
        : quote(TOKEN_MINT, cfg.token.solMint, "9000000"),
    );
    const feed = makeFeed(get, () => false);
    feed.on("error", () => undefined);
    feed.start();

    expect(feed.triggerImmediateTick()).toBe(false); // startup tick already queued
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.triggerImmediateTick()).toBe(true);
    expect(feed.triggerImmediateTick()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(feed.history.latest()).toBeDefined();
    feed.stop();
  });

  it("discards a sample whose request began before resetSession", async () => {
    let releaseBuy!: (value: QuoteResponse) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pendingBuy = new Promise<QuoteResponse>((resolve) => {
      releaseBuy = resolve;
    });
    const cfg = config();
    const get = vi
      .fn()
      .mockImplementationOnce(() => {
        markStarted();
        return pendingBuy;
      })
      .mockResolvedValueOnce(quote(TOKEN_MINT, cfg.token.solMint, "9000000"));
    const feed = makeFeed(get, () => false);
    feed.on("error", () => undefined);
    feed.start();

    await started;
    feed.resetSession();
    releaseBuy(quote(cfg.token.solMint, TOKEN_MINT, "1000000"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(feed.history.latest()).toBeUndefined();
    feed.stop();
  });
});
