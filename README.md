# Daily Escape — a daily police pursuit

There is no finish line. The course keeps going, and every section it throws more police
at you, then heavier police, then faster police, then spike strips. You drive until they
box you in. The only question the game asks is *how far did you get*.

**A new map every day, and a leaderboard for it.** One shared boundary — midnight US
Eastern — so everybody is on the same course at the same time and the board is never
ambiguous.

## The daily challenge

The course generator was already seeded, so the map is derived rather than stored: the day
key (`YYYY-MM-DD` in `America/New_York`) is hashed into a seed, and the same day always
rebuilds the same course. Nothing has to be fetched to know what you are driving, and any
past or future day can be reproduced offline for testing.

The hash matters. Feeding mulberry32 `20260729` and `20260730` back to back produces courses
that open almost identically, so the date is mixed before it is used. Verified: consecutive
days differ in length and layout while the seven-theme *order* stays fixed, which is the
right split — the rhythm is learnable, the road is new.

DST is handled by asking `Intl` for the date in the zone rather than doing arithmetic on
offsets, in both the browser and the Worker. A page left open across the rollover keeps
yesterday's course until reloaded; the countdown on the intro card is what makes that
visible.

## The leaderboard

Cloudflare Pages Functions plus D1, so the API deploys from the same `git push` as the game
and there is no second vendor to hold credentials for.

| | |
| --- | --- |
| `POST /api/score` | Submit a run. Keeps only your best per day. |
| `GET /api/leaderboard` | One day's board, plus your own row if you fall outside the top 25. |
| `GET /api/leaderboard?mode=days` | Recent days, for the day picker. |

**Identity is deliberately thin**: a random id in `localStorage` plus a name you pick. That
is enough to own your scores across days without accounts or passwords. Clearing site data
loses the link, which the board says out loud rather than hiding.

### On cheating — read this before trusting the board

**The API cannot tell a real run from a fabricated one.** It rejects scores that are
physically impossible for the time claimed, requires the score to match its own breakdown,
bounds every field, decides the day server-side so nobody can post onto a map they have
already studied, and caps submissions per player per day. That stops idle tampering and
keeps a malformed request from corrupting the table.

Someone determined can still post a plausible lie. Closing that needs server-side replay of
the input stream, which needs the simulation to be deterministic — and it is not: four
`Math.random()` calls in the police logic change outcomes. That is a real piece of work and
it would also make police behaviour identical for everyone on a given day, which changes how
the game feels. Worth doing only if the board actually gets spoiled.

### Deploying it

The database and its `DB` binding are created in the Cloudflare dashboard. Two things there
are easy to get wrong and produce identical symptoms:

- **`binding` and `database_name` are different things.** The code sees `env.DB`; the
  wrangler CLI addresses the database by its own name (`daily-escape-leaderboard` here).
  Passing the binding where the name belongs fails with "couldn't find a D1 DB with the name
  or binding 'DB'".
- **Bindings are configured per environment.** A database bound only to Production leaves
  `env.DB` undefined on every branch preview, which used to surface as a bare
  Cloudflare 1101. `GET /api/health` now names both failures instead.

Once bound, the schema is applied once:

```bash
npm run db:remote
```

Locally, `npm run dev:api` serves the built site and the functions together against a local
D1 (`npm run db:local` for its schema). Plain `npm run dev` still runs the game alone on
Vite, with the leaderboard simply reporting itself unavailable.

There is deliberately **no `wrangler.toml` in the repo root**. Cloudflare Pages treats one
as the source of truth for bindings and ignores what the dashboard says, so committing it
would silently override the binding on the project. `wrangler.local.toml` is passed
explicitly where it is needed.

## Scoring

```
score = furthest distance travelled + 500 x sections survived
```

Distance is **furthest forward progress along the course**, not distance driven. Doubling
back, circling a block, taking the scenic line, or cutting across the wasteland outside the
barriers all earn nothing — the counter only moves when you get somewhere new, on the road.
A section bonus is worth roughly one section's worth of driving, so reaching the next one is
always worth about as much as the driving that got you there.

Reference points from a scripted driver that holds the road centre line, never boosts,
never fires the rocket and never dodges anything:

| | Result |
| --- | --- |
| Median of ten runs | section **5** |
| Quartiles | section **3** to section **6** |
| Best | section **7** |
| Died in the first 15 s | **0 of 10** |
| At the moment of arrest | **4.7 of 8 directions blocked** |
| Standing still from the line | arrested in **17-28 s** |
| From half meter to arrest | **0.9 s** |

The driver was rewritten for this round and the old numbers are not comparable. It used to
aim at a node 55 units away with no lane-keeping, which is fine on a fifty-unit motorway
and useless on an eighteen-unit street — on the narrowed course it simply drove into a
building at the second bend, with the police disabled. It now scales its look-ahead with
speed, corrects toward the segment centre line and brakes into corners. It still never uses
boost or the rocket, so a player has real headroom above these numbers.
| Dropped into section 18 | caught in **13 s**, 20 police on it, ~17,000 points |

Both are floors, not targets. Everything a player can do — boost, the rocket, braking,
reversing out of a pile-up, taking a line, jumping a spike strip — is upside the scripted
driver never uses. It also never sees a hazard coming, so it eats almost every one.

## Playing it online

**Live: <https://daily-escape.pages.dev>**

Hosted on Cloudflare Pages, built from this repo. Every push to `main` rebuilds and
deploys; pull requests get their own preview URL.

| | |
| --- | --- |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node version | 20 |

