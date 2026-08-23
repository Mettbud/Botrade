import { describe, expect, it } from "vitest";
import { initTrailingStop, updateTrailingStop } from "../src/strategy/trailingStop.js";

describe("trailingStop", () => {
  it("tracks the highest price seen since entry", () => {
    let state = initTrailingStop(0.01);
    ({ state } = updateTrailingStop(state, 0.012, 0.01, 12, 0));
    ({ state } = updateTrailingStop(state, 0.015, 0.01, 12, 0));
    ({ state } = updateTrailingStop(state, 0.013, 0.01, 12, 0));
    expect(state.highestPriceUsd).toBeCloseTo(0.015, 9);
  });

  it("triggers once price falls trailingStopPercent below the high (spec example)", () => {
    // buy = $0.01, rises to $0.015, trailing stop = 12%
    let state = initTrailingStop(0.01);
    ({ state } = updateTrailingStop(state, 0.015, 0.01, 12, 0));

    const stillAbove = updateTrailingStop(state, 0.0133, 0.01, 12, 0); // -11.3%
    expect(stillAbove.triggered).toBe(false);

    const trigger = updateTrailingStop(state, 0.0131, 0.01, 12, 0); // -12.7%
    expect(trigger.triggered).toBe(true);
    expect(trigger.drawdownFromHighPercent).toBeGreaterThanOrEqual(12);
  });

  it("does not arm until the activation threshold is met", () => {
    let state = initTrailingStop(0.01);
    // price only rose 5%, activation requires 10%
    const check = updateTrailingStop(state, 0.0105, 0.01, 1, 10);
    expect(check.state.armed).toBe(false);
    expect(check.triggered).toBe(false);
  });

  it("arms once activation threshold is reached and then can trigger", () => {
    let state = initTrailingStop(0.01);
    ({ state } = updateTrailingStop(state, 0.012, 0.01, 5, 10)); // +20% from entry, activation 10%
    expect(state.armed).toBe(true);

    const trigger = updateTrailingStop(state, 0.0113, 0.01, 5, 10); // -5.8% from high
    expect(trigger.triggered).toBe(true);
  });
});
