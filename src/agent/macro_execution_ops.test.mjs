/**
 * macro_execution_ops.test.mjs — 宏给出的「执行提示」必须能被 mod 真的执行。
 *
 * 为什么需要这条测试（factcheck §1 实测）：
 *   宏是纯规划器，它返回 `ok:true` 之后，**真正落盘的是 tx 里的 op**。
 *   而 op 的字段白名单由 mod 的 `actionSpecs()` 定义（`place` 只有
 *   `building,x,y,r,variant,rotationVariant,rv,originalRotation,orig`，**没有 code**）。
 *   宏曾经在自己的 `execution.note` 里教人写 `place{code:9,...}` —— 照抄就直接 2001。
 *
 *   这不是"文档笔误"：`loop.mjs` 会读 `execution` 来决定怎么发 op。提示错了，
 *   loop 就错；而且错在**最后一米**（规划全绿、落盘被拒），最难查。
 *
 * 所以本测试做一件很硬的事：把宏产出的每一个 `execution.tx_ops` 元素，
 * 逐条喂给**从 mod 源码里真实加载出来的** `validateAction()`。
 * 不复制白名单 —— 复制就是第二份真值，会立刻腐烂。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { insertMachine, extendLine } from "./macros/place.mjs";
import { replaceRun } from "./macros/remove.mjs";
import { connect } from "./macros/connect.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const MOD_SRC = path.join(REPO, "src/mod/shapez-ai-bridge.js");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
    if (cond && typeof cond.then === "function") {
        fail++; failures.push(label + " [Promise 当布尔]");
        console.log("✗ " + label + "  [cond 是 Promise，漏了 await？]");
        return;
    }
    if (cond) { pass++; console.log("✓ " + label); }
    else { fail++; failures.push(label); console.log("✗ " + label + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 300) : "")); }
}

/* ─────────── 1. 从 mod 源码加载真实的 validateAction ─────────── */

/** 最小可用的 shapez 桩。`validateAction` 只用到 Buildings/gBuildingRegistry 这一层，
 *  但 mod 的类体在加载时就会 `class Mod extends shapez.Mod`，所以必须给 Mod 基类。 */
function stubShapez() {
    const mkMeta = (type, w, h, code, layer = "regular", rotatable = false) => ({
        getIsRotateable: () => rotatable,
        getIsRemovable: () => true,
        getRotationVariantCount: () => 1,
        getLayer: () => layer,
        getSprite: () => ({}),
        getCode: () => code,
        getSize: () => ({ x: w, y: h }),
        getId: () => type,
        type,
    });
    const byCode = {
        1: { metaInstance: mkMeta("belt", 1, 1, 1), variant: "default", rotationVariant: 0 },
        9: { metaInstance: mkMeta("cutter", 2, 1, 9), variant: "default", rotationVariant: 0 },
        20: { metaInstance: mkMeta("trash", 1, 1, 20), variant: "default", rotationVariant: 0 },
        7: { metaInstance: mkMeta("miner", 2, 2, 7), variant: "default", rotationVariant: 0 },
    };
    const variants = {
        getEntries: () => Object.values(byCode),
    };
    return {
        Mod: class BaseMod { constructor(_p) {} },
        Buildings: {
            getBuildingDataFromCode: (c) => byCode[c] || null,
            belt: byCode[1],
        },
        gBuildingVariants: variants,
        gBuildingRegistry: [],
        Atlas: { getSpriteByName: () => ({}) },
        enumLayerToId: () => 0,
        Vector: class { constructor(x = 0, y = 0) { this.x = x; this.y = y; } },
    };
}