`public/_headers` is copied into the build and tells Cloudflare how to cache: the bundle
filename is content-hashed by Vite so it is cached forever, while `index.html` is never
cached — otherwise a deploy would be invisible to anyone who had been here before, which is
exactly the failure the build stamp exists to make debuggable.

### Connecting it (one-time)

1. <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git**
2. Authorise GitHub and pick `tragone1/daily-escape`
3. Build command `npm run build`, output directory `dist`, then **Save and Deploy**

### A custom `.dev` domain

`.dev` is a real TLD, so a name like `dailyescape.dev` has to be registered (~$12/yr;
Cloudflare Registrar sells at cost). Once it is in the account: Pages project → **Custom
domains** → **Set up a domain**. DNS and the certificate are handled automatically. `.dev`
is on the HSTS preload list, so it is HTTPS-only by definition — which Cloudflare does
regardless.

### The single-file build

The game also packs into one self-contained HTML file, for pasting somewhere that wants a
single document rather than a site:

```bash
npm run build:share
```

That writes `dist/daily-escape.html` (~110 kB, stamped with a build id shown on the start
card so a stale cached copy is identifiable at a glance) — styles, markup and the whole game
inlined, no external requests, no server needed. It is a *fragment* (no `<html>`/`<head>`),
because the host supplies the document shell. The file is pure ASCII on purpose:
without a `<meta charset>` of its own, any raw multi-byte character is at the mercy of the
serving encoding, which is what turned the HUD arrows into mojibake first time round.

## Running it

```bash
npm install
```

```bash
npm run dev
```

Opens on <http://localhost:5173>. Also `npm run typecheck`, `npm run build`, `npm run preview`.

## Controls

| Key | Action |
| --- | --- |
| `W` / `↑` | Accelerate |
| `S` / `↓` | Brake, then reverse |
| `A` `D` / `←` `→` | Steer |
| `Space` | Boost |
| `F` | Fire rocket |
| `Q` | Restart the run |
| `C` | Snap the camera behind the car |

There is no compass. There was an arrow above the car pointing at the escape gate, and the
escape gate stopped existing when the game became endless — it had been pointing at nothing
in particular for several versions.

The run does not start until you hit **Start Run** or press a driving key, so nothing is
chasing you before you are at the wheel.

The intro card lives in `index.html` and both builds share it — the shareable build used to
inject its own copy, which is two places for the same words to drift apart. The card covers
the canvas, so its button is wired in `Game` rather than in the build script; otherwise the
hosted site had no way to start at all. The first leg of the course
runs dead straight, so the car and the road agree about which way forward is — a generated
opening that turned immediately meant starting the run pointed off the road for no reason
you could see.

## The course

Procedurally generated from a fixed seed (`src/world/generator.ts`), so every player drives
the identical course and scores are comparable. 40 sections, ~21.9 km, built once at
startup — 5,400 meshes and 3,100 colliders, and the page still loads in ~130 ms.

Sections are numbered, not named. A run has no destination, so "FINAL APPROACH" was a
promise the game does not keep; the number is the honest label for how far you got.
Themes still cycle underneath in a five-beat rhythm, so you learn roughly what is coming
while the difficulty underneath makes each pass through the cycle meaner than the last:

| # | Theme | Total width | Walls | Character |
| --- | --- | --- | --- | --- |
| 1 | **Hills** | 34 | rails | Constant gradient changes. The roomiest of the tight ones. |
| 2 | **Construction** | 23 | barriers | Ramps, narrow lanes, hazard yellow. |
| 3 | **Downtown** | 18 | buildings | Cool blue-grey canyon of towers. The first real squeeze. |
| 4 | **The flats** | 64 | open | Genuinely open. The one place you get to breathe. |
| 5 | **Canyon** | 15 | rock | Warm tan rock, gravel underfoot. The tightest road in the game. |
| 6 | **Industrial** | 18 | fence | Sodium-lit asphalt, teal plant. |
| 7 | **Final** | 24 | barriers | Loose gravel, real elevation. |


Width **is** the difficulty dial, and the order is the rhythm: roomy, tighter, tight,
open, tightest. Everything used to sit between 42 and 90 units across, which made the whole
course a motorway — nothing could trap you on it, so the heavy units and the roadblocks had
nothing to work with, and a run could coast through the mid-game without ever being in
trouble.

Difficulty tightens further with depth: each section narrows by 1.4%, to a floor of 22%
below the theme's base.

The generator's one hard job is staying drivable, which it does by construction: headings
are clamped to a ±1.15 rad cone around "forward", every leg drifts back toward the course
axis, gradients ease toward a new target rather than snapping to it, and every ramp is
followed by a forced 90-unit landing apron.

### Ambush spurs

80 dead-end side roads hang off the spine, two per section — including section 1, where
they are kept off the opening legs so the first hundred metres stay clean. They exist for exactly one
reason: a walled corridor can only deliver police from directly behind or directly in
front, which turns the squad into a queue — outrun the ones behind, then meet the ones
ahead one at a time, head on, where they are trivial to dodge. A spur gives the squad
somewhere to be *waiting*, off to the side, so a unit comes out of an alley as you pass
and puts you into the far wall.

The unit inside one **waits**. Woken as an ordinary pursuer it simply drove out at once,
crossed the road and buried itself in the far wall, and by the time you arrived it was
scenery to be driven past — which is exactly what it looked like. It now holds station with
the engine running until your time-to-the-mouth matches its own, so it arrives in the road
at the moment you do.

