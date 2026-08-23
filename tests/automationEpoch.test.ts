import { describe, expect, it } from "vitest";
import { AutomationEpoch } from "../src/trading/automationEpoch.js";

describe("AutomationEpoch", () => {
  it("invalidates asynchronous continuations captured before PAPER reset", () => {
    const epoch = new AutomationEpoch();
    const staleOperation = epoch.capture();

    epoch.invalidate();

    expect(epoch.isCurrent(staleOperation)).toBe(false);
    expect(epoch.isCurrent(epoch.capture())).toBe(true);
  });

  it("does not let an old operation impersonate work from a newer session", () => {
    const epoch = new AutomationEpoch();
    const firstSession = epoch.capture();
    epoch.invalidate();
    const secondSession = epoch.capture();

    expect(epoch.isCurrent(firstSession)).toBe(false);
    expect(epoch.isCurrent(secondSession)).toBe(true);
  });
});
