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

export interface PositionEvaluation {
  averageEntryPriceUsd: number | undefined;
  unrealized: UnrealizedPnl | undefined;
  stopLoss: StopLossCheck;
  trailing: {
    state: TrailingStopState;
    triggered: boolean;
    drawdownFromHighPercent: number;
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
      trailing: { state: trailingState, triggered: false, drawdownFromHighPercent: 0 },
      dueTakeProfitLevels: [],
    };
  }

  const stopLoss = checkStopLoss(
    currentSellPriceUsd,
    entryPrice,
    config.strategy.stopLossPercent,
  );

  const trailing = updateTrailingStop(
    trailingState,
    currentSellPriceUsd,
    entryPrice,
    config.strategy.trailingStopPercent,
    config.strategy.trailingStopActivationPercent,
  );

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