The release is timed **late** on purpose. Arriving exactly with you means meeting nose to
nose, which is a head-on and reads as a wall; a quarter-second behind that and it comes
through your flank instead, which is the hit that actually spoils a line and puts you into
the far wall. It also **steers the strike** for the first 46 units out of the mouth. A timed launch is a
prediction and a prediction is usually a near miss — it arrives behind you or ahead of you
and either way you drive past it. Homing converts the guess into contact, and because it
aims where you *will* be, the contact lands on the flank whatever speed you are doing.

Measured across driving styles: **95% of launches connect when driving steadily, 93% while
boosting, 64% while weaving** — and a hit throws you sideways at **17.6 u/s on average**,
peaking at 37, with ten of eleven above 8. That is the T-bone into the far wall.

Measured over three runs: **92% of launches connect** and **half of all hits are side-on**,
against a hit rate of roughly zero when they simply drove out and hit the far wall. The
ambush spawn weight went from 2.5 to 6, so they arrive about three times as often.

It reads your speed **once**, at 170 units out, and commits to that estimate. Re-timing
every frame made the ambush *better* against a faster player, which is precisely backwards.
Fewer of them are sent now that each one lands — the ambush spawn weight came down from 4
to 2.5.

They are deliberately dead ends, capped with a walled, chevroned end face. An opening that
went somewhere would be a route, and a route the player can take is a route the player can
use to skip — which is the cheat the enclosed course exists to remove. Verified: a car
driven flat out at the cap of nine sample spurs stopped 2.2 units short every time and
never left the course.

### Open ground

Only Downtown is a tight corridor. Every other theme carries a **drivable shoulder** — up
to 34 units either side off-road — so running wide, cutting a corner or getting shoved off
the tarmac leaves you driving rather than hitting a fence.

Open means "a lot of ground to drive on", **not** "you can leave the course". Every section
is bounded by a continuous barrier at the outer edge of its run-off.

### There is no out of bounds

Every section is walled, and the wall is the edge of the drivable world. Most themes have
no run-off at all now — the grass lane was a literal reading of "some sections could have
grass beside the road" applied to all of them, and it made everything uniformly wide and
uniformly safe. Two themes keep a real shoulder (the flats at 20, hills at 7); the rest are
walls at the kerb.

Containment is verified rather than assumed. A car boosting straight at the boundary from
every leg, at three angles, both sides, 324 probes: 3% got out through individual gaps
where two legs meet at a sharp bend. Hunting each one across twelve thousand wall pieces is
a losing game, so the invariant is also enforced physically — outside the ribbon, outward
velocity is cancelled and the car is pushed back toward the road. With that in place, 1
probe in 120 was still outside after four seconds, longest spell 2.8 s. A firm shove rather
than a teleport, so a leak costs a moment and your line instead of resetting the chase.

### Cars sat in the road, not on it

`heightAt` returns the *centre line* of a segment, and the road ribbon was a half-unit-thick
slab centred on that — so the surface you could see was a quarter of a unit above the
surface the simulation stood the car on. Every car in the game was sunk to about half a
wheel, everywhere, for as long as the ribbon has existed. The slab, the grass apron and the
junction patches are now positioned so their **top faces** are the ground plane.

### Filling the gaps

Two bits of geometry exist purely so the world does not look like flat panes leaning on
each other:

- **Skirts.** A deep apron hangs under every road piece. Consecutive legs meet at an angle
  and at different heights, so every joint and every ramp landing used to leave a vertical
  slot you could see straight through to the void.
- **Joint patches.** The ribbons are rectangles, so where the course turns they open a
  triangular notch on the outside of the bend — a jagged step with black behind it. One
  flat patch per junction, laid at the mean of the two headings, covers it.

Spike strips are also laid *on* the road rather than level with the world now. A flat strip
on a gradient sank half its length into the tarmac at one end and floated at the other.

And segments no longer fight over the joint between them. `JOINT_TOLERANCE` lets each leg
claim a little past its own ends so a car on a joint is never off-course — but both legs
then claimed it with near-identical margins and the winner flipped frame to frame, which
reads as the ground shimmering between dirt and tarmac wherever two sections meet, and
feels as the surface multipliers switching underneath you. A segment that needs the
tolerance now ranks strictly below one that contains the point outright.

#### The joint bug this found

Consecutive legs share exactly one point, so a car sitting on a joint was — to floating
point — a fraction past the end of one and a fraction before the start of the next, and
therefore outside both. Harmless while off-course meant nothing; a real defect once it
meant a speed penalty, a frozen score and a warning on the HUD, because the course has
some two hundred joints and you cross every one. Segments now overlap their neighbours by
1.5 units. That single change took the escape rate from 14% to 3%.

It is also visible: warm scorched rust instead of the old near-black, which was the same
colour as the empty background, so the boundary between "road" and "the part that ends
your run" could not be seen until the HUD said so. Plus an amber vignette and an
**OFF COURSE** tag while you are out there.

Leaving used to be a free move, and the best one available: dip into the black, get
teleported back a second and a half later by the containment backstop, and every pursuer
you had was now somewhere else. Two changes close it. Out there you crawl — the multipliers
sit *outside* the boost bypass, so a charge cannot power through them the way it can
through mud — and the progress counter freezes, so ground made past the barriers is not
ground made. The police follow you out, and are no longer recycled for doing so.

The backstop still exists, but only for a player genuinely stranded: nine seconds, and only
while barely moving. It can never be the faster option.

### Terrain

