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

For the agreed CYBERLEEK short-term PAPER profile, use
`CYBERLEEK.env.ready` instead. It is a complete secret-free file generated
for copying into `.env`; only the owner fills `WALLET_PRIVATE_KEY` and a newly
rotated `JUPITER_API_KEY`. The bot and repository changes never edit the real
`.env`.

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
| `MAX_TRADE_USD` | Hard cap for each LIVE buy, in USD. Starts at `1`; PAPER buys are limited only by the virtual balance. |
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
- **`MAX_TRADE_USD`.** Every LIVE buy is checked against this before it is sent.
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
- **Spread guard.** A separate, tighter check for automatic
  TAKE_PROFIT/TRAILING_STOP sells: blocked if spread exceeds
  `MAX_SPREAD_BPS` (default 0.5%), or `MAX_SPREAD_HIGH_GAIN_BPS` (default
  1%) once the position's unrealized gain clears
  `MAX_SPREAD_HIGH_GAIN_THRESHOLD_PERCENT` (default 10%) - don't block
  locking in a big win over a slightly wider spread. Deliberately does
  **not** apply to `STOP_LOSS`/`PANIC_EXIT` - getting out of a bad position
  matters more than the spread it costs, same reasoning as `panic` already
  bypassing the price-impact guard.
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
| `buy <usd>` | Buy `<usd>` dollars worth; LIVE is capped by `MAX_TRADE_USD`, PAPER by its virtual balance |
| `sell 25` / `sell 50` / `sell 100` | Sell that percent of the current position |
| `panic` | Emergency exit: previews the quote, price impact, expected SOL and slippage, then sells 100% immediately, bypassing the price-impact/slippage guard |
| `reset` | PAPER only (refused in live): wipes PAPER trades, balances, rolling price signals, auto-buy cooldown/watch state, and retained dashboard errors/events. It keeps the configuration already loaded by this process. |
| `status` | Force a dashboard redraw |
| `help` | List commands |
| `quit` / `exit` or `Ctrl+C` | Stop the bot cleanly |

`.env` is read once when the bot starts. After replacing or editing `.env`, use
`quit` and start the bot again; `reset` deliberately does **not** hot-reload
configuration. This avoids mixing one session's trades with strategy values
that changed halfway through the process.

### Optional: auto-buy (off by default)

By default the bot never buys on its own - `buy` is the only way in. Set
`AUTO_BUY_ENABLED=true` to change that: the bot then watches for
`AUTO_BUY_DIP_PERCENT`% (default 50%) drop within `AUTO_BUY_DIP_LOOKBACK_MS`
(default 60s), and buys on the very first tick price ticks up from its low
after that. This targets a pattern CYBERLEEK specifically shows - a sudden,
extreme wick down that immediately bounces.

The configured dip is now the calm-market floor, not always the final
threshold. Two protections can widen it automatically, and the strictest
value wins:

- **Peak protection:** after an ordered low-to-high run-up of at least
  `AUTO_BUY_PEAK_RUNUP_PERCENT` (default 10%) inside
  `AUTO_BUY_PEAK_LOOKBACK_MS` (default 5 minutes), require at least
  `AUTO_BUY_PEAK_DIP_PERCENT` (default 8%) from the peak. A later crash is
  not itself mistaken for the earlier run-up; the low must occur first.
- **Volatility protection:** calculate rolling realized volatility from
  consecutive executable-price changes over
  `AUTO_BUY_VOLATILITY_LOOKBACK_MS` (default 60 seconds), multiply it by
  `AUTO_BUY_VOLATILITY_MULTIPLIER` (default 2), and cap that component at
  `AUTO_BUY_VOLATILITY_MAX_DIP_PERCENT` (default 12%). For example, 3%
  realized volatility produces a 6% dip requirement.

With a custom calm-market value of 2%, the effective threshold is therefore
`max(2%, peak 8% when active, 2 x current volatility up to 12%)`. Both
protections default to on, can be disabled independently, and never make a
more conservative base setting smaller. If volatility tightens the threshold
after a dip was already being watched, the old signal is disarmed until price
actually reaches the newer threshold.

