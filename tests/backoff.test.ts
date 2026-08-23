import { describe, expect, it } from "vitest";
import { nextPollDelayMs } from "../src/market/backoff.js";

describe("nextPollDelayMs", () => {
  it("uses the base interval with no prior errors", () => {
    expect(nextPollDelayMs(2000, 0)).toBe(2000);
  });

  it("doubles per consecutive error", () => {
    expect(nextPollDelayMs(2000, 1)).toBe(4000);
    expect(nextPollDelayMs(2000, 2)).toBe(8000);
    expect(nextPollDelayMs(2000, 3)).toBe(16000);
  });

  it("caps at maxDelayMs instead of growing forever", () => {
    expect(nextPollDelayMs(2000, 10, 30_000)).toBe(30_000);
    expect(nextPollDelayMs(2000, 100, 30_000)).toBe(30_000);
  });

  it("resets to the base interval once errors clear (consecutiveErrors=0)", () => {
    expect(nextPollDelayMs(1000, 0)).toBe(1000);
  });
});
