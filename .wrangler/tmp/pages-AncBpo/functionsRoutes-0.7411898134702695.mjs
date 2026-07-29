import { onRequestGet as __api_leaderboard_ts_onRequestGet } from "/Users/tragone1/Daily Escape/functions/api/leaderboard.ts"
import { onRequestPost as __api_score_ts_onRequestPost } from "/Users/tragone1/Daily Escape/functions/api/score.ts"

export const routes = [
    {
      routePath: "/api/leaderboard",
      mountPath: "/api",
      method: "GET",
      middlewares: [],
      modules: [__api_leaderboard_ts_onRequestGet],
    },
  {
      routePath: "/api/score",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_score_ts_onRequestPost],
    },
  ]