function loadModClass() {
    const sourceText = fs.readFileSync(MOD_SRC, "utf8");
    const sb = {
        console: { log() {}, warn() {}, error() {} },
        performance, setTimeout, clearTimeout, setInterval, clearInterval,
        JSON, Math, Number, String, Object, Array, Error, Map, Set, Promise,
        WebSocket: class { constructor() { this.readyState = 0; } send() {} close() {} },
        window: { shapez: stubShapez(), APP_ERROR_OCCURED: false },
    };
    sb.shapez = sb.window.shapez;
    sb.globalThis = sb;
    vm.createContext(sb);
    let registered = null;
    sb.window.$shapez_registerMod = (modClass, meta) => { registered = { modClass, meta }; };
    vm.runInContext(
        sourceText + "\nif (typeof Mod !== 'undefined') { window.$shapez_registerMod(Mod, METADATA); }",
        sb, { filename: "shapez-ai-bridge.js" },
    );
    if (!registered) throw new Error("mod 没注册成功");
    return new registered.modClass({
        app: { stateMgr: { currentState: null }, savegameMgr: {} },
        modLoader: { modInterface: {}, signals: { gameStarted: { add() {} }, stateEntered: { add() {} } } },
        meta: registered.meta,
        settings: { ws_url: "ws://x", allow_step: true, allow_write: true, max_entities: 20000 },
        saveSettings: () => {},
    });
}

/** 把一条 op 过 mod 的 validateAction；返回 null 表示合法，否则返回错误说明。 */
function opViolation(mod, op) {
    try { mod.validateAction(op); return null; }
    catch (e) {
        const d = (e && e.__rpcError) || {};
        return {
            message: String((d.detail || (e && e.message) || e)),
            allowed: d.hint || null,
        };
    }
}

/* ─────────── 2. 夹具世界 ─────────── */

function world() {
    // 一条 6 格横带（y=0, x=0..5，朝右），右侧一台 miner 作宿；上方一台 trash 收副产品
    const ents = [];
    for (let x = 0; x < 6; x++) {
        ents.push({ uid: 100 + x, type: "belt", x, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 1 });
    }
    ents.push({ uid: 200, type: "miner", x: 8, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 7 });
    ents.push({ uid: 300, type: "trash", x: 2, y: -3, r: 0, variant: "default", rotation_variant: 0, code: 20 });
    return ents;
}
const ENT = world();

/* ─────────── 3. 测试 ─────────── */

const mod = loadModClass();

ok(typeof mod.validateAction === "function", "mod 加载成功，validateAction 可用");

/* 3a. 白名单本身：确认 place 真的不收 code —— 否则下面的测试没有意义 */
{
    const bad = opViolation(mod, { op: "place", building: "cutter", x: 1, y: 1, r: 0, code: 9 });
    ok(bad !== null, "前提核实：place{code:...} 确实被 mod 拒绝（白名单没有 code）", bad);
    ok(bad && /code/.test(bad.message), "前提核实：拒绝信息点名了 code 字段", bad && bad.message);

    const good = opViolation(mod, { op: "place", building: "cutter", x: 1, y: 1, r: 0 });
    ok(good === null, "前提核实：place 不带 code 是合法的", good);
}

/* 3b. insert_machine 的 execution.tx_ops 必须逐条合法 */
{
    const r = insertMachine({ at: [3, 0], facing: "top", machine: "cutter" }, { entities: ENT });
    ok(r.ok, "insert_machine 规划成功", r.error);
    if (r.ok) {
        ok(Array.isArray(r.execution.tx_ops) && r.execution.tx_ops.length > 0,
            "insert_machine.execution 带 tx_ops 数组（loop 可以直接用，不必自己拼）",
            r.execution && Object.keys(r.execution));
        const v = (r.execution.tx_ops || []).map((op, i) => ({ i, op, why: opViolation(mod, op) })).filter(x => x.why);
        ok(v.length === 0, "insert_machine 的每个 tx_op 都过 mod 的 validateAction", v);
        ok(!/code:/.test(r.execution.note || ""),
            "insert_machine.execution.note 不再教人写 place{code:...}（照抄会 2001）", r.execution.note);
        ok(!/paste_blueprint/.test(JSON.stringify(r.execution)),
            "insert_machine.execution 不再推荐 paste_blueprint", r.execution);
    }
}

