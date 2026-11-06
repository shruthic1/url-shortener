-- Idempotent: safe to run on every deploy.
CREATE TABLE IF NOT EXISTS links (
  short_code  CHAR(7) PRIMARY KEY,
  long_url    TEXT NOT NULL,
  used_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
