# SONEYBUN — Descent Protocol

A 3D action roguelike in the vein of *Risk of Rain 2*. Kill things, take their gold, spend it
on chests, and try to out-scale a difficulty curve that never stops climbing. When the run
ends — and it will — you are paid in **Echoes**, a currency that permanently widens the item
pool and unlocks new weapons for every run after.

Built with [three.js](https://threejs.org/) and plain ES modules. **No build step, no
bundler, no external assets** — every character, weapon and prop is assembled from
primitives at runtime.

---

## Running it

```bash
npm start          # serves on http://localhost:8080, and hosts co-op on the same port
```

That is a zero-dependency static server (`tools/serve.js`) with a WebSocket room relay
(`tools/relay.js`) riding on the same port. On start it prints your LAN address as well as
localhost — that is the one to give friends. Any static server works for solo play; the game
needs one only because ES modules can't load over `file://`.

```bash
npm run check      # parses every module, then proves co-op terrain agrees
npm run check:coop # just the terrain check
```

Neither needs a browser, and neither needs `npm install` — `three` is vendored, and
`tools/vendor-resolve.mjs` is a resolve hook that makes the bare specifier mean the vendored
build outside the browser, where there is no importmap. `check` parses every module to catch
syntax errors, then builds arenas headlessly and asserts that two peers on the same seed
produce identical colliders and identical ground height — the thing that, when it silently
stopped being true, had teammates rendering knee-deep in the floor.

Requires a browser with WebGL2. No install step: `three` is vendored in `vendor/`.

### In VS Code

Open the folder and press **F5**. The bundled launch config starts the dev server as a
background task and opens the game in Chrome (there is an Edge variant too) — nothing to
configure. `Ctrl/Cmd+Shift+B`-style task running also works: **Terminal → Run Task** offers
`serve` and `check`, with `check` wired as the default test task.

For IntelliSense on `import * as THREE from 'three'`, run `npm install` once. That pulls
`@types/three` — an **editor-only** dependency; the game still loads the vendored copy at
runtime via the importmap in `index.html`, so the types never ship and never affect the
build. `jsconfig.json` sets the language service to ES2022 modules with `checkJs` off, so
you get completion and signature help without the editor red-underlining idiomatic JS.

The recommended-extensions prompt suggests Live Server, which is a fine alternative to
`npm start` — right-click `index.html` → *Open with Live Server*. Do not open `index.html`
directly from the file system: ES modules and the importmap need an HTTP origin.

---

## Controls

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| Mouse | Look (click the canvas to capture the pointer) |
| Left click | Primary attack |
| `Q` | Weapon secondary — **hold to charge** on weapons that support it |
| `Shift` | Utility ability (character-specific) |
| `R` | Special ability (character-specific) |
| Right click | Aim — pulls the camera in and narrows the field of view |
| `Space` | Jump (double jump with Gravity Boots) |
| `E` | Interact — chests, shrines, brood eggs, the Beacon |
| `Esc` | Pause (in co-op this frees your mouse; the world keeps running) |

---

## How a run works

**Kill → gold → chests → items.** Enemies drop gold that homes to you a moment after they
die. Chests are scattered around each arena and cost gold to open; each gives one item.
Items **stack** — every copy strengthens the effect, with no cap.

**Difficulty is a function of time.** A coefficient rises continuously from the first second
and steps up each stage:

```
difficulty = (1 + 0.30 × minutes) × 1.14 ^ stagesCleared × modeMultiplier
```

It feeds enemy health and damage, gold values, chest prices, and the rate at which the
spawn director earns credits — so surviving longer is uniformly harder, not harder along
one axis. The named tiers (Easy → Medium → Hard → Very Hard → Insane → Impossible →
Cataclysm → Oblivion) are just labels on that one number, shown as a meter that only ever
goes up.

Roughly what that means in practice:

| Elapsed | Stages | Coefficient | Tier | Husk HP | Husk damage |
| --- | --- | --- | --- | --- | --- |
| 0:00 | 0 | ×1.00 | Easy | 60 | 9 |
| 5:00 | 0 | ×2.50 | Medium | 143 | 16 |
| 10:00 | 1 | ×4.56 | Hard | 257 | 24 |
| 20:00 | 3 | ×10.4 | Insane | 577 | 50 |
| 30:00 | 5 | ×19.3 | Cataclysm | 1068 | 88 |

**The Beacon is a decision, not a formality.** Each arena contains one. Activating it starts
a ~42-second charge that advances *only while you stand inside the ring*, and summons a
guardian. Survive both and the way down opens: a fresh arena, a higher baseline, richer
gold. You may instead ignore it and farm — but the clock keeps running either way, so
farming is never free.

**Death pays out.** Echoes are awarded mostly for time survived, plus stages cleared, bosses
killed, and how deep into the ramp you got. Spend them in the **Sanctum**. Unlocking an item
does not give it to you; it makes it *findable*, so a larger pool means more variety rather
than more power per chest.

---

## Co-op

Up to eight of you, one arena.

1. One person runs `npm start` and opens **Co-op** from the main menu, then **Open a Lobby**.
   The screen shows a four-letter code and the address of their machine.
2. Everyone else opens *that address* in a browser — not their own localhost — goes to
   **Co-op**, types the code, and hits **Join**.
3. The host presses **Launch Descent** when the party is full.

Over the internet rather than a LAN, the host needs port 8080 reachable: forward it on the
router, or point a tunnel (`ssh -R`, `cloudflared`, `ngrok`, anything) at it and hand out the
tunnel's address instead.

**What is shared:** the arena, the director, the enemies, the bosses, the chests and the
beacon. **What is yours alone:** your items, your gold, your level and your brood. Gold and
experience are paid to *everyone* on every kill, so nobody has to race to a corpse — but an
item on the ground goes to whoever reaches it first.

**Boss loot is per head.** A boss, and the beacon on stage clear, drops one item per player —
four of you, four items — so joining a friend never costs you the drop you would have had
alone. Each one is claimed by exactly one person.

**Everyone stands on the same ground.** The arena is built from a seed the host sends, and
the stage packet carries a hash of the collision geometry with it; a client that would have
built anything different says so and resyncs rather than letting you see a teammate buried to
the waist. Until the host's stage arrives, a client stands on a placeholder arena that is
identical on every machine and keeps its position to itself.

Going down is not the end of your run. You keep watching, teammates see a DOWN marker over
your body, and standing on you for five seconds brings you back at 45% health. Everyone still
down gets up when the party descends. The run ends only when the last of you falls.

The host's machine owns the world, so if they leave, the session ends for everyone.

---

## Content

**4 characters.** A character sets your stats and both signature abilities; weapons stay
independent, so the character decides how you move and commit while the weapon decides how
you shoot.

| Character | Identity | Utility (Shift) | Special (R) |
| --- | --- | --- | --- |
| Vanguard | Balanced baseline — 115 HP, no sharp edges | Combat Roll | Overclock |
| Unloader | Heavy exosuit, 165 HP, slow but armoured | **Grapple Gun** | **Overcharged Fist** |
| Wraith | Glass cannon — 88 HP, negative armour, double jump | Blink (in the air too) | Umbral Volley |
| Bulwark | 200 HP and 16 armour, walks slowly at the problem | Shield Charge | Bastion |

**Unloader** is the combo character. The grapple anchors to terrain *or* enemies and reels
you in at 40 u/s, and — critically — it hands that momentum back on release instead of
zeroing it. Overcharged Fist then spends it: damage scales from 450% standing to 1800% at
full tilt. Measured, that is 38 damage from a standstill against 210 at speed, so the loop is
grapple → arrive fast → punch, exactly as intended.

**Shrines.** The **Shrine of Chance** is the old gamble — pay, and it pays out an item 42% of
the time, three times, at a rising price. The **Shrine of Ruin** appears from stage two and is
not a gamble at all: it is a trade you make once. It summons another guardian to the beacon
and adds one more item per player to everything the beacon and its bosses drop, for the rest
of the run. It stacks twice and no further — three guardians waiting at the beacon, three
items each on the far side of them.

**Brood lizards.** Eggs sit out in every stage beside the chests. Paying one hatches a lizard
that follows you, picks targets off your crosshair, and spits homing fire that explodes and
burns. They have no stats of their own — health, damage, speed and fire rate all read from
*your* current stats every frame, and their hits resolve through the same `damageEnemy` path
yours do, so your crit, your damage modifiers, your lifesteal and your on-hit items all fire
from their fireballs. Every second item you pick up grows another crystal on their backs.
Dropping one to zero curls it back into an egg for fifteen seconds rather than deleting a
purchase you made three stages ago.

**62 items** across five rarities — 34 available from the start (including a taste of every
tier, so Rare, Epic and Legendary drops can appear on a brand-new profile), 28 unlockable. Every item
draws its own icon procedurally from a shape library, so all 62 are distinguishable on the
ground before you touch them, and the same art appears in the HUD, the pickup card, the
Sanctum and the Codex:

| Rarity | Count | Chest odds | Echo cost |
| --- | --- | --- | --- |
| Common | 11 | 74% | 40 |
| Uncommon | 10 | 20% | 110 |
| Rare | 9 | 4.7% | 240 |
| Epic | 8 | 1.1% | 480 |
| Legendary | 6 | 0.3% | 900 |

A fresh profile starts with all 11 Commons, all 10 Uncommons, and 2 Rares / 2 Epics / 1
Legendary, so every tier is reachable from the first run.

Large chests never roll Common — paying the premium guarantees at least an Uncommon, and
Legendary chests start at Rare. Each table carries a rarity floor that the "nothing of that
tier is unlocked yet" fallback cannot drop below, so an expensive chest can never quietly
hand back a white item. **Fortune Clover** rerolls every rarity roll and keeps the better
result.

**7 weapons**, one starting and six unlockable, each with a distinct primary and secondary.
They are deliberately tuned to near-identical single-target DPS (~64–84 at base damage) so
the choice is about *how* you fight, not which is strongest:

| Weapon | Identity | Secondary |
| --- | --- | --- |
| MK-4 Sidearm | Balanced hitscan, full 1.0 proc coefficient | Focused Shot — chargeable piercing round |
| Breach Scattergun | 10 pellets, brutal up close | Concussive Blast — knockback, and a self-launch |
| Arc Emitter | Chains through 3 extra targets | Overload Sphere — drifting orb that zaps an area |
| Rivet Driver | 13/s, pierces 2 | Harpoon — drags a target to you and chills it |
| Seeker Launcher | Homing explosive arcs | Cluster Barrage — 9 mortars on your aim point |
| Photon Lance | Beam that ramps to 3× on a held target | Prism Burst — discharge stored heat |
| Void Reaper | A two-handed void blade; every wide slash feeds you | Blink Slash — phase 14m at your own height, cutting the path |

**10 enemy types** (7 regulars, 3 bosses) with melee, ranged, flying, charging and artillery
behaviours, plus **4 elite affixes** — Blazing, Glacial, Overcharged, Voidtouched — that
appear once the ramp gets going and bring their own mechanics.

**6 arena themes** cycle across stages, each procedurally generated and dressed with a
low-poly prop set — grass, ferns, reeds, bushes, trees, conifers, dead trees, mushrooms,
rocks, crystals, columns, arches, broken walls and monoliths. Stage 1 (*Verdant Hollow*) is
deliberately the calmest of the set: open green meadow under a blue sky. The palette darkens
and the architecture gets taller and more ruined as you descend.

Structures are assemblies, not slabs: columns have stepped plinths, drummed shafts and
capitals; decks have edge lips, braced legs and collapsing railings; walls are coursed brick
with doorways and missing blocks. All of it is **textured** from a procedural material
library — masonry, industrial panelling, poured concrete, rock face and etched rune plate,
each with a matching roughness map, painted onto canvases at load time.

Those textures are applied with **triplanar projection**. The structures are boxes scaled to
wildly different dimensions through an instance matrix, so ordinary UVs would smear the
texture along whichever axis got stretched; projecting on the three world axes and blending
by surface normal costs three samples and never stretches.

Terrain massing is theme-driven, so the opening stages read as landscape (low, sparse
structure) while the deep stages fill with tall ruins. Around 2,900 props dress the opening
arena for roughly **30 draw calls** — every prop type is drawn from a handful of pre-built
geometry variants through `InstancedMesh`, and the grass sways in a vertex shader so the CPU
never touches it.

---

## Architecture

```
index.html            importmap + all HUD/menu markup
styles/main.css       the entire UI
vendor/three.module.js
src/
  main.js             entry point
  game.js             orchestrator — owns the run, the world, and the frame loop
  core/
    config.js         every tuning constant in the game
    engine.js         renderer, camera, lighting, adaptive quality
    input.js          keyboard/mouse + pointer lock
    rng.js            seedable mulberry32 + weighted picks
    mathx.js          clamp/damp/armor curve/proc rolls
  data/
    items.js          62 item descriptors
    itemArt.js        procedural icon recipes, one per item
    characters.js     4 playable characters and their abilities
    weapons.js        7 weapon descriptors
    enemies.js        bestiary, bosses, elite affixes
  world/
    arena.js          procedural arena, structures, scattering, collider grid
    textures.js       procedural material library + triplanar projection
    props.js          low-poly prop geometry library (grass → ruins)
    themes.js         6 stage palettes, prop mixes and terrain profiles
  entities/
    player.js         movement, stats pipeline, third-person camera
    characterRig.js   procedural body animation, shared by local and remote players
    enemy.js          AI behaviours + enemy manager
    minion.js         brood lizards and their manager
    projectiles.js    bullets, mortars, hazards, singularities
    interactables.js  chests, shrines, eggs, teleporter, pickups
    models.js         every mesh, built from primitives
  net/
    session.js        WebSocket transport, roster, message dispatch
    coop.js           replication: who owns what, and what crosses the wire
    remotePlayer.js   a teammate's body, and their stand-in in the host's sim
  systems/
    combat.js         weapon firing + the single damage entry point
    inventory.js      item runtime and hook dispatch
    director.js       difficulty coefficient + spawn director
    loot.js           rarity rolls and chest pricing
    physics.js        collide-and-slide, raycasts
    fx.js             pooled particles, beams, rings, glows
  meta/
    save.js           localStorage profile
    progression.js    Echo maths and the unlock catalogue
  ui/
    hud.js            in-run overlay and floating combat text
    menus.js          menu, loadout, Sanctum, codex, records, summary
tools/
  serve.js            dev server + co-op relay on the same port
  relay.js            WebSocket rooms, written from scratch (no dependencies)
  check.js            module parser
  coop-check.js       proves two peers on one seed build the same ground
  vendor-resolve.mjs  makes `import 'three'` work outside the browser
  vendor-hooks.mjs    the resolve hook itself
graph/                generated knowledge graph — see graph/README.md
.vscode/              launch + task config (F5 to play)
jsconfig.json         language-service config for IntelliSense
```

Everything above `graph/` is the game. `graph/` is generated analysis output, read by
people and agents rather than by the game — deleting it changes nothing at runtime.

Systems talk through the `Game` object rather than to each other. Two conventions carry most
of the weight:

**All enemy damage funnels through `Combat.damageEnemy`.** Crits, item damage modifiers,
lifesteal and on-hit procs are therefore applied in exactly one place, no matter whether the
source was a bullet, a beam, an explosion, a brood lizard or an item. It is also the single
point where a co-op client reports what it did to the host.

**Authority in co-op is split, not centralised.** The host owns the world; every player owns
themselves. You resolve your own hits locally and send the host the number, and when
something hits you the host sends raw damage that *your* machine applies your armour and
items to — so a build is only ever evaluated on the machine it lives on, and nothing you do
waits for a round trip.

**Item drops read at a glance.** Each drop billboards its own procedurally drawn icon on a
rarity-framed plate, so you can tell a Phoenix Charm from a Glass Shard across the arena.
Collecting one raises a card
showing the name, rarity, category and what the item does *at its new stack count*, so a
second copy reads as the upgrade it is rather than repeating the first pickup's numbers.

**Proc coefficients.** Every hit carries one. The sidearm's is 1.0; a Rivet Driver nail is
0.25; explosion splash is 0. On-hit items scale their trigger chance by it, so a 13/s weapon
does not trivially out-proc a 1.4/s one.

### Adding an item

Items are declarative — append one object to `src/data/items.js` and it is complete:

```js
{
  id: 'thermal_lining', name: 'Thermal Lining', rarity: 'uncommon', icon: '🧥',
  desc: (s) => `Reduces damage taken by ${s * 4}%.`,
  stackText: '-4% damage taken per stack',
  stats: (s, acc) => { acc.multDamageTaken *= 1 - 0.04 * s; },
  hooks: {
    onKill(ctx, s, ev) { ctx.heal(2 * s); },
  },
}
```

`stats(stacks, acc, run)` folds passive modifiers into the stat accumulator.
`hooks.<event>(ctx, stacks, ev)` reacts to gameplay: `onHit`, `onCrit`, `onKill`,
`onDamaged`, `onLowHealth`, `onFatal`, `onSecondary`, `onTick`, `modifyDamage`. `ctx` is a
stable façade (`src/systems/inventory.js`) exposing healing, area damage, chain lightning,
buffs, internal cooldowns, timers and FX — item code never touches the game object directly,
and a throwing hook is caught and logged rather than killing the frame.

### Adding a character

Append to `src/data/characters.js` with base stats, a `build` key for the model, and a
`utility` plus `special`. Abilities receive the same combat context weapons use, extended
with movement primitives — `dash`, `fireGrapple`, `momentumPunch`, `blink`, `homingVolley`,
`shieldCharge`, `bastion`. Movement states live on the player (`startGrapple`,
`startShieldCharge`) so they compose with collision and the camera correctly.

### Adding a weapon

Append to `src/data/weapons.js` with a `primary` and `secondary`. Damage is expressed as a
multiplier of the player's damage stat so it scales with levels and items automatically. The
context gives you `hitscan`, `spawnBullet`, `spawnMortar`, `cone`, `melee`, `blinkSlash` and
`chain`.

### Tuning

`src/core/config.js` holds every constant worth touching: the difficulty formula, director
credit rates, chest pricing, rarity tables, Echo payouts, player stats and camera framing.

---

## Performance

Roughly 150 draw calls and 75k triangles for a fully dressed arena, with all scenery batched
into `InstancedMesh` and the simulation costing about **1.2 ms per frame with 40 active
enemies**. Three things matter more than the totals:

**Shader programs stay flat.** three.js bakes the visible light count into every material's
shader, so toggling `visible` on a `PointLight` invalidates and recompiles the program for
every material in the scene. Explosions did that several times a second — the program count
climbed past 110 and frames cost hundreds of milliseconds. Dynamic lights are now allocated
once and animated to zero intensity instead, and projectile/hazard materials are pooled by
colour rather than constructed per spawn. The count now sits flat at ~20.

**Effect pools draw only what is live.** Active particles, beams, rings and glows are
compacted to the front of their instance buffers each frame and `count` is set to the number
written, so an idle pool costs nothing. The matrices were being rewritten every frame anyway,
so the compaction is free.

**Models merge their own detail.** The detail passes pushed a chest to ~60 meshes and a husk
to ~37; with ten chests and dozens of enemies that is over a thousand draw calls of pure
overhead. A post-build pass collapses sibling meshes that share a material into one mesh per
group — only ever *within* a group, never across one, so every Group the animation code
rotates still exists and still transforms its contents. Chests went 60 → 10 meshes, enemies
20 → 7, weapons 38 → 8, with triangle counts unchanged. A fight with 40 enemies draws in 83
calls.

**Collision queries are broadphased.** A uniform XZ grid over the arena's ~400 colliders
serves point, box and ray queries (the last by DDA traversal). Every enemy raycasts the world
several times a frame; linear scans made that the most expensive thing in the simulation.
Adding the grid cut the frame cost from 3.2 ms to 0.5 ms *while* tripling the collider count,
and it is verified against brute force — zero missed hits over 600 randomised queries.

The engine also watches its own smoothed frame time and steps quality down (shadow
resolution → shadows off → pixel ratio) when it can't hold pace, stepping back up when it
recovers, with a hold either side so it never oscillates. The simulation clamps `dt` to
50 ms, so a stalled frame slows time rather than teleporting the player through a wall.

---

## Saving

Progress lives in `localStorage` under `soneybun.profile.v1`: Echoes, unlocks, equipped
weapon, lifetime records and the Codex. If storage is unavailable the profile falls back to
memory for the session rather than failing. **Records → Erase All Progress** wipes it
(two clicks, deliberately).
