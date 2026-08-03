-- Per-IP submission limiting.
--
-- The existing 400/day cap is keyed on player_id, which the browser generates
-- and can therefore rotate: it stops a player spamming by accident, not a
-- script spamming on purpose. This is keyed on something the client does not
-- choose.
--
-- The address itself is never stored. The key is a SHA-256 of the address and
-- a per-day salt, so a row cannot be turned back into an IP, and the same
-- address produces a different key tomorrow.

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket      TEXT PRIMARY KEY,          -- hash(ip, day) + ':' + window start
  hits        INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL           -- epoch ms; rows are swept after this
);

-- The sweep's only query shape.
CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits (expires_at);
