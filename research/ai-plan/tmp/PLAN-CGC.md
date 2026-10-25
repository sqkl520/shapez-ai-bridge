I have all the evidence I need. Here is the plan.

---

# PLAN-CGC — Making `CgScScCg` compile

**Verification baseline (reproduced):** `node src/ai/compiler/cli.mjs --goal CgScScCg --seed 43391 --hub -2,-2 --range 400 --no-handoff` → `ok:false`, `reason=dag-not-placeable:column-conflict-unresolved`, failing node `-g------` @ `[-410,55]`, check `V6-crossing`.

`CpCpCpCp` compiles (383 entities, 378 belt tiles, 8 corners). `CuCuCuCu`, `----CuCu`, `RuRu----`, `CrCrCrCr`, `RbRb----` all compile. Baselines for all seven goals are recorded under §6.

---

## 0. Three corrections to the brief (evidence first)

I reproduced every claim and two of the three framing assumptions are wrong. This changes the recommendation, so it comes first.

### 0.1 The prototype `blue(387,-192) green(387,-196) mix(387,-204)` is refuted — it is not 10/11, it is 6/11

The prototype scripts pass `{}` as the occupancy context:

- `research/ai-plan/tmp/proto-cgc.mjs:9` — `planChannel(first, o.dir, last, i.dir, {})`
- `research/ai-plan/tmp/proto-multirow.mjs:27` — same
- `research/ai-plan/tmp/proto2.mjs:14` — same

With an empty occupancy set every channel "passes" because nothing can collide. Re-running the *same coordinates* with the real machine footprints in `occupied` (exactly what `place()` builds at `src/ai/compiler/place.mjs:1274-1284`) gives:

```
blue->mix[0]      FAIL cell-occupied @[387,-196]      <- the green miner itself
green1->mix[1]    ok z/2
...
=> 6/11
```

`blue(387,-192)` and `green(387,-196)` share **column 387**. Blue's vertical stem must descend through `(387,-193..-203)` and the green miner occupies `(387,-196)`. Moving the stacker to the painters' right takes it to **7/11**, not 11/11.

The prototype's Su coordinate is also fictitious — `su:{op:'mine',x:300,y:-192}` but there is **no `SuSuSuSu` ore anywhere in x∈[250,520]** on seed 43391 (`resourcesInRegion` over ±400 returns 0 cells). So the prototype never tested a realizable layout.

**Consequence:** the "10 of 11 / 11 of 11" number cannot be used as evidence for option (a). The recommendation below is derived from geometry instead.

### 0.2 B1 is not a distance problem — it is a slot-ordering problem

The brief says the mixer's parents are 46 cells apart while its inputs are adjacent. I swept the distance explicitly, holding everything else fixed (`mine` at row 56, `mix` at row 48, slot0 parent at `x=a`, slot1 parent at `x=b`):

```
slot0 parent WEST of slot1 parent:
  a=-2   -> slot0 straight, slot1 z    OK
  a=-5   -> OK
  a=-20  -> OK
  a=-100 -> OK
  a=-193 -> OK            <- 193 cells apart, routable

slot0 parent EAST of slot1 parent:
  a=0,b=-2   -> slot1 FAIL cell-occupied
  a=0,b=-5   -> slot1 FAIL
  a=0,b=-20  -> slot1 FAIL
  a=0,b=-100 -> slot1 FAIL
  a=0,b=-193 -> slot1 FAIL
```

The failure is **invariant to distance from 2 cells to 193 cells**. It is caused by the relative order. The mechanism:

A straight drop into a mixer's slot-1 input lands on column `mix.x+1`. A parent whose column is `> mix.x+1` must approach from the east, and the only 0/1/2-corner forms in `planChannel` (`place.mjs:813-876`) all require the vertical leg to descend at a column `<= last.x`. A parent at `mix.x` (i.e. directly above slot 0) that feeds slot 1 needs to shift **east by one** while descending only `rowGap-1 = 7` rows — the Z form needs a lane row strictly between `first.y+1` and `last.y-1` (`pickLane`, `place.mjs:905-927`, the `lo = f+1` / `hi = l-1` bounds), and 0 rows are available. `pickLane` returns `null` → `column-conflict`.

