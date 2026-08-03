# Daily Escape — pre-launch audit

**Audit start:** `4e7b546` (tag `known-good-2026-08-03`)
**Audit end:** `ab0c6d8`
**Currently live:** `origin/main` = `2c02e56` — an older build. **Nothing from this pass or the preceding session is deployed.**

---

## 1. Executive summary

The game was in better shape than a checklist of this size implies. Ordering and
tie-breaking are deterministic, names are allowlisted server-side and rendered as text,
SQL is parameterised, the day is server-authoritative, the boot path already detects
WebGL2 failure and a bundle that never ran, and there is no service worker to trap anyone
on a broken build. Those were verified and left alone.

Six genuine gaps were found and closed: no mute control, no network timeout, no version
identifier, no Unicode normalization or profanity handling, no moderation path, and no
telemetry. One real bug was found by the long-run test — the streamed world was holding
four copies of its scenery.

**158 automated assertions pass, typecheck is clean, production build succeeds.**

---

## 2. Recommendation: **CONDITIONAL GO**

The conditions are not code. They are three things I cannot do from here:

1. **Play it.** Nobody has. Every result in this document is synthetic — railed players and
   simulated frames. The deep-game difficulty numbers in particular are reasoned, not
   play-tested.
2. **Open it on a real iPhone and a real Android.** Safe-area insets, touch controls and
   the landscape layout have been verified only by resizing a desktop browser.
3. **Decide the leaderboard question** in §9.

Ship after those. The code is ready; the evidence about how it *feels* is not.

---

## 3. Critical blockers

**None outstanding.** One was found and fixed during the pass:

- **Streamed world held four copies of the scenery.** Of the two passes that build a wall,
  only the collider rail was scoped to the window being built; the block *meshes* were
  emitted for the whole course by every window. Four resident windows meant 229,000
  resident triangles against the 118,000 of the fixed world it replaced — a streaming
  system that cost more than what it replaced. Now 43,000 and flat. Fixed in `1d41c67`.

---

## 4. High-priority issues found and fixed

| Issue | Evidence | Fix |
|---|---|---|
| No mute control | Audio started on first interaction with no way to stop it | Master-gain mute, persisted, `aria-pressed` (`7c25273`) |
| `fetch` had no timeout | A hung request left "Sending…" until the tab closed | 10s abort, retryable vs verdict distinction (`84fc57c`) |
| A failed submission was lost | Dropped connection at the end of a good run lost it | Best run held locally, offered back same-day only (`84fc57c`) |
| No build/API version | "It went black" was unactionable; stale clients invisible | Commit stamped in, shown on the card, sent with scores (`6313335`) |
| Non-Latin names rejected | `checkName("日本語")` returned false | Letter check runs on the name, not folded ASCII (`7c8be0d`) |
| Scunthorpe problem | `checkName("Scunthorpe")` returned false | Slurs blocked anywhere; mild profanity whole-word only (`7c8be0d`) |
| No moderation path | Nothing could be taken down | `POST /api/moderate`, secret-authenticated, constant-time (`7c8be0d`) |
| No telemetry | Nothing left the browser on failure | Errors + 9 counters to Worker logs (`ab0c6d8`) |
| No safe-area insets | `viewport-fit=cover` put the HUD under the notch | Insets on edge-pinned elements (`ab0c6d8`) |
| 168ms frame hitch | Long-run test, every ~13s of play | Build window 4 sections → 2; max now 94ms (`1d41c67`) |

Three of these were faults **in my own new code**, found by writing the tests rather than
by reading it: the non-Latin rejection, the Scunthorpe problem, and the scenery duplication.

---

## 5. Medium priority — not done, with reasons

- **94ms hitch remains** when a window builds (0.07% of frames). Halved already; removing it
  needs the build spread across frames via `requestIdleCallback`. Deferred as a real change
  to a system that currently works.
