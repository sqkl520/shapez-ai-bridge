#!/usr/bin/env node
// Self-test for src/mcp/server.mjs — zero npm dependencies (node: builtins only).
//
// Usage: node src/mcp/selftest.mjs
//
// Spins up a mock bridge (node:http) and drives the MCP server as a child
// process over stdio, asserting the frozen contract in docs/PROTOCOL.md:
//   - §9 tool mapping (12 tools, name/arg passthrough, screenshot image content)
//   - read-only tools exposed by the mod but formerly unreachable over MCP
//     (production / debug_items / world_info / resources)
//   - obs response_format:'concise' trimming
//   - error payloads carry an actionable `next` array
//   - shapez_batch fail-fast semantics (not_executed is explicit)
//   - §7 error codes surfaced as isError content
//   - §11.1 bridge HTTP forwarding (POST /rpc, GET /health, GET /status)
//   - MCP stdio framing: one JSON per stdout line, notifications answered with
//     silence, EOF → exit 0.
//
// Prints PASS/FAIL lines and a summary; exit code 0 iff everything passed.

import http from "node:http";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(HERE, "server.mjs");

// ---------------------------------------------------------------------------
// Tiny test harness.
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`FAIL  ${name}${detail !== undefined ? `  [${detail}]` : ""}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Line-based stdout reader.
// ---------------------------------------------------------------------------

class LineReader {
  constructor(stream) {
    this.buf = "";
    this.all = []; // every raw line ever received (for pollution checks)
    this.queue = []; // received, not yet consumed
    this.pending = []; // active next() waiters
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        this.all.push(line);
        const w = this.pending.shift();
        if (w) {
          clearTimeout(w.timer);
          w.resolve(line);
        } else {
          this.queue.push(line);
        }
      }
    });
  }

  next(timeoutMs = 8000) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const idx = this.pending.indexOf(w);
        if (idx !== -1) this.pending.splice(idx, 1);
        reject(new Error(`timeout after ${timeoutMs}ms waiting for stdout line`));
      }, timeoutMs);
      this.pending.push(w);
    });
  }
}

// ---------------------------------------------------------------------------
// Fixtures: valid 1x1 transparent PNG (generated, not hand-copied).
// ---------------------------------------------------------------------------

function crc32(buf) {
  // node:zlib.crc32 exists on Node >= 20.15 / 22; fallback for safety.
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function make1x1Png() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const raw = Buffer.from([0x00, 0, 0, 0, 0]); // filter byte + RGBA transparent
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG_1X1_BUF = make1x1Png();
const PNG_1X1 = PNG_1X1_BUF.toString("base64");

const MOCK_BLUEPRINT = "SZBP1.selftest-fake-blueprint";

const MOCK_STATUS = {
  mod_version: "0.1.0",
  game_version: "1.5.6",
  protocol: 1,
  in_game: true,
  tick: 123.45,
  paused: false,
  speed: "regular",
  layer: "regular",
  read_only: false,
};

const MOCK_OBS = {
  protocol: 1,
  mod_version: "0.1.0",
  game_version: "1.5.6",
  in_game: true,
  tick: 123.45,
  paused: false,
  speed: "regular",
  layer: "regular",
  camera: { x: 0, y: 0, zoom: 1 },
  goal: {
    level: 10,
    requirement: {
      shape: "CuCuCuCu",
      required: 100,
      delivered: 37,
      progress: 0.37,
      throughput_only: false,
    },
    upgrade_levels: { belt: 3, miner: 2, processors: 2, painting: 1 },
  },
  hub: {
    stored_shapes: { CuCuCuCu: 25267 },
    blueprint_cost: 123,
    has_free_paste: false,
  },
  region: [0, 0, 10, 10],
  entities: [
    { uid: 10002, type: "miner", x: -7, y: 5, r: 90, variant: "default", rotation_variant: 0, code: 7, layer: "regular" },
    { uid: 10003, type: "belt", x: -6, y: 5, r: 0, variant: "default", rotation_variant: 0, code: 12, layer: "regular" },
  ],
  stats: { total: 2, by_type: { miner: 1, belt: 1 } },
  truncated: false,
  entity_count: 2,
};

const MOCK_PRODUCTION = {
  window_seconds: 60,
  slice_seconds: 10,
  slices_returned: 6,
  produced_total: { CuCuCuCu: 120 },
  produced_per_sec: { CuCuCuCu: 2 },
  delivered_total: { CuCuCuCu: 100 },
  delivered_per_sec: { CuCuCuCu: 1.667 },
  stored_delta: { CuCuCuCu: 20 },
  produced_slices: [{ CuCuCuCu: 20 }],
  delivered_slices: [{ CuCuCuCu: 16 }],
};

const MOCK_ITEMS = {
  belts: [{ cell: [-6, 5], path: 0, idx: 0, pos: 0.5, spacing_to_next: 0.63, item: "CuCuCuCu" }],
  ejectors: [],
  underground: [],
  pending: [],
  pathCount: 1,
  truncatedPaths: false,
  paths: [{ cells: [[-6, 5]], itemsOnPath: 1, spacingToFirstItem: 0.5, boundAcceptor: [0, 4] }],
  counts: { belts: 1, ejectors: 0, pending: 0 },
};

const MOCK_WORLD = {
  seed: 43391,
  game_version: "1.5.6",
  hub: { x: -2, y: -2, w: 4, h: 4, rotation: 0, uid: 1 },
};

const MOCK_RESOURCES = {
  region: [-40, -40, 40, 40],
  total_resource_tiles: 22,
  resources: [
    { key: "RuRuRuRu", count: 22, bbox: [-30, 12, -20, 20], runs: [{ y: 20, from: -30, to: -20, len: 11 }] },
  ],
};

// ---------------------------------------------------------------------------
// Mock bridge (§11.1 surface only, fixed results).
// ---------------------------------------------------------------------------

function startMockBridge() {
  const received = []; // every parsed POST /rpc request
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (obj, code = 200) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      if (req.method === "GET" && req.url === "/health") {
        return send({ ok: true, mod_connected: true, uptime_s: 42 });
      }
      if (req.method === "GET" && req.url === "/status") {
        return send(MOCK_STATUS);
      }
      if (req.method === "POST" && req.url === "/rpc") {
        let rpc;
        try {
          rpc = JSON.parse(body);
        } catch {
          return send({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          });
        }
        received.push(rpc);
        const { id, method, params } = rpc;
        const ok = (result) => send({ jsonrpc: "2.0", id, result });
        const err = (code, message, data) =>
          send({ jsonrpc: "2.0", id, error: { code, message, data } });
        switch (method) {
          case "obs":
            return ok(MOCK_OBS);
          case "production":
            return ok(MOCK_PRODUCTION);
          case "debug_items":
            if (!params || !Array.isArray(params.region) || params.region.length !== 4) {
              return err(2001, "invalid_action", "region must be [x0,y0,x1,y1]", {
                code_name: "invalid_action",
                detail: "region must be [x0,y0,x1,y1]",
              });
            }
            return ok(MOCK_ITEMS);
          case "world_info":
            return ok(MOCK_WORLD);
          case "resources":
            return ok(MOCK_RESOURCES);
          case "act": {
            const op = params && params.op;
            if (op === "delete") {
              return err(2002, "cannot delete: no building at position", {
                code_name: "game_rejected",
                detail: { x: params.x, y: params.y, reason: "no_building" },
                hint: "the tile is empty; check coordinates with shapez_observe",
              });
            }
            if (op === "place" && params.x === 3 && params.y === 4) {
              // Occupied tile: the mod reports the occupant in its hint prose.
              return err(2002, "cannot place belt at (3,4)", {
                code_name: "game_rejected",
                detail: "Tile occupied by hub (uid 4127, rot 0)",
              });
            }
            if (op === "place" && params.x === 9 && params.y === 9) {
              return err(2002, "cannot place belt at (9,9)", {
                code_name: "game_rejected",
                detail: "Tile occupied by belt (uid 4128, rot 0)",
              });
            }
            if (op === "place" && params.x === 8 && params.y === 8) {
              // Mod-side hard failure used by the batch tests.
              return err(2002, "cannot place belt at (8,8)", {
                code_name: "game_rejected",
                detail: "Tile occupied by belt (uid 4129, rot 0)",
              });
            }
            if (op === "place" && params.x === 7 && params.y === 7) {
              // Non-fatal per PROTOCOL.md: batch must keep going.
              return err(2005, "await exceeded the bridge's budget", {
                code_name: "await_timeout",
                hint: "Not an error state: raise timeout_ticks",
              });
            }
            if (op === "export_blueprint") {
              return ok({ ok: true, op: "export_blueprint", text: MOCK_BLUEPRINT });
            }
            return ok({
              ok: true,
              op,
              applied: 1,
              entity_uid: 10002,
              tick: 20654.28,
            });
          }
          case "batch":
            return ok({
              results: (params && params.actions ? params.actions : []).map(
                (a) => ({ ok: true, op: a && a.op }),
              ),
            });
          case "screenshot":
            return ok({ png_base64: PNG_1X1, w: 1, h: 1 });
          case "snapshot_save":
            return ok({
              name: (params && params.name) || "auto-123",
              path: `snapshots/${(params && params.name) || "auto-123"}.bin`,
              internal_id: "internal-1",
              level: 10,
            });
          case "snapshot_load":
            return ok({ ok: true });
          default:
            return err(-32601, `Method not found: ${method}`, {
              code_name: "method_not_found",
            });
        }
      }
      send({ error: "not found" }, 404);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, received });
    });
  });
}

function lastReceived(mock, method) {
  for (let i = mock.received.length - 1; i >= 0; i--) {
    if (mock.received[i].method === method) return mock.received[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// MCP child-process driver.
// ---------------------------------------------------------------------------

function startServer(args, env) {
  const child = spawn(process.execPath, [SERVER_PATH, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : process.env,
  });
  const reader = new LineReader(child.stdout);
  let stderrBuf = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => (stderrBuf += c));
  return {
    child,
    reader,
    get stderr() {
      return stderrBuf;
    },
  };
}

function waitExit(proc, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (proc.exitCode !== null) return resolve(proc.exitCode);
    const t = setTimeout(() => {
      proc.kill();
      reject(new Error("child did not exit in time"));
    }, timeoutMs);
    proc.once("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

async function run() {
  const strays = [];
  let nextId = 1;

  // --- mock bridge + server under test ------------------------------------
  const mock = await startMockBridge();
  const bridgeUrl = `http://127.0.0.1:${mock.port}`;
  const srv = startServer(["--url", bridgeUrl]);

  async function rpc(method, params) {
    const id = nextId++;
    const req = { jsonrpc: "2.0", id, method };
    if (params !== undefined) req.params = params;
    srv.child.stdin.write(JSON.stringify(req) + "\n");
    for (let i = 0; i < 10; i++) {
      const line = await srv.reader.next(8000);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        strays.push(line);
        continue;
      }
      if (msg && msg.id === id) return msg;
      strays.push(msg);
    }
    throw new Error(`no response for id ${id} (method ${method})`);
  }

  function parseToolText(msg) {
    const content = msg && msg.result && msg.result.content;
    if (!Array.isArray(content)) return null;
    const block = content.find((b) => b && b.type === "text");
    if (!block || typeof block.text !== "string") return null;
    try {
      return JSON.parse(block.text);
    } catch {
      return null;
    }
  }

  // --- 1. initialize: supported version is echoed --------------------------
  let r = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "selftest", version: "0" },
  });
  check("initialize: response id is echoed (1)", r.id === 1, JSON.stringify(r.id));
  check(
    "initialize: protocolVersion echoed (2025-06-18)",
    r.result && r.result.protocolVersion === "2025-06-18",
    r.result && r.result.protocolVersion,
  );
  check(
    "initialize: capabilities.tools.listChanged === false",
    r.result &&
      r.result.capabilities &&
      r.result.capabilities.tools &&
      r.result.capabilities.tools.listChanged === false,
  );
  check(
    "initialize: serverInfo name/version",
    r.result &&
      r.result.serverInfo &&
      r.result.serverInfo.name === "shapez-ai-bridge" &&
      r.result.serverInfo.version === "0.1.0",
    JSON.stringify(r.result && r.result.serverInfo),
  );

  // --- 1b. initialize: version negotiation --------------------------------
  r = await rpc("initialize", { protocolVersion: "2024-11-05" });
  check(
    "initialize: 2024-11-05 echoed",
    r.result && r.result.protocolVersion === "2024-11-05",
    r.result && r.result.protocolVersion,
  );
  r = await rpc("initialize", { protocolVersion: "1999-01-01" });
  check(
    "initialize: unsupported version → highest supported (2025-06-18)",
    r.result && r.result.protocolVersion === "2025-06-18",
    r.result && r.result.protocolVersion,
  );

  // --- 2. notifications/initialized → silence -----------------------------
  srv.child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );
  await sleep(300);
  check(
    "notifications/initialized: no stdout output within 300ms",
    srv.reader.queue.length === 0 && srv.reader.pending.length === 0,
    `queue=${srv.reader.queue.length} pending=${srv.reader.pending.length}`,
  );

  // --- 3. tools/list -------------------------------------------------------
  r = await rpc("tools/list");
  const toolNames = ((r.result && r.result.tools) || []).map((t) => t.name).sort();
  const expectedNames = [
    "shapez_action",
    "shapez_batch",
    "shapez_blueprint",
    "shapez_items",
    "shapez_load",
    "shapez_observe",
    "shapez_production",
    "shapez_resources",
    "shapez_save",
    "shapez_screenshot",
    "shapez_status",
    "shapez_world",
  ].sort();
  check(
    "tools/list: exactly 12 tools with expected names",
    JSON.stringify(toolNames) === JSON.stringify(expectedNames),
    toolNames.join(","),
  );
  check(
    "tools/list: every tool has an object inputSchema",
    ((r.result && r.result.tools) || []).every(
      (t) => t.inputSchema && t.inputSchema.type === "object",
    ),
  );

  // --- 4. ping -------------------------------------------------------------
  r = await rpc("ping");
  check(
    "ping: empty object result",
    r.result && typeof r.result === "object" && Object.keys(r.result).length === 0,
    JSON.stringify(r.result),
  );

  // --- 5. shapez_status (bridge /health + /status) -------------------------
  r = await rpc("tools/call", { name: "shapez_status", arguments: {} });
  const statusOut = parseToolText(r);
  check("shapez_status: no isError", r.result && r.result.isError !== true);
  check(
    "shapez_status: bridge health included (ok, mod_connected)",
    statusOut &&
      statusOut.bridge &&
      statusOut.bridge.health &&
      statusOut.bridge.health.ok === true &&
      statusOut.bridge.health.mod_connected === true,
  );
  check(
    "shapez_status: status payload from bridge /status",
    statusOut &&
      statusOut.status &&
      statusOut.status.in_game === true &&
      statusOut.status.tick === 123.45,
  );

  // --- 6. shapez_observe ---------------------------------------------------
  r = await rpc("tools/call", {
    name: "shapez_observe",
    arguments: { region: [0, 0, 10, 10], max_entities: 50, include_hub: true },
  });
  const obsOut = parseToolText(r);
  check(
    "shapez_observe: Observation returned",
    obsOut && obsOut.tick === 123.45 && Array.isArray(obsOut.entities),
  );
  const obsReq = lastReceived(mock, "obs");
  check(
    "shapez_observe: region/max_entities/include_hub forwarded",
    obsReq &&
      JSON.stringify(obsReq.params.region) === "[0,0,10,10]" &&
      obsReq.params.max_entities === 50 &&
      obsReq.params.include_hub === true,
    obsReq && JSON.stringify(obsReq.params),
  );

  // --- 6b. shapez_observe response_format --------------------------------
  {
    const detailed = await rpc("tools/call", {
      name: "shapez_observe",
      arguments: {},
    });
    const dOut = parseToolText(detailed);
    const dEnt = dOut && dOut.entities && dOut.entities[0];
    check(
      "observe detailed (default): entity keeps variant/code/layer",
      dEnt &&
        dEnt.variant === "default" &&
        dEnt.code === 7 &&
        dEnt.rotation_variant === 0 &&
        dEnt.layer === "regular",
      dEnt && JSON.stringify(dEnt),
    );
    check(
      "observe detailed: no response_format marker added",
      dOut && dOut.response_format === undefined,
      dOut && JSON.stringify(dOut.response_format),
    );
    check(
      "observe detailed: the mod receives no response_format param",
      lastReceived(mock, "obs") &&
        lastReceived(mock, "obs").params.response_format === undefined,
      lastReceived(mock, "obs") && JSON.stringify(lastReceived(mock, "obs").params),
    );
    {
      const lay = await rpc("tools/call", {
        name: "shapez_observe",
        arguments: { layer: "all", max_resources: 10 },
      });
      check(
        "observe: layer/max_resources forwarded (formerly unexposed reads)",
        parseToolText(lay) &&
          lastReceived(mock, "obs").params.layer === "all" &&
          lastReceived(mock, "obs").params.max_resources === 10,
        lastReceived(mock, "obs") && JSON.stringify(lastReceived(mock, "obs").params),
      );
    }

    const concise = await rpc("tools/call", {
      name: "shapez_observe",
      arguments: { response_format: "concise" },
    });
    const cOut = parseToolText(concise);
    const cEnt = cOut && cOut.entities && cOut.entities[0];
    check(
      "observe concise: entity reduced to {uid,type,x,y,r}",
      cEnt &&
        JSON.stringify(Object.keys(cEnt).sort()) ===
          JSON.stringify(["r", "type", "uid", "x", "y"]),
      cEnt && JSON.stringify(cEnt),
    );
    check(
      "observe concise: rotation r is preserved",
      cEnt && cEnt.r === 90,
      cEnt && cEnt.r,
    );
    check(
      "observe concise: response_format echoed, entity_count/stats kept",
      cOut &&
        cOut.response_format === "concise" &&
        cOut.entity_count === 2 &&
        cOut.stats &&
        cOut.stats.total === 2,
      cOut && JSON.stringify({ f: cOut.response_format, n: cOut.entity_count }),
    );
    // Measure the actual saving on the fixture (detailed vs concise payload).
    const dLen = Buffer.byteLength(JSON.stringify(dOut), "utf8");
    const cLen = Buffer.byteLength(JSON.stringify(cOut), "utf8");
    check(
      "observe concise: payload is smaller than detailed",
      cLen < dLen,
      `detailed=${dLen}B concise=${cLen}B`,
    );
    {
      const dOnly = JSON.stringify(dOut.entities);
      const cOnly = JSON.stringify(cOut.entities);
      // The ~117 B/entity figure in the brief is for the mod's entity object;
      // assert the per-entity envelope really is the small one.
      const dPer = Math.round((dOnly.length - 2) / 2);
      const cPer = Math.round((cOnly.length - 2) / 2);
      check(
        "observe concise: per-entity bytes shrink by at least 40%",
        cPer <= dPer * 0.6,
        `detailed=${dPer}B concise=${cPer}B per entity`,
      );
      check(
        "observe concise: sub-60B per entity",
        cPer < 60,
        `concise=${cPer}B per entity`,
      );
    }

    const bad = await rpc("tools/call", {
      name: "shapez_observe",
      arguments: { response_format: "tiny" },
    });
    check(
      "observe response_format illegal: -32602",
      bad.error && bad.error.code === -32602,
      JSON.stringify(bad.error),
    );
    check(
      "observe response_format illegal: next lists the legal values",
      bad.error &&
        bad.error.data &&
        Array.isArray(bad.error.data.next) &&
        bad.error.data.next.some((s) => /concise.*detailed|detailed.*concise/.test(String(s))),
      bad.error && JSON.stringify(bad.error.data),
    );
  }

  // --- 6c. shapez_production ---------------------------------------------
  {
    const resp = await rpc("tools/call", {
      name: "shapez_production",
      arguments: { slices: 3 },
    });
    const out = parseToolText(resp);
    const req = lastReceived(mock, "production");
    check(
      "shapez_production: forwards to `production` with slices",
      req && req.params.slices === 3,
      req && JSON.stringify(req.params),
    );
    check(
      "shapez_production: result carries per-second rates",
      out && out.produced_per_sec && out.produced_per_sec.CuCuCuCu === 2,
      out && JSON.stringify(out && out.produced_per_sec),
    );
    const def = await rpc("tools/call", { name: "shapez_production", arguments: {} });
    check(
      "shapez_production: no args → empty params (mod default 6 slices)",
      lastReceived(mock, "production") &&
        Object.keys(lastReceived(mock, "production").params).length === 0,
      lastReceived(mock, "production") &&
        JSON.stringify(lastReceived(mock, "production").params),
    );
    check(
      "shapez_production: no args still returns a result",
      parseToolText(def) && parseToolText(def).window_seconds === 60,
    );
    const bad = await rpc("tools/call", {
      name: "shapez_production",
      arguments: { slices: 0 },
    });
    check(
      "shapez_production: slices out of range → -32602 with next",
      bad.error &&
        bad.error.code === -32602 &&
        bad.error.data &&
        Array.isArray(bad.error.data.next),
      JSON.stringify(bad.error),
    );
  }

  // --- 6d. shapez_items ---------------------------------------------------
  {
    const resp = await rpc("tools/call", {
      name: "shapez_items",
      arguments: { region: [-10, -10, 10, 10] },
    });
    const out = parseToolText(resp);
    const req = lastReceived(mock, "debug_items");
    check(
      "shapez_items: forwards to `debug_items` with region",
      req && JSON.stringify(req.params.region) === "[-10,-10,10,10]",
      req && JSON.stringify(req.params),
    );
    check(
      "shapez_items: result exposes boundAcceptor per path",
      out &&
        Array.isArray(out.paths) &&
        out.paths[0] &&
        JSON.stringify(out.paths[0].boundAcceptor) === "[0,4]",
      out && JSON.stringify(out && out.paths && out.paths[0]),
    );
    check(
      "shapez_items: belt item + counts present",
      out && out.belts.length === 1 && out.counts && out.counts.belts === 1,
      out && JSON.stringify(out && out.counts),
    );
    check(
      "shapez_items: every result entity has uid-free cell coords",
      out && Array.isArray(out.belts) && Array.isArray(out.belts[0].cell),
    );
    const bad = await rpc("tools/call", {
      name: "shapez_items",
      arguments: {},
    });
    check(
      "shapez_items: missing region → -32602 with next",
      bad.error &&
        bad.error.code === -32602 &&
        bad.error.data &&
        bad.error.data.next.length > 0,
      JSON.stringify(bad.error),
    );
  }

  // --- 6e. shapez_world ---------------------------------------------------
  {
    const resp = await rpc("tools/call", {
      name: "shapez_world",
      arguments: {},
    });
    const out = parseToolText(resp);
    check(
      "shapez_world: seed + hub forwarded from `world_info`",
      out && out.seed === 43391 && out.hub && out.hub.w === 4,
      out && JSON.stringify(out),
    );
    check(
      "shapez_world: sends empty params",
      lastReceived(mock, "world_info") &&
        Object.keys(lastReceived(mock, "world_info").params).length === 0,
      lastReceived(mock, "world_info") &&
        JSON.stringify(lastReceived(mock, "world_info").params),
    );
  }

  // --- 6f. shapez_resources ----------------------------------------------
  {
    const resp = await rpc("tools/call", {
      name: "shapez_resources",
      arguments: {},
    });
    const out = parseToolText(resp);
    check(
      "shapez_resources: default call → empty params (mod default region)",
      lastReceived(mock, "resources") &&
        Object.keys(lastReceived(mock, "resources").params).length === 0,
      lastReceived(mock, "resources") &&
        JSON.stringify(lastReceived(mock, "resources").params),
    );
    check(
      "shapez_resources: aggregated result (count/bbox/runs)",
      out &&
        out.resources[0] &&
        out.resources[0].count === 22 &&
        Array.isArray(out.resources[0].bbox) &&
        Array.isArray(out.resources[0].runs),
      out && JSON.stringify(out && out.resources && out.resources[0]),
    );
    const withRegion = await rpc("tools/call", {
      name: "shapez_resources",
      arguments: { region: [-5, -5, 5, 5] },
    });
    check(
      "shapez_resources: region forwarded",
      parseToolText(withRegion) &&
        JSON.stringify(lastReceived(mock, "resources").params.region) === "[-5,-5,5,5]",
      lastReceived(mock, "resources") &&
        JSON.stringify(lastReceived(mock, "resources").params),
    );
    const tooBig = await rpc("tools/call", {
      name: "shapez_resources",
      arguments: { region: [-300, -300, 300, 300] },
    });
    check(
      "shapez_resources: oversized region → -32602 (40000-tile cap) with next",
      tooBig.error &&
        tooBig.error.code === -32602 &&
        tooBig.error.data &&
        tooBig.error.data.next.length > 0,
      JSON.stringify(tooBig.error),
    );
  }

  // --- 7. shapez_action (happy path, verbatim params) ----------------------
  r = await rpc("tools/call", {
    name: "shapez_action",
    arguments: { op: "place", building: "belt", x: 1, y: 2 },
  });
  const actOut = parseToolText(r);
  check(
    "shapez_action: ActionResult returned",
    actOut && actOut.ok === true && actOut.op === "place",
  );
  const actReq = lastReceived(mock, "act");
  check(
    "shapez_action: op and args forwarded verbatim",
    actReq &&
      actReq.params.op === "place" &&
      actReq.params.building === "belt" &&
      actReq.params.x === 1 &&
      actReq.params.y === 2,
    actReq && JSON.stringify(actReq.params),
  );

  // --- 8. §7 error → isError text with code 2002 ---------------------------
  r = await rpc("tools/call", {
    name: "shapez_action",
    arguments: { op: "delete", x: 0, y: 0 },
  });
  check(
    "shapez_action delete: isError true",
    r.result && r.result.isError === true,
    JSON.stringify(r.result && r.result.isError),
  );
  const errOut = parseToolText(r);
  check("error text carries code 2002", errOut && errOut.code === 2002, errOut && errOut.code);
  check(
    "error text carries code_name and hint",
    errOut &&
      errOut.code_name === "game_rejected" &&
      typeof errOut.hint === "string" &&
      errOut.hint.length > 0,
    errOut && JSON.stringify(errOut),
  );
  check(
    "error text carries a non-empty `next` array",
    errOut && Array.isArray(errOut.next) && errOut.next.length > 0,
    errOut && JSON.stringify(errOut.next),
  );
  check(
    "error text `next` names an actionable next call",
    errOut &&
      errOut.next.some((s) => /shapez_(observe|action)\b|debug_app_state/.test(String(s))),
    errOut && JSON.stringify(errOut.next),
  );

  // --- 9. shapez_batch -----------------------------------------------------
  r = await rpc("tools/call", {
    name: "shapez_batch",
    arguments: { actions: [{ op: "noop" }, { op: "camera", x: 0, y: 0 }] },
  });
  const batchOut = parseToolText(r);
  check(
    "shapez_batch: results array of 2",
    batchOut && Array.isArray(batchOut.results) && batchOut.results.length === 2,
  );
  check(
    "shapez_batch: all-ok batch reports ok:true, stopped:false",
    batchOut &&
      batchOut.ok === true &&
      batchOut.stopped === false &&
      batchOut.executed === 2 &&
      batchOut.requested === 2,
    batchOut && JSON.stringify({ ok: batchOut.ok, stopped: batchOut.stopped }),
  );
  check(
    "shapez_batch: dispatched through `act` (not the bridge's non-fail-fast batch)",
    lastReceived(mock, "batch") === null ||
      lastReceived(mock, "batch").id < lastReceived(mock, "act").id,
    lastReceived(mock, "batch") && lastReceived(mock, "batch").id,
  );

  // --- 9a. unknown tool arguments are rejected, not silently dropped -------
  {
    const bad = await rpc("tools/call", {
      name: "shapez_observe",
      arguments: { maxEntities: 5 },
    });
    check(
      "unknown arg (maxEntities typo): -32602 instead of silent ignore",
      bad.error && bad.error.code === -32602,
      JSON.stringify(bad.error),
    );
    check(
      "unknown arg: error names the offending key and the legal ones",
      bad.error &&
        bad.error.data &&
        Array.isArray(bad.error.data.next) &&
        /maxEntities/.test(bad.error.message) &&
        bad.error.data.next.some((s) => /max_entities/.test(String(s))),
      JSON.stringify(bad.error),
    );
    const ok = await rpc("tools/call", {
      name: "shapez_action",
      arguments: { op: "place", building: "belt", x: 1, y: 2, r: 0 },
    });
    check(
      "shapez_action permits extra op-specific fields (additionalProperties:true)",
      ok.result && ok.result.isError !== true,
    );
  }

  // --- 9b. shapez_batch fail-fast: stops at the first error ----------------
  {
    const before = mock.received.length;
    const resp = await rpc("tools/call", {
      name: "shapez_batch",
      arguments: {
        actions: [
          { op: "noop" },
          { op: "place", building: "belt", x: 8, y: 8 },
          { op: "camera", x: 1, y: 1 },
          { op: "noop" },
        ],
      },
    });
    const out = parseToolText(resp);
    check(
      "shapez_batch fail-fast: stops after the failing action (2 executed of 4)",
      out && out.executed === 2 && out.requested === 4 && out.stopped === true,
      out && JSON.stringify({ executed: out.executed, stopped: out.stopped }),
    );
    check(
      "shapez_batch fail-fast: ok:false, failed_at/failed_op identify the failure",
      out && out.ok === false && out.failed_at === 1 && out.failed_op === "place",
      out && JSON.stringify({ ok: out.ok, failed_at: out.failed_at }),
    );
    check(
      "shapez_batch fail-fast: not_executed lists the 2 skipped actions",
      out &&
        Array.isArray(out.not_executed) &&
        out.not_executed.length === 2 &&
        out.not_executed[0].index === 2 &&
        out.not_executed[0].op === "camera" &&
        out.not_executed[1].index === 3,
      out && JSON.stringify(out.not_executed),
    );
    check(
      "shapez_batch fail-fast: failing result carries its own `next`",
      out &&
        out.results[1] &&
        out.results[1].error &&
        Array.isArray(out.results[1].error.next) &&
        out.results[1].error.next.length > 0,
      out && JSON.stringify(out.results[1] && out.results[1].error),
    );
    check(
      "shapez_batch fail-fast: only 2 act calls hit the bridge",
      mock.received.slice(before).filter((m) => m.method === "act").length === 2,
      String(mock.received.slice(before).filter((m) => m.method === "act").length),
    );
  }

  // --- 9c. shapez_batch: await_timeout (2005) is not fatal -----------------
  {
    const resp = await rpc("tools/call", {
      name: "shapez_batch",
      arguments: {
        actions: [
          { op: "place", x: 7, y: 7 },
          { op: "noop" },
        ],
      },
    });
    const out = parseToolText(resp);
    check(
      "shapez_batch: 2005 await_timeout does not stop the run",
      out &&
        out.stopped === false &&
        out.executed === 2 &&
        out.ok === false &&
        out.failed === 1,
      out && JSON.stringify({ stopped: out.stopped, executed: out.executed, ok: out.ok }),
    );
  }

  // --- 9d. shapez_batch: continue_on_error:true keeps old semantics --------
  {
    const resp = await rpc("tools/call", {
      name: "shapez_batch",
      arguments: {
        actions: [
          { op: "place", x: 8, y: 8 },
          { op: "noop" },
          { op: "camera", x: 2, y: 2 },
        ],
        continue_on_error: true,
      },
    });
    const out = parseToolText(resp);
    check(
      "shapez_batch continue_on_error: runs all 3, not_executed absent",
      out &&
        out.executed === 3 &&
        out.stopped === false &&
        out.not_executed === undefined &&
        out.failed === 1,
      out && JSON.stringify({ executed: out.executed, failed: out.failed }),
    );
  }

  // --- 9e. shapez_batch: malformed action → -32602 with legal ops ----------
  {
    const resp = await rpc("tools/call", {
      name: "shapez_batch",
      arguments: { actions: [{ op: "noop" }, { nope: 1 }] },
    });
    check(
      "shapez_batch malformed action: -32602",
      resp.error && resp.error.code === -32602,
      JSON.stringify(resp.error),
    );
    check(
      "shapez_batch malformed action: error.data.next lists legal ops",
      resp.error &&
        resp.error.data &&
        Array.isArray(resp.error.data.next) &&
        resp.error.data.next.some((s) => /legal ops: .*place/.test(String(s))),
      resp.error && JSON.stringify(resp.error.data),
    );
  }

  // --- 9f. occupied tile → blocker-like `next` names the occupant ---------
  {
    const resp = await rpc("tools/call", {
      name: "shapez_action",
      arguments: { op: "place", building: "belt", x: 9, y: 9 },
    });
    const out = parseToolText(resp);
    const joined = out && Array.isArray(out.next) ? out.next.join(" | ") : "";
    check(
      "occupied tile: `next` names the occupant (type + uid)",
      /belt/.test(joined) && /4128/.test(joined),
      joined,
    );
    check(
      "occupied tile: `next` offers delete at the parsed coordinates",
      /op:'delete', x:9, y:9/.test(joined),
      joined,
    );
    check(
      "occupied tile: blocker is structured {uid,type,removable,x,y}",
      out &&
        out.blocker &&
        out.blocker.uid === 4128 &&
        out.blocker.type === "belt" &&
        out.blocker.removable === true &&
        out.blocker.x === 9 &&
        out.blocker.y === 9,
      out && JSON.stringify(out.blocker),
    );
    check(
      "occupied tile: `next` includes the inspect-region call",
      /shapez_observe/.test(joined),
      joined,
    );
  }

  // --- 9g. non-removable blocker (hub) → no delete suggestion --------------
  {
    const resp = await rpc("tools/call", {
      name: "shapez_action",
      arguments: { op: "place", building: "belt", x: 3, y: 4 },
    });
    const out = parseToolText(resp);
    const joined = out && Array.isArray(out.next) ? out.next.join(" | ") : "";
    check(
      "hub blocker: removable=false and no delete suggestion",
      out &&
        out.blocker &&
        out.blocker.removable === false &&
        !/op:'delete'/.test(joined),
      joined,
    );
  }

  // --- 9h. 1003 not_in_game → next points at debug_app_state ---------------
  {
    // A second mock bridge that reports the mod as "not in game".
    const notInGame = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const q = JSON.parse(body || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: q.id,
            error: {
              code: 1003,
              message: "not in game",
              data: { code_name: "not_in_game", detail: "no root" },
            },
          }),
        );
      });
    });
    await new Promise((res) => notInGame.listen(0, "127.0.0.1", res));
    const srv2 = startServer(["--url", `http://127.0.0.1:${notInGame.address().port}`]);
    try {
      srv2.child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "shapez_world", arguments: {} },
        }) + "\n",
      );
      const line = await srv2.reader.next(8000);
      const msg = JSON.parse(line);
      const text =
        msg.result && msg.result.content && msg.result.content[0] && msg.result.content[0].text;
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {}
      check(
        "1003 not_in_game: isError with `next` naming shapez_status",
        msg.result &&
          msg.result.isError === true &&
          parsed &&
          Array.isArray(parsed.next) &&
          parsed.next.some((s) => /shapez_status/.test(String(s))),
        parsed && JSON.stringify(parsed.next),
      );
      srv2.child.stdin.end();
      await waitExit(srv2.child, 5000);
    } finally {
      if (srv2.child.exitCode === null) srv2.child.kill();
      notInGame.close();
    }
  }

  // --- 10. shapez_screenshot → MCP image content ---------------------------
  r = await rpc("tools/call", {
    name: "shapez_screenshot",
    arguments: { scale: 0.5 },
  });
  const blocks = (r.result && r.result.content) || [];
  const img = blocks.find((b) => b && b.type === "image");
  const cap = blocks.find((b) => b && b.type === "text");
  check(
    "shapez_screenshot: image content with png_base64 + mimeType",
    img && img.data === PNG_1X1 && img.mimeType === "image/png",
  );
  check(
    "shapez_screenshot: returned image is a valid PNG",
    img &&
      Buffer.from(img.data, "base64").subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
  );
  check(
    "shapez_screenshot: caption text mentions dimensions",
    cap && /1\s*x\s*1/.test(cap.text),
    cap && cap.text,
  );
  const shotReq = lastReceived(mock, "screenshot");
  check(
    "shapez_screenshot: scale forwarded",
    shotReq && shotReq.params.scale === 0.5,
    shotReq && JSON.stringify(shotReq.params),
  );

  // --- 11. shapez_blueprint export → raw string ----------------------------
  r = await rpc("tools/call", {
    name: "shapez_blueprint",
    arguments: { mode: "export", region: [0, 0, 5, 5] },
  });
  const bpText = r.result && r.result.content && r.result.content[0] && r.result.content[0].text;
  check(
    "shapez_blueprint export: returns the blueprint string as text",
    bpText === MOCK_BLUEPRINT,
    bpText,
  );
  const expReq = lastReceived(mock, "act");
  check(
    "shapez_blueprint export: act export_blueprint {region} forwarded",
    expReq &&
      expReq.params.op === "export_blueprint" &&
      JSON.stringify(expReq.params.region) === "[0,0,5,5]",
    expReq && JSON.stringify(expReq.params),
  );

  // --- 12. shapez_blueprint paste ------------------------------------------
  r = await rpc("tools/call", {
    name: "shapez_blueprint",
    arguments: { mode: "paste", text: MOCK_BLUEPRINT, x: 3, y: 4, charge: false },
  });
  const pasteOut = parseToolText(r);
  check("shapez_blueprint paste: ActionResult ok", pasteOut && pasteOut.ok === true);
  const pasteReq = lastReceived(mock, "act");
  check(
    "shapez_blueprint paste: text/x/y/charge forwarded",
    pasteReq &&
      pasteReq.params.op === "paste_blueprint" &&
      pasteReq.params.text === MOCK_BLUEPRINT &&
      pasteReq.params.x === 3 &&
      pasteReq.params.y === 4 &&
      pasteReq.params.charge === false,
    pasteReq && JSON.stringify(pasteReq.params),
  );

  // --- 13. shapez_blueprint invalid mode → -32602 --------------------------
  r = await rpc("tools/call", {
    name: "shapez_blueprint",
    arguments: { mode: "wat" },
  });
  check(
    "shapez_blueprint invalid mode: -32602 protocol error",
    r.error && r.error.code === -32602 && r.result === undefined,
    JSON.stringify(r.error),
  );

  // --- 14. shapez_save / shapez_load ---------------------------------------
  r = await rpc("tools/call", {
    name: "shapez_save",
    arguments: { name: "snap-t1" },
  });
  check(
    "shapez_save: snapshot result, name forwarded",
    parseToolText(r) &&
      parseToolText(r).name === "snap-t1" &&
      lastReceived(mock, "snapshot_save") &&
      lastReceived(mock, "snapshot_save").params.name === "snap-t1",
  );
  r = await rpc("tools/call", {
    name: "shapez_load",
    arguments: { name: "snap-t1" },
  });
  check(
    "shapez_load: ok, name forwarded",
    parseToolText(r) &&
      parseToolText(r).ok === true &&
      lastReceived(mock, "snapshot_load") &&
      lastReceived(mock, "snapshot_load").params.name === "snap-t1",
  );

  // --- 15. unknown tool → -32601 -------------------------------------------
  r = await rpc("tools/call", { name: "shapez_nope", arguments: {} });
  check(
    "unknown tool: -32601",
    r.error && r.error.code === -32601,
    JSON.stringify(r.error),
  );

  // --- 16. unknown method → -32601 -----------------------------------------
  r = await rpc("totally/unknown");
  check(
    "unknown method: -32601",
    r.error && r.error.code === -32601,
    JSON.stringify(r.error),
  );

  // --- 17. malformed JSON line → -32700 with null id -----------------------
  srv.child.stdin.write("{this is not json\n");
  {
    const line = await srv.reader.next(3000);
    let pe = null;
    try {
      pe = JSON.parse(line);
    } catch {}
    check(
      "malformed line: -32700 with id null",
      pe && pe.error && pe.error.code === -32700 && pe.id === null,
      line,
    );
  }

  // --- 18. logs go to stderr, not stdout -----------------------------------
  check("stderr received log output", srv.stderr.length > 0);

  // --- 18b. string id is echoed verbatim -----------------------------------
  {
    srv.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: "str-id-7", method: "ping" }) + "\n",
    );
    const line = await srv.reader.next(5000);
    const msg = JSON.parse(line);
    check(
      "string id echoed verbatim",
      msg.id === "str-id-7" && msg.result && typeof msg.result === "object",
      line,
    );
  }

  // --- 18c. unknown notification → silence ---------------------------------
  {
    const before = srv.reader.all.length;
    srv.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/whatever" }) + "\n",
    );
    await sleep(300);
    check(
      "unknown notification: no stdout output within 300ms",
      srv.reader.all.length === before,
      `new lines=${srv.reader.all.length - before}`,
    );
  }

  // --- 18d. shapez_observe with no arguments -------------------------------
  {
    const resp = await rpc("tools/call", { name: "shapez_observe", arguments: {} });
    const out = parseToolText(resp);
    const req = lastReceived(mock, "obs");
    check(
      "shapez_observe {}: forwards empty params, returns Observation",
      out && out.in_game === true && req && Object.keys(req.params).length === 0,
      req && JSON.stringify(req.params),
    );
  }

  // --- 18e. Authorization token forwarded when configured ------------------
  {
    let sawAuthHeader = null;
    const authProbe = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        sawAuthHeader = req.headers["authorization"] || null;
        const rpcReq = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: rpcReq.id, result: { ok: true } }),
        );
      });
    });
    await new Promise((resolve) => authProbe.listen(0, "127.0.0.1", resolve));
    const authPort = authProbe.address().port;
    const authSrv = startServer(
      ["--url", `http://127.0.0.1:${authPort}`, "--token", "sekret-token"],
    );
    try {
      authSrv.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n",
      );
      await authSrv.reader.next(5000);
      authSrv.child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "shapez_save", arguments: {} },
        }) + "\n",
      );
      await authSrv.reader.next(5000);
      check(
        "--token: Authorization Bearer header sent to bridge",
        sawAuthHeader === "Bearer sekret-token",
        String(sawAuthHeader),
      );
      authSrv.child.stdin.end();
      await waitExit(authSrv.child, 5000);
    } finally {
      if (authSrv.child.exitCode === null) authSrv.child.kill();
      authProbe.close();
    }
  }

  // --- 19. every stdout line is valid JSON ---------------------------------
  {
    let allOk = true;
    let badLine = null;
    for (const line of srv.reader.all) {
      if (line.trim() === "") {
        allOk = false;
        badLine = "<empty line>";
        break;
      }
      try {
        JSON.parse(line);
      } catch {
        allOk = false;
        badLine = line;
        break;
      }
    }
    check(
      `all ${srv.reader.all.length} stdout lines are valid JSON`,
      allOk,
      badLine,
    );
  }

  // --- 20. no stray/out-of-order messages ----------------------------------
  check("no stray responses observed", strays.length === 0, JSON.stringify(strays.slice(0, 2)));

  // --- 21. stdin EOF → graceful exit 0 -------------------------------------
  {
    const exitCode = await (async () => {
      srv.child.stdin.end();
      return waitExit(srv.child, 5000);
    })();
    check("stdin EOF → exit code 0", exitCode === 0, `exit=${exitCode}`);
  }

  // --- 22. bridge down → isError with startup hint (env var config) --------
  {
    // Use a port we know is closed: bind, capture, close.
    const closedPort = await (async () => {
      const s = http.createServer(() => {});
      await new Promise((res) => s.listen(0, "127.0.0.1", res));
      const p = s.address().port;
      await new Promise((res) => s.close(res));
      return p;
    })();
    const dead = startServer([], {
      SHAPEZ_BRIDGE_URL: `http://127.0.0.1:${closedPort}`,
    });
    try {
      dead.child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        }) + "\n",
      );
      let line = await dead.reader.next(8000);
      let msg = JSON.parse(line);
      check(
        "bridge-down server: initialize still answers",
        msg.id === 1 && msg.result && msg.result.protocolVersion === "2025-06-18",
      );
      dead.child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "shapez_status", arguments: {} },
        }) + "\n",
      );
      line = await dead.reader.next(8000);
      msg = JSON.parse(line);
      const deadText =
        msg.result &&
        msg.result.content &&
        msg.result.content[0] &&
        msg.result.content[0].text;
      check(
        "bridge down: shapez_status isError true",
        msg.result && msg.result.isError === true,
        JSON.stringify(msg.result),
      );
      check(
        "bridge down: text explains how to start the bridge",
        typeof deadText === "string" &&
          deadText.includes("bridge.mjs") &&
          /not running|not reachable/i.test(deadText),
        deadText,
      );
      dead.child.stdin.end();
      const deadExit = await waitExit(dead.child, 5000);
      check("bridge-down server: EOF → exit 0", deadExit === 0, `exit=${deadExit}`);
    } finally {
      if (dead.child.exitCode === null) dead.child.kill();
    }
  }

  // --- cleanup --------------------------------------------------------------
  mock.server.close();
  if (srv.child.exitCode === null) srv.child.kill();
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

console.log("shapez-ai-bridge MCP selftest");
console.log("──────────────────────────────");

const watchdog = setTimeout(() => {
  console.error("selftest watchdog: timed out after 60s");
  process.exit(1);
}, 60_000);
watchdog.unref();

try {
  await run();
} catch (err) {
  failed++;
  failures.push("selftest crashed: " + (err && err.stack ? err.stack : err));
  console.error("selftest crashed:", err);
}

console.log("──────────────────────────────");
console.log(`summary: ${passed} PASS, ${failed} FAIL (${passed + failed} total)`);
if (failed > 0) {
  console.log("failures:");
  for (const f of failures) console.log("  - " + f);
}
process.exit(failed === 0 ? 0 : 1);
