/**
 * Whether this page may expose its internals.
 *
 * One flag, read in the two places that matter, so there is no chance of the
 * console handles shipping enabled because a second condition was missed. A
 * production build of a leaderboard game hands out nothing.
 */
export const DEBUG_HOOKS =
  typeof location !== "undefined" && new URLSearchParams(location.search).has("debug");
