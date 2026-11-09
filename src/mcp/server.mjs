#!/usr/bin/env node
// shapez-ai-bridge MCP stdio server.
//
// Contract: docs/PROTOCOL.md
//   - Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout.
//   - stdout carries protocol messages only (one JSON per line, trailing \n).
//   - All logging goes to stderr.
//   - Zero npm dependencies; node: builtins only.
//
// Bridge HTTP interface (§11.1):
//   GET  /health   -> {"ok":true,"mod_connected":bool,"uptime_s":N}
//   GET  /status   -> status result (text JSON)
//   POST /rpc      -> JSON-RPC 2.0 request in, JSON-RPC 2.0 response out.
//
// The MCP server forwards tool calls to POST /rpc. Tool semantics (§9).

import process from "node:process";
import http from "node:http";
import https from "node:https";

// ---------------------------------------------------------------------------
// Config: --url / SHAPEZ_BRIDGE_URL (default http://127.0.0.1:7777),
//         --token / SHAPEZ_BRIDGE_TOKEN (optional Bearer).
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const out = { url: null, token: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url" && i + 1 < argv.length) {
      out.url = argv[++i];
    } else if (a.startsWith("--url=")) {
      out.url = a.slice("--url=".length);
    } else if (a === "--token" && i + 1 < argv.length) {
      out.token = argv[++i];
    } else if (a.startsWith("--token=")) {
      out.token = a.slice("--token=".length);
    }
  }
  return out;
}

const argv = parseArgv(process.argv.slice(2));
const rawUrl =
  argv.url || process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777";
