import { beforeEach, describe, expect, it } from "vitest";
import { buildConfig } from "../src/config/schema.js";
import { openDatabase } from "../src/database/index.js";
import { TradesRepo } from "../src/database/tradesRepo.js";
import { createLogger } from "../src/logger/index.js";
import { PositionManager } from "../src/trading/positionManager.js";
import type { TradeExecutor, BuyParams, SellParams } from "../src/trading/tradeExecutor.js";
import type { Trade, TradeMode } from "../src/trading/types.js";

/** Executes trades instantly at whatever `price` is set to at call time. */
class FakeExecutor implements TradeExecutor {
  readonly mode: TradeMode;
  price = 1;

  constructor(mode: TradeMode = "PAPER") {
    this.mode = mode;
  }

  async buy({ usdAmount, reason }: BuyParams): Promise<Trade> {
    return {
      timestampMs: Date.now(),
      mode: this.mode,
      side: "BUY",
      reason,
      tokenAmount: usdAmount / this.price,
      solAmount: 0,
      usdEstimate: usdAmount,
    };
  }

  async sell({ tokenAmount, reason }: SellParams): Promise<Trade> {
    return {
      timestampMs: Date.now(),
      mode: this.mode,
      side: "SELL",
      reason,
      tokenAmount,
      solAmount: 0,
      usdEstimate: tokenAmount * this.price,
    };
  }
}

function setup(overrides: Record<string, string> = {}) {
  const config = buildConfig({
    TARGET_TOKEN_MINT: "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg",
    DB_PATH: ":memory:",
    STOP_CONFIRMATION_ENABLED: "false",
    STOP_LOSS_PERCENT: "90",
    TRAILING_STOP_PERCENT: "90",
    ...overrides,
  } as unknown as NodeJS.ProcessEnv);
  const db = openDatabase(config);
  const tradesRepo = new TradesRepo(db);
  const logger = createLogger("error");
  const executor = new FakeExecutor();
  const positionManager = new PositionManager(executor, tradesRepo, config, logger);
  return { config, tradesRepo, executor, positionManager };
}

describe("PositionManager - cascade take-profit", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup({
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "20",
      CASCADE_TAKE_PROFIT_SELL_PERCENT: "20",
    });
  });

  it("sells 20% of the position on the first +20% tranche, measured from entry", async () => {
    const { positionManager, executor } = ctx;
    executor.price = 1;
    await positionManager.manualBuy(100); // 100 tokens @ $1

    executor.price = 1.2;
    await positionManager.handlePriceSample(1.2, 0, Date.now());

    expect(positionManager.getCostBasis().tokenAmount).toBeCloseTo(80, 6);
  });

  it("measures the second tranche from the first tranche's sell price, not from entry", async () => {
    const { positionManager, executor } = ctx;
    executor.price = 1;
    await positionManager.manualBuy(100);

    executor.price = 1.2;
    await positionManager.handlePriceSample(1.2, 0, Date.now()); // -> 80 left

    // +40% from entry would already qualify under the old "entry" ladder,
    // but cascade mode needs +20% from 1.2 (i.e. >= 1.44), not from entry.
    executor.price = 1.3;
    await positionManager.handlePriceSample(1.3, 0, Date.now());
    expect(positionManager.getCostBasis().tokenAmount).toBeCloseTo(80, 6); // unchanged

    executor.price = 1.44;
    await positionManager.handlePriceSample(1.44, 0, Date.now());
    expect(positionManager.getCostBasis().tokenAmount).toBeCloseTo(64, 6); // 80 * 0.8
  });

  it("does NOT advance lastSellPriceUsd on a TAKE_PROFIT sell, so auto-buy's gate isn't ratcheted up", async () => {
    const { positionManager, executor } = ctx;
    executor.price = 1;
    await positionManager.manualBuy(100);

    executor.price = 1.2;
    await positionManager.handlePriceSample(1.2, 0, Date.now());

    expect(positionManager.getLastSellPriceUsd()).toBeUndefined();
  });

  it("DOES advance lastSellPriceUsd on a STOP_LOSS sell", async () => {
    const { positionManager, executor } = setup({ STOP_LOSS_PERCENT: "10" });
    executor.price = 1;
    await positionManager.manualBuy(100);

    executor.price = 0.85; // -15% triggers the 10% stop loss
    await positionManager.handlePriceSample(0.85, 0, Date.now());

    expect(positionManager.getLastSellPriceUsd()).toBeCloseTo(0.85, 6);
    expect(positionManager.getCostBasis().tokenAmount).toBe(0);
  });
});

describe("PositionManager - reset", () => {
  it("wipes trade history and in-memory state back to a fresh position", async () => {
    const { positionManager, executor, tradesRepo } = setup();
    executor.price = 1;
    await positionManager.manualBuy(100);
    executor.price = 1.5;
    await positionManager.manualSell(50, "MANUAL", 0);

    expect(tradesRepo.findAll().length).toBe(2);
    expect(positionManager.getLastSellPriceUsd()).toBeCloseTo(1.5, 6);

    positionManager.reset();

    expect(tradesRepo.findAll().length).toBe(0);
    expect(positionManager.getCostBasis().tokenAmount).toBe(0);
    expect(positionManager.getLastSellPriceUsd()).toBeUndefined();
    expect(positionManager.hasOpenPosition()).toBe(false);
  });
});
