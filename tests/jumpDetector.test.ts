import { describe, expect, it } from "vitest";
import { JumpDetector } from "../src/onchain/jumpDetector.js";

describe("JumpDetector", () => {
  it("does not flag a small move", () => {
    const d = new JumpDetector(10_000, 5);
    d.update(0, 1.0);
    const r = d.update(1_000, 1.01); // +1%
    expect(r.jumped).toBe(false);
  });

  it("flags a fast upward jump within the window", () => {
    const d = new JumpDetector(10_000, 5);
    d.update(0, 1.0);
    const r = d.update(2_000, 1.06); // +6%
    expect(r.jumped).toBe(true);
    expect(r.changePercent).toBeCloseTo(6, 6);
  });

  it("flags a fast downward jump too (abs value)", () => {
    const d = new JumpDetector(10_000, 5);
    d.update(0, 1.0);
    const r = d.update(2_000, 0.9); // -10%
    expect(r.jumped).toBe(true);
    expect(r.changePercent).toBeCloseTo(-10, 6);
  });

  it("ignores samples that fell out of the window", () => {
    const d = new JumpDetector(5_000, 5);
    d.update(0, 1.0);
    const r = d.update(20_000, 1.5); // huge move, but the t=0 sample is long gone
    // only one sample left in-window -> nothing to compare against
    expect(r.jumped).toBe(false);
    expect(r.changePercent).toBeUndefined();
  });

  it("returns no verdict on the very first sample", () => {
    const d = new JumpDetector(10_000, 5);
    const r = d.update(0, 1.0);
    expect(r.jumped).toBe(false);
    expect(r.changePercent).toBeUndefined();
  });
});
