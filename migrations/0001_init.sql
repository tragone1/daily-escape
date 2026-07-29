-- Daily Escape leaderboard.
--
-- Two tables and no more: a player is a name attached to an anonymous id, and a score is
-- one player's best on one day. Keeping only the best per player per day is what makes the
-- board readable - a leaderboard of forty attempts by the same three people is not one.

CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,          -- random, generated in the browser
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,          -- epoch ms
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
  day         TEXT NOT NULL,             -- YYYY-MM-DD in the challenge timezone
  player_id   TEXT NOT NULL,
  score       INTEGER NOT NULL,
  section     INTEGER NOT NULL,
  distance    INTEGER NOT NULL,
  elapsed_ms  INTEGER NOT NULL,
  runs        INTEGER NOT NULL DEFAULT 1, -- attempts submitted that day
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (day, player_id)
);

-- The only query shape the board needs: one day, ordered.
CREATE INDEX IF NOT EXISTS scores_day_rank ON scores (day, score DESC);
-- And a player's own history.
CREATE INDEX IF NOT EXISTS scores_player ON scores (player_id, day DESC);
