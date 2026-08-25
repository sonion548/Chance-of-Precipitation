# Graph

Everything in this directory is generated. It is the output of `graphify` — a
knowledge graph built by walking this repository's ASTs and prose — and none of
it is read by the game at runtime. Delete the lot and `npm start` still works.

It is committed rather than ignored because it is useful to a person or an agent
arriving cold: `GRAPH_REPORT.md` names the hub modules and the surprising
connections, and `graph.json` answers "what calls this?" without a grep.

| File | What it is |
| --- | --- |
| `GRAPH_REPORT.md` | The readable summary: corpus size, community hubs, god nodes, freshness. **Start here.** |
| `graph.json` | The graph itself — nodes, edges, hyperedges, and the commit it was built from. |
| `graph.html` | Standalone interactive viewer. Open it in a browser; no server needed. |
| `community_summary.txt` | Per-community prose descriptions. |
| `graphify_labels.json` | Community id → human-readable name. |
| `manifest.json` | Per-file extraction fingerprints. Drives incremental re-extraction. |
| `stat-index.json` | Per-file size/mtime/word-count index. |
| `chunks/*.json` | Cached extractions for document files, keyed by content hash. |
| `cost.json`, `last_query_stamp` | Run bookkeeping. |

## Regenerating

```sh
graphify update .        # incremental — only re-reads what changed, no API cost
```

**graphify writes its output to the directory it is pointed at.** These files
were originally produced at the repository root and were moved here to keep the
root readable, so if a run drops a fresh `graph.json` (and friends) at the root
again, move them back into `graph/` — or point the tool at this directory if
your version supports it. Nothing else depends on the location.

## Two things to know before trusting it

**The source has caught up with the graph, and then moved past it.** The graph
was built on a machine a step ahead of what this repository held: it carried
nodes for `src/core/audio.js`, `src/core/settings.js`, `src/ui/chat.js`,
`src/data/pets.js` and `src/entities/pet.js`, plus `Arena._initLandform`,
`Arena.terrainHeightAt`, `Arena._terrainGeometry`, `Input.captureBinding`,
`Director.partyScale`, `Game.partySize`, `Coop.onPortalState` and a `Portal`
interactable, none of which the source here had. All of them exist now — that
tree is the base game this repository was rebuilt onto, so the graph is no
longer describing somewhere else.

What it has not seen is the work that landed *after* it was built: the
ultimates, Halcyon and Javelin, the Siege Gauntlets, `rigAttack` and the
attack-animation rig, `ctx.slashWave` / `ctx.shockwave` / `ctx.jetBoost` /
`ctx.meteorSlam`, and the merge itself — which removed `Profile.setSetting`,
`Profile.unlockAll` and `Game.applySettings` when the two settings systems were
collapsed into one. Query it for structure, not for a complete symbol list, and
run `graphify update .` to close the gap.

**Some nodes were written in by hand.** The co-op terrain / lobby-code / Void
Reaper / boss-loot / Shrine of Ruin change set was folded in manually, because
graphify is not installed in the environment that change was made in. Those
carry `_origin: "manual"` instead of `_origin: "ast"`:

```py
import json
g = json.load(open("graph/graph.json"))
[n["id"] for n in g["nodes"] if n.get("_origin") == "manual"]
```

`GRAPH_REPORT.md` has the full account under **Hand-applied delta**.

## What was thrown away

The repository briefly held two exports of this graph side by side — the later
one under `(N)`-suffixed filenames, courtesy of a browser download. The later
export is what survives here. `graphify_labels.json.sig` went with the earlier
one: it signs 182 community ids and the surviving labels file has 183, so it
signed a file that no longer exists. graphify rewrites it on the next run.