let BRIDGE_URL;
try {
  BRIDGE_URL = new URL(
    /^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`,
  );
} catch (err) {
  log(`invalid bridge URL ${JSON.stringify(rawUrl)}: ${err.message}`);
  process.exit(1);
}
const BRIDGE_TOKEN = argv.token || process.env.SHAPEZ_BRIDGE_TOKEN || null;
const BRIDGE_KIND = BRIDGE_URL.protocol === "https:" ? https : http;

// Request timeout for bridge HTTP calls (ms). Must be >= the bridge's own
// long_timeout_ms (180_000, bridge.config) or the MCP layer would cut a
// legitimately-running long `await`/`step` short and misreport it as
// "bridge not reachable" — a red-team finding. Keep this strictly above it.
const BRIDGE_TIMEOUT_MS = 200_000;

function log(...args) {
  process.stderr.write(`[shapez-mcp] ${args.join(" ")}\n`);
}

// ---------------------------------------------------------------------------
// Bridge HTTP client.
// ---------------------------------------------------------------------------

/**
 * Perform one HTTP request against the bridge.
 * Resolves {status, body} with body parsed as JSON when possible, else raw text.
 * Rejects only on network-layer failure (connection refused, DNS, timeout, ...).
 */
function httpRequest(method, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let payload = null;
    if (bodyObj !== undefined) {
      payload = Buffer.from(JSON.stringify(bodyObj), "utf8");
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }
    if (BRIDGE_TOKEN) headers["Authorization"] = `Bearer ${BRIDGE_TOKEN}`;

    const req = BRIDGE_KIND.request(
      {
        hostname: BRIDGE_URL.hostname,
        port: BRIDGE_URL.port || (BRIDGE_URL.protocol === "https:" ? 443 : 80),
        path,
        method,
        headers,
        timeout: BRIDGE_TIMEOUT_MS,
        // No keep-alive: sockets close after each response so a lingering
        // pooled connection can never keep the process alive at EOF.
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode, text, json: parsed });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`bridge request timed out after ${BRIDGE_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let rpcSeq = 1;

/**
 * Forward a JSON-RPC call to the bridge POST /rpc.
 * Returns the parsed JSON-RPC response object ({result} or {error}).
 * Throws an Error with a `bridgeDown` flag on network-layer failure.
 */
async function bridgeRpc(method, params) {
  const reqObj = { jsonrpc: "2.0", id: rpcSeq++, method, params: params ?? {} };
  let res;
  try {
    res = await httpRequest("POST", "/rpc", reqObj);
  } catch (err) {
    const e = new Error(err && err.message ? err.message : String(err));
    e.bridgeDown = true;
    throw e;
  }
  if (res.json && typeof res.json === "object") {
    // A well-formed JSON-RPC response carries `result` xor `error`.
    if ("error" in res.json && res.json.error) return res.json;
    if ("result" in res.json) return res.json;
  }
  // Non-JSON, non-2xx, or a body that is not a JSON-RPC envelope:
  // surface as a synthetic error object.
  return {
    error: {
      code: res.status && res.status >= 400 ? res.status : -32603,
      message:
        `bridge returned unexpected response (HTTP ${res.status}): ` +
        res.text.slice(0, 500),
      ...(res.status === 401
        ? {
            data: {
              code_name: "unauthorized",
              hint: "Check --token / SHAPEZ_BRIDGE_TOKEN matches bridge.config.json.",
            },
          }
        : {}),
    },
  };
}

async function bridgeStatus() {
  let res;
  try {
    res = await httpRequest("GET", "/status");
  } catch (err) {
    const e = new Error(err && err.message ? err.message : String(err));
    e.bridgeDown = true;
    throw e;
  }
  return res;
}

// ---------------------------------------------------------------------------
// MCP content helpers.
// ---------------------------------------------------------------------------

/** Wrap arbitrary JSON-serializable data as a single MCP text content block. */
function textContent(data) {
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

function toolOk(content) {
  return { content: Array.isArray(content) ? content : [content] };
}

function toolFail(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function bridgeDownMessage(detail) {
  return JSON.stringify(
    {
      code: 1005,
      code_name: "no_connection",
      message:
        "bridge not reachable at " +
        BRIDGE_URL.origin +
        " (" +
        detail +
        ")",
      hint:
        "桥接未运行，请先启动桥接：node src/bridge/bridge.mjs " +
        "(bridge is not running; then make sure shapez.io is running and " +
        "the mod is connected). Override the address with --url <url> or " +
        "SHAPEZ_BRIDGE_URL.",
    },
    null,
    2,
  );
}

/**
 * Convert a bridge JSON-RPC error (§7) into an MCP isError tool result.
 * text = JSON of {code, code_name, message, hint?, detail?, blocker?, next[]}.
 *
 * `next` is the actionable part: a list of concrete tool calls / checks the
 * caller can run immediately. It is derived here (not in the mod) so that every
 * error path — including ones the mod only describes in prose — gets one.
 */
function bridgeErrorToToolResult(err, ctx) {
  const code = typeof err.code === "number" ? err.code : -32603;
  const data = err.data && typeof err.data === "object" ? err.data : {};
  const payload = {
    code,
    code_name: data.code_name || nameForCode(code),
    message: typeof err.message === "string" ? err.message : "",
  };
  if (data.hint !== undefined) payload.hint = data.hint;
  if (data.detail !== undefined) payload.detail = data.detail;
  else if (data.action !== undefined) payload.detail = data.action;
  if (data.blocker !== undefined) payload.blocker = data.blocker;
  if (code === 2002 && payload.blocker === undefined) {
    // Prefer the coordinates the caller supplied over ones scraped from prose.
    const cell =
      isPlainObject(ctx.action) &&
      Number.isInteger(ctx.action.x) &&
      Number.isInteger(ctx.action.y)
        ? { x: ctx.action.x, y: ctx.action.y }
        : extractCell(payload);
    const b = parseOccupant(payload, cell);
    if (b) payload.blocker = b;
  }

  const next = nextStepsFor(payload, ctx || {});
  if (next.length) payload.next = next;
  return toolFail(JSON.stringify(payload, null, 2));
}

/**
 * Best-effort parse of a tile coordinate out of an error message/detail.
 * The mod's messages use "(x,y)" — e.g. "cannot place belt at (3,4)".
 */
function extractCell(payload) {
  const sources = [
    typeof payload.message === "string" ? payload.message : "",
    typeof payload.detail === "string" ? payload.detail : "",
  ];
  for (const s of sources) {
    const m = /\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/.exec(s);
    if (m) return { x: Number(m[1]), y: Number(m[2]) };
  }
  return null;
}

/** Buildings the game refuses to remove (mirrors the mod's own delete guard). */
const NON_REMOVABLE_TYPES = new Set(["hub"]);

/**
 * Turn the mod's occupant prose into a structured blocker.
 *
 * The mod's describeTileOccupant() returns free text like
 *   "Tile occupied by belt (uid 4128, rot 0)"
 * which is readable but not machine-usable. Parsing it here gives the caller
 * {uid, type, removable} so it can decide "delete it" vs "move elsewhere"
 * without a second round trip. Unknown shapes degrade to null (no blocker).
 */
function parseOccupant(payload, cell) {
  if (payload.blocker !== undefined) return payload.blocker;
  const text = [
    typeof payload.detail === "string" ? payload.detail : "",
    typeof payload.hint === "string" ? payload.hint : "",
    typeof payload.message === "string" ? payload.message : "",
  ].join(" ");
  const m = /occupied by\s+([A-Za-z0-9_\-]+)\s*\(\s*uid\s+(\d+)/i.exec(text);
  if (!m) return null;
  const type = m[1];
  return {
    uid: Number(m[2]),
    type,
    removable: !NON_REMOVABLE_TYPES.has(type),
    ...(cell ? { x: cell.x, y: cell.y } : {}),
  };
}

/**
 * Derive the "what do I do next" list for a tool error.
 *
 * ctx = { tool, args, action } — `action` is the op being executed (for a
 * single action or for the failing item inside a batch).
 */
function nextStepsFor(payload, ctx) {
  const code = payload.code;
  const action = isPlainObject(ctx.action) ? ctx.action : {};
  const tool = ctx.tool;
  const out = [];

  switch (code) {
    case 2001: {
      // Invalid action / params: name the legal values instead of "bad input".
      if (action.op === undefined && tool === "shapez_action") {
        out.push(`shapez_action requires op; legal ops: ${ACTION_OPS.join(", ")}`);
      } else if (action.op !== undefined && !ACTION_OPS.includes(action.op)) {
        out.push(
          `unknown op ${JSON.stringify(action.op)}; legal ops: ${ACTION_OPS.join(", ")}`,
        );
      }
      const detail = `${payload.message} ${typeof payload.detail === "string" ? payload.detail : ""}`;
      if (/region/i.test(detail)) {
        out.push("region must be integer [x0,y0,x1,y1] with x0<=x1 and y0<=y1");
      }
      if (/layer/i.test(detail)) {
        out.push('layer must be "regular" or "wires"');
      }
      if (/zoom/i.test(detail)) {
        out.push("zoom must be in (0, 10]");
      }
      if (/op\b|field|unhandled/i.test(detail)) {
        out.push("See docs/PROTOCOL.md §5 for the Action schema.");
      }
      if (!out.length) {
        out.push("Re-check the action schema: shapez_action {op, ...} (docs/PROTOCOL.md §5).");
      }
      break;
    }

    case 2002: {
      // Game rejected. The most common case is an occupied tile: say WHO is
      // there and whether it can be removed, instead of "cannot place".
      const blocker =
        payload.blocker && isPlainObject(payload.blocker) ? payload.blocker : null;
      const cell =
        blocker && Number.isInteger(blocker.x)
          ? { x: blocker.x, y: blocker.y }
          : isPlainObject(ctx.action) &&
              Number.isInteger(ctx.action.x) &&
              Number.isInteger(ctx.action.y)
            ? { x: ctx.action.x, y: ctx.action.y }
            : extractCell(payload);
      if (blocker) {
        const uid = Number.isInteger(blocker.uid) ? blocker.uid : null;
        const type = typeof blocker.type === "string" ? blocker.type : "unknown";
        out.push(
          `blocker: ${type}${uid !== null ? ` uid=${uid}` : ""} at (${cell.x},${cell.y}), removable=${blocker.removable === true}`,
        );
        if (blocker.removable === true) {
          out.push(`shapez_action {op:'delete', x:${cell.x}, y:${cell.y}}`);
        } else {
          out.push(
            `${type} cannot be removed; choose another tile — ` +
              `shapez_observe {region:[${cell.x - 2},${cell.y - 2},${cell.x + 2},${cell.y + 2}], response_format:'concise'}`,
          );
        }
      } else if (cell) {
        out.push(
          `inspect the tile first: shapez_observe {region:[${cell.x - 1},${cell.y - 1},${cell.x + 1},${cell.y + 1}], response_format:'concise'}`,
        );
      }
      const detail = `${payload.message} ${typeof payload.detail === "string" ? payload.detail : ""}`;
      if (/nothing to delete|empty/i.test(detail)) {
        out.push("the tile is empty — confirm coordinates with shapez_observe before deleting");
      } else if (/afford|cost|stored/i.test(detail)) {
        out.push("check what is in the hub: shapez_observe {include_hub:true, max_entities:1}");
      } else if (/unlock|level/i.test(detail)) {
        out.push("the building may still be locked; check shapez_status / goal.upgrade_levels");
      }
      if (!out.length) {
        out.push(
          "the game refused the action; verify the target tile is free and the building is unlocked " +
            "(shapez_observe around the target, then shapez_status)",
        );
      }
      break;
    }

    case 1003: {
      // not_in_game — almost always a state-machine problem.
      out.push("check the game state first: shapez_status (in_game, paused, tick)");
      out.push(
        "deeper diagnostics live in the bridge-only RPC `debug_app_state` " +
          "(state_key, ingame_stage, root_present); it has no MCP tool yet — " +
          "call the bridge's POST /rpc directly if you need it",
      );
      out.push("if a savegame is loading, wait for it to finish and retry");
      break;
    }

    case 1002: {
      out.push("restart the game/bridge so mod and game versions match: shapez_status");
      break;
    }

    case 1001: {
      out.push("mod and bridge disagree on the protocol version; update both to the same checkout");
      out.push("confirm versions: shapez_status");
      break;
    }

    case 1004: {
      out.push("this bridge runs with --read-only; reads still work, writes need a restart without it");
      break;
    }

    case 2004:
    case 2005: {
      out.push("check the game state first: shapez_status (in_game, paused, tick)");
      out.push("raise the budget (await: timeout_ticks) or split the work into smaller actions");
      break;
    }

    case 2006: {
      out.push("blueprint is not compatible with this game version; re-export it from shapez_blueprint mode=export");
      break;
    }

    case 2003: {
      // mod_error: a thrown JS error inside the mod.
      out.push("check the game state first: shapez_status (in_game, paused, tick)");
      out.push("if the world is mid-load, retry after shapez_status reports in_game:true");
      break;
    }

    case 1005: {
      out.push("start the bridge: node src/bridge/bridge.mjs, then load a savegame in shapez.io");
      break;
    }

    default:
      break;
  }

  // Always end with a way to see the current truth.
  if (code >= 2001 && code <= 2003 && !out.some((s) => s.startsWith("shapez_observe"))) {
    out.push("re-read the world: shapez_observe {response_format:'concise'}");
  }
  return out;
}

function nameForCode(code) {
  const names = {
    1001: "protocol_version_mismatch",
    1002: "game_version_mismatch",
    1003: "not_in_game",
    1004: "read_only",
    1005: "no_connection",
    2001: "invalid_action",
    2002: "game_rejected",
    2003: "mod_error",
    2004: "timeout",
    2005: "await_timeout",
    2006: "blueprint_incompatible",
    "-32700": "parse_error",
    "-32600": "invalid_request",
    "-32601": "method_not_found",
    "-32602": "invalid_params",
    "-32603": "internal_error",
  };
  return names[String(code)] || "unknown_error";
}

// ---------------------------------------------------------------------------
// §9 tool definitions.
// ---------------------------------------------------------------------------

/** Action opcodes accepted by the mod (`performAction` switch). */
const ACTION_OPS = [
  "noop",
  "place",
  "place_path",
  "delete",
  "bulk_delete",
  "paste_blueprint",
  "export_blueprint",
  "set_speed",
  "step",
  "await",
  "camera",
  "save",
  "load",
  "new_game",
];

/** Entity fields kept by obs response_format:'concise'. */
const OBS_ENTITY_FIELDS_CONCISE = ["uid", "type", "x", "y", "r"];
/** Entity fields kept by obs response_format:'detailed' (mod default). */
const OBS_ENTITY_FIELDS_DETAILED = [
  "uid",
  "type",
  "x",
  "y",
  "r",
  "variant",
  "rotation_variant",
  "code",
  "layer",
];

const TOOLS = [
  {
    name: "shapez_status",
    description:
      "Bridge/game health and status: connection state, mod & game versions, " +
      "in-game state, tick, speed, read-only flag. Safe to call anytime " +
      "(report only; no connection required).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "shapez_observe",
    description:
      "Observe the factory: current level/goal, camera, hub contents, " +
      "entities (with stable uid) and stats, optionally resources. " +
      "Use `region` to crop, `max_entities` to cap (truncation is reported, " +
      "never silent). " +
      "`response_format:'concise'` drops variant/rotation_variant/code/layer " +
      "from every entity (~45% smaller); it keeps r (rotation), so use " +
      "'detailed' (default) when you need variants or building codes. " +
      "For 'is this line connected / where is the jam', prefer shapez_items " +
      "(boundAcceptor, per-belt item counts) over a full obs.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "array",
          items: { type: "integer" },
          minItems: 4,
          maxItems: 4,
          description: "Bounding box [x0,y0,x1,y1]. Default: bbox of all entities.",
        },
        max_entities: {
          type: "integer",
          minimum: 1,
          maximum: 20000,
          description: "Hard cap on returned entities (default 2000). Over the cap -> truncated:true; stats stay complete.",
        },
        include_hub: {
          type: "boolean",
          description: "Include hub stored shapes, blueprint cost, free-paste flag (default true).",
        },
        include_resources: {
          type: "boolean",
          description: "Include resource patches [[x,y,shape],...] on the lower layer (default false). For a compact per-resource summary use shapez_resources instead.",
        },
        include_stats: {
          type: "boolean",
          description: "Include per-type entity counts (default true).",
        },
        max_resources: {
          type: "integer",
          minimum: 1,
          maximum: 20000,
          description:
            "Only with include_resources: cap on returned resource patches (default 2000).",
        },
        layer: {
          type: "string",
          enum: ["regular", "wires", "all"],
          description:
            'Which layer to enumerate: "regular" (default), "wires", or "all".',
        },
        response_format: {
          type: "string",
          enum: ["concise", "detailed"],
          description:
            "concise = entities only carry {uid,type,x,y,r}. " +
            "detailed (default) = also variant/rotation_variant/code/layer. " +
            "Need orientation or variant? use detailed.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "shapez_production",
    description:
      "Real throughput from the game's own productionAnalytics (not an estimate): " +
      "produced/delivered per-second rates per shape plus the stored delta, " +
      "over the last N analytics slices. Use it to answer 'is this line actually " +
      "producing / how fast does it drain'. shapez_observe only reports entities " +
      "and cumulative hub storage, so it cannot tell you a rate. " +
      "Rates are averaged over the window (default 6 slices = 60 s); " +
      "per-slice arrays expose a mid-window stall.",
    inputSchema: {
      type: "object",
      properties: {
        slices: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description:
            "How many recent analytics slices to average (1 slice = 10 s). Default 6 (60 s).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "shapez_items",
    description:
      "Read the items ON belts / in machine ejector slots / pending in tunnels, " +
      "plus each belt path's `boundAcceptor` (the cell its output is bound to, or " +
      "null when nothing accepts it). This is the tool for 'is this line " +
      "connected?', 'where is it jammed?', 'is the miner producing?' — shapez_observe " +
      "only sees buildings, never items. " +
      "Paths beyond the first 40 are summarised (see pathCount/truncatedPaths); " +
      "`region` is required and must be [x0,y0,x1,y1].",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "array",
          items: { type: "integer" },
          minItems: 4,
          maxItems: 4,
          description:
            "Bounding box [x0,y0,x1,y1] (required). Keep it tight: it scans all belts.",
        },
      },
      required: ["region"],
      additionalProperties: false,
    },
  },
  {
    name: "shapez_world",
    description:
      "Map identity: world seed, game version, and the hub's exact tile rect. " +
      "Call this before offline planning/compiling: resource layout is derived " +
      "from the seed, and the offline compiler's default seed (43391) belongs to " +
      "one specific savegame — using it elsewhere silently places miners on empty " +
      "ground. Takes no arguments.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "shapez_resources",
    description:
      "Natural resource patches (ore on the lower layer), aggregated per resource: " +
      "total tile count, bounding box, and per-row contiguous runs `{y,from,to,len}` " +
      "so you can see how many miners fit side by side. shapez_observe reports " +
      "buildings only — ore is not an entity, so without this tool the map's " +
      "minable ground is invisible. Default region is [-40,-40,40,40] (80x80 around " +
      "the hub); scanning is capped at 40000 tiles.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "array",
          items: { type: "integer" },
          minItems: 4,
          maxItems: 4,
          description:
            "Bounding box [x0,y0,x1,y1]. Default: [-40,-40,40,40]. Max 40000 tiles.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "shapez_action",
    description:
      "Execute ONE game action as {op, ...params}. Ops: noop, place{building,x,y,r?,variant?}, " +
      "place_path{building,from,to,r?}, delete{x,y,layer?}, bulk_delete{region,layer?}, " +
      "paste_blueprint{text,x,y,charge?}, export_blueprint{region}, set_speed{speed}, " +
      "step{ticks,collect?}, await{until,timeout_ticks,chunk?,collect?}, camera{x,y,zoom?}, save, load{internal_id}, new_game{game_mode?}. " +
      "Unknown op/field -> error 2001 with `next` listing the legal values. See docs/PROTOCOL.md §5.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ACTION_OPS,
          description: "Action opcode (required).",
        },
      },
      required: ["op"],
      additionalProperties: true,
    },
  },
  {
    name: "shapez_batch",
    description:
      "Execute a sequence of actions IN ORDER, FAIL-FAST: the first action that " +
      "returns an error stops the run, and the response says which action failed " +
      "and which ones were never executed. " +
      "Returns {results:[ActionResult,...], ok, stopped, failed_at?, not_executed:[{index,op}]}. " +
      "Actions are dispatched one at a time so that 'not_executed' is truthful " +
      "(the bridge-side batch continues after a rejection, which hides the tail). " +
      "Set continue_on_error:true for the old best-effort behaviour. " +
      "Note: `await_timeout` (2005) is documented as a non-error outcome and does " +
      "not stop the run.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          minItems: 1,
          maxItems: 5000,
          description: "Ordered list of action objects, each with an `op`.",
        },
        continue_on_error: {
          type: "boolean",
          description:
            "false (default): stop at the first failing action. true: run every action and report each result (old bridge semantics).",
        },
      },
      required: ["actions"],
      additionalProperties: false,
    },
  },
  {
    name: "shapez_screenshot",
    description:
      "Capture the game canvas as a PNG (returned as MCP image content). " +
      "Position the view first with shapez_action {op:'camera'}.",
    inputSchema: {
      type: "object",
      properties: {
        scale: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Downscale factor 0..1 (1 = full resolution). Default 1.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "shapez_blueprint",
    description:
      "Blueprint transfer. mode='export': export the entities in `region` and return the " +
      "blueprint string (SZBP1.<lz>). mode='paste': paste a blueprint `text` at (x,y); " +
      "charge='auto' (default) pays the blueprint cost per game rules, charge=false pastes free (sandbox).",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["export", "paste"],
          description: "export or paste.",
        },
        region: {
          type: "array",
          items: { type: "integer" },
          minItems: 4,
          maxItems: 4,
          description: "Export only: bounding box [x0,y0,x1,y1].",
        },
        text: {
          type: "string",
          description: "Paste only: blueprint string (SZBP1.*).",
        },
        x: { type: "integer", description: "Paste only: anchor X." },
        y: { type: "integer", description: "Paste only: anchor Y." },
        charge: {
          description: "Paste only: 'auto' (pay per game rules) or false (free). Default 'auto'.",
          oneOf: [{ type: "string", enum: ["auto"] }, { type: "boolean" }],
        },
      },
      required: ["mode"],
      additionalProperties: false,
    },
  },
  {
    name: "shapez_save",
    description:
      "Save the game now and snapshot the savegame file on the bridge side. " +
      "Optional `name` for the snapshot (default auto-<timestamp>).",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          description: "Snapshot name (file stem). Default: auto-<timestamp>.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "shapez_load",
    description:
      "Restore a bridge-side snapshot by name and load it into the game.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          description: "Snapshot name previously created with shapez_save.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// Tool implementations (§9 semantics).
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Build the ObsRequest from tool args (only known keys pass through). */
function obsParams(args) {
  const p = {};
  if (args.region !== undefined) p.region = args.region;
  if (args.max_entities !== undefined) p.max_entities = args.max_entities;
  if (args.include_hub !== undefined) p.include_hub = args.include_hub;
  if (args.include_resources !== undefined)
    p.include_resources = args.include_resources;
  if (args.include_stats !== undefined) p.include_stats = args.include_stats;
  if (args.max_resources !== undefined) p.max_resources = args.max_resources;
  if (args.layer !== undefined) p.layer = args.layer;
  return p;
}

/**
 * Apply obs response_format to an Observation result.
 *
 * `concise` rewrites each entity to {uid,type,x,y,r} — the four fields that
 * describe *layout* — and drops variant/rotation_variant/code/layer, which the
 * mod emits at ~117 B/entity but which only matter when you need to tell
 * variants or wire codes apart. r (rotation) is kept: direction is layout.
 *
 * The mod is not asked to filter (it has no response_format field); trimming
 * here keeps the bridge protocol unchanged and backwards compatible.
 * Fields that only exist on the mod side (stats/hub/goal/region/truncated/...)
 * are preserved untouched, so no information about *completeness* is lost.
 */
function applyObsFormat(result, format) {
  if (format !== "concise") return result;
  if (!isPlainObject(result) || !Array.isArray(result.entities)) return result;
  const entities = result.entities.map((e) => {
    if (!isPlainObject(e)) return e;
    const o = {};
    for (const k of OBS_ENTITY_FIELDS_CONCISE) {
      if (e[k] !== undefined) o[k] = e[k];
    }
    return o;
  });
  return { ...result, entities, response_format: "concise" };
}

function validateResponseFormat(args) {
  const f = args.response_format;
  if (f === undefined) return "detailed";
  if (f !== "concise" && f !== "detailed") {
    invalidParams(
      `response_format must be "concise" or "detailed", got ${JSON.stringify(f)}`,
      ['use response_format:"concise" or omit it (detailed is the default)'],
    );
  }
  return f;
}

/**
 * One bridge `act` call, with errors turned into isError tool results carrying
 * `next` steps. Returns {ok:true, result} or {ok:false, toolResult}.
 */
async function actOnce(action) {
  let resp;
  try {
    resp = await bridgeRpc("act", action);
  } catch (err) {
    return { ok: false, toolResult: toolFail(bridgeDownMessage(err && err.message)) };
  }
  if (resp.error) {
    return {
      ok: false,
      toolResult: bridgeErrorToToolResult(resp.error, {
        tool: "shapez_action",
        args: action,
        action,
      }),
    };
  }
  return { ok: true, result: resp.result };
}

/**
 * Fail-fast batch: dispatch actions one at a time through the bridge and stop
 * at the first error.
 *
 * Why not the bridge's `batch`: performBatch pushes a failed ActionResult and
 * keeps going (only 1003/1004 abort), and on an abort it simply stops pushing —
 * the caller sees a short `results` array and cannot tell "3 actions ran" from
 * "5 were requested, 2 never ran". Dispatching from here makes the report
 * truthful: every result is present up to the failure, and the remainder is
 * listed explicitly in `not_executed`.
 *
 * `await_timeout` (2005) is treated as a *non-fatal* outcome: PROTOCOL.md
 * documents it as "not an error state", so the run continues.
 */
async function runBatchFailFast(actions, continueOnError) {
  const results = [];
  let stoppedAt = null;

  for (let i = 0; i < actions.length; i++) {
    const action = isPlainObject(actions[i]) ? actions[i] : {};
    const r = await actOnce(action);
    if (r.ok) {
      results.push({ ok: true, ...(isPlainObject(r.result) ? r.result : { value: r.result }) });
      continue;
    }
    const errText = r.toolResult.content[0].text;
    let err = null;
    try {
      err = JSON.parse(errText);
    } catch {
      err = { message: errText };
    }
    results.push({
      ok: false,
      op: action.op,
      index: i,
      error: err,
      ...(action.x !== undefined && action.y !== undefined
        ? { cell: { x: action.x, y: action.y } }
        : {}),
    });
    const fatal = continueOnError === true ? false : err.code !== 2005;
    if (fatal) {
      stoppedAt = i;
      break;
    }
  }

  const failedCount = results.filter((r) => !r.ok).length;
  const out = {
    ok: failedCount === 0,
    results,
    executed: results.length,
    requested: actions.length,
    failed: failedCount,
    stopped: stoppedAt !== null,
  };
  if (stoppedAt !== null) {
    out.failed_at = stoppedAt;
    out.failed_op = results[stoppedAt] && results[stoppedAt].op;
    out.not_executed = actions
      .slice(stoppedAt + 1)
      .map((a, k) => ({ index: stoppedAt + 1 + k, op: isPlainObject(a) ? a.op : undefined }));
  }
  return out;
}

async function callTool(name, args) {
  if (!isPlainObject(args)) args = {};

  switch (name) {
    case "shapez_status": {
      // §9: status = bridge /status + bridge state /health.
      let health = null;
      let statusRes = null;
      try {
        const h = await httpRequest("GET", "/health");
        health = h.json !== null ? h.json : { raw: h.text, http_status: h.status };
      } catch (err) {
        return toolFail(bridgeDownMessage(err && err.message));
      }
      try {
        statusRes = await bridgeStatus();
      } catch (err) {
        // /health worked but /status failed: report status of connection.
        return toolFail(
          JSON.stringify(
            {
              code: -32603,
              code_name: "internal_error",
              message: "bridge /status failed: " + (err && err.message),
              health,
              hint: "Bridge responds to /health but /status failed; check bridge logs.",
            },
            null,
            2,
          ),
        );
      }
      const out = {
        bridge: {
          url: BRIDGE_URL.origin,
          health,
        },
      };
      if (statusRes.status >= 400 && !statusRes.json) {
        out.status_http_error = { http_status: statusRes.status, body: statusRes.text.slice(0, 500) };
      } else if (statusRes.json && statusRes.json.error) {
        // §7 error from /status (e.g. 1005 no mod connection)
        const e = statusRes.json.error;
        const data = isPlainObject(e.data) ? e.data : {};
        out.status = {
          code: e.code,
          code_name: data.code_name || nameForCode(e.code),
          message: e.message || "",
          ...(data.hint !== undefined ? { hint: data.hint } : {}),
        };
        // Status is still useful info (health is there), not a tool failure:
        // report without isError so the AI can see mod_connected=false.
      } else if (isPlainObject(statusRes.json) && "result" in statusRes.json) {
        // /status returned a JSON-RPC-wrapped response; unwrap it.
        out.status = statusRes.json.result;
      } else {
        out.status = statusRes.json !== null ? statusRes.json : statusRes.text;
      }
      return toolOk(textContent(out));
    }

    case "shapez_observe": {
      const format = validateResponseFormat(args);
      const params = obsParams(args);
      let resp;
      try {
        resp = await bridgeRpc("obs", params);
      } catch (err) {
        return toolFail(bridgeDownMessage(err && err.message));
      }
      if (resp.error) {
        return bridgeErrorToToolResult(resp.error, { tool: "shapez_observe", args });
      }
      return toolOk(textContent(applyObsFormat(resp.result, format)));
    }

    case "shapez_production": {
      const params = {};
      if (args.slices !== undefined) {
        if (!Number.isInteger(args.slices) || args.slices < 1 || args.slices > 100) {
          invalidParams(
            `slices must be an integer in [1,100], got ${JSON.stringify(args.slices)}`,
            ["use slices:6 for the last 60 s, or slices:1..100 (1 slice = 10 s)"],
          );
        }
        params.slices = args.slices;
      }
      return forwardRpc("production", params, { tool: "shapez_production", args });
    }

    case "shapez_items": {
      if (!Array.isArray(args.region) || args.region.length !== 4) {
        invalidParams(
          "shapez_items requires `region` [x0,y0,x1,y1]",
          [
            "pass 4 integers: shapez_items {region:[x0,y0,x1,y1]}",
            "get the bbox first: shapez_observe {response_format:'concise', max_entities:1}",
          ],
        );
      }
      return forwardRpc("debug_items", { region: args.region }, {
        tool: "shapez_items",
        args,
      });
    }

    case "shapez_world": {
      return forwardRpc("world_info", {}, { tool: "shapez_world", args });
    }

    case "shapez_resources": {
      const params = {};
      if (args.region !== undefined) {
        if (!Array.isArray(args.region) || args.region.length !== 4) {
          invalidParams(
            "region must be [x0,y0,x1,y1] with x0<=x1, y0<=y1",
            ["omit region for the default [-40,-40,40,40], or pass 4 integers"],
          );
        }
        const area =
          (Math.abs(args.region[2] - args.region[0]) + 1) *
          (Math.abs(args.region[3] - args.region[1]) + 1);
        if (area > 40000) {
          invalidParams(
            `region covers ${area} tiles, the mod caps a scan at 40000`,
            [
              "narrow the box, or scan it in pieces of at most 200x200",
              "the default [-40,-40,40,40] is 6561 tiles",
            ],
          );
        }
        params.region = args.region;
      }
      return forwardRpc("resources", params, { tool: "shapez_resources", args });
    }

    case "shapez_action": {
      if (typeof args.op !== "string" || args.op.length === 0) {
        invalidParams(
          `shapez_action requires a non-empty string \`op\``,
          [`legal ops: ${ACTION_OPS.join(", ")}`],
        );
      }
      // op and params are forwarded as-is (§9).
      return forwardRpc("act", args, { tool: "shapez_action", args, action: args });
    }

    case "shapez_batch": {
      if (!Array.isArray(args.actions) || args.actions.length === 0) {
        invalidParams("shapez_batch requires a non-empty `actions` array.", [
          "pass at least one action: shapez_batch {actions:[{op:'noop'}]}",
        ]);
      }
      if (args.actions.length > 5000) {
        invalidParams(
          `shapez_batch accepts at most 5000 actions, got ${args.actions.length}`,
          ["split the list into several shapez_batch calls"],
        );
      }
      const badIdx = args.actions.findIndex(
        (a) => !isPlainObject(a) || typeof a.op !== "string",
      );
      if (badIdx !== -1) {
        invalidParams(`shapez_batch actions[${badIdx}] is not an object with a string \`op\``, [
          `legal ops: ${ACTION_OPS.join(", ")}`,
        ]);
      }
      const out = await runBatchFailFast(args.actions, args.continue_on_error);
      return toolOk(textContent(out));
    }

    case "shapez_screenshot": {
      const params = {};
      if (args.scale !== undefined) params.scale = args.scale;
      let resp;
      try {
        resp = await bridgeRpc("screenshot", params);
      } catch (err) {
        return toolFail(bridgeDownMessage(err && err.message));
      }
      if (resp.error) {
        return bridgeErrorToToolResult(resp.error, { tool: "shapez_screenshot", args });
      }
      const r = isPlainObject(resp.result) ? resp.result : {};
      const png =
        typeof r.png_base64 === "string"
          ? r.png_base64
          : typeof r.png === "string"
            ? r.png
            : null;
      if (!png) {
        return toolFail(
          JSON.stringify(
            {
              code: -32603,
              code_name: "internal_error",
              message:
                "bridge screenshot result has no png_base64 field.",
              detail: resp.result,
              next: [
                "the mod may not have a canvas yet: retry after shapez_status reports in_game:true",
                "if it persists, inspect state: RPC debug_app_state",
              ],
            },
            null,
            2,
          ),
        );
      }
      const content = [
        { type: "image", data: png, mimeType: "image/png" },
        {
          type: "text",
          text: `screenshot ${r.w ?? "?"}x${r.h ?? "?"} px (scale=${params.scale ?? 1})`,
        },
      ];
      return toolOk(content);
    }

    case "shapez_blueprint": {
      const mode = args.mode;
      if (mode !== "export" && mode !== "paste") {
        invalidParams(
          `shapez_blueprint: mode must be "export" or "paste", got ${JSON.stringify(mode)}`,
          ['legal values: "export", "paste"'],
        );
      }
      if (mode === "export") {
        if (!Array.isArray(args.region) || args.region.length !== 4) {
          invalidParams(
            "shapez_blueprint mode=export requires `region` [x0,y0,x1,y1]",
            ["pass 4 integers, e.g. region:[-2,-2,2,2]"],
          );
        }
        let resp;
        try {
          resp = await bridgeRpc("act", {
            op: "export_blueprint",
            region: args.region,
          });
        } catch (err) {
          return toolFail(bridgeDownMessage(err && err.message));
        }
        if (resp.error) {
          return bridgeErrorToToolResult(resp.error, {
            tool: "shapez_blueprint",
            args,
            action: { op: "export_blueprint", region: args.region },
          });
        }
        // §9 out is the blueprint string itself ("text 放结果"). The bridge
        // may return the raw string or an ActionResult carrying it.
        const r = resp.result;
        let text = null;
        if (typeof r === "string") text = r;
        else if (isPlainObject(r) && typeof r.text === "string") text = r.text;
        else if (isPlainObject(r) && typeof r.blueprint === "string")
          text = r.blueprint;
        if (text !== null) return toolOk([{ type: "text", text }]);
        return toolOk(textContent(r));
      }
      // mode === "paste"
      if (typeof args.text !== "string" || args.text.length === 0) {
        invalidParams(
          "shapez_blueprint mode=paste requires `text` (blueprint string)",
          ["export one first: shapez_blueprint {mode:'export', region:[...]}"],
        );
      }
      const params = { op: "paste_blueprint", text: args.text };
      if (args.x !== undefined) params.x = args.x;
      if (args.y !== undefined) params.y = args.y;
      if (args.charge !== undefined) params.charge = args.charge;
      return forwardRpc("act", params, {
        tool: "shapez_blueprint",
        args,
        action: params,
      });
    }

    case "shapez_save": {
      const params = {};
      if (args.name !== undefined) params.name = args.name;
      return forwardRpc("snapshot_save", params, { tool: "shapez_save", args });
    }

    case "shapez_load": {
      if (typeof args.name !== "string" || args.name.length === 0) {
        invalidParams("shapez_load requires a non-empty `name` (snapshot name)", [
          "snapshot names come from shapez_save; letters, digits, space, dot, _ and - only",
        ]);
      }
      return forwardRpc("snapshot_load", { name: args.name }, {
        tool: "shapez_load",
        args,
      });
    }

    default:
      return null; // signal: unknown tool
  }
}

/** Forward a call to the bridge and map its response to MCP tool result. */
async function forwardRpc(method, params, ctx) {
  let resp;
  try {
    resp = await bridgeRpc(method, params);
  } catch (err) {
    return toolFail(bridgeDownMessage(err && err.message));
  }
  if (resp.error) return bridgeErrorToToolResult(resp.error, ctx);
  return toolOk(textContent(resp.result));
}

/**
 * Tool argument validation failure. Per MCP spec, invalid tool arguments are
 * protocol errors (JSON-RPC -32602), not isError tool results. Thrown by
 * callTool and translated in the tools/call handler.
 *
 * `next` rides along in error.data so a client that renders the protocol error
 * still sees the legal values / the next call to make.
 */
class InvalidParamsError extends Error {
  constructor(detail, next) {
    super(detail);
    this.next = Array.isArray(next) ? next : [];
  }
}

/**
 * @param {string} detail human-readable reason
 * @param {string[]} [next] concrete next steps (tool calls / checks)
 */
function invalidParams(detail, next) {
  throw new InvalidParamsError(detail, next);
}

// ---------------------------------------------------------------------------
// JSON-RPC / MCP dispatch.
// ---------------------------------------------------------------------------

const SERVER_INFO = { name: "shapez-ai-bridge", version: "0.1.0" };
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
// Highest supported version is the last one in the list.
const LATEST_PROTOCOL_VERSION =
  SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

function negotiateProtocolVersion(requested) {
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return requested;
  return LATEST_PROTOCOL_VERSION;
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id, error: err };
}

