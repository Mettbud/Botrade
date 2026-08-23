const PRICE_EPSILON = 1e-9;

export interface CascadeTakeProfitInput {
  /** Current executable sell price. */
  currentPriceUsd: number;
  /** Frozen entry price for the regular position; averaging must not move it. */
  entryPriceUsd: number;
  /** Number of cascade tranches that were actually completed. */
  completedTranches: number;
  /** Linear distance between targets, e.g. 5 means +5%, +10%, +15%... */
  gainStepPercent: number;
  /** Size of one tranche as a percentage of the initial regular position. */
  sellPercentOfInitial: number;
  /** Frozen initial token amount of the regular position. */
  initialTokenAmount: number;
  /** Tokens already sold specifically by this cascade, including partial fills. */
  cascadeSoldTokenAmount?: number;
  /** Tokens from the regular position that are still available to sell. */
  remainingTokenAmount: number;
}

export interface CascadeTakeProfitStatus {
  shouldSell: boolean;
  /** Kept for the existing caller; always means % of the initial position. */
  sellPercent: number;
  /** Current gain from the frozen entry price. */
  gainPercent: number;
  completedTranches: number;
  maxTranches: number;
  complete: boolean;
  soldPercentOfInitial: number;
  /** One-based tranche number. Undefined after the final tranche. */
  nextTrancheNumber: number | undefined;
  /** Absolute gain from entry required for the next tranche. */
  nextGainPercent: number | undefined;
  nextTargetPriceUsd: number | undefined;
  /** Gain still needed to reach the next target, never negative. */
  gainRemainingPercent: number | undefined;
  /** Progress from the previous target to the next target, clamped to 0..100. */
  progressPercent: number;
  /** Number of targets currently passed but not yet recorded as completed. */
  tranchesDue: number;
  /** Exact token amount of one tranche before the remaining-position cap. */
  singleTrancheTokenAmount: number;
  /** Total amount due now, capped to the remaining regular position. */
  sellTokenAmount: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedCompletedTranches(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp(Math.floor(value), 0, maximum);
}

/**
 * Evaluates the complete linear cascade state without mutating it.
 *
 * Targets are always calculated from the frozen entry price. With a 5%
 * step they are +5%, +10%, +15%...; they never compound from a previous
 * sell price. A skipped price interval may make multiple tranches due in one
 * evaluation, allowing the caller to execute a single rate-limit-friendly
 * sell and record all passed targets.
 */
export function evaluateCascadeTakeProfit(
  input: CascadeTakeProfitInput,
): CascadeTakeProfitStatus {
  const validEntry =
    Number.isFinite(input.entryPriceUsd) && input.entryPriceUsd > 0;
  const validStep =
    Number.isFinite(input.gainStepPercent) && input.gainStepPercent > 0;
  const validSellPercent =
    Number.isFinite(input.sellPercentOfInitial) &&
    input.sellPercentOfInitial > 0 &&
    input.sellPercentOfInitial <= 100;

  const maxTranches = validSellPercent
    ? Math.ceil(100 / input.sellPercentOfInitial)
    : 0;
  const completedTranches = normalizedCompletedTranches(
    input.completedTranches,
    maxTranches,
  );
  const complete = maxTranches > 0 && completedTranches >= maxTranches;

  const gainPercent =
    validEntry && Number.isFinite(input.currentPriceUsd)
      ? ((input.currentPriceUsd - input.entryPriceUsd) / input.entryPriceUsd) *
        100
      : 0;

  const hasNextTarget = validEntry && validStep && !complete && maxTranches > 0;
  const nextTrancheNumber = hasNextTarget ? completedTranches + 1 : undefined;
  const nextGainPercent = hasNextTarget
    ? (completedTranches + 1) * input.gainStepPercent
    : undefined;
  const nextTargetPriceUsd =
    nextGainPercent === undefined
      ? undefined
      : input.entryPriceUsd * (1 + nextGainPercent / 100);
  const gainRemainingPercent =
    nextGainPercent === undefined
      ? undefined
      : Math.max(0, nextGainPercent - gainPercent);

  const previousGainPercent = completedTranches * input.gainStepPercent;
  const progressPercent = complete
    ? 100
    : hasNextTarget
      ? clamp(
          ((gainPercent - previousGainPercent) / input.gainStepPercent) * 100,
          0,
          100,
        )
      : 0;

  const targetsReached =
    validEntry && validStep && Number.isFinite(input.currentPriceUsd)
      ? clamp(
          Math.floor((gainPercent + PRICE_EPSILON) / input.gainStepPercent),
          0,
          maxTranches,
        )
      : 0;
  const tranchesDue = Math.max(0, targetsReached - completedTranches);

  const initialTokenAmount =
    Number.isFinite(input.initialTokenAmount) && input.initialTokenAmount > 0
      ? input.initialTokenAmount
      : 0;
  const remainingTokenAmount =
    Number.isFinite(input.remainingTokenAmount) &&
    input.remainingTokenAmount > 0
      ? input.remainingTokenAmount
      : 0;
  const singleTrancheTokenAmount = validSellPercent
    ? initialTokenAmount * (input.sellPercentOfInitial / 100)
    : 0;
  const fallbackSoldTokenAmount =
    singleTrancheTokenAmount * completedTranches;
  const cascadeSoldTokenAmount =
    input.cascadeSoldTokenAmount !== undefined &&
    Number.isFinite(input.cascadeSoldTokenAmount) &&
    input.cascadeSoldTokenAmount >= 0
      ? Math.min(initialTokenAmount, input.cascadeSoldTokenAmount)
      : fallbackSoldTokenAmount;
  const targetCascadeSoldTokenAmount =
    Math.min(initialTokenAmount, singleTrancheTokenAmount * targetsReached);
  const sellTokenAmount = Math.min(
    remainingTokenAmount,
    Math.max(0, targetCascadeSoldTokenAmount - cascadeSoldTokenAmount),
  );

  return {
    shouldSell: tranchesDue > 0 && sellTokenAmount > 0,
    sellPercent: validSellPercent ? input.sellPercentOfInitial : 0,
    gainPercent,
    completedTranches,
    maxTranches,
    complete,
    soldPercentOfInitial:
      initialTokenAmount > 0
        ? Math.min(100, (cascadeSoldTokenAmount / initialTokenAmount) * 100)
        : 0,
    nextTrancheNumber,
    nextGainPercent,
    nextTargetPriceUsd,
    gainRemainingPercent,
    progressPercent,
    tranchesDue,
    singleTrancheTokenAmount,
    sellTokenAmount,
  };
}

/**
 * Compatibility wrapper for the existing evaluator. New integration should
 * call `evaluateCascadeTakeProfit` so it can provide the frozen initial and
 * remaining regular-position amounts and use `sellTokenAmount` directly.
 */
export function checkCascadeTakeProfit(
  currentPriceUsd: number,
  entryPriceUsd: number,
  gainStepPercent: number,
  sellPercentOfInitial: number,
  completedTranches = 0,
): CascadeTakeProfitStatus {
  return evaluateCascadeTakeProfit({
    currentPriceUsd,
    entryPriceUsd,
    completedTranches,
    gainStepPercent,
    sellPercentOfInitial,
    initialTokenAmount: 1,
    remainingTokenAmount: 1,
  });
}