The governing law, confirmed by direct experiment: **for a `bottom`-input at column `c`, the feeding parent must be at column `< c` (straight/Z) or exactly `c` (straight) — never `> c`.** Slot 1 is at `c = mix.x+1`, so its parent must be `<= mix.x+1`; slot 0's parent must be `<= mix.x`. Two distinct parents on one row therefore need `slot0.parent.x < slot1.parent.x`, i.e. **slot order must match west→east order**. That is precisely the invariant `layerAndOrder`'s barycenter sort does *not* guarantee, and `planMinerColumns` (place.mjs:524-532) explicitly builds for the *layout* order, not the *slot* order.

### 0.3 B2 is real, but multi-row miners do not fix B1

`assignRows` consumes only `minerX.get(n.id)[0]` — the **x** — at `place.mjs:639`. The y is discarded; every level-0 node gets `n.row = baseY` at `place.mjs:613`. So B2 as stated is correct.

But I tested whether giving the far mixer parent its own row unblocks it, varying the green miner's y from 60 down to 40 with the mix fixed at 48:

```
green y=60 -> FAIL cell-occupied
green y=58 -> FAIL cell-occupied
green y=56 -> FAIL cell-occupied
green y=54 -> FAIL cell-occupied
green y=52 -> FAIL cell-occupied
green y=50 -> FAIL column-conflict
green y=44 -> FAIL column-conflict
green y=40 -> FAIL column-conflict
```

**Every y fails.** Moving the parent to another row cannot fix B1, because B1 is a *column-order* violation, and no vertical displacement changes a column comparison. Multi-row miners are orthogonal to B1.

### 0.4 There is a third blocker the brief does not list: the stacker

With the mixer slot order corrected and the miners left on one row, I got 10/11 — the residual failure was `n5->n10 cell-occupied`. Isolating it:

```
painters both on row y=40, stacker east:
  p1 x=0,  p2 x=2,  st=20  -> p1 FAIL  p2 elbow
  p1 x=0,  p2 x=4,  st=20  -> p1 FAIL  p2 elbow
  p1 x=0,  p2 x=6,  st=20  -> p1 FAIL  p2 elbow
  p1 x=0,  p2 x=8,  st=20  -> p1 FAIL  p2 elbow
  p1 x=0,  p2 x=12, st=20  -> p1 FAIL  p2 elbow
  p1 x=6,  p2 x=0,  st=12  -> p1 elbow p2 FAIL
```

**No arrangement of two painters on a shared row can feed one stacker** — one of the two always fails. This is the same law as §0.2 applied twice: stacker slot 0 is at `c = st.x`, slot 1 at `c = st.x+1`, and both parents emit `right`. With both on one row, the west parent's horizontal run to reach `st.x` passes through the east parent's body (or vice versa).

The working configuration is a **row-order** constraint, not an x constraint:

```
slot0-parent y=40 (above), slot1-parent y=48  -> p0 elbow  p1 elbow  OK
slot0-parent y=48 (below), slot1-parent y=40  -> p0 elbow  p1 FAIL   BLOCKED
both y=40 (same row)                          -> p0 elbow  p1 FAIL   BLOCKED
```

i.e. **the parent feeding the lower input slot must be on a *higher* row than the parent feeding the upper slot.** Note this is "higher on screen = smaller y = further from the hub", which matches the "upstream below, downstream above" sense of the doc at `place.mjs:431-435` only if you read "below" as larger y.

This matters because **B2 is a genuine multi-row requirement, but it is at level 2 (painters), not level 0 (miners).** `assignRows` gives one y per level (`place.mjs:611-615`), so `n5` and `n9` are forced onto the same row no matter what `rowGap` is:

```
rowGap= 8 -> painters n5@-121,40 n9@-39,40  conflicts=3
rowGap=10 -> painters n5@-121,36 n9@-39,36  conflicts=3
rowGap=12 -> painters n5@-121,32 n9@-39,32  conflicts=3
rowGap=14 -> painters n5@-121,28 n9@-28,28  conflicts=3
rowGap=16 -> painters n5@-121,24 n9@-39,24  conflicts=3
rowGap=20 -> painters n5@-121,16 n9@-39,16  conflicts=3
```

`routeStage`'s gap-widening retry loop (`compile.mjs:790-831`) is **structurally incapable** of ever fixing this, because widening moves y but never separates two same-level nodes. That is why the 4 retry tiers all report the identical 3 conflicts.

