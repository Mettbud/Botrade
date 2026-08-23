import { describe, expect, it } from "vitest";
import {
  checkCascadeTakeProfit,
  evaluateCascadeTakeProfit,
} from "../src/strategy/cascadeTakeProfit.js";

type CascadeInput = Parameters<typeof evaluateCascadeTakeProfit>[0];

function evaluate(overrides: Partial<CascadeInput> = {}) {
  return evaluateCascadeTakeProfit({
    currentPriceUsd: 1,
    entryPriceUsd: 1,
    completedTranches: 0,
    gainStepPercent: 5,
    sellPercentOfInitial: 20,
    initialTokenAmount: 1_000,
    remainingTokenAmount: 1_000,
    ...overrides,
  });
}

describe("evaluateCascadeTakeProfit", () => {
  it("uses linear targets from the frozen entry price", () => {
    const first = evaluate({ currentPriceUsd: 1.05 });
    expect(first.shouldSell).toBe(true);
    expect(first.nextGainPercent).toBe(5);

    const second = evaluate({
      currentPriceUsd: 1.1,
      completedTranches: 1,
      remainingTokenAmount: 800,
    });
    expect(second.shouldSell).toBe(true);
    expect(second.nextGainPercent).toBe(10);
    expect(second.nextTargetPriceUsd).toBeCloseTo(1.1, 12);
    expect(second.gainPercent).toBeCloseTo(10, 12);
  });

  it("does not compound the next target from the previous sell price", () => {
    const status = evaluate({
      currentPriceUsd: 1.099,
      completedTranches: 1,
      remainingTokenAmount: 800,
    });
    expect(status.shouldSell).toBe(false);
    expect(status.nextTargetPriceUsd).toBeCloseTo(1.1, 12);
  });

  it("sells exactly 20% of the frozen initial amount per tranche", () => {
    const status = evaluate({
      currentPriceUsd: 1.1,
      completedTranches: 1,
      remainingTokenAmount: 800,
    });
    expect(status.singleTrancheTokenAmount).toBe(200);
    expect(status.sellTokenAmount).toBe(200);
  });

  it("catches up crossed targets in one evaluation", () => {
    const status = evaluate({ currentPriceUsd: 1.16 });
    expect(status.tranchesDue).toBe(3);
    expect(status.sellTokenAmount).toBe(600);
  });

  it("caps a due sell to the remaining regular position", () => {
    const status = evaluate({
      currentPriceUsd: 1.16,
      remainingTokenAmount: 350,
    });
    expect(status.tranchesDue).toBe(3);
    expect(status.sellTokenAmount).toBe(350);
  });

  it("retries only the missing part of a partially filled tranche", () => {
    const status = evaluate({
      currentPriceUsd: 1.15,
      completedTranches: 2,
      cascadeSoldTokenAmount: 500,
      remainingTokenAmount: 500,
    });

    expect(status.tranchesDue).toBe(1);
    expect(status.soldPercentOfInitial).toBe(50);
    expect(status.sellTokenAmount).toBe(100);
  });

  it("reports stable dashboard progress and the next target", () => {
    const status = evaluate({
      currentPriceUsd: 1.075,
      completedTranches: 1,
      remainingTokenAmount: 800,
    });
    expect(status.completedTranches).toBe(1);
    expect(status.maxTranches).toBe(5);
    expect(status.soldPercentOfInitial).toBe(20);
    expect(status.nextTrancheNumber).toBe(2);
    expect(status.nextGainPercent).toBe(10);
    expect(status.nextTargetPriceUsd).toBeCloseTo(1.1, 12);
    expect(status.gainRemainingPercent).toBeCloseTo(2.5, 12);
    expect(status.progressPercent).toBeCloseTo(50, 12);
  });

  it("adds a capped final tranche when sellPercent does not divide 100", () => {
    const status = evaluate({ sellPercentOfInitial: 30 });
    expect(status.maxTranches).toBe(4);

    const final = evaluate({
      currentPriceUsd: 1.2,
      sellPercentOfInitial: 30,
      completedTranches: 3,
      cascadeSoldTokenAmount: 900,
      remainingTokenAmount: 100,
    });
    expect(final.sellTokenAmount).toBe(100);
  });

  it("reports completion without another target", () => {
    const status = evaluate({
      currentPriceUsd: 1.3,
      completedTranches: 5,
      remainingTokenAmount: 0,
    });
    expect(status.complete).toBe(true);
    expect(status.nextTrancheNumber).toBeUndefined();
    expect(status.nextGainPercent).toBeUndefined();
    expect(status.nextTargetPriceUsd).toBeUndefined();
    expect(status.progressPercent).toBe(100);
    expect(status.shouldSell).toBe(false);
  });

  it("treats an invalid entry price as never due", () => {
    const status = evaluate({ currentPriceUsd: 1.5, entryPriceUsd: 0 });
    expect(status.shouldSell).toBe(false);
    expect(status.gainPercent).toBe(0);
    expect(status.nextTargetPriceUsd).toBeUndefined();
  });
});

describe("checkCascadeTakeProfit compatibility wrapper", () => {
  it("still exposes the fields used by the existing evaluator", () => {
    const status = checkCascadeTakeProfit(1.05, 1, 5, 20);
    expect(status.shouldSell).toBe(true);
    expect(status.sellPercent).toBe(20);
    expect(status.gainPercent).toBeCloseTo(5, 12);
  });
});
