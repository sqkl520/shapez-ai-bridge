# MOD-GAPS.md — P7 live findings against mod / bridge / shared (registered, not fixed)

Source of every line: a live experiment's `results/*.json` (pass judged in script code).

## 1. `paste_blueprint` silently destroys replaceable belts and reports nothing  (severity 5 / R3)
- Evidence: `results/belt-silent-overwrite.json` — placed a 5-belt line (uids 10055-10059),
  pasted a 3-cell blueprint overlapping 2 of them. Result: `ok:true`, `applied:3`, `failed:[]`,
  no `warnings` key, response text contains no destroy/replace/overwrite mention — yet the 2 old
  belt uids were gone and replaced by new uids.
- Impact: an off-by-one anchor can wipe a real production line and still return success. This is
  the mechanism behind the historical "6 belts destroyed" incident.
- Missing tool: **`paste dry_run`** (report would-be-destroyed uids + would-be-placed before applying),
  and a **`replaced`/`destroyed` field** on the real paste response listing uids it destroyed.
- Compiler rule (C1): paste only onto an obs-verified-empty rectangle; `applied !== entityCount` ⇒ abort+rollback.

## 2. SZBP1 stride=4 does not store `originalRotation`; post-paste neighbours rewrite explicit-rv belts (severity 4 / R2)
- Evidence: `results/orig-flip.json`, 9-cell matrix (corner configs × perturb mode). Placing ONE belt
  next to an already-pasted corner rewrote that corner's `(r,rv,code)` in **every** `PULL` cell:
  `C00(bottom→right, r0/rv2/code3)`, `C270(right→bottom, r270/rv1/code2)`, `C180(top→left, r180/rv2/code3)`
  all became `rv0/code1` (straight). The `rotation` stayed the same in every flip; only `rv` collapsed to
  straight. The `orig` saved equalled the pasted `rotation` in all three (exactly what `bridge:814` writes),
  so the observable is independent of orig being "wrong": an explicit-rv belt pinned at paste does NOT survive
  a later single-belt neighbour addition. `EJECT` and `NONE` cells stayed unchanged.
- The paste ITSELF is deterministic (T2 `results/paste-corner.json`: a contradicting belt neighbour
  present AT PASTE TIME did not alter the corner — the immutable wrapper held). The gap is **after** paste.
- Impact: the compiler's "explicit rv in the blueprint" guarantee is only valid for a **single whole-block
  paste with zero later additions near any belt**. Incremental construction silently corrupts corners.
- Missing: **stride=5** (store `originalRotation`) in `src/shared/blueprint.mjs`, or an equivalent.
- Compiler discipline (C2): whole-block paste only; never `place` adjacent to a pasted corner; re-paste
  the whole block to change it. `V3` (computeBelt fixed-point including machine neighbours) would additionally
  guarantee the stored rv is a fixed point so even a perturbation leaves it alone.

## 3. `bulk_delete dry_run` over-reports the hub in `would_delete`  (severity 2)
- Evidence: `results/paste-l1.json` / others — `dry_run` items include the hub (by_type `{hub:1,...}`),
  but after the real `bulk_delete` the uid audit shows the hub still present (`missing:0`). The real op
  protects the hub via `performBulkOperation`; the dry-run manifest does not.
- Impact: an agent that trusts the dry_run `count`/items to plan "exactly what will change" is misled about
  the hub (and would be if any other protected entity existed).
- Missing: dry_run should mark hub/protected entities as `would_skip` rather than `would_delete`.

## 4. `place` / `place_path` do not accept an explicit `rotationVariant`  (severity 2)
- Evidence: mod `actionSpecs` (`shapez-ai-bridge.js:876-877`) allow only `building,x,y,r,variant` for
  `place` — no `rv`. A belt placed via `place` gets the game's auto-derived rv (neighbour-order dependent).
  The rv override exists internally (`placeOne`'s `rotationVariantOverride`, `bridge:787`) but only the
  paste path uses it.
- Impact: F2/T2 needed explicit rv; the only way to pin it is through a blueprint paste, not `place`.
  A "place one belt with exact rv" op would make incremental construction debuggable.

## 5. `step`/`await` throw 2002 while an upgrade modal is visible — no `dismiss_overlays` op  (severity 3)
- Not directly hit in P7 (level-1 targets did not pop the upgrade dialog during our step windows, and T1's
  `await hub_delivered_increased` returned `met:true` normally). Recorded here because plan-compiler §6 and
  redteam flag it as the first thing a real L3 run will trip. `await`/`step` have no overlay dismissal.
- Missing: `act{op:"dismiss_overlays"}` or auto-dismiss in stepTicks.

## 6. Game render loop is a hidden single point of failure for world ops  (severity 4, operational)
- Evidence: LIVE-LOG "World wedge". With the game window minimized, `new_game`/`load_save` return ok but
  `status.in_game` stays false and every world call returns 1003 for minutes; restoring the window (ShowWindow
  SW_RESTORE) immediately resumed the transition (main-window CPU 0→2.9s/4s, in_game→true).
- Root cause: shapez pumps the InGameState transition (and `gameStarted` that sets `mod.root`) off
  requestAnimationFrame; a minimized/occluded window stops the frame pump.
- Not a mod *bug* per se, but a bridge robustness gap: `status` could report a `frames_advancing`/stalled signal,
  and world ops could surface "renderer not ticking, un-minimize the window" as the hint. P7 now calls
  `ensureWindowAwake()` before world ops (kit).
