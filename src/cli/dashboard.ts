import type { CostBasisState } from "../strategy/costBasis.js";
import type { PositionEvaluation } from "../strategy/evaluatePosition.js";
import type { PriceSample } from "../market/types.js";
import type { AutoBuyStatus } from "../trading/autoBuyManager.js";
import { colorize, colors, pct, signColor, usd } from "./format.js";

export interface DashboardEvent {
  message: string;
  /** Age is supplied by the caller so formatting stays deterministic in tests. */
  ageMs: number;
}

export interface CascadeDashboardStatus {
  enabled: boolean;
  completedTranches: number;
  /** Omit for an unlimited cascade. */
  maxTranches?: number;
  /** How much of the position captured when the cascade started was sold. */
  soldInitialPercent: number;
  /** Absolute gain from frozen entry required for the next payout. */
  nextGainPercent?: number;
  nextTargetPriceUsd?: number;
  /** Progress between the previous and next linear entry target, from 0 to 100. */
  nextProgressPercent?: number;
  lastExecution?: {
    trancheNumber: number;
    soldInitialPercent: number;
    priceUsd: number;
    /** Total gain from entry at which this tranche was executed, when known. */
    gainFromEntryPercent?: number;
    ageMs?: number;
  };
}

export interface ProfitLockDashboardStatus {
  enabled: boolean;
  armed: boolean;
  completedTranches?: number;
  activationTrancheCount: number;
  floorGainPercent: number;
  floorPriceUsd?: number;
}

export type CrashBuyDashboardPhase =
  | "OFF"
  | "ARMED"
  | "PAUSED"
  | "BUYING"
  | "ACTIVE"
  | "RECENT"
  | "ERROR";

export interface CrashBuyDashboardStatus {
  phase: CrashBuyDashboardPhase;
  /** Closed/partially closed crash-lot P&L accumulated in the current DB. */
  realizedPnlUsd: number;
  /** Realized plus current mark-to-market P&L of the active crash lot. */
  totalPnlUsd?: number;
  /** Short explanation for PAUSED/ERROR, or other useful state detail. */
  detail?: string;
  activeLot?: {
    tokenAmount: number;
    costUsd: number;
    /** Price immediately before the detected crash. */
    preDropPriceUsd: number;
    reboundTargetPriceUsd: number;
    entryPriceUsd?: number;
    pnlUsd?: number;
    pnlPercent?: number;
    stopLossPriceUsd?: number;
    trailingStopPercent?: number;
  };
  /** RECENT can keep this visible after the lot has already been closed. */
  lastEvent?: DashboardEvent;
}

export interface DashboardState {
  tokenSymbol: string;
  mode: "PAPER" | "LIVE";
  sample: PriceSample | undefined;
  changes: { label: string; changePercent: number | undefined }[];
  costBasis: CostBasisState;
  evaluation: PositionEvaluation | undefined;
  solBalance: number;
  tokenBalance: number;
  paperUsdBalance: number | undefined;
  lastMovementMessage: string | undefined;
  /** Persists until the next successful sample - unlike a plain log line,
   *  this survives the once-a-second screen clear so it's actually readable. */
  lastErrorMessage: string | undefined;
  autoBuy: AutoBuyStatus;
  stopLossPercent: number;
  trailingStopPercent: number;
  cascade?: CascadeDashboardStatus;
  profitLock?: ProfitLockDashboardStatus;
  crashBuy?: CrashBuyDashboardStatus;
}

