import { describe, expect, it } from "vitest";
import { IDLE_DIP_WATCH, updateDipWatch } from "../src/strategy/dipRebound.js";

describe("updateDipWatch", () => {
  it("does not start watching for a drop below the threshold", () => {
    // recent high $1, now $0.60 => -40%, threshold 50%
    const r = updateDipWatch(IDLE_DIP_WATCH, 0.6, 1.0, 50);
    expect(r.state.watching).toBe(false);
    expect(r.shouldBuy).toBe(false);
    expect(r.dropPercentFromHigh).toBeCloseTo(40, 9);
  });

  it("starts watching once the drop meets the threshold", () => {
    // recent high $1, now $0.45 => -55%, threshold 50%
    const r = updateDipWatch(IDLE_DIP_WATCH, 0.45, 1.0, 50);
    expect(r.state.watching).toBe(true);
    expect(r.state.lowestPriceUsd).toBe(0.45);
    expect(r.shouldBuy).toBe(false);
  });

  it("keeps tracking a new low while still falling, never buys", () => {
    let state = updateDipWatch(IDLE_DIP_WATCH, 0.45, 1.0, 50).state;
    const r = updateDipWatch(state, 0.3, 1.0, 50); // fell further
    expect(r.shouldBuy).toBe(false);
    expect(r.state.watching).toBe(true);
    expect(r.state.lowestPriceUsd).toBe(0.3);
  });

  it("buys on the first uptick from the lowest point seen (the spec example)", () => {
    let state = updateDipWatch(IDLE_DIP_WATCH, 0.45, 1.0, 50).state; // start watching
    state = updateDipWatch(state, 0.3, 1.0, 50).state; // new low
    const rebound = updateDipWatch(state, 0.32, 1.0, 50); // ticks up
    expect(rebound.shouldBuy).toBe(true);
    expect(rebound.state).toEqual(IDLE_DIP_WATCH); // resets, ready for next cycle
  });

  it("does nothing with no recent-high reference yet (e.g. bot just started)", () => {
    const r = updateDipWatch(IDLE_DIP_WATCH, 0.5, undefined, 50);
    expect(r.shouldBuy).toBe(false);
    expect(r.state.watching).toBe(false);
  });

  it("a flat/unchanged price while watching does not trigger a buy", () => {
    const state = updateDipWatch(IDLE_DIP_WATCH, 0.3, 1.0, 50).state;
    const r = updateDipWatch(state, 0.3, 1.0, 50); // exactly equal, not an uptick
    expect(r.shouldBuy).toBe(false);
  });

  it("disarms when a dynamic threshold widens beyond the current drawdown", () => {
    const calmState = updateDipWatch(IDLE_DIP_WATCH, 0.98, 1.0, 2).state;
    expect(calmState.watching).toBe(true);

    const volatileState = updateDipWatch(calmState, 0.97, 1.0, 5);
    expect(volatileState.shouldBuy).toBe(false);
    expect(volatileState.state).toEqual(IDLE_DIP_WATCH);

    const rearmed = updateDipWatch(volatileState.state, 0.94, 1.0, 5);
    expect(rearmed.state.watching).toBe(true);
    expect(rearmed.state.armedDipPercent).toBe(5);
  });

  it("holds a configured rebound for the full confirmation period", () => {
    let state = updateDipWatch(IDLE_DIP_WATCH, 0.4, 1, 50, {
      nowMs: 1_000,
      reboundPercent: 1,
      confirmationMs: 8_000,
      timeoutMs: 30_000,
    }).state;
    let result = updateDipWatch(state, 0.404, 1, 50, {
      nowMs: 2_000,
      reboundPercent: 1,
      confirmationMs: 8_000,
      timeoutMs: 30_000,
    });
    expect(result.shouldBuy).toBe(false);
    expect(result.state.reboundStartedAtMs).toBe(2_000);

    state = result.state;
    result = updateDipWatch(state, 0.405, 1, 50, {
      nowMs: 10_000,
      reboundPercent: 1,
      confirmationMs: 8_000,
      timeoutMs: 30_000,
    });
    expect(result.shouldBuy).toBe(true);
  });

  it("expires a stale rebound watch instead of buying an old setup", () => {
    const state = updateDipWatch(IDLE_DIP_WATCH, 0.4, 1, 50, {
      nowMs: 1_000,
      reboundPercent: 1,
      confirmationMs: 0,
      timeoutMs: 5_000,
    }).state;
    const result = updateDipWatch(state, 0.5, 1, 50, {
      nowMs: 6_000,
      reboundPercent: 1,
      confirmationMs: 0,
      timeoutMs: 5_000,
    });
    expect(result.shouldBuy).toBe(false);
    expect(result.state).toEqual(IDLE_DIP_WATCH);
  });
});
