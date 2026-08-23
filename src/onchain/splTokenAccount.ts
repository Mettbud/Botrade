/**
 * Decodes just the `amount` field out of a raw SPL Token Account buffer.
 * This layout is the standard SPL Token program Account struct - stable,
 * documented, identical for every token account on Solana regardless of
 * which AMM/pool owns it:
 *   mint:   Pubkey (32 bytes) @ offset 0
 *   owner:  Pubkey (32 bytes) @ offset 32
 *   amount: u64 little-endian  @ offset 64
 * (more fields follow, unused here)
 */
const AMOUNT_OFFSET = 64;
const AMOUNT_LENGTH = 8;
const MIN_ACCOUNT_LENGTH = AMOUNT_OFFSET + AMOUNT_LENGTH;

export function decodeTokenAccountAmount(data: Buffer): bigint {
  if (data.length < MIN_ACCOUNT_LENGTH) {
    throw new Error(
      `Buffer too short to be an SPL token account (${data.length} bytes, need at least ${MIN_ACCOUNT_LENGTH})`,
    );
  }
  return data.readBigUInt64LE(AMOUNT_OFFSET);
}