/* 3c. extend_line 的 execution.tx_ops 必须逐条合法，且不再指向 paste_blueprint */
{
    const r = extendLine({ from: { uid: 105 }, dir: "right", len: 3 }, { entities: ENT });
    ok(r.ok, "extend_line 规划成功", r.error);
    if (r.ok) {
        ok(r.execution.method !== "paste_blueprint",
            "extend_line.execution.method 不再是 paste_blueprint（它不在 tx 白名单且会扣 hub 的货）",
            r.execution.method);
        ok(Array.isArray(r.execution.tx_ops) && r.execution.tx_ops.length === r.cells_planned,
            "extend_line 的 tx_ops 数量 = cells_planned",
            { ops: r.execution.tx_ops && r.execution.tx_ops.length, planned: r.cells_planned });
        const v = (r.execution.tx_ops || []).map((op, i) => ({ i, op, why: opViolation(mod, op) })).filter(x => x.why);
        ok(v.length === 0, "extend_line 的每个 tx_op 都过 mod 的 validateAction", v);
        // 每一格必须带 rotationVariant（rv 由宏反解，游戏会按邻居重算，必须显式下发 + 读回）
        ok((r.execution.tx_ops || []).every(op => typeof op.rotationVariant === "number"),
            "extend_line 的每个 place 都带 rotationVariant（不能靠游戏猜）",
            (r.execution.tx_ops || []).filter(op => typeof op.rotationVariant !== "number"));
    }
}

/* 3d. connect 的 cells[] → tx op 的映射：**用真实存档穷举，并断言实测结果**
 *
 *     ⚠️ 这条测试曾经写错过一次，值得记下来（红队抓到的）：
 *     我最初只枚举 `cutter/trash/hub` 三类机器、且 port 只试了 `left/right`，
 *     于是得出「真实存档上 connect 一次都连不成」——**那是枚举范围太窄造成的错误结论**。
 *     正确做法：枚举**所有非带子实体** × **所有角色名**（`primary/secondary/…`），
 *     因为 balancer 的角色名就是 primary/secondary，不是 left/right。
 *
 *     实测（正确枚举）：23 种组合成功，其中 **10 条直达 hub**，来源全是 balancer。
 *     ⇒ 「connect 在真实存档上没用」是错的；但「connect 是主力」也未被证实
 *       （L4 的正解是一条 replace_run，不需要 connect）。
 */
{
    const real = JSON.parse(fs.readFileSync(path.join(REPO, "test/fixtures/saves/L5-obs.json"), "utf8"));
    const ents = (real.result || real).entities;
    /* ★ 枚举所有非带子实体，不是只挑三种；port 枚举要包含实际角色名 ★ */
    const machines = ents.filter(e => !["belt", "underground_belt"].includes(e.type));
    const { ERROR_CODES: ERROR_CODE_TABLE } = await import("./macros/contract.mjs");
    const codes = new Set(Object.keys(ERROR_CODE_TABLE));
    /* 角色名闭集取自 op-templates 的真实表，而不是我猜的几个 */
    const { templateByBuildingVariant } = await import("../ai/op-templates.mjs");
    const rolesOf = (e) => {
        const tpl = templateByBuildingVariant(e.type, e.variant || "default");
        if (!tpl) return [];
        const rs = new Set();
        for (const p of [...(tpl.inputs || []), ...(tpl.outputs || [])]) if (p.role) rs.add(p.role);
        return [...rs];
    };

    const hist = {};
    const badCodes = new Set();
    const successes = [];
    let mapped = 0;
    for (const a of machines) {
        for (const bb of machines) {
            if (a.uid === bb.uid) continue;
            const portsA = [undefined, ...rolesOf(a)];
            const portsB = rolesOf(bb).length ? rolesOf(bb) : ["primary"];
            for (const pa of portsA) {
                for (const roleB of portsB) {
                    for (let idx = 0; idx < 3; idx++) {
                        const r = connect(
                            { from: { uid: a.uid, ...(pa ? { port: pa } : {}) }, to: { uid: bb.uid, port: { role: roleB, index: idx } } },
                            { entities: ents },
                        );
                        if (!r.ok) {
                            const code = (r.error && r.error.code) || "NO_CODE";
                            hist[code] = (hist[code] || 0) + 1;
                            if (!codes.has(code)) badCodes.add(code);
                            continue;
                        }
                        successes.push({ from: `${a.type}#${a.uid}`, to: `${bb.type}#${bb.uid}`, toHub: bb.type === "hub", n: r.cells.length });
                        const ops = (r.cells || []).map(c => ({
                            op: "place", building: "belt", x: c.x, y: c.y,
                            r: c.rotation, rotationVariant: c.rotationVariant,
                        }));
                        const v = ops.map((op, i) => ({ i, op, why: opViolation(mod, op) })).filter(x => x.why);
                        ok(v.length === 0,
                            `真实存档：connect(${a.type}#${a.uid}→${bb.type}#${bb.uid}) 的 ${ops.length} 个 op 全部合法`, v);
                        ok((r.cells || []).every(c => c.code === c.rotationVariant + 1),
                            "真实存档：connect.cells[].code === rotationVariant + 1（code 只能读回核对，不能下发）",
                            (r.cells || []).filter(c => c.code !== c.rotationVariant + 1).slice(0, 3));
                        mapped += ops.length;
                    }
                }
            }
        }
    }

    ok(badCodes.size === 0, "connect 的所有拒绝码都在 ERROR_CODES 闭集里（没有崩溃）", [...badCodes]);
    ok(successes.length > 0,
        `真实存档上 connect 能连成（正确枚举角色名之后）：${successes.length} 种组合`,
        { hist, sample: successes.slice(0, 5) });
    ok(successes.some(s => s.toHub),
        `至少有一条直达 hub —— 这是阶段 2 真正需要的能力；来源类型：${[...new Set(successes.map(s => s.from.split("#")[0]))].join(",")}`,
        successes.filter(s => s.toHub).slice(0, 5));
    ok(mapped > 0, "至少映射出 1 个 place op", mapped);
    console.log(`  ℹ 实测分布：成功 ${successes.length}，拒绝 ${JSON.stringify(hist)}`);
}

