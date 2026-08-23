import {
  applyTrade,
  EMPTY_COST_BASIS,
  type CostBasisState,
} from "../strategy/costBasis.js";
import type { Trade } from "./types.js";

const POSITION_EPSILON = 1e-12;

export interface CrashLotState extends CostBasisState {
  /** Stable ID written on the CRASH_BUY and every dedicated exit. */
  crashLotId: string;
  /** Original size is retained after the lot closes for audit/dashboard use. */
  initialTokenAmount: number;
  initialCostUsd: number;
  openedAtMs: number;
  preDropPriceUsd: number;
  closedAtMs?: number;
}

export interface PositionBookWarnings {
  /** Old CRASH_BUY rows cannot safely be guessed into a dedicated lot. */
  legacyCrashBuyWithoutMetadata: boolean;
  /** An exit did not name an existing lot and required aggregate reconciliation. */
  unroutableCrashBuyExit: boolean;
  /** A book-specific sell asked for more tokens than that book contained. */
  sellAmountExceededTargetBook: boolean;
}

export interface PositionBooksState {
  regular: CostBasisState;
  /** Includes closed lots so their realized P&L and original size survive replay. */
  crashLots: readonly CrashLotState[];
  warnings: PositionBookWarnings;
}

export const EMPTY_POSITION_BOOKS: PositionBooksState = {
  regular: EMPTY_COST_BASIS,
  crashLots: [],
  warnings: {
    legacyCrashBuyWithoutMetadata: false,
    unroutableCrashBuyExit: false,
    sellAmountExceededTargetBook: false,
  },
};

const REGULAR_ONLY_SELL_REASONS = new Set<Trade["reason"]>([
  "TAKE_PROFIT",
  "CASCADE_TAKE_PROFIT",
  "PROFIT_LOCK",
  "REGULAR_STOP_LOSS",
  "REGULAR_TRAILING_STOP",
]);

const CRASH_ONLY_SELL_REASONS = new Set<Trade["reason"]>([
  "CRASH_BUY_EXIT",
  "CRASH_STOP_LOSS",
  "CRASH_TRAILING_STOP",
]);

const GLOBAL_SELL_REASONS = new Set<Trade["reason"]>([
  "STOP_LOSS",
  "TRAILING_STOP",
  "PANIC_EXIT",
]);

/** Rebuilds independent regular/crash cost bases in the supplied trade order. */
export function replayPositionBooks(trades: readonly Trade[]): PositionBooksState {
  return trades.reduce(applyTradeToBooks, EMPTY_POSITION_BOOKS);
}

/**
 * Purely folds one trade into the appropriate book(s).
 *
 * An old crash buy without both pieces of metadata joins the regular book.
 * An exit without a known lot ID is reconciled regular-first so a confirmed
 * wallet sale never disappears, and a warning pauses exact-lot automation.
 */
export function applyTradeToBooks(
  state: PositionBooksState,
  trade: Trade,
): PositionBooksState {
  if (trade.side === "BUY") {
    return applyBuy(state, trade);
  }

  if (CRASH_ONLY_SELL_REASONS.has(trade.reason)) {
    return applyCrashExit(state, trade);
  }

  if (REGULAR_ONLY_SELL_REASONS.has(trade.reason)) {
    return applyRegularOnlySell(state, trade);
  }

  if (GLOBAL_SELL_REASONS.has(trade.reason)) {
    return applyGlobalSell(state, trade);
  }

  // MANUAL is explicitly regular-first. Treat an unknown/future sell reason
  // the same way: it cannot accidentally prefer a crash lot over regular funds.
  return applyRegularFirstSell(state, trade);
}

/** Aggregated wallet view while retaining independent realized P&L internally. */
export function aggregateBooks(state: PositionBooksState): CostBasisState {
  return state.crashLots.reduce<CostBasisState>(
    (aggregate, lot) => ({
      tokenAmount: aggregate.tokenAmount + lot.tokenAmount,
      totalCostUsd: aggregate.totalCostUsd + lot.totalCostUsd,
      realizedPnlUsd: aggregate.realizedPnlUsd + lot.realizedPnlUsd,
    }),
    { ...state.regular },
  );
}

