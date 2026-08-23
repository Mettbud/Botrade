import { describe, expect, it, vi } from "vitest";
import { handleLine, type CommandDeps } from "../src/cli/commands.js";
import { buildConfig } from "../src/config/schema.js";
import { Logger } from "../src/logger/index.js";
import { PaperTrader } from "../src/trading/paperTrader.js";

function resetDeps(): {
  deps: CommandDeps;
  reset: ReturnType<typeof vi.fn>;
  onPaperReset: ReturnType<typeof vi.fn>;
  executor: PaperTrader;
} {
  const config = buildConfig({
    TARGET_TOKEN_MINT: "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg",
    TRADING_MODE: "paper",
    PAPER_BALANCE_USD: "1234",
  } as unknown as NodeJS.ProcessEnv);
  const executor = Object.create(PaperTrader.prototype) as PaperTrader;
  executor.usdBalance = 12;
  executor.tokenAmount = 34;
  const reset = vi.fn();
  const onPaperReset = vi.fn();

  const deps = {
    config,
    executor,
    positionManager: { reset },
    onPaperReset,
    logger: new Logger("error"),
  } as unknown as CommandDeps;

  return { deps, reset, onPaperReset, executor };
}

describe("PAPER reset command", () => {
  it("resets the ledger and balances before invalidating runtime automation", async () => {
    const { deps, reset, onPaperReset, executor } = resetDeps();
    const order: string[] = [];
    reset.mockImplementation(() => order.push("position"));
    onPaperReset.mockImplementation(() => {
      order.push("runtime");
      expect(executor.usdBalance).toBe(1234);
      expect(executor.tokenAmount).toBe(0);
    });

    await handleLine("reset", deps);

    expect(order).toEqual(["position", "runtime"]);
    expect(reset).toHaveBeenCalledOnce();
    expect(onPaperReset).toHaveBeenCalledOnce();
  });

  it("does not clear runtime state when the position reset is refused", async () => {
    const { deps, onPaperReset, executor } = resetDeps();
    const balanceBefore = executor.usdBalance;
    const positionBefore = executor.tokenAmount;
    const refusal = new Error("pending trade");
    (deps.positionManager.reset as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        throw refusal;
      },
    );

    await expect(handleLine("reset", deps)).rejects.toBe(refusal);
    expect(onPaperReset).not.toHaveBeenCalled();
    expect(executor.usdBalance).toBe(balanceBefore);
    expect(executor.tokenAmount).toBe(positionBefore);
  });
});
