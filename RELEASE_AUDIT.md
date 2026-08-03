# Daily Escape — pre-launch audit

**Audited at:** `4e7b546` (tag `known-good-2026-08-03`)
**Live at time of audit:** `origin/main` = `2c02e56` — an older build; none of this session's work is deployed.

Status vocabulary: **VERIFIED** (implemented correctly, checked) · **UNTESTED** (implemented,
no evidence) · **PARTIAL** · **MISSING** · **WRONG** (incorrect or insecure) · **N/A**.

---

## 1. Initial classification

Recorded before any changes were made in this pass.

### Loading and error handling

| Item | Status | Evidence |
|---|---|---|
| WebGL2 capability check with player-facing message | VERIFIED | `src/compat.ts` `webgl2Problem()`, surfaced by `main.ts` |
| Error screen on init failure | VERIFIED | `#bootError` + `__bootError()`; catches throw, `error`, `unhandledrejection` |
| Boot watchdog if the bundle never runs | VERIFIED | 6s timer on `window.__booted` (fixed earlier this session) |
| Error screen independent of game init | VERIFIED | Inline `<script>` in `index.html`, runs before the module |
| Errors written for players, no stack traces | PARTIAL | Boot screen is player-readable; leaderboard surfaces raw `err.message` |
| Retry / refresh affordance on failure | MISSING | Boot error is text only |
| Loading state while the world builds | PARTIAL | Intro card shows immediately; world build (~100ms) is not signalled |
| Stuck-loading timeout | VERIFIED | Same 6s watchdog |
| "Update available" for an incompatible cached build | MISSING | No version is emitted at all |
| Nonessential service failure is survivable | VERIFIED | `DailyUi` construction is wrapped in try/catch in `game.ts` |

### Leaderboard and names

| Item | Status | Evidence |
|---|---|---|
| Deterministic ordering and tie-break | VERIFIED | `ORDER BY score DESC, updated_at ASC` — earliest to reach a score ranks higher |
| Player's own rank when outside the top | VERIFIED | `you` block in `functions/api/leaderboard.ts` |
| Names rendered as text, never HTML | VERIFIED | `textContent` throughout `dailyUi.ts`; explicit comment |
| Server-side name validation | VERIFIED | `cleanName()` — allowlist, 2–18 chars, Unicode-aware |
| Parameterised SQL | VERIFIED | Every query uses `.bind()` |
| Blank / spaces-only names rejected | VERIFIED | `trim()` then length check |
| Unicode normalization | MISSING | No `normalize("NFKC")`; visually identical names can differ |
| Profanity filtering | MISSING | No filter of any kind |
| Admin moderation path | MISSING | No authenticated way to remove an entry |
| Duplicate-click protection | VERIFIED | Button disabled during flight, `submittedFor` guard |
| Submission failure preserves the run | PARTIAL | Retry is possible while the card is open; nothing survives a refresh |
| Network timeout | MISSING | `fetch` has no `AbortController`; a hung request shows "Sending…" forever |

### Cheating and validation

| Item | Status | Evidence |
|---|---|---|
| Server decides the day, never the client | VERIFIED | `dayKey()` server-side; client `day` is ignored |
| Score consistent with its own breakdown | VERIFIED | `distance + (section-1)*500`, ±500 |
| Rate-of-scoring plausibility | VERIFIED | 130 pts/s; measured max sustained is 86, ~100 deep |
| Bounds on every numeric field | VERIFIED | `isInt` on score, section, distance, elapsed |
| Section bound tracks run length | VERIFIED | Fixed this session; was a fixed 500 |
| Per-player submission cap | PARTIAL | 400/day, but `playerId` is client-generated so it is rotatable |
| Run tokens (server-issued, expiring, single-use) | MISSING | Documented as a known limitation |
| Per-IP rate limiting | MISSING | No IP-based bound |
| Suspicious-score flagging | MISSING | Rejected submissions are not recorded |

### Daily challenge

| Item | Status | Evidence |
|---|---|---|
| Server-authoritative day | VERIFIED | Submissions stamped with server `dayKey()` |
| Timezone defined and shared | VERIFIED | `America/New_York`, same `Intl` call both sides |
| Deterministic per-seed course | VERIFIED | `world.test.ts` asserts determinism |
| Device-clock manipulation cannot move the board | VERIFIED | Server ignores client day |
| Client clock still picks the *map* | PARTIAL | A wrong device clock draws a different map than it submits to |
| Countdown accuracy | VERIFIED | `msUntilRollover()`, repainted every 30s |

### Audio

| Item | Status | Evidence |
|---|---|---|
| Mute / unmute control | **MISSING** | No control exists in the UI |
| Audio state indicator | MISSING | — |
| Preference persisted | MISSING | — |
| Autoplay-block tolerance | VERIFIED | Context created on first interaction; `resume()` guarded |
| Focus-loss / tab-switch handling | VERIFIED | `visibilitychange` handling in `audio.ts` |
| No accumulation across restarts | UNTESTED | Needs the long-run test |

### Sharing

| Item | Status | Evidence |
|---|---|---|
| Native share with clipboard fallback | VERIFIED | `share.ts`; `AbortError` treated as success |
| Confirmation after copying | VERIFIED | Button reports `LINK COPIED` |
| Last-resort fallback | VERIFIED | Hidden textarea + `execCommand` |
| Shared URL cannot inject | VERIFIED | Params parsed as numbers; name via `textContent`; middleware sanitises |
| Preview metadata + image | VERIFIED | `og.png` 1200×630 generated at build |
| Production URL | UNTESTED | Absolute `daily-escape.pages.dev` — correct if that stays the domain |

### Platform, performance, observability

| Item | Status | Evidence |
|---|---|---|
| Long-run stability | UNTESTED | Never run beyond ~4 minutes |
| Safe-area insets | MISSING | `viewport-fit=cover` set, no `env(safe-area-inset-*)` anywhere |
| `prefers-reduced-motion` | MISSING | — |
| Landscape fits on a phone | VERIFIED | Fixed this session; verified at 740×320 |
| Service worker | N/A | None — cannot trap players on a bad build |
| Cache headers | VERIFIED | `public/_headers`: hashed assets immutable, HTML `no-cache` |
| Secrets in the repo | VERIFIED | None; `wrangler.local.toml` carries no real database id |
| Game/API version identifier | MISSING | `#buildStamp` exists in the DOM and is never populated |
| Error reporting | MISSING | Nothing leaves the browser |
| Analytics | MISSING | No counters at all |

---

*(Findings, fixes and the launch recommendation follow in later sections, added as the
pass proceeds.)*
