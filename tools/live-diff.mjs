#!/usr/bin/env node
/**
 * tools/live-diff.mjs —— 「这个世界到底变没变」的结构化对比。
 *
 * ═════════════════════════ 为什么需要它 ═════════════════════════
 *
 * 过去判断一次真机 run 好不好，靠人读 `transcript.jsonl`。这有两类系统性误读：
 *
 *   ① **只看 `delivered` 会以为什么都没发生。**
 *      真机 `r-20261121190439-6190`：`delivered` 0→0，但 `produced_total`
 *      从 `{}` 变成 `{----CgCg:4, ScScCgCg:9, CgScScCg:9}`，hub 真的进了 9 件
 *      （只是进的不是目标形状）。「没交付目标」和「世界没动」是两件事。
 *
 *   ② **只看死带子总数会把「施工」读成「破坏」。**
 *      同一次 run：`belts_dead` 390→413（+23），V-health 因此判 regressive。
 *      而逐 uid 归因显示：**原有活线一条没死**，+23 里 29 条是新铺的喂料带子、
 *      -6 条是删掉的死环。指标方向恰好与事实相反。
 *      这个归因当时是 agent 手工做的（`.findings/LIVE-E2E-2026-11-21.md` §4），
 *      本工具把它固化。
 *
 * ═════════════════════════ 三种用法 ═════════════════════════
 *
 *   # 1. 两个 run 目录对比（离线，最常用）
 *   node tools/live-diff.mjs --a research/ai-plan/runs/r-20261121072433-521e \
 *                            --b research/ai-plan/runs/r-20261121190439-6190
 *
 *   # 2. 一个快照文件 + 一个 run 目录（或两个快照文件）
 *   node tools/live-diff.mjs --baseline .live-xxx/baseline.json --after <run-dir>
 *
 *   # 3. 抓当前真机世界成快照（只读，不改世界）
 *   node tools/live-diff.mjs --capture --out /tmp/baseline.json --label before
 *
 *   # 4. 只做安全检查（bridge 健康 + 载入的存档身份），给 live-run.sh 用
 *   node tools/live-diff.mjs --check
 *
 * 只读：`--capture` / `--check` 只发 `obs` / `debug_items` / `production` /
 * `status` / `debug_app_state` 五个读方法，不发任何 `act` / `tx` / `save`。
 *
 * 指标口径**不复制**：连通性一律走 `topology.mjs#flowReachable`，
 * 健康快照走 `health.mjs#worldHealth`。本文件只负责「两份快照比出人话」。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const argv = process.argv.slice(2);
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k) => argv.includes(k);

const JSON_OUT = has("--json");
const BRIDGE = (argVal("--bridge") || process.env.BRIDGE_URL || "http://127.0.0.1:7777").replace(/\/+$/, "");

/* ── 世界身份 ────────────────────────────────────────────────────────────────
 * 实验存档 7c93b3dd… 是本项目**唯一**允许写/跑的世界。
 * 用户正式存档 5c967065… 连读都不许，所以它在下面是一条**硬拒绝**，
 * 不是「建议别用」。见 memory: live-verify-target-world。 */
const EXPECT_SAVE = "7c93b3dd9e949c561e5aa529974973b18c856b45";
const FORBIDDEN_SAVES = ["5c96706563c0b74c4d2ce4c7f8bf7a244392de89"];

const STATUS_NAMES = {
    0: "ok",
    2001: "invalid_action",
    2003: "mod_error",
    2004: "not_found",
    1001: "not_connected",
    1003: "not_in_game",
    1004: "read_only",
};

/* ══════════════════════ 0. 小工具 ══════════════════════ */

const short = (v, n = 8) => (typeof v === "string" && v.length > n ? v.slice(0, n) : v ?? "?");
const fmt = (v) => (typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : (v === null || v === undefined ? "—" : String(v)));

/** uid 集合 → 连续区间串（与人工报告里 `17649..17677` 同一种读法）。 */
function ranges(uids) {
    const s = [...new Set(uids)].sort((a, b) => a - b);
    const out = [];
    for (const u of s) {
        const last = out[out.length - 1];
        if (last && u === last[1] + 1) last[1] = u;
        else out.push([u, u]);
    }
    return out.map(([a, b]) => (a === b ? String(a) : `${a}..${b}`));
}

function rangeText(uids, max = 6) {
    if (!uids.length) return "—";
    const rs = ranges(uids);
    const head = rs.slice(0, max).join(", ");
    return rs.length > max ? `${head} …（共 ${rs.length} 段 / ${uids.length} 条）` : head;
}

/** 有方向的增量渲染：`390 → 413 (+23)`；坏方向加 ▼ / 好方向加 ▲。 */
function deltaText(before, after, goodDirection = null) {
    if (!Number.isFinite(before) || !Number.isFinite(after)) return `${fmt(before)} → ${fmt(after)}`;
    const d = Math.round((after - before) * 1000) / 1000;
    if (d === 0) return `${fmt(before)} → ${fmt(after)} (0)`;
    const signed = d > 0 ? `+${d}` : `${d}`;
    let mark = "";
    if (goodDirection === "up") mark = d > 0 ? " ▲" : " ▼";
    else if (goodDirection === "down") mark = d < 0 ? " ▲" : " ▼";
    return `${fmt(before)} → ${fmt(after)} (${signed})${mark}`;
}

