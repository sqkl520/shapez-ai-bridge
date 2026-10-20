#!/usr/bin/env node
/**
 * 实机验证用的最小桥接（与 src/bridge/bridge.mjs 独立，专供 test 流程）。
 *
 * 目的：在正式桥接尚在开发时，提供一个「够用即可」的 WS 服务端给游戏 mod 连接，
 * 支持：hello 握手、status/obs/act/batch RPC 转发、命令行交互。
 *
 * 手写 RFC6455（服务端侧）：只实现本场景需要的子集——
 * - upgrade 握手（/mod 路径）
 * - 解析客户端帧（带掩码；只处理 text/close/ping）
 * - 写出不掩码的 text 帧（支持 64bit 长度）
 *
 * 用法：node test/live_bridge.mjs [--port 7777]
 * 交互：输入 JSON 行 = 作为 RPC 请求发给 mod；空行打印状态。
 */
import http from "node:http";
import crypto from "node:crypto";
import readline from "node:readline";

const args = process.argv.slice(2);
function argVal(name, dflt) {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const PORT = parseInt(argVal("--port", "7777"), 10);

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** 已连接的 mod socket 状态 */
let mod = null;

const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, mod_connected: !!mod, uptime_s: Math.round(process.uptime()) }));
        return;
    }
    if (req.method === "GET" && req.url === "/status") {
        res.writeHead(200, { "content-type": "application/json" });
        if (!mod) {
            res.end(JSON.stringify({ error: { code: 1005, message: "no mod connected" } }));
            return;
        }
        rpcAsync("status", {})
            .then(r => res.end(JSON.stringify(r)))
            .catch(e => res.end(JSON.stringify({ error: { code: 2003, message: String(e) } })));
        return;
    }
    if (req.method === "POST" && req.url === "/rpc") {
        // 将 HTTP JSON-RPC 请求翻译为 WS RPC，并把响应写回 HTTP（与正式 bridge 行为一致）
        let body = "";
        req.on("data", d => (body += d));
        req.on("end", () => {
            let rpcReq;
            try {
                rpcReq = JSON.parse(body);
            } catch (e) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
                return;
            }
            if (!mod) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: rpcReq.id,
                        error: { code: 1005, message: "no_connection: no mod connected", data: { code_name: "no_connection", detail: "start the game" } },
                    })
                );
                return;
            }
            rpcAsync(rpcReq.method, rpcReq.params || {})
                .then(result => {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcReq.id, result }));
                })
                .catch(err => {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcReq.id, error: err }));
                });
        });
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mod_connected: !!mod }));
});

/** Promise 版 RPC（供 HTTP 转发用；与交互模式共用下一层 WS 写出） */
const httpPending = new Map();
function rpcAsync(method, params) {
    return new Promise((resolve, reject) => {
        if (!mod) return reject({ code: 1005, message: "no_connection" });
        const id = nextId++;
        httpPending.set(id, { resolve, reject });
        writeFrame(mod.socket, 0x1, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} })));
        setTimeout(() => {
            if (httpPending.has(id)) {
                httpPending.delete(id);
                reject({ code: 2004, message: "timeout" });
            }
        }, 180000);
    });
}

server.on("upgrade", (req, socket, head) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
        socket.destroy();
        return;
    }
    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: " +
            accept +
            "\r\n\r\n"
    );
    log(`mod connected from ${socket.remoteAddress}:${socket.remotePort} path=${req.url}`);
    mod = { socket, buffer: Buffer.alloc(0), fragments: [], fragmentOpcode: 0 };
    socket.on("data", d => onData(mod, d));
    socket.on("close", () => {
        log("mod disconnected");
        if (mod && mod.socket === socket) mod = null;
    });
    socket.on("error", e => log("socket error:", e.message));
    if (head && head.length) onData(mod, head);
});

function log(...a) {
    console.error("[live-bridge]", ...a);
}

// ── 帧解析（客户端 → 服务端：必带掩码）──
function onData(conn, data) {
    conn.buffer = Buffer.concat([conn.buffer, data]);
    for (;;) {
        const buf = conn.buffer;
        if (buf.length < 2) return;
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
        } else if (len === 127) {
            if (buf.length < 10) return;
            const big = buf.readBigUInt64BE(2);
            len = Number(big);
            off = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < off + maskLen + len) return;
        let payload = buf.subarray(off + maskLen, off + maskLen + len);
        if (masked) {
            const mask = buf.subarray(off, off + 4);
            payload = Buffer.from(payload);
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }
        conn.buffer = buf.subarray(off + maskLen + len);

        if (opcode === 0x8) {
            log("close frame from mod");
            conn.socket.end();
            return;
        }
        if (opcode === 0x9) {
            // ping → pong
            writeFrame(conn.socket, 0xa, payload);
            continue;
        }
        if (opcode === 0xa) continue; // pong
        if (opcode === 0x0) {
            conn.fragments.push(payload);
            if (fin) {
                const full = Buffer.concat(conn.fragments);
                conn.fragments = [];
                handleText(conn, full.toString("utf8"));
            }
            continue;
        }
        // text / binary
        if (!fin) {
            conn.fragments = [payload];
            conn.fragmentOpcode = opcode;
            continue;
        }
        if (opcode === 0x1) handleText(conn, payload.toString("utf8"));
    }
}

