# CYBERLEEK bot

A local Solana trading bot for one token — **CYBERLEEK**
(`ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg`) against SOL/WSOL — with a
terminal dashboard, real-quote paper trading, and a heavily-guarded live
mode. The target token is plain config (`TARGET_TOKEN_MINT` /
`TARGET_TOKEN_SYMBOL` in `.env`), so pointing it at a different SPL token
later doesn't need any code changes.

This bot does not promise profit. It has no leverage, no margin, no
borrowing, and never touches more than what sits in the one dedicated
wallet you create for it.

## Requirements

- Node.js 20+
- A **new, separate** Solana wallet used only by this bot (never your
  Phantom/main wallet)
- A little SOL in that wallet to pay network/priority fees (and to swap,
  once you enable live trading)

## Install

```bash
npm install
cp .env.example .env
```

## 1. Create a dedicated hot wallet

Do this with the Solana CLI (or any tool you trust), **not** with your main
wallet:

```bash
solana-keygen new --outfile ./bot-wallet.json --no-bip39-passphrase
```

That file is a JSON array of bytes. You can paste that array directly into
`WALLET_PRIVATE_KEY` in `.env`, or convert it to base58 first — both formats
are accepted. Then fund the wallet with a small amount of SOL (a few
dollars is plenty to start) and delete `bot-wallet.json` once you've copied
the key into `.env`, or keep it somewhere safe outside the repo.

**Never** put your seed phrase or your main wallet's key anywhere near this
project.

## 2. Configure `.env`

Open `.env.example`, read every line, then fill in `.env`. Key fields:

| Variable | Meaning |
|---|---|
| `WALLET_PRIVATE_KEY` | The dedicated bot wallet's secret key. Required even in paper mode (used for realistic fee estimates and balance display) but never spends funds in paper mode. |
| `RPC_URL` | Your Solana RPC endpoint. The public default works but is rate-limited; a paid RPC (Helius, Triton, QuickNode, …) is much more reliable. |
| `JUPITER_API_KEY` | Optional. Get one free at https://portal.jup.ag for higher rate limits. Without it the bot uses Jupiter's free `lite-api.jup.ag` tier. |
| `TARGET_TOKEN_MINT` / `TARGET_TOKEN_SYMBOL` | The token this run trades. Defaults to CYBERLEEK; change later to trade something else. |
| `TRADING_MODE` + `ENABLE_LIVE_TRADING` | The live-trading gate — see below. |
| `MAX_TRADE_USD` | Hard cap per trade, in USD. Starts at `1`. |
| `MIN_SOL_RESERVE` | SOL that must always stay untouched. |
| `PAPER_BALANCE_USD` | Starting virtual balance for paper trading. |
| `STOP_LOSS_PERCENT`, `TRAILING_STOP_PERCENT`, `TAKE_PROFIT_LEVELS` | Strategy thresholds — all optional to tune. |

## Safety mechanisms (read this)

- **Paper mode by default.** `TRADING_MODE=paper` out of the box.
- **Two independent switches for live trading.** Real swaps only execute
  when **both** `TRADING_MODE=live` **and** `ENABLE_LIVE_TRADING=true` are
  set. Either one alone keeps the bot in paper mode — flipping one by
  accident is not enough to spend real money. If only one is set, the bot
  refuses to start at all until you fix it, rather than silently falling
  back.
- **`MAX_TRADE_USD`.** Every buy is checked against this before it is sent.
  Anything larger is rejected with an `ERROR` in the terminal — no partial
  send, no silent clamp.
- **`MIN_SOL_RESERVE`.** A live buy is rejected if it would leave the
  wallet's SOL below this reserve, both before quoting and again after the
  real priority fee is known.
- **Slippage / price impact guard.** If a quote's slippage or price impact
  exceeds `MAX_SLIPPAGE_BPS` / `MAX_PRICE_IMPACT_BPS`, the trade is blocked
  with `TRADE BLOCKED – price impact too high` — including automatic stop
  loss, trailing stop and take profit sells. The only bypass is `panic`
  (see below), and even that still prints the quote first.
