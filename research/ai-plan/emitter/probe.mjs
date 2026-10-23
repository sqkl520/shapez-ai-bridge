/**
 * probe.mjs — P6 的补充探针（**不属于** L1 门 CLI；手工跑：`node research/ai-plan/emitter/probe.mjs`）
 *
 * 锁三件 roundtrip.mjs 里不好表达、但 P8 一定要的事：
 *   1. `emitPlan` **永不 throw** —— plan §0 的顶层签名规定「永不 throw；失败走 {ok:false,reason,...}」。
 *      12 个畸形顶层入参 + 9 个 entity 级畸形（浮点 dx、同格二次放置、非象限角、假蓝图…）。
 *   2. 锚点归一的**平移不变性** —— site.anchor 平移、或 dx/dy 起点不为 0 时，
 *      w 必须跟着走、dx'/dy' 必须非负、e 数组必须**逐元素不变**（C1 + P7 的 paste{x,y}=anchor 口径）。
 *   3. chargeMode 的口径 —— 入参写 "auto" 也要被钉成 "false"（v1 god-mode，plan §2.1 硬规定 + §6 R4），
 *      并在 warnings 里说明。
 *
 * 零依赖：只 import 仓库内模块（P2 经 emit.mjs 的 `P2` 出口拿，理由见 emit.mjs 的 loadP2 注释）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const imp = rel => import(pathToFileURL(path.join(ROOT, rel)).href);

const { emitPlan, normalizeAnchor } = await imp("src/ai/compiler/emit.mjs");
const { fixtureStraight, diffCells } = await imp("src/ai/compiler/roundtrip.mjs");
const { decodeBlueprint } = await imp("src/shared/blueprint.mjs");

let fails = 0;
const say = (cond, msg, extra) => { if (cond) console.log("✓ " + msg); else { fails++; console.log(`✗ ${msg}${extra ? "  " + extra : ""}`); } };
const clone = o => JSON.parse(JSON.stringify(o));

/* ── 1. never-throw ── */
const junkTop = [
    undefined, null, 0, 1, "x", true, [], {}, { ok: true }, { ok: true, entities: [] },
    { ok: true, validation: { pass: true, errors: [] } },
    { ok: false }, { ok: false, reason: "not-a-reason" },
    { ok: true, blueprint: "SZBP1.garbage", entities: [{ code: 7 }] },
];
const bad = [];
for (const j of junkTop) {
    try {
        const r = emitPlan(j);
        if (r.ok !== false || r.blueprint !== null || !Array.isArray(r.beltIntent)) bad.push(`误接受 ${JSON.stringify(j)}`);
        if (r.ok === false && (typeof r.reason !== "string" || !r.failingNode)) bad.push(`拒绝但形状不全 ${JSON.stringify(j)}`);
    } catch (e) { bad.push(`throw(${JSON.stringify(j)}): ${String(e.message).slice(0, 90)}`); }
}
const junkEntity = [
    ["entities[0]=null", q => { q.entities[0] = null; }],
    ["dx 非整数", q => { q.entities[0].dx = 1.5; }],
    ["两实体同格", q => { q.entities.push(clone(q.entities[0])); }],
    ["belt rot 非象限角", q => { const b = q.entities.find(e => e.kind === "belt"); b.rot = 45; }],
    ["belt 方向自相矛盾", q => { const b = q.entities.find(e => e.kind === "belt"); b.outDir = "left"; }],
    ["validation=null", q => { q.validation = null; }],
    ["goal 不是 shortKey", q => { q.goal = "not-a-shape"; }],
    ["假蓝图串", q => { q.blueprint = "SZBP1.@@@@"; }],
    ["kind 不在枚举", q => { q.entities[0].kind = "balancer"; }],
    ["scope 越界", q => { q.scope.tunnels = true; }],
    ["stats.bbox 造假的", q => { q.stats.bbox = [99, 99]; }],
    ["entities 顺序反了", q => { q.entities.reverse(); }],
];
for (const [label, mut] of junkEntity) {
    const q = clone(fixtureStraight()); mut(q);
    try {
        const r = emitPlan(q);
        if (r.ok !== false || r.blueprint !== null) bad.push(`误接受 ${label}`);
    } catch (e) { bad.push(`throw(${label}): ${String(e.message).slice(0, 90)}`); }
}
say(bad.length === 0, `emitPlan 永不 throw 且畸形输入一律 blueprint:null（${junkTop.length + junkEntity.length} 例）`, bad.join(" | "));