/* 3e. replace_run 的 placed[] → tx op 也必须合法（同样用真实存档） */
{
    const real = JSON.parse(fs.readFileSync(path.join(REPO, "test/fixtures/saves/L5-obs.json"), "utf8"));
    const ents = (real.result || real).entities;
    const tries = [
        { region: [2, -12, 5, -11], building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }] },
        { region: [1, -12, 4, -12], building: "belt" },
    ];
    let done = 0;
    for (const t of tries) {
        const r = replaceRun(t, { entities: ents });
        if (!r.ok) continue;
        const ops = [
            ...(r.removes || []).map(x => ({ op: "delete", uid: x.uid })),
            ...(r.placed || []).map(p => ({
                op: "place", building: p.kind, x: p.origin[0], y: p.origin[1], r: p.rotation || 0,
                ...(p.kind === "belt" ? { rotationVariant: p.rotationVariant || 0 } : {}),
            })),
        ];
        const v = ops.map((op, i) => ({ i, op, why: opViolation(mod, op) })).filter(x => x.why);
        ok(v.length === 0,
            `真实存档：replace_run(${JSON.stringify(t.region)}) 的 ${ops.length} 个 op 全部合法`, v);
        done++;
    }
    ok(done > 0, "真实存档上至少一例 replace_run 成功（否则这条检查是空的）", done);
}

/* ─────────── 汇总 ─────────── */
console.log(`\nmacro_execution_ops 自测：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log("失败项："); for (const f of failures) console.log("  ✗ " + f); }
process.exit(fail ? 1 : 0);