- **Wick protection.** `STOP_CONFIRMATION_MS` requires a stop-loss/trailing-
  stop trigger to hold continuously for that long before it's acted on, so
  one fast wick doesn't force a sell. Set `STOP_CONFIRMATION_ENABLED=false`
  to disable it.
- **The bot can only ever lose what's in the dedicated wallet.** No
  leverage, no margin, no borrowing, no "use full balance" behavior
  anywhere in the code.
- **The private key never leaves the process.** It's read once from `.env`
  into memory, used only to sign transactions locally, and is never logged,
  printed, or sent to any API. `.env` is git-ignored.

## Run paper trading

```bash
npm run bot
```

With `TRADING_MODE=paper` (the default), this simulates trading against
**real** Jupiter quotes — real price impact, real spread, and a realistic
dynamic priority-fee estimate (read back from an unsigned, never-sent swap
transaction Jupiter builds) — against a virtual balance
(`PAPER_BALANCE_USD`), so the numbers are close to what live trading would
actually cost, without risking anything.

### Dashboard

The terminal redraws every `DASHBOARD_REFRESH_MS` with price, position,
P&L, trailing-stop/stop-loss state, balances, and short-window % changes.
Momentum/dump alerts (e.g. `🚀 MOMENTUM: +8.4% / 30s`, `⚠️ DUMP DETECTED:
-11.2% / 20s`) print above it as they happen.

### Commands (type into the running terminal)

| Command | Effect |
|---|---|
| `buy <usd>` | Buy up to `<usd>` dollars worth (still capped by `MAX_TRADE_USD`) |
| `sell 25` / `sell 50` / `sell 100` | Sell that percent of the current position |
| `panic` | Emergency exit: previews the quote, price impact, expected SOL and slippage, then sells 100% immediately, bypassing the price-impact/slippage guard |
| `status` | Force a dashboard redraw |
| `help` | List commands |
| `quit` / `exit` or `Ctrl+C` | Stop the bot cleanly |

### Optional: auto-buy (off by default)

By default the bot never buys on its own - `buy` is the only way in. Set
`AUTO_BUY_ENABLED=true` to change that: the bot then watches for
`AUTO_BUY_DIP_PERCENT`% (default 50%) drop within `AUTO_BUY_DIP_LOOKBACK_MS`
(default 60s), and buys on the very first tick price ticks up from its low
after that. This targets a pattern CYBERLEEK specifically shows - a sudden,
extreme wick down that immediately bounces.

**Be honest with yourself about what this is and isn't.** It is a simple,
transparent rule, not a prediction - there is no way for the bot (or
anyone) to know in advance whether a given drop is "the" dip or the start
of a bigger fall. It will buy into drops that keep falling. It only ever
buys while the bot has no open position, and every buy still goes through
`MAX_TRADE_USD` - but the entry decision itself carries real risk that
`STOP_LOSS_PERCENT` limits, it doesn't remove. Test it in paper mode for a
good while, watching how often the "rebound" was real vs. a dead cat
bounce, before ever pairing it with live trading.

The dashboard shows `Auto-buy: OFF` / `ON, watching for a dip (...)` /
`WATCHING for rebound (...)` so you can see what state it's in at a glance.

### Optional: on-chain pool watch (faster detection, off by default)

Polling Jupiter every 1-3s means the bot can miss a move that fully
happens between two polls. `ONCHAIN_WATCH_ENABLED=true` adds a second,
faster channel: it subscribes directly to a pool's two reserve accounts
over RPC (`connection.onAccountChange`) and flags a fast price move the
instant it lands on-chain, instead of waiting for the next scheduled poll.

**This never replaces Jupiter for pricing or trading** - it only makes the
bot check Jupiter sooner. Every buy/sell is still decided from a real,
fresh Jupiter quote; the pool watch is just a faster alarm bell. It also
only understands simple constant-product pools (reserves = two SPL token
account balances) - not bin-based AMMs like Meteora DLMM.

Configure pools to watch in `WATCH_POOLS`:
```
WATCH_POOLS=raydium1:<baseVaultAddress>:<quoteVaultAddress>
```
`baseVault`/`quoteVault` are the pool's own reserve token accounts (found
via a block explorer like Solscan - look up the pool address, then find
the token account holding each side's balance), not the token mints.
Multiple pools: comma separate multiple `label:base:quote` entries - each
one watched independently, any one jumping triggers an early check.

