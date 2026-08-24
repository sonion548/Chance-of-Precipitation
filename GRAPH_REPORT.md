# Graph Report - claude project  (2026-08-23)

## Corpus Check
- 66 files · ~148,743 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 3110 nodes · 6722 edges · 183 communities (63 shown, 120 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 297 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ec0bbb2f`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

### Hand-applied delta (ec0bbb2f)
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
- i
- di
- game.js
- .push
- Game
- ii
- Enemy
- .addScaledVector
- lr
- Pet
- li
- r
- ti
- wi
- am
- .applyMatrix4
- n
- dr
- dd
- ds
- characterRig.js
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
- .dot
- qs
- gl
- Profile
- projectiles.js
- pu
- .update
- qh
- .fromArray
- jp
- Inventory
- player.js
- .toJSON
- compilerOptions
- ei
- NetSession
- .getAttribute
- .dispose
- qi
- oa
- .copy
- graphify
- package.json
- Director
- Chat
- zc
- id
- .raycast
- .constructor
- ru
- .toArray
- r2
- ai
- lu
- Input
- du
- jh
- kp
- vm
- Engine
- Combat
- lc
- eu
- qn
- cc
- is
- qp
- Step 6: Obsidian Vault + HTML Export
- SONEYBUN — Descent Protocol (README)
- bi
- .render
- .union
- gd
- SettingsStore
- _p
- xp
- Tl
- wc
- Extraction Subagent Prompt
- --update Incremental Re-extraction
- fm
- .connect
- Step 4: Build Graph, Cluster, Analyze
- Step 3: Extract Entities & Relationships
- SONEYBUN — Descent Protocol (Project State)
- zp
- Kn
- qu
- yp
- Step 0: GitHub Repos & Multi-Path Merge
- Performance: Shader Programs, Effect Pools, Broadphase
- ac
- ci
- Dm
- el
- gh
- kh
- sp
- sc
- sf
- check.js
- gs
- gu
- hd
- ih
- itemArt.js
- lf
- mu
- na
- nh
- oc
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
- .updateMatrix
- ri
- _s
- vc
- vp
- wh
- xs
- yh
- yl
- ys
- pet.js
- af
- _d
- hu
- zs
- tu
- _u
- ud
- xc

## God Nodes (most connected - your core abstractions)
1. `li` - 76 edges
2. `Coop` - 58 edges
3. `ti` - 58 edges
4. `Game` - 56 edges
5. `wi` - 52 edges
6. `Audio` - 49 edges
7. `dr` - 47 edges
8. `ii()` - 40 edges
9. `am` - 40 edges
10. `Enemy` - 39 edges

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

## Communities (183 total, 120 thin omitted)

### Community 0 - "three.module.js"
Cohesion: 0.02
Nodes (86): _a, aa, ar, bc, bm, br, bs, _c (+78 more)

### Community 1 - "Arena"
Cohesion: 0.06
Nodes (49): disposeObject(), Arena, _scatter, smoothstep(), UNIT_BOX, applyWind(), brokenWall(), bush() (+41 more)

### Community 2 - "models.js"
Cohesion: 0.10
Nodes (45): petById(), _v, addGrowths(), addPlates(), addSeams(), addSpines(), articulatedLimb(), boltRow() (+37 more)

### Community 3 - "Player"
Cohesion: 0.06
Nodes (18): armorMultiplier(), freshAccumulator(), Player, _dir, _origin, _ray, SECONDARY_ACTION, SPECIAL_ACTION (+10 more)

### Community 4 - "i"
Cohesion: 0.07
Nodes (15): e(), ap, bp, ep, o(), i(), ip, kd (+7 more)

### Community 5 - "di"
Cohesion: 0.06
Nodes (3): di, _m(), wm

### Community 6 - "game.js"
Cohesion: 0.06
Nodes (59): COOP, DIFFICULTY, DIRECTOR, ECHOES, ECONOMY, FINAL, PARTY, PETS (+51 more)

### Community 7 - ".push"
Cohesion: 0.08
Nodes (11): ad, l(), cs, ed, p(), p(), Nm(), td() (+3 more)

### Community 10 - "Enemy"
Cohesion: 0.09
Nodes (3): Enemy, EnemyManager, rayCapsule()

### Community 15 - "r"
Cohesion: 0.09
Nodes (27): s(), r(), c(), h(), l(), g(), t(), ic() (+19 more)

### Community 18 - "am"
Cohesion: 0.05
Nodes (5): am, bind(), constructor(), getValue(), om

### Community 20 - "n"
Cohesion: 0.11
Nodes (33): n(), bl(), E(), s(), B(), F(), k(), O() (+25 more)

### Community 24 - "characterRig.js"
Cohesion: 0.13
Nodes (28): angleLerp(), clamp(), damp(), lerp(), wrapAngle(), _aimDir, _aimQuat, applyCloak() (+20 more)

### Community 25 - "ts"
Cohesion: 0.09
Nodes (4): gi(), Jn(), ts, Zn()

### Community 27 - "remotePlayer.js"
Cohesion: 0.09
Nodes (8): characterById(), weaponById(), createRig(), rigFlinch(), rigRecoil(), angleBlend(), RemotePlayer, _v

### Community 28 - ".constructor"
Cohesion: 0.08
Nodes (14): cd, il, rc, bt(), Gt(), Lt(), Pt(), qt() (+6 more)

### Community 30 - "PickupManager"
Cohesion: 0.07
Nodes (5): Egg, PickupManager, Portal, Teleporter, buildOrbModel()

### Community 31 - "Menus"
Cohesion: 0.14
Nodes (6): formatNumber(), codeLabel(), itemIconDataURL(), itemDescription(), esc(), Menus

### Community 33 - ".setValues"
Cohesion: 0.06
Nodes (10): bd, fd, Md, rs, uh, vd, wd, xd (+2 more)

### Community 36 - ".multiplyScalar"
Cohesion: 0.07
Nodes (6): v(), au, S(), ou, rh, zu()

### Community 41 - "Relay"
Cohesion: 0.16
Nodes (9): acceptKey(), Conn, encodeFrame(), Relay, lanAddresses(), relay, ROOT, server (+1 more)

### Community 42 - "co"
Cohesion: 0.16
Nodes (22): ao, bo(), co(), Do(), eo, fo(), go(), ho() (+14 more)

### Community 44 - ".dot"
Cohesion: 0.07
Nodes (7): ec, hs, or, qr, Yn(), zi, zr

### Community 46 - "gl"
Cohesion: 0.15
Nodes (9): Al(), gl(), G(), J(), q(), W(), Z(), J() (+1 more)

### Community 47 - "Profile"
Cohesion: 0.14
Nodes (4): freshProfile(), migrate(), Profile, readRaw()

### Community 48 - "projectiles.js"
Cohesion: 0.05
Nodes (23): fx, hashSeed(), RNG, glowMaterial(), haloCache, haloMaterial(), hazardCache, hazardMaterial() (+15 more)

### Community 50 - ".update"
Cohesion: 0.18
Nodes (6): km, of, qa(), a(), sa, r()

### Community 56 - "player.js"
Cohesion: 0.08
Nodes (23): SCALES, THEME_MUSIC, CAMERA, WORLD, ACTIONS, codeShort(), DEFAULT_BINDINGS, RESERVED_CODES (+15 more)

### Community 57 - ".toJSON"
Cohesion: 0.15
Nodes (4): r(), s(), rp, tp

### Community 58 - "compilerOptions"
Cohesion: 0.12
Nodes (16): compilerOptions, baseUrl, checkJs, lib, module, moduleResolution, target, exclude (+8 more)

### Community 61 - ".getAttribute"
Cohesion: 0.18
Nodes (3): bu, vh(), zm

### Community 62 - ".dispose"
Cohesion: 0.13
Nodes (14): cm, Hn, ja(), a(), o(), s(), m(), S() (+6 more)

### Community 65 - ".copy"
Cohesion: 0.05
Nodes (11): gp, ha, hp, mm, nc(), i(), n(), pm (+3 more)

### Community 66 - "graphify"
Cohesion: 0.14
Nodes (14): Graphify Trigger Note, /graphify add, Debounce (3s default), --watch (graphify.watch), Post-Commit Hook (graphify hook install), BFS vs DFS Traversal Modes, /graphify explain, /graphify path (+6 more)

### Community 67 - "package.json"
Cohesion: 0.13
Nodes (14): description, devDependencies, @types/three, engines, node, name, private, scripts (+6 more)

### Community 71 - "id"
Cohesion: 0.10
Nodes (4): id, ld, nd, zd

### Community 72 - ".raycast"
Cohesion: 0.12
Nodes (3): ah, bh, vs

### Community 73 - ".constructor"
Cohesion: 0.12
Nodes (7): N(), kl, _l(), ql(), R(), U(), kt()

### Community 74 - "ru"
Cohesion: 0.14
Nodes (4): iu(), ku(), ru, su

### Community 77 - "ai"
Cohesion: 0.18
Nodes (5): ai(), fi(), _i, mi, oi()

### Community 78 - "lu"
Cohesion: 0.15
Nodes (3): cu, lu, nu()

### Community 94 - "Step 6: Obsidian Vault + HTML Export"
Cohesion: 0.22
Nodes (9): Token Reduction Benchmark, FalkorDB Export (--falkordb/--falkordb-push), MCP stdio Server (graphify.serve), Neo4j Export (--neo4j/--neo4j-push), SVG/GraphML Export, Wiki Export (--wiki), Native CLAUDE.md Integration (graphify claude install), Step 6: Obsidian Vault + HTML Export (+1 more)

### Community 95 - "SONEYBUN — Descent Protocol (README)"
Cohesion: 0.31
Nodes (9): index.html Shell (HUD + Screens Markup), In-Run HUD Markup, Importmap (three -> vendor/three.module.js), Screen System (menu/loadout/coop/unlocks/codex/stats/help/pause/summary), Combat.damageEnemy Single Entry Point, PARTY Co-op Scaling Config, Co-op Lobby Flow, 62-Item Rarity System (+1 more)

### Community 100 - "SettingsStore"
Cohesion: 0.26
Nodes (3): freshSettings(), read(), SettingsStore

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

### Community 134 - "itemArt.js"
Cohesion: 0.24
Nodes (8): C, dataUrlCache, drawItemIcon(), ICON_RECIPES, itemIconCanvas(), makeBrush(), TAG_FALLBACK, itemIconTexture()

### Community 171 - "pet.js"
Cohesion: 0.25
Nodes (7): PET_BY_ID, PETS_SPECIES, rollPetSpecies(), _dir, _v, _v2, WHITE

## Knowledge Gaps
- **225 isolated node(s):** `target`, `module`, `moduleResolution`, `checkJs`, `ES2022` (+220 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **120 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ti` connect `ti` to `three.module.js`, `.copy`, `.multiplyScalar`, `.constructor`, `.dot`, `.length`, `hc`, `.constructor`, `qi`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **Why does `dr` connect `dr` to `three.module.js`, `.updateMatrix`, `.copy`, `i`, `ii`, `.invert`, `.toJSON`, `.constructor`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **Why does `wi` connect `wi` to `three.module.js`, `.multiplyScalar`, `.dot`, `.length`, `hc`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **What connects `target`, `module`, `moduleResolution` to the rest of the system?**
  _225 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `three.module.js` be split into smaller, more focused modules?**
  _Cohesion score 0.021972884525479196 - nodes in this community are weakly interconnected._
- **Should `Arena` be split into smaller, more focused modules?**
  _Cohesion score 0.06498599439775911 - nodes in this community are weakly interconnected._
- **Should `models.js` be split into smaller, more focused modules?**
  _Cohesion score 0.10122448979591837 - nodes in this community are weakly interconnected._