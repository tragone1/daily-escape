# Daily Escape — endless police pursuit

There is no finish line. The course keeps going, and every section it throws more police
at you, then heavier police, then faster police, then spike strips. You drive until they
box you in. The only question the game asks is *how far did you get*.

A feel prototype: no daily generation, no backend, no leaderboard.

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
| Median of twelve runs | caught at **96 s**, section **6**, ~5,500 points |
| Best of twelve | **121 s**, section **7**, ~6,600 points |
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
| `R` | Restart the run |
| `C` | Snap the camera behind the car |

The run does not start until you press a driving key (or hit **Start Run** on the shared
build), so nothing is chasing you before you are at the wheel. The first leg of the course
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

| Theme | Surface | Walls | Run-off | Character |
| --- | --- | --- | --- | --- |
| **Downtown** | asphalt | buildings | none | Tight walled corridor. |
| **Construction** | dirt | barriers | 12 | Ramps, narrow lanes. |
| **Hills** | asphalt | rails | 20 | Constant gradient changes. |
| **Off-road** | dirt | open | 34 | Widest; road is the fast line, not the only line. |
| **Final** | gravel | fence | 14 | Loose surface, moderate width. |

Difficulty tightens with depth as well as breadth: each section narrows the road and its
run-off by 2%, to a floor of 35% narrower than the theme's base.

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

### The wasteland

Past the barriers there is ground, and you can drive on it. You just should not want to.

| | On the course | Outside it |
| --- | --- | --- |
| Your top speed | 39 u/s | **9 u/s** |
| Police top speed | 46 u/s | **42 u/s** |
| Progress banked | yes | **none** |

The penalty is one-sided on purpose. Slowing the police out there too just moved the
stalemate past the barriers — everyone crawled, so leaving cost nothing. At a third of
their pace with the whole squad still at full speed, the wasteland is somewhere you get
caught, which is the entire point of it.

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
emergent: crossing a marked lip above 17 u/s launches you, so a jump always happens for a
reason you could see coming. Landing scrubs speed in proportion to the drop, capped at
32% — a jump costs tempo, never the run.

## Police

Every unit the run will ever need is built at startup and parked dormant. The director
decides how many are awake and which classes they are drawn from, both as functions of the
section you have reached.

**Headcount**: `6 + 1.15 per section`, capped at **20**.

It used to be `4 + 1.1`, which asked for five units in section 2 and six in section 3 —
and the opening wave already puts five on the board, so the two sections after the start
woke *nothing*, and the game got quieter before it got louder. Measured, sections 2 and 3
now carry 5.5 and 6.5 cars within 120 units of you, against 3.6 and 4.3 before. The fix is
a higher base with a shallower slope rather than a steeper slope: raising the rate filled
the early sections but compounded all the way up and cost a quarter of the median run.

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
| **Juggernaut** | blood orange on charcoal | 8 | 3.4 | The armoured wrecker. 5× mass, a metre wider, `impactResistance` 0.35 and `pushResistance` 2.4 — hits barely slow it and shoves barely move it, and it hits back at 1.8×. Only a near-direct rocket wrecks one. |
| **Warden** | amber on charcoal | 10 | 2.2 | 4× mass SUV. Alternates a head-on charge and a flanking sweep. |

**Speed**: everything gains `0.22 u/s` of top speed per section, capped at `+7`.

**Closing speed**: a unit the player has *left behind* gets up to +38% top speed and
acceleration, scaling in from 55 units of separation to 210. Without it, being passed once
was permanent — police top speeds sit barely above yours, so a clean driver simply drove
away from the whole squad and only ever met the cars spawned in front. It is deliberately
one-directional: a car coming the other way gets nothing, because handing an oncoming unit
closing speed as well turns every head-on into an unavoidable wall.

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

## Police deployables

The only way the police can hurt you without touching you — and it is strictly a
consequence of losing the lead, because only a unit that has got **45–190 units ahead of
you** can lay one.

| | From | Effect | Duration |
| --- | --- | --- | --- |
| **Spike strip** | section 4 | Top speed ×0.5, grip ×0.72 | 4.0 s |
| **Oil slick** | section 6 | Grip ×0.3, speed untouched | 2.8 s |
| **Charge** | any | 2.3× shove, 0.45 s telegraph | see above |

Two different problems. Spikes take your pace and hand the squad the seconds they need to
pin you. Oil leaves you fast and unable to point the car, which is far worse going into a
corner than on a straight.

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