## Run live trading

Only after you're comfortable with paper trading and the numbers it's
showing you. In `.env`:

```
TRADING_MODE=live
ENABLE_LIVE_TRADING=true
```

Then `npm run bot` again. Everything else (dashboard, commands, guards) is
identical — the only difference is that trades are now real, signed
locally with your dedicated wallet's key and sent to the network.

### The $1 round-trip test

Before trusting the bot with anything more, run the dedicated round-trip
test. It buys ~$1 of the target token, waits, sells it all back to SOL, and
reports exactly what that cost:

```bash
npm run roundtrip            # $1, 30s wait
npm run roundtrip 1 45       # $1, 45s wait
```

It refuses to run unless live trading is fully armed, and refuses any
amount above `MAX_TRADE_USD`. Output includes starting/ending value,
expected vs. actual output on each leg, network fees, priority fees,
slippage, price impact, and total round-trip cost in both USD and percent.

## How P&L works

The bot keeps its own weighted-average cost basis from the trades it has
actually made (`src/strategy/costBasis.ts`), replayed from the local trade
log — it does not trust a wallet UI's P&L display. Every buy adds to
`totalCostUsd`; every sell realizes P&L proportional to the fraction of the
position sold, netting out its share of cost basis. Fees are folded into
`usdEstimate` on both sides, so realized/unrealized P&L already accounts
for them.

## Logs & rate limits

The dashboard clears the terminal every second, so anything only printed
to the console can flash and vanish before you read it. Two things fix
that:

- Every log line is also written to `LOG_FILE` (default `./data/bot.log`)
  - open it any time to see everything, not just the last screen redraw.
- The most recent price-feed error (e.g. a Jupiter rate limit) stays
  visible on the dashboard itself until the next successful price update,
  instead of disappearing on the next clear.

If you see `429 Too Many Requests` a lot: the bot already backs off
automatically (it waits longer after each consecutive failure, up to 30s),
but the real fix is a free API key from https://portal.jup.ag pasted into
`JUPITER_API_KEY` - it switches the bot from the shared free tier
(`lite-api.jup.ag`) to the keyed one (`api.jup.ag`) with a much higher
limit, at no cost. `PRICE_POLL_INTERVAL_MS` below ~1000ms will still find
that limit eventually since every tick is normally 2 requests (buy + sell
quote) - **except** while the bot has no open position, where it only
fetches the buy quote and estimates the sell price from the last known
spread (roughly halving API load in the common "watching, not holding"
case). The dashboard marks an estimated sell price with `(est., not
live-quoted while flat)`; the instant a position opens, both sides go back
to real, freshly-quoted prices, since that's when exit-price accuracy on
stop loss / trailing stop / take profit actually matters.

## Data storage

Everything is local SQLite (`DB_PATH`, default `./data/cyberleek.sqlite`):

- `price_history` — timestamp, executable buy/sell price, spread, price
  impact, SOL/USD, and 5s/15s/30s/1m/5m % change. `liquidity`, `volume`,
  `buy_count`/`sell_count` and whale-trade columns exist in the schema but
  are left `NULL` in v1 — reliably getting those needs a dedicated
  on-chain transaction indexer, which is out of scope for a local bot and
  wasn't worth faking with unreliable numbers.
- `trades` — every buy/sell (paper or live) with token/SOL/USD amounts,
  the quote used, expected vs. actual output, slippage, price impact, fees,
  tx signature (live), realized P&L, and the reason
  (`MANUAL` / `STOP_LOSS` / `TRAILING_STOP` / `TAKE_PROFIT` / `PANIC_EXIT`).

## Architecture

