# P7 live — execution log

Exclusive holder of the game process + bridge `127.0.0.1:7777`.
Every experiment: one status line here + a pointer to its `results/*.json`.
`pass` in results is decided by script code only — this document never overrides it.

## Ground rules in force
- destructive experiments run only in a NEW game (`new_game regularMode`); level-11 save never pasted into
- restore to level-11 after each experiment, assert world baseline uid-by-uid (2805/extra0/missing0)
- landing box obs-verified empty before any paste (C1: replaceable belts destroyed silently)
- cleanup: `bulk_delete dry_run:true` -> print manifest -> delete -> baseline
- `>150 cells from origin` applies to the detached forensic builds (F1/F2). The T1/T2/T3
  delivery lines must touch the hub, and a fresh save's hub sits at the origin — so for those
  the safety property is "isolated new save + snapshot + obs-empty box", not distance.

## Status

| id | experiment | state | result |
|----|------------|-------|--------|
| kit | `kit.mjs` + `routes.mjs` | complete, live-smoke-tested | route planner 15/15 seeds, 0 chain defects |
| preflight | `exp-00-preflight.mjs` | ✅ PASS — level-11 world audited | `results/preflight.json` |
| T1 | `exp-paste-l1.mjs` | BLOCKED — see "world wedge" below | `results/paste-l1.json` (pass:false, fatal=new_game never landed) |
| T2 | `exp-paste-corner.mjs` | not started (waiting on world) | — |
| T3 | `exp-paste-machine.mjs` | not started (waiting on world) | — |
| F1 | `exp-belt-silent-overwrite.mjs` | not started (waiting on world) | — |
| F2 | `exp-orig-flip.mjs` | not started (waiting on world) | — |

## Preflight (passed before any mutation)
- bridge: mod 0.1.0 / game 1.5.6, `allow_write=true`, `allow_step=true` (**not** read-only → package may run)
- level-11 loaded, world audited **uid-by-uid against `snapshots/ai-research-base.bin`**:
  count=2805 want=2805 **extra=0 missing=0 pass=true**, seed=43391, hub origin=(-2,-2)
- offline resource model agreed with live obs on 3 sampled cells (all_match=true)
- `load_save` from the menu took ~2 min (126s) on this machine → kit waits up to 360s

## World wedge (found while running T1) — timeline
- 00:37  T1 issued `snapshot_save p7-paste-l1-home` (ok), then `new_game regularMode`
- new_game returned `internal_id=9ac66b0b…` but `status.in_game` stayed **false** for >6 min
- also created an orphan `ab4ded04…` (level null) from a first attempt that never landed
- 00:47 `load_save ab4ded…` → never landed. 00:53 `load_save` level-11 → **never landed either**
- Since 00:43 every `obs`/`screenshot`/`step` returns `1003 not_in_game`; `status` shows
  `in_game:false` (mod `root` is only set by `MOD_SIGNALS.gameStarted`, bridge:158)
- **No world data was lost.** The on-disk level-11 save was re-decoded offline and is
  **identical to baseline: 2805 uids, extra 0, missing 0** (checked at 00:53; file mtime
  2026-10-23T16:37:00Z = the last legitimate save, before any P7 action). No paste ever ran
  against the level-11 world.
- The wedge is a client-side state transition (game parked outside InGameState). It needs the
  game window to be interacted with, or the game restarted — **not something the RPC surface
  can force**, and I will not kill/restart the user's game process without approval.
- 00:58+ background watcher (`results/watch.log`) polls every 30s; experiments resume the
  moment `in_game=true`.

## Wrap-up line (must be filled)
- [x] level-11 save verified intact offline: count=2805 extra=0 missing=0 (uid-by-uid vs ai-research-base)
- [ ] restored to level-11 after experiments: ___ (blocked by the wedge above)
