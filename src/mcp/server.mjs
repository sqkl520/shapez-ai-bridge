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
 * text = JSON of {code, code_name, message, hint?, detail?}.
 */
function bridgeErrorToToolResult(err) {
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
  return toolFail(JSON.stringify(payload, null, 2));
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
      "never silent).",
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
          description: "Include resource patches [[x,y,shape],...] on the lower layer (default false).",
        },
        include_stats: {
          type: "boolean",
          description: "Include per-type entity counts (default true).",
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
      "Unknown op/field -> error 2001. See docs/PROTOCOL.md §5.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: [
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
          ],
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
      "Execute a sequence of actions in order (each a §5 Action object). " +
      "Returns {results:[ActionResult,...]}. Use for multi-step edits in one round trip.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          minItems: 1,
          description: "Ordered list of action objects, each with an `op`.",
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
  return p;
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
      return forwardRpc("obs", obsParams(args));
    }

    case "shapez_action": {
      if (typeof args.op !== "string" || args.op.length === 0) {
        invalidParams("shapez_action requires a non-empty string `op`.");
      }
      // op and params are forwarded as-is (§9).
      return forwardRpc("act", args);
    }

    case "shapez_batch": {
      if (!Array.isArray(args.actions) || args.actions.length === 0) {
        invalidParams("shapez_batch requires a non-empty `actions` array.");
      }
      return forwardRpc("batch", { actions: args.actions });
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
      if (resp.error) return bridgeErrorToToolResult(resp.error);
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
          `shapez_blueprint: mode must be "export" or "paste", got ${JSON.stringify(mode)}.`,
        );
      }
      if (mode === "export") {
        if (!Array.isArray(args.region) || args.region.length !== 4) {
          invalidParams(
            "shapez_blueprint mode=export requires `region` [x0,y0,x1,y1].",
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
        if (resp.error) return bridgeErrorToToolResult(resp.error);
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
          "shapez_blueprint mode=paste requires `text` (blueprint string).",
        );
      }
      const params = { op: "paste_blueprint", text: args.text };
      if (args.x !== undefined) params.x = args.x;
      if (args.y !== undefined) params.y = args.y;
      if (args.charge !== undefined) params.charge = args.charge;
      return forwardRpc("act", params);
    }

    case "shapez_save": {
      const params = {};
      if (args.name !== undefined) params.name = args.name;
      return forwardRpc("snapshot_save", params);
    }

    case "shapez_load": {
      if (typeof args.name !== "string" || args.name.length === 0) {
        invalidParams("shapez_load requires a non-empty `name` (snapshot name).");
      }
      return forwardRpc("snapshot_load", { name: args.name });
    }

    default:
      return null; // signal: unknown tool
  }
}

/** Forward a call to the bridge and map its response to MCP tool result. */
async function forwardRpc(method, params) {
  let resp;
  try {
    resp = await bridgeRpc(method, params);
  } catch (err) {
    return toolFail(bridgeDownMessage(err && err.message));
  }
  if (resp.error) return bridgeErrorToToolResult(resp.error);
  return toolOk(textContent(resp.result));
}

/**
 * Tool argument validation failure. Per MCP spec, invalid tool arguments are
 * protocol errors (JSON-RPC -32602), not isError tool results. Thrown by
 * callTool and translated in the tools/call handler.
 */
class InvalidParamsError extends Error {}

function invalidParams(detail) {
  throw new InvalidParamsError(detail);
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
        const result = await callTool(name, args);
        if (result === null) {
          // Defense in depth; TOOL_BY_NAME check should prevent this.
          return rpcError(id, -32601, `Unknown tool: ${name}`);
        }
        return rpcResult(id, result);
      } catch (err) {
        if (err instanceof InvalidParamsError) {
          return rpcError(id, -32602, `Invalid params: ${err.message}`);
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
