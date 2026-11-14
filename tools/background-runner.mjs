#!/usr/bin/env node
/**
 * background-runner.mjs — **后台 AI 循环**：不依赖游戏窗口，前台玩也不冲突。
 *
 * ═════════════════════════ 它解决什么问题 ═════════════════════════
 *
 * 用户的要求是两句话：
 *   「后台AI依旧在运行操作」
 *   「前台也一样」
 *
 * 原来的 `loop.mjs` 做不到，因为它的每次决策都要：
 *   1. `reader.obs()` 读游戏世界（RPC，要游戏主线程响应）
 *   2. 预演 → 落盘（RPC tx，更要主线程）
 *   3. `step(ticks)` 推进游戏（直接把主线程占住几秒）
 *
 * 第 3 步是致命的：**AI 一推游戏，用户就没法操作**。而窗口最小化时
 * 第 1/2 步也会因为 rAF 停摆而超时。
 *
 * 本文件的做法是**把「思考」和「落盘」分开**：
 *
 *   · 后台模式（默认）：只读一次世界 → 用 `flow-sim` **离线**评估候选方案
 *     → 把结果写进 `pending/` 队列。**完全不碰游戏**，用户随便玩。
 *   · 前台模式（`--apply`）：消费 `pending/` 队列，逐条 tx 落盘。
 *     这时才需要游戏，且每条之间留间隔，不挡用户操作。
 *
 * 也就是说：AI 在后台想好了要做什么，等你（或前台窗口）方便的时候才动手。
 *
 * ═════════════════════════ 用法 ═════════════════════════
 *
 *   # 后台思考（不需要游戏在跑，用快照）
 *   node tools/background-runner.mjs --think --obs snapshot.json
 *
 *   # 后台思考（从活着的游戏读一次，然后离线算）
 *   node tools/background-runner.mjs --think
 *
 *   # 前台落盘（消费队列）
 *   node tools/background-runner.mjs --apply
 *
 *   # 一直循环（每 N 秒读一次、算一次、写队列）
 *   node tools/background-runner.mjs --loop 30
 *
 * ═════════════════════════ 队列格式 ═════════════════════════
 *
 * `pending/<ts>-<id>.json` = `{ createdAt, ops, reason, expected, obs_hash }`
 * `--apply` 成功一条就移到 `done/`，失败移到 `failed/` 并记原因。
 * 每个 op 带 `obs_hash` —— 世界变了就不落盘（防止用过期决策改世界）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createFlowSim } from "../src/ai/compiler/flow-sim.mjs";
import { connect } from "../src/agent/macros/connect.mjs";
import { removeRun } from "../src/agent/macros/remove.mjs";
import { indexOf, isBelt, hubReachable, exitCellOf, entryCellOf } from "../src/agent/loop/topology.mjs";

const BASE = process.env.SHAPEZ_BRIDGE || "http://127.0.0.1:7777/rpc";
const QUEUE = path.resolve(".bgqueue");
const PENDING = path.join(QUEUE, "pending");
const DONE = path.join(QUEUE, "done");
const FAILED = path.join(QUEUE, "failed");

for (const d of [PENDING, DONE, FAILED]) fs.mkdirSync(d, { recursive: true });

let seq = 1;
const rpc = async (method, params = {}, timeoutMs = 20000) => {
    const res = await fetch(BASE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: seq++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    if (body.error) {
        const e = new Error(body.error.message);
        e.rpc = body.error;
        throw e;
    }
    return body.result;
};

/** 世界指纹：世界变了，旧决策就不该落盘。 */
function hashWorld(obs) {
    const parts = (obs.entities || [])
        .map(e => `${e.uid}:${e.type}:${e.x},${e.y},${e.r || 0},${e.rotation_variant || 0}`)
        .sort();
    return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

/**
 * 离线评估：给当前世界，产出候选决策。
 *
 * **这是整个后台运行的核心** —— 它只读不做，所以可以在任何时刻跑，
 * 不影响前台。产出的每个候选都带 `expected`（预计交付增量），
 * 由 `flow-sim` 算出来。
 */
function think(obs, opts = {}) {
    const idx = indexOf(obs);
    const reach = hubReachable(obs, idx);
    const belts = (obs.entities || []).filter(isBelt);
    const dead = belts.filter(b => !reach.has(b.uid));

    const base = createFlowSim(obs, opts.simOpts).run(opts.simSeconds || 30);

    const candidates = [];

    /* ── 候选类型 1：把死带子的末端接到 hub ──
     *
     * 判据：末端是空地、且这条链有货在流（说明它有源）。
     * 「有源但到不了 hub」= 最值得连的一类。 */
    const hub = (obs.entities || []).find(e => e.type === "hub");
    if (hub) {
        for (const b of dead.slice(0, 20)) {
            const ex = exitCellOf(b);
            if (!ex) continue;
            const t = idx.byCell.get(`${ex[0]},${ex[1]}`);
            if (t) continue;                       // 末端不是空地，不是断头
            /* 这条链有源吗（反向走到底遇到机器） */
            let cur = b, hasSource = false;
            const seen = new Set();
            for (let i = 0; i < 100 && cur; i++) {
                if (seen.has(cur.uid)) break;
                seen.add(cur.uid);
                const en = entryCellOf(cur);
                const u = en ? idx.byCell.get(`${en[0]},${en[1]}`) : null;
                if (!u) break;
                if (u.type !== "belt") { hasSource = true; break; }
                cur = u;
            }
            if (!hasSource) continue;

            const plan = connect({ from: { uid: b.uid }, to: { uid: hub.uid } }, { entities: obs.entities });
            if (!plan.ok || !plan.cells) continue;

            candidates.push({
                kind: "connect_dead_end",
                handle_uid: b.uid,
                cells: plan.cells.length,
                ops: plan.cells.map(c => ({
                    op: "place", building: "belt", x: c.x, y: c.y,
                    r: c.rotation, rotationVariant: c.rotationVariant,
                })),
                reason: `死带子 ${b.uid} 的末端接到 hub（${plan.cells.length} 格）`,
            });
        }
    }

    /* ── 候选类型 2：删纯垃圾（两端都不接机器、且到不了 hub） ── */
    const junk = [];
    for (const b of dead) {
        let backM = false, fwdM = false;
        let c1 = b; const s1 = new Set();
        for (let i = 0; i < 80 && c1; i++) {
            if (s1.has(c1.uid)) break;
            s1.add(c1.uid);
            const en = entryCellOf(c1);
            const u = en ? idx.byCell.get(`${en[0]},${en[1]}`) : null;
            if (!u) break;
            if (u.type !== "belt") { backM = true; break; }
            c1 = u;
        }
        if (backM) continue;
        let c2 = b; const s2 = new Set();
        for (let i = 0; i < 80 && c2; i++) {
            if (s2.has(c2.uid)) break;
            s2.add(c2.uid);
            const ex = exitCellOf(c2);
            const u = ex ? idx.byCell.get(`${ex[0]},${ex[1]}`) : null;
            if (!u) break;
            if (u.type !== "belt") { fwdM = true; break; }
            c2 = u;
        }
        if (fwdM) continue;
        junk.push(b.uid);
    }
    if (junk.length >= 5) {
        candidates.push({
            kind: "remove_junk",
            count: junk.length,
            ops: junk.map(uid => ({ op: "delete", uid })),
            reason: `${junk.length} 条纯垃圾带子（两端都不接机器、且到不了 hub）`,
        });
    }

    /* ── 用 flow-sim 给每个候选打分：预计交付增量 ── */
    const scored = [];
    for (const c of candidates) {
        let expected = null;
        try {
            const after = applyOps(obs, c.ops);
            const sim = createFlowSim(after, opts.simOpts).run(opts.simSeconds || 30);
            expected = sim.delivered - base.delivered;
        } catch { expected = null; }
        scored.push({ ...c, expected, base_delivered: base.delivered });
    }
    scored.sort((a, b) => (b.expected ?? -1e9) - (a.expected ?? -1e9));

    return {
        obs_hash: hashWorld(obs),
        base,
        candidates: scored,
        top: scored[0] || null,
    };
}

/** 把 op 应用到一个 obs 的副本上（只读，不改原对象）。 */
function applyOps(obs, ops) {
    const del = new Set(ops.filter(o => o.op === "delete").map(o => o.uid));
    const entities = (obs.entities || []).filter(e => !del.has(e.uid)).map(e => ({ ...e }));
    let nextUid = 1 + Math.max(0, ...entities.map(e => (typeof e.uid === "number" ? e.uid : 0)));
    for (const o of ops) {
        if (o.op !== "place") continue;
        entities.push({
            uid: nextUid++, type: o.building, x: o.x, y: o.y,
            r: o.r || 0, variant: "default", rotation_variant: o.rotationVariant || 0, layer: "regular",
        });
    }
    return { ...obs, entities, entity_count: entities.length };
}

/** 拿一次世界。 */
async function grabObs(fileOrNull) {
    if (fileOrNull) {
        const raw = JSON.parse(fs.readFileSync(fileOrNull, "utf8"));
        return raw.result || raw;
    }
    return rpc("obs", { region: [-120, -120, 120, 120], include_resources: true, max_resources: 20000 }, 30000);
}

/** 把一条决策写进队列。 */
function enqueue(decision, meta) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const file = path.join(PENDING, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({
        id, createdAt: new Date().toISOString(),
        obs_hash: decision.obs_hash,
        expected: decision.top.expected,
        ops: decision.top.ops,
        reason: decision.top.reason,
        ...meta,
    }, null, 2));
    return file;
}

