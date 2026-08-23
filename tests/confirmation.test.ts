import { describe, expect, it } from "vitest";
import { TriggerConfirmation } from "../src/strategy/confirmation.js";

describe("TriggerConfirmation (wick protection)", () => {
  it("confirms immediately when disabled", () => {
    const gate = new TriggerConfirmation(false, 2000);
    expect(gate.update(true, 0)).toBe(true);
  });

  it("requires the trigger to hold for confirmMs before confirming", () => {
    const gate = new TriggerConfirmation(true, 2000);
    expect(gate.update(true, 0)).toBe(false);
    expect(gate.update(true, 1000)).toBe(false);
    expect(gate.update(true, 2000)).toBe(true);
  });

  it("resets the timer if the trigger goes false before confirmMs (a single wick)", () => {
    const gate = new TriggerConfirmation(true, 2000);
    expect(gate.update(true, 0)).toBe(false);
    expect(gate.update(false, 500)).toBe(false); // price bounced back
    expect(gate.update(true, 700)).toBe(false); // trigger again, timer restarts
    expect(gate.update(true, 2699)).toBe(false);
    expect(gate.update(true, 2700)).toBe(true);
  });

  it("stays confirmed on subsequent true ticks until reset", () => {
    const gate = new TriggerConfirmation(true, 1000);
    gate.update(true, 0);
    expect(gate.update(true, 1000)).toBe(true);
    expect(gate.update(true, 5000)).toBe(true);
    gate.reset();
    expect(gate.update(true, 5001)).toBe(false);
  });
});