/* ── 2. 锚点归一的平移不变性 ── */
const base = fixtureStraight();
const outBase = emitPlan(base);
say(outBase.ok === true, "基准样例发射", outBase.ok ? "" : `reason=${outBase.reason}`);
if (outBase.ok) {
    for (const [shiftX, shiftY, label] of [[0, 0, "dx/dy 起点为 0"], [5, 3, "dx/dy 起点 (5,3)"], [-7, -2, "dx/dy 起点 (-7,-2)"]]) {
        const q = clone(base);
        for (const e of q.entities) { e.dx += shiftX; e.dy += shiftY; }
        const out = emitPlan(q);
        const na = normalizeAnchor(q);
        const d = out.ok ? decodeBlueprint(out.blueprint) : null;
        const sameFlat = !!d && JSON.stringify(d.entities) === JSON.stringify(decodeBlueprint(outBase.blueprint).entities);
        const nonNeg = !!d && out.beltIntent.every(b => b.dx >= 0 && b.dy >= 0);
        const anchorIsMin = !!d && out.beltIntent.every(b => b.x >= out.anchor[0] && b.y >= out.anchor[1]) &&
            out.beltIntent.some(b => b.x === out.anchor[0]) && out.beltIntent.some(b => b.y === out.anchor[1]);
        const worldMap = !!d && out.beltIntent.every(b => b.x === q.site.anchor[0] + (b.dx + shiftX) && b.y === q.site.anchor[1] + (b.dy + shiftY));
        say(out.ok === true && sameFlat && nonNeg && anchorIsMin && worldMap &&
            out.anchor[0] === na.anchor[0] && out.anchor[1] === na.anchor[1],
            `锚点归一：${label}`, out.ok ? `w=${JSON.stringify(out.anchor)} e 不变=${sameFlat} 非负=${nonNeg} 世界可复原=${worldMap}` : `reason=${out.reason} got=${JSON.stringify(out.got)}`);
    }
    // 换 site.anchor（几何整体平移）：e 数组不变，世界坐标跟着走
    const q2 = clone(base); q2.site.anchor = [q2.site.anchor[0] + 300, q2.site.anchor[1] - 220];
    const out2 = emitPlan(q2);
    const shiftSame = out2.ok && JSON.stringify(decodeBlueprint(out2.blueprint).entities) === JSON.stringify(decodeBlueprint(outBase.blueprint).entities);
    const worldShifted = out2.ok && out2.beltIntent.every((b, i) => b.x === outBase.beltIntent[i].x + 300 && b.y === outBase.beltIntent[i].y - 220);
    say(shiftSame && worldShifted, "site.anchor 平移只挪 w，e 数组逐元素不变", `w=${JSON.stringify(out2.anchor)} vs ${JSON.stringify(outBase.anchor)}；世界平移=${worldShifted}`);
}

/* ── 3. chargeMode 口径 ── */
{
    const q = clone(base); q.stats.chargeMode = "auto";
    const out = emitPlan(q);
    say(out.ok === true && out.chargeMode === "false" && out.plan.stats.chargeMode === "false" && out.warnings.length > 0,
        '入参 chargeMode:"auto" 被钉成 "false" + warning', `emit=${out.chargeMode} stats=${out.plan.stats.chargeMode} warn=${JSON.stringify(out.warnings)}`);
    const q2 = clone(base); q2.stats.chargeMode = "false";
    const out2 = emitPlan(q2);
    say(out2.ok === true && out2.warnings.length === 0, "v1 口径（false）不产生噪音 warning", `warn=${JSON.stringify(out2.warnings)}`);
    const q3 = clone(base); q3.stats.chargeMode = "nope";
    const out3 = emitPlan(q3);
    say(out3.ok === false, "非法 chargeMode → 契约拒（不静默改）", `reason=${out3.reason} gate=${out3.gate}`);
}

/* ── 4. diffCells 的反证（L1-1 的判据真的能抓到错位） ── */
{
    const out = emitPlan(base);
    if (out.ok) {
        const d = decodeBlueprint(out.blueprint);
        const tampered = d.entities.map((e, i) => (i === 0 ? { ...e, rot: 90 } : e));
        say(diffCells(tampered, out.beltIntent).length === 1, "diffCells 能抓到单格篡改（判据不是恒真）", JSON.stringify(diffCells(tampered, out.beltIntent)));
        say(diffCells(d.entities.slice(0, -1), out.beltIntent).length > 0, "diffCells 能抓到数量不符");
        say(diffCells(d.entities, out.beltIntent).length === 0, "diffCells 对未篡改返回空");
    }
}

/* ── 5. 交接件可读（P8 的 out/*.szbp.txt + intent.json 口径，plan §4.6） ── */
{
    const out = emitPlan(base);
    if (out.ok) {
        const text = out.blueprint;
        const ok = typeof text === "string" && text.startsWith("SZBP1.") && /^SZBP1\.[A-Za-z0-9+\-$.]+$/.test(text);
        say(ok, "蓝图文本仅含 [A-Za-z0-9+\\-$.]（PROTOCOL §6：可安全塞进 JSON/剪贴板）", text.slice(0, 32));
        const intentJson = JSON.stringify({ anchor: out.anchor, hub: base.site.hub, chargeMode: out.chargeMode, beltIntent: out.beltIntent });
        say(JSON.parse(intentJson).beltIntent.length === out.count, "intent.json 可 JSON 往返（P7 只读这个）", `${intentJson.length} 字节`);
        say(fs.existsSync(path.join(ROOT, "research", "ai-plan", "fixtures", "plan-l1.json")), "共享金样例仍只读存在");
    }
}

console.log(fails ? `\nprobe: ${fails} 条失败` : "\nprobe: 全部通过");
if (fails) process.exitCode = 1;
