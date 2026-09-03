# Chance of Precipitation — Descent Protocol · Project State

Handoff summary. Paste this into a new chat to continue work.

---

## What it is

A 3D action roguelike in the vein of *Risk of Rain 2*. Kill enemies for gold, spend gold on
chests, collect stacking items, and try to out-scale a difficulty curve that rises with
elapsed time. Runs pay out **Echoes**, a meta currency that permanently widens the item pool
and unlocks weapons and characters. Now also playable **co-op, up to eight**.

**Stack:** three.js (vendored, r169) + plain ES modules. **No build step, no bundler, no
dependencies** — every texture, icon, sound effect and note of the score is generated
procedurally at runtime, and the multiplayer relay is hand-written Node. The only binaries in
the repository are three authored character meshes under `assets/models/`; everything else,
including every other model in the game, is built from primitives at runtime.

**Run it:** `node tools/serve.js` (or double-click `play.cmd`) → http://localhost:8080. npm is
optional — `npm start` only forwards to that command, and there are no runtime dependencies to
install. The server also hosts co-op on the same port and prints the LAN address to give
friends; `MULTIPLAYER.md` covers playing with people outside your network. `npm run check` parses every module
without a browser. Open the folder in VS Code and press **F5** to launch with the bundled
config.

---

## Controls

All rebindable from Settings → Controls, onto keys or mouse buttons. Defaults:

| Input | Action |
| --- | --- |
| `W A S D` | Move — camera-relative, not character-relative |
| Mouse | Look (click canvas to capture pointer) |
| Left click | Weapon primary |
| `Q` | Weapon secondary (hold to charge where applicable) |
| `Shift` | Character utility |
| `R` | Character special |
| `F` | Character ultimate — no cooldown; charges from kills and damage taken |
| Right click | Aim (pulls camera in, narrows FOV) |
| `E` | Interact — chests, shrines, eggs, the Beacon, the rift |
| `Enter` | Chat, and the run log |
| `Esc` | Pause — in co-op this only frees the mouse; the world keeps running |

**The camera and the body are decoupled** (Risk of Rain 2 style). The mouse drives `camYaw`
and `camPitch` and nothing else; `player.yaw` is the body, and it faces the travel direction
while free-running, snapping to the camera only when the weapon has to point at the crosshair
— firing, aiming, charging, or an ability. Anything that used `player.yaw` as "where you are
looking" now uses `camYaw`; the rig gets both plus a `lookYaw`, and splits the difference
across the head and chest.

---

## Content

- **9 characters** — Vanguard (baseline), **Unloader** (a slow, committed punch off
  alternating fists; grapple + momentum punch, the Loader-alike), Wraith (glass cannon; twin
  blades worth four times as much at the hilt as at the tip, blink, and two seconds of being
  neither hittable nor findable), Bulwark (tank; an eight-round shotgun that reaches 15m and a
  shield he can simply hold up), **Halcyon** (flies; a white beam with no falloff at any
  range, impact bombs, low health and negative armour), **Dasher** (a three-hit lance combo
  ending in a longer thrust, a half-second parry, and a look-directed piercing dash that
  refunds itself on a marked hit; the thinnest frame in the game and the hardest hitting),
  **Chain** (straw hat and robe; one hat thrown three ways plus a second one swung on a
  chain), **Sniper** (a bolt gun that never rolls a crit and goes looking for one instead —
  the seam behind the glass — plus a cloak to leave with and an ultimate that is just the
  rifle with the aiming taken out), and **Diver** (a drop-suit that never has to land: fire
  patches thrown onto the floor as ammunition, and a slam that detonates every one it lands
  on). A character sets base stats plus a **passive**, a utility, a special and an ultimate,
  and names the kit it carries — the M1 and the Q ability — which nobody else can hold.
