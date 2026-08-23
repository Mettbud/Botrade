import type { Connection, PublicKey, TokenBalance } from "@solana/web3.js";

export interface SwapActuals {
  /** Net lamports change for the owner (negative = spent, includes fees). */
  solDeltaLamports: number;
  /** Net raw token amount change for the owner on `mint`. */
  tokenDelta: bigint;
  networkFeeLamports: number;
}

/**
 * Reads a confirmed transaction's pre/post balances to determine what the
 * wallet actually gained/lost - the real numbers, not the pre-trade quote.
 */
export async function getSwapActuals(
  connection: Connection,
  signature: string,
  owner: PublicKey,
  mint: PublicKey,
): Promise<SwapActuals | undefined> {
  const tx = await connection.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.meta) return undefined;

  const ownerStr = owner.toBase58();
  const mintStr = mint.toBase58();
  const accountKeys = tx.transaction.message.accountKeys.map((k) =>
    k.pubkey.toBase58(),
  );
  const ownerIndex = accountKeys.indexOf(ownerStr);

  const solDeltaLamports =
    ownerIndex >= 0
      ? tx.meta.postBalances[ownerIndex]! - tx.meta.preBalances[ownerIndex]!
      : 0;

  // A wallet can own more than one token account for the same mint. Summing
  // every matching pre/post entry avoids reporting only the first account's
  // fill when a transaction touches several of them.
  const preAmount = sumOwnerMintTokenAmount(
    tx.meta.preTokenBalances,
    ownerStr,
    mintStr,
  );
  const postAmount = sumOwnerMintTokenAmount(
    tx.meta.postTokenBalances,
    ownerStr,
    mintStr,
  );

  return {
    solDeltaLamports,
    tokenDelta: postAmount - preAmount,
    networkFeeLamports: tx.meta.fee,
  };
}

function sumOwnerMintTokenAmount(
  balances: readonly TokenBalance[] | null | undefined,
  owner: string,
  mint: string,
): bigint {
  return (balances ?? []).reduce(
    (sum, balance) =>
      balance.owner === owner && balance.mint === mint
        ? sum + BigInt(balance.uiTokenAmount.amount)
        : sum,
    0n,
  );
}
