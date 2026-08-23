import type { BotConfig, TakeProfitLevel } from "../config/index.js";
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
  dueTakeProfitLevels: TakeProfitLevel[];
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

  const dueTakeProfitLevels = unrealized
    ? checkTakeProfit(
        unrealized.percent,
        config.strategy.takeProfitLevels,
        triggeredTakeProfitGains,
      )
    : [];

  return {
    averageEntryPriceUsd: entryPrice,
    unrealized,
    stopLoss,
    trailing,
    dueTakeProfitLevels,
  };
}
