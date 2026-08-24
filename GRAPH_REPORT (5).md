# Graph Report - claude project  (2026-08-23)

## Corpus Check
- 66 files · ~162,165 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 3136 nodes · 6787 edges · 182 communities (67 shown, 115 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 297 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `27c550dc`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

### Hand-applied delta (27c550dc)
The co-op terrain / lobby-code / Void Reaper / boss-loot / Shrine of Ruin change
set was folded into the graph by hand: graphify lives as a uv tool on the
author's machine and is not installed in the environment the change was made in.
What that means for anyone reading this:

- **18 nodes and 51 edges were written in manually**, in the shape the AST
  extractor emits (`method`, `contains`, `calls`). They carry `_origin: "manual"`
  instead of `_origin: "ast"`, so a query can separate them:
  `[n for n in graph["nodes"] if n.get("_origin") == "manual"]`. Both endpoints
  of every added edge were checked against the existing graph — there are no
  dangling edges and no duplicate ids.
- **The 19 touched files are flagged for re-extraction** in `manifest.json`:
  their `ast_hash` and `semantic_hash` are cleared and `mtime` zeroed, so the
  next `graphify update .` re-reads them from disk instead of trusting a
  fingerprint taken before the change.
- **`graph.html` and `community_summary.txt` were not regenerated.** They are
  exports, and they still describe the graph as it stood at `269beeaa`. Running
  `graphify update .` and re-exporting refreshes both.

New symbols in the graph: `Arena.terrainHash`, `isTextTarget`, `FX.slash`,
`FX._buildSlashes`, `Game._verifyTerrain`, `Game.livingBosses`,
`Game.bossItemCount`, `Game.spawnBossLoot`, `Game.grantRuinBoon`,
`Game.applyBoon`, `Game.announceRuinBoon`, `Coop._sendWorldTo`,
`Coop.requestStage`, `Coop.partySize`, `Coop.onBoon`, `Chest.isShrine`,
`Player.moveDirection`, and the `tools/coop-check.js` file node.

### The graph is one step ahead of the source in this repository
The graph was built from a working tree this repository does not contain. It
carries nodes for `src/core/audio.js`, `src/core/settings.js`, `src/ui/chat.js`,
`src/data/pets.js` and `src/entities/pet.js`, plus `Arena._initLandform`,
`Arena.terrainHeightAt`, `Arena._terrainGeometry`, `Input.captureBinding`,
`Director.partyScale`, `Game.partySize`, `Coop.onPortalState` and a `Portal`
interactable — none of which exist in the uploaded snapshot the source here was
edited from (that snapshot still has `src/entities/minion.js`, since renamed to
`pet.js`). Read the graph as describing the newer tree and the source as the
older one, until both are rebuilt from one commit.

## Community Hubs (Navigation)
- three.module.js
- Arena
- models.js
- Player
- n
- di
- menus.js
- .push
- Game
- ii
- Enemy
- .clone
- lr
- Pet
- li
- .render
- ti
- wi
- am
- .applyMatrix4
- .constructor
- dr
- dd
- ds
- player.js
- ts
- hc
- remotePlayer.js
- .constructor
- clamp01
- PickupManager
- Menus
- .updateMatrixWorld
- .setValues
- _h
- lm
- .multiplyScalar
- FX
- Coop
- hm
- Audio
- Relay
- co
- ba
- .subVectors
- qs
- gl
- Profile
- projectiles.js
- pu
- .update
- zr
- qh
- .fromArray
- jp
- Inventory
- mathx.js
- .toJSON
- compilerOptions
- ei
- NetSession
- .getAttribute
- s
- qi
- .dot
- .copy
- graphify
- package.json
- Director
- Chat
- zc
- id
- .raycast
- .dispatchEvent
- ru
- .toArray
- r2
- ai
- .fromJSON
- Input
- _r
- jh
- kp
- vm
- .parse
- combat.js
- lc
- eu
- qn
- cc
- is
- qp
- Step 6: Obsidian Vault + HTML Export
- SONEYBUN — Descent Protocol (README)
- bi
- cp
- cs
- ._finishRun
- settings.js
- _p
- xp
- Tl
- wc
- Extraction Subagent Prompt
- --update Incremental Re-extraction
- fm
- Step 4: Build Graph, Cluster, Analyze
- Step 3: Extract Entities & Relationships
- SONEYBUN — Descent Protocol (Project State)
- zp
- qu
- pm
- Step 0: GitHub Repos & Multi-Path Merge
- Performance: Shader Programs, Effect Pools, Broadphase
- ac
- ci
- Dm
- il
- gh
- kh
- sp
- sc
- mm
- check.js
- gs
- gu
- hd
- ih
- hud.js
- lf
- mu
- na
- nh
- ym
- od
- pa
- rd
- sd
- Chest
- xu
- yu
- Honesty Rules
- Declarative Item System (stats/hooks)
- Object3D.add Returns Parent, Not Child
- Proc Coefficients
- fp
- fs
- hh
- kc
- ko
- lh
- ms
- pi
- ps
- up
- ri
- _s
- vc
- vp
- wh
- xs
- yh
- yl
- ys
- game.js
- _d
- km
- zs
- ip
- _u
- ud
- np
- qd

## God Nodes (most connected - your core abstractions)
1. `li` - 76 edges
2. `Coop` - 58 edges
3. `ti` - 58 edges
4. `Game` - 56 edges
5. `wi` - 52 edges
6. `Audio` - 49 edges
7. `dr` - 47 edges
8. `Enemy` - 44 edges
9. `ii()` - 40 edges
10. `am` - 40 edges

## Surprising Connections (you probably didn't know these)
- `Discrete Confidence Score Rubric` --semantically_similar_to--> `Difficulty-as-Time Formula`  [INFERRED] [semantically similar]
  .claude/skills/graphify/references/extraction-spec.md → README.md
- `Honesty Rules` --semantically_similar_to--> `Test-Harness Lessons (harnesses lie, measure before optimizing)`  [INFERRED] [semantically similar]
  .claude/skills/graphify/SKILL.md → PROJECTSTATE.md
- `In-Run HUD Markup` --shares_data_with--> `Difficulty-as-Time Formula`  [INFERRED]
  index.html → README.md
- `Project graphify Usage Rules` --conceptually_related_to--> `--update Incremental Re-extraction`  [INFERRED]
  CLAUDE.md → .claude/skills/graphify/references/update.md
- `Six Arena Themes + Triplanar Projection` --conceptually_related_to--> `SONEYBUN — Descent Protocol (Project State)`  [INFERRED]
  README.md → PROJECTSTATE.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Core Graphify Pipeline (Detect -> Extract -> Build -> Label -> Cleanup)** — _claude_skills_graphify_skill_step2_detect, _claude_skills_graphify_skill_step3_extract, _claude_skills_graphify_skill_step4_build, _claude_skills_graphify_skill_step5_label, _claude_skills_graphify_skill_step9_cleanup [INFERRED 0.85]
- **Graph Query Sub-Commands (query/path/explain/add)** — _claude_skills_graphify_references_query_bfs_dfs, _claude_skills_graphify_references_query_path_command, _claude_skills_graphify_references_query_explain_command, _claude_skills_graphify_references_add_watch_add_command [INFERRED 0.85]
- **SONEYBUN Co-op Authority Design** — projectstate_coop_authority_split, projectstate_combat_damageenemy, projectstate_party_scaling [INFERRED 0.85]

## Communities (182 total, 115 thin omitted)

### Community 0 - "three.module.js"
Cohesion: 0.02
Nodes (88): _a, aa, ar, bc, bm, br, bs, _c (+80 more)

### Community 1 - "Arena"
Cohesion: 0.05
Nodes (51): disposeObject(), Engine, Arena, clamp01(), gradientMaterial(), _scatter, smoothstep(), UNIT_BOX (+43 more)

### Community 2 - "models.js"
Cohesion: 0.12
Nodes (43): itemIconCanvas(), addGrowths(), addPlates(), addSeams(), addSpines(), articulatedLimb(), boltRow(), box() (+35 more)

### Community 3 - "Player"
Cohesion: 0.08
Nodes (10): armorMultiplier(), freshAccumulator(), Player, moveWithCollision(), overlapsBox(), rayBox(), raycastBoxes(), raycastGround() (+2 more)

### Community 4 - "n"
Cohesion: 0.10
Nodes (16): e(), n(), bl(), o(), i(), kd, ll(), nc() (+8 more)

### Community 5 - "di"
Cohesion: 0.05
Nodes (4): di, _m(), wm, zi

### Community 6 - "menus.js"
Cohesion: 0.12
Nodes (24): ECHOES, RUN_MODES, VERSION, hyperbolic(), CHARACTERS, CHARACTERS_BY_ID, DEFAULT_CHARACTER, DEFAULT_UNLOCKED_CHARACTERS (+16 more)

### Community 7 - ".push"
Cohesion: 0.09
Nodes (13): ad, l(), cd, ed, ep, p(), i(), d() (+5 more)

### Community 10 - "Enemy"
Cohesion: 0.09
Nodes (3): Enemy, EnemyManager, rayCapsule()

### Community 11 - ".clone"
Cohesion: 0.18
Nodes (3): A(), gp, ws

### Community 15 - ".render"
Cohesion: 0.09
Nodes (24): r(), c(), h(), l(), g(), t(), ic(), h() (+16 more)

### Community 18 - "am"
Cohesion: 0.06
Nodes (3): am, constructor(), om

### Community 20 - ".constructor"
Cohesion: 0.11
Nodes (29): E(), s(), B(), F(), k(), O(), P(), V() (+21 more)

### Community 24 - "player.js"
Cohesion: 0.07
Nodes (45): angleLerp(), clamp(), damp(), lerp(), wrapAngle(), _aimDir, _aimQuat, applyCloak() (+37 more)

### Community 25 - "ts"
Cohesion: 0.07
Nodes (5): bp, gi(), Jn(), ts, Zn()

### Community 27 - "remotePlayer.js"
Cohesion: 0.09
Nodes (10): COOP, characterById(), createRig(), rigFlinch(), rigRecoil(), _v, angleBlend(), RemotePlayer (+2 more)

### Community 28 - ".constructor"
Cohesion: 0.12
Nodes (9): rc, bt(), kt(), Lt(), Pt(), $t(), Tt(), Wt() (+1 more)

### Community 30 - "PickupManager"
Cohesion: 0.09
Nodes (4): PickupManager, Portal, Teleporter, buildOrbModel()

### Community 31 - "Menus"
Cohesion: 0.17
Nodes (5): formatNumber(), formatTime(), codeLabel(), esc(), Menus

### Community 33 - ".setValues"
Cohesion: 0.06
Nodes (10): bd, fd, Md, rs, uh, vd, wd, xd (+2 more)

### Community 36 - ".multiplyScalar"
Cohesion: 0.06
Nodes (6): v(), au, S(), ou, rf, zu()

### Community 40 - "Audio"
Cohesion: 0.08
Nodes (11): Audio, noteHz(), fx, hashSeed(), RNG, _c, _m, _q (+3 more)

### Community 41 - "Relay"
Cohesion: 0.16
Nodes (9): acceptKey(), Conn, encodeFrame(), Relay, lanAddresses(), relay, ROOT, server (+1 more)

### Community 42 - "co"
Cohesion: 0.16
Nodes (22): ao, bo(), co(), Do(), eo, fo(), go(), ho() (+14 more)

### Community 44 - ".subVectors"
Cohesion: 0.11
Nodes (4): ec, hs, or, qr

### Community 46 - "gl"
Cohesion: 0.10
Nodes (10): Al(), gl(), G(), J(), q(), W(), Z(), _l() (+2 more)

### Community 48 - "projectiles.js"
Cohesion: 0.10
Nodes (14): glowMaterial(), haloCache, haloMaterial(), hazardCache, hazardMaterial(), matCache, ProjectileManager, RING (+6 more)

### Community 49 - "pu"
Cohesion: 0.11
Nodes (3): af, fu, pu

### Community 50 - ".update"
Cohesion: 0.11
Nodes (13): cm, ia, of, qa(), a(), Gt(), sa, r() (+5 more)

### Community 56 - "mathx.js"
Cohesion: 0.13
Nodes (16): DIRECTOR, rollProc(), smoothstep(), TAU, AFFIX_BY_ID, BOSSES, ELITE_AFFIXES, ENEMIES (+8 more)

### Community 57 - ".toJSON"
Cohesion: 0.07
Nodes (7): r(), s(), oc, rp, tp, xc, yp

### Community 58 - "compilerOptions"
Cohesion: 0.12
Nodes (16): compilerOptions, baseUrl, checkJs, lib, module, moduleResolution, target, exclude (+8 more)

### Community 61 - ".getAttribute"
Cohesion: 0.15
Nodes (4): bu, um, vh(), zm

### Community 62 - "s"
Cohesion: 0.15
Nodes (15): s(), Hn, ja(), a(), o(), s(), b(), m() (+7 more)

### Community 65 - ".copy"
Cohesion: 0.08
Nodes (5): ha, hp, mp, ol(), tc

### Community 66 - "graphify"
Cohesion: 0.14
Nodes (14): Graphify Trigger Note, /graphify add, Debounce (3s default), --watch (graphify.watch), Post-Commit Hook (graphify hook install), BFS vs DFS Traversal Modes, /graphify explain, /graphify path (+6 more)

### Community 67 - "package.json"
Cohesion: 0.13
Nodes (14): description, devDependencies, @types/three, engines, node, name, private, scripts (+6 more)

### Community 71 - "id"
Cohesion: 0.12
Nodes (4): id, ld, nd, zd

### Community 72 - ".raycast"
Cohesion: 0.12
Nodes (3): ah, bh, vs

### Community 74 - "ru"
Cohesion: 0.14
Nodes (4): iu(), ku(), ru, su

### Community 77 - "ai"
Cohesion: 0.22
Nodes (5): ai(), fi(), _i, mi, oi()

### Community 78 - ".fromJSON"
Cohesion: 0.12
Nodes (3): cu, lu, nu()

### Community 87 - "combat.js"
Cohesion: 0.11
Nodes (10): weaponById(), Combat, _dir, _origin, _ray, SECONDARY_ACTION, SPECIAL_ACTION, UTILITY_ACTION (+2 more)

### Community 94 - "Step 6: Obsidian Vault + HTML Export"
Cohesion: 0.22
Nodes (9): Token Reduction Benchmark, FalkorDB Export (--falkordb/--falkordb-push), MCP stdio Server (graphify.serve), Neo4j Export (--neo4j/--neo4j-push), SVG/GraphML Export, Wiki Export (--wiki), Native CLAUDE.md Integration (graphify claude install), Step 6: Obsidian Vault + HTML Export (+1 more)

### Community 95 - "SONEYBUN — Descent Protocol (README)"
Cohesion: 0.31
Nodes (9): index.html Shell (HUD + Screens Markup), In-Run HUD Markup, Importmap (three -> vendor/three.module.js), Screen System (menu/loadout/coop/unlocks/codex/stats/help/pause/summary), Combat.damageEnemy Single Entry Point, PARTY Co-op Scaling Config, Co-op Lobby Flow, 62-Item Rarity System (+1 more)

### Community 100 - "settings.js"
Cohesion: 0.14
Nodes (9): SCALES, THEME_MUSIC, ACTIONS, DEFAULT_BINDINGS, freshSettings(), read(), RESERVED_CODES, settings (+1 more)

### Community 106 - "Extraction Subagent Prompt"
Cohesion: 0.29
Nodes (7): Discrete Confidence Score Rubric, Hyperedges (>=3-node groupings), Node ID Format Spec, Rationale-as-Attribute Rule, Extraction Subagent Prompt, Semantic Extraction Cache, Difficulty-as-Time Formula

### Community 107 - "--update Incremental Re-extraction"
Cohesion: 0.29
Nodes (6): Domain-Hint Prompt Composition, Whisper Transcription, build_merge(), --update Incremental Re-extraction, Manifest Stamping Only On Success (#2015/#1948/#1908/#1417), Step 2.5: Video/Audio Transcription

### Community 110 - "Step 4: Build Graph, Cluster, Analyze"
Cohesion: 0.40
Nodes (6): god_nodes / surprising_connections / suggest_questions Analysis, Shrink-Guard (#479), Step 4.5: Graph Health Check, Step 4: Build Graph, Cluster, Analyze, Step 5: Label Communities, Step 9: Manifest, Cost Tracker, Cleanup

### Community 111 - "Step 3: Extract Entities & Relationships"
Cohesion: 0.47
Nodes (6): Step 1: Ensure Graphify Installed, Step 2: Detect Files, Step 3: Extract Entities & Relationships, Part A: Structural (AST) Extraction, Part B: Semantic Extraction (Subagents), Part C: Merge AST + Semantic

### Community 112 - "SONEYBUN — Descent Protocol (Project State)"
Cohesion: 0.33
Nodes (6): Split Co-op Authority Model, SONEYBUN — Descent Protocol (Project State), Six Arena Themes + Triplanar Projection, Optional Ending: Null Sanctum / Null Sovereign, Four Pet Species, Unloader Grapple -> Overcharged Fist Combo

### Community 116 - "qu"
Cohesion: 0.40
Nodes (3): qu(), Uu(), vu

### Community 118 - "Step 0: GitHub Repos & Multi-Path Merge"
Cohesion: 0.50
Nodes (4): graphify clone, graphify merge-graphs, Monorepo Multi-Subfolder Flow, Step 0: GitHub Repos & Multi-Path Merge

### Community 119 - "Performance: Shader Programs, Effect Pools, Broadphase"
Cohesion: 0.50
Nodes (4): Broadphase Collision Grid, mergeStaticMeshes (sub-mesh merging), Never Toggle visible on a Light, Performance: Shader Programs, Effect Pools, Broadphase

### Community 123 - "il"
Cohesion: 0.15
Nodes (6): bind(), el(), getValue(), il, nl(), setValue()

### Community 134 - "hud.js"
Cohesion: 0.16
Nodes (10): codeShort(), C, dataUrlCache, drawItemIcon(), ICON_RECIPES, itemIconDataURL(), makeBrush(), TAG_FALLBACK (+2 more)

### Community 170 - "ys"
Cohesion: 0.22
Nodes (3): ls(), os(), ys

### Community 171 - "game.js"
Cohesion: 0.07
Nodes (35): CAMERA, DIFFICULTY, ECONOMY, FINAL, PARTY, PETS, PLAYER, RARITY (+27 more)

## Knowledge Gaps
- **231 isolated node(s):** `target`, `module`, `moduleResolution`, `checkJs`, `ES2022` (+226 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **115 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ti` connect `ti` to `three.module.js`, `.dot`, `.multiplyScalar`, `.dispatchEvent`, `.clone`, `.constructor`, `hc`, `qi`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **Why does `hm` connect `hm` to `three.module.js`, `lm`, `qp`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Why does `dr` connect `dr` to `three.module.js`, `.copy`, `.dispatchEvent`, `.clone`, `_r`, `.invert`, `.parse`, `.toJSON`, `.constructor`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **What connects `target`, `module`, `moduleResolution` to the rest of the system?**
  _231 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `three.module.js` be split into smaller, more focused modules?**
  _Cohesion score 0.021500559910414333 - nodes in this community are weakly interconnected._
- **Should `Arena` be split into smaller, more focused modules?**
  _Cohesion score 0.05277262420119563 - nodes in this community are weakly interconnected._
- **Should `models.js` be split into smaller, more focused modules?**
  _Cohesion score 0.1226215644820296 - nodes in this community are weakly interconnected._