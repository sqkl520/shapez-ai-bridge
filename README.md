# shapez-ai-bridge

**English** | [简体中文](README.zh-CN.md)

**An AI-operable interface for [shapez.io](https://shapez.io): a single-file official mod + a zero-dependency local bridge + an MCP server.** Observe the factory, place and delete buildings, fast-forward deterministically, move blueprints and savegame snapshots, and let any script or MCP client drive it — all locally, over `127.0.0.1`.

```
┌─ shapez.io (Electron) ───────────────────┐
│  shapez-ai-bridge.js                    │   the mod is a WebSocket *client*
│  (official single-file mod, no Node)  ──┼──▶ ws://127.0.0.1:7777/mod
└─────────────────────────────────────────┘
              │
┌─────────────┴────────────────────────────┐
│  bridge.mjs  (Node, zero dependencies)   │
│  ├─ WS   /mod     ← game mod             │
│  ├─ WS   /client  ← tools / event stream │
│  └─ HTTP /health  /status  /rpc  ← curl  │
└─────────────┬────────────────────────────┘
              │ HTTP or stdio
┌─────────────┴──────────┬─────────────────┐
│  mcp/server.mjs        │  agent/play.mjs │
│  8 MCP tools (Claude…) │  reference agent│
└────────────────────────┴─────────────────┘
```

Why a separate bridge process? shapez.io's renderer is sandboxed (`nodeIntegration:false`, `sandbox:true`), so an in-game mod has no file or socket APIs — but the browser's native `WebSocket` client is always available. The mod dials out to a small Node process on your machine; that process owns the HTTP API, the MCP server and the snapshot files.

## 30-second quick start

Prerequisites: **Node.js ≥ 20**, **shapez.io desktop 1.5.6** (Steam build), and a checkout of this repository.

**1. Install the mod (one command).**

Windows (PowerShell):
```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```
macOS / Linux:
```bash
bash install.sh
```

**2. Start the bridge (one command).**

```bash
node src/bridge/bridge.mjs
```

**3. Start shapez.io, load a savegame, then run:**

```bash
node scripts/smoke_test.mjs
```

Expected: `SMOKE TEST PASSED (5/5)`. (The test briefly places and deletes one belt near the hub to prove writes work — your world is left unchanged.)

## What it can do

Curl examples below assume bash. On Windows PowerShell `curl` is an alias for `Invoke-WebRequest` — use `curl.exe` instead, with double quotes around the JSON (escaping the inner quotes), or use the included scripts.

- **Observe** — ask the game what's in the world as JSON: entities with stable uids, hub stock, current goal, camera, stats.
  ```bash
  curl -s http://127.0.0.1:7777/rpc -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"obs","params":{"max_entities":5,"include_hub":true}}'
  ```
- **Act** — place or delete buildings, lay paths, set game speed, move the camera.
  ```bash
  curl -s http://127.0.0.1:7777/rpc -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"act","params":{"op":"place","building":"belt","x":5,"y":5}}'
  ```
- **Fast-forward** — advance N game ticks synchronously and deterministically (the same loop the game's own puzzle validator uses), optionally collecting an observation.
  ```bash
  curl -s http://127.0.0.1:7777/rpc -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"act","params":{"op":"step","ticks":600,"collect":true}}'
  ```
- **Blueprints** — export any region as a portable `SZBP1.*` string and paste it back anywhere (material cost per game rules by default, free with `charge:false`).
  ```bash
  curl -s http://127.0.0.1:7777/rpc -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"act","params":{"op":"export_blueprint","region":[0,0,10,10]}}'
  ```
- **Save snapshots** — save the game and keep a named copy of the save file on the bridge side, then restore it any time.
  ```bash
  curl -s http://127.0.0.1:7777/rpc -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"snapshot_save","params":{"name":"before-big-build"}}'
  ```
- **MCP** — all of the above exposed as 8 MCP tools (`shapez_status`, `shapez_observe`, `shapez_action`, `shapez_batch`, `shapez_screenshot`, `shapez_blueprint`, `shapez_save`, `shapez_load`) for Claude and other MCP clients.
  ```bash
  echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node src/mcp/server.mjs
  ```

The full protocol contract (methods, error codes, observation schema) lives in [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Compatibility

Generated from `compat.json`:

| Game version | Mod version | Protocol | Status |
|---|---|---|---|
| 1.5.6 (Steam build `ee2279d5`, Electron 16.2.8) | 0.1.x | 1 | Supported — development baseline |
| any other | any | any | **Hard fail** (error `1002`) — no downgrade, no override |

The mod declares `minimumGameVersion: 1.5.6`, and the bridge re-checks the game version reported at handshake against this table; on mismatch nothing is routed.

## Uninstall

Delete `shapez-ai-bridge.js` from the mods folder (that single file is the entire mod), or run `install.ps1 -Uninstall` / `bash install.sh --uninstall`.

## Known limitations

An honest list, taken from the phase-0 recon ([`PHASE0-RECON.md`](PHASE0-RECON.md)):

- **Steam achievements are disabled while ANY mod is installed.** The game only enables its Steam layer when zero mods are loaded (`if (mods.length === 0) steam.listen()`). This is official shapez.io behavior, not a bug of this project.
- **The game clears localStorage on every launch** (`clearCache()` + `clearStorageData()` in the main process), so the mod has no cross-session local storage. Anything persistent must go through mod settings files or the savegame.
- **shapez.io 1.5.6 has no native blueprint string format.** This project defines its own `SZBP1.*` format (built on the game's own LZ-string compression), so blueprints are only exchangeable between the same game version — the embedded `gv` field is checked on paste, and a mismatch fails with error `2006`.
- **Pasting a blueprint charges "blueprint shape" material** (in regular mode, `CbCbCbRb:CwCwCwCw`) per the game's own cost formula. Use `charge:false` to paste for free.
- **`step` / `await` fast-forward runs synchronously on the render thread** — large tick counts briefly freeze the screen. A single step is capped at 20,000 ticks.
- **Observations of big factories must be clipped** with `region` and/or `max_entities`. Over-limit observations report `truncated: true` and always include full `stats` — never a silent cut.
- **Desktop only** (Windows / macOS / Linux Electron builds). The mobile and browser versions of shapez.io do not support mods and are not applicable.

## Troubleshooting

**"I can't connect."**
1. Is the bridge running? `curl -s http://127.0.0.1:7777/health` should return `{"ok":true,...}`. "Connection refused" → start `node src/bridge/bridge.mjs`.
2. Is the game running? `health` reports `mod_connected:true` only once the game is open *with the mod loaded*. `mod_connected:false` means the game (or the mod) isn't there yet.
3. Is the mod in the right place? The game reads `%APPDATA%\shapez.io\mods` (Windows), `~/Library/Preferences/shapez.io/mods` (macOS), `~/.local/share/shapez.io/mods` (Linux). It must be a **single `.js` file directly in that folder** (not a subfolder). On startup the game logs `Loaded N mods` — N must be ≥ 1. The install scripts pick the right folder automatically; `-ModsDir` / `--mods-dir` override it.
4. Security software: a firewall/proxy that blocks localhost traffic can break both the bridge's listener and the mod's WebSocket. Allow `node` on `127.0.0.1:7777`; if a system proxy is forced for all traffic, exclude `127.0.0.1`.

**"Version mismatch (error 1002)."** The bridge refused the handshake because the game version isn't in the compatibility table. This is a hard fail by design: building codes and internal APIs are version-specific. Fix by upgrading to a mod/bridge version that lists your game build in `compat.json` (or switch the game back to a supported build via Steam betas). There is no override flag.

**"Observation is empty / errors."**
- Error `1003 not_in_game` → you're in the main menu or still loading. Load a savegame (or start a new one); `status` will say `in_game:true`.
- Region selection: `region:[x0,y0,x1,y1]` is an inclusive bounding box — everything outside it is filtered out. Omit `region` to observe the bounding box of all entities.
- Layer: entities live on `regular` or `wires`; observe the right one (default `regular`).

**"My MCP client doesn't list the tools."**
- The path in the client config must be **absolute** and point at `src/mcp/server.mjs`. In JSON on Windows use forward slashes (`C:/...`) or escaped backslashes (`C:\\...`).
- Restart the MCP client after editing its config.
- Test the server standalone: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node src/mcp/server.mjs` — you should get a JSON line listing 8 tools.
- The server logs to stderr, not stdout; check your client's MCP logs for its stderr output.

## MCP configuration

`mcp-config.example.json`:

```json
{
  "mcpServers": {
    "shapez": {
      "command": "node",
      "args": [
        "C:/path/to/shapez-ai-bridge/src/mcp/server.mjs"
      ],
      "env": {
        "SHAPEZ_BRIDGE_URL": "http://127.0.0.1:7777"
      }
    }
  }
}
```

Replace the path with the absolute path of your checkout. **Windows path writing in JSON:** either forward slashes (`C:/Users/you/shapez-ai-bridge/src/mcp/server.mjs`) or escaped backslashes (`C:\\Users\\you\\...`); single backslashes are invalid JSON. `command` must resolve to a `node` ≥ 20. If your bridge runs with a token (`bridge.config.json`), add `"SHAPEZ_BRIDGE_TOKEN": "<token>"` to `env`.

## License and provenance

- This project's code is **MIT** — see [`LICENSE`](LICENSE).
- Vendored [lz-string](https://github.com/pieroxy/lz-string) 1.4.5 (`src/shared/lz-string.cjs`): © 2013 Pieroxy, dual-licensed **MIT / WTFPL** — see [`src/shared/lz-string.LICENSE.txt`](src/shared/lz-string.LICENSE.txt). It compresses blueprints and mirrors the game's own savegame compression.
- This repository contains **no shapez.io game code**. All integration goes through the game's official mod API (single-file mods with `METADATA`/`Mod`, `ModInterface`, the `window.shapez` module exports). shapez.io is © [tobspr Games](https://shapez.io).

## Development

Directory layout:

| Path | What it is |
|---|---|
| `src/mod/shapez-ai-bridge.js` | In-game mod — single file, loaded by the official mod loader |
| `src/bridge/bridge.mjs` | Zero-dependency Node bridge: WS `/mod` + `/client`, HTTP `/health` `/status` `/rpc`, snapshot file management |
| `src/mcp/server.mjs` | MCP stdio server (8 tools), forwards to the bridge's HTTP API |
| `src/agent/play.mjs` | Reference agent driving the bridge over HTTP |
| `src/shared/` | Vendored lz-string + the `SZBP1` blueprint codec |
| `scripts/smoke_test.mjs` | Zero-dependency end-to-end smoke test |
| `docs/PROTOCOL.md` | The frozen protocol contract — the single source of truth |
| `compat.json` | Machine-readable compatibility matrix |
| `test/` | Layer selftests (mod RPC in a Node sandbox, lz-string interop, blueprint round-trips) |
| `recon/` | Phase-0 reverse-engineering artifacts (local research only, excluded from distribution) |

Running the layers and their selftests:

```bash
npm run selftest:bridge   # bridge layer selftest
npm run selftest:mcp      # MCP layer selftest
npm run smoke             # end-to-end smoke test (needs game + bridge running)
npm run agent             # reference agent
node test/mod_rpc_selftest.mjs    # mod RPC logic, exercised in a Node sandbox
node test/lzstring_interop.mjs    # lz-string byte-level interop with the game's variant
node test/blueprint_selftest.mjs  # SZBP1 codec round-trips
```

**Smoke test details:** fully non-interactive by default; exit code `0` = pass, `1` = bridge not running, `2` = game not in a world, `3` = other check failed. `SHAPEZ_SMOKE_AUTOPLAY=1` additionally suppresses the notice about the temporary belt it places. Override the bridge address with `--url` / `SHAPEZ_BRIDGE_URL`; authenticate with `--token` / `SHAPEZ_BRIDGE_TOKEN`.