function handleText(conn, text) {
    let msg;
    try {
        msg = JSON.parse(text);
    } catch (e) {
        log("bad json from mod:", text.slice(0, 200));
        return;
    }
    if (msg.method === "hello") {
        conn.hello = msg.params;
        log("HELLO:", JSON.stringify(msg.params));
        return;
    }
    if (msg.id !== undefined && msg.result !== undefined) {
        pending.delete(msg.id);
        const hp = httpPending.get(msg.id);
        if (hp) {
            httpPending.delete(msg.id);
            hp.resolve(msg.result);
            return;
        }
        log("RESPONSE id=" + msg.id + ":", JSON.stringify(msg.result).slice(0, 4000));
        if (pending.size === 0 && !interactive) maybeExit();
        return;
    }
    if (msg.id !== undefined && msg.error !== undefined) {
        pending.delete(msg.id);
        const hp = httpPending.get(msg.id);
        if (hp) {
            httpPending.delete(msg.id);
            hp.reject(msg.error);
            return;
        }
        log("ERROR id=" + msg.id + ":", JSON.stringify(msg.error));
        if (pending.size === 0 && !interactive) maybeExit();
        return;
    }
    log("unhandled from mod:", text.slice(0, 200));
}

// ── 帧写出（服务端 → 客户端：不掩码）──
function writeFrame(socket, opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    socket.write(Buffer.concat([header, payload]));
}

let nextId = 1;
const pending = new Map();
function rpc(method, params) {
    if (!mod) {
        log("no mod connected");
        return null;
    }
    const id = nextId++;
    pending.set(id, method);
    writeFrame(mod.socket, 0x1, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} })));
    return id;
}

// ── 自动验证脚本模式：node live_bridge.mjs --script obs,status ──
const script = argVal("--script", null);
const interactive = !script;

let scriptSteps = null;
if (script) {
    // 步骤用 ";;" 分隔（JSON 参数里含逗号，不能用逗号）
    scriptSteps = script.split(";;").map(s => s.trim()).filter(Boolean);
}

function maybeExit() {
    if (!scriptSteps) return;
    if (scriptSteps.length === 0) {
        log("script done");
        process.exit(0);
    }
    const step = scriptSteps.shift();
    setTimeout(() => sendStep(step), 200);
}

function sendStep(step) {
    // 支持 wait=N（毫秒）作为纯等待步骤
    const waitMatch = /^wait=(\d+)$/.exec(step);
    if (waitMatch) {
        const ms = parseInt(waitMatch[1], 10);
        log("... waiting " + ms + "ms");
        setTimeout(maybeExit, ms);
        return;
    }
    let method = step;
    let params = {};
    const eq = step.indexOf("=");
    if (eq > 0) {
        method = step.slice(0, eq);
        try {
            params = JSON.parse(step.slice(eq + 1));
        } catch (e) {
            log("bad params json:", step);
            maybeExit();
            return;
        }
    }
    log(">>> " + method + " " + JSON.stringify(params));
    rpc(method, params);
}

server.listen(PORT, "127.0.0.1", () => {
    log(`listening on ws://127.0.0.1:${PORT}/mod`);
    log("start the game now; the mod will connect and send hello");
    if (scriptSteps) {
        log("script mode:", scriptSteps.join(" -> "));
        // 等 mod hello 后开始
        const waitMod = setInterval(() => {
            if (mod && mod.hello) {
                clearInterval(waitMod);
                log("mod ready, running script");
                setTimeout(() => {
                    const s = scriptSteps.shift();
                    sendStep(s);
                }, 300);
            }
        }, 200);
    } else {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        rl.on("line", line => {
            line = line.trim();
            if (!line) {
                log("status:", mod ? "mod connected: " + JSON.stringify(mod.hello) : "no mod");
                return;
            }
            sendStep(line);
        });
        log("interactive: type e.g.  obs  /  act={\"op\":\"noop\"}");
    }
});
