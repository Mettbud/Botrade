CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp_ms INTEGER NOT NULL,
  buy_price_usd REAL NOT NULL,
  sell_price_usd REAL NOT NULL,
  -- true when sell_price_usd/price_impact_sell_bps are estimated from the
  -- last real spread (only happens while flat) rather than freshly quoted.
  sell_is_estimated INTEGER NOT NULL DEFAULT 0,
  spread REAL NOT NULL,
  price_impact_buy_bps REAL NOT NULL,
  price_impact_sell_bps REAL NOT NULL,
  sol_usd_price REAL NOT NULL,
  -- Nullable: not available without a dedicated chain indexer in v1.
  liquidity_usd REAL,
  volume_usd REAL,
  buy_count INTEGER,
  sell_count INTEGER,
  buy_volume_usd REAL,
  sell_volume_usd REAL,
  change_5s REAL,
  change_15s REAL,
  change_30s REAL,
  change_1m REAL,
  change_5m REAL
);

CREATE INDEX IF NOT EXISTS idx_price_history_timestamp
  ON price_history (timestamp_ms);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp_ms INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  reason TEXT NOT NULL,
  token_amount REAL NOT NULL,
  sol_amount REAL NOT NULL,
  usd_estimate REAL NOT NULL,
  quote_before_json TEXT,
  expected_output REAL,
  actual_output REAL,
  slippage_bps REAL,
  price_impact_pct REAL,
  network_fee_lamports INTEGER,
  priority_fee_lamports INTEGER,
  tx_signature TEXT,
  realized_pnl_usd REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades (timestamp_ms);
