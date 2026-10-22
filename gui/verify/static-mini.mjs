/**
 * static-mini.mjs — T5 用最小静态服务器（仅为在 T2 server.mjs 未就绪时做 A 组预检）。
 * 只服务 gui/ui/ 目录；不做 token/origin 校验（那不是本工具职责）。
 * 用法: node gui/verify/static-mini.mjs [--port 7806]
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(here, "..", "ui");
const args = process.argv.slice(2);
const i = args.indexOf("--port");
const PORT = parseInt(i >= 0 ? args[i + 1] : "7806", 10);

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
};

http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    if (p === "/") p = "/index.html";
    const abs = path.normalize(path.join(UI_DIR, p));
    if (!abs.startsWith(UI_DIR)) { res.writeHead(403); res.end("forbidden"); return; }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(abs).pipe(res);
}).listen(PORT, "127.0.0.1", () => {
    console.log(`[static-mini] serving ${UI_DIR} at http://127.0.0.1:${PORT}/`);
});