Every effect is a plain multiplier in `CONFIG.terrain`, so the cause is always readable:

| Surface | Grip | Drag | Top speed | Accel |
| --- | --- | --- | --- | --- |
| Asphalt | 1.00 | 1.00 | 1.00 | 1.00 |
| Dirt | 0.74 | 1.20 | 0.93 | 0.90 |
| Gravel | 0.58 | 1.25 | 0.90 | 0.88 |
| Grass | 0.84 | 1.30 | 0.88 | 0.85 |
| Mud | 0.90 | 3.00 | 0.55 | 0.50 |

Slopes change forward speed by `slopeAccel × grade` per second. Ramps are **explicit**, not
emergent: crossing a marked lip above 16 u/s launches you, so a jump always happens for a
reason you could see coming. **Boosting into one multiplies the launch by 1.75**, which is
the difference between a hop and a jump — measured, a boosted launch peaks at 9 units,
hangs for 1.13 s and covers 57 units of ground, against roughly a third of that cold. The
landing apron after every ramp was lengthened to 130 units to catch it. Landing scrubs speed in proportion to the drop, capped at
32% — a jump costs tempo, never the run.

## Police

Every unit the run will ever need is built at startup and parked dormant. The director
decides how many are awake and which classes they are drawn from, both as functions of the
section you have reached.

**Headcount**: `5 + 0.8 per section`, capped at **20** — reached at section 19.

It used to be `4 + 1.1`, which asked for five units in section 2 and six in section 3 —
and the opening wave already puts five on the board, so the two sections after the start
woke *nothing*, and the game got quieter before it got louder. Sections 2 and 3 now carry
5.0 and 6.1 cars within 120 units of you, against 3.6 and 4.3 then.

The slope came *down* again once the capture meter learned to count a crowd. Eleven cars
in section 5 that could not actually finish you was the worst of both worlds — punishing
to drive through and harmless to be caught by.

### What still escalates, and when

Everything below used to stop by section 13. Past that point the only thing that changed
was police top speed, +0.22 u/s per section, and a run that survived the mid-game could
coast to section 30 without ever meeting anything new.

| | Climbs until | Then |
| --- | --- | --- |
| Headcount | section 19 | capped at 20, for frame time |
| Police top speed | section 40 | +12 u/s |
| Hazard frequency | section 24 | one every ~0.4 s of eligibility |
| **Class mix** | forever | see below |

The mix is the one with no ceiling, and it costs nothing at runtime. Each class has a
**retirement** as well as an unlock: patrols stop being dispatched after section 13,
rammers after 19, blockers after 22, interceptors after 26. Twenty cars meaning eight
patrols and some rammers is a completely different section from twenty cars meaning
heavies, elites, juggernauts, wardens and rigs — which is all you face past section 26.

Retirement also stands down stragglers rather than recycling them. Without that it did
nothing at all: recycling reuses the same car and never re-picks its class, so a patrol
woken in section 2 was still being sent at you in section 33.

Measured survival, dropped cold into a section with a scripted driver, eight trials each:

| Section | 1 | 2 | 3 | 4 | 7 | 10 | 13 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Cars active | 5 | 6 | 7 | 7 | 10 | 12 | 15 |
| Within 120 units | 3.3 | 4.7 | 5.8 | 6.4 | 7.8 | 10.3 | 12.6 |
| **Behind you** | 1.9 | 3.2 | 3.9 | 3.5 | 4.5 | 5.0 | 5.3 |

**The opening**: five units, and **none of them on the start line**. Three are up the road
facing back down it, and two are already waiting in alleys within the first 600 units. Cars
simply parked alongside you before you have touched a key read as a bug rather than as
pressure — and it was one: two of the four opening offsets were negative, and both clamped
to the first node on the spine, which is exactly where the player is.

**Class mix**: a weighted pick over whatever has unlocked, so late sections stop being
patrol soup.

| Type | Colour | Unlocks | Weight | Behaviour |
| --- | --- | --- | --- | --- |
| **Patrol** | blue | section 1 | 1.0 | Chases, rams on sight. The baseline; dangerous in groups. |
| **Rammer** | red | 2 | 1.8 | Swings to your flank, then drives through you. Carries oil. |
| **Interceptor** | magenta | 3 | 1.6 | Measures how far you'll travel in 2.2–4 s **along the road network** and takes that junction first. Carries spike strips. |
| **Blocker** | amber | 4 | 1.0 | Parks across a junction up the road. Carries spike strips. |
| **Heavy** | teal | 5 | 2.4 | 2.6× mass, slow to turn, resists shoves, takes 45% less speed loss per hit. |
| **Elite** | hot pink | 7 | 3.0 | Fast (52 top speed), short-horizon route lead, closes to a ram. Carries oil. |
| **Juggernaut** | blood orange on charcoal | 8 | 3.4 | The armoured wrecker. 5× mass, a metre wider, `impactResistance` 0.35 and `pushResistance` 2.4 — hits barely slow it and shoves barely move it. Only a near-direct rocket wrecks one. Its `contactBoost` is only 1.1: see below. |
| **Warden** | amber on charcoal | 10 | 2.2 | 4× mass SUV. Alternates a head-on charge and a flanking sweep. |
| **Rig** | hazard yellow on charcoal | 6 | 2.6 | Nine metres of armoured transport. Does not chase — parks broadside across the tightest point ahead of you. See below. |

**Speed**: everything gains `0.22 u/s` of top speed per section, capped at `+7`.

