/**
 * verify-concurrent.mjs — 验证「后台 AI 在跑，前台照样能用」。
 *
 * 判据不是「两个进程都能启动」，而是**同时操作时游戏仍然响应**。
 *
 * 做法：
 *   1. 后台持续跑 `background-runner --think`（只读 + 离线算）
 *   2. 前台同时每 500ms 发一个轻量 RPC（status），测响应时间
 *   3. 如果后台读世界会阻塞前台，status 的 p99 延迟会明显升高
 *
 * 通过标准：后台满载时，前台 status 的 p99 < 500ms，且成功率 100%。
 */
import { spawn } from "node:child_process";

const BASE = "http://127.0.0.1:7777/rpc";
let seq = 1;
async function rpc(method, params = {}, timeoutMs = 10000) {
    const t0 = Date.now();
    const res = await fetch(BASE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: seq++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error.message);
    return { result: body.result, ms: Date.now() - t0 };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log("=== 基线：没有后台负载时，前台 RPC 延迟 ===");
const base = [];
for (let i = 0; i < 10; i++) {
    const { ms } = await rpc("status");
    base.push(ms);
}
base.sort((a, b) => a - b);
console.log(`  中位数 ${base[Math.floor(base.length / 2)]}ms  p99 ${base[base.length - 1]}ms`);

console.log("\n=== 启动后台思考（连续 3 轮）===");
const bg = spawn(process.execPath, ["tools/background-runner.mjs", "--loop", "3"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
});
let bgOut = "";
bg.stdout.on("data", d => { bgOut += d.toString(); });
bg.stderr.on("data", d => { bgOut += d.toString(); });

await sleep(1000);   // 让它跑起来

console.log("=== 后台满载时，前台 RPC 延迟 ===");
const loaded = [];
let failures = 0;
for (let i = 0; i < 20; i++) {
    try {
        const { ms } = await rpc("status");
        loaded.push(ms);
    } catch (e) {
        failures += 1;
    }
    await sleep(300);
}
loaded.sort((a, b) => a - b);
const p50 = loaded.length ? loaded[Math.floor(loaded.length / 2)] : null;
const p99 = loaded.length ? loaded[loaded.length - 1] : null;
console.log(`  中位数 ${p50}ms  p99 ${p99}ms  失败 ${failures}/20`);

bg.kill();
console.log("\n=== 后台输出片段 ===");
console.log(bgOut.split("\n").filter(l => l.includes("思考") || l.includes("基线") || l.includes("候选")).slice(0, 8).join("\n"));

console.log("\n=== 判定 ===");
const ok = failures === 0 && p99 !== null && p99 < 500;
console.log(ok
    ? `✓ 后台跑的时候前台照常可用（p99 ${p99}ms < 500ms）`
    : `✗ 不达标：p99=${p99}ms 失败=${failures}`);
process.exitCode = ok ? 0 : 1;