**Be honest with yourself about what this is and isn't.** It is a simple,
transparent rule, not a prediction - there is no way for the bot (or
anyone) to know in advance whether a given drop is "the" dip or the start
of a bigger fall. It will buy into drops that keep falling. By default it
only ever buys while the bot has no open position - but the entry decision
itself carries real risk that `STOP_LOSS_PERCENT` limits, it doesn't
remove. Test it in paper mode for a good while, watching how often the
"rebound" was real vs. a dead cat bounce, before ever pairing it with live
trading.

Set `AUTO_BUY_ALLOW_AVERAGING=true` to let it also buy more while already
holding a position (averaging in on each new qualifying dip, instead of
waiting to be flat again) - meaningfully more risk, since it can keep
buying into a token that keeps falling, with no limit on how many times.
`AUTO_BUY_MIN_GAP_MS` (default 3000) spaces out consecutive buys either
way; raise it for deliberate breathing room between purchases.

The dashboard shows `Auto-buy: OFF` / `ON, watching for a dip (...)` /
`WATCHING for rebound (...)`, the effective threshold, and `PEAK`/`VOL`
labels whenever either protection is actively widening it.

**Position sizing is the same formula on both modes, with one guardrail
that only applies to LIVE.** Every auto-buy spends
`PAPER_POSITION_SIZE_PERCENT`% of the *current available balance* -
PAPER's simulated balance, or LIVE's real SOL balance above
`MIN_SOL_RESERVE` converted to USD - so paper trading actually previews
what live will do, not a different strategy. The one asymmetry: LIVE
auto-buys additionally never exceed `MAX_TRADE_USD` (the real-money safety
ceiling - raise it in `.env` if you want bigger live auto-buys, that's the
one dial that controls it), while PAPER is deliberately left uncapped by
it, since paper trades risk nothing real and the whole point can be
previewing sizes larger than `MAX_TRADE_USD`.

### Take-profit modes: entry ladder vs cascade

`TAKE_PROFIT_MODE=entry` (default) is the fixed ladder described above -
`TAKE_PROFIT_LEVELS` gain thresholds are always measured from the original
entry price, and each level fires once.

`TAKE_PROFIT_MODE=cascade` uses linear targets from one frozen entry:
`+X%`, `+2X%`, `+3X%` and so on. Each target sells
`CASCADE_TAKE_PROFIT_SELL_PERCENT`% of the position captured when the cycle
opened, not a percentage of a shrinking remainder. With the requested
5%/20% profile, $1.00 -> $1.05 -> $1.10 -> $1.15 leaves exactly
100% -> 80% -> 60% -> 40%. If one price sample jumps across several targets,
the due tranches are combined into one rate-limit-friendly swap and their
count is persisted with the trade.

`CASCADE_PROFIT_LOCK_ENABLED=true` can protect the regular remainder after a
configured payout count. For example, after three payouts,
`CASCADE_PROFIT_LOCK_GAIN_PERCENT=8` closes the remainder if executable price
falls back to entry +8% and holds there for the configured confirmation time.
This is a trigger floor, not a guaranteed fill price during a fast gap.

The frozen entry, initial amount and completed tranche count are reconstructed
from SQLite after restart. Once any cascade amount has actually sold, further
regular buys are blocked until that cycle closes; otherwise fresh tokens could
inherit already-completed payout targets. The ready profile additionally uses
`AUTO_BUY_ALLOW_AVERAGING=false`. A take-profit sell is also deliberately excluded from
`AUTO_BUY_REQUIRE_BELOW_LAST_SELL`'s "last sell" tracking - otherwise a
run of successful cascade tranches on an uptrend would keep ratcheting
that gate higher until auto-buy/averaging could never fire again.

Lower thresholds mean more potential swaps, although skipped targets are
batched. Check live spread/price impact before enabling real money; on a
low-liquidity token the cumulative cost can still be material.

### Optional: crash-buy (very fast drop, off by default)