**Closing speed**: a unit the player has *left behind* gets up to +38% top speed and
acceleration, scaling in from 55 units of separation to 210. Without it, being passed once
was permanent — police top speeds sit barely above yours, so a clean driver simply drove
away from the whole squad and only ever met the cars spawned in front. It is deliberately
one-directional: a car coming the other way gets nothing, because handing an oncoming unit
closing speed as well turns every head-on into an unavoidable wall.

### Nothing vanishes

Every reposition the director makes is a teleport — recycling a straggler, standing down a
retired class, pulling a car back to cover your rear. The rules only ever checked where a
car was *going*, never where it was coming from, so a unit could pull out of a spur beside
you, drive for a second and blink out of existence while you watched.

A unit within 190 units and in line of sight is now never moved, retired or stood down,
whatever else the director wants; the stuck-recovery teleport is likewise held back while
you can see the car, which keeps working the reverse-out instead. A car struggling against
a wall is at worst untidy. The same car disappearing is plainly broken. Measured over three
and a half minutes of driving: **74 repositions, 0 of them visible.**

### Where they come from

Placement matters as much as headcount, and is picked per spawn:

| Mode | Weight | Where |
| --- | --- | --- |
| **Ambush** | 4 | Parked deep in a dead-end spur 35–230 units up the road, nose at the mouth |
| **Side** | 2 | Out in the run-off, up to 65% of the way across the shoulder |
| **Behind** | 2 | 105–225 units back down the spine |
| **Ahead** | 1 | 130–265 units up the spine |

Modes fall through in order if the first choice has nowhere to put the unit — a walled
section has no run-off to sit in, and there may be no spur in range. Nothing else about an
ambusher changes; it wakes up chasing like any other unit. The whole effect comes from
where it was standing when it did.

Common to all of them: never within 80 units, never in your line of sight unless it is
more than 165 units away (the open sections have nothing to hide behind, and requiring
concealment outright left them empty), never on top of another live unit, and any unit
that falls 260 units behind is recycled forward rather than left trailing.

And — the one that took the longest to notice — **the unit has to be able to drive out of
where it is put**. "Clear ground with the player in sight" is not the same thing: a guard
rail is two units tall, so it blocks a car completely while blocking sight not at all, and
a lateral spawn on the far side of one produced a car that spent the entire encounter
driving into a fence. `CollisionWorld.canReach` casts against *solid* colliders rather than
tall occluders and is the test that question actually needed. Measured over ten runs, it
vetoes **36% of otherwise-valid spawn spots**.

### The rig

A nine-metre armoured transport that does not chase you at all — and no longer *travels*
to its post either. It is placed 260–700 units up your route, already in position and
already broadside, out of sight. Waking it behind the player and having it race past to set
up was both unconvincing for a transport and the reason three of them could end up stacked
in the same pinch; **one blocks at a time**, and once you are 70 units past, it stands down.

It picks the tightest point it can find with at least 19 units of free width, and it is
slow (38 u/s) because it never has to catch anybody. Measured: **1 at a time**, **all of
them first seen ahead of the player**, broadside **93%** of the time they are stopped.

| | |
| --- | --- |
| Scouts | 210-620 units up your route |
| Picks | the narrowest **free width**, measured by ray, not the section's nominal width |
| Mass | 8.0, effective 17.6 against a shove — a wall at cruising speed |
| Top speed | 38 u/s — it never has to catch anybody |

It will not park anywhere narrower than **19 units** of free width. Twelve metres of
vehicle broadside across the fourteen-metre canyon sealed the road outright, and with no
rocket in hand that is a dead run rather than a hard corner. It now stands where there is
still a car's width to fight for.

**It is not a dead end.** Boosting into one shoves at 2.6x, which is enough to barge a gap
in a road it has closed; and wrecking it drops its effective mass from **17.6 to 0.22** —
lighter than your own car — so the hulk can simply be pushed aside. A multiplier could not
do that job: at eight tonnes even a tenth left it heavier than the player, so blowing up a
roadblock produced a roadblock. Being stopped by geometry you have no answer to is the one
kind of loss with no play in it.

"Tight" has to mean the actual gap between the walls, cast by ray — a section's nominal
width barely varies along its length, so scouting on that picked spots no better than at
random.

### Boxing in

Left to themselves every unit drives at the player, which produces a scrum: everyone
arrives at the same point from the same direction, the collisions cancel, and being shoved
somewhere is being freed. The director now hands the six nearest units a **station** around
the player instead — front, both front quarters, both flanks, rear — and they hold it,
matching pace rather than charging, closing the offset once they are on it. The forward
stations are a brake-check, and they are the reason a fast player has to slow down.

Units on station **match your pace** rather than charging it: ahead of you they run at 0.9×
your speed and let you close — that is the brake-check — and behind you they run at 1.12×
and push. Pace matching only applies **once a unit has reached its station**, which was a
real bug and the reason the squad read as shoving you along from behind: a car given a
front station while still behind you had its speed capped *below* yours, so it could never
overtake to take the station it had been given.

**When you slow below 22 u/s the front stations are filled first, by the units currently
behind you** — they have to overtake to take them, which is exactly the manoeuvre that was
missing. Measured, stopping dead in a corridor now leaves 4.4 units ahead of you against
0.4 behind, and gets you arrested 11.8 seconds later. Without that the box read as ordinary traffic, because everyone arrived at their
spot flat out and immediately left it again.

There are **eight** stations, one per enclosure sector, because the loss condition counts
directions blocked and six stations could only ever close six of eight — a perfectly
executed box still left two ways out and the arrest could not finish.