/**
 * Returns an active lot only when it is unambiguous. Passing an ID always does
 * an exact lookup; without one, two simultaneous lots deliberately yield
 * `undefined` instead of guessing which amount a crash exit may sell.
 */
export function getActiveCrashLot(
  state: PositionBooksState,
  crashLotId?: string,
): CrashLotState | undefined {
  if (crashLotId !== undefined) {
    return state.crashLots.find(
      (lot) => lot.crashLotId === crashLotId && isOpen(lot),
    );
  }

  const active = state.crashLots.filter(isOpen);
  return active.length === 1 ? active[0] : undefined;
}

function applyBuy(state: PositionBooksState, trade: Trade): PositionBooksState {
  if (trade.reason !== "CRASH_BUY") {
    return {
      ...state,
      regular: applyTrade(state.regular, trade),
    };
  }

  const crashLotId = validCrashLotId(trade.crashLotId);
  const preDropPriceUsd = validPositive(trade.crashPreDropPriceUsd);
  if (crashLotId === undefined || preDropPriceUsd === undefined) {
    return {
      ...state,
      regular: applyTrade(state.regular, trade),
      warnings: {
        ...state.warnings,
        legacyCrashBuyWithoutMetadata: true,
      },
    };
  }

  const existingIndex = state.crashLots.findIndex(
    (lot) => lot.crashLotId === crashLotId,
  );
  if (existingIndex < 0) {
    const costBasis = applyTrade(EMPTY_COST_BASIS, trade);
    const lot: CrashLotState = {
      crashLotId,
      ...costBasis,
      initialTokenAmount: nonNegative(trade.tokenAmount),
      initialCostUsd: nonNegative(trade.usdEstimate),
      openedAtMs: trade.timestampMs,
      preDropPriceUsd,
    };
    return { ...state, crashLots: [...state.crashLots, lot] };
  }

  // Multiple fills sharing one stable ID form one logical crash lot.
  const existing = state.crashLots[existingIndex]!;
  const updatedBasis = applyTrade(existing, trade);
  const updated: CrashLotState = {
    ...existing,
    ...updatedBasis,
    initialTokenAmount:
      existing.initialTokenAmount + nonNegative(trade.tokenAmount),
    initialCostUsd: existing.initialCostUsd + nonNegative(trade.usdEstimate),
    closedAtMs: undefined,
  };
  return replaceLot(state, existingIndex, updated);
}

function applyCrashExit(
  state: PositionBooksState,
  trade: Trade,
): PositionBooksState {
  const crashLotId = validCrashLotId(trade.crashLotId);
  const lotIndex =
    crashLotId === undefined
      ? -1
      : state.crashLots.findIndex(
          (lot) => lot.crashLotId === crashLotId && isOpen(lot),
        );
  if (lotIndex < 0) {
    // A confirmed sell must never disappear from the aggregate ledger. Old
    // versions wrote CRASH_BUY/CRASH_BUY_EXIT without lot IDs, so their buy is
    // intentionally kept in the regular book and the matching exit must use
    // the same regular-first fallback. An unknown ID is handled identically:
    // attribution is uncertain, but the wallet really did lose the tokens.
    const fallback = applyRegularFirstSell(state, trade);
    return {
      ...fallback,
      warnings: {
        ...fallback.warnings,
        unroutableCrashBuyExit: true,
      },
    };
  }

  const lot = state.crashLots[lotIndex]!;
  const requested = nonNegative(trade.tokenAmount);
  const allocated = Math.min(requested, lot.tokenAmount);
  const updated = applySellToLot(lot, trade, allocated);
  return replaceLot(
    {
      ...state,
      warnings:
        requested > lot.tokenAmount + POSITION_EPSILON
          ? { ...state.warnings, sellAmountExceededTargetBook: true }
          : state.warnings,
    },
    lotIndex,
    updated,
  );
}

