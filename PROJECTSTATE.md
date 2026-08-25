# Chance of Precipitation — Descent Protocol · Project State

Handoff summary. Paste this into a new chat to continue work.

---

## What it is

A 3D action roguelike in the vein of *Risk of Rain 2*. Kill enemies for gold, spend gold on
chests, collect stacking items, and try to out-scale a difficulty curve that rises with
elapsed time. Runs pay out **Echoes**, a meta currency that permanently widens the item pool
and unlocks weapons and characters. Now also playable **co-op, up to eight**.

**Stack:** three.js (vendored, r169) + plain ES modules. **No build step, no bundler, no
external assets, no dependencies** — every model, texture and icon is generated procedurally
at runtime, and the multiplayer relay is hand-written Node.

**Run it:** `npm start` → http://localhost:8080. The same command also hosts co-op on the
same port and prints the LAN address to give friends. `npm run check` parses every module
without a browser. Open the folder in VS Code and press **F5** to launch with the bundled
config.

---

## Controls

| Input | Action |
| --- | --- |
| `W A S D` | Move |
| Mouse | Look (click canvas to capture pointer) |
| Left click | Weapon primary |
| `Q` | Weapon secondary (hold to charge where applicable) |
| `Shift` | Character utility |
| `R` | Character special |
| `F` | Character ultimate — no cooldown; charges from kills and damage taken |
| Right click | Aim (pulls camera in, narrows FOV) |
| `E` | Interact — chests, shrines, brood eggs, the Beacon |
| `Esc` | Pause — in co-op this only frees the mouse; the world keeps running |

---

## Content

- **6 characters** — Vanguard (baseline), **Unloader** (grapple + momentum punch, the
  Loader-alike), Wraith (glass cannon, blink), Bulwark (tank, shield charge + bastion),
  **Halcyon** (flies; low health, negative armour, slightly softer damage, impact bombs),
  **Javelin** (0-damage marking spear + a piercing dash that refunds itself on a marked hit).
  A character sets base stats plus utility (Shift), special (R) and ultimate (F); weapons
  are independent.
- **Ultimates** — one per character, on `F`, with **no cooldown**. A meter fills from kills
  (3 / 9 / 26 per normal / elite / boss) and from damage taken (0.6 per 1% of max health
  lost), plus a 0.35/s trickle; spending empties it. Tuning lives in `ULTIMATE` in
  `core/config.js`. They are meant to be run-swinging, not routine.
- **8 weapons** — MK-4 Sidearm, Breach Scattergun, Arc Emitter, Rivet Driver, Seeker
  Launcher, Photon Lance, Void Reaper, **Siege Gauntlets**. Tuned to near-identical
  single-target DPS (~64–84 at base damage) so the choice is about *how* you fight. Every
  ability names an `anim` and the rig acts it out (slash / punch / thrust / pump / lob).
- **62 items** across 5 rarities. 34 unlocked on a fresh profile including some of every
  tier, so all five can drop on run one. Each has a procedurally drawn icon.
- **Brood lizards** — gold-bought minions hatched from eggs, four at base, and substantially
  buffed: 135% of owner damage per fireball on a 0.85s cadence, 75% of owner health, cheaper
  eggs with a gentler per-owned markup.
- **10 enemies** (7 regular, 3 bosses) + 4 elite affixes.
- **6 arena themes**, procedurally generated and dressed. Stage 1 (*Verdant Hollow*) is a
  calm green meadow; the palette darkens as you descend.

---

## Architecture

```
index.html            importmap + all HUD/menu markup
styles/main.css       the entire UI
vendor/three.module.js
src/
  main.js             entry point
  game.js             orchestrator — owns the run, the world, the frame loop
  core/               config.js (all tuning), engine.js, input.js, rng.js, mathx.js
  data/               items.js, itemArt.js, characters.js, weapons.js, enemies.js
  world/              arena.js, props.js, textures.js, themes.js
  entities/           player.js, characterRig.js, enemy.js, minion.js,
                      projectiles.js, interactables.js, models.js
  net/                session.js (transport), coop.js (replication), remotePlayer.js
  systems/            combat.js, inventory.js, director.js, loot.js, physics.js, fx.js
  meta/               save.js (localStorage), progression.js (Echo maths)
  ui/                 hud.js, menus.js
tools/                serve.js (+ co-op relay), relay.js, check.js, coop-check.js
graph/                generated knowledge graph — nothing at runtime reads it
.vscode/              launch + task config
```

The repository is the game: source at the root, no build step, no bundler. The one
exception is `graph/`, which holds generated analysis output (`graph/README.md` says what
it is, how to regenerate it, and where it disagrees with the source).


**Conventions that carry weight:**

- **All enemy damage funnels through `Combat.damageEnemy`** — crits, item damage modifiers,
  lifesteal and on-hit procs apply in exactly one place. It is also where a co-op client
  reports what it did to the host.
- **Proc coefficients.** Every hit carries one (sidearm 1.0, a Rivet Driver nail 0.25,
  explosion splash 0, a brood fireball 0.15), so a 13/s weapon cannot trivially out-proc a
  1.4/s one, and a pack of lizards cannot out-proc your gun.
- **Items are declarative.** `stats(stacks, acc, run)` folds passives; `hooks.<event>(ctx,
  stacks, ev)` reacts. `ctx` is a stable façade in `systems/inventory.js`; a throwing hook is
  caught and logged, not fatal. Hooks: onHit, onCrit, onKill, onDamaged, onLowHealth, onTick,
  onSecondary, onMinionDown, onFatal, modifyDamage, modifyIncoming.
- **Everything is procedural.** Models from primitives, textures painted to canvases, item
  icons drawn from a shape library.
- **Body animation is a free function.** `entities/characterRig.js` poses any model built by
  `buildPlayerModel` from a plain descriptor, so the local player and a networked teammate
  share one rig with no inheritance between them.

---

## Co-op — how it is put together

`tools/relay.js` is a from-scratch WebSocket server (frame codec included, ~200 lines) that
knows about rooms and nothing about the game. `tools/serve.js` attaches it to the static
server, so one command serves and hosts.

**Authority is split.** The host owns the world: arena seed, director, enemies, bosses,
chests, beacon. Every player owns themselves: position, items, gold, level, lizards.

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
- Send rates live in `COOP` in config.js: 20 Hz own state, 15 Hz host snapshot, 10 Hz minions.

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
- **Marks had to survive being spent by somebody else.** Javelin's mark is a per-enemy status,
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
- **Blink teleported down the camera's line and landed you.** It travels the way the
  character is moving (`Player.moveDirection()`) and holds your altitude, so blinking out of
  a jump leaves you airborne with your fall and your second jump intact. Same rule now
  applies to the Void Reaper's Blink Slash.

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

Suites in use: all item hooks (all 62 items at 3 stacks each, in a live firefight with a
brood out), all 7 weapons (damage benchmark), all 4 characters (ability displacement/damage
vs spec), collision correctness vs brute force, a full menu→run→boss→descend→summary pass, a
two-peer co-op pass (lobby, stage sync, damage prediction, item arbitration, revive, stage
advance), a 10-minute leak soak, and shader-program stability.

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
- Boss AI is three fixed patterns; no phase transitions. Bosses do not scale with party size.
- No audio at all.
- Stage count is unbounded (themes cycle); there is no ending or victory condition beyond
  dying.
- `game.js` is ~800 lines and is the natural place for a split if it grows further.