- **`segments` array grows** with run length (8,571 at 13 min ≈ 2MB; ~8MB at an hour). Bounded
  and small, but not constant. The fix is a windowed segment array, which touches progress
  bookkeeping everywhere.
- **`policeCar.ts` `update()` is 922 lines.** Splitting it needs coverage of the spin-out, rig
  and weld paths first; thin coverage on this file has already caused two bugs.

## 6. Low priority

- Leaderboard errors surface raw `err.message` in one place.
- No explicit loading indicator during the ~100ms world build.
- No `prefers-reduced-motion` handling.

---

## 7. Verified and deliberately left alone

Deterministic ordering and tie-break (`score DESC, updated_at ASC` — earliest to reach a
score ranks higher) · own-rank-when-outside-top · `textContent` rendering · parameterised
SQL · server-authoritative day · score-vs-breakdown consistency · 130 pts/s rate ceiling
(measured max sustained 86, ~100 deep) · duplicate-click guard · `guarded()` wrapper turning
1101s into readable JSON · WebGL2 detection · boot watchdog · cache headers · no secrets in
repo · no service worker.

## 8. Added this pass

`src/telemetry.ts`, `src/version.ts`, `functions/api/names.ts`, `functions/api/moderate.ts`,
`functions/api/telemetry.ts`, plus tests. 22 files changed, +1,234 lines.

**Tests added:** 32 (10 network/retention, 15 name validation, 7 telemetry). **Total 158
across 9 files.** Typecheck clean; production build succeeds (183.34 kB / 62.56 kB gzipped).

---

## 9. Decisions needed from you

1. **The leaderboard mixes incomparable scores.** The old course capped at 43,044; it is now
   endless. A 60k today does not mean what a 40k meant last week. Reset the board, start a
   new season, or accept the mix?
2. **`MODERATION_SECRET`** must be set as a Cloudflare Pages secret before `/api/moderate`
   works. It refuses everything until then — deliberately, so an unset variable is never an
   unlocked door.
3. **Per-IP rate limiting** is not implemented. `playerId` is client-generated and rotatable,
   so the 400/day cap is not a real bound. Recommend a Cloudflare Rate Limiting rule on
   `/api/score` — dashboard configuration, no code.

## 10. Remaining limitations — stated plainly

**The game is not cheat-proof and cannot be made so in a browser.** The server rejects
impossible scores and decides the day itself, which stops casual tampering. A patient
cheater who submits plausible scores at a plausible rate will succeed. Closing that needs
server-issued run tokens and replay validation, which needs a deterministic simulation —
which this is not.

---

## 11. Manual test checklist

- [ ] Safari on macOS — the black-screen history is here
- [ ] iPhone Safari: portrait, landscape, notch clearance, home indicator
- [ ] Android Chrome
- [ ] Touch: accelerate + steer + boost + rocket simultaneously
- [ ] Mute, reload, confirm it persisted
- [ ] Lock the phone mid-run, unlock, confirm audio and input recover
- [ ] Switch tabs mid-run and return
- [ ] Turn off wifi at the end of a run → expect "Saved", then retry with wifi on
- [ ] Reload after a failed submission → expect "SUBMIT SAVED RUN"
- [ ] Share on mobile (sheet) and desktop (clipboard); check the preview card
- [ ] Play past section 25 and judge whether the escalation feels fair
- [ ] Roll a test deployment back
- [ ] `POST /api/moderate` with the secret set; confirm a row disappears

## 12. Rollback and recovery

```bash
# This audited build
git reset --hard ab0c6d8

# Before this audit pass
git reset --hard known-good-2026-08-03

# The pre-experiment game
git reset --hard live-before-flow-model

# Revert production to what is live right now
git push --force-with-lease origin 2c02e56:main
```

Cloudflare Pages keeps every deployment — roll back from the dashboard without touching
git. **D1 is unaffected by any of the above:** the schema is unchanged this pass, so no
migration needs reverting and no leaderboard data is at risk. Take a `wrangler d1 export`
before the first deploy that does change the schema.
