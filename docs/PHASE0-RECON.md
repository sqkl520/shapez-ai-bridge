# shapez.io integration — phase 0 findings

> How this project determined what shapez.io 1.5.6 lets an external tool do.
> Everything below was established by **using the game's own public extension
> surface** — the built-in mod loader, the module exports it exposes, and the
> behaviour observable from a running game — not by redistributing or deriving
> from game code.
>
> This document records **design constraints**, which is what a contributor
> needs. It deliberately does not record how the game is packaged internally.

---

## 1. What the game offers

shapez.io ships a **built-in mod loader**. Mods are single JavaScript files
dropped into the user's mods directory; the game reads and evaluates them, and
the mod's metadata lives inside the file rather than in a manifest. This is a
first-class extension path — no patching of game files is involved, and
installing or removing a mod is a file copy either way.

The mod API gives an extension three things:

| Surface | What it provides |
| --- | --- |
| Lifecycle signals | A set of named game events a mod can subscribe to (boot, game start, save/load, state transitions, HUD hooks) |
| `ModInterface` | Registration calls — new buildings, sprites, translations, game systems, keybindings, HUD elements — plus method interception (`replaceMethod` / `runBeforeMethod` / `runAfterMethod`) for wrapping existing behaviour without editing game files |
| Game root object | The live game instance: map, logic, entity manager, hub state, time, camera |

That third one is what makes this project possible: an AI needs to *read* the
world and *write* to it, and both are reachable from a mod.

## 2. Why the mod cannot host the bridge

The game's renderer runs with Node integration disabled, context isolation on,
and sandboxing enabled. A mod therefore has **no filesystem and no socket API** —
it cannot open a listening port or write a file.

But the renderer is a full Chromium environment, so the browser's native
`WebSocket` client is always available.

→ **The bridge has to be an external process that the mod dials out to.** This
is not a preference; the sandbox forces it. It is also why the bridge binds to
`127.0.0.1` and the mod is the client, not the server.

A related constraint: the game clears its session storage on every launch, so a
mod cannot persist anything in `localStorage`. Anything that must survive a
restart goes to a file.

## 3. World model

An entity is a numeric `uid` plus a dictionary of components. One component
(`StaticMapEntity`) carries position, rotation and the building code; the rest
describe behaviour (miner, ejector, processor, belt, wiring…).

Building **types are numeric codes**, not strings — a code maps to
(building, variant, rotation-variant). Codes and component names are stable for
a given game version, which is why this project pins the version.

Shapes are short strings: four quadrants, two characters each (a shape letter
and a colour letter). `CuCuCuCu` is four circular-uncoloured quadrants;
`RuRu----` is a two-quadrant rectangle. Multi-layer shapes join layers with `:`.

Coordinates are integer tile positions; rotation is one of 0/90/180/270.

## 4. World mutation

The game's logic object exposes the operations an editor needs, and they are
ordinary instance methods rather than internals:

- place a building, with a validity check and a cost check
- delete a building, with a corresponding can-delete check
- bulk operations, which batch a set of changes and settle them once — the game
  uses this itself for mass delete
- blueprints: capture a region into an in-memory object and place it back

Two properties matter for an AI:

1. **Blueprints carry a material cost** in the default mode, deducted from what
   the hub holds. An agent that ignores cost will keep hitting "the game said
   no", so cost and current stock have to be in the observation.
2. **1.5.6 has no blueprint string format.** Blueprints are in-memory objects
   and the clipboard path exists but is never invoked. Serialising a blueprint
   to a portable string is something this project defines itself — see
   [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the `SZBP1` format.

## 5. Deterministic fast-forward

The game already contains a headless simulation loop: its puzzle validator steps
the simulation forward synchronously for a fixed number of ticks with rendering
skipped.

The tick mechanism makes this deterministic:

- each tick advances logic by a **fixed** delta, not by wall-clock frame time
- the tick body is entity update plus system update — no rendering, no camera,
  no serialisation
- puzzle mode runs at a fixed 300 Hz with a determinism flag set

→ `step(ticks)` is implementable by mirroring that loop. Two caveats, both
observable from the running game: the simulation pauses if a dialog is open, and
changing speed mid-step aborts it.

## 6. Savegames

The on-disk savegame format is a compressed, dictionary-encoded JSON document
with a checksum header. It is fully decodable **without running the game**,
which is what lets this project offer offline analysis and blueprint tooling.

Two facts that shaped the design:

- The savegame includes a **mod-owned extension slot** — the official place for
  a mod to persist its own data, paired with the serialise/deserialise signals.
- All of the game's persisted files go through the same serialiser, so one
  implementation covers settings, savegames and mod settings.

The savegame carries a schema version. This project pins the game version rather
than attempting to handle several, because the schema and the building codes
change between releases.

---

## 7. Design conclusions

| Decision | Forced by |
| --- | --- |
| Mod is a single file, installed by copy | The game's own loader has no manifest |
| Bridge is an external process, mod is the WS client | Renderer sandbox: no sockets inside the game |
| Bridge binds `127.0.0.1` only | There is no reason for it to be reachable, and every reason not to be |
| Version pinned with a hard failure on mismatch | Building codes and savegame schema change between releases |
| Blueprint strings are this project's own format | The game has none in 1.5.6 |
| Cost and hub stock are part of the observation | Blueprint placement is not free in the default mode |
| `step(ticks)` mirrors the game's own validation loop | Reimplementing the tick would not be faithful |

## 8. Known risks

1. **No native blueprint strings** — the format here is ours, so it is only
   exchangeable between matching game versions.
2. **Blueprint placement costs materials** — an agent must be given the cost and
   the current stock, or it will keep failing against the game's refusal.
3. **Session storage is cleared each launch** — cross-session state must go to a
   file.
4. **A future release may change the mod loader** — hence the version gate and
   the separation between the protocol layer and the mod layer.
5. **Installing a mod disables Steam achievements and the DLC for that save.**
   This is the game's documented behaviour. See the note in the README.
