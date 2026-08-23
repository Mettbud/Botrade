import { beforeEach, describe, expect, it } from "vitest";
import { buildConfig } from "../src/config/schema.js";
import { openDatabase } from "../src/database/index.js";
import { TrailingStateRepo } from "../src/database/trailingStateRepo.js";
import { TradesRepo } from "../src/database/tradesRepo.js";
import { createLogger } from "../src/logger/index.js";
import { PositionManager } from "../src/trading/positionManager.js";
import type { TradeExecutor, BuyParams, SellParams } from "../src/trading/tradeExecutor.js";
import type { Trade, TradeMode } from "../src/trading/types.js";

/** Executes trades instantly at whatever `price` is set to at call time. */
class FakeExecutor implements TradeExecutor {
  readonly mode: TradeMode;
  price = 1;
  sellCalls = 0;
  sellFillRatio = 1;
  buyGate: Promise<void> | undefined;
  sellGate: Promise<void> | undefined;

  constructor(mode: TradeMode = "PAPER") {
    this.mode = mode;
  }

  async buy({ usdAmount, reason }: BuyParams): Promise<Trade> {
    const executionPrice = this.price;
    await this.buyGate;
    return {
      timestampMs: Date.now(),
      mode: this.mode,
      side: "BUY",
      reason,
      tokenAmount: usdAmount / executionPrice,
      solAmount: 0,
      usdEstimate: usdAmount,
    };
  }