Something is also always **behind** you. Ambush and side placements both tend to land in
front and the recycler pulls stragglers forward, so deep sections could quietly end up with
the entire squad ahead and nothing at your back. Below three units behind, the one furthest
up the road — the one doing least — gets sent back. It *moves* a car rather than adding
one; waking a fresh unit there ignored the headcount target and ran every 0.4 s, which put
fifteen cars in section 3 against a target of six and took the whole difficulty curve with
it.

### Closing for a hit

A pursuer used to solve an intercept and drive at it flat out, which is why they read as
blasting past with a token swerve. Two changes, and the honest summary is that one of them
worked and one of them was mostly wrong:

- **Turn-in.** Inside 17 units a unit aims *through* the player rather than at an intercept
  point, so the last movement is a turn into you rather than a pass beside you.
- **Overtake cap.** Capped how much faster than you a unit may travel *along* your line.
  Applied to everyone in range this cost a third of all contact — reined in, they simply
  stopped arriving — so it now applies only to a car that has genuinely got past and is
  pulling away.

Measured together: contact goes from 60 to 64 a minute. A real improvement, and a small
one; the honest reading is that the fly-by was less of the problem than it looked.

### The charge

The squad's melee move, available to rammers, heavies, elites, juggernauts and wardens.
Ordinary contact is incidental — cars bump because they are all in the same place. A charge
is a decision: from 9–46 units out and roughly lined up, the unit's strobe **stops and both
lamps go hard on** for 0.45 s, then it commits for 1.1 s at +30% pace and **2.3× shove**.

The wind-up is what makes it fair. Without it, being hit hard is noise; with it, the solid
lights in your mirror are something you can read and turn out of. One charge per unit per
6.5 s.

Contact is capped in the other direction too: the total speed the player can lose to car
contact in one frame is clamped at 50%. Contacts resolve pair by pair and each scrubs a
share of what is left, so four units arriving together used to compound to 43 u/s → zero in
two frames with no input that could recover it. Being hit hard should cost you the corner,
not the run.

### Being surrounded

A run ends one way, and the rule is about **directions**, not cars:

```
the circle around you is cut into 8 wedges
a wedge is blocked when a live unit sits in it within 15 units
below 4 blocked, nothing happens however slow you are
at 5 blocked, the arrest runs at full speed - and it takes 1.4 s
```

Counting cars was the wrong measure entirely. Two heavies leaning on your bumper is two
cars and *one* direction, and it used to end runs while the road ahead was wide open — so
losing felt arbitrary, and the thing that should be the whole fantasy, being buried in a
scrum and squeezing out through a gap, could never happen, because the meter had already
run out. Directions are what "no way out" means.

Measured at the moment of arrest, across ten runs: **5.3 of 8 directions blocked, player
doing 6.8 u/s**. That is genuinely ringed and genuinely stopped.

**The bar did not want lowering; the clock did.** Dropping the threshold to two blocked
directions produced arrests at 3.3 of 8 — a couple of cars on one side, which reads as
arbitrary. Halving the *duration* instead keeps the same "genuinely ringed" requirement and
removes the thing that was actually wrong: at 2.2 s you could let the scrum form around you,
wait for everyone to settle, and then fire the rocket and walk out. The rocket has to be
spent before the box closes or as it is closing, on a read rather than on a certainty.

Measured: **0.9 seconds** from the meter passing halfway to the arrest, and arrests landing
at **4.7 of 8 directions blocked**.

The speed it tests is smoothed over 0.55 s. Being surrounded is a constant sequence of
impacts and every impact spikes your speed for a few frames; tested instantaneously that
read as "escaping" over and over, so a player who had actually come to a stop watched the
meter reset every time somebody hit them.

### Why a stopped player could not be surrounded

Stopping dead at the start line produced a run of cars arriving, shoving, and wandering off
again: measured, an average of **2.1 of 8 sectors blocked**, the pin breaking **twelve
times** in half a minute, and half a minute to lose. Three separate causes, all of them the
squad dismantling its own work:

- **The stuck detector.** A car pressed against a stationary player is, by definition,
  moving slowly — so it registered as stuck, reversed out of the sector it was blocking,
  and after three and a half seconds teleported away entirely. Sitting on somebody is the
  job, not a fault; anything within 15 units of the player is now exempt.
- **The pace floor.** Units on station held a floor of 14 u/s regardless of the player, so
  against a stopped car they kept driving *through* the ring at 14 and bounced off. The
  floor is now capped to just above the player's own speed.
- **The shove.** The fixed impulse that makes contact read as forceful during a chase
  scatters a ring once the player has stopped. Below 12 u/s it drops to 12% and the bounce
  with it, so cars nestle in and stay.

Measured after: the pin now breaks **zero** times, the ring builds monotonically 1 → 2 → 4
→ 5 sectors, and standing still ends the run in **22 seconds**.

### Losing your speed is the punishment

Nothing in the game kills you directly. Spikes, a slick, a heavy hit, a rig across a
narrow pass — none of them end a run. What ends it is the ten seconds afterwards, while
everything that was chasing you gets to arrive and stand somewhere you needed to be.

That is wired explicitly: below 22 u/s the box closes **faster and further**, up to 92% of
the way in. It is why the boost meter is the thing you find yourself watching.

### Always a line to take

