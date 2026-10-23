/**
 * op-templates.test.mjs — P2 data 包对 op-templates.mjs 的独立验收（L0）
 *
 * 与 `node src/ai/op-templates.mjs --test` **互为双实现**：那边是"自证"（表自身一致），
 * 这边是"验收"（对着**原始凭据文件**重新核一遍，不信任内嵌表的写法）。
 * 两份代码读同一批事实（building-codes-live.json / GEOMETRY 表1）→ 任一处改错就红。
 *
 * 运行：node research/ai-plan/data/op-templates.test.mjs --test
 *
 * 自包含纪律：断言一律用普通对象 + JSON 比较；**不 import P1 的 types.mjs**
 * （P1 可能还在写；TODO(P1 落地后)：换成 errors.mjs 的 ContractViolation / assert* 以保持
 * 与其余包统一的错误形态。）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    OP_TEMPLATES, AUX_TEMPLATES, ALL_TEMPLATES, MACHINE_CODES, RATES, UNLOCK_LEVEL_FALLBACK,
    codeFor, rotateSlot, rotateLocal, beltCode, worldSlots, machineWorldBounds, assertV1Rotation,
    opByName, templateForBuildingCode, loadMachineSpec, specGapReport, bottleneckOf, SpecError,
} from "../../../src/ai/op-templates.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const LIVE_CODES = path.join(REPO, "research", "ai-player", "facts", "building-codes-live.json");
const GEO_MD = path.join(REPO, "research", "ai-player", "facts", "GEOMETRY-TABLE.md");

let failed = 0, passed = 0;
const eq = (label, got, want) => {
    const a = JSON.stringify(got), b = JSON.stringify(want);
    if (a === b) { passed++; console.log("  ✓ " + label); }
    else { failed++; console.log(`  ✗ ${label}\n      got  ${a}\n      want ${b}`); }
};
const ok = (label, cond, detail = "") => {
    if (cond) { passed++; console.log("  ✓ " + label); }
    else { failed++; console.log(`  ✗ ${label} ${detail}`); }
};
const throwsSpec = (label, fn, msgPart = "") => {
    try { fn(); failed++; console.log(`  ✗ ${label} —— 未抛错`); }
    catch (e) {
        if (!(e instanceof SpecError)) { failed++; console.log(`  ✗ ${label} —— 抛的不是 SpecError：${e.name} ${e.message}`); return; }
        if (msgPart && !String(e.message).includes(msgPart)) { failed++; console.log(`  ✗ ${label} —— 消息不含 "${msgPart}"：${e.message}`); return; }
        passed++; console.log(`  ✓ ${label}（${e.name} / ${e.reason}）`);
    }
};

const rots = [0, 90, 180, 270], dirs = ["top", "right", "bottom", "left"];

/* ══════════════════════════ 1. 15 条实机 code 逐条对拍 ══════════════════════════ */
console.log("\n[1] 实机 code 表（facts/building-codes-live.json 逐条）");
const live = JSON.parse(fs.readFileSync(LIVE_CODES, "utf8"));
ok(`实机记录条数 = ${live.length}`, live.length === 60, "应为 60 条（15 组合 × 4 朝向）");
ok("全部实机记录 rotation_variant = 0（H2 的证据基础）", live.every(r => r.rotation_variant === 0));
for (const r of live) {
    if (r.building === "belt") continue;                    // belt 单独走 H1
    eq(`codeFor(${r.building},${r.variant},r=${r.rotation},rv=0) == ${r.code}`,
        codeFor(r.building, r.variant, r.rotation, 0), r.code);
}
// belt：实机 4 条 r=0/90/180/270 全 rv=0 → code 1 = beltCode(0)
const belts = live.filter(r => r.building === "belt");
eq("belt 实机 rv=0 → code 1", belts.map(b => b.code), [1, 1, 1, 1]);
eq("belt 实机 code == beltCode(rv)", belts.map(b => codeFor("belt", "default", b.rotation, b.rotation_variant)), belts.map(b => b.code));
eq("去重后 code 集 = plan §2.2 的 15 条",
    [...new Set(live.map(r => r.code))].sort((a, b) => a - b),
    [1, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
// MACHINE_CODES 必须与实机逐键相等（按 key 排序后比，避免声明顺序造成假失败）
const sortedObj = o => JSON.stringify(Object.fromEntries(Object.entries(o).sort((a, b) => (a[0] < b[0] ? -1 : 1))));
const fromLive = {};
for (const r of live) if (r.building !== "belt") fromLive[`${r.building}|${r.variant}`] = r.code;
eq("MACHINE_CODES 与实机逐键一致（belt 除外）", sortedObj(MACHINE_CODES), sortedObj(fromLive));

/* ══════════════════════════ 2. 槽位数 == GEOMETRY 表1 ══════════════════════════ */
console.log("\n[2] 槽位/占地（GEOMETRY-TABLE 表1，只在 r=0 定义）");
/** 期望值手抄自 facts/GEOMETRY-TABLE.md:13-23 —— 与 op-templates.mjs 内嵌表相互独立 */
const GEO = {
    //      [footprint, [输入描述], [输出描述], verifiedOnLive]
    mine:   [[1, 1], [], [["top", "out"]], true],
    cut:    [[2, 1], [["bottom"]], [["top", "left"], ["top", "right"]], true],
    cutQuad:[[4, 1], [["bottom"]], [["top"], ["top"], ["top"], ["top"]], false],
    rotate: [[1, 1], [["bottom"]], [["top"]], false],
    paint:  [[2, 1], [["left"], ["top"]], [["right"]], true],
    mix:    [[2, 1], [["bottom"], ["bottom"]], [["top"]], false],
    stack:  [[2, 1], [["bottom"], ["bottom"]], [["top"]], true],
};
for (const [op, [fp, ins, outs, verified]] of Object.entries(GEO)) {
    const t = OP_TEMPLATES[op];
    ok(`${op} 模板存在`, !!t);
    eq(`${op} footprint`, t.footprint, fp);
    eq(`${op} 输入槽数 == 表1`, t.inputs.length, ins.length);
    eq(`${op} 输出槽数 == 表1`, t.outputs.length, outs.length);
    eq(`${op} 输入槽方位`, t.inputs.map(s => s.dir), ins.map(a => a[0]));
    eq(`${op} 输出槽方位`, t.outputs.map(s => s.dir), outs.map(a => a[0] ?? "top"));
    eq(`${op} verifiedOnLive 承表1 的 ✅/⬜`, t.verifiedOnLive, verified);
    eq(`${op} 全部槽位在 r=0 局部帧内（cell 非负、dy=0 起）`,
        [...t.inputs, ...t.outputs].every(s => s.cell[0] >= 0 && s.cell[1] >= 0 && s.cell[0] < fp[0] && s.cell[1] < fp[1]), true);
}
// 文档一致性：GEOMETRY-TABLE.md 里出现的建筑名都要有模板（防文档与代码漂移）
const geoMd = fs.readFileSync(GEO_MD, "utf8");
for (const b of ["miner", "cutter", "rotater", "stacker", "painter", "mixer", "trash", "belt", "hub"]) {
    ok(`GEOMETRY 表1 提及建筑 ${b}`, geoMd.includes(`**${b}**`) || geoMd.includes(b));
}
// 关键语义三条（验收点名的）
eq("trash = code 20", codeFor("trash", "default", 0, 0), 20);
eq("stacker 左格=下层 / 右格=上层（M3 实机映射）",
    OP_TEMPLATES.stack.inputs.map(s => `${s.cell.join(",")}=${s.role}`), ["0,0=lower", "1,0=upper"]);
eq("painter shape←left / color←top / 出→right（M2a 实机）",
    [...OP_TEMPLATES.paint.inputs.map(s => `${s.role}←${s.dir}`), `出→${OP_TEMPLATES.paint.outputs[0].dir}`],
    ["shape←left", "color←top", "出→right"]);
eq("cutter 左格 top=左列 / 右格 top=右列（M1b 实机）",
    OP_TEMPLATES.cut.outputs.map(s => `${s.cell.join(",")}:${s.dir}=${s.role}`), ["0,0:top=left", "1,0:top=right"]);
eq("废槽默认规则：cutter 右列 = 废料（mustDiscardUnused + wasteRoles）",
    [OP_TEMPLATES.cut.mustDiscardUnused, OP_TEMPLATES.cut.wasteRoles], [true, ["right"]]);
ok("所有加工 op 都 mustDiscardUnused（陷阱表 #7）",
    Object.values(OP_TEMPLATES).every(t => t.mustDiscardUnused === true));

/* ══════════════════════════ 3. 速率表（V7 要用 stacker:0.25） ══════════════════════════ */
console.log("\n[3] 速率（GEOMETRY-TABLE 表2）");
eq("RATES 全表（含 stacker 0.25）", { ...RATES },
    { belt: 2.0, miner: 0.4, rotater: 2.0, cutter: 0.5, stacker: 0.25, painter: 0.33, mixer: 0.4, trash: 0, hub: 0 });
eq("stacker 是全场最慢（工厂瓶颈）",
    Object.entries(RATES).filter(([, v]) => v > 0).sort((a, b) => a[1] - b[1])[0][0], "stacker");
eq("bottleneckOf 含 stacker 的链", bottleneckOf(["mine", "paint", "stack"]), "stack@0.25");
eq("文档表2 的数值都能在代码里找到", [0.25, 0.33, 0.4, 0.5, 2.0].every(v => Object.values(RATES).includes(v)), true);
ok("GEOMETRY 文档写了 stacker 0.25", geoMd.includes("0.25"));

/* ══════════════════════════ 4. 硬断言 H1/H2/H3 ══════════════════════════ */
console.log("\n[4] 硬断言");
// H1 belt 族唯一权威
eq("belt rv0/1/2 → 1/2/3", [0, 1, 2].map(rv => codeFor("belt", "default", 0, rv)), [1, 2, 3]);
eq("belt code 与 rot 完全无关", [0, 90, 180, 270].map(r => [0, 1, 2].map(rv => codeFor("belt", "default", r, rv))),
    [[1, 2, 3], [1, 2, 3], [1, 2, 3], [1, 2, 3]]);
throwsSpec("belt rv 越界（3）→ 抛", () => codeFor("belt", "default", 0, 3), "rv ∈ {0,1,2}");
throwsSpec("belt rv 负数 → 抛", () => codeFor("belt", "default", 0, -1), "rv ∈ {0,1,2}");
// H2 非 belt 只出 rv=0
for (const key of Object.keys(MACHINE_CODES)) {
    const [b, v] = key.split("|");
    throwsSpec(`非 belt ${key} rv=1 → 结构化抛错`, () => codeFor(b, v, 0, 1), "rv 必须为 0");
    throwsSpec(`非 belt ${key} rv=2 → 结构化抛错`, () => codeFor(b, v, 0, 2), "rv 必须为 0");
}
eq("抛错对象带 reason 分诊字段（§2.5 枚举成员）",
    (() => { try { codeFor("cutter", "default", 0, 1); } catch (e) { return e.reason; } })(),
    "out-of-scope:rotated-machine");
eq("抛错对象可归一为 {ok:false,reason,failingNode,hint}",
    (() => { try { codeFor("cutter", "default", 0, 1); } catch (e) { return Object.keys(e.failure).sort(); } })(),
    ["failingNode", "hint", "ok", "reason"]);
// 非象限角度：**拒绝**而不是静默截断。belt-rules.rotateLocal 对非 90 倍数角度是 `|0` 截断
// （45° 被当 0° 用），而同文件的 angleToDir 是量化到最近象限 —— 两者语义不同（NOTES G7）。
for (const bad of [45, 91, 179, 181, 359, -1, 100]) {
    throwsSpec(`非象限角 rot=${bad} → codeFor 拒绝（不静默截断）`, () => codeFor("cutter", "default", bad, 0), "0|90|180|270");
    throwsSpec(`非象限角 rot=${bad} → rotateSlot 拒绝`, () => rotateSlot("top", bad), "0|90|180|270");
}
eq("象限角（含负角/超 360）正常通过", [0, 90, 180, 270, -90, 450].map(a => codeFor("belt", "default", a, 0)), [1, 1, 1, 1, 1, 1]);
eq("rotateSlot 与底层 rotateLocal 在象限角上完全一致（委托，不二次实现）",
    rots.flatMap(r => dirs.map(d => rotateSlot(d, r))), rots.flatMap(r => dirs.map(d => rotateLocal(d, r))));
// H3 v1 朝向恒 0
for (const b of ["cutter", "stacker", "painter", "mixer", "rotater", "miner"]) {
    throwsSpec(`v1 加工机器 ${b} rot=90 → assertV1Rotation 抛`, () => assertV1Rotation(b, 90), "rotation 必须为 0");
    ok(`v1 加工机器 ${b} rot=0 放行`, assertV1Rotation(b, 0) === 0);
}
ok("belt rot=270 放行（带子本来就要转向）", assertV1Rotation("belt", 270) === 270);
ok("trash rot=180 放行（四边全收，朝向无意义）", assertV1Rotation("trash", 180) === 180);
throwsSpec("assertV1Rotation 也拒绝非象限角", () => assertV1Rotation("belt", 45), "0|90|180|270");

/* ══════════════════════════ 5. 世界槽位 = rotateLocal（复用 belt-rules，无二次实现） ══════════════════════════ */
console.log("\n[5] 旋转律：世界槽位 = rotateLocal(局部, rotation)");
// 委托证明：在全部 4×4 象限角组合上与底层 rotateLocal **逐项相等**（本包不自己算方向）
for (const r of rots) for (const d of dirs) eq(`rotateSlot(${d},${r}) == rotateLocal(${d},${r})`, rotateSlot(d, r), rotateLocal(d, r));
ok("rotateSlot 内部委托 belt-rules.rotateLocal（本文件不自己算方向）",
    (() => {
        const s = fs.readFileSync(path.join(REPO, "src", "ai", "op-templates.mjs"), "utf8");
        const i = s.indexOf("export function rotateSlot");
        return s.slice(i, i + 600).includes("rotateLocal(localDir, rotation)") && !/const\s+ORDER\s*=/.test(s);
    })(), true);
// v1 恒 r=0：世界 == 局部
for (const op of Object.keys(OP_TEMPLATES)) {
    eq(`${op} r=0 时世界槽位 == 局部槽位`,
        worldSlots(opByName(op), 0).inputs.map(s => s.dir), OP_TEMPLATES[op].inputs.map(s => s.dir));
}
// 方形机器（未来支持旋转）：rot=90 顺时针
eq("rotate 1×1 rot=90：下进上出 → 左进右出",
    [worldSlots(OP_TEMPLATES.rotate, 90).inputs[0].dir, worldSlots(OP_TEMPLATES.rotate, 90).outputs[0].dir],
    ["left", "right"]);
eq("rotate 1×1 rot=180：bottom→top / top→bottom",
    [worldSlots(OP_TEMPLATES.rotate, 180).inputs[0].dir, worldSlots(OP_TEMPLATES.rotate, 180).outputs[0].dir],
    ["top", "bottom"]);
// 非方形 rot≠0 必须拦住（不假装会算 origin 位移）
throwsSpec("cutter 2×1 rot=90 → 抛（origin 位移未实机验证）", () => worldSlots(OP_TEMPLATES.cut, 90), "只允许 rotation=0");
throwsSpec("stacker 2×1 rot=270 → 抛", () => worldSlots(OP_TEMPLATES.stack, 270), "只允许 rotation=0");
throwsSpec("rotateSlot 非法方位 → 抛", () => rotateSlot("up", 0), "top|right|bottom|left");
// v1 包围盒
eq("v1 bounds stacker @(100,-200)", machineWorldBounds(OP_TEMPLATES.stack, [100, -200], 0),
    { x0: 100, y0: -200, x1: 101, y1: -200, w: 2, h: 1 });
eq("v1 bounds cutQuad @(0,0)", machineWorldBounds(OP_TEMPLATES.cutQuad, [0, 0], 0),
    { x0: 0, y0: 0, x1: 3, y1: 0, w: 4, h: 1 });

/* ══════════════════════════ 6. 归一形式：字段齐全（plan §2.2 契约） ══════════════════════════ */
console.log("\n[6] OpTemplate 字段契约");
const REQ = ["op", "building", "variant", "code", "unlockLevel", "footprint", "inputs", "outputs",
             "ratePerSec", "mustDiscardUnused", "verifiedOnLive"];
for (const op of Object.keys(OP_TEMPLATES)) {
    const t = OP_TEMPLATES[op];
    eq(`${op} 含 §2.2 全部字段`, REQ.every(k => t[k] !== undefined), true);
    eq(`${op} slot 元素形如 {cell:[x,y], dir, role}`,
        [...t.inputs, ...t.outputs].every(s => Array.isArray(s.cell) && s.cell.length === 2 &&
            typeof s.dir === "string" && typeof s.role === "string"), true);
    eq(`${op} code == codeFor(building,variant,0,0)`, t.code, codeFor(t.building, t.variant, 0, 0));
    eq(`${op} unlockLevel 为正整数或 null`, Number.isInteger(t.unlockLevel) && t.unlockLevel >= 1, true);
}
eq("op 枚举覆盖 plan §2.2", Object.keys(OP_TEMPLATES).sort(),
    ["cut", "cutQuad", "mix", "mine", "paint", "paintMirrored", "rotate", "rotate180", "rotateCCW", "stack"].sort());
eq("AUX 覆盖非 op 但必须的实体", Object.keys(AUX_TEMPLATES).sort(), ["belt", "mineChainable", "paintDouble", "paintQuad", "trash"]);
eq("code 全局唯一（反查不歧义）",
    new Set(Object.values(ALL_TEMPLATES).map(t => t.code)).size, Object.values(ALL_TEMPLATES).length);
for (const c of [1, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) {
    ok(`code ${c} 可反查模板（P6 自检：summarizeBlueprint 不解 code→名字）`, templateForBuildingCode(c) !== null);
}
eq("反查 code→op 全表",
    [1, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map(c => templateForBuildingCode(c).op),
    ["belt", "mine", "mineChainable", "cut", "cutQuad", "rotate", "rotateCCW", "rotate180", "stack", "mix",
     "paint", "paintMirrored", "paintDouble", "paintQuad", "trash"]);

/* ══════════════════════════ 7. loadMachineSpec：不被 P0-spec 卡住 ══════════════════════════ */
console.log("\n[7] machine-spec 适配（迁移路径 5 条）");
const specPath = path.join(REPO, "src", "ai", "machine-spec.json");
const s0 = loadMachineSpec(specPath);
ok(`内嵌表独立可用（machine-spec.json ${fs.existsSync(specPath) ? "存在" : "不存在"}，recognized=${s0.recognized}）`,
    Object.keys(s0.templates).length >= 10 && Array.isArray(s0.gaps));
eq("无 spec 时内嵌表原样（stack 槽位不变）", s0.templates.stack.inputs.map(x => x.role), ["lower", "upper"]);
ok("缺口清单非空（rv 编码无证据等）", specGapReport().length > 0);
// 合成 spec：验证「覆盖 + 冲突登记 + 不 fork」
const sample = path.join(HERE, "fixtures", "spec-sample.json");
fs.mkdirSync(path.dirname(sample), { recursive: true });
// 与 op-templates.mjs --test 写的是同一份样本；这里也保证存在，使本测试可独立跑
fs.writeFileSync(sample, JSON.stringify([
    { id: "cutter|default", building: "cutter", variant: "default", code: 999, unlockLevel: 1, ratePerSec: 0.5,
      inputs: [{ cell: [0, 0], dir: "bottom" }],
      outputs: [{ cell: [0, 0], dir: "top" }, { cell: [1, 0], dir: "top" }, { cell: [2, 0], dir: "top" }] },
    { id: "belt|default", building: "belt", variant: "default", code: 777 },
    { id: "stacker|default", building: "stacker", variant: "default", code: 14, unlockLevel: 12, footprint: [2, 1], ratePerSec: 0.5 },
    { id: "weird|default", building: "weird", code: 42 },
], null, 1) + "\n");
ok(`本包私有 fixture 就位 research/ai-plan/data/fixtures/spec-sample.json`, fs.existsSync(sample));
const s1 = loadMachineSpec(sample);
eq("合成 spec recognized", s1.recognized, true);
eq("belt code 冲突：以 belt-rules 为准（kept=1，spec=777 被驳回）",
    s1.diffs.filter(d => d.op === "belt").map(d => [d.embedded, d.spec, d.kept]), [[1, 777, 1]]);
eq("非 belt code 分歧：实机值保留", s1.diffs.filter(d => d.op === "cut" && d.field === "code").map(d => d.kept), [9]);
eq("spec 覆盖生效（unlockLevel / ratePerSec）",
    [s1.templates.stack.unlockLevel, s1.templates.stack.ratePerSec], [12, 0.5]);
eq("GEOMETRY 槽位数权威不被 spec 改写（差异登记、值保留）",
    [s1.templates.cut.inputs.length, s1.templates.cut.outputs.length], [1, 2]);
ok("未知 building|variant 进 gaps 而不是崩", s1.gaps.some(g => g.includes("weird")));
throwsSpec("spec 覆盖后 H2 仍成立（stack rv=1 抛）", () => codeFor("stacker", "default", 0, 1), "rv 必须为 0");
// 不可识别 schema → 保内嵌 + gap，绝不要求 P0-spec 改文件
const bad = path.join(HERE, "fixtures", "spec-unrecognizable.json");
fs.writeFileSync(bad, JSON.stringify({ hello: "world" }));
const s2 = loadMachineSpec(bad);
eq("不可识别 schema → recognized:false", s2.recognized, false);
eq("不可识别 → 内嵌表保留", s2.templates.paint.inputs.map(x => x.dir), ["left", "top"]);
ok("不可识别 → 记 gap（不抛错）", s2.gaps.length > 0, JSON.stringify(s2.gaps));
fs.rmSync(bad);
// 兜底常量（C7：god-mode 口径下仍回报解锁等级）
eq("§2.2 兜底常量", Object.fromEntries(["mine", "cut", "rotate", "paint", "mix", "stack"].map(k => [k, UNLOCK_LEVEL_FALLBACK[k]])),
    { mine: 1, cut: 1, rotate: 4, paint: 6, mix: 8, stack: 10 });

/* ══════════════════════════ 8. 零依赖 / 不越界 ══════════════════════════ */
console.log("\n[8] 包边界");
const src = fs.readFileSync(path.join(REPO, "src", "ai", "op-templates.mjs"), "utf8");
const importLines = [...src.matchAll(/^import\b.*$/gm)].map(m => m[0]).join("\n");
ok("没有 import proto/belt-rules（红队 #1）", !/proto\/belt-rules/.test(src));
ok("import 行只有 node: 内置 + ./belt-rules.mjs",
    importLines.split("\n").every(l => /from\s+["'](node:[^'"]+|\.\/belt-rules\.mjs)["']/.test(l)), importLines);
ok("不 import P3-P8 任何文件", !/compiler\/(place|route|lane|validate|belt-sim|emit|roundtrip|compile|cli)/.test(importLines));
ok("不 import P1（保持自包含，见文件头 TODO）", !/compiler\/(types|grid|errors)/.test(importLines));
ok("无网络/RPC 调用", !/fetch\(|WebSocket|127\.0\.0\.1:7777/.test(src));

console.log(`\n${failed ? "✗" : "✓"} op-templates.test：${passed} 通过 / ${failed} 失败`);
process.exitCode = failed ? 1 : 0;
