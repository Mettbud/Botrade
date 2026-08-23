import { averageEntryPriceUsd, type CostBasisState } from "../strategy/costBasis.js";
import {
  applyTradeToBooks,
  EMPTY_POSITION_BOOKS,
  type PositionBooksState,
} from "./positionBooks.js";
import type { Trade } from "./types.js";

const POSITION_EPSILON = 1e-12;

export interface CascadeCycle {
  /** Frozen weighted entry used for every linear +X% target. */
  entryPriceUsd: number;
  /** Regular tokens acquired before the first cascade payout. */
  initialTokenAmount: number;
  completedTranches: number;
  cascadeSoldTokenAmount: number;
}

export interface CascadeExecution {
  timestampMs: number;
  trancheNumber: number;
  tranchesExecuted: number;
  tokenAmount: number;
  /** Frozen opening amount, retained so dashboard percentages use actual fills. */
  initialTokenAmount: number;
  /** Actual cumulative cascade tokens sold, including partial fills. */
  cumulativeSoldTokenAmount: number;
  priceUsd: number;
  gainFromEntryPercent: number;
}

export interface CascadeTrackerState {
  active: CascadeCycle | undefined;
  lastExecution: CascadeExecution | undefined;
  /** Old TAKE_PROFIT rows do not say how many new linear thresholds fired. */
  legacyTakeProfitInActiveCycle: boolean;
}

export const EMPTY_CASCADE_TRACKER: CascadeTrackerState = {
  active: undefined,
  lastExecution: undefined,
  legacyTakeProfitInActiveCycle: false,
};

/** Reconstructs a cascade cycle and its exact completed count after restart. */
export function replayCascadeTracker(
  trades: readonly Trade[],
): CascadeTrackerState {
  let books: PositionBooksState = EMPTY_POSITION_BOOKS;
  let tracker = EMPTY_CASCADE_TRACKER;

  for (const trade of trades) {
    const before = books.regular;
    books = applyTradeToBooks(books, trade);
    tracker = updateCascadeTracker(tracker, trade, before, books.regular);
  }
  return tracker;
}

/** Purely updates cycle metadata after an already-successful/persistable trade. */
export function updateCascadeTracker(
  state: CascadeTrackerState,
  trade: Trade,
  regularBefore: CostBasisState,
  regularAfter: CostBasisState,
): CascadeTrackerState {
  let active = state.active;
  let lastExecution = state.lastExecution;
  let legacyTakeProfitInActiveCycle = state.legacyTakeProfitInActiveCycle;

  const regularBought = Math.max(
    0,
    regularAfter.tokenAmount - regularBefore.tokenAmount,
  );
  if (trade.side === "BUY" && regularBought > POSITION_EPSILON) {
    const entryPriceUsd = averageEntryPriceUsd(regularAfter);
    if (regularBefore.tokenAmount <= POSITION_EPSILON || !active) {
      if (entryPriceUsd !== undefined) {
        active = {
          entryPriceUsd,
          initialTokenAmount: regularBought,
          completedTranches: 0,
          cascadeSoldTokenAmount: 0,
        };
        lastExecution = undefined;
        legacyTakeProfitInActiveCycle = false;
      }
    } else if (active.completedTranches === 0 && entryPriceUsd !== undefined) {
      // Averaging before the first payout joins the opening position. Once a
      // payout happened, the entry/initial size remain frozen and later buys
      // are deliberately not allowed to rewrite already-paid thresholds.
      active = {
        ...active,
        entryPriceUsd,
        initialTokenAmount: active.initialTokenAmount + regularBought,
      };
    }
  }

  const regularSold = Math.max(
    0,
    regularBefore.tokenAmount - regularAfter.tokenAmount,
  );
  if (
    trade.side === "SELL" &&
    trade.reason === "CASCADE_TAKE_PROFIT" &&
    regularSold > POSITION_EPSILON
  ) {
    const metadataEntry = validPositive(trade.cascadeEntryPriceUsd);
    const metadataInitial = validPositive(trade.cascadeInitialTokenAmount);
    if (!active && metadataEntry !== undefined && metadataInitial !== undefined) {
      active = {
        entryPriceUsd: metadataEntry,
        initialTokenAmount: metadataInitial,
        completedTranches: 0,
        cascadeSoldTokenAmount: 0,
      };
    }

    if (active) {
      const tranchesExecuted = nonNegativeExecutionCount(
        trade.cascadeTranchesExecuted,
      );
      const entryPriceUsd = metadataEntry ?? active.entryPriceUsd;
      const initialTokenAmount = metadataInitial ?? active.initialTokenAmount;
      const completedTranches = active.completedTranches + tranchesExecuted;
      const priceUsd = trade.usdEstimate / trade.tokenAmount;
      const cumulativeSoldTokenAmount =
        active.cascadeSoldTokenAmount + regularSold;
      active = {
        entryPriceUsd,
        initialTokenAmount,
        completedTranches,
        cascadeSoldTokenAmount: cumulativeSoldTokenAmount,
      };
      lastExecution = {
        timestampMs: trade.timestampMs,
        trancheNumber: completedTranches,
        tranchesExecuted,
        tokenAmount: regularSold,
        initialTokenAmount,
        cumulativeSoldTokenAmount,
        priceUsd,
        gainFromEntryPercent:
          ((priceUsd - entryPriceUsd) / entryPriceUsd) * 100,
      };
    }
  } else if (
    trade.side === "SELL" &&
    trade.reason === "TAKE_PROFIT" &&
    regularSold > POSITION_EPSILON &&
    active
  ) {
    // The old implementation persisted every cascade payout as TAKE_PROFIT
    // without cycle/count metadata. Never guess and risk paying it twice.
    legacyTakeProfitInActiveCycle = true;
  }

  if (regularAfter.tokenAmount <= POSITION_EPSILON) {
    active = undefined;
    legacyTakeProfitInActiveCycle = false;
  }

  return { active, lastExecution, legacyTakeProfitInActiveCycle };
}

function nonNegativeExecutionCount(value: number | undefined): number {
  // Rows written before zero-count partial fills were supported have no
  // metadata. Preserve their historical one-tranche meaning.
  if (value === undefined) return 1;
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function validPositive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
