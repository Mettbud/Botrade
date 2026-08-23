import { describe, expect, it } from "vitest";
import { decodeTokenAccountAmount } from "../src/onchain/splTokenAccount.js";

/** Builds a synthetic (but correctly shaped) SPL Token Account buffer. */
function fakeTokenAccount(amount: bigint): Buffer {
  const buf = Buffer.alloc(165); // real SPL token accounts are 165 bytes
  buf.writeBigUInt64LE(amount, 64);
  return buf;
}

describe("decodeTokenAccountAmount", () => {
  it("reads the amount field at the documented offset (64)", () => {
    const buf = fakeTokenAccount(123_456_789_000n);
    expect(decodeTokenAccountAmount(buf)).toBe(123_456_789_000n);
  });

  it("reads zero correctly (empty vault)", () => {
    expect(decodeTokenAccountAmount(fakeTokenAccount(0n))).toBe(0n);
  });

  it("handles large u64 values without overflow (bigint, not number)", () => {
    const large = 18_000_000_000_000_000_000n; // near u64 max
    expect(decodeTokenAccountAmount(fakeTokenAccount(large))).toBe(large);
  });

  it("throws a clear error instead of silently misreading a too-short buffer", () => {
    expect(() => decodeTokenAccountAmount(Buffer.alloc(40))).toThrow(/too short/);
  });
});
