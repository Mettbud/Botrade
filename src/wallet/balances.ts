import {
  getAssociatedTokenAddressSync,
  getMint,
  getAccount,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import type { Connection, PublicKey } from "@solana/web3.js";

export const LAMPORTS_PER_SOL = 1_000_000_000;

export async function getSolBalanceSol(
  connection: Connection,
  owner: PublicKey,
): Promise<number> {
  const lamports = await connection.getBalance(owner, "confirmed");
  return lamports / LAMPORTS_PER_SOL;
}

const decimalsCache = new Map<string, number>();

export async function getMintDecimals(
  connection: Connection,
  mint: PublicKey,
): Promise<number> {
  const key = mint.toBase58();
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;

  const info = await getMint(connection, mint);
  decimalsCache.set(key, info.decimals);
  return info.decimals;
}

export interface TokenBalance {
  amountRaw: bigint;
  uiAmount: number;
  decimals: number;
}

/** Reads the owner's SPL token balance for `mint`, or zero if no ATA exists yet. */
export async function getTokenBalance(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
): Promise<TokenBalance> {
  const decimals = await getMintDecimals(connection, mint);
  const ata = getAssociatedTokenAddressSync(mint, owner);

  try {
    const account = await getAccount(connection, ata, "confirmed");
    const amountRaw = account.amount;
    return {
      amountRaw,
      uiAmount: Number(amountRaw) / 10 ** decimals,
      decimals,
    };
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) {
      return { amountRaw: 0n, uiAmount: 0, decimals };
    }
    throw err;
  }
}