export function formatDashboard(s: DashboardState): string {
  const lines: string[] = [];
  const modeColor = s.mode === "LIVE" ? colors.RED : colors.GREEN;

  lines.push(`${colors.BOLD}${s.tokenSymbol}${colors.RESET}`);
  lines.push(`Price (buy):  ${usd(s.sample?.buyPriceUsd, 8)}`);
  const sellEstimateNote = s.sample?.sellIsEstimated
    ? colorize(" (est., not live-quoted while flat)", colors.DIM)
    : "";
  lines.push(`Price (sell): ${usd(s.sample?.sellPriceUsd, 8)}${sellEstimateNote}`);
  lines.push("");

  if (s.costBasis.tokenAmount > 0 && s.evaluation) {
    const ev = s.evaluation;
    const positionValue = s.sample
      ? s.costBasis.tokenAmount * s.sample.sellPriceUsd
      : undefined;
    lines.push(`Position:       ${s.costBasis.tokenAmount.toLocaleString()} ${s.tokenSymbol}`);
    lines.push(`Position value: ${usd(positionValue)}`);
    lines.push(`Entry value:    ${usd(s.costBasis.totalCostUsd)}`);
    lines.push(`Avg entry:      ${usd(ev.averageEntryPriceUsd, 8)}`);
    lines.push(
      `PnL:            ${colorize(pct(ev.unrealized?.percent), signColor(ev.unrealized?.percent))}`,
    );
    lines.push(
      `PnL USD:        ${colorize(usd(ev.unrealized?.usd), signColor(ev.unrealized?.usd))}`,
    );
    lines.push(`Highest since entry:  ${usd(ev.trailing.state.highestPriceUsd, 8)}`);
    lines.push(`Drawdown from high:   -${ev.trailing.drawdownFromHighPercent.toFixed(2)}%`);
    lines.push(
      `Stop loss (${s.stopLossPercent}%):     ${ev.stopLoss.triggered ? colorize("TRIGGERED", colors.RED) : formatStopLossMargin(ev.stopLoss.lossPercent)}`,
    );
    lines.push(
      `Trailing stop (${ev.trailing.appliedPercent}%): ${ev.trailing.triggered ? colorize("TRIGGERED", colors.RED) : ev.trailing.state.armed ? "armed" : "not armed yet"}`,
    );
  } else {
    lines.push("Position: none");
    lines.push(formatAutoBuyLine(s.autoBuy));
  }

  const strategyStatusLines = [
    ...(s.cascade ? formatCascadeStatusLines(s.cascade) : []),
    ...(s.profitLock ? formatProfitLockStatusLines(s.profitLock) : []),
    ...(s.crashBuy ? formatCrashBuyStatusLines(s.crashBuy, s.tokenSymbol) : []),
  ];
  if (strategyStatusLines.length > 0) {
    lines.push("");
    lines.push(...strategyStatusLines);
  }

  lines.push("");
  lines.push(`Realized PnL: ${colorize(usd(s.costBasis.realizedPnlUsd), signColor(s.costBasis.realizedPnlUsd))}`);
  lines.push("");
  lines.push(`SOL balance:      ${s.solBalance.toFixed(6)}`);
  lines.push(`${s.tokenSymbol} balance: ${s.tokenBalance.toLocaleString()}`);
  if (s.paperUsdBalance !== undefined) {
    lines.push(`Paper USD balance: ${usd(s.paperUsdBalance, 2)}`);
  }

  lines.push("");
  lines.push(
    s.changes
      .map((c) => `${c.label}: ${colorize(pct(c.changePercent), signColor(c.changePercent))}`)
      .join("   "),
  );

  lines.push("");
  lines.push(formatPriceImpactLine(s.sample));

  if (s.lastMovementMessage) {
    lines.push("");
    lines.push(s.lastMovementMessage);
  }

  if (s.lastErrorMessage) {
    lines.push("");
    lines.push(colorize(s.lastErrorMessage, colors.YELLOW));
  }

  lines.push("");
  lines.push(`Mode: ${colorize(s.mode, modeColor)}`);

  return lines.join("\n");
}

/**
 * stopLoss.lossPercent is (entry - current) / entry - positive means an
 * actual loss (distance still to go before the stop triggers), negative
 * means the position is in profit. Labeling a negative number "loss"
 * unconditionally read as "-5.36% loss" while up 5.36% - fix the label to
 * match the sign instead of always saying "loss".
 */
/**
 * priceImpactBuyBps/priceImpactSellBps come straight from a Jupiter quote
 * as raw floats (many decimal places) - unlike `spread`, which was already
 * rounded with .toFixed(2), these used to print in full precision (e.g.
 * "0.44457776396648256%"). Round them the same way for legibility.
 */