A hazard is a decision, and a decision needs an alternative. Laid at a fixed width they
covered the entire carriageway in the narrow sections, where there is no line to take and
running one over is simply what happens - which is not a hazard, it is a toll. Every strip
and slick is now clamped to 62% of the local road half-width with a minimum gap enforced on
top. Measured across the course, the tightest gap any hazard leaves is **3.4 units** against
a car 2.1 wide.

### Screen flash

The white pop was designed for one-off moments — a boost, a detonation — and then contact
became near-constant by design, at which point a flash weighted for a rare event sat over
the whole back half of a run as a permanent veil. It is now a fifth of its old weight on
contact, gone entirely on oil, decays twice as fast, and cannot accumulate past 0.3.

## Police deployables

The only way the police can hurt you without touching you — and it is strictly a
consequence of losing the lead, because only a unit that has got **45–190 units ahead of
you** can lay one.

| | From | Effect | Duration |
| --- | --- | --- | --- |
| **Spike strip** | section 4 | Top speed **×0.34**, grip ×0.55 | **6.0 s** |
| **Oil slick** | section 6 | Grip **×0.0008** (×0.0002 boosting) + spin, **no speed penalty** | **5.5 s** |
| **Charge** | any | 2.3× shove, 0.45 s telegraph | see above |

Two different problems. Spikes take your pace and hand the squad the seconds they need to
pin you. Measured: a car at 44 u/s is down to **11 u/s within a second** and held there for
six and a half. That last part needed a separate fix — the strip always cut top speed to a
quarter, but the *gentle* overspeed decay meant a fast car took two and a half seconds just
to reach the new ceiling, so most of the effect was spent coasting at a speed the strip was
supposed to have taken away. Shredded tyres now scrub rather than glide. Oil leaves you fast and unable to point the car, which is far worse going into a
corner than on a straight.

Oil's grip multiplier had to go almost to zero to mean anything. At 0.3 the lateral damping
still pulled the car straight inside a corner's worth of time, so a slick was something you
could drive over and ignore. At **0.03** the velocity keeps pointing where it was pointing
while the nose turns — you steer and, for the better part of two seconds, nothing happens.

Slicks are rarer than they were — carried by rammers alone, on a cooldown 2.6x the shared
one — because the more disruptive of the two hazards was also much the cheaper to lay, so
it turned up constantly and stopped reading as an event. Rarer and nastier is the better
trade.

They are half again as wide as they were, and built to be *seen*: a near-black
puddle on near-black asphalt is invisible, which is how the slick spent several versions
being something players drove over without ever learning why the car went sideways. It now
reads by contrast — an iridescent sheen over the pool and a hard bright rim around it.

The slick takes **no speed off you at all**. A liquid does not slow a car down, it stops it
steering, and taking pace off as well muddled what the hazard was for — it read as a weak
spike strip. All of its weight is in control now: you keep every unit of speed you had and
almost none of your ability to point the car.

Low grip alone only makes a car understeer in a straightish line. Some of the sideways
slide is now converted into **yaw**, which is what lets it actually come round: and it scales with how hard you are
driving, because yaw is fed by the steering input as well as by the slide:

| On a slick | Rotation |
| --- | --- |
| Quarter lock, feathered | 24° |
| Full lock | 93° |
| Full lock, boosting | **182° — a complete spin** |

**Boosting on oil does not rescue you.** Grip drops a further 65% while the charge burns:
power with no traction is the definition of a slide, and this is the one moment in the game
where the answer to everything else is the wrong move.

Both are answerable, which is the point — a hazard you cannot avoid is just damage. They
cover most of the road and never all of it, they take a moment to arm, they glow, and you
can jump one clean if you are airborne over it.

Tyre damage sits **outside** the boost terrain bypass. Boost is the answer to terrain;
making it the answer to spike strips as well would leave the squad's only ranged weapon
meaning nothing to anyone holding a charge.

Headcount and top speed both have to be capped — frame time and fairness — so hazard
frequency is the difficulty screw with no ceiling on it. Both cooldowns shrink 5.5% per
section down to 30% of base, and by the late sections the road ahead of you is being
carpeted.

## Boost and the rocket

There are no boost refills — it is purely cooldown-gated (1.6 s of burn, 7.5 s cooldown).
What makes it worth saving is that it is the **answer to terrain**, not a generic speed
button: while it burns you are fully impervious to surface penalty
(`boostTerrainBypass: 1.0`) and 65% of a climb's speed penalty is cancelled.

One direct hit wrecks a car outright and throws it **18 units at a peak of 58 u/s**. It used
to barely shift them, for a reason that had nothing to do with the blast: forward speed was
hard-clamped to the engine's ceiling every single frame, which deleted the along-the-car
component of any external impulse on the frame it landed. Blasts could throw a car sideways
and nowhere else, so wrecks slumped where they died and firing the rocket at a roadblock
built you a better one. The ceiling is now something the car settles back to rather than a
wall it is snapped against.

Three things keep it a kick rather than a launch. The blast damps hard above
`wreckCoastSpeed` and not at all below it, so a hulk is thrown clear and then stops instead
of sliding half a section. Its `pushResistance` drops to 0.1 on death, so you can shove one
about 18 units in three seconds of pushing rather than being walled in by your own kill.
And `selfImpulseScale` is **zero**: your own rocket does not knock you backwards. That was
the one part of the explosion that punished you for using it well, in a game about not
losing momentum. The camera shake sells the concussion instead.