A separate, faster opt-in from `AUTO_BUY_ENABLED` above:
`CRASH_BUY_ENABLED=true` watches the live executable USD price history for
a very sharp move - price dropping `CRASH_BUY_DROP_PERCENT`% (default 20%)
within `CRASH_BUY_WINDOW_MS` (default 12000ms) - and buys **immediately**,
with no dip-then-rebound wait like normal auto-buy. It still only ever
buys through a real, fresh Jupiter quote - never a raw on-chain swap - and
at most one isolated crash lot at a time. A regular position may coexist
with it. Detection granularity is bounded by how often a real
price sample actually lands (`PRICE_POLL_INTERVAL_MS`, sped up by
`ONCHAIN_WATCH_ENABLED` jumps if that's also on) - it isn't a promise of
true sub-poll-interval detection, just the window the drop is measured
over once a sample does land.

Sizing is deliberately larger than a normal auto-buy, since the whole
point is catching a rare, genuine crash - a $1 nibble wouldn't be worth
chasing it for. It spends `CRASH_BUY_PORTFOLIO_PERCENT`% (default 50%) of
whatever's currently available (PAPER balance, or live SOL balance above
`MIN_SOL_RESERVE` converted to USD), hard-capped at `CRASH_BUY_MAX_USD`
(default $50) either way - both apply on PAPER and LIVE.

Also gated by `CRASH_BUY_MAX_SPREAD_BPS` (default 500 = 5%): a genuine
crash naturally widens spread, so this is deliberately looser than normal
trading's tolerance - it only rejects the extreme, pathological case (a
near-drained/rugged pool), not ordinary crash volatility.

Exit is its own rule, not the normal take-profit ladder: once price
recovers to within `CRASH_BUY_REBOUND_TOLERANCE_PERCENT`% (default 3%) of
P0 - the price right before the crash - exactly the recorded crash-lot amount
sells (`CRASH_BUY_EXIT` in the trade log). Regular tokens are left untouched,
even if they share the same fungible wallet balance. The lot ID, P0, initial
amount and remaining cost are persisted, so a restart does not lose the exit.
The dashboard keeps ACTIVE state until exit and retains the last crash event
for `CRASH_BUY_STATUS_HOLD_MS` afterwards. Regular and crash books evaluate
`STOP_LOSS_PERCENT`/`TRAILING_STOP_PERCENT` independently: a stop triggered in
only one book sells only that book. If both independently cross the hard
stop-loss on the same sample, one aggregate emergency swap closes both faster;
the explicit `panic` command is also always global.

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

On Windows, follow the durable log live in a second PowerShell window:

```powershell
Get-Content .\data\bot.log -Tail 100 -Wait
```

All Jupiter GET/POST calls (price quotes, trade quotes and paper fee
estimates) now pass through one process-wide FIFO. Their starts are spaced by
`JUPITER_MIN_REQUEST_INTERVAL_MS` (2100 ms by default), so an on-chain early
tick cannot burst requests on top of a take-profit sell. A `429 Too Many
Requests` stays at the front of that queue, honors Jupiter's reset/retry
header when available and retries at most `JUPITER_429_MAX_RETRIES` times;
the exponential fallback begins at `JUPITER_429_FALLBACK_BACKOFF_MS`. If the
bounded retries still fail, the action is logged and the bot remains alive —
the interactive `reset` command is not lost.

A free API key from https://portal.jup.ag belongs in `JUPITER_API_KEY`; it
switches the host from `lite-api.jup.ag` to `api.jup.ag`. Keep the conservative
2100 ms spacing unless the quota documented for your plan clearly permits a
lower value. `PRICE_POLL_INTERVAL_MS` is not a complete rate limiter by itself:
one tick can need buy and sell quotes, while a trade can add quote/swap or fee
requests. While flat, the feed normally fetches only the buy quote and estimates
the sell price from the last known spread. The dashboard marks that estimate;
as soon as a position opens, both sides return to fresh quotes for accurate
stop-loss, trailing-stop and take-profit decisions.

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
  (including scoped regular/crash stops, cascade/profit-lock and `PANIC_EXIT`).
- `trailing_states` — the persisted high-water mark and armed state for the
  regular position and each isolated crash lot. A position identity prevents a
  stale peak from being reused by a later position after a restart.

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
- Trailing-stop high-water marks, cascade counters and isolated crash lots are
  restored after restart. Very old trades written before crash-lot metadata was
  introduced are reconciled conservatively and pause exact crash automation if
  their ownership cannot be proven.