```
src/
  config/     env parsing + validation (zod), live-trading safety gate
  logger/     leveled logger with secret redaction
  solana/     RPC connection, transaction analysis (actual amounts)
  wallet/     keypair loading, SOL/token balance reads
  jupiter/    quote/swap REST client, transaction signing+sending, fee estimation
  market/     price feed (polling), rolling history, momentum/dump detection
  strategy/   cost basis, stop loss, trailing stop, take profit, wick confirmation
  trading/    risk guards, paper trader, live trader, position manager
  database/   SQLite schema + repositories
  cli/        dashboard rendering, interactive commands
  index.ts    wires it all together (`npm run bot`)
scripts/
  roundtripTest.ts   the $1 live round-trip test (`npm run roundtrip`)
tests/        vitest unit tests for the strategy/risk math
```

Each module does one job; the strategy and risk-guard modules are pure
functions with no I/O, which is what `tests/` exercises directly.

## Current API/SDK choices (checked at build time)

- **Jupiter Swap API**: `swap/v1/quote` and `swap/v1/swap`, against the free
  `lite-api.jup.ag` host by default, switching to `api.jup.ag` automatically
  once `JUPITER_API_KEY` is set (same paths, just the host changes — this is
  Jupiter's current recommended migration path off the legacy Metis
  endpoints). Swaps use `dynamicComputeUnitLimit` and
  `prioritizationFeeLamports.priorityLevelWithMaxLamports`, Jupiter's
  current-recommended way to size compute budget and priority fee instead
  of hand-rolling `ComputeBudgetProgram` instructions.
- **Solana SDK**: `@solana/web3.js` (v1) + `@solana/spl-token`. Newer
  `@solana/kit` exists, but Jupiter's own official examples and most
  ecosystem tooling still build on `@solana/web3.js`'s `Keypair` /
  `VersionedTransaction` types, which this bot needs directly to sign swap
  transactions built by Jupiter's API — so that's what's used here.
- Transactions are always deserialized, signed locally with the in-memory
  `Keypair`, and sent with `sendRawTransaction` + a resend/confirm loop —
  never through a third-party signer.

### Known upstream advisory

`npm audit` reports a handful of transitive vulnerabilities inside
`@solana/web3.js`'s and `@solana/spl-token`'s own dependency trees
(`bigint-buffer`, `uuid` via `jayson`). These come from the official Solana
SDKs themselves, not from anything added here, and `npm audit fix --force`
would downgrade to non-functional ancient versions rather than fix
anything. Worth knowing about; not something this project can fix on its
own.

## Testing

```bash
npm test          # run once
npm run test:watch
npm run typecheck
```

Covers: weighted-average cost basis, partial sells and realized P&L,
unrealized P&L, stop loss (including the wick-protection confirmation
timer), trailing stop (including the activation threshold), take-profit
ladder triggering, `MAX_TRADE_USD`/`MIN_SOL_RESERVE`/slippage/price-impact
guards, price-history % change math, and the live-trading safety gate
(both switches required, wallet key required).

## Stopping the bot

`Ctrl+C`, or type `quit`/`exit` at the prompt. Either way it stops the
price feed and closes the database cleanly — no trade is ever left
half-sent by a shutdown (an in-flight swap either confirms or the CLI
reports it didn't).

## Emergency exit

Type `panic` at any time. It previews the current sell quote (expected
SOL, price impact, slippage) and then sells 100% of the position
immediately, bypassing the slippage/price-impact block — the one place in
the bot where that guard is intentionally skipped, because the whole point
of `panic` is "get me out now."

## Limitations, honestly

- Price monitoring is quote-based polling (`PRICE_POLL_INTERVAL_MS`,
  1-3s by default), not a raw on-chain websocket feed of pool state. A true
  websocket feed would need pool discovery/decoding logic specific to
  whichever AMM CYBERLEEK trades on, which is more fragile than a
  well-throttled real quote and was not worth the risk for v1 — the
  interval is easy to lower if your RPC/API limits allow it.
- Buy/sell counts, on-chain volume and whale-trade detection are not
  implemented — they need a dedicated transaction indexer this bot doesn't
  have, and it seemed worse to fake them than to leave them out.
- After a restart, the trailing-stop "highest since entry" resets to the
  current average entry price (not the true historical high before
  restart), and already-triggered take-profit levels are forgotten. Both
  are safe defaults (nothing sells more than it should), just not
  perfectly stateful across restarts in v1.
