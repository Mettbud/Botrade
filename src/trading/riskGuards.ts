export interface RiskCheck {
  allowed: boolean;
  reason?: string;
}

/** A single buy can never exceed MAX_TRADE_USD, on paper or live. */
export function checkMaxTradeSize(
  usdAmount: number,
  maxTradeUsd: number,
): RiskCheck {
  if (usdAmount > maxTradeUsd) {
    return {
      allowed: false,
      reason: `Trade size $${usdAmount.toFixed(4)} exceeds MAX_TRADE_USD=$${maxTradeUsd}`,
    };
  }
  return { allowed: true };
}

/** A buy can never spend into the untouchable SOL reserve. */
export function checkSolReserve(
  currentSolBalance: number,
  solAmountToSpend: number,
  minSolReserve: number,
): RiskCheck {
  const remaining = currentSolBalance - solAmountToSpend;
  if (remaining < minSolReserve) {
    return {
      allowed: false,
      reason:
        `Spending ${solAmountToSpend.toFixed(6)} SOL would leave ${remaining.toFixed(6)} SOL, ` +
        `below MIN_SOL_RESERVE=${minSolReserve} SOL`,
    };
  }
  return { allowed: true };
}

export function checkSlippage(
  quoteSlippageBps: number,
  maxSlippageBps: number,
): RiskCheck {
  if (quoteSlippageBps > maxSlippageBps) {
    return {
      allowed: false,
      reason: `Slippage ${quoteSlippageBps}bps exceeds MAX_SLIPPAGE_BPS=${maxSlippageBps}bps`,
    };
  }
  return { allowed: true };
}

export function checkPriceImpact(
  priceImpactBps: number,
  maxPriceImpactBps: number,
): RiskCheck {
  if (priceImpactBps > maxPriceImpactBps) {
    return {
      allowed: false,
      reason: `TRADE BLOCKED – price impact too high (${(priceImpactBps / 100).toFixed(2)}% > ${(maxPriceImpactBps / 100).toFixed(2)}%)`,
    };
  }
  return { allowed: true };
}

/** Runs every applicable guard and returns the first failure, if any. */
export function evaluateTradeRisk(checks: RiskCheck[]): RiskCheck {
  return checks.find((c) => !c.allowed) ?? { allowed: true };
}
