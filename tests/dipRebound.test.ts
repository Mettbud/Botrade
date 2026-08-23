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
});