/**
 * Reject arguments that the tool's own schema does not declare.
 *
 * The schemas already say `additionalProperties: false`, but nothing enforced
 * it: a caller typing `maxEntities` instead of `max_entities` got a silently
 * ignored field and an un-capped response — the worst kind of failure, because
 * it looks like it worked. Tools that opt into extra properties (shapez_action)
 * are left alone.
 */
function checkUnknownArgs(name, args) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool || !isPlainObject(tool.inputSchema)) return;
  if (tool.inputSchema.additionalProperties !== false) return;
  const allowed = Object.keys(tool.inputSchema.properties || {});
  const unknown = Object.keys(args).filter((k) => !allowed.includes(k));
  if (!unknown.length) return;
  invalidParams(
    `${name}: unknown argument(s) ${unknown.map((k) => JSON.stringify(k)).join(", ")}`,
    [
      `legal arguments: ${allowed.length ? allowed.join(", ") : "(none)"}`,
      `call tools/list for the full schema of ${name}`,
    ],
  );
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize": {
      const requested =
        isPlainObject(params) && typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : null;
      const protocolVersion = negotiateProtocolVersion(requested);
      if (requested && requested !== protocolVersion) {
        log(
          `client requested protocol ${JSON.stringify(requested)}; ` +
            `responding with ${protocolVersion}`,
        );
      }
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: TOOLS });

    case "tools/call": {
      if (!isPlainObject(params) || typeof params.name !== "string") {
        return rpcError(id, -32602, "Invalid params: tools/call requires {name, arguments}.");
      }
      const name = params.name;
      if (!TOOL_BY_NAME.has(name)) {
        return rpcError(id, -32601, `Unknown tool: ${name}`);
      }
      const args = isPlainObject(params.arguments) ? params.arguments : {};
      try {
        checkUnknownArgs(name, args);
        const result = await callTool(name, args);
        if (result === null) {
          // Defense in depth; TOOL_BY_NAME check should prevent this.
          return rpcError(id, -32601, `Unknown tool: ${name}`);
        }
        return rpcResult(id, result);
      } catch (err) {
        if (err instanceof InvalidParamsError) {
          return rpcError(
            id,
            -32602,
            `Invalid params: ${err.message}`,
            err.next.length ? { next: err.next } : undefined,
          );
        }
        log(`tool ${name} threw: ${err && err.stack ? err.stack : err}`);
        return rpcResult(
          id,
          toolFail(
            JSON.stringify(
              {
                code: -32603,
                code_name: "internal_error",
                message: `MCP server internal error in ${name}: ${err && err.message}`,
              },
              null,
              2,
            ),
          ),
        );
      }
    }

    default:
      // Unknown method. If it's a request (has id), answer -32601.
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

