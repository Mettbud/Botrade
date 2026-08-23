import { describe, expect, it } from "vitest";
import { checkCrashBuyRebound } from "../src/strategy/crashBuyExit.js";

describe("checkCrashBuyRebound", () => {
  it("does not sell exactly at the tolerance boundary", () => {
    // P0=100, tolerance=3% -> boundary is 97.
    expect(checkCrashBuyRebound(97, 100, 3)).toBe(false);
  });

  it("sells once price is above the tolerance boundary", () => {
    expect(checkCrashBuyRebound(99, 100, 3)).toBe(true);
  });

  it("does not sell while still below the boundary", () => {
    expect(checkCrashBuyRebound(90, 100, 3)).toBe(false);
  });

  it("treats an invalid (<=0) reference price as never due", () => {
    expect(checkCrashBuyRebound(50, 0, 3)).toBe(false);
  });
});
