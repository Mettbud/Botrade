export interface AutoBuyDipThresholdInput {
  baseDipPercent: number;
  peakProtectionEnabled: boolean;
  recentRunUpPercent: number;
  peakRunUpPercent: number;
  peakDipPercent: number;
  volatilityProtectionEnabled: boolean;
  realizedVolatilityPercent: number;
  volatilityMultiplier: number;
  volatilityMaxDipPercent: number;
}

export interface AutoBuyDipThreshold {
  effectiveDipPercent: number;
  peakProtectionActive: boolean;
  volatilityProtectionActive: boolean;
  volatilityDipPercent: number;
}

/**
 * Chooses the dip required before auto-buy starts watching for a rebound.
 * A recent pump switches to the wider peak threshold, but can never make a
 * user-configured base threshold less conservative.
 */
export function resolveAutoBuyDipThreshold(
  input: AutoBuyDipThresholdInput,
): AutoBuyDipThreshold {
  const peakProtectionActive =
    input.peakProtectionEnabled &&
    input.recentRunUpPercent >= input.peakRunUpPercent;
  const peakThreshold = peakProtectionActive ? input.peakDipPercent : 0;
  const volatilityDipPercent = input.volatilityProtectionEnabled
    ? Math.min(
        input.realizedVolatilityPercent * input.volatilityMultiplier,
        input.volatilityMaxDipPercent,
      )
    : 0;
  const volatilityProtectionActive =
    input.volatilityProtectionEnabled &&
    volatilityDipPercent > input.baseDipPercent;

  return {
    peakProtectionActive,
    volatilityProtectionActive,
    volatilityDipPercent,
    effectiveDipPercent: Math.max(
      input.baseDipPercent,
      peakThreshold,
      volatilityDipPercent,
    ),
  };
}