  async sell({ tokenAmount, reason }: SellParams): Promise<Trade> {
    this.sellCalls += 1;
    await this.sellGate;
    const executedTokenAmount = tokenAmount * this.sellFillRatio;
    return {
      timestampMs: Date.now(),
      mode: this.mode,
      side: "SELL",
      reason,
      tokenAmount: executedTokenAmount,
      solAmount: 0,
      usdEstimate: executedTokenAmount * this.price,
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
  const trailingStateRepo = new TrailingStateRepo(db);
  const logger = createLogger("error");
  const executor = new FakeExecutor();
  const positionManager = new PositionManager(
    executor,
    tradesRepo,
    config,
    logger,
    trailingStateRepo,
  );
  return {
    config,
    tradesRepo,
    trailingStateRepo,
    executor,
    positionManager,
  };
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

  it("uses linear targets from entry and sells another 20% of the initial position", async () => {
    const { positionManager, executor } = ctx;
    executor.price = 1;
    await positionManager.manualBuy(100);

    executor.price = 1.2;
    await positionManager.handlePriceSample(1.2, 0, Date.now()); // -> 80 left

    // With a 20% step the second linear target is +40% from entry.
    executor.price = 1.3;
    await positionManager.handlePriceSample(1.3, 0, Date.now());
    expect(positionManager.getCostBasis().tokenAmount).toBeCloseTo(80, 6); // unchanged

    executor.price = 1.4;
    await positionManager.handlePriceSample(1.4, 0, Date.now());
    expect(positionManager.getCostBasis().tokenAmount).toBeCloseTo(60, 6);
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

  it("does not execute duplicate automatic sells from overlapping price samples", async () => {
    const { positionManager, executor } = ctx;
    executor.price = 1;
    await positionManager.manualBuy(100);

    let releaseSell!: () => void;
    executor.sellGate = new Promise<void>((resolve) => {
      releaseSell = resolve;
    });
    executor.price = 1.2;

    const firstSample = positionManager.handlePriceSample(1.2, 0, Date.now());
    await Promise.resolve();
    const overlappingSample = positionManager.handlePriceSample(1.2, 0, Date.now());

    expect(executor.sellCalls).toBe(1);
    releaseSell();
    await Promise.all([firstSample, overlappingSample]);
    expect(positionManager.getCostBasis().tokenAmount).toBeCloseTo(80, 6);
  });

  it("sells exactly 60% of the initial position when price jumps through +5/+10/+15", async () => {
    const { positionManager, executor, tradesRepo } = setup({
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "5",
      CASCADE_TAKE_PROFIT_SELL_PERCENT: "20",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);

    executor.price = 1.15;
    await positionManager.handlePriceSample(1.15, 0, Date.now());

    expect(positionManager.getRegularCostBasis().tokenAmount).toBeCloseTo(40, 6);
    expect(positionManager.getCascadeStatus(1.15)).toMatchObject({
      completedTranches: 3,
      soldPercentOfInitial: 60,
      nextGainPercent: 20,
    });
    const cascadeTrade = tradesRepo
      .findAll()
      .find((trade) => trade.reason === "CASCADE_TAKE_PROFIT");
    expect(cascadeTrade?.cascadeTranchesExecuted).toBe(3);
  });

  it("counts only fully executed cascade tranches and retries a partial fill", async () => {
    const { positionManager, executor, tradesRepo } = setup({
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "5",
      CASCADE_TAKE_PROFIT_SELL_PERCENT: "20",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);

    executor.price = 1.15;
    executor.sellFillRatio = 2 / 3;
    await positionManager.handlePriceSample(1.15, 0, Date.now());

    expect(positionManager.getCascadeCycle()).toMatchObject({
      completedTranches: 2,
      cascadeSoldTokenAmount: 40,
    });
    expect(positionManager.getCascadeStatus(1.15)).toMatchObject({
      tranchesDue: 1,
      sellTokenAmount: 20,
      soldPercentOfInitial: 40,
    });

    executor.sellFillRatio = 1;
    await positionManager.handlePriceSample(1.15, 0, Date.now() + 1);

    expect(positionManager.getRegularCostBasis().tokenAmount).toBeCloseTo(40, 6);
    expect(positionManager.getCascadeCycle()).toMatchObject({
      completedTranches: 3,
      cascadeSoldTokenAmount: 60,
    });
    expect(
      tradesRepo
        .findAll()
        .filter((trade) => trade.reason === "CASCADE_TAKE_PROFIT")
        .map((trade) => trade.cascadeTranchesExecuted),
    ).toEqual([2, 1]);
  });

  it("records a capped final cascade payout as completed", async () => {
    const { positionManager, executor, tradesRepo } = setup({
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "5",
      CASCADE_TAKE_PROFIT_SELL_PERCENT: "30",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);

    executor.price = 1.2;
    await positionManager.handlePriceSample(1.2, 0, Date.now());

    expect(positionManager.getRegularCostBasis().tokenAmount).toBe(0);
    expect(
      tradesRepo
        .findAll()
        .find((trade) => trade.reason === "CASCADE_TAKE_PROFIT")
        ?.cascadeTranchesExecuted,
    ).toBe(4);
  });

  it("discards a sample captured before an earlier queued buy changed the position", async () => {
    const { positionManager, executor } = setup({
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "5",
      CASCADE_TAKE_PROFIT_SELL_PERCENT: "20",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);

    let releaseBuy!: () => void;
    executor.buyGate = new Promise<void>((resolve) => {
      releaseBuy = resolve;
    });
    const queuedBuy = positionManager.manualBuy(100);
    await Promise.resolve();

    executor.price = 1.15;
    const queuedSample = positionManager.handlePriceSample(
      1.15,
      0,
      Date.now(),
    );
    releaseBuy();
    await Promise.all([queuedBuy, queuedSample]);

    expect(positionManager.getCascadeCycle()).toMatchObject({
      entryPriceUsd: 1,
      initialTokenAmount: 200,
      completedTranches: 0,
    });
    expect(positionManager.getRegularCostBasis().tokenAmount).toBeCloseTo(200, 6);

    await positionManager.handlePriceSample(1.15, 0, Date.now() + 1);
    expect(positionManager.getCascadeCycle()).toMatchObject({
      completedTranches: 3,
    });
    expect(positionManager.getRegularCostBasis().tokenAmount).toBeCloseTo(80, 6);
  });

  it("does not apply a pre-entry price peak to a newly opened position", async () => {
    const { positionManager, executor } = setup({
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "5",
      CASCADE_TAKE_PROFIT_SELL_PERCENT: "20",
    });
    executor.price = 1;
    let releaseBuy!: () => void;
    executor.buyGate = new Promise<void>((resolve) => {
      releaseBuy = resolve;
    });

    const queuedBuy = positionManager.manualBuy(100);
    await Promise.resolve();
    const oldPeak = positionManager.handlePriceSample(1.5, 0, Date.now());
    releaseBuy();
    await Promise.all([queuedBuy, oldPeak]);

    expect(executor.sellCalls).toBe(0);
    expect(positionManager.getRegularCostBasis().tokenAmount).toBeCloseTo(100, 6);
  });

  it("blocks regular averaging after the first cascade payout", async () => {
    const { positionManager, executor } = setup({
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "5",
      CASCADE_TAKE_PROFIT_SELL_PERCENT: "20",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);
    executor.price = 1.05;
    await positionManager.handlePriceSample(1.05, 0, Date.now());

    await expect(positionManager.manualBuy(10)).rejects.toThrow(
      "Regular buy blocked",
    );
    expect(positionManager.getRegularCostBasis().tokenAmount).toBeCloseTo(80, 6);
  });

  it("blocks averaging after even a partial first cascade fill", async () => {
    const { positionManager, executor } = setup({
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "5",
      CASCADE_TAKE_PROFIT_SELL_PERCENT: "20",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);
    executor.price = 1.05;
    executor.sellFillRatio = 0.5;
    await positionManager.handlePriceSample(1.05, 0, Date.now());

    expect(positionManager.getCascadeCycle()).toMatchObject({
      completedTranches: 0,
      cascadeSoldTokenAmount: 10,
    });
    await expect(positionManager.manualBuy(10)).rejects.toThrow(
      "Regular buy blocked",
    );
  });

  it("preserves a queued price peak while an automatic sell is in flight", async () => {
    const { positionManager, executor } = setup({
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "5",
      CASCADE_TAKE_PROFIT_SELL_PERCENT: "20",
      TRAILING_STOP_PERCENT: "10",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);

    let releaseSell!: () => void;
    executor.sellGate = new Promise<void>((resolve) => {
      releaseSell = resolve;
    });
    executor.price = 1.05;
    const firstSample = positionManager.handlePriceSample(1.05, 0, Date.now());
    await Promise.resolve();

    executor.price = 1.2;
    await positionManager.handlePriceSample(1.5, 0, Date.now() + 1);
    await positionManager.handlePriceSample(1.2, 0, Date.now() + 2);
    releaseSell();
    await firstSample;

    expect(executor.sellCalls).toBe(2);
    expect(positionManager.getCostBasis().tokenAmount).toBe(0);
  });

  it("does not erase the regular trailing high when averaging before a payout", async () => {
    const { positionManager, executor, tradesRepo } = setup({
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "100",
      TRAILING_STOP_PERCENT: "12",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);
    await positionManager.handlePriceSample(1.5, 0, Date.now());

    executor.price = 1.2;
    await positionManager.manualBuy(20);
    executor.price = 1.25;
    await positionManager.handlePriceSample(1.25, 0, Date.now() + 1);

    expect(positionManager.getRegularCostBasis().tokenAmount).toBe(0);
    expect(tradesRepo.findAll().at(-1)?.reason).toBe(
      "REGULAR_TRAILING_STOP",
    );
  });

  it("restores the regular trailing high-water after restart", async () => {
    const {
      config,
      positionManager,
      executor,
      tradesRepo,
      trailingStateRepo,
    } = setup({
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "100",
      TRAILING_STOP_PERCENT: "12",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);
    await positionManager.handlePriceSample(1.5, 0, Date.now());

    const restarted = new PositionManager(
      executor,
      tradesRepo,
      config,
      createLogger("error"),
      trailingStateRepo,
    );
    executor.price = 1.3;
    await restarted.handlePriceSample(1.3, 0, Date.now() + 1);

    expect(restarted.getRegularCostBasis().tokenAmount).toBe(0);
    expect(tradesRepo.findAll().at(-1)?.reason).toBe(
      "REGULAR_TRAILING_STOP",
    );
    expect(
      trailingStateRepo.get("PAPER", "regular", "closed-cycle"),
    ).toBeUndefined();
  });

  it("does not attach a stale regular high-water to a newer position cycle", async () => {
    const {
      config,
      positionManager,
      executor,
      tradesRepo,
      trailingStateRepo,
    } = setup({
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "100",
      TRAILING_STOP_PERCENT: "12",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);
    await positionManager.handlePriceSample(1.5, 0, Date.now());
    await positionManager.manualSell(100, "MANUAL", 0);

    // Simulates a stale write left by an older process. The new BUY is then
    // persisted without going through that process's trailing-state update.
    trailingStateRepo.upsert("PAPER", "regular", "old-cycle", {
      highestPriceUsd: 1.5,
      armed: true,
    });
    const newBuy = await executor.buy({ usdAmount: 100, reason: "MANUAL" });
    const newBuyId = tradesRepo.insert(newBuy);

    const restarted = new PositionManager(
      executor,
      tradesRepo,
      config,
      createLogger("error"),
      trailingStateRepo,
    );
    expect(
      trailingStateRepo.get("PAPER", "regular", `trade:${newBuyId}`),
    ).toEqual({ highestPriceUsd: 1, armed: false });

    executor.price = 1.3;
    await restarted.handlePriceSample(1.3, 0, Date.now() + 1);
    expect(restarted.getRegularCostBasis().tokenAmount).toBeCloseTo(100, 6);
    expect(tradesRepo.findAll().at(-1)?.side).toBe("BUY");
  });

  it("arms +8% profit lock after three payouts and closes only the regular remainder", async () => {
    const { positionManager, executor } = setup({
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "5",
      CASCADE_TAKE_PROFIT_SELL_PERCENT: "20",
      CASCADE_PROFIT_LOCK_ENABLED: "true",
      CASCADE_PROFIT_LOCK_AFTER_TRANCHES: "3",
      CASCADE_PROFIT_LOCK_GAIN_PERCENT: "8",
      CASCADE_PROFIT_LOCK_CONFIRMATION_ENABLED: "false",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);
    executor.price = 1.15;
    await positionManager.handlePriceSample(1.15, 0, Date.now());
    expect(positionManager.getProfitLockStatus(1.15)?.armed).toBe(true);

    executor.price = 1.08;
    // Profit lock is a floor, so unlike ordinary TP it is not held back by
    // a widened spread on the reversal.
    await positionManager.handlePriceSample(1.08, 0, Date.now(), 0.05);
    expect(positionManager.getRegularCostBasis().tokenAmount).toBe(0);
  });

  it("persists the cascade counter across a PositionManager restart", async () => {
    const { config, positionManager, executor, tradesRepo } = setup({
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "5",
      CASCADE_TAKE_PROFIT_SELL_PERCENT: "20",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);
    executor.price = 1.15;
    await positionManager.handlePriceSample(1.15, 0, Date.now());

    const restarted = new PositionManager(
      executor,
      tradesRepo,
      config,
      createLogger("error"),
    );
    expect(restarted.getCascadeStatus(1.16)).toMatchObject({
      completedTranches: 3,
      nextGainPercent: 20,
      shouldSell: false,
    });
    expect(restarted.getRegularCostBasis().tokenAmount).toBeCloseTo(40, 6);
  });
});

describe("PositionManager - isolated crash lot", () => {
  it("exits only the crash-buy amount and leaves the regular position unchanged", async () => {
    const { positionManager, executor, tradesRepo } = setup();
    executor.price = 1;
    await positionManager.manualBuy(100);
    executor.price = 0.5;
    const crashTrade = await positionManager.crashBuy(50, 1);

    expect(crashTrade.crashLotId).toBeTruthy();
    expect(positionManager.getRegularCostBasis().tokenAmount).toBeCloseTo(100, 6);
    expect(positionManager.getActiveCrashLot()?.tokenAmount).toBeCloseTo(100, 6);

    executor.price = 0.97;
    await positionManager.exitCrashLot(0);

    expect(positionManager.getRegularCostBasis().tokenAmount).toBeCloseTo(100, 6);
    expect(positionManager.getActiveCrashLot()).toBeUndefined();
    expect(positionManager.getCostBasis().tokenAmount).toBeCloseTo(100, 6);
    const exit = tradesRepo.findAll().find((trade) => trade.reason === "CRASH_BUY_EXIT");
    expect(exit?.crashLotId).toBe(crashTrade.crashLotId);
  });

  it("reconstructs the active crash lot after restart and never consumes later regular buys", async () => {
    const { config, positionManager, executor, tradesRepo } = setup();
    executor.price = 1;
    await positionManager.manualBuy(100);
    executor.price = 0.5;
    const crash = await positionManager.crashBuy(50, 1);
    executor.price = 0.6;
    await positionManager.manualBuy(60); // another 100 regular tokens

    const restarted = new PositionManager(
      executor,
      tradesRepo,
      config,
      createLogger("error"),
    );
    expect(restarted.getActiveCrashLot()).toMatchObject({
      crashLotId: crash.crashLotId,
      tokenAmount: 100,
      preDropPriceUsd: 1,
    });

    executor.price = 0.97;
    await restarted.exitCrashLot(0, crash.crashLotId);
    expect(restarted.getRegularCostBasis().tokenAmount).toBeCloseTo(200, 6);
    expect(restarted.getCostBasis().tokenAmount).toBeCloseTo(200, 6);
  });

  it("restores a crash lot's own trailing high-water after restart", async () => {
    const {
      config,
      positionManager,
      executor,
      tradesRepo,
      trailingStateRepo,
    } = setup({
      TRAILING_STOP_PERCENT: "12",
    });
    executor.price = 1;
    const crash = await positionManager.crashBuy(100, 2);
    await positionManager.handlePriceSample(1.5, 0, Date.now());

    const restarted = new PositionManager(
      executor,
      tradesRepo,
      config,
      createLogger("error"),
      trailingStateRepo,
    );
    executor.price = 1.3;
    await restarted.handlePriceSample(1.3, 0, Date.now() + 1);

    expect(restarted.getActiveCrashLot()).toBeUndefined();
    expect(tradesRepo.findAll().at(-1)?.reason).toBe(
      "CRASH_TRAILING_STOP",
    );
    expect(
      trailingStateRepo.get(
        "PAPER",
        `crash:${crash.crashLotId}`,
        crash.crashLotId!,
      ),
    ).toBeUndefined();
  });

  it("does not let a regular trailing stop consume a newly opened crash lot", async () => {
    const { positionManager, executor, tradesRepo } = setup({
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "100",
      TRAILING_STOP_PERCENT: "12",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);
    await positionManager.handlePriceSample(1.2, 0, Date.now());

    executor.price = 0.96;
    await positionManager.crashBuy(48, 1.2);
    await positionManager.handlePriceSample(0.96, 0, Date.now() + 1);

    expect(positionManager.getRegularCostBasis().tokenAmount).toBe(0);
    expect(positionManager.getActiveCrashLot()?.tokenAmount).toBeCloseTo(50, 6);
    expect(tradesRepo.findAll().at(-1)?.reason).toBe("REGULAR_TRAILING_STOP");
  });

  it("stops only the crash lot when its own entry loses 15%", async () => {
    const { positionManager, executor, tradesRepo } = setup({
      STOP_LOSS_PERCENT: "15",
    });
    executor.price = 0.3;
    await positionManager.manualBuy(100);
    executor.price = 0.5;
    await positionManager.crashBuy(50, 0.6);

    executor.price = 0.4;
    await positionManager.handlePriceSample(0.4, 0, Date.now());

    expect(positionManager.getRegularCostBasis().tokenAmount).toBeCloseTo(
      100 / 0.3,
      6,
    );
    expect(positionManager.getActiveCrashLot()).toBeUndefined();
    expect(tradesRepo.findAll().at(-1)?.reason).toBe("CRASH_STOP_LOSS");
  });

  it("combines two simultaneously confirmed hard stops into one emergency swap", async () => {
    const { positionManager, executor, tradesRepo } = setup({
      STOP_LOSS_PERCENT: "10",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);
    await positionManager.crashBuy(50, 1.2);

    executor.price = 0.8;
    await positionManager.handlePriceSample(0.8, 0, Date.now());

    expect(executor.sellCalls).toBe(1);
    expect(positionManager.getCostBasis().tokenAmount).toBe(0);
    expect(positionManager.getRegularCostBasis().tokenAmount).toBe(0);
    expect(positionManager.getActiveCrashLot()).toBeUndefined();
    expect(tradesRepo.findAll().at(-1)?.reason).toBe("STOP_LOSS");
  });

  it("combines two independently triggered trailing exits into one swap", async () => {
    const { positionManager, executor, tradesRepo } = setup({
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "100",
      TRAILING_STOP_PERCENT: "12",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);
    await positionManager.crashBuy(50, 1.2);
    await positionManager.handlePriceSample(1.5, 0, Date.now());

    executor.price = 1.3;
    await positionManager.handlePriceSample(1.3, 0, Date.now() + 1);

    expect(executor.sellCalls).toBe(1);
    expect(positionManager.getCostBasis().tokenAmount).toBe(0);
    expect(tradesRepo.findAll().at(-1)?.reason).toBe("TRAILING_STOP");
  });

  it("keeps panic as the explicit global exit for both books", async () => {
    const { config, positionManager, executor, tradesRepo } = setup();
    executor.price = 1;
    await positionManager.manualBuy(100);
    executor.price = 0.5;
    await positionManager.crashBuy(50, 1);

    await positionManager.panicSell(0);

    expect(positionManager.getRegularCostBasis().tokenAmount).toBe(0);
    expect(positionManager.getActiveCrashLot()).toBeUndefined();
    expect(positionManager.getCostBasis().tokenAmount).toBe(0);

    const restarted = new PositionManager(
      executor,
      tradesRepo,
      config,
      createLogger("error"),
    );
    expect(restarted.getLatestCrashTrade()).toMatchObject({
      reason: "CRASH_BUY_EXIT",
      tokenAmount: 100,
    });
  });
});

describe("PositionManager - spread guard", () => {
  it("blocks a TAKE_PROFIT sell when spread exceeds MAX_SPREAD_BPS", async () => {
    const { positionManager, executor } = setup({
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "20",
      CASCADE_TAKE_PROFIT_SELL_PERCENT: "20",
      MAX_SPREAD_BPS: "50", // 0.5%
    });
    executor.price = 1;
    await positionManager.manualBuy(100);

    executor.price = 1.2; // +20%, would normally fire the cascade tranche
    await positionManager.handlePriceSample(1.2, 0, Date.now(), 0.02); // 2% spread - over the 0.5% cap

    expect(positionManager.getCostBasis().tokenAmount).toBeCloseTo(100, 6); // unchanged - blocked
  });

  it("still executes a STOP_LOSS sell even when spread exceeds MAX_SPREAD_BPS", async () => {
    const { positionManager, executor } = setup({
      STOP_LOSS_PERCENT: "10",
      MAX_SPREAD_BPS: "50",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);

    executor.price = 0.85; // -15%, triggers the 10% stop loss
    await positionManager.handlePriceSample(0.85, 0, Date.now(), 0.05); // 5% spread - way over the cap

    expect(positionManager.getCostBasis().tokenAmount).toBe(0); // sold anyway - STOP_LOSS bypasses the spread guard
  });

  it("allows a TAKE_PROFIT sell above the high-gain threshold using the looser cap", async () => {
    const { positionManager, executor } = setup({
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "20",
      CASCADE_TAKE_PROFIT_SELL_PERCENT: "20",
      MAX_SPREAD_BPS: "50", // 0.5%
      MAX_SPREAD_HIGH_GAIN_BPS: "200", // 2%
      MAX_SPREAD_HIGH_GAIN_THRESHOLD_PERCENT: "10",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);

    executor.price = 1.2; // +20% unrealized gain - above the 10% high-gain threshold
    await positionManager.handlePriceSample(1.2, 0, Date.now(), 0.015); // 1.5% spread - over base cap, under the 2% high-gain cap

    expect(positionManager.getCostBasis().tokenAmount).toBeCloseTo(80, 6); // sold - looser cap applied
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

describe("PositionManager - recovery buy", () => {
  it("allows one add, persists its count, and rejects a second add", async () => {
    const {
      config,
      positionManager,
      executor,
      tradesRepo,
      trailingStateRepo,
    } = setup({
      RECOVERY_BUY_ENABLED: "true",
      RECOVERY_BUY_MAX_ADDS_PER_POSITION: "1",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);
    await positionManager.recoveryBuy(10);
    expect(positionManager.getRecoveryBuyCount()).toBe(1);
    await expect(positionManager.recoveryBuy(10)).rejects.toThrow(/limit/);

    const restarted = new PositionManager(
      executor,
      tradesRepo,
      config,
      createLogger("error"),
      trailingStateRepo,
    );
    expect(restarted.getRecoveryBuyCount()).toBe(1);
    await expect(restarted.recoveryBuy(10)).rejects.toThrow(/limit/);
  });

  it("rejects recovery averaging after any cascade amount was sold", async () => {
    const { positionManager, executor } = setup({
      RECOVERY_BUY_ENABLED: "true",
      TAKE_PROFIT_MODE: "cascade",
      CASCADE_TAKE_PROFIT_PERCENT: "5",
      CASCADE_TAKE_PROFIT_SELL_PERCENT: "20",
    });
    executor.price = 1;
    await positionManager.manualBuy(100);
    executor.price = 1.05;
    await positionManager.handlePriceSample(1.05, 0, Date.now());

    await expect(positionManager.recoveryBuy(10)).rejects.toThrow(/cascade payout/);
  });
});
