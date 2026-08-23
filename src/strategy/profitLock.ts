const PRICE_EPSILON = 1e-9;

export interface ProfitLockStatus {
  armed: boolean;
  triggered: boolean;
  completedTranches: number;
  activationTranches: number;
  lockGainPercent: number;
  currentGainPercent: number;
  floorPriceUsd: number | undefined;
  /** Positive above the floor, zero on it, negative below it. */
  distanceAboveFloorPercent: number | undefined;
}

/**
 * Locks a minimum gain after a configured number of cascade tranches.
 * For example, (3, 8) arms after the third completed tranche and triggers
 * when the executable sell price reaches entry +8% or lower.
 */
export function checkProfitLock(
  currentPriceUsd: number,
  entryPriceUsd: number,
  completedTranches: number,
  activationTranches = 3,
  lockGainPercent = 8,
): ProfitLockStatus {
  const validEntry = Number.isFinite(entryPriceUsd) && entryPriceUsd > 0;
  const validCurrent = Number.isFinite(currentPriceUsd) && currentPriceUsd > 0;
  const validActivation =
    Number.isFinite(activationTranches) && activationTranches >= 0;
  const validLockGain = Number.isFinite(lockGainPercent);
  const normalizedCompleted = Number.isFinite(completedTranches)
    ? Math.max(0, Math.floor(completedTranches))
    : 0;
  const normalizedActivation = validActivation
    ? Math.floor(activationTranches)
    : 0;

  const armed =
    validEntry &&
    validActivation &&
    validLockGain &&
    normalizedCompleted >= normalizedActivation;
  const floorPriceUsd = armed
    ? entryPriceUsd * (1 + lockGainPercent / 100)
    : undefined;
  const currentGainPercent =
    validEntry && validCurrent
      ? ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100
      : 0;
  const distanceAboveFloorPercent =
    floorPriceUsd !== undefined && validCurrent
      ? ((currentPriceUsd - floorPriceUsd) / floorPriceUsd) * 100
      : undefined;

  return {
    armed,
    triggered:
      armed &&
      validCurrent &&
      floorPriceUsd !== undefined &&
      currentPriceUsd <= floorPriceUsd + PRICE_EPSILON,
    completedTranches: normalizedCompleted,
    activationTranches: normalizedActivation,
    lockGainPercent,
    currentGainPercent,
    floorPriceUsd,
    distanceAboveFloorPercent,
  };
}