---

## 1. Recommendation: option (a), generalized — per-node `y` for *any* level, not just miners

**Recommendation: (a'), a generalization of (a).** Let `assignRows` accept an optional per-node row override for **every** level, computed by a new planner that reasons about slot order, not just about ore.

Rejecting the alternatives with evidence:

- **(b) give each miner its own DAG level — reject.** Confirmed: it changes semantics. `normalizeDepths` (`place.mjs:405-429`) recomputes depth purely from `parents`, and `layerAndOrder` (`place.mjs:440-471`) buckets strictly by `n.depth`. A miner at depth 1 would additionally violate the level-0-is-miners assumption at `place.mjs:1208-1213` (`levels[0].filter(n => n.op === "mine")`) and at `place.mjs:1236` (`nodes.filter` — this one is fine). Worse, it does not help: §0.3 shows row separation does not fix B1 anyway.
- **(c) route the long mixer feed as a 3-segment Z with a dedicated lane row — reject as a *standalone* fix, but it is available.** I tested forcing each row in the 49..55 sliver for the real 193-cell feed:

  ```
  force lane 49 -> column-conflict
  force lane 50 -> z
  force lane 51 -> z
  force lane 52 -> z
  force lane 53 -> z
  force lane 54 -> z
  force lane 55 -> column-conflict
  force lane 41..47 -> column-conflict (all)
  ```

  So a lane row **does** exist in the gap — but only when the *slot order is already correct*. The Z is not blocked by an occupied gap; it is blocked by the parent being east of its target column. Fixing the lane alone changes nothing (with `strictLane:false`, `planChannel` already picks row 50 and still fails on `cell-occupied` at the far end). Option (c) treats a symptom.
- **(d) nothing better found.** The one genuinely different idea — reorder `mix.parents` to match west→east — is *part* of (a'), not a substitute, because it cannot fix the stacker (§0.4).

### What (a') changes, precisely

1. **`planMinerColumns` → becomes order-aware.** Today it is driven by `levels[0]` iteration order (place.mjs:1209), which is `layerAndOrder`'s barycenter order — `---g----, -b------, -g------, n0, n6` — while the mixer's slot order is `[blue, green]`. The *layout* order and the *slot* order disagree. Add a constraint pass that, for each node with ≥2 `bottom` inputs, requires `parent[i].x < parent[i+1].x`. Because the mixer is provably commutative (`recon/upstream-full/src/js/game/colors.js:58-73` — the table is built as `bitfieldToColor[i | j]`, symmetric; and `recon/upstream-full/src/js/game/systems/item_processor.js:489-506` treats both slots identically), reordering `mix.parents` and `template.inputs` **in lockstep** is semantically safe. It is *not* safe for `stack`, where `process_STACKER` at `item_processor.js:461-463` reads `items.get(0)` as lower and `items.get(1)` as upper — so for the stacker the fix must move *rows*, not swap parents.
2. **`assignRows` gains `opts.rowY` (nodeId → y)**, applied the same way `minerX` already is at `place.mjs:639`: an override that supersedes the level default at `place.mjs:613`, before the three placement passes run. `occupied`/`clash` already key on `n.row` (`place.mjs:595-608`), so the passes work unchanged. `claim`/`unclaim`/`clash` need no edits.
3. **A new row planner** assigns `n5.y = baseY - 2*rowGap`, `n9.y = baseY - 3*rowGap` (satisfying §0.4's "lower-slot parent on the higher row"), and reports the separation through `rows[]`.
4. **`rows[]` may carry two entries with the same `level`.** Contract check: `types.mjs:588-592` requires only `level`/`y`/`nodeIds` and has **no uniqueness constraint on `level`** (the `dup-row` test at `types.mjs:1169` is about `lanes[]`, a different array). No schema change is required, though emitting `{level, y, nodeIds}` per distinct y-*group* is cleaner.

**Risk of (a'):** the `①g 行号序列一致` and `miner y > mixer y > painter y` assertions in `research/ai-plan/placer/test.mjs:604-611` pin the per-level row ordering. They read `bad.rows.map(r => r.level)`, so if a level emits two rows the sequence changes length. See §3.

---

## 2. The concrete B1 question, answered

**Is the mixer's feed routable if miners are on separate rows?** Not by virtue of being on separate rows. But yes, if **slot order matches west→east order**, and that works at *any* distance including 193 cells.

The verified calls (`planChannel(first, d1, last, inDir, {occupied, lanePool})`, `occupied` = real footprints of all three machines, `lanePool` shared and respecting reuse):

**REFUTED — the prototype's geometry:**

```
blue(387,-192)  green(387,-196)  mix(387,-204)
  blue->mix[0]    first=[387,-193] last=[387,-203] d1=top d2=top  => FAIL cell-occupied @[387,-196]
  green->mix[1]   first=[388,-197] last=[388,-203] d1=top d2=top  => ok z/2 lane=-202
```

Green must move to `x=388` (its ore is a 13-column-wide patch at `385..394 × -207..-196`, so `(388,-196)` is green — verified via `tileResource(43391,388,-196) === "green"`). With `green(388,-196)`:

```
blue(387,-192)  green(388,-196)  mix(387,-204)
  blue->mix[0]    first=[387,-193] last=[387,-203]  => ok straight/0
  green->mix[1]   first=[388,-197] last=[388,-203]  => ok straight/0
```

**Both straight, zero corners.** This is the clean case: the two parents are exactly one column apart and both feed straight down.

**But that blue/green pair cannot host the whole factory.** It is the only adjacent-column blue/green pair in the ±400 region near Su, and there is **no `SuSuSuSu` ore within 150 cells** of it (`Su within150 = 0` for all four candidate pairs). So this geometry is real but does not close the DAG.

**The geometry that *does* work at the real distances** — slot order west→east, mix above the west parent:

```
green(-410,56) [slot0]   blue(-217,56) [slot1]   mix(-410,48)
  slot0: first=[-410,55] last=[-410,49]           => ok straight/0
  slot1: first=[-217,55] last=[-409,49]           => ok z/2 lane=50
     cells: -217,55 ... -217,50, then -218,50 ... -409,50, then -409,49
```

193 cells of horizontal run on lane row 50, inside the 7-row sliver between level 0 (y=56) and level 1 (y=48), and it routes. The lane row is genuinely free — the sliver has rows 49..55 and level-0 machines occupy only y=56.

**Control (the current layout's order), same positions:**

```
blue(-217,56) [slot0]   green(-410,56) [slot1]   mix(-217,48)
  slot0: straight/0
  slot1: FAIL cell-occupied @[-217,50]      <- blocked by slot0's own belt
```

So: **the relative geometry that works is "slot-0 parent strictly west of slot-1 parent, and the mixer anchored above either one"**. Your prototype's `blue(387,-192) green(387,-196) mix(387,-204)` is refuted (same column → blue's stem crosses the green miner); the corrected version is `blue(387,-192) green(388,-196) mix(387,-204)`.

---

## 3. Blast radius

### Callers of `assignRows`

| Site | Change |
|---|---|
| `place.mjs:1216` — the only production call | Signature gains `rowY`; call site adds the planner output. Magnitude ~5 lines. |
| `research/ai-plan/tmp/place-*.mjs` (6 stale snapshots) | Not imported by any test; snapshots of older `place.mjs`. No action, but they must **not** be treated as ground truth. |

`assignRows` is exported but **not re-exported** through `compile.mjs`, and no test file imports it directly (only the comments at `placer/test.mjs:157` mention it). Confirmed by grep over `src/` and `research/ai-plan/*/`.

### Callers of `planMinerColumns`

| Site | Change |
|---|---|
| `place.mjs:1209-1214` | Gains the order constraint; call shape unchanged. |
| `placer/test.mjs:989` (exported check) | Unchanged. |
| `placer/test.mjs:998` — `⑥-a` | **Will change.** Asserts `xs[0] < xs[1] < xs[2]` for input order `blue,red,Cu`. The new constraint is about *slot* order, and for CpCpCpCp slot order coincides with layout order, so this stays green — but it must be re-verified, not assumed. |
| `placer/test.mjs:1005` — `⑥-a` same-row | **Will break if B2 is implemented for miners.** Asserts `new Set(ys).size === 1`. Since §0.3 shows miners do *not* need multiple rows, **keep miners on one row** and this stays green. This is the strongest argument for not touching level 0. |
| `placer/test.mjs:1015` — `⑥-b` | Unchanged (same-color compaction). |
| `placer/test.mjs:1031` — `⑥-c` | Unchanged (reversed order still order-preserving). |
| `placer/test.mjs:1042` — `⑥-d` | Unchanged (null on impossible resource). |

### Tests that pin row behaviour and *will* change

1. **`placer/test.mjs:604`** — `eq(bad.rows.map(r => r.level), good.rows.map(r => r.level), "①g 行号序列一致")`. If painters split into two rows this array becomes `[0,1,2,2,3,4]` vs `[0,1,2,3,4]` in one of the two paths. **Will go red.** Needs the assertion restated as "same *set* of levels, same per-node y for single-row levels".
2. **`placer/test.mjs:608-610`** — `yOf("n0") > yOf("-p------") > yOf("n4")"`. With painters split, `n4` moves up two gaps. `>` still holds, so this likely survives — verify.
3. **`placer/test.mjs:649-663`** — `rowGap:3` must produce conflicts, `rowGap:8` must produce zero. This uses a 2-input stacker with parents at depth 1, so the stacker row rule now *also* applies. `rowGap:8` must still be clean or the fix regresses its own control.
4. **`harness/test.mjs:238-242`** — **`C6 CgScScCg 仍失败（B-3 未修）` asserts `p.ok === false`.** This test *must be inverted* as part of the change; it is the single blocking assertion for the goal. Also `harness/test.mjs:239-241` pins `reason ∈ {crossing-needs-tunnel, column-conflict-unresolved}`.
5. **`harness/test.mjs:606`** — the summary printf still lists `CpCpCpCp` as blocked. **Stale text, not an assertion** — I verified `CpCpCpCp` compiles (exit 0). Fix the message while touching the file; it is actively misleading.
6. **`harness/test.mjs:54`** — `PASSING` list. Adding `CgScScCg` there is the acceptance change.

### Tests that must *not* change (golden byte-equality)

- `placer/test.mjs:78-82` `GOLD.G1/G2/G3` compared at `:95`, `:109`, `:137` and again at `:212` (`T4 无 hub`). These run **without seed** (`noHub`, `place.mjs:1204-1215` — `minerX` stays `null` when `seedEarly === null`), so a `rowY` that is only computed on the seed path leaves them byte-identical. **This is the key design constraint: gate `rowY` behind `seedEarly !== null` exactly as `minerX` is.**
- `placer/test.mjs:196` — `T2 grid 逐字节等价` (world translation invariance).
- `placer/test.mjs:426` — `F4 无 seed 的 hub 布局确定`.
- `placer/test.mjs:603` — `①g 矛盾 depth 与拓扑 depth 产出的网格逐字节相同`.
- `router/test.mjs`, `validator/test.mjs`, `emitter/run-all.mjs` — consume `LayoutReport`, never call `assignRows`. A `rows[]` with a duplicated `level` passes `types.mjs:588-592` (no uniqueness gate). Should be unaffected; run them.

**Baseline to hold:** `placer` 235 pass / 0 fail; `harness` 358 pass / 0 fail (both measured).

---

## 4. Work breakdown — 4 parallel work packages

The packages are file-disjoint except WP3, which depends on WP1+WP2 landing.

### WP1 — Mixer slot ordering (`planMinerColumns` + `mix.parents` normalization)

- **Owns:** `src/ai/compiler/place.mjs` (functions `planMinerColumns` at :506, `buildDag` parent-order handling around :226), `src/ai/compiler/compile.mjs` (`mapOps` at :347 / `rebuildDag` at :455 for the lockstep reorder).
- **Does:** for each node whose template has ≥2 `bottom` inputs *and* whose slots are semantically interchangeable (`mix` only — `stack`'s slots are ordered), sort `parents` and `template.inputs` by parent x so slot order matches west→east. Because `mix` is commutative (§1, `colors.js:58-73`), this is a no-op semantically. Guard it: **do not touch `stack`**.
- **Acceptance:** `node research/ai-plan/placer/test.mjs` → `235 passed / 0 failed`, **plus** a new probe under `research/ai-plan/tmp/` asserting that for seed 43391 the mixer's two channels both `planChannel` on the real coordinates. Expected: `2/2` channels ok, lane rows 50 and 51 distinct, slot-1 run = 193 cells.
- **Falsification control:** delete the `mix`-only guard so the sort also applies to `stack`. `CgScScCg` must then fail with a *different* reason (or the stacker geometry must visibly break) — if it still passes, the guard was not load-bearing and the test is not testing it.

### WP2 — Painter/lower-slot row rule (`assignRows` per-node `rowY`)

- **Owns:** `src/ai/compiler/place.mjs` (`assignRows` at :590, the `levelAndOrder`→`assignRows` call at :1216).
- **Does:** add `opts.rowY` (nodeId → y), applied at :613 as an override, mirroring `minerX` at :639. Add a planner that, for every multi-`bottom`-input node, places `slot[0]`'s parent one row *higher* (smaller y) than `slot[1]`'s parent — the verified rule from §0.4. Emit one `rows[]` entry per distinct y-group. **Gate on `seedEarly !== null`** so goldens are byte-identical.
- **Acceptance:** `node research/ai-plan/placer/test.mjs` → `235/0`, and a probe asserting the stacker's two channels route on synthetic coordinates: `p0(0,40) p1(0,48) st(20,32)` → both `elbow/1`; and the control `p0(0,48) p1(0,40) st(20,32)` → `p1 FAIL`.
- **Falsification control:** invert the row rule (slot-0 parent *below* slot-1 parent). The stacker control must go red. If it stays green, the planner is not actually moving anything.

### WP3 — Harness acceptance flip + stale claims

- **Owns:** `research/ai-plan/harness/test.mjs` (:54 `PASSING`, :236-242 `C6`, :606 summary).
- **Does:** move `CgScScCg` from the "known-blocked" block into `PASSING`; delete/invert `C6`'s `p.ok === false` assertion into `ok === true` with `validation.pass`, `drift.length === 0`, `roundtrip.ok`, and an entity count; correct the stale `CpCpCpCp` text at :606.
- **Acceptance:** `node research/ai-plan/harness/test.mjs` → all green; summary line no longer lists `CpCpCpCp` or `CgScScCg` as blocked; the eight previously-PASSING goals still pass.
- **Falsification control:** re-add `CgScScCg` to the blocked list while the compiler *does* compile it — the suite must go red on the inverted assertion. If it stays green, the assertion is not wired.

### WP4 — Blast-radius lock (tests that pin `rows[]`)

- **Owns:** `research/ai-plan/placer/test.mjs` (:604, :608-610), `research/ai-plan/router/test.mjs`, `research/ai-plan/validator/test.mjs` (read-only verification).
- **Does:** restate `①g 行号序列一致` in terms of per-node y (not the level array), keeping the "correction is total, byte-identical grid" property at :603. Verify `T2`/`T4`/`F4`/`①g` goldens are untouched.
- **Acceptance:** `node research/ai-plan/placer/test.mjs` → `235/0` with the restated assertion; `node research/ai-plan/router/test.mjs` and `node research/ai-plan/validator/test.mjs` unchanged counts; the four `GOLD` byte-equality assertions still green.
- **Falsification control:** remove the `seedEarly !== null` gate on `rowY` — `GOLD.G1` must go red immediately (no-seed path gets perturbed).

**Sequencing:** WP1 and WP2 are independent and can run in parallel (disjoint functions, both in `place.mjs` but different regions — coordinate the merge). WP4 depends on WP2. WP3 depends on WP1+WP2 both landing, and is the final gate.

---

## 5. Risks, ranked, each with a cheap early check

**R1 — The layout still does not close even with both fixes (highest).**
My own 11/11 search over a 4×10×3×9×3×8×2 window found **no** fully routable arrangement, and the best hand arrangement I reached was **9/11** (`n1>n5 column-conflict`, `---g---->n9 cell-occupied`). The `n1>n5` failure is a *third* independent issue: painter `shape←left` requires the cutter to be at column `< paint.x-1`, and `r5`'s cutter sits at `-122` while its painter is at `-121` — a 1-column lead. This is a `desiredX` problem (`place.mjs:769-778`, the `s.dir === "left"` branch returns `beltCol + 1 - s.cx`, which lands the painter one column east of the cutter's belt when the cutter is 2 wide).
**Cheap check:** before writing production code, run a probe that (a) applies WP1's slot sort to the real DAG, (b) applies WP2's row rule, and (c) calls `planChannel` on all 11 channels in `place()`'s iteration order with real occupancy. **If that probe does not reach 11/11, the plan is incomplete** — add a WP0 for the `shape←left` lead distance before committing.

**R2 — Moving the failure later instead of removing it (your explicit question).**
Yes, this is a real risk: WP1 and WP2 could let `placeStage` return `ok:true` while `routeAll`/`validate` still rejects. Cheap test: **the compiler's own stage trace**. `compilePlan` already reports per-stage status; assert in a probe that a layout which routes at `placeStage` also has `stages.routeStage.ok === true` **and** `stages.validateStage.ok === true` **and** `validation.beltSim.drift.length === 0`. A layout that routes geometrically but fails V3 fixed-point is exactly the "moved the failure later" signature, and `beltSim` catches it. Run this on all seven goals, not just `CgScScCg`.

**R3 — Goldens drift.**
`GOLD.G1/G2/G3` are byte-compared at four sites. Mitigation is the `seedEarly !== null` gate, which is verifiable in one command (`placer/test.mjs`, expect `235/0` with the goldens specifically green). Cheap check: run the placer suite after *each* of WP1 and WP2 separately, not just at the end.

**R4 — Reordering `mix.parents` silently corrupts the stacker.**
`process_STACKER` at `item_processor.js:461-463` is order-sensitive; `process_MIXER` at `:489-506` is not. A shared helper that sorts all multi-input nodes would swap stacker layers and produce `ScScCgCg` vs `CgCgScSc` — a *wrong blueprint that still validates*. Cheap check: a unit assertion that `stack`'s `template.inputs[].role` sequence is unchanged, plus goal `CuCuSuSu:RuRuCuCu` (the M3 verified case) still compiling to the same shape.

**R5 — `rows[]` contract break.**
Two entries with the same `level`. `types.mjs:588-592` has no uniqueness gate, so this passes `assertLayoutReport`, but the `①g` test compares the array. Cheap check: `node research/ai-plan/contract/test.mjs` plus the placer suite.

**R6 — Determinism.**
New ordering must not use `localeCompare` or RNG. The existing code uses `cmpNum`/`cmpStr` (`place.mjs:148-152`). Cheap check: run `CgScScCg` twice in one process and byte-compare `layout.grid` (the pattern already used at `placer/test.mjs:527`).

---

## 6. Regression ledger (measured baseline — hold these)

| Goal | Now | Target |
|---|---|---|
| `CuCuCuCu` | ok, 8 belt, 2 corners | unchanged |
| `----CuCu` | ok, 17 belt, 3 corners | unchanged |
| `RuRu----` | ok, 26 belt, 2 corners | unchanged |
| `CrCrCrCr` | ok, 114 belt, 7 corners | unchanged |
| `RbRb----` | ok, 257 belt, 6 corners | unchanged |
| `CpCpCpCp` | ok, 378 belt, 8 corners | unchanged |
| `CgScScCg` | **FAIL** `column-conflict-unresolved` | `ok:true`, validator pass, drift 0 |

Command: `node src/ai/compiler/cli.mjs --goal <G> --seed 43391 --hub -2,-2 --range 400 --no-handoff`.

---

### Critical Files for Implementation

- `D:\Projects\rea\Project work\shapez\src\ai\compiler\place.mjs` — `planMinerColumns` (:506), `assignRows` (:590), `desiredX` (:738), `anchorFromParent` (:769), `planChannel` (:807), `pickLane` (:905), the `place()` call site (:1216)
- `D:\Projects\rea\Project work\shapez\src\ai\compiler\compile.mjs` — `routeStage` gap-retry loop (:790), `placeStage` (:732)
- `D:\Projects\rea\Project work\shapez\research\ai-plan\placer\test.mjs` — goldens (:78), `planMinerColumns` pins (:983-1050), `rows[]` pins (:604-610)
- `D:\Projects\rea\Project work\shapez\research\ai-plan\harness\test.mjs` — `C6` blocking assertion (:236-242), `PASSING` (:54)
- `D:\Projects\rea\Project work\shapez\src\ai\op-templates.mjs` — `mix`/`stack`/`paint` slot tables (:316-370)