# Chance of Precipitation — Descent Protocol

A 3D action roguelike in the vein of *Risk of Rain 2*. Kill things, take their gold, spend it
on chests, and try to out-scale a difficulty curve that never stops climbing. When the run
ends — and it will — you are paid in **Echoes**, a currency that permanently widens the item
pool and unlocks new weapons for every run after.

Built with [three.js](https://threejs.org/) and plain ES modules. **No build step, no
bundler, no external assets** — every character, weapon and prop is assembled from
primitives at runtime, every texture is painted onto a canvas at load, and every sound,
including the score, is synthesised by the Web Audio API as it plays. Nothing in the
repository is a binary.

---

## Running it

```bash
node tools/serve.js       # serves on http://localhost:8080, and hosts co-op on the same port
node tools/serve.js --port 9000   # if 8080 is taken; it also auto-advances on its own
```

Or double-click **`play.cmd`** on Windows (**`./play.sh`** elsewhere), which finds Node —
including a portable copy unzipped next to the script — and starts the same server.

**npm is optional.** It never did anything here but forward the command: `npm start` runs
`node tools/serve.js` and nothing else. There are no runtime dependencies to install, and
`three` is vendored in `vendor/`. If npm is broken or blocked on your machine, ignore it —
see [MULTIPLAYER.md](MULTIPLAYER.md) for the details and for the PowerShell execution-policy
fix if you want it back.

That server is a zero-dependency static server (`tools/serve.js`) with a WebSocket room relay
(`tools/relay.js`) riding on the same port. On start it prints your LAN address as well as
localhost — that is the one to give friends. Any static server works for solo play, but *not*
for co-op: Live Server and friends serve the files without the relay, so the lobby has nothing
to talk to. The game needs a server at all only because ES modules can't load over `file://`.

```bash
npm run check      # parses every module, lints, then proves co-op terrain agrees
npm run check:coop # just the terrain check
```

Neither needs a browser, and neither needs `npm install` — `three` is vendored, and
`tools/vendor-resolve.mjs` is a resolve hook that makes the bare specifier mean the vendored
build outside the browser, where there is no importmap. `check` parses every module to catch
syntax errors, then builds arenas headlessly and asserts that two peers on the same seed
produce identical colliders and identical ground height — the thing that, when it silently
stopped being true, had teammates rendering knee-deep in the floor.

The lint is short and specific. `Object3D.add` returns the **parent**, so
`group.add(mesh).rotation.z = x` rotates the whole group — an idiom that reads exactly like
the thing it is not, and which has shipped three separate times here: once it put a
character's head inside its own torso, once it rolled every rifle-family weapon ninety degrees
onto its side, and once it displaced a chest lid. It parses, it type-checks, and it is never
correct, so `check.js` greps for it.

Requires a browser with WebGL2. No install step: `three` is vendored in `vendor/`.

### In VS Code

Open the folder and press **F5**. The bundled launch config starts the dev server as a
background task and opens the game in Chrome (there is an Edge variant too) — nothing to
configure. `Ctrl/Cmd+Shift+B`-style task running also works: **Terminal → Run Task** offers
`serve` and `check`, with `check` wired as the default test task.

For IntelliSense on `import * as THREE from 'three'`, run `npm install` once — the one thing
npm is genuinely for here, and entirely skippable. That pulls
`@types/three` — an **editor-only** dependency; the game still loads the vendored copy at
runtime via the importmap in `index.html`, so the types never ship and never affect the
build. `jsconfig.json` sets the language service to ES2022 modules with `checkJs` off, so
you get completion and signature help without the editor red-underlining idiomatic JS.

The recommended-extensions prompt suggests Live Server, which is a fine alternative to
`npm start` — right-click `index.html` → *Open with Live Server*. Do not open `index.html`
directly from the file system: ES modules and the importmap need an HTTP origin.

---

## Controls

Every one of these is rebindable from **Settings → Controls**, onto keys *or* mouse buttons —
they share one code namespace, so an ability can live on a thumb button without anything
downstream knowing the difference. The defaults:

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` | Move — **relative to the camera**, not to the character |
| Mouse | Look (click the canvas to capture the pointer) |
| Left click | Primary attack |
| `Q` | Weapon secondary — **hold to charge** on weapons that support it |
| `Shift` | Utility ability (character-specific) |
| `R` | Special ability (character-specific) |
| `F` | **Ultimate** — no cooldown; the meter fills from kills and from damage taken |
| Right click | Aim — pulls the camera in and narrows the field of view |
| `Space` | Jump (double jump with Gravity Boots) |
| `E` | Interact — chests, shrines, eggs, the Beacon, the rift |
| `Enter` | Chat, and the run log |
| `Esc` | Pause (in co-op this frees your mouse; the world keeps running) |

### The character

The weapon is held by the grip, in the hand, and the hand goes where the weapon goes: the
glove is parented into the weapon mount, so however the barrel turns to track the crosshair,
the fingers turn with it. The aim is clamped to a cone around the forearm, so a body facing
its travel direction while the camera looks elsewhere can never end up presenting a gun
pointing somewhere the arm plainly is not.

Elbows bend forwards and knees bend backwards, which sounds like it should not need saying.
Both were positive rotations about the same axis, so both bent the same way and one of them
was wrong — most visible with the weapon lowered, where the hands ended up behind the hips.
The hips are also set wider than they were, with a few degrees of splay, because at the old
width the two boots were seven centimetres apart and every walk cycle looked like the knees
were being pressed together.

### The camera is not bolted to the character

Look direction and body facing are two separate quantities. The mouse drives the camera and
nothing else; the character turns to face **wherever it is travelling** while you are simply
running around, and snaps to the camera only when the weapon needs to be pointed at the
crosshair — firing, aiming, charging, or an ability. So you can sprint one way and watch
another, and the legs tell you which: a run, a backpedal and a side-step are three different
gaits blended by the travel direction in the body's own frame, sharing one clock so a
diagonal is a continuous gait changing shape rather than a crossfade.

Looking steeply up is a supported move. A boom is a rigid arm — swing it up and the far end
goes *down*, which on a character standing on the ground meant straight into the floor. The
pivot now rises with the pitch and the arm shortens against the terrain underneath it, so the
camera stays on the boom the whole way to 74° and the crosshair keeps working.

---

## How a run works

**Kill → gold → chests → items.** Enemies drop gold that homes to you a moment after they
die. Chests are scattered around each arena and cost gold to open; each gives one item.
Items **stack** — every copy strengthens the effect, with no cap.

A run is funded by the trash between beacons, not by the guardians. A guardian pays out a
little under half what a normal enemy of its size would suggest, and the Sovereign about
half: killing a boss is rewarded with its **item**, and the gold is a tip. XP is untouched —
the levels were never the problem.

**Eight things to walk up to.** Three chest tiers and a shrine take gold for a roll. The other
four each ask for something else entirely:

| Device | Costs | Gives |
| --- | --- | --- |
| Blood Altar | 35% of your maximum health | A guaranteed Uncommon-or-better. No gold involved. |
| Cursed Cache | Nothing | An item, and an ambush of five with an elite in it. |
| Pattern Duplicator | Gold, above a Large chest | +1 stack of an item you already carry, weighted to what you have most of. |
| Scrap Forge | Two Common items | One better one. Twice per stage. |

Each has its own silhouette, because the point of four more devices is that you decide which
one to cross the arena for before you are close enough to read the prompt.

**Prices are fixed for the length of a stage.** Everything buyable is priced once, when the
stage is built, from the difficulty coefficient at that moment — and does not move again until
you descend. The number on the prompt when you walk past a chest is what it will still cost
when you come back with the gold for it. Eggs are priced as a clutch, so the second egg on a
stage is dearer than the first and says so up front, rather than repricing itself behind you
once you have bought one.

**Difficulty is a function of time.** A coefficient rises continuously from the first second
and steps up each stage:

```
difficulty = (1 + 0.30 × minutes) × 1.14 ^ stagesCleared × modeMultiplier
```

It feeds enemy health and damage, gold values, the price list each stage is built with, and
the rate at which the spawn director earns credits — so surviving longer is uniformly harder, not harder along
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

**Charging it is the pressure, and it ends when the meter does.** Spawn rate slightly more
than doubles for those forty-two seconds. The moment the beacon fills, the arena stops
feeding the fight and stays stopped for the rest of the stage: whatever is on the ground is
what you finish the guardian with, and once the guardian is down the stage is genuinely
quiet — time to spend the gold rather than another forty seconds of husks between you and
the chest. The difficulty clock is deliberately *not* stopped with it, so standing on a
charged beacon is not a way to pause the ramp.

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
router, or point a tunnel (`ssh -R`, `cloudflared`, VS Code's built-in port forwarding,
anything) at it and hand out the tunnel's address instead. Friends paste that address into the
Join screen, or simply open it — the game defaults to talking to whatever served the page.

**[MULTIPLAYER.md](MULTIPLAYER.md) walks through each of those**, including the options that
need no installer, no administrator rights and no firewall exception.

**What is shared:** the arena, the director, the enemies, the bosses, the chests and the
beacon. **What is yours alone:** your items, your gold, your level and your pets. Gold and
experience are paid to *everyone* on every kill, so nobody has to race to a corpse — but an
item on the ground goes to whoever reaches it first.

The party makes the run harder as well as faster: the difficulty coefficient, the spawn budget
and the simultaneous-enemy cap all rise with the headcount, and the stages stock more chests
and more eggs to match. Press **Enter** to talk — the same panel logs who picked up what.

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

**7 characters.** A character sets your stats and all three signature abilities; weapons stay
independent, so the character decides how you move and commit while the weapon decides how
you shoot.

| Character | Identity | Utility (Shift) | Special (R) | Ultimate (F) |
| --- | --- | --- | --- | --- |
| Vanguard | Balanced baseline — 115 HP, no sharp edges | Combat Roll | Overclock | Fire Mission |
| Unloader | Heavy exosuit, 165 HP, slow but armoured | **Grapple Gun** | **Overcharged Fist** | Terminal Velocity |
| Wraith | Glass cannon — 88 HP, negative armour, double jump | Blink (in the air too) | Umbral Volley | Event Horizon |
| Bulwark | 200 HP and 16 armour, walks slowly at the problem | Shield Charge | Bastion | Last Stand |
| Halcyon | 84 HP, −10 armour, slightly softer damage — and it **flies** | **Thruster Flight** | **Bomb Cluster** | Ordnance Override |
| Dasher | 76 HP, −8 armour, the fastest and hardest-hitting frame in the descent | **Lance Dash** | **Marking Spear** (×2) | Skewer |
| Chain | 104 HP wanderer in a straw hat. Owns one thing and throws it | **Wanderer's Mark** | **Hat Toss** | Unbroken Chain |

**Ultimates** are the one ability the game gives you for having been in a fight rather than
for having waited. There is no cooldown: the meter beside the ability bar fills from kills
(0.28% a kill, 0.9% an elite, 11% a boss) and from damage taken (0.06% per 1% of your health
lost), plus a slow trickle so a quiet stretch is not dead time. It empties completely when
spent, and it is priced so that a full meter is worth about two stages of fighting — the
boss is the single biggest contributor, because it is the one landmark every stage has.
They are deliberately enormous — a 26-shell fire mission, a 2600% crater, three singularities
with thirty shades thrown into them, six seconds of literal invulnerability.

**Halcyon** is the flying character. Thruster Flight switches gravity off for seven seconds:
hold `Space` to climb, release to drift down, full ground-level control of your direction the
whole time. It is paid for in everything else — 84 HP, −10 armour and slightly less damage
than the baseline — and its bombs (three per Bomb Cluster) go off on whatever they touch
first. Landing early cuts the thrusters and refunds half the time you did not use.

Its ultimate hands you no new button. **Ordnance Override** takes the limiter off the two
things Halcyon already owns and rations: for fifteen seconds flight stops burning fuel and
landing no longer ends it, and the bomb rack unlocks — Bomb Cluster becomes a single bunker
charge thrown at whatever you are looking at for 700% damage in 16m, on nothing but a
half-second arming delay. It goes to the aim *point*, not along the aim direction — a
bombardier hanging thirty metres up is looking down a steep line, and a charge with any real
gravity on it would land well short of the thing being aimed at. Fifteen seconds of unlimited flight over an unlimited rack is a bigger ability than
any one enormous explosion, because it is the character finally being what the silhouette
has been promising.

Under thrust it has a pose of its own rather than a walk cycle with the floor deleted. The
throttle is what the whole body answers to: climbing stands it upright with the legs hanging
and the chest tipped back over the thrust, cruising pitches it forward with the legs streamed
out behind, hovering leaves it loose and drifting. It blends in and out over about half a
second, so a takeoff eases out of the run rather than cutting, and it gives the arms straight
back the moment you aim or use an ability — those poses have the weapon on them.

**Dasher** is the one built around a weapon that barely does any damage. The Marking Spear
lands for 70% and paints everything within 15m of where it sticks for ten seconds; you carry
two charges on a three-second clock, because the dash eats marks faster than one throw can
put them down. Lance Dash then goes *through* people for 420% damage — down your line of
sight, pitch included, so a ledge is somewhere you can go rather than something you arrive
underneath — and if it strikes something marked, the dash comes straight back. On its own the
dash is expensive, ten seconds, which is the point: the mark is not a bonus on top of a cheap
ability, it is how you avoid paying for an expensive one. A dash into open air costs you the
next ten seconds of mobility. Only the enemy actually struck spends its mark; everything else
the spear painted stays painted, so one good throw is a chain of dashes across a crowd rather
than a single reset. It is paid for in survivability — 76 HP and −8 armour is the thinnest
frame in the game — against the highest damage and the highest top speed.

**Skewer**, its ultimate, throws one great spear at the aim point: 900% in 22m, everything
caught marked for fourteen seconds and dragged bodily onto the shaft. A crowd raked into a
single point is a crowd one dash goes through end to end, and it comes with three banked
dashes that cost nothing at all — spent before the charge is, so they survive a full cooldown
and can be taken back to back.

It is the only character you cannot actually see. The plate is matte black, near enough to
the background colour that nothing reflects off it, so the whole silhouette is carried by
light instead: two nested additive shells around the body, a hard ring at the chest, and lit
edges down the pauldrons, thighs and shins — and a teal scarf, the one piece of cloth on an
otherwise entirely hard body, wrapped at the throat with two tails trailing behind. At range
you read the aura and the scarf and work out the shape from them.

**Chain** owns one object and throws it at everything. **Hat Toss** puts it through the first
body it crosses and then *ricochets* — off that one into the next, and the next, taking ten
percent more with every bounce, until it runs out of people within eighteen metres and comes
home. It comes back around for a second cut on a body it has already crossed, so a crowd of
three is six bounces rather than three with the growth compounding across all of them; fresh
bodies are always taken first, so a throw into a crowd still reaches the back of it. That
second cut is a real rebound — the hat deflects, swings clear and turns — because a hat that
simply struck twice on consecutive frames would read as a stutter rather than a bounce.
Thrown at nobody it simply comes back, so a miss costs the cooldown and nothing else.
**Wanderer's Mark** throws the same hat at what you are looking at and leaves it lying in the
grass; press again and you are standing where it is. Only the throw spends the charge — the
walk back is already paid for and hands it straight back — so one charge is one whole round
trip, and the five seconds are only ever paid by a hat you threw and walked away from.
**Unbroken Chain** throws it and does not catch it: nine seconds of ricochet that re-crosses
bodies it has already cut, with the ten percent compounding the entire time. It is the one
ability in the game whose damage is decided by how tightly the room is packed.

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

**Four pet species.** Eggs sit out in every stage beside the chests, and each one says what is
inside before you pay for it. There is no cap on how many you keep — the limit is how many
eggs a stage puts out and the price of the next one, which climbs with every pet you own.

| Pet | Role | Measured |
| --- | --- | --- |
| 🦎 Brood Lizard | Homing fire that bursts and burns | 6.3 dps |
| 🪲 Cinder Beetle | Charges in and gores. Tough | 8.0 dps |
| ✨ Spark Wisp | Constant fire, arcs to a second target, made of paper | 4.9 dps |
| 🐢 Aegis Shell | Barely scratches anything; pulses barrier onto the party | 1.7 dps, +17% barrier |

None of them have stats of their own — health, damage, speed and attack rate all read from
*your* current stats every frame, and their hits resolve through the same `damageEnemy` path
yours do, so your crit, your damage modifiers, your lifesteal and your on-hit items all fire
from their attacks. Every second item you pick up shows up on their backs. Dropping one to
zero curls it back into an egg for fifteen seconds rather than deleting a purchase you made
three stages ago.

**An ending, if you want one.** From stage 5, clearing a stage tears a rift open beside the
Beacon. Through it is the Null Sanctum and the Null Sovereign — no chests, no eggs and no way
back. Beating it finishes the run as a win. Ignoring it is a perfectly good answer; the stages
keep going forever.

**The Sovereign fights in three phases**, and each threshold *adds* rather than replaces, so
the last third is genuinely all of it at once:

| | Health | Name | What arrives |
| --- | --- | --- | --- |
| 1 | 100–66% | Sealed | Spiral barrages and summoned husks, at arm's length |
| 2 | 66–33% | Shelled | + expanding rifts of ground fire and blink-slams; it starts closing |
| 3 | 33–0% | Unravelled | + a wall of fire across the arena, elite summons, and no time to breathe |

Crossing a threshold costs you the damage window. It stops, armours up completely, and sheds
for a second or two — motionless and untouchable, venting a ring of fire you have to walk out
of — so the change of form is a beat in the fight rather than a line on the health bar you
burst straight through without noticing. The bar shows both thresholds as ticks, goes cold and
reads IMMUNE while it sheds. Every number that moves between phases lives in one table
(`SOVEREIGN_PHASES`), so a fourth phase is a fourth row.

**81 items** across five rarities — 49 available from the start, 32 unlockable. Every item
draws its own icon procedurally from a shape library, so all 81 are distinguishable on the
ground before you touch them, and the same art appears in the HUD, the pickup card, the
Sanctum and the Codex:

| Rarity | Total | Unlocked on a fresh profile | Chest odds | Echo cost |
| --- | --- | --- | --- | --- |
| Common | 19 | 19 | 74% | 40 |
| Uncommon | 18 | 18 | 20% | 110 |
| Rare | 17 | 6 | 4.7% | 240 |
| Epic | 15 | 4 | 1.1% | 480 |
| Legendary | 12 | 2 | 0.3% | 900 |

Every tier is reachable from the very first run — a new account can find a Legendary. The
Sanctum widens the pool rather than gating entry to it, which is the difference between a
progression system and a paywall made of time. And if you would rather not have the campaign
at all, **Settings → Game** hands over every item, weapon and character in one click.

Large chests never roll Common — paying the premium guarantees at least an Uncommon, and
Legendary chests start at Rare. Each table carries a rarity floor that the "nothing of that
tier is unlocked yet" fallback cannot drop below, so an expensive chest can never quietly
hand back a white item. **Fortune Clover** rerolls every rarity roll and keeps the better
result.

**9 weapons**, one starting and eight unlockable, each with a distinct primary and secondary.
Most are deliberately tuned to near-identical single-target DPS (~64–84 at base damage) so
the choice is about *how* you fight, not which is strongest; the Longrifle is the one that
deliberately steps outside that, because what it trades is not damage:

| Weapon | Identity | Secondary |
| --- | --- | --- |
| MK-4 Sidearm | Balanced hitscan, full 1.0 proc coefficient | Focused Shot — chargeable piercing round |
| Breach Scattergun | 10 pellets, brutal up close | Concussive Blast — knockback, and a self-launch |
| Arc Emitter | Chains through 3 extra targets | Overload Sphere — drifting orb that zaps an area |
| Rivet Driver | 13/s, pierces 2 | Harpoon — **winches** a target all the way in over 0.9s |
| Seeker Launcher | Homing explosive arcs | Cluster Barrage — 9 mortars on your aim point |
| Photon Lance | Beam that ramps to 3× on a held target — but only 1.6× on a boss. 30-round cell | Prism Burst — discharge stored heat |
| Void Reaper | Flat horizontal slash that **throws the cut** as a crescent wave | Blink Slash — phase 14m along your line of sight, cutting the path |
| Siege Gauntlets | Punches a 9m compression wave out of the knuckles | Jet Boost — ride the blast straight up |
| Meridian Longrifle | Scoped bolt gun. Never rolls a crit — earns them off a visible seam | Sidearm Revolver — free to holster if it finishes the job |

**Every weapon acts its attack out.** A weapon ability names an `anim` — `slash`, `punch`,
`thrust`, `pump`, `lob`, `beam` or `shoot` — and the rig plays it: the blade sweeps across the
body and rolls through its arc, the gauntlet drives the shoulder forward and snaps the elbow
straight, the harpoon is a two-handed stab, the shotgun racks its action with the support
hand. The trunk leads every one of them, because a swing that lives only in the wrist reads
as a mannequin twitching. Alternate strokes reverse, so holding attack is a sequence rather
than one shape stuttering.

The **Void Reaper**'s primary is a flat horizontal cut that then leaves the blade: the swing
does 245% in an arc and the crescent travels 26m at 34 u/s doing another 130%, sweeping
through everything it passes rather than raycasting down its centre line. It is drawn as the
cut itself — a tapered crescent lying flat — not as a glowing ball.

The **Photon Lance** ramps, and a boss is the one target that lets it ramp for free. Everything
else in the arena moves, dies, or has to be re-acquired, which is the cost the 3× was priced
against; a boss is a stationary wall that pays that cost once and then stands there. So the
*ramp* is cut against bosses rather than the damage: the beam still opens at exactly full
strength — 7.66 against a husk and 7.66 against the Colossus, measured — and then climbs to
3× on ordinary bodies against 1.6× on a boss. At full heat that is 53% of the damage. Prism
Burst splits the same way, since half of it is stored heat.

It also has the only magazine in the arsenal: thirty rounds in the cell, then two flat
seconds of nothing. Thirty ticks is a shade under three seconds held down, which is exactly
the length of the ramp — so the weapon now reaches the top of its own curve at about the
moment the cell runs dry, and holding the beam on one target costs you the reload instead of
being free forever. The two seconds do not shorten with attack speed: attack speed buys
rounds, not hands. This is a second, simpler kind of reload beside the Meridian Longrifle's
active-reload minigame — there is no window and nothing to get right, just a hole in your
damage the weapon's rhythm is priced around. The round count sits on the M1 slot and the
reload bar runs without a marker.

The **Rivet Driver**'s Harpoon is a winch rather than a shove. A single impulse barely moved
anything heavy; the target is now dragged under power for 0.9s at 34 u/s, lifted just enough
to clear kerbs on the way, with heavy enemies resisting in proportion to their knockback
resistance rather than ignoring the line entirely.

The **Siege Gauntlets** have no muzzle: the reach *is* the ability. Each punch resolves a 9m
cone with three upright crescents marching away from the fist, and the secondary fires both
gauntlets at the floor — straight up, jumps refunded, with a 260% blast under you.

The **Meridian Longrifle** is the only weapon that takes the dice away. Right mouse puts you
behind real glass: the camera collapses onto the eye, the field of view narrows to fifteen
degrees, the body stops drawing and the HUD draws a lens with a reticle in it. Behind that
glass every body in the arena — husk, elite or boss — shows the one plate it never got seated
properly, drawn as a red box somewhere on its surface. Put a round through the box and the
hit is critical, guaranteed; the seam is depth-tested like anything else, so one on the far
side of a target is a reason to move rather than a free shot through its back.

It never rolls a crit of its own. That is what makes the seam mean anything — a weapon that
sometimes crits anyway turns aiming into a suggestion — and it is why every point of crit
*chance* an item hands you is read as 2.5× that much crit *damage* instead, so a Glass Shard
is still worth picking up.

Each shot then takes the fire button away and gives you a bar with a marker sweeping across
it. Click as the marker crosses the mark and the bolt is chambered instantly; click early,
click late, or let the marker run off the right-hand end, and the action jams for three
seconds. The mark moves every shot, because a fixed one is a rhythm you learn once and then
stop reading.

Its secondary is a revolver, and it prices itself on the outcome: 260% damage, and if the
shot finishes something it holsters free. If the target is still standing, it is gone for ten
seconds. It is a finisher, not a second primary.

**13 enemy types** (7 regulars, 6 bosses) with melee, ranged, flying, charging and artillery
behaviours, plus **4 elite affixes** — Blazing, Glacial, Overcharged, Voidtouched — that
appear once the ramp gets going and bring their own mechanics.

Each arena owns **two** guardians and draws from them at random, and the two places in a tier
never share one — so a stage number offers four possible fights, two of which are on the table
depending on which of the pair you landed in. Once you have looped, the ordering stops meaning
anything and the whole roster is on the table everywhere, which is the point of refusing the
ending. The six:

| Boss | The problem it sets |
| --- | --- |
| The Colossus | Slams and boulder volleys. A wall that walks. |
| Ashen Leviathan | Circles at altitude, painting the ground with cold fire. |
| Void Harbinger | Teleports, summons, and knows you are the anomaly. |
| **Thornmaw** | Spends half the fight underground, where you cannot hit it and it can still reach you. |
| **The Fulgurant** | Strikes where you are *going*. Standing still is the only reliable way to be wrong. |
| **The Ossuary Choir** | Cannot be meaningfully hurt while its choir is standing. Kill the adds. |

The last three are built to be different *problems* rather than more health bars: one you
cannot hit for half the fight, one that punishes holding a line, and one where shooting the
health bar is the wrong play. The Choir's damage ward is shown on its lantern ring — one lit
lantern per living chorister — so it reads without a tooltip.

**9 arena themes**, drawn in a different order every run, each procedurally generated and
dressed with a low-poly prop set — grass, ferns, reeds, bushes, trees, conifers, dead trees, mushrooms,
rocks, crystals, columns, arches, broken walls and monoliths. Stage 1 is always one of the two
calm green ones, because the opening minutes are the tutorial. The palette darkens and the
architecture gets taller and more ruined as you descend.

Every prop's collision volume is **measured off the geometry that actually got built**, per
variant, rather than read from a hand-written table of radii. The table could only ever be
approximately right — a builder makes three or four randomised shapes and the scatterer then
scales each instance again — so boulders had no collider at all, arches were solid all the
way across, and columns stopped you a metre early. Trunks are found by scanning the vertices
near the base; arches emit one volume per leg and leave the opening walkable.

There are **nine of them**, they are **148 to 176 metres in radius** — up from a flat 78 — and
each has the shape of its own ground, not just its own colours. A theme carries a `landform`:
an amplitude, a wavelength, and three dials for whether the relief rolls, folds into ridges,
or quantises into shelves.

| Theme | Radius | Depth | Ground |
| --- | --- | --- | --- |
| Verdant Hollow | 148 | 1 | Rolling and forgiving, lifting gently toward the treeline |
| Sunken Mire | 158 | 1 | Shallow terraced pans draining inward, thick with reeds |
| Tidal Shelf | 162 | 2 | Metre-high shelves falling away from the middle |
| Frozen Shelf | 170 | 3 | The smoothest relief in the game, walled in by a high rim |
| Shattered Spires | 168 | 3 | The most vertical ground here: 2.4m plates with real drops |
| Ashfall Basin | 155 | 4 | Falls away from the centre, hardened crests breaking through |
| Ossuary Flats | 172 | 4 | Almost flat, and pale — the longest sightlines in the game |
| Void Terrace | 176 | 5 | Wide plates you break line of sight behind |
| Ember Depths | 166 | 5 | Short-wavelength ridging and deep clefts; nowhere to hold a line |

**Stages come in tiers of exactly two.** Stage one is the forest or the swamp, stage two is
one of the next pair, and so on; past the fourth tier the stage number wraps, which is what a
loop is. A stage number always offers the same choice of two places, and which of the two you
get is the only thing that varies between runs at that depth — so you know the shape of what
is coming and not which one, and no theme ever runs back to back.

| Stage | The two places |
| --- | --- |
| 1, 5, 9 … | Verdant Hollow · Sunken Mire |
| 2, 6, 10 … | Shattered Spires · Tidal Shelf |
| 3, 7, 11 … | Ossuary Flats · Frozen Shelf |
| 4, 8, 12 … | Ashfall Basin · Ember Depths |

This replaced a sliding window — a theme was eligible if its depth was within four of the
stage — which sounded like a descent and behaved like a jumble: stage three drew from *five*
themes with the opening forest and swamp still in the bag, stage five drew from all nine, and
a player three stages in had usually seen the same two green arenas three times and nothing
else.

The **Void Terrace** is not on the way down at all. It joins every tier's pool the moment you
have stood in front of the rift and descended anyway, so it is the one place you cannot reach
on a first clear.

The host draws and sends the result in the stage packet, so a co-op party always lands in the
same place — including someone who joined halfway through.

It is an analytic height function, not a baked heightmap, for two reasons: co-op replicates an
arena from its seed alone, so the ground has to be reproducible from four bytes; and the
physics, the camera boom and every prop placement ask "how high is the ground here" thousands
of times a frame, which a closed form answers in a handful of trig calls. The centre is held
flat so the plateau, the Beacon fight and every spawn sit on level ground, and so is the outer
ring, so the boundary still meets the floor. Prop counts, structure counts and interactable
counts all scale with the area, so a bigger arena is more stage rather than the same stage
spread thinner: about twenty chests, three or four shrines, two or three devices and a
handful of eggs.

### There is no wall

There used to be a thirty-metre brick cylinder around every arena, visible from anywhere in
it. It answered "what stops me leaving" very clearly and every other question badly — every
stage was visibly a room, and no amount of landform mattered when the backdrop was masonry.

Two things replace it, because they are two jobs. A **backdrop** of three mountain ranges at
two and a half to five arena radii, each washed further toward the horizon colour than the one
in front of it, under a gradient sky and a band of haze — depth read entirely from value,
since none of it ever moves relative to you. And a **containment field**: a hexagonal lattice
on the boundary that is completely invisible until you are within about twenty metres, lights
only the panels near you, and fades out again as you walk away. Nothing about the physics
changed — a radial clamp has always been what actually stops you, and the field is purely the
readout for it.

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
    input.js          pointer lock, and actions rather than keys
    settings.js       volumes, mouse feel, key bindings — persisted separately
    audio.js          the entire soundtrack and every effect, synthesised
    rng.js            seedable mulberry32 + weighted picks
    mathx.js          clamp/damp/armor curve/proc rolls
  data/
    items.js          81 item descriptors
    pets.js           the four pet species
    itemArt.js        procedural icon recipes, one per item
    characters.js     4 playable characters and their abilities
    weapons.js        8 weapon descriptors
    enemies.js        bestiary, 6 bosses, elite affixes
  world/
    arena.js          procedural arena, structures, scattering, collider grid
    textures.js       procedural material library + triplanar projection
    props.js          low-poly prop geometry, and collision measured off it
    themes.js         9 stages: palettes, prop mixes, landforms, boss shortlists
  entities/
    player.js         movement, stats pipeline, third-person camera
    characterRig.js   procedural body animation, shared by local and remote players
    enemy.js          AI behaviours + enemy manager
    pet.js            the four pet species and their manager
    projectiles.js    bullets, mortars, hazards, singularities
    interactables.js  chests, shrines, the four devices, eggs, Beacon, pickups
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
    chat.js           run log and text chat
    menus.js          menu, loadout, Sanctum, codex, records, settings, summary
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
source was a bullet, a beam, an explosion, a pet or an item. It is also the single
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

**Proportions first, geometry second.** The measure that decides whether a figure reads as a
character or as a toy is *heads tall*, and nothing else comes close: an early pass built these
at 4.7 heads with the legs at 40% of height, which is bobblehead, and no amount of smoothing
rescued it. They are laid out at about 7 heads now with the legs just over half the height —
close to the concept sheets — and the torso is lathed from a profile with hips, a waist pinch,
a ribcage and a chest flare instead of being one cylinder from belt to collar. There is a neck,
too; a figure with no neck has nowhere for the head to attach, so it reads as placed on top.
Every piece of a character's own hardware is quoted off `P.w`, `P.torso` or a limb radius
rather than in metres, because anything given an absolute size stops fitting the moment the
proportions move — the shield became a door and the wing became a hang-glider exactly once
before this rule existed.

**How round anything is lives in one table.** `SEG` in `entities/models.js` names segment
counts by what the part *is* — `SEG.torso`, `SEG.limb`, `SEG.tiny` — rather than by number,
so "make the arms rounder" is one edit instead of forty at the call sites. It is deliberately
uneven: the torso and the helmet are the two surfaces a player actually looks at and they get
28 and 26 segments; a knuckle stud gets 8. Boxes go through `roundedBox`, which extrudes a
rounded rectangle with a single-segment chamfer — a chamfer kills the razor specular line
down an edge exactly as well as a fillet does at any distance this game is played from, for a
third of the triangles, which is why low-poly hardware is chamfered rather than filleted.
Hairline glow strips stay as raw boxes on purpose: a two-centimetre strip has no visible
chamfer and rounding it spends forty triangles to change nothing.

A character costs 15–23k triangles, up from 3–5k when every curve was built from six flats.
Only the player models pay it — there are at most eight of those in a co-op run — and the
bestiary is untouched at 100–1500 each, so a fifty-strong crowd is exactly as cheap as it was.
`mergeStaticMeshes` still collapses each model to about 50 draw calls either way, which is the
number that actually decides the frame.

Append to `src/data/characters.js` with base stats, a `build` key for the model, and a
`utility`, `special` and (optionally) `ultimate`. The `build` key selects a branch in
`buildPlayerModel` (`entities/models.js`) that hangs the character's own hardware onto a
shared body; that body's proportions and its `torsoKit` / `headKit` live in the same table.
The kits decide how much issued gear is under the character's own — `armoured` is the full
soldier (pack, harness, pouches), `light` is a bare frame, `cloth` is a core something else
is going over, and the head runs `trooper` / `smooth` / `plain` the same way. A wanderer in a
straw hat does not want a rebreather and two belt pouches under his robe, and every one of
those parts would be hidden by the robe anyway. Abilities receive the same combat context
weapons use, extended with movement primitives — `dash`, `lanceDash`, `fireGrapple`,
`momentumPunch`, `blink`, `flight`, `homingVolley`, `bombVolley`, `markSpear`, `shieldCharge`,
`bastion` — and the ultimate-scale helpers `mortarStorm`, `meteorSlam`, `voidStorm`,
`lastStand`, `carpetBomb` and `spearStorm`. Movement states live on the player
(`startGrapple`, `startShieldCharge`, `startFlight`, and `startDash`, which takes
`damage`/`radius`/`onHit` for a dash that pierces) so they compose with collision and the
camera correctly. An ultimate needs no cooldown field: it is gated by the charge meter in
`Combat`, and `ULTIMATE` in `core/config.js` decides how fast that fills.

### Adding a weapon

Append to `src/data/weapons.js` with a `primary` and `secondary`. Damage is expressed as a
multiplier of the player's damage stat so it scales with levels and items automatically. The
context gives you `hitscan`, `spawnBullet`, `spawnMortar`, `cone`, `melee`, `slashWave`,
`shockwave`, `jetBoost`, `blinkSlash` and `chain`. Give each ability an `anim` so the body
acts it out — see `rigAttack` in `entities/characterRig.js` for the moves available.

### Tuning

`src/core/config.js` holds every constant worth touching: the difficulty formula, director
credit rates, chest pricing, rarity tables, Echo payouts, player stats and camera framing.

---

## Sound

There is not an audio file in the repository, and there is not going to be one. Everything you
hear is built out of oscillators and filtered noise at the moment it plays, in `core/audio.js`.

The reasoning is the same as for the models and the textures: the whole game is procedural, and
a folder of `.ogg` files would be the only part of it that had to be downloaded, and the only
part that could not be retuned by changing a number. A weapon's report is derived from its
`model` tag, so a new weapon that reuses an existing silhouette gets a fitting sound without
anyone authoring one.

Three buses hang off the master — effects, music, UI — behind a gentle limiter, with a shared
convolution reverb whose impulse response is synthesised decaying noise. Positional sounds are
attenuated by distance and panned against the camera's right vector, which is enough
spatialisation for a third-person game at a fraction of what a `PannerNode` per voice costs.
Voices are throttled per sound name and capped at 28 at once; anything that would be inaudible
is never synthesised at all, so a fight with forty enemies in it does not cost forty graphs.

The score is a small generative engine rather than a loop. Each theme carries a root, a scale,
a tempo and two timbre dials, so a stage change hands the same engine a different key instead
of cutting to a different track. It is sequenced against the audio clock with a quarter-second
lookahead, so notes land on the grid when the renderer stutters — and if the frame loop stalls
outright, the schedule skips the gap rather than firing every missed note at once. The
arrangement opens up with the fight: percussion arrives with the crowd, and a lead line only
shows up when a boss is out or you are below a third health.

---

## Settings

`Settings` is reachable from the main menu and from the pause panel, and everything on it
writes through immediately — there is no Apply button, because a volume slider you have to
confirm is a volume slider you cannot hear yourself adjusting.

- **Audio** — master, effects and music, plus a mute.
- **Controls** — every action, rebindable onto keys or mouse buttons, two slots each. Binding a
  key that is already in use takes it from whatever had it; the robbed action is shown as
  unbound in red rather than silently losing a slot. Plus mouse sensitivity, a separate
  multiplier that applies only while aiming, and inverted look.
- **Game** — screen shake (down to zero, which changes nothing else), how hard the body snaps
  back to the camera, and a button that unlocks every item, weapon and character at once.

Settings live under their own localStorage key, apart from the profile. Wiping your progress
should not reset your mouse sensitivity, and a profile carried between browsers should not
drag someone else's controls along with it.

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

Progress lives in `localStorage` under `chance-of-precipitation.profile.v1`: Echoes, unlocks, equipped
weapon, lifetime records and the Codex. If storage is unavailable the profile falls back to
memory for the session rather than failing. **Settings → Reset Account** wipes it — Echoes,
unlocks, records and Codex alike — behind a two-click confirmation that disarms itself after
four seconds. **Settings → Game → Unlock All** is the other direction: it grants the whole
catalogue at no Echo cost, behind its own two-click arm, and says so once there is nothing
left to grant. It spends nothing and loses nothing.

Settings live under a separate key, `chance-of-precipitation.settings.v1`, and are
deliberately not part of the profile: a profile is a record of what you have earned, settings
are how the machine in front of you is set up, and wiping one should not touch the other.

The game used to be called SONEYBUN and wrote to `soneybun.profile.v1`. A profile under the
old key is adopted the first time you load a build with the new one, and left where it is —
so an older build still finds its save and nothing is stranded. Erasing progress clears both.