export function formatPriceImpactLine(sample: PriceSample | undefined): string {
  const buy = ((sample?.priceImpactBuyBps ?? 0) / 100).toFixed(2);
  const sell = ((sample?.priceImpactSellBps ?? 0) / 100).toFixed(2);
  const spread = ((sample?.spread ?? 0) * 100).toFixed(2);
  return `Price impact: buy ${buy}%  sell ${sell}%  spread ${spread}%`;
}

export function formatStopLossMargin(lossPercent: number): string {
  if (lossPercent <= 0) {
    return `no loss (+${Math.abs(lossPercent).toFixed(2)}% above entry)`;
  }
  return `${lossPercent.toFixed(2)}% loss`;
}

export function formatDashboardAge(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return "unknown age";
  const safeAgeMs = Math.max(0, ageMs);
  if (safeAgeMs < 1_000) return "now";
  if (safeAgeMs < 60_000) return `${Math.floor(safeAgeMs / 1_000)}s ago`;
  if (safeAgeMs < 3_600_000) return `${Math.floor(safeAgeMs / 60_000)}m ago`;
  if (safeAgeMs < 86_400_000) return `${Math.floor(safeAgeMs / 3_600_000)}h ago`;
  return `${Math.floor(safeAgeMs / 86_400_000)}d ago`;
}

export function formatCascadeStatusLines(status: CascadeDashboardStatus): string[] {
  if (!status.enabled) {
    return [`Cascade TP: ${colorize("OFF", colors.DIM)}`];
  }

  const completed = Math.max(0, Math.trunc(status.completedTranches));
  const max = status.maxTranches === undefined
    ? undefined
    : Math.max(0, Math.trunc(status.maxTranches));
  const count = max === undefined ? `${completed}` : `${completed}/${max}`;
  const isComplete = max !== undefined && completed >= max;
  const state = isComplete ? ` ${colorize("COMPLETE", colors.GREEN)}` : "";
  const lines = [
    `Cascade TP:${state} ${count} payouts | sold ${formatPlainPercent(status.soldInitialPercent)} of initial`,
  ];

  if (!isComplete && (
    status.nextGainPercent !== undefined
    || status.nextTargetPriceUsd !== undefined
    || status.nextProgressPercent !== undefined
  )) {
    lines.push(
      `  Next: +${formatPlainPercent(status.nextGainPercent)} @ ${usd(status.nextTargetPriceUsd, 8)} | progress ${formatProgress(status.nextProgressPercent)}`,
    );
  }

  if (status.lastExecution) {
    const execution = status.lastExecution;
    const gain = execution.gainFromEntryPercent === undefined
      ? ""
      : ` (${pct(execution.gainFromEntryPercent)})`;
    const age = execution.ageMs === undefined
      ? ""
      : `, ${formatDashboardAge(execution.ageMs)}`;
    lines.push(
      `  Last: #${Math.max(0, Math.trunc(execution.trancheNumber))} sold ${formatPlainPercent(execution.soldInitialPercent)} of initial @ ${usd(execution.priceUsd, 8)}${gain}${age}`,
    );
  }

  return lines;
}

export function formatProfitLockStatusLines(status: ProfitLockDashboardStatus): string[] {
  if (!status.enabled) {
    return [`Profit lock: ${colorize("OFF", colors.DIM)}`];
  }

  const activation = Math.max(0, Math.trunc(status.activationTrancheCount));
  const completed = Math.max(0, Math.trunc(status.completedTranches ?? 0));
  const phase = status.armed
    ? `${colorize("ARMED", colors.GREEN)} after ${activation} payouts`
    : `${colorize("WAITING", colors.YELLOW)} ${Math.min(completed, activation)}/${activation} payouts`;
  return [
    `Profit lock: ${phase} | floor +${formatPlainPercent(status.floorGainPercent)} @ ${usd(status.floorPriceUsd, 8)}`,
  ];
}

