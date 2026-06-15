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

CREATE TABLE IF NOT EXISTS session_playbooks (
  id BIGSERIAL PRIMARY KEY,
  session_date DATE NOT NULL,
  instrument_key TEXT NOT NULL,
  expiry_date DATE NOT NULL,
  formula_version TEXT NOT NULL,
  fingerprint JSONB NOT NULL,
  playbook JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_date, instrument_key, expiry_date, formula_version)
);

CREATE INDEX IF NOT EXISTS session_playbooks_lookup_idx
ON session_playbooks (instrument_key, session_date DESC);

CREATE TABLE IF NOT EXISTS institutional_daily (
  trade_date DATE PRIMARY KEY,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  participant_report JSONB NOT NULL,
  cash_report JSONB,
  source JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS institutional_daily_date_idx
ON institutional_daily (trade_date DESC);
