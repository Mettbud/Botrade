import type { BotConfig, TakeProfitLevel } from "../config/index.js";
import { checkCascadeTakeProfit } from "./cascadeTakeProfit.js";
import {
  averageEntryPriceUsd,
  unrealizedPnl,
  type CostBasisState,
  type UnrealizedPnl,
} from "./costBasis.js";
import { checkStopLoss, type StopLossCheck } from "./stopLoss.js";
import { checkTakeProfit } from "./takeProfit.js";
import {
  updateTrailingStop,
  type TrailingStopState,
} from "./trailingStop.js";
import { resolveTrailingStopPercent } from "./trailingStopScale.js";

export interface PositionEvaluation {
  averageEntryPriceUsd: number | undefined;
  unrealized: UnrealizedPnl | undefined;
  stopLoss: StopLossCheck;
  trailing: {
    state: TrailingStopState;
    triggered: boolean;
    drawdownFromHighPercent: number;
    /** The trailing-stop % actually applied this tick (may be scaled by peak gain). */
    appliedPercent: number;
  };
  /** TAKE_PROFIT_MODE=entry only - the fixed ladder from entry. Empty in cascade mode. */
  dueTakeProfitLevels: TakeProfitLevel[];
  /** TAKE_PROFIT_MODE=cascade only - undefined in entry mode. */
  cascadeTakeProfit: { sellPercent: number; gainPercent: number } | undefined;
}

/**
 * Pure composition of the individual strategy checks against the current
 * cost basis and executable sell price. No I/O, no confirmation delay -
 * the caller (PositionManager) owns timing/confirmation and side effects.
 */
export function evaluatePosition(
  costBasis: CostBasisState,
  currentSellPriceUsd: number,
  trailingState: TrailingStopState,
  triggeredTakeProfitGains: ReadonlySet<number>,
  config: BotConfig,
  /** TAKE_PROFIT_MODE=cascade only: price the next tranche's +gain% is
   *  measured from - the last cascade sell's price, or entry before the
   *  first one. Ignored in "entry" mode. */
  cascadeReferencePriceUsd?: number,
): PositionEvaluation {
  const entryPrice = averageEntryPriceUsd(costBasis);
  const unrealized = unrealizedPnl(costBasis, currentSellPriceUsd);

  if (entryPrice === undefined || costBasis.tokenAmount <= 0) {
    return {
      averageEntryPriceUsd: undefined,
      unrealized: undefined,
      stopLoss: { triggered: false, lossPercent: 0 },
      trailing: {
        state: trailingState,
        triggered: false,
        drawdownFromHighPercent: 0,
        appliedPercent: config.strategy.trailingStopPercent,
      },
      dueTakeProfitLevels: [],
      cascadeTakeProfit: undefined,
    };
  }

  const stopLoss = checkStopLoss(
    currentSellPriceUsd,
    entryPrice,
    config.strategy.stopLossPercent,
  );

  // The peak (highest price since entry) may move to currentSellPriceUsd
  // this very tick - resolve the applicable trailing-stop % against that
  // prospective peak's gain before evaluating the trigger against it.
  const prospectiveHighUsd = Math.max(trailingState.highestPriceUsd, currentSellPriceUsd);
  const peakGainPercent = ((prospectiveHighUsd - entryPrice) / entryPrice) * 100;
  const appliedTrailingStopPercent = resolveTrailingStopPercent(
    peakGainPercent,
    config.strategy.trailingStopLevels,
    config.strategy.trailingStopPercent,
  );

  const trailingResult = updateTrailingStop(
    trailingState,
    currentSellPriceUsd,
    entryPrice,
    appliedTrailingStopPercent,
    config.strategy.trailingStopActivationPercent,
  );
  const trailing = { ...trailingResult, appliedPercent: appliedTrailingStopPercent };

  let dueTakeProfitLevels: TakeProfitLevel[] = [];
  let cascadeTakeProfit: { sellPercent: number; gainPercent: number } | undefined;

  if (config.strategy.takeProfitMode === "cascade") {
    const reference = cascadeReferencePriceUsd ?? entryPrice;
    const check = checkCascadeTakeProfit(
      currentSellPriceUsd,
      reference,
      config.strategy.cascadeTakeProfitPercent,
      config.strategy.cascadeTakeProfitSellPercent,
    );
    if (check.shouldSell) {
      cascadeTakeProfit = { sellPercent: check.sellPercent, gainPercent: check.gainPercent };
    }
  } else {
    dueTakeProfitLevels = unrealized
      ? checkTakeProfit(
          unrealized.percent,
          config.strategy.takeProfitLevels,
          triggeredTakeProfitGains,
        )
      : [];
  }

  return {
    averageEntryPriceUsd: entryPrice,
    unrealized,
    stopLoss,
    trailing,
    dueTakeProfitLevels,
    cascadeTakeProfit,
  };
}