/** 消费队列：逐条落盘。世界变了就跳过（不拿过期决策改世界）。 */
async function applyQueue(dry = false) {
    const files = fs.readdirSync(PENDING).filter(f => f.endsWith(".json")).sort();
    if (!files.length) { console.log("队列空。"); return; }

    let curHash = null;
    try { curHash = hashWorld(await grabObs()); } catch (e) {
        console.error("读不到世界，无法安全落盘：" + e.message);
        return;
    }

    for (const f of files) {
        const p = path.join(PENDING, f);
        let item;
        try { item = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }

        if (item.obs_hash && item.obs_hash !== curHash) {
            console.log(`  跳过 ${f}：世界已变（决策针对 ${item.obs_hash}，当前 ${curHash}）`);
            fs.renameSync(p, path.join(FAILED, f));
            continue;
        }
        if (dry) { console.log(`  [dry] ${f}: ${item.reason}`); continue; }

        try {
            const r = await rpc("act", { op: "tx", ops: item.ops }, 60000);
            console.log(`  ✓ ${f}: applied ${r.applied}/${r.requested}`);
            fs.renameSync(p, path.join(DONE, f));
            /* 落盘后世界变了，后面的决策全部作废 */
            curHash = hashWorld(await grabObs());
        } catch (e) {
            console.log(`  ✗ ${f}: ${e.message.slice(0, 100)}`);
            fs.writeFileSync(path.join(FAILED, f), JSON.stringify({ ...item, error: e.message }, null, 2));
            fs.unlinkSync(p);
        }
        /* 每条之间留间隔：不挡用户操作 */
        await new Promise(r => setTimeout(r, 800));
    }
}