function handleNotification(msg) {
  const method = msg.method;
  if (method === "notifications/initialized") {
    log("client initialized");
    return;
  }
  // Other notifications: ignore silently (no response allowed).
  log(`ignoring notification: ${method}`);
}

// ---------------------------------------------------------------------------
// stdio transport: newline-delimited JSON.
// ---------------------------------------------------------------------------

function writeMessage(obj) {
  const line = JSON.stringify(obj);
  // Guard: a protocol message must never contain a raw newline.
  if (line.includes("\n") || line.includes("\r")) {
    log("BUG: serialized message contains newline; dropping");
    return;
  }
  process.stdout.write(line + "\n");
}

// Serialize processing to guarantee response order matches arrival order.
let queue = Promise.resolve();

function enqueue(fn) {
  queue = queue.then(fn).catch((err) => {
    log(`dispatch error: ${err && err.stack ? err.stack : err}`);
  });
}

let buffer = "";

function processLine(line) {
  const trimmed = line.trim();
  if (trimmed === "") return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    // -32700 parse error; id unknown -> null per JSON-RPC 2.0.
    log(`parse error: ${err.message}`);
    enqueue(async () => writeMessage(rpcError(null, -32700, "Parse error")));
    return;
  }

  if (!isPlainObject(msg)) {
    // Batch array or scalar: MCP stdio uses single objects; treat as invalid.
    enqueue(async () => writeMessage(rpcError(null, -32600, "Invalid Request")));
    return;
  }

  const hasId = Object.prototype.hasOwnProperty.call(msg, "id");
  const isRequest = hasId;
  const isNotification = !hasId && typeof msg.method === "string";

  if (!isRequest && !isNotification) {
    // Object without id and without method: invalid (has no meaning).
    enqueue(async () => writeMessage(rpcError(null, -32600, "Invalid Request")));
    return;
  }

  if (isNotification) {
    handleNotification(msg);
    return;
  }

  // Request: must have a method.
  if (typeof msg.method !== "string") {
    enqueue(async () =>
      writeMessage(rpcError(msg.id, -32600, "Invalid Request: missing method")),
    );
    return;
  }

  enqueue(async () => {
    const response = await handleRequest(msg);
    writeMessage(response);
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    processLine(line);
  }
});

process.stdin.on("end", () => {
  // EOF: process any trailing partial line (be lenient — last line without \n).
  if (buffer.trim() !== "") {
    processLine(buffer);
    buffer = "";
  }
  // Wait for the queue to drain, then exit 0. Use an explicit stdout flush
  // so the final response is not lost to an abrupt exit.
  queue.finally(() => {
    process.stdout.write("", () => process.exit(0));
  });
});

process.stdin.on("error", (err) => {
  log(`stdin error: ${err.message}`);
  process.exit(1);
});

// stdout errors (EPIPE, closed pipe): exit quietly.
process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") process.exit(0);
  log(`stdout error: ${err && err.message}`);
  process.exit(1);
});

log(
  `shapez-ai-bridge MCP server v${SERVER_INFO.version} started; ` +
    `bridge=${BRIDGE_URL.origin} token=${BRIDGE_TOKEN ? "set" : "none"}`,
);