export function formatCrashBuyStatusLines(
  status: CrashBuyDashboardStatus,
  tokenSymbol: string,
): string[] {
  const phaseColor = crashPhaseColor(status.phase);
  const detail = status.detail ? ` - ${status.detail}` : "";
  const lines = [
    `Crash-buy: ${colorize(status.phase, phaseColor)}${detail}`,
  ];

  const activePnlUsd = status.activeLot?.pnlUsd;
  const pnlParts = [
    `realized ${colorize(usd(status.realizedPnlUsd, 2), signColor(status.realizedPnlUsd))}`,
  ];
  if (activePnlUsd !== undefined) {
    pnlParts.push(
      `open ${colorize(usd(activePnlUsd, 2), signColor(activePnlUsd))}`,
    );
  }
  if (status.totalPnlUsd !== undefined && activePnlUsd !== undefined) {
    pnlParts.push(
      `total ${colorize(usd(status.totalPnlUsd, 2), signColor(status.totalPnlUsd))}`,
    );
  }
  lines.push(`  Crash PnL: ${pnlParts.join(" | ")}`);

  if (status.activeLot) {
    const lot = status.activeLot;
    lines.push(
      `  Lot: ${formatTokenAmount(lot.tokenAmount)} ${tokenSymbol} | cost ${usd(lot.costUsd, 2)} | P0 ${usd(lot.preDropPriceUsd, 8)} | rebound ${usd(lot.reboundTargetPriceUsd, 8)}`,
    );
    if (
      lot.entryPriceUsd !== undefined ||
      lot.pnlPercent !== undefined ||
      lot.stopLossPriceUsd !== undefined ||
      lot.trailingStopPercent !== undefined
    ) {
      lines.push(
        `  Risk: entry ${usd(lot.entryPriceUsd, 8)} | PnL ${pct(lot.pnlPercent)} | hard stop ${usd(lot.stopLossPriceUsd, 8)} | trailing ${formatPlainPercent(lot.trailingStopPercent)} (isolated)`,
      );
    }
  }

  if (status.lastEvent) {
    lines.push(
      `  Last: ${status.lastEvent.message} (${formatDashboardAge(status.lastEvent.ageMs)})`,
    );
  }

  return lines;
}

function crashPhaseColor(phase: CrashBuyDashboardPhase): string {
  switch (phase) {
    case "ACTIVE":
    case "RECENT":
      return colors.GREEN;
    case "ARMED":
    case "BUYING":
    case "PAUSED":
      return colors.YELLOW;
    case "ERROR":
      return colors.RED;
    case "OFF":
      return colors.DIM;
  }
}

function formatPlainPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return `${value.toFixed(2)}%`;
}

function formatProgress(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return `${Math.min(100, Math.max(0, value)).toFixed(1)}%`;
}

function formatTokenAmount(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatAutoBuyLine(status: AutoBuyStatus): string {
  if (!status.enabled) return `Auto-buy: ${colorize("OFF", colors.DIM)}`;
  const peakLabel = status.peakProtectionActive
    ? `, ${colorize("PEAK", colors.YELLOW)} +${status.recentRunUpPercent?.toFixed(2)}%`
    : "";
  const volatilityLabel = status.volatilityProtectionActive
    ? `, ${colorize("VOL", colors.YELLOW)} ${status.realizedVolatilityPercent?.toFixed(2)}%`
    : "";
  if (status.watching) {
    return `Auto-buy: ${colorize("WATCHING for rebound", colors.YELLOW)} (dip threshold ${status.effectiveDipPercent.toFixed(2)}%${peakLabel}${volatilityLabel}, low so far: ${usd(status.watchingLowUsd, 8)})`;
  }
  return `Auto-buy: ON, watching for a ${status.effectiveDipPercent.toFixed(2)}% dip${peakLabel}${volatilityLabel} (currently ${pct(status.dropPercentFromHigh ? -status.dropPercentFromHigh : undefined)} from recent high)`;
}

export function renderDashboard(s: DashboardState): void {
  // console.clear() is unreliable on some Windows terminals (it's a no-op
  // or gets ignored there), which makes every refresh stack up under the
  // last one instead of replacing it. This ANSI sequence clears the visible
  // screen AND scrollback and homes the cursor - works everywhere console.clear()
  // does, plus the terminals where it doesn't.
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  console.log(formatDashboard(s));
  console.log(
    "\ncommands: buy <usd>  sell <25|50|100>  panic  reset  status  quit",
  );
}
