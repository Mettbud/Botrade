import type { CostBasisState } from "../strategy/costBasis.js";
import type { PositionEvaluation } from "../strategy/evaluatePosition.js";
import type { PriceSample } from "../market/types.js";
import type { AutoBuyStatus } from "../trading/autoBuyManager.js";
import { colorize, colors, pct, signColor, usd } from "./format.js";

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
      `Stop loss (${s.stopLossPercent}%):     ${ev.stopLoss.triggered ? colorize("TRIGGERED", colors.RED) : `${ev.stopLoss.lossPercent.toFixed(2)}% loss`}`,
    );
    lines.push(
      `Trailing stop (${s.trailingStopPercent}%): ${ev.trailing.triggered ? colorize("TRIGGERED", colors.RED) : ev.trailing.state.armed ? "armed" : "not armed yet"}`,
    );
  } else {
    lines.push("Position: none");
    lines.push(formatAutoBuyLine(s.autoBuy));
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
  lines.push(
    `Price impact: buy ${(s.sample?.priceImpactBuyBps ?? 0) / 100}%  sell ${(s.sample?.priceImpactSellBps ?? 0) / 100}%  spread ${((s.sample?.spread ?? 0) * 100).toFixed(2)}%`,
  );

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

function formatAutoBuyLine(status: AutoBuyStatus): string {
  if (!status.enabled) return `Auto-buy: ${colorize("OFF", colors.DIM)}`;
  if (status.watching) {
    return `Auto-buy: ${colorize("WATCHING for rebound", colors.YELLOW)} (low so far: ${usd(status.watchingLowUsd, 8)})`;
  }
  return `Auto-buy: ON, watching for a dip (currently ${pct(status.dropPercentFromHigh ? -status.dropPercentFromHigh : undefined)} from recent high)`;
}

export function renderDashboard(s: DashboardState): void {
  console.clear();
  console.log(formatDashboard(s));
  console.log(
    "\ncommands: buy <usd>  sell <25|50|100>  panic  status  quit",
  );
}