/** 两个 {k:count} 字典 → 逐键增减。只报真的变了的键。 */
function dictDelta(before, after) {
    const b = before && typeof before === "object" ? before : {};
    const a = after && typeof after === "object" ? after : {};
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
    const out = [];
    for (const k of keys) {
        const x = Number(b[k] ?? 0);
        const y = Number(a[k] ?? 0);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x === y) continue;
        out.push({ key: k, before: x, after: y, delta: y - x });
    }
    return out;
}

const dictStr = (d) => {
    const o = d && typeof d === "object" ? d : {};
    const ks = Object.keys(o).sort();
    return ks.length ? `{${ks.map((k) => `${k}:${o[k]}`).join(", ")}}` : "{}";
};

/* ══════════════════════ 1. 桥 RPC（只读） ══════════════════════ */

let rpcSeq = 1;
async function rpc(method, params, timeoutMs = 60000) {
    const res = await fetch(`${BRIDGE}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcSeq++, method, params: params || {} }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    if (body.error) {
        const e = new Error(`${method}: ${body.error.message || "rpc error"}`);
        e.rpc = body.error;
        throw e;
    }
    return body.result;
}

async function healthHttp() {
    const res = await fetch(`${BRIDGE}/health`, { signal: AbortSignal.timeout(5000) });
    return res.json();
}

/* ══════════════════════ 2. 世界度量（全部复用既有实现） ══════════════════════ */

let MODS = null;
async function mods() {
    if (!MODS) {
        const healthMod = await imp("src/agent/loop/health.mjs");
        const topoMod = await imp("src/agent/loop/topology.mjs");
        const loopMod = await imp("src/agent/loop.mjs");
        MODS = {
            worldHealth: healthMod.worldHealth,
            healthDelta: healthMod.healthDelta,
            classifyNetEffect: healthMod.classifyNetEffect,
            formatNetEffect: healthMod.formatNetEffect,
            indexOf: topoMod.indexOf,
            flowReachable: topoMod.flowReachable,
            isBelt: topoMod.isBelt,
            isTunnel: topoMod.isTunnel,
            sourceEntityOf: topoMod.sourceEntityOf,
            debugItemsRegion: loopMod.debugItemsRegion,
        };
    }
    return MODS;
}

/**
 * 带 uid 集合的度量。`worldHealth` 只给数量，uid 级归因需要集合本身，
 * 所以这里按**与 worldHealth 完全相同的调用方式**再取一次集合
 * （同一份 `flowReachable`、同一个 `itemsDoc` 门槛），不另写一套判据。
 */
async function beltSets(obs, items) {
    const M = await mods();
    const ents = (obs && Array.isArray(obs.entities) ? obs.entities : []).filter((e) => e && Number.isInteger(e.uid));
    const out = { all: new Set(), deadGeo: null, deadTyped: null, sourceOf: new Map(), typeOf: new Map() };
    for (const e of ents) out.typeOf.set(e.uid, e.type);
    if (!ents.length) return out;

    const belts = ents.filter((e) => M.isBelt(e) || M.isTunnel(e));
    for (const b of belts) out.all.add(b.uid);
    if (!belts.length) return out;

    const idx = M.indexOf(obs);
    try {
        const geo = M.flowReachable(obs, idx);
        out.deadGeo = new Set(belts.filter((b) => !geo.has(b.uid)).map((b) => b.uid));
    } catch { out.deadGeo = null; }
    if (items && Array.isArray(items.belts)) {
        try {
            const typed = M.flowReachable(obs, idx, { itemsDoc: items });
            out.deadTyped = new Set(belts.filter((b) => !typed.has(b.uid)).map((b) => b.uid));
        } catch { out.deadTyped = null; }
    }
    /* 死带子的「源头类型」—— 全是 miner 说明矿机空转，全是 cutter 说明加工链断了。
       只在要渲染归因时用，取不到就记 unknown。 */
    for (const b of belts) {
        let kind = "unknown";
        try { kind = M.sourceEntityOf(idx, b).kind || "unknown"; } catch { kind = "unknown"; }
        out.sourceOf.set(b.uid, kind);
    }
    return out;
}

/** 死带子集合的逐 uid 归因：新增的死是「新铺的」还是「原有活线变死的」。 */
function attribute(before, after, field) {
    const b = before && before[field] instanceof Set ? before[field] : null;
    const a = after && after[field] instanceof Set ? after[field] : null;
    if (!b || !a) return null;
    const becameDead = [...a].filter((u) => before.all.has(u) && !b.has(u)).sort((x, y) => x - y);
    const newlyLaid = [...a].filter((u) => !before.all.has(u)).sort((x, y) => x - y);
    const revived = [...b].filter((u) => after.all.has(u) && !a.has(u)).sort((x, y) => x - y);
    const removed = [...b].filter((u) => !after.all.has(u)).sort((x, y) => x - y);
    const countBySource = (uids) => {
        const acc = {};
        for (const u of uids) {
            const k = after.sourceOf.get(u) || "unknown";
            acc[k] = (acc[k] || 0) + 1;
        }
        return acc;
    };
    return {
        became_dead: becameDead,
        newly_laid_dead: newlyLaid,
        dead_to_live: revived,
        removed_dead: removed,
        became_dead_by_source: countBySource(becameDead),
        newly_laid_dead_by_source: countBySource(newlyLaid),
        /* 一句话结论：只有「原有活线变死」才是真退化。 */
        verdict: becameDead.length === 0
            ? "原有活线一条没死"
            : `${becameDead.length} 条原有活线变成了死带子`,
    };
}

/* ══════════════════════ 3. 快照：从桥 / 从 run 目录 / 从文件 ══════════════════════ */

/** 从真机抓一份快照。**只读**。 */
async function captureLive(label) {
    const M = await mods();
    const h = await healthHttp();
    if (!h || h.ok !== true || h.mod_connected !== true) {
        throw new Error(`bridge 不健康：${JSON.stringify(h)}`);
    }
    const status = await rpc("status", {});
    if (!status || status.in_game !== true) {
        throw new Error("游戏不在世界里（status.in_game=false）—— 先载入 7c93b3dd 再抓快照");
    }
    const app = await rpc("debug_app_state", {});
    /* 只要资源会让 payload 到 500KB+，而健康/连通性一个都不需要它。
       先请求不含资源，再兜底剥一次（老 mod 可能忽略这个参数）。 */
    const obsRaw = await rpc("obs", {
        max_entities: 50000, layer: "all", include_stats: true,
        include_resources: false, max_resources: 0, resource_radius: 256,
    });
    const obs = { ...obsRaw };
    delete obs.resources;
    delete obs.resources_region;
    const items = await rpc("debug_items", { region: M.debugItemsRegion(obs) });
    const production = await rpc("production", { slices: 6 });
    const saveId = (app && app.savegame && app.savegame.internal_id) || null;
    const health = M.worldHealth({ obs, items, production });
    return {
        kind: "live-world-snapshot",
        version: 1,
        label: label || "live",
        captured_at: new Date().toISOString(),
        source: {
            kind: "live",
            bridge: BRIDGE,
            savegame_internal_id: saveId,
            state_key: app && app.state_key,
            root_present: app && app.root_present,
            page_visible: app && app.page_visible,
            game_version: status.game_version,
            mod_version: status.mod_version,
        },
        obs,
        items,
        production,
        health,
    };
}

/** 从一个 run 目录读快照。缺文件就**明确报错**，不拿空对象冒充。 */
async function snapshotFromRunDir(dir) {
    const M = await mods();
    const need = ["obs-last.json", "items-last.json", "production-last.json"];
    const missing = need.filter((f) => !fs.existsSync(path.join(dir, f)));
    if (missing.length) {
        throw new Error(`${dir} 不是完整 run 目录，缺 ${missing.join(" / ")}（不拿空数据冒充）`);
    }
    const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const obs = read("obs-last.json");
    const items = read("items-last.json");
    const production = read("production-last.json");
    const optional = (f) => (fs.existsSync(path.join(dir, f)) ? read(f) : null);
    const verify = optional("verify-last.json");
    const halt = optional("HALT.json");
    const tx = optional("tx-last.json");
    return {
        kind: "run-dir-snapshot",
        version: 1,
        label: path.basename(dir),
        captured_at: null,
        source: {
            kind: "run-dir",
            dir,
            verify_failed: verify && Array.isArray(verify.checks)
                ? verify.checks.filter((c) => c && c.ok === false).map((c) => c.name)
                : null,
            halt_reason: halt && halt.reason ? halt.reason : null,
            tx_applied: tx && Number.isFinite(tx.applied) ? tx.applied : null,
            tx_rolled_back: tx && tx.rolled_back === true,
        },
        obs,
        items,
        production,
        health: M.worldHealth({ obs, items, production }),
    };
}

async function snapshotFromFile(file) {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!j || typeof j !== "object") throw new Error(`${file} 不是 JSON 对象`);
    if (j.kind === "live-world-snapshot" || j.kind === "run-dir-snapshot") {
        /* `health` 是本工具的派生量，不是原始观测的一部分。
           手写的快照（比如测试合成世界）不会带它 —— 缺了就地重算，
           而不是让 compare() 读到 undefined 崩掉。 */
        if (!j.health) {
            const M = await mods();
            j.health = M.worldHealth({ obs: j.obs, items: j.items || null, production: j.production || null });
        }
        return j;
    }
    /* 裸 obs（history 里的手抓 dump）也接受：有 entities + goal 就够算连通性。 */
    if (Array.isArray(j.entities) && j.goal) {
        const M = await mods();
        return {
            kind: "obs-only-snapshot",
            version: 1,
            label: path.basename(file),
            source: { kind: "obs-file", file },
            obs: j,
            items: null,
            production: null,
            health: M.worldHealth({ obs: j, items: null, production: null }),
        };
    }
    /* 包了一层 `{result:{entities,…}}` 的 RPC 原文也认。 */
    if (j.result && Array.isArray(j.result.entities) && j.result.goal) {
        const M = await mods();
        return {
            kind: "obs-only-snapshot",
            version: 1,
            label: path.basename(file),
            source: { kind: "obs-file", file },
            obs: j.result,
            items: null,
            production: null,
            health: M.worldHealth({ obs: j.result, items: null, production: null }),
        };
    }
    throw new Error(`${file} 既不是本工具的快照，也不是 obs dump（缺 entities/goal）`);
}

async function loadSnapshot(spec, role) {
    const p = path.resolve(spec);
    if (!fs.existsSync(p)) throw new Error(`${role} 不存在：${p}`);
    const st = fs.statSync(p);
    if (st.isDirectory()) return snapshotFromRunDir(p);
    return snapshotFromFile(p);
}

/* ══════════════════════ 4. 对比 ══════════════════════ */

async function compare(before, after) {
    const M = await mods();
    const hb = before.health;
    const ha = after.health;
    const delta = M.healthDelta(hb, ha);
    const net = M.classifyNetEffect(hb, ha, delta);

    const bSets = await beltSets(before.obs, before.items);
    const aSets = await beltSets(after.obs, after.items);

    const goalOf = (s) => {
        const g = s.obs && s.obs.goal;
        return {
            level: g && Number.isInteger(g.level) ? g.level : null,
            shape: (g && g.requirement && g.requirement.shape) || null,
        };
    };

    const beforeSave = before.source && before.source.savegame_internal_id ? before.source.savegame_internal_id : null;
    const afterSave = after.source && after.source.savegame_internal_id ? after.source.savegame_internal_id : null;

    return {
        a: {
            label: before.label, kind: before.kind, source: before.source,
            tick: Number.isFinite(before.obs && before.obs.tick) ? before.obs.tick : null,
        },
        b: {
            label: after.label, kind: after.kind, source: after.source,
            tick: Number.isFinite(after.obs && after.obs.tick) ? after.obs.tick : null,
        },
        /* 两份快照是不是同一个世界 —— 不是的话下面所有增量都无意义 */
        same_world: beforeSave && afterSave ? beforeSave === afterSave : null,
        savegame: { before: beforeSave, after: afterSave },
        goal: { before: goalOf(before), after: goalOf(after) },
        tick: {
            before: Number.isFinite(before.obs && before.obs.tick) ? before.obs.tick : null,
            after: Number.isFinite(after.obs && after.obs.tick) ? after.obs.tick : null,
            delta: Number.isFinite(before.obs && before.obs.tick) && Number.isFinite(after.obs && after.obs.tick)
                ? Math.round((after.obs.tick - before.obs.tick) * 1000) / 1000 : null,
        },
        scale: {
            entities: [hb.entities, ha.entities],
            belts: [hb.belts, ha.belts],
            machines: [hb.machines, ha.machines],
        },
        /* ── 交付与存量 ── */
        delivered: [hb.delivered, ha.delivered],
        stored_goal: [hb.stored_goal, ha.stored_goal],
        produced_goal: [hb.produced_goal, ha.produced_goal],
        stored_changes: dictDelta(hb.stored, ha.stored),
        /* ── 产出（关键：真机那次 delivered 0→0 而 produced 从零到有） ── */
        produced_total: {
            before: (before.production && before.production.produced_total) || {},
            after: (after.production && after.production.produced_total) || {},
            delta: dictDelta(
                before.production && before.production.produced_total,
                after.production && after.production.produced_total,
            ),
            before_window_seconds: (before.production && before.production.window_seconds) ?? null,
            after_window_seconds: (after.production && after.production.window_seconds) ?? null,
        },
        delivered_total: {
            before: (before.production && before.production.delivered_total) || {},
            after: (after.production && after.production.delivered_total) || {},
            delta: dictDelta(
                before.production && before.production.delivered_total,
                after.production && after.production.delivered_total,
            ),
        },
        /* ── 连通性 ── */
        belts_reaching_hub: [hb.belts_reaching_hub, ha.belts_reaching_hub],
        belts_dead: [hb.belts_dead, ha.belts_dead],
        belts_deliverable: [hb.belts_deliverable, ha.belts_deliverable],
        belts_undeliverable: [hb.belts_undeliverable, ha.belts_undeliverable],
        items_on_belts: [hb.items_on_belts, ha.items_on_belts],
        /* ── uid 级归因（几何口径 + 类型口径） ── */
        dead_attribution: attribute(bSets, aSets, "deadGeo"),
        undeliverable_attribution: attribute(bSets, aSets, "deadTyped"),
        /* ── 原口径的净效果判定（保留，方便和 timeline.log 对照） ── */
        shape_changed: hb.shape !== ha.shape,
        shape_before: hb.shape,
        shape_after: ha.shape,
        net_effect: { kind: net.kind, why: net.why },
        health_delta: delta.filter((d) => d.sign === "+" || d.sign === "-" || d.sign === null),
    };
}

/* ══════════════════════ 5. 人读输出 ══════════════════════ */

function render(cmp) {
    const L = [];
    const A = cmp.a, B = cmp.b;
    L.push("════════════════ 世界对比 ════════════════");
    L.push(`A ${A.label} (${A.kind})   tick=${fmt(A.tick)}`);
    L.push(`B ${B.label} (${B.kind})   tick=${fmt(B.tick)}   Δtick=${fmt(cmp.tick.delta)}`);
    if (cmp.same_world === false) {
        L.push("");
        L.push(`⚠ 两份快照不是同一个存档：${short(cmp.savegame.before)} vs ${short(cmp.savegame.after)}`);
        L.push("  下面的增量没有意义 —— 换存档之后 delivered/带子数全部不可比。");
    }
    if (cmp.goal.before.level !== cmp.goal.after.level) {
        L.push(`⚠ 关卡变了：L${cmp.goal.before.level} → L${cmp.goal.after.level}（跨关时 delivered 归零，不可相减）`);
    }

    const gs = cmp.goal.after.shape || cmp.goal.before.shape || "?";
    L.push("");
    L.push(`目标  L${cmp.goal.after.level ?? "?"}  ${gs}`);
    L.push(`  delivered        ${deltaText(cmp.delivered[0], cmp.delivered[1], "up")}`);
    L.push(`  hub 存量(目标形状) ${deltaText(cmp.stored_goal[0], cmp.stored_goal[1], "up")}`);
    if (cmp.produced_goal[0] !== null || cmp.produced_goal[1] !== null) {
        L.push(`  本窗口产出(目标)  ${deltaText(cmp.produced_goal[0], cmp.produced_goal[1], "up")}`);
    }

    L.push("");
    L.push("规模");
    L.push(`  entities         ${deltaText(cmp.scale.entities[0], cmp.scale.entities[1])}`);
    L.push(`  belts            ${deltaText(cmp.scale.belts[0], cmp.scale.belts[1])}`);
    L.push(`  machines         ${deltaText(cmp.scale.machines[0], cmp.scale.machines[1])}`);

    L.push("");
    L.push("连通性");
    L.push(`  到 hub 的带子    ${deltaText(cmp.belts_reaching_hub[0], cmp.belts_reaching_hub[1], "up")}`);
    L.push(`  死带子(几何)     ${deltaText(cmp.belts_dead[0], cmp.belts_dead[1], "down")}`);
    L.push(`  可交付(类型口径) ${deltaText(cmp.belts_deliverable[0], cmp.belts_deliverable[1], "up")}`);
    L.push(`  不可交付         ${deltaText(cmp.belts_undeliverable[0], cmp.belts_undeliverable[1], "down")}`);
    L.push(`  带上货           ${deltaText(cmp.items_on_belts[0], cmp.items_on_belts[1], "up")}`);

    /* ── 产出：整份报告里最能揭穿「什么都没发生」的一段 ── */
    L.push("");
    L.push("产出（production 窗口）");
    /* ⚠ 这不是累计量，是**最近 N 个 10 秒片**的求和。窗口滑过去，旧货就掉出统计。
       所以 after 比 before 小，可能只是「跑完之后没再产出」，不是「产出倒退」。 */
    L.push("  ⚠ produced_total / delivered_total 是滑动窗口求和，不是累计量；变小只说明「窗口里没再出货」");
    const pt = cmp.produced_total;
    L.push(`  produced_total   ${dictStr(pt.before)} → ${dictStr(pt.after)}`);
    if (pt.delta.length) {
        for (const d of pt.delta) L.push(`      · ${d.key}  ${d.before} → ${d.after} (${d.delta > 0 ? "+" : ""}${d.delta})${d.delta < 0 ? "  ← 掉出窗口" : ""}`);
    }
    if (pt.before_window_seconds !== pt.after_window_seconds) {
        L.push(`  ⚠ 两个窗口长度不同（${fmt(pt.before_window_seconds)}s vs ${fmt(pt.after_window_seconds)}s），总量不可直接相减`);
    }
    const dt = cmp.delivered_total;
    L.push(`  delivered_total  ${dictStr(dt.before)} → ${dictStr(dt.after)}`);
    if (dt.delta.length) {
        for (const d of dt.delta) L.push(`      · ${d.key}  ${d.before} → ${d.after} (${d.delta > 0 ? "+" : ""}${d.delta})${d.delta < 0 ? "  ← 掉出窗口" : ""}`);
    }
    if (cmp.stored_changes.length) {
        L.push("  hub 存量变化（累计账本，跨关不清零 —— 这才是权威的交付证据）：");
        const shown = cmp.stored_changes.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, 10);
        for (const d of shown) L.push(`      · ${d.key}  ${d.before} → ${d.after} (${d.delta > 0 ? "+" : ""}${d.delta})`);
        if (cmp.stored_changes.length > shown.length) L.push(`      … 另外 ${cmp.stored_changes.length - shown.length} 个形状也有变化`);
    }

    /* ── uid 级归因 ── */
    const renderAttr = (title, at) => {
        if (!at) { L.push(`  ${title}: 无法归因（缺 obs/items）`); return; }
        L.push(`  ${title}`);
        L.push(`    原有活线变死 : ${at.became_dead.length} 条${at.became_dead.length ? "  " + rangeText(at.became_dead) : ""}`);
        if (at.became_dead.length && Object.keys(at.became_dead_by_source).length) {
            L.push(`                   源头类型 ${dictStr(at.became_dead_by_source)}`);
        }
        L.push(`    新铺的死带子 : ${at.newly_laid_dead.length} 条${at.newly_laid_dead.length ? "  " + rangeText(at.newly_laid_dead) : ""}`);
        if (at.newly_laid_dead.length && Object.keys(at.newly_laid_dead_by_source).length) {
            L.push(`                   源头类型 ${dictStr(at.newly_laid_dead_by_source)}`);
        }
        L.push(`    死 → 活      : ${at.dead_to_live.length} 条`);
        L.push(`    删掉的死带子 : ${at.removed_dead.length} 条${at.removed_dead.length ? "  " + rangeText(at.removed_dead) : ""}`);
        L.push(`    → ${at.verdict}`);
    };

    L.push("");
    L.push("死带子 uid 级归因（几何口径）");
    renderAttr("归因", cmp.dead_attribution);
    if (cmp.undeliverable_attribution
        && (cmp.undeliverable_attribution.became_dead.length || cmp.undeliverable_attribution.newly_laid_dead.length)) {
        L.push("");
        L.push("不可交付 uid 级归因（类型口径，扣掉「几何通但运颜料」）");
        renderAttr("归因", cmp.undeliverable_attribution);
    }

    /* ── 结论：先给「有没有发生事」，再给「好坏」 ── */
    L.push("");
    L.push("结论");
    const producedGained = pt.delta.filter((d) => d.delta > 0);
    const anyProduced = Object.keys(pt.after || {}).length > 0;
    const goalDelivery = (cmp.delivered[0] ?? 0) < (cmp.delivered[1] ?? 0)
        || (cmp.stored_goal[0] ?? 0) < (cmp.stored_goal[1] ?? 0);
    const producedKeys = Object.keys(pt.after || {});
    const goalShape = cmp.goal.after.shape;

    if (goalDelivery) {
        L.push(`  ✓ 目标有进展：delivered ${fmt(cmp.delivered[0])}→${fmt(cmp.delivered[1])}，hub 存量 ${fmt(cmp.stored_goal[0])}→${fmt(cmp.stored_goal[1])}`);
    } else {
        L.push(`  ✗ 目标没有进展（delivered ${fmt(cmp.delivered[1])}，目标形状 ${goalShape} 的 hub 存量 ${fmt(cmp.stored_goal[1])}）`);
    }
    if (!cmp.shape_changed) {
        L.push("  · 世界形态逐实体完全没变（inert）—— 拓扑上一次写入都没落地");
    }
    if (producedGained.length) {
        const what = producedGained.map((d) => `${d.key} +${d.delta}`).join(", ");
        L.push(`  ✓ 世界上真的发生了事：产出从「${dictStr(pt.before)}」变成有货（${what}）`);
        const offGoal = producedKeys.filter((k) => k !== goalShape);
        if (goalShape && offGoal.length && !producedKeys.includes(goalShape)) {
            L.push(`  ⚠ 产出的是 ${offGoal.join(", ")}，不是目标 ${goalShape} —— 线通了，形状不对`);
        }
    } else if (anyProduced) {
        L.push(`  · 产出窗口里没有新增（现有 ${dictStr(pt.after)}，可能是上一轮的余量/流到一半）`);
    } else if (cmp.shape_changed) {
        L.push("  · 产出仍为零 —— 拓扑变了但一件货都没流出来");
    }
    const att = cmp.dead_attribution;
    const deadUp = (cmp.belts_dead[1] ?? 0) - (cmp.belts_dead[0] ?? 0);
    if (att && deadUp > 0) {
        if (att.became_dead.length === 0 && att.newly_laid_dead.length > 0) {
            L.push(`  ✓ 死带子 +${deadUp} 全部是新铺的（${att.newly_laid_dead.length} 条），原有活线一条没死`
                + " —— 单看死带子总数会把这个读成「改坏了」");
        } else if (att.became_dead.length > 0) {
            L.push(`  ⚠ 死带子 +${deadUp}，其中 ${att.became_dead.length} 条是**原有活线变死的**：${rangeText(att.became_dead)}`);
        }
    } else if (att && deadUp < 0) {
        L.push(`  ✓ 死带子少了 ${-deadUp} 条（原有活线变死 ${att.became_dead.length} 条，删掉死带子 ${att.removed_dead.length} 条）`);
    }
    L.push(`  → 原口径净效果：${cmp.net_effect.kind}${cmp.net_effect.why.length ? "（" + cmp.net_effect.why.join("；") + "）" : ""}`);

    if (A.source && A.source.verify_failed) {
        L.push(`  A 的 verify 红项：${A.source.verify_failed.length ? A.source.verify_failed.join(", ") : "无"}`
            + (A.source.halt_reason ? `（halt: ${A.source.halt_reason}）` : ""));
    }
    if (B.source && B.source.verify_failed) {
        L.push(`  B 的 verify 红项：${B.source.verify_failed.length ? B.source.verify_failed.join(", ") : "无"}`
            + (B.source.halt_reason ? `（halt: ${B.source.halt_reason}）` : ""));
    }
    return L.join("\n");
}

/* ══════════════════════ 6. 安全检查（给 live-run.sh 用） ══════════════════════ */

async function check({ expectSave }) {
    const out = { ok: false, bridge: null, status: null, app: null, savegame_internal_id: null, problems: [], warnings: [] };
    try {
        out.bridge = await healthHttp();
    } catch (e) {
        out.problems.push(`bridge 不可达（${BRIDGE}/health）：${e && e.message ? e.message : e}`);
        return out;
    }
    if (!out.bridge || out.bridge.ok !== true) out.problems.push(`bridge /health 非 ok：${JSON.stringify(out.bridge)}`);
    if (out.bridge && out.bridge.mod_connected !== true) out.problems.push("mod 未连接（mod_connected=false）—— 游戏没开或 mod 没加载");
    try {
        out.status = await rpc("status", {});
    } catch (e) {
        out.problems.push(`status 读取失败：${e && e.message ? e.message : e}`);
    }
    if (out.status) {
        if (out.status.in_game !== true) out.problems.push("游戏不在世界里（in_game=false）");
        if (out.status.allow_write === false) out.problems.push("桥处于 read_only，tx 会被 1004 拒掉");
        if (out.status.allow_step === false) out.warnings.push("allow_step=false —— L4 行为检查会降级");
        if (out.status.paused === true) out.warnings.push("游戏处于暂停（paused=true）—— 产线不会流动，L4 会判没产出");
        const feats = Array.isArray(out.status.features) ? out.status.features : [];
        for (const f of ["tx", "step"]) if (!feats.includes(f)) out.problems.push(`桥缺少能力 "${f}"（features 里没有）`);
    }
    try {
        out.app = await rpc("debug_app_state", {});
    } catch (e) {
        out.problems.push(`debug_app_state 读取失败：${e && e.message ? e.message : e}`);
    }
    if (out.app) {
        out.savegame_internal_id = (out.app.savegame && out.app.savegame.internal_id) || null;
        if (out.app.root_present !== true) out.problems.push("mod root 为空（root_present=false）—— 世界没建起来");
        if (out.app.state_key !== "InGameState") out.problems.push(`当前状态是 ${out.app.state_key}，不是 InGameState`);
        if (out.app.app_error_occurred === true) out.problems.push("游戏报了 APP_ERROR_OCCURED");
        if (out.app.ingame_stage && out.app.ingame_stage !== "s10_gameRunning") {
            out.problems.push(`加载还没完成（ingame_stage=${out.app.ingame_stage}）`);
        }
        if (out.app.page_visible === false) {
            /* memory: raf-stall-not-window —— 窗口不可见会让 rAF 停、加载链卡死。
               但「不可见」不等于「帧不跑」（本机实测该字段恒 false 而 tick 正常推进），
               所以只警告，并用 tick 是否推进来判真伪。 */
            out.warnings.push("page_visible=false（窗口不可见）—— 若 tick 不推进，加载链会卡在 rAF 上");
        }
    }
    /* tick 活性：两秒内 tick 有推进，才说明游戏循环真的在跑。
       这是「状态说 in_game，世界却冻着」唯一的廉价判据。 */
    if (!out.problems.length) {
        try {
            const t1 = (await rpc("obs", { max_entities: 1, include_stats: false, include_resources: false })).tick;
            await new Promise((r) => setTimeout(r, 2000));
            const t2 = (await rpc("obs", { max_entities: 1, include_stats: false, include_resources: false })).tick;
            out.tick = { before: t1, after: t2, delta: Number.isFinite(t1) && Number.isFinite(t2) ? Math.round((t2 - t1) * 1000) / 1000 : null };
            if (!(out.tick.delta > 0)) {
                out.warnings.push(`tick 2 秒内没有推进（${fmt(t1)} → ${fmt(t2)}）—— 游戏循环可能停了（暂停/rAF 被节流）`);
            }
        } catch (e) {
            out.warnings.push(`tick 活性采样失败：${e && e.message ? e.message : e}`);
        }
    }
    /* 身份硬判据 */
    const id = out.savegame_internal_id;
    const forbidden = id && FORBIDDEN_SAVES.includes(id);
    out.forbidden = !!forbidden;
    if (forbidden) {
        out.problems.push(`载入的是用户正式存档 ${short(id)} —— 这是禁令，**连读都不许**，立即停止`);
    } else if (!id) {
        out.problems.push("读不到 savegame.internal_id —— 无法证明当前是实验存档 7c93b3dd，拒绝继续");
    } else if (expectSave && !id.startsWith(expectSave.slice(0, 8)) && id !== expectSave) {
        out.problems.push(`载入的存档是 ${id}，不是实验存档 ${expectSave}`);
    } else if (!id.startsWith(EXPECT_SAVE.slice(0, 8))) {
        out.problems.push(`载入的存档是 ${id}，不是实验存档 ${EXPECT_SAVE}`);
    }
    out.ok = out.problems.length === 0;
    return out;
}

/* ══════════════════════ 7. CLI ══════════════════════ */

function usage() {
    console.log(`用法：
  node tools/live-diff.mjs --a <run-dir|snapshot.json> --b <run-dir|snapshot.json>
  node tools/live-diff.mjs --baseline <...> --after <...>
  node tools/live-diff.mjs --capture --out <file> [--label <name>]
  node tools/live-diff.mjs --check [--expect-save ${EXPECT_SAVE.slice(0, 8)}...]

选项：
  --json        机器可读输出
  --bridge URL  桥地址（默认 ${BRIDGE}）
  --goal SHAPE  强制指定目标形状（默认取快照自己的 goal.requirement.shape）`);
}

async function main() {
    if (has("--help") || has("-h")) { usage(); return 0; }
    /* 裸跑（无参数）= 用法错误，不是成功。给 0 会让 `&&` 链在用法错时继续往下走。 */
    if (argv.length === 0) { usage(); return 2; }

    if (has("--check")) {
        const r = await check({ expectSave: argVal("--expect-save") || EXPECT_SAVE });
        if (JSON_OUT) {
            console.log(JSON.stringify(r, null, 2));
        } else {
            console.log("════════════════ 安全检查 ════════════════");
            console.log(`bridge   ${r.bridge ? `ok=${r.bridge.ok} mod_connected=${r.bridge.mod_connected} uptime=${r.bridge.uptime_s}s` : "不可达"}`);
            if (r.status) {
                console.log(`game     in_game=${r.status.in_game} paused=${r.status.paused} level=${r.status.hub_level} `
                    + `game=${r.status.game_version} mod=${r.status.mod_version} allow_write=${r.status.allow_write}`);
            }
            console.log(`存档     ${r.savegame_internal_id || "（读不到）"}${r.savegame_internal_id && r.savegame_internal_id.startsWith(EXPECT_SAVE.slice(0, 8)) ? "  ✓ 实验存档" : ""}`);
            if (r.tick) console.log(`tick     ${fmt(r.tick.before)} → ${fmt(r.tick.after)} (Δ${fmt(r.tick.delta)})`);
            for (const w of r.warnings) console.log(`⚠ ${w}`);
            for (const p of r.problems) console.log(`✗ ${p}`);
            console.log(r.ok ? "→ 可以跑（读身份、健康、写权限都对得上）" : "→ 拒绝运行（见上面 ✗）");
        }
        return r.ok ? 0 : 3;
    }

    if (has("--capture")) {
        const outPath = argVal("--out");
        if (!outPath) { console.error("--capture 需要 --out <file>"); return 2; }
        const snap = await captureLive(argVal("--label") || "live");
        const abs = path.resolve(outPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, JSON.stringify(snap, null, 1), "utf8");
        const h = snap.health;
        if (JSON_OUT) {
            console.log(JSON.stringify({ out: abs, label: snap.label, savegame: snap.source.savegame_internal_id, health: h }, null, 1));
        } else {
            console.log(`已抓快照 ${abs}`);
            console.log(`  存档 ${snap.source.savegame_internal_id}   tick ${fmt(snap.obs.tick)}   entities ${h.entities}`);
            console.log(`  delivered ${fmt(h.delivered)}   items_on_belts ${fmt(h.items_on_belts)}   `
                + `belts_deliverable ${fmt(h.belts_deliverable)}   belts_dead ${fmt(h.belts_dead)}`);
        }
        return 0;
    }

    const aSpec = argVal("--a") || argVal("--baseline") || argVal("--before");
    const bSpec = argVal("--b") || argVal("--after");
    if (!aSpec || !bSpec) { usage(); return 2; }
    const before = await loadSnapshot(aSpec, "--a");
    const after = await loadSnapshot(bSpec, "--b");
    const cmp = await compare(before, after);
    if (JSON_OUT) console.log(JSON.stringify(cmp, null, 1));
    else console.log(render(cmp));
    /* 退出码：0 = 有进展或至少没变坏；1 = 原有活线变死 / 目标倒退。
       这是给 CI/脚本用的**粗判据**，细看仍然读输出。 */
    const bad = (cmp.dead_attribution && cmp.dead_attribution.became_dead.length > 0)
        || (cmp.belts_reaching_hub[0] !== null && cmp.belts_reaching_hub[1] !== null
            && cmp.belts_reaching_hub[1] < cmp.belts_reaching_hub[0]);
    return bad ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error("✗ " + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
});