function applyRegularOnlySell(
  state: PositionBooksState,
  trade: Trade,
): PositionBooksState {
  const requested = nonNegative(trade.tokenAmount);
  const allocated = Math.min(requested, state.regular.tokenAmount);
  return {
    ...state,
    regular: applyAllocatedSell(state.regular, trade, allocated),
    warnings:
      requested > state.regular.tokenAmount + POSITION_EPSILON
        ? { ...state.warnings, sellAmountExceededTargetBook: true }
        : state.warnings,
  };
}

function applyGlobalSell(
  state: PositionBooksState,
  trade: Trade,
): PositionBooksState {
  const requested = nonNegative(trade.tokenAmount);
  const aggregate = aggregateBooks(state);
  const allocatedTotal = Math.min(requested, aggregate.tokenAmount);
  if (allocatedTotal <= POSITION_EPSILON || aggregate.tokenAmount <= POSITION_EPSILON) {
    return state;
  }

  const regularAllocation =
    allocatedTotal * (state.regular.tokenAmount / aggregate.tokenAmount);
  const regular = applyAllocatedSell(state.regular, trade, regularAllocation);
  const crashLots = state.crashLots.map((lot) => {
    const allocation = allocatedTotal * (lot.tokenAmount / aggregate.tokenAmount);
    return applySellToLot(lot, trade, allocation);
  });

  return {
    ...state,
    regular,
    crashLots,
    warnings:
      requested > aggregate.tokenAmount + POSITION_EPSILON
        ? { ...state.warnings, sellAmountExceededTargetBook: true }
        : state.warnings,
  };
}

function applyRegularFirstSell(
  state: PositionBooksState,
  trade: Trade,
): PositionBooksState {
  const requested = nonNegative(trade.tokenAmount);
  let remaining = requested;

  const regularAllocation = Math.min(remaining, state.regular.tokenAmount);
  remaining -= regularAllocation;
  const regular = applyAllocatedSell(state.regular, trade, regularAllocation);

  const crashLots = state.crashLots.map((lot) => {
    const allocation = Math.min(remaining, lot.tokenAmount);
    remaining -= allocation;
    return applySellToLot(lot, trade, allocation);
  });

  return {
    ...state,
    regular,
    crashLots,
    warnings:
      remaining > POSITION_EPSILON
        ? { ...state.warnings, sellAmountExceededTargetBook: true }
        : state.warnings,
  };
}

function applyAllocatedSell(
  book: CostBasisState,
  source: Trade,
  tokenAmount: number,
): CostBasisState {
  if (tokenAmount <= POSITION_EPSILON) return book;
  return applyTrade(book, allocatedSell(source, tokenAmount));
}

function applySellToLot(
  lot: CrashLotState,
  source: Trade,
  tokenAmount: number,
): CrashLotState {
  if (tokenAmount <= POSITION_EPSILON) return lot;
  const basis = applyAllocatedSell(lot, source, tokenAmount);
  return {
    ...lot,
    ...basis,
    closedAtMs:
      basis.tokenAmount <= POSITION_EPSILON
        ? (lot.closedAtMs ?? source.timestampMs)
        : undefined,
  };
}

/** Allocates proceeds by token count, never by the books' different costs. */
function allocatedSell(source: Trade, tokenAmount: number): Trade {
  const requested = nonNegative(source.tokenAmount);
  const proceedsShare = requested > POSITION_EPSILON ? tokenAmount / requested : 0;
  return {
    ...source,
    tokenAmount,
    usdEstimate: nonNegative(source.usdEstimate) * proceedsShare,
  };
}

function replaceLot(
  state: PositionBooksState,
  index: number,
  lot: CrashLotState,
): PositionBooksState {
  const crashLots = [...state.crashLots];
  crashLots[index] = lot;
  return { ...state, crashLots };
}

function isOpen(lot: CrashLotState): boolean {
  return lot.tokenAmount > POSITION_EPSILON;
}

function validCrashLotId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function validPositive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
