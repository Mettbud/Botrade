import { describe, expect, it } from "vitest";
import { resolveMaxSpreadBps } from "../src/trading/spreadGuard.js";
import { checkSpread } from "../src/trading/riskGuards.js";

const config = {
  maxSpreadBps: 50,
  maxSpreadHighGainBps: 100,
  maxSpreadHighGainThresholdPercent: 10,
};

describe("resolveMaxSpreadBps", () => {
  it("returns undefined (no cap) for STOP_LOSS", () => {
    expect(resolveMaxSpreadBps("STOP_LOSS", 3, config)).toBeUndefined();
  });

  it("returns undefined (no cap) for PANIC_EXIT", () => {
    expect(resolveMaxSpreadBps("PANIC_EXIT", -50, config)).toBeUndefined();
  });

  it("uses the base cap for TAKE_PROFIT below the high-gain threshold", () => {
    expect(resolveMaxSpreadBps("TAKE_PROFIT", 8, config)).toBe(50);
  });

  it("uses the looser cap for TAKE_PROFIT above the high-gain threshold", () => {
    expect(resolveMaxSpreadBps("TAKE_PROFIT", 15, config)).toBe(100);
  });

  it("uses the base cap for TRAILING_STOP below the threshold", () => {
    expect(resolveMaxSpreadBps("TRAILING_STOP", 5, config)).toBe(50);
  });

  it("treats an undefined gain as 0 (base cap)", () => {
    expect(resolveMaxSpreadBps("TAKE_PROFIT", undefined, config)).toBe(50);
  });
});

describe("checkSpread", () => {
  it("blocks when spread exceeds the cap", () => {
    const r = checkSpread(60, 50);
    expect(r.allowed).toBe(false);
  });

  it("allows when spread is within the cap", () => {
    const r = checkSpread(40, 50);
    expect(r.allowed).toBe(true);
  });

  it("allows exactly at the cap", () => {
    expect(checkSpread(50, 50).allowed).toBe(true);
  });
});
