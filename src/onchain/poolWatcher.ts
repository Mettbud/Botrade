import { EventEmitter } from "node:events";
import type { Connection, PublicKey } from "@solana/web3.js";
import { JumpDetector } from "./jumpDetector.js";
import { priceFromReserves } from "./poolPrice.js";
import { decodeTokenAccountAmount } from "./splTokenAccount.js";

export interface WatchedPool {
  label: string;
  baseVault: PublicKey;
  quoteVault: PublicKey;
}

export interface PoolJumpEvent {
  poolLabel: string;
  changePercent: number;
  /** Current quote-token-per-base-token reserve price (WSOL per CYBERLEEK here). */
  priceInQuote: number;
  /** Reserve price immediately before the detected move, reconstructed from change%. */
  preChangePriceInQuote: number | undefined;
}

/**
 * Subscribes to the two reserve (vault) accounts of each configured pool
 * via Solana account-change notifications, and flags a fast price jump per
 * pool. In normal mode this only schedules a price check. Direct crash mode
 * may use it as a trigger, but its Raydium quote must still pass a pinned-pool
 * and hard-maximum-price check before any transaction can be signed. Untestable
 * against real Solana from a sandboxed environment; kept intentionally
 * small and built on the separately unit-tested pieces (JumpDetector,
 * priceFromReserves, decodeTokenAccountAmount).
 */
export class PoolWatcher extends EventEmitter {
  private readonly subscriptionIds: number[] = [];
  private readonly reserves = new Map<string, { base?: bigint; quote?: bigint }>();
  private readonly detectors = new Map<string, JumpDetector>();

  constructor(
    private readonly connection: Connection,
    private readonly pools: WatchedPool[],
    private readonly baseDecimals: number,
    private readonly quoteDecimals: number,
    jumpWindowMs: number,
    jumpThresholdPercent: number,
  ) {
    super();
    for (const pool of pools) {
      this.detectors.set(pool.label, new JumpDetector(jumpWindowMs, jumpThresholdPercent));
      this.reserves.set(pool.label, {});
    }
  }

  start(): void {
    for (const pool of this.pools) {
      const baseSub = this.connection.onAccountChange(pool.baseVault, (info) =>
        this.onVaultUpdate(pool, "base", info.data),
      );
      const quoteSub = this.connection.onAccountChange(pool.quoteVault, (info) =>
        this.onVaultUpdate(pool, "quote", info.data),
      );
      this.subscriptionIds.push(baseSub, quoteSub);
    }
  }

  async stop(): Promise<void> {
    await Promise.all(
      this.subscriptionIds.map((id) =>
        this.connection.removeAccountChangeListener(id).catch(() => undefined),
      ),
    );
    this.subscriptionIds.length = 0;
  }

  private onVaultUpdate(pool: WatchedPool, side: "base" | "quote", data: Buffer): void {
    let amount: bigint;
    try {
      amount = decodeTokenAccountAmount(data);
    } catch {
      return; // malformed/unexpected account data - skip this update, don't crash the watcher
    }

    const entry = this.reserves.get(pool.label)!;
    entry[side] = amount;
    if (entry.base === undefined || entry.quote === undefined) return; // need both sides first

    const price = priceFromReserves(entry.base, this.baseDecimals, entry.quote, this.quoteDecimals);
    const detector = this.detectors.get(pool.label)!;
    const result = detector.update(Date.now(), price);

    if (result.jumped && result.changePercent !== undefined) {
      const event: PoolJumpEvent = {
        poolLabel: pool.label,
        changePercent: result.changePercent,
        priceInQuote: price,
        preChangePriceInQuote:
          1 + result.changePercent / 100 > 0
            ? price / (1 + result.changePercent / 100)
            : undefined,
      };
      this.emit("jump", event);
    }
  }
}