You start with one rocket and can carry two. Ammo turns up regularly, and **two out of
every three sit out in the run-off**, well off the racing line: you have to leave the
tarmac, lose grip and lose time to take one, with the squad on you. The other third sit
mid-road and are simply free. Most rockets should cost you something, but a player who
never gambles should still see one occasionally.
It homes onto the most on-target live unit inside a 0.95 rad cone, wrecks anything within
14 units of the blast and throws anything within 24. It is a one-or-two-per-run superpower,
so the decision is *when* to spend it, not whether it will work.

## Code structure

```
src/
  config.ts              every tuning value, nothing else
  game.ts                system wiring + main loop
  state.ts               progress, score, capture meter, best
  world/
    generator.ts         seeded course generation, incl. ambush spurs  <- shape it here
    course.ts            section index, spurs, pickups, constants
    terrain.ts           height / surface / slope sampling, ramp launches, progress
    courseBuilder.ts     segments -> meshes, colliders, props, walls
    navGraph.ts          route network generated from the spine + A* routing
    pickups.ts           rocket ammo (boost has no refills)
  gfx/                   the renderer: math3d, primitives, renderer (no engine dependency)
  vehicle/vehicle.ts     arcade model incl. elevation, surfaces, jumps, tyre damage
  police/                behaviors (goal selection) + policeCar (driving)
                         + policeManager (escalation) + hazards (deployables)
  physics/               SAT collision, oriented + height-aware colliders, spatial grid
  weapons/rocket.ts      projectile + layered explosion
  camera/, ui/, audio.ts, input.ts, player/
```

## Performance

Endless mode made the world an order of magnitude bigger than the fixed course, and every
per-frame cost is multiplied by a squad of up to 20. Two things had to change:

- **Broad phase.** Static colliders are bucketed into a uniform spatial hash
  (`physics/spatialGrid.ts`). Collision resolution, line-of-sight and the police avoidance
  feelers all query cells instead of scanning 3,100 colliders.
- **Routing.** A* with a binary heap replaced the flat Dijkstra scan. The straight-line
  heuristic keeps the search inside a corridor around the direct line, which matters when
  twenty units re-plan several times a second. `nodeAtProgress` is a binary search over a
  sorted spine index rather than a linear scan.

Measured simulation cost, fixed 60 Hz timestep, excluding render: **0.14 ms/frame** at ten
police, **0.36 ms/frame** at twenty — about 2% of a frame budget in the worst case.

## Browser support

**WebGL2 is the hard requirement.** Safari only shipped it in version 15 (macOS Monterey);
before that it was experimental or absent. Everything else degrades.

The renderer has always thrown a clear message when WebGL2 is missing — but nothing caught
it, so on an unsupported browser the game presented as a black screen and the person looking
at it had no way to know why. That is the actual bug, and it is fixed in two parts:

- **`#bootError`, in every build.** An inline classic script catches `error` and
  `unhandledrejection`, prints the message and the user agent on the page, and after six
  seconds says so explicitly if the bundle never ran at all. Plain ES5 on purpose: it has to
  work when the module bundle itself fails to parse, which is precisely the case on an engine
  missing syntax the bundle uses. It previously existed only in the shareable build.
- **An explicit WebGL2 probe before the game is constructed**, which distinguishes "this
  browser has no WebGL2" from "it has WebGL2 and refused a context" — the second is usually
  hardware acceleration being off — and says what to try.

Four smaller compatibility hazards found in the same audit and fixed in `src/compat.ts`:

| Hazard | Floor | Why it mattered |
| --- | --- | --- |
| `/\p{L}\p{N}/u` as a literal | Safari 11.1 | A **parse-time** SyntaxError takes the whole bundle down, not just the name check. Built with `new RegExp` in a try/catch now, falling back to Latin-plus-accents. |
| `replaceChildren` | Safari 14 | Called every time the leaderboard opens. `setChildren` falls back to remove-and-append. |
| `Intl` with `timeZone` | wide, but not universal | Called at module load to pick the day's map, so a throw meant no game at all. Falls back to the US DST rules — verified identical to `Intl` for all 26,304 hours of 2026-2028, both transitions included. |
| `DailyUi` construction | — | It looks up a dozen elements and throws if one is missing. As a class field initializer that killed the whole `Game` constructor, so a broken leaderboard meant a black screen rather than a playable game without a leaderboard. Now caught. |

Index widths were checked and are correct: the baked world batch uses `Uint32Array` with
`UNSIGNED_INT`, which it must, since it is far past 65,535 vertices. `#version 300 es` sits at
byte zero of both shader sources, which Safari requires and Chrome does not.

## Rendering

There is no 3D engine dependency. `src/gfx/` is a ~600-line WebGL2 renderer written for
this game specifically: flat-shaded primitives (box, cylinder, sphere, torus, plane), one
hemispheric + directional light, linear fog, and a scene graph three levels deep.

It replaced Babylon.js, which was 1.5 MB of a 1.55 MB shareable build — large enough that
the published page silently refused to run its own scripts. The same build is now ~105 kB.

**It is left-handed**, matching the simulation: at heading 0 the car's forward is +Z and
its right is +X. Using the usual right-handed GL convention renders the entire world
mirrored — the car still steers correctly in world space, but on screen it appears to turn
the wrong way. Handedness has to follow the simulation, not the graphics convention.

The one trick worth knowing: all 5,400 pieces of scenery are baked into a single vertex
buffer at startup (`Renderer.bake()`), so the entire course costs one draw call and only
cars and effects are drawn individually. Static meshes must not move after baking.

Swapping the renderer changed no gameplay numbers at all, because the simulation never
depended on the engine.
