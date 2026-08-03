-- Season reset: archive the old board, then clear it.
--
-- Run ONCE, deliberately, when the scoring basis changes. It is being run now
-- because the course used to end at forty sections and cap the score at
-- 43,044; it is endless now, so a score from before and a score from after are
-- not measuring the same thing and should not share a table.
--
-- Nothing is destroyed. The rows are copied to scores_archive with the reason
-- and the date, so the old board can still be read, quoted, or restored. A
-- leaderboard is the only thing here a player cannot get back by playing
-- again, which is reason enough not to use DELETE on its own.

CREATE TABLE IF NOT EXISTS scores_archive (
  season      TEXT NOT NULL,             -- why this batch was retired
  archived_at INTEGER NOT NULL,          -- epoch ms
  day         TEXT NOT NULL,
  player_id   TEXT NOT NULL,
  score       INTEGER NOT NULL,
  section     INTEGER NOT NULL,
  distance    INTEGER NOT NULL,
  elapsed_ms  INTEGER NOT NULL,
  runs        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS scores_archive_season ON scores_archive (season, day);

INSERT INTO scores_archive
  (season, archived_at, day, player_id, score, section, distance, elapsed_ms, runs, created_at, updated_at)
SELECT
  'pre-endless',
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  day, player_id, score, section, distance, elapsed_ms, runs, created_at, updated_at
FROM scores;

DELETE FROM scores;

-- Player names and ids are deliberately kept. Someone who set a name last week
-- should not have to type it again, and their id is what the browser already
-- holds - clearing it would orphan every returning player.