- **Four of them are authored meshes** — Halcyon, Dasher, Unloader and Sniper ship as glTF and are
  skeletoned, skinned and painted at load time by `entities/authoredRig.js`; the rest are
  built from primitives by `entities/models.js`. An authored mesh also *carries* its weapon:
  the geometry was sculpted into its hand, so it is skinned to the weapon mount rather than
  having a procedural weapon model attached. Held weapons no longer swivel onto the crosshair
  — a weapon is welded into the carry the art was drawn in and moves only because the arm
  did, which is what makes it read as belonging to whoever is holding it. `aimWeapon` is the
  one exception and one character sets it: Sniper, whose whole identity is the line from an
  optic to a body. Two characters carry something in the *other* hand as well — Bulwark's
  plate and Wraith's second blade — and `offhandHeld` keeps that arm out of the weapon
  support pose, which was bringing a shield up across the chest every time a target appeared. See "Adding a character" in the
  README, and `tools/rigview.html` / `tools/modelview.html` for the two pages every
  measurement in that module was taken with. A spec can also repair a mesh at load time:
  `strip` takes off geometry the character should not have (Unloader's cargo hook), and
  `detach` cuts a piece free of the body it was welded into and puts it back straight
  (Sniper's scope, which was fused to his shoulder and 15° off the bore), and `attachments`
  bolts procedural plate onto a sculpt that arrived without any (Sniper's, who is a man in a
  cloak with bare arms). Skinning has three rules a wrap-around cloak and a rifle held across
  the chest forced out: a `core` the limbs may not reach into, cloth weighted down its chain
  by height rather than by distance, and every claim a confidence with a shared margin rather
  than a hard line.
- **Chain's hat** is resolved in `Combat._tickHat` rather than as a projectile, because a
  projectile flies at what it was pointed at and this one *chooses*: on every body it crosses
  it picks the next within its search radius and turns, compounding 5% a bounce. It ignores
  terrain deliberately. The worn hat's visibility is derived every frame from whether either
  form is out, so the two abilities cannot desync it.
- **A flight pose**, not an airborne walk. `poseFlight` in `entities/characterRig.js` runs
  after the gait and blends over it by `rig.fly`, driven by `flying` / `flightClimb` off the
  player. Legs trail and scissor, ankles point, the trunk pitches with the throttle, and the
  arms yield to aiming and to attack animations rather than fighting them.
- **Ultimates** — one per character, with **no cooldown**. A meter fills from **damage dealt**
  (0.016 per 1% of the target's own max health, capped at one whole body per hit), from kills
  (0.28 / 0.9 / 11 per normal / elite / boss) and from damage taken (0.06 per 1% of max
  health lost), plus a 0.035/s trickle; spending empties it. Tuning lives in `ULTIMATE` in
  `core/config.js`. Damage is the largest source and is measured as a *fraction of the
  target* rather than as raw numbers, so a build with ten times the damage kills the same
  husk ten times quicker and is paid the same for it; the cap is exactly one body because
  `takeDamage` reports what was thrown rather than what fitted, and without it a 2600% slam
  into a husk would pay for the next four ultimates. Clearing a stage on damage alone is
  worth a little under a full meter, so an ultimate arrives about **once a stage**.
- **9 kits, one per character** — a kit is the M1 and the Q ability, and nobody can carry
  anybody else's. That is what lets each one be built for exactly one body: Bulwark's shotgun
  reaches 15m because only a 200-health frame could walk into that range, Halcyon's beam has
  no falloff at all because a bombardier four hundred metres up has to reach the ground, and
  Wraith's blades pay 480% at the hilt against 120% at the tip because that is the only thing
  that makes a thin frame walk *towards* something. Every ability names an `anim` — or `animFor`
  when it changes shot to shot — and the rig acts it out (slash / swing / punch / punchL /
  thrust / pump / lob / beam / shoot).
- **Q has four shapes**: a plain press, `charges: n` (Diver's three fire patches on
  independent timers), `charge: t` (a wind-up), and `sustain: true` — an ability that is
  simply true while the button is down. Bulwark's **Guard** is the only sustained one: 62%
  less damage taken, no cooldown, and no attacking behind it. Holding it is the price;
  charging a cooldown as well would be billing twice for the same thing.
- **Passives** — one per character, and hooks rather than numbers. `damageMult(player, enemy)`
  folds in at the end of `damageEnemy` (Desperation, Executioner, Momentum, **Standoff**),
  `moveMult(player)` is read every frame by the movement code (Altitude), `cooldownMult` folds
  into `stats.cooldownMult` and `ultimateMult` into `addUltimateCharge` (**Standard Issue**),
  `onDamaged` fires after a hit lands (Overshield), `onHatHit` rides an ability (Chain
  Reaction). Each is read at the moment it applies, which is what lets one depend on things a
  stat block cannot see.
- **The two ends of that design are Sniper's and Vanguard's.** **Standoff** is the exact
  inverse of Wraith's blades — hers pay most at the hilt, his pays most at 60m — which puts
  two characters on one axis at opposite ends and turns the range card, the cloak and Break
  Contact into one plan. **Standard Issue** is a passive with deliberately *no* condition:
  every other one is a situation to play around, and the character the whole roster is tuned
  against cannot have one without stopping being the centre. It is 20% off every cooldown,
  the ultimate meter included, because the meter is that ability's cooldown.
- **Meridian Longrifle** is the precision option and the only weapon that takes the dice
  away. `scope` on the weapon collapses the camera onto the eye at 15° FOV, hides the body
  and draws a lens overlay; every enemy carries a red seam box (`Enemy._buildWeakPoint`) that
  only draws while somebody is scoped, and a hitscan carrying `weakPoint: true` asks a second
  ray-sphere question against it for a guaranteed crit. `randomCrits: false` kills the roll
  outright and `critChanceToDamage: 2.5` reads crit-chance items as crit damage instead, so
  the item pool does not go dead. `primary.activeReload` takes the fire button away after
  each shot until the bar is answered — on the mark, chambered instantly; missed or run off
  the end, jammed for 3s.
- **81 items** across 5 rarities. 49 unlocked on a fresh profile — 19/18/6/4/2 by tier, so a
  new account can find a Legendary. Each has a procedurally drawn icon.
- **4 pet species** — lizard, beetle, wisp, shell — hatched from eggs with gold. No cap on
  how many you keep; the eggs a stage puts out and the rising price are the limit.
- **14 enemies** (7 regular, 6 stage bosses, 1 optional final boss) + 4 elite affixes. The new
  three are **Thornmaw** (burrows; untouchable and faster underground, erupts under you),
  **The Fulgurant** (hovers, strikes a lead-predicted point, periodic telegraphed nova) and
  **The Ossuary Choir** (raises minions and takes 16% less damage per living one, capped at
  72% — the lantern ring shows how much). Each arena draws its boss at random from its own
  shortlist (`theme.bosses`), so the fight suits the place and is not the same twice.
- **An optional ending.** From stage 5 a rift opens beside the Beacon; through it is the Null
  Sanctum and a three-phase boss. Killing it wins the run.
- **9 arena themes**, 148–176m radius, procedurally generated and dressed, each with its own
  **landform**. Three are new: **Sunken Mire** (terraced shallow pans, dense reeds),
  **Shattered Spires** (the most vertical ground in the game) and **Ossuary Flats** (near-flat,
  pale, the longest sightlines). **The order is random per run** — see below.
- **Four new interactables** beside the chests, each asking for something other than gold:
  the **Blood Altar** (35% of max health for a guaranteed Uncommon+), the **Cursed Cache**
  (free item, five-enemy ambush with an elite), the **Pattern Duplicator** (gold for +1 stack
  of something you already carry) and the **Scrap Forge** (two Commons for one better, twice).
  All four are `Chest` kinds, so they replicate, save and prompt for free.
- **The Shrine of Ruin**, from stage two, beside the Shrine of Chance. Not a gamble: it is a
  trade made once. It adds a guardian to the beacon and one more item per player to
  everything the beacon and its bosses drop, for the rest of the run, and stacks twice.
- **Settings** — volumes, sensitivity (with a separate aiming multiplier), inverted look,
  screen shake, turn response, damage numbers, full rebinding, and an unlock-everything
  button for people who do not want the meta-progression campaign. They live in
  `core/settings.js` under their own storage key, not in the profile.

### The landform

Every theme carries `landform: { amplitude, scale, detail, ridged, bowl, terrace }`, evaluated
by `Arena.terrainHeightAt(x, z)` — an analytic function, not a heightmap, because co-op has to
rebuild an arena from its seed alone and because physics, the camera boom and every prop
placement sample it thousands of times a frame. Phases come from the arena RNG, so the same
seed grows the same hills.

| Theme | Radius | Depth | Ground |
| --- | --- | --- | --- |
| Verdant Hollow | 148 | 1 | Rolling, gentle lift toward the rim |
| Sunken Mire | 158 | 1 | Shallow terraced pans draining inward |
| Tidal Shelf | 162 | 2 | ~1m terraces falling away from the centre |
| Frozen Shelf | 170 | 3 | Big smooth drifts inside a high rim |
| Shattered Spires | 168 | 3 | 2.4m stepped plates, the most vertical ground here |
| Ashfall Basin | 155 | 4 | Falls away from the middle, ridged crests |
| Ossuary Flats | 172 | 4 | Near flat and pale; the longest sightlines |
| Void Terrace | 176 | 5 | 1.7m stepped plates |
| Ember Depths | 166 | 5 | Short-wavelength ridging, deep clefts |

**Stage order is drawn per run**, by `themeForStage(stage, rng, avoidId)`: eligible themes are
those whose `depth` is between `stage - 4` and `stage`, the previous stage's theme is excluded,
and stage one comes from the two depth-1 themes. **The host draws and puts the id in the stage
packet** — deriving it from the stage seed would have been reproducible right up until somebody
joined a run in progress, at which point their idea of "the previous stage" and the host's
would differ and the party would be standing in two different arenas.

The centre (plateau radius + 5m) and the outer 18m are masked flat, so the structures, the
spawns and the boundary all still meet the ground.

### The edge, and what is past it

**There is no wall.** `_buildBackdrop` puts three instanced mountain ranges at 2.6/3.8/5.2
arena radii under a gradient sky dome and a height-faded haze band, all `fog: false` and
unlit — depth comes from each ring being washed further toward the horizon colour, since
nothing out there ever moves relative to the player. `CAMERA.far` had to go 620 → 3200 to
reach them (and `near` 0.1 → 0.2 to keep the depth precision).

`_buildBarrier` is the other half: one cylinder, one shader, **no colliders**. The radial
clamp in `moveWithCollision` has always been what stops you; the barrier is the readout.
Opacity is driven by the distance from `arena.barrierFocus` (the player, set each frame in
`Game._update`) to each point on the wall, so it is entirely invisible from the middle of the
arena and lights only the panels you are pressed against.

### Prop hitboxes are measured, not declared

`PROP_COLLISION`'s hand-written radii are gone. `propColliders(type, geo)` in `props.js`
measures the volumes off the geometry that was actually built, per variant, and `PROP_PHYSICS`
now only says what *kind* of thing it is: `trunk` (narrow solid trunk, canopy as a camera-only
blocker), `box`, `arch` (one volume per leg, walkable middle) or null. Before this, boulders
and crystals had no collider at all, arches were solid across the opening, and every tree
shared one radius regardless of variant or instance scale.

One trap worth knowing: a trunk is a cylinder, so it has vertices at its two caps and nowhere
between, and the bottom cap lands at `-1e-8` after a transform. The band scan starts at
`-0.01` for exactly that reason — an exact `y >= 0` test dropped it and left every tree in the
game with no collider. `groundHeightAt` returns the terrain
as its baseline and boxes above it; `moveWithCollision` rests on it and lifts you up a slope
you walk into; `raycastGround` in `physics.js` marches and bisects rather than solving a
plane. **Camera lift and the boom's ground limit deliberately use `terrainHeightAt`, not
`groundHeightAt`** — asking for the highest *solid* surface makes the boom hop onto the roof
of the building it is trying to see past, which is a bug this codebase has now had twice.

---

---

## Architecture

```
index.html            importmap + all HUD/menu markup
styles/main.css       the entire UI
vendor/three.module.js
src/
  main.js             entry point
  game.js             orchestrator — owns the run, the world, the frame loop
  core/               config.js (all tuning), engine.js, input.js, settings.js,
                      audio.js, rng.js, mathx.js
  data/               items.js, itemArt.js, characters.js, weapons.js, enemies.js, pets.js
  world/              arena.js, props.js, textures.js, themes.js
  entities/           player.js, characterRig.js, enemy.js, pet.js,
                      projectiles.js, interactables.js, models.js
  net/                session.js (transport), coop.js (replication), remotePlayer.js
  systems/            combat.js, inventory.js, director.js, loot.js, physics.js, fx.js
  meta/               save.js (localStorage), progression.js (Echo maths)
  ui/                 hud.js, menus.js, chat.js, caseRoll.js
tools/                serve.js (+ co-op relay + feedback endpoint), relay.js,
                      feedback.js, check.js, coop-check.js
graph/                generated knowledge graph — nothing at runtime reads it
.vscode/              launch + task config
play.cmd / play.sh    start the server without npm, finding Node wherever it lives
MULTIPLAYER.md        co-op setup, incl. tunnels for machines without admin rights
FEEDBACK.md           where player bug reports and ideas go, and how to be sent them
```

The repository is the game: source at the root, no build step, no bundler. The one
exception is `graph/`, which holds generated analysis output (`graph/README.md` says what
it is, how to regenerate it, and where it disagrees with the source).


**Conventions that carry weight:**

- **All enemy damage funnels through `Combat.damageEnemy`** — crits, item damage modifiers,
  lifesteal and on-hit procs apply in exactly one place. It is also where a co-op client
  reports what it did to the host.
- **Proc coefficients.** Every hit carries one (sidearm 1.0, a Rivet Driver nail 0.25,
  explosion splash 0, a pet 0.1–0.5 by species), so a 13/s weapon cannot trivially out-proc a
  1.4/s one, and a pack of pets cannot out-proc your gun.
- **Items are declarative.** `stats(stacks, acc, run)` folds passives; `hooks.<event>(ctx,
  stacks, ev)` reacts. `ctx` is a stable façade in `systems/inventory.js`; a throwing hook is
  caught and logged, not fatal. Hooks: onHit, onCrit, onKill, onDamaged, onLowHealth, onTick,
  onSecondary, onPetDown, onFatal, modifyDamage, modifyIncoming.
- **Everything is procedural.** Models from primitives, textures painted to canvases, item
  icons drawn from a shape library.
- **Body animation is a free function.** `entities/characterRig.js` poses any model built by
  `buildPlayerModel` from a plain descriptor, so the local player and a networked teammate
  share one rig with no inheritance between them. Locomotion is three gaits — run, backpedal,
  side-step — blended by `rig.gaitF/gaitB/gaitS` from the travel direction in the body's own
  frame, all on one shared clock so a diagonal is a continuous gait changing shape rather than
  a crossfade. `rig.onStep` fires on each footfall, which is what drives footstep audio.
- **Input is addressed by action, never by key.** `input.actionDown('secondary')`, not
  `input.down('KeyQ')`. Mouse buttons live in the same code namespace (`Mouse0/1/2`), which is
  the whole reason the rebinding screen can offer them for anything. Bindings live in
  `core/settings.js` under their own localStorage key, separate from the profile.
- **Sound is synthesised, never loaded.** `core/audio.js` builds every effect from oscillators
  and filtered noise on demand, behind three buses and a shared convolution reverb whose
  impulse is synthesised decaying noise. A weapon's report is derived from its `model` tag, so
  a new weapon that reuses a silhouette gets a sound for free. Voices are throttled per name
  and capped at 28; anything inaudible is never built. The score is a generative sequencer
  scheduled against the audio clock with a 0.25s lookahead — it skips the gap after a stall
  rather than firing every missed note at once.
- **A reveal presents a roll; it never makes one.** `Chest._grantItem` rolls through
  `systems/loot.js` and hands the answer to `game.revealItem` — along with the device's own
  label and `RARITY_TABLES` key — which either drops it or plays the case-opening reel around
  it (`ui/caseRoll.js`) and drops it after. The reel's filler is weighted by that same table, so
  every tile going past is something this chest could actually have given you: a Legendary Chest
  shows no Commons because it cannot roll one. Tiers are narrowed to those the table can roll
  *and* the player has unlocked something in, because `loot.pickItem` would have stepped away
  from an empty tier too. The separation is the
  point: the animation is skippable, refusable and switchable-off precisely because nothing
  downstream of the roll can reach back into it. The reel freezes the world via
  `game.freezeForReveal`, which is why it is solo-only — `CaseRoll.enabled` re-checks
  `coop.active` at every drop rather than trusting the setting alone.
- **Stage prices are frozen at stage build.** `game.stageDifficulty` is sampled once in
  `_buildStage` and is what chests and eggs are priced from; `Chest.price` / `Egg.price` then
  apply the local player's own discount on top. `cost` is the replicated stage price, `price`
  is what you pay — a discount belongs to the payer, not to the chest, so it never crosses the
  wire.

---

## Co-op — how it is put together

`tools/relay.js` is a from-scratch WebSocket server (frame codec included, ~200 lines) that
knows about rooms and nothing about the game. `tools/serve.js` attaches it to the static
server, so one command serves and hosts.

**Authority is split.** The host owns the world: arena seed, director, enemies, bosses,
chests, beacon. Every player owns themselves: position, items, gold, level, pets.

- **You hurt things locally.** Your crit, your items, your damage numbers resolve instantly
  against your copy of the enemy; the host is then told the number and applies it. Verified:
  a client predicted 132 damage over two seconds and the host applied exactly 132.
- **Things hurt you locally.** The host sends raw damage; your machine applies your armour,
  barrier and items. A build is only ever evaluated where it lives.
- **Enemy fire is a spawn event, not a stream.** Each peer runs the identical ballistic path
  and resolves it against their own body, so a shot costs one small message however long it
  flies.
- **Arenas are seeded explicitly** (`_buildStage(stage, layout)`) rather than off the run
  RNG's running state, which is what lets a client rebuild the host's world exactly.
  `Arena` takes the seed itself and splits it into two streams that never touch: `rng` draws
  everything with a collider, `decorRng` draws everything you can only look at. The stage
  packet carries `th`, a hash of the collider set, and a client that rebuilds to a different
  number says so and asks the host again instead of quietly standing on its own ground.
  `npm run check:coop` builds both sides headlessly and compares.
- **A client never simulates on an arena only it can see.** Waiting on the host it builds
  `COOP.pendingSeed` — the same placeholder on every machine — and does not describe its
  position to anyone until the real stage lands. It also asks for the stage again if one
  never arrives, and a mid-run joiner is sent the run itself (`start`, stage, live enemies)
  rather than only the stage it was missing.
- **Enemies target the party**, chosen on a slow timer with stickiness. A `RemotePlayer` is a
  full stand-in inside the host's simulation — the AI chases, hits and shoves it without
  knowing a network exists.
- **Downed, not dead.** You keep looking around; a teammate standing over you for 5s revives
  you at 45%. The downed player runs their own revive timer (they already know where everyone
  is, so it costs zero messages). The run ends when the last player falls.
- Send rates live in `COOP` in config.js: 20 Hz own state, 15 Hz host snapshot, 10 Hz pets.
- **Party scaling** lives in `PARTY`: the difficulty coefficient, spawn budget, enemy cap,
  chest count and egg count all rise with the headcount. Measured for two players: coefficient
  +22%, cap 16 → 25, banked credits 42 → 65.
- **Chat and the pickup log** ride the same session (`k: chat`, `k: got`).

Trusting peers is deliberate: this is a game you host for friends off a code you read aloud.

---

## Performance — the non-obvious parts

Roughly **83 draw calls** and 76k triangles in a 40-enemy fight, simulation at **~0.5 ms/frame**.
Four things got it there, all of which will bite again if undone:

1. **Never toggle `visible` on a light.** three.js bakes the visible light count into every
   material's shader, so toggling a PointLight recompiles *every material in the scene*.
   Explosions did this several times a second — program count passed 110, frames cost
   hundreds of ms. Lights are allocated once and animated to zero intensity. Program count is
   flat at ~20.
2. **Pool materials by colour.** Constructing a material per projectile/hazard is a shader
   compile per spawn.
3. **Compact instance buffers.** Active particles/beams/rings/glows are written to the front
   of the buffer and `count` is set to what was written, so idle pools are free.
4. **Broadphase collision.** A uniform XZ grid over ~400 colliders serves point, box and ray
   queries (ray by DDA). It detects a stale collider array and falls back to a linear scan.
   Verified against brute force: zero missed hits over 600 randomised queries.
5. **Merge model sub-meshes.** `mergeStaticMeshes` collapses siblings sharing a material,
   only ever *within* a group so animated Groups survive. Chests 60→10 meshes, enemies 20→7,
   weapons 38→8, triangle counts unchanged.

Adaptive quality also steps shadows and pixel ratio down under sustained slow frames, and
dynamic lights are the first thing dropped.

---

## Recently fixed (worth not regressing)

- **`Object3D.add` returns the PARENT.** `g.add(mesh).rotation.z = Math.PI / 2` rotates the
  whole group. Nine of these had accumulated across the weapon models; the one in `addAction`
  rolled every rifle-family weapon ninety degrees onto its side, which is why the character
  appeared to hold its gun out flat to the left. This has now shipped three separate times
  (the missing head, the flat weapon, a chest lid), so **`npm run check` greps for it** and
  fails the build. Do not delete that lint.
- **The walk was knock-kneed, and the pelvis was why.** Two faults compounding. The rest
  splay had the wrong sign — a positive Z rotation swings a limb toward +X, so the leg at
  negative X needed a negative angle, and positive on both made a V where the comment above
  it promised an A. On top of that the pelvis twisted 0.3 rad into every step, about double a
  real running gait, and because both legs hang rigidly off it that did not read as hip
  rotation: it swung the forward leg bodily across the centreline. Measured on the Vanguard,
  the knees tracked 0.25 apart against hips 0.39 apart and closed to 0.15 at worst, and each
  foot reached up to 0.29 past its own hip. The Wraith was worse — knees to 0.08. The splay
  is the right way round now, the twist is 0.15, and `poseLegs` counter-rotates each hip by
  `LEG_TRACK` of it, which is what a femur does and why people's feet land in a line. Same
  measurement now: knees 0.40 apart, 0.35 at worst, feet within 0.10. The side-step still
  crosses on purpose — that one is a gait, not a defect.
- **Slashes were drawn flat however you swung them.** `FX.slash` took only the yaw off the
  direction it was handed, so every crescent lay in the ground plane with a fixed roll on
  top; the travelling wave did the same with its velocity. Swing up at something overhead and
  the damage went up — `melee` has always used the full 3D aim vector — while the cut stayed
  at your feet. Both take yaw and pitch now, via `aimYaw` / `aimPitch` in `core/mathx.js`,
  and the roll is applied afterwards in the cut's own frame so it keeps meaning the same
  thing whichever way the swing points. The wave is re-aimed every frame rather than only at
  spawn, because gravity and drag bend the path.
- **Elbows bent backwards.** Arm and leg joints both used positive `rotation.x` on the lower
  segment, but an elbow flexes forward and a knee flexes back, so one of them had to be
  negative. Arms are now negative, and the joint pad moved to the outside of the joint
  (`jointSide` in `articulatedLimb`) since a knee cap and an elbow cap face opposite ways.
- **The weapon was not held by the grip.** The glove stayed with the forearm while the mount
  rotated to track the crosshair, so the weapon floated beside a hand that was not holding it.
  The glove is now parented into `weaponMount`. The aim is also clamped to a 72° cone around
  the *forearm* (`-Y`, not `+Z` — measuring the cone against the wrong axis pointed the gun at
  the sky).
- **`Quaternion.setFromRotationMatrix` on a scaled matrix.** `poseWeapon` took the mount's
  parent orientation from `matrixWorld`, which carries the torso's breathing scale.
  `getWorldQuaternion` decomposes properly.

- **You could not aim upwards.** A camera boom is a rigid arm: pitching up swings the far end
  *down*, and past about 40 degrees that put it under the floor. The old code clamped the
  camera height afterwards, which took it off the boom entirely — the arm pointed one way and
  the camera lay on the ground looking another, so looking up simply stopped working. Now the
  pivot rises with the pitch (`CAMERA.pitchLift`) and `Player._groundLimit` marches the arm
  against `terrainHeightAt`, stopping it where it would go under. Max pitch 0.95 → 1.30 rad.
- **`_placeBoom` must lift against terrain, not against `groundHeightAt`.** Using the latter
  makes the camera hop onto the roof of whatever it is trying to see past. This bug has now
  been introduced twice — once originally, once while adding the landform. Solid geometry
  shortens the boom through `_probeBoom`; only the ground lifts it.
- **Egg prices changed while you were walking back with the gold.** They were recomputed on
  every prompt from the live difficulty and how many pets you were holding, so the number on
  the prompt was not the number you paid, and buying one egg silently raised the price of the
  one you were saving for. Prices are now fixed for the stage — see `game.stageDifficulty`.
- **A "melee" weapon that fired a projectile with no swing behind it.** The Void Reaper's
  primary now resolves as a flat horizontal arc (`ctx.slashWave`) that *then* throws the cut:
  a tapered crescent mesh, not a sphere, sweeping a radius rather than raycasting its own
  centre line. Anything that wants a travelling melee arc should use the same `wave` spec on
  `ProjectileManager.spawn` — it damages each enemy exactly once through a hit set, and it
  ghosts through world geometry so a wave spawned at chest height does not die on the floor.
- **Attack animations went through the wrist.** `rigAttack` plays a named move on the whole
  upper body, and the damped bases the swing adds to live on the rig (`rig.armRX` and
  friends) rather than on the `Object3D` rotations. That separation is load-bearing: adding
  an offset straight onto a value that is `damp`-ed toward a target every frame feeds the
  offset back into the smoothing and the limb over-rotates while the attack is rising.
- **The Harpoon shoved instead of pulling.** It applied one impulse, which barely moved
  anything heavy. It is now a `pulled` status the enemy carries for 0.9s, overriding its AI
  velocity each frame and scaled by `knockbackResist` so bosses resist rather than ignore it.
- **Marks had to survive being spent by somebody else.** Dasher's mark is a per-enemy status,
  so consuming the one the dash struck cannot touch any other enemy's — and the dash refunds
  at most once per dash, so a line of marked targets is a bonus, not infinite movement.
- **Refunding a utility charge used to hand out two.** Setting `utilityTimer = 0` is exactly
  the condition the charge regeneration ticks on, so a "reset the cooldown" that zeroed it
  granted a second charge on the next frame. `Combat.refundUtility` restarts the timer at
  full instead, and only zeroes it when already at max charges.
- **Terrain drifted apart in co-op** — teammates rendered inside the floor or hovering above
  it. Three causes, all fixed: the ground texture pulled ~3,600 numbers out of the same RNG
  stream the colliders came from (so any cosmetic edit moved every structure), a waiting
  client built a *random* arena of its own and broadcast its position from it, and a stage
  packet that went missing was never chased. See the co-op section above.
- **WASD could not be typed into the lobby-code box.** The game listens for keys on `window`,
  so keystrokes aimed at a text field were read as movement and the bound ones had their
  default prevented — which is what stops the character reaching the input. `isTextTarget()`
  now short-circuits both the input layer and `Game._onKey` whenever a field has focus.
  Anything that gates `preventDefault` on "is this key bound?" needs that guard first.
- **Boss loot was one item for the whole party.** Every boss and every stage clear now drops
  one per player (`Game.bossItemCount()`), each a separately claimable networked pickup, so
  four players get four items rather than three of them watching one person collect.
- **Blink teleported down the camera's line and landed you.** The Wraith's blink travels the
  way the character is moving (`Player.moveDirection()`) and holds your altitude, so blinking
  out of a jump leaves you airborne with your fall and your second jump intact. The Void
  Reaper's Blink Slash is the deliberate exception: it follows the aim line, up or down or
  across a gap, and walks its landing point back until it is somewhere a body can stand.

- **The character had no head.** `head.add(mesh).position.set(...)` reads like it positions
  the mesh, but `Object3D.add` returns the **parent** — so the line relocated the whole head
  to the antenna tip's coordinates, inside the torso. Watch for that idiom anywhere.
- **The weapon was canted, and upside down at some angles.** Its orientation came from
  `setFromUnitVectors(+Z, aimDir)`, the shortest arc from world +Z, which carries arbitrary
  roll — ~15° on a diagonal aim, a full inversion near world −Z. The mount now builds an
  explicit basis against world up. Measured roll is now only the 4° cant we ask for.
- **`player.aiming` was never assigned**, so the braced arm pose could never trigger.
- **The muzzle transform was read before the rig posed the model**, so shots left from where
  the muzzle was last frame. `_readMuzzle()` now runs after posing.
- **Camera pumping + gun pointing down were one bug.** The camera's collision "walk it in"
  loop wrote its shrink back into the persistent distance, so it pumped near props; that
  collapsed the aim point onto the player and made the muzzle direction degenerate. The aim
  floor is now measured along the ray *past the player*, not from the camera.
- **A/D were inverted.** Screen-right is `forward × up`; the movement basis used its negation.
- **Chest lid** was built from two stacked rotations and landed on its side. Rebuilt in one
  unambiguous frame (cylinder axis rotated onto X, theta swept 0→π).
- **Triplanar materials must not set `vertexColors`** — the shared BoxGeometry has no colour
  attribute, so `USE_COLOR` multiplies by zero and renders every structure black.
- **Textures are neutral detail maps.** Painting them in theme colours double-darkens against
  the per-instance tint.
- **Director credits are capped.** Unspent credits used to accumulate without bound, so
  falling behind produced waves bigger than the one you couldn't clear.
- **Loot tables have a rarity floor.** Large chests never roll Common; the "nothing unlocked
  at that tier" fallback returns the best available tier rather than `pool[0]`.
- **The camera boom hangs off a shoulder-offset pivot**, so a clear boom is not a clear view.
  One thin ray from the pivot ran *beside* every tree trunk in the game. Probe with a bundle,
  cast from the body as well as the pivot, and never feed the previous frame's distance back
  into the target or it pumps in and out on the spot.
- **`groundHeightAt` returns the top of any collider, not the terrain.** Using it to lift the
  camera parked it on the roof of the building it was trying to see past.
- **Foliage has no collider** — you are meant to walk under it — so the camera needs its own
  occluder volumes (`PROP_COLLISION.camera`), and must ignore any it is standing inside.
- **`scatterPoints` used to silently return fewer points than asked for** when the arena could
  not fit them at the requested spacing, so whatever was placed last simply never appeared.
- **Party size must come from the lobby, not from remote avatars** — an avatar does not exist
  until its first state packet, which is after the host has already built stage one.
- **A splashing projectile never resolves a direct hit** — it detonates instead. Anything
  giving a projectile splash has to put the whole payload in the splash, or it does a third
  of the damage its numbers claim.

---

## Testing

There is no unit-test suite. Verification is done by driving the real game in a browser with
the render loop stubbed so the simulation can be stepped at fixed `dt`:

```js
g._realUpdate = g._update.bind(g); g._update = () => {};   // rAF only renders
const step = n => { for (let i=0;i<n;i++) g._realUpdate(1/60); };
```

For **co-op**, drive two tabs off `setInterval` at wall-clock rate (rAF is throttled in a
background tab, and pauses entirely if the browser pane is not compositing) — WebSocket
events still fire, so replication can be tested end to end.

`npm run check` parses every module and then runs `tools/coop-check.js`, which builds arenas
headlessly (canvas stubbed, since nothing it draws reaches a collider) and asserts that two
peers on one seed agree on every collider and on ground height across 400 sample points.

Suites in use: all item hooks (all 81 items at 3 stacks each, in a live firefight with a
brood out), all 8 weapons (damage benchmark), all 6 characters (ability displacement/damage
vs spec), collision correctness vs brute force, a full menu→run→boss→descend→summary pass, a
two-peer co-op pass (lobby, stage sync, damage prediction, item arbitration, revive, stage
advance), a 10-minute leak soak, and shader-program stability.

The **case-opening reveal** and the **feedback panel** were verified by driving the real page
with Playwright: the reel measured against its marker across repeated rolls (the landing is
jittered by up to a third of a tile, so "on the marker" is a range, not a point), skip and take
by key and by click, the item that actually spawns matching the one the reel stopped on, and
the run coming back unpaused with input re-enabled afterwards. That is where the reel's two
real bugs came from — a stride that drifted because a flex tile with `min-width: auto` grows
past its basis for a long item name, and a spin that stretched on a slow machine because it
summed clamped frame deltas instead of reading the clock. The feedback endpoint was exercised
with `curl`: validation, the rate limiter, the size cap, escaping in the admin page, the
whitelist dropping unknown diagnostic keys, and a mock webhook receiving the record.

**Three lessons from this project:** test harnesses lie — a "grapple does nothing" result was
the harness holding a key for two frames and firing twice, and a scary damage number was two
overlapping floaters. Measure before optimising — the FPS complaint was shader recompilation,
not geometry. And the browser caches ES modules aggressively; a plain `location.reload()`
during testing can leave you looking at code you already replaced.

---

## Known rough edges / next candidates

- Characters are ~50 meshes each and are *not* merged (the rig animates most of the groups).
  Eight players on screen is a draw-call cost nobody has measured yet.
- The co-op relay trusts every peer completely. Fine for friends; not fine for strangers.
- A client's brood takes splash and stray fire from its own local simulation, but the host's
  melee slams only reach the host's own lizards.
- The scripted test bot is naive (walks into trees, no kiting), so "bot survived N minutes" is
  a weak signal. Director pressure is measured against a fixed reference DPS instead.
- Stage bosses are still three fixed patterns with no phase transitions. Only the Null
  Sovereign has phases, and only it scales health directly with party size (everything else
  scales through the difficulty coefficient).
- Stage count is still unbounded if you ignore the rift; the Sovereign is the only ending.
- Wraith's Blink still flattens to the horizontal and snaps to the ground. Only the Void
  Reaper's Blink Slash was made three-dimensional, because only that one was asked for.
- `game.js` is ~1150 lines and is the natural place for a split if it grows further.
- The terraced landforms (Void Terrace, Tidal Shelf) put a short scramble at every shelf edge.
  It is inside the step-up allowance so it is climbable, but a shelf lip is still a place
  where an enemy pathing straight at you can bunch up.
- Enemy and pet movement respect the landform through `groundHeightAt`, but none of the AI
  reasons about height — nothing takes the high ground on purpose.
- The music engine has one arrangement shape across all ten themes; only key, tempo and two
  timbre dials change. A second shape — something sparser for the sanctum, something with a
  pulse for the Spires — would be cheap and is the obvious next thing.
- Backdrop ranges are per-arena instanced meshes rebuilt on every stage change. They are
  cheap (three draw calls) but they are also thrown away and remade each time.
- The Choir can summon its chorus from across a terrace edge, so on Shattered Spires the adds
  sometimes have to path a long way round. They get there; it just looks odd.
- `Egg.sequence` prices a clutch, but the clutch is per-stage, not per-player: in co-op two
  people buying from the same stage both see the same list rather than each having their own
  escalation. That is deliberate, and worth knowing before someone calls it a bug.
