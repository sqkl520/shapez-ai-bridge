/**
 * 验证无头驱动：窗口不可见时游戏逻辑是否还在前进。
 *
 * 用法：node tools/verify-headless.mjs [--force]
 *
 * --force 会让 mod 无条件接管（不管窗口可见性），用于无头批处理场景。
 *
 * 判据：连续采样 tick，10 秒内应前进 ~600（regular 速度约 60 tick/s）。
 * 前进 0 = 主线程死锁；前进个位数 = 严重节流。
 */
const BASE = "http://127.0.0.1:7777/rpc";
const force = process.argv.includes("--force");

let seq = 1;
async function rpc(method, params = {}, timeoutMs = 20000) {
    const res = await fetch(BASE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: seq++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log("=== 1. 桥与 mod 状态 ===");
try {
    const st = await rpc("status");
    console.log(`  in_game=${st.in_game} paused=${st.paused} speed=${st.speed} L${st.hub_level} tick=${Math.round(st.tick)}`);
} catch (e) {
    console.error("  ✗ status 失败：" + e.message);
    process.exit(1);
}

console.log("\n=== 2. 无头驱动状态 ===");
try {
    const hs = await rpc("act", { op: "headless_status" });
    console.log("  " + JSON.stringify(hs));
} catch (e) {
    console.log("  读不到（mod 可能还是旧版，需要重载游戏）：" + e.message.slice(0, 100));
}

if (force) {
    console.log("\n=== 2b. 强制接管 ===");
    try {
        const en = await rpc("act", { op: "headless_enable", force: true });
        console.log("  " + JSON.stringify(en));
    } catch (e) {
        console.log("  失败：" + e.message.slice(0, 120));
    }
}

console.log("\n=== 3. tick 前进速率（3 次采样，每次 10 秒）===");
const samples = [];
for (let i = 1; i <= 3; i++) {
    const a = (await rpc("status")).tick;
    await sleep(10000);
    const b = (await rpc("status")).tick;
    const adv = Math.round(b - a);
    samples.push(adv);
    const verdict = adv === 0 ? "✗ 完全卡死" : adv < 100 ? "✗ 严重节流" : adv < 400 ? "△ 偏慢" : "✓ 正常";
    console.log(`  第 ${i} 次：10 秒 +${adv} tick  ${verdict}`);
}

console.log("\n=== 4. 能否读世界（obs）===");
try {
    const t0 = Date.now();
    const o = await rpc("obs", { region: [-60, -60, 60, 60] }, 30000);
    console.log(`  ✓ obs 可用（${o.entities.length} 实体，${Date.now() - t0}ms）`);
} catch (e) {
    console.log(`  ✗ obs 失败：${e.message.slice(0, 120)}`);
}

const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
console.log(`\n平均 ${Math.round(avg)} tick/10s （正常 ~600）`);
process.exitCode = avg >= 400 ? 0 : 1;
