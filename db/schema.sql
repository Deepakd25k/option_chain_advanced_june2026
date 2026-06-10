CREATE TABLE IF NOT EXISTS market_snapshots (
  id BIGSERIAL PRIMARY KEY,
  session_date DATE NOT NULL,
  instrument_key TEXT NOT NULL,
  expiry_date DATE NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  bucket_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  spot DOUBLE PRECISION NOT NULL DEFAULT 0,
  atm_strike DOUBLE PRECISION NOT NULL DEFAULT 0,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_date, instrument_key, expiry_date, bucket_at)
);

CREATE INDEX IF NOT EXISTS market_snapshots_lookup_idx
ON market_snapshots (session_date, instrument_key, expiry_date, captured_at);