/* ═════════════════════════ CLI ═════════════════════════ */
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

async function main() {
    if (has("--apply")) {
        await applyQueue(has("--dry"));
        return;
    }

    const obsFile = val("--obs");
    const loopSec = Number(val("--loop"));

    const once = async () => {
        let obs;
        try { obs = await grabObs(obsFile); } catch (e) {
            console.error("读世界失败（游戏可能卡着，或用了 --obs 快照？）：" + e.message);
            return false;
        }
        const t0 = Date.now();
        const d = think(obs, { simSeconds: Number(val("--sim-seconds")) || 30 });
        const ms = Date.now() - t0;

        console.log(`\n[${new Date().toISOString()}] 世界 ${(obs.entities || []).length} 实体，思考 ${ms}ms`);
        console.log(`  基线：${d.base.delivered} 件 / 30 秒（flow-sim 估）`);
        if (!d.candidates.length) { console.log("  没有候选（世界可能已经是最优，或缺资源图）"); return true; }
        for (const c of d.candidates.slice(0, 5)) {
            console.log(`  · ${c.kind}  ${c.expected >= 0 ? "+" : ""}${c.expected ?? "?"} 件  ${c.reason}`);
        }
        if (d.top && (d.top.expected ?? 0) > 0) {
            const f = enqueue(d, { source: obsFile || "live" });
            console.log(`  ⇒ 已排队：${path.basename(f)}（等 --apply 时落盘）`);
        } else {
            console.log("  ⇒ 没有正收益的候选，不排队");
        }
        return true;
    };

    if (loopSec > 0) {
        console.log(`后台循环模式：每 ${loopSec} 秒想一次。Ctrl-C 退出。`);
        for (;;) {
            await once();
            await new Promise(r => setTimeout(r, loopSec * 1000));
        }
    } else {
        await once();
    }
}

main().catch(e => { console.error("✗ " + (e && e.stack || e)); process.exitCode = 1; });
