import { PublicKey, type Connection, type TokenBalance } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { getSwapActuals } from "../src/solana/txAnalysis.js";

function tokenBalance(
  accountIndex: number,
  owner: PublicKey,
  mint: PublicKey,
  amount: bigint,
): TokenBalance {
  return {
    accountIndex,
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    uiTokenAmount: {
      amount: amount.toString(),
      decimals: 6,
      uiAmount: Number(amount) / 1_000_000,
      uiAmountString: (Number(amount) / 1_000_000).toString(),
    },
  };
}

describe("getSwapActuals", () => {
  it("sums every token account belonging to the owner and mint", async () => {
    const owner = PublicKey.unique();
    const otherOwner = PublicKey.unique();
    const mint = PublicKey.unique();
    const otherMint = PublicKey.unique();
    const getParsedTransaction = vi.fn().mockResolvedValue({
      transaction: {
        message: {
          accountKeys: [{ pubkey: owner }],
        },
      },
      meta: {
        preBalances: [1_000],
        postBalances: [850],
        fee: 5,
        preTokenBalances: [
          tokenBalance(1, owner, mint, 100n),
          tokenBalance(2, owner, mint, 50n),
          tokenBalance(3, otherOwner, mint, 500n),
          tokenBalance(4, owner, otherMint, 700n),
        ],
        postTokenBalances: [
          tokenBalance(1, owner, mint, 40n),
          tokenBalance(2, owner, mint, 30n),
          tokenBalance(3, otherOwner, mint, 1n),
          tokenBalance(4, owner, otherMint, 2n),
        ],
      },
    });
    const connection = { getParsedTransaction } as unknown as Connection;

    const actuals = await getSwapActuals(
      connection,
      "signature",
      owner,
      mint,
    );

    expect(actuals).toEqual({
      solDeltaLamports: -150,
      tokenDelta: -80n,
      networkFeeLamports: 5,
    });
  });
});
