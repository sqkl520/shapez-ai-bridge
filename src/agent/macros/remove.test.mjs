/**
 * remove.test.mjs — `remove_run` / `replace_run` / `trash_unused` 三个减法宏的单测。
 *
 * 运行：node src/agent/macros/remove.test.mjs        退出码 0 全过 / 1 有失败
 *
 * 世界 = research/ai-plan/live-L4-entities.json（181 实体，真实存档 dump）。
 * 所有期望值都是**从这个世界推出来的**，不是从实现反推的（见每组用例的注释）。
 *
 * 设计原则（照 connect.test.mjs 的纪律）：
 *   1. **负例必须红**：每个正例都配一个做错的对照组，并断言报的是**具体错误码**，
 *      不只是 !ok。只证明"对的能过"是恒等式，证明不了检查器有判断力。
 *   2. 判据来自运行时：L4 的 (4,-14)/(5,-14) 等格子的角色是逐格读 entry/exit 得到的事实。
 *   3. 变异验证由 `--mutate` 开关驱动：把 would_disconnect 检查改成恒空，下面必须变红。
 *      （变异体是**源码字符串替换**，跑的是真实现，不是另写一个假实现。）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { OPP, DIRV, beltEntry, beltExit } from "../../ai/belt-rules.mjs";
/* 从真值派生 wasteRole —— 测试不许再硬编码 left/right（2026-10-29 曾被错误定义锁死过） */
import { templateByBuildingVariant } from "../../ai/op-templates.mjs";
import { validateMacroResult, lintNoBareCoords, isPendingRef } from "./contract.mjs";
import {
    removeRun, replaceRun, trashUnused, analyzeRemoval, makeContext, MACRO_IMPLS,
} from "./remove.mjs";
import { insertMachine, applyToWorld } from "./place.mjs";
import { buildWorld } from "./connect.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVE = path.resolve(HERE, "../../../research/ai-plan/live-L4-entities.json");
const SRC = path.resolve(HERE, "remove.mjs");

/* ══════════════════════════════════════════════════════════════════════════
 * A. 变异验证 (`--mutate`)：把实现的某个判据**改坏**，测试必须变红。
 *
 * 为什么要有这一步：一个只在"正确实现"上全绿的测试集，
 * 无法证明它**真的在检查**那件事 —— 它可能只是在跑一遍代码。
 * 变异测试是唯一能证明"检查器有判断力"的离线手段。
 *
 * 做法：读 remove.mjs 源码 → 字符串替换成变异体 → 写临时文件 →
 * 生成一个只改 import 路径的测试副本 → 用子进程跑它 → 断言它**红了**、
 * 而且红的条数与预期一致（不要求具体哪几条，只要求"处理这条判据的用例被抓住"）。
 *
 * 用法：node src/agent/macros/remove.test.mjs --mutate
 * ══════════════════════════════════════════════════════════════════════════ */

const MUTANTS = [
    {
        id: "M1-would-disconnect-always-empty",
        why: "把 would_disconnect 检查改成恒空（任务书点名的变异）",
        from: "const wouldDisconnect = analyzeRemoval(c0, picked.map(p => p.uid));",
        to: "const wouldDisconnect = []; /* MUTANT */",
        expectRed: 4,
    },
    {
        id: "M2-trash-offset-by-one",
        why: "把 portCellOf 的 DIRV 偏移去掉 → trash 落在槽位格而不是喷口格",
        from: "const portCellOf = (origin, q) => [origin[0] + q.cell[0] + DIRV[q.dir][0], origin[1] + q.cell[1] + DIRV[q.dir][1]];",
        to: "const portCellOf = (origin, q) => [origin[0] + q.cell[0], origin[1] + q.cell[1]]; /* MUTANT */",
        expectRed: 13,
    },
    {
        id: "M3-replace-deletes-all-belts",
        why: "replace_run 删光 region 内全部带子（不再区分「被新建筑覆盖」）",
        from: "        if (placedCells.has(key(b.x, b.y))) {",
        to: "        if (true) { /* MUTANT */",
        expectRed: 14,
    },
    {
        id: "M4-remove-silently-skips-missing-uid",
        why: "删不存在的 uid 时静默跳过（而不是 endpoint_not_found 整单拒绝）",
        from: '            if (!rec) { bad.push({ uid, why: "不在当前世界（obs 过期或已被删）" }); continue; }',
        to: "            if (!rec) { continue; } /* MUTANT */",
        expectRed: 3,
    },
    {
        id: "M5-replace-ignores-wasteRoles",
        why: "replace_run 的 trash 不再看 wasteRoles（销毁没人签字也放行）",
        from: "        const wasteRoles = primary.tpl.wasteRoles || [];",
        to: '        const wasteRoles = ["left", "right", "primary", "secondary"]; /* MUTANT */',
        expectRed: 1,
    },
    {
        id: "M6-trash-unused-ignores-wasteRoles",
        why: "trash_unused 不再要求 confirm_waste",
        from: "    if (!wasteRoles.includes(port.role) && !opts.confirm_waste) {",
        to: "    if (false) { /* MUTANT */",
        expectRed: 1,
    },
    {
        id: "M7-chain-cut-gate-always-open",
        why: "语义闸失效：trash 剪断一条仍在供货的活链也不要求签字（E2E §4 V9 的静默通过形态）",
        from: "    if (planCuts.length && !trashSpecs.every(t => t.confirmWaste)) {",
        to: "    if (false) { /* MUTANT */",
        expectRed: 1,
    },
];

if (process.argv.includes("--mutate")) {
    const { spawnSync } = await import("node:child_process");
    const os = await import("node:os");
    const srcText = fs.readFileSync(SRC, "utf8");
    const selfText = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remove-mut-"));
    let bad = 0;
    console.log(`变异验证：${MUTANTS.length} 个变异体\n`);
    for (const m of MUTANTS) {
        if (!srcText.includes(m.from)) {
            console.log(`\x1b[31m✗ ${m.id}\x1b[0m\n      锚点未找到（实现已改？）: ${m.from.slice(0, 70)}`);
            bad++;
            continue;
        }
        const mutantPath = path.join(tmpDir, "remove.mutant.mjs");
        const testPath = path.join(tmpDir, "remove.test.mutant.mjs");
        /* 用 pathToFileURL 而不是手拼 "file://" —— Windows 下反斜杠转义在多层引号里
           极易被吃掉（实测被吃成 /\/g 造成 SyntaxError），而它顺便处理盘符与 %20 空格。 */
        const uri = f => pathToFileURL(path.resolve(HERE, f)).href;
        /* 变异体**自己**的 import 也要换成绝对 URL：临时目录里的相对路径会指到别处
           （实测变成 <Temp>\ai\belt-rules.mjs，于是子进程以「模块找不到」退出）。 */
        const mutantText = srcText
            .replace(m.from, m.to)
            .replaceAll('"../../ai/belt-rules.mjs"', JSON.stringify(uri("../../ai/belt-rules.mjs")))
            .replaceAll('"../../ai/op-templates.mjs"', JSON.stringify(uri("../../ai/op-templates.mjs")))
            .replaceAll('"./contract.mjs"', JSON.stringify(uri("contract.mjs")))
            .replaceAll('"./connect.mjs"', JSON.stringify(uri("connect.mjs")))
            .replace(
                'const SPEC_PATH = path.resolve(HERE, "../../ai/machine-spec.json");',
                `const SPEC_PATH = ${JSON.stringify(path.resolve(HERE, "../../ai/machine-spec.json"))};`);
        fs.writeFileSync(mutantPath, mutantText);
        /* 测试副本：只把 import 说明符换成绝对 URL，其余逐字照抄 ——
           保证跑的是**同一份测试**，不是另写的一套。
           ⚠️ 必须按**说明符**（引号内的部分）替换，不能按 `from "x"` 整行替换 ——
           带花括号的多行 import 那行里没有 `from`。 */
        const rewritten = selfText
            .replaceAll('"./remove.mjs"', JSON.stringify(pathToFileURL(mutantPath).href))
            .replaceAll('"./place.mjs"', JSON.stringify(uri("place.mjs")))
            .replaceAll('"./contract.mjs"', JSON.stringify(uri("contract.mjs")))
            .replaceAll('"./connect.mjs"', JSON.stringify(uri("connect.mjs")))
            .replaceAll('"../../ai/belt-rules.mjs"', JSON.stringify(uri("../../ai/belt-rules.mjs")))
            .replace(
                'const SAVE = path.resolve(HERE, "../../../research/ai-plan/live-L4-entities.json");',
                `const SAVE = ${JSON.stringify(SAVE)};`)
            .replace(
                'const SRC = path.resolve(HERE, "remove.mjs");',
                `const SRC = ${JSON.stringify(SRC)};`);
        /* 自检：路径重写必须真的发生了。否则子进程会以「模块找不到」退出，
           那个退出码 1 会被误当成「变异被抓」—— 变异测试最常见的假绿来源。
           判据两条：测试副本里不许再有相对说明符；变异体里也不许有。 */
        if (/from "(\.\/|\.\.\/)/.test(rewritten) || !rewritten.includes("file://")) {
            throw new Error("变异测试副本的 import 重写失败（会退化成假绿）");
        }
        if (/from "(\.\/|\.\.\/)/.test(mutantText)) {
            throw new Error("变异体的 import 重写失败（子进程会以模块找不到退出）");
        }
        fs.writeFileSync(testPath, rewritten);
        const r = spawnSync(process.execPath, [testPath], { encoding: "utf8" });
        const out = (r.stdout || "") + (r.stderr || "");
        /* 行首有 ANSI 颜色码（\x1b[31m✗\x1b[0m），所以要先剥色再按行首数 ✗。
           直接 /^✗/gm 会数到 0 条 —— 那会让「变异被抓」永远判成逃逸（假红）。 */
        const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
        const red = (plain.match(/^✗/gm) || []).length;
        const passed = (plain.match(/^✓/gm) || []).length;
        const crashed = /SyntaxError|ReferenceError|TypeError/.test(out) && red === 0;
        const caught = r.status !== 0 && red === m.expectRed && passed > 0;
        if (process.env.MUT_DEBUG) console.log("--- " + m.id + " status=" + r.status + " red=" + red + " pass=" + passed + "\n" + plain.slice(0, 1200));
        if (caught) {
            console.log(`\x1b[32m✓ ${m.id}\x1b[0m  红 ${red}/${m.expectRed} 条 —— ${m.why}`);
        } else {
            bad++;
            console.log(`\x1b[31m✗ ${m.id}\x1b[0m  期望红 ${m.expectRed} 条，实得 ${red} 条`
                + `（退出码 ${r.status}${crashed ? "，疑似崩溃而不是断言失败" : ""}）\n       ${m.why}`);
        }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`\n${bad === 0 ? "\x1b[32m全部变异被抓\x1b[0m" : `\x1b[31m${bad} 个变异逃逸\x1b[0m`}`);
    process.exitCode = bad ? 1 : 0;
    process.exit();
}

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
    try { fn(); pass++; results.push(["ok", name]); }
    catch (e) { fail++; results.push(["FAIL", name, e && e.message ? e.message : String(e)]); }
}
const eq = (a, b, m) => assert.deepEqual(a, b, m === undefined ? `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}` : m);
const ok = (c, m) => assert.ok(c, m);

const ENTITIES = JSON.parse(fs.readFileSync(SAVE, "utf8"));
const CTX = { entities: ENTITIES };
/** 每次调用都用**同一个** entities 数组引用（world 缓存命中）；宏本身不写它。 */
const UID = {
    hub: 10000,
    // 钌线：x=2..5 的向上直线，y=-9..-18
    b4_13: 10209, b5_13: 10149, b4_14: 10143, b5_14: 10150,
    b4_12: 10208, b5_12: 10148, b4_15: 10144, b5_15: 10151,
    // 铜线死路：(-10,-3) 向上，出口 (-10,-4) 是空的
    cu_deadend: 10008,
    // 铜线拐角 (-9,-3)：入口 bottom、出口 right → 出口被 balancer 10035 占住
    cu_corner: 10024,
    balancer: 10035,
    cutter: 10036,
};

/* 世界未被改动（宏零写操作）—— 放在最后复查 */
const WORLD_SNAPSHOT = JSON.stringify(ENTITIES);

/* ══════════════════════════════════════════════════════════════════════════
 * 0. 前置事实：本组用例依赖的世界事实（若存档变了，这里是第一个红的地方）
 * ══════════════════════════════════════════════════════════════════════════ */

t("世界事实：(4,-13)/(5,-13)/(4,-14) 是 r=0 code=1 的向上带；它们构成 x=4/x=5 两条竖线", () => {
    const by = new Map(ENTITIES.map(e => [`${e.x},${e.y}`, e]));
    for (const [cell, uid] of [[[4, -13], UID.b4_13], [[5, -13], UID.b5_13], [[4, -14], UID.b4_14]]) {
        const e = by.get(cell.join(","));
        assert.ok(e, `${cell} 应有实体`);
        eq([e.uid, e.type, e.r, e.rotation_variant], [uid, "belt", 0, 0], `${cell} 的 uid/type/r/rv`);
        eq(beltExit(e.rotation_variant, e.r), "top", `${cell} 出口应向上`);
        eq(beltEntry(e.rotation_variant, e.r), "bottom", `${cell} 入口应向下`);
    }
});

t("世界事实：cutter 10036 的槽位把「左=废料、右=产品」摆出来（L4 与 wasteRoles 相反）", () => {
    // op-templates：cutter outputs = left@tile(0,0), right@tile(1,0)，都朝 top
    // 所以 origin 在 (4,-13) 时左槽喷 (4,-14)、右槽喷 (5,-14)
    // wasteRoles=["right"]（半切场景右列是废料），而 L4 的 RuRu---- 要右列 ⇒ 必须 confirm_waste
    const ents = ENTITIES.filter(e => e.uid === UID.cutter);
    eq(ents.length, 1, "cutter 应只有 1 台");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 1. remove_run
 * ══════════════════════════════════════════════════════════════════════════ */

t("remove_run：删 3 格带 → 恰好 3 个 removed，uid/cell 逐个相等（G-delete-replay 口径）", () => {
    const r = removeRun({ uids: [UID.b4_13, UID.b5_13, UID.b4_14] }, CTX);
    assert.ok(r.ok, JSON.stringify(r.error));
    eq(r.macro, "remove_run");
    eq(r.removed.length, 3);
    // 确定序：先 y 再 x ⇒ (4,-14) 在 y=-14，排在两个 y=-13 之前
    eq(r.removed.map(x => [x.uid, x.cell]), [
        [UID.b4_14, [4, -14]],
        [UID.b4_13, [4, -13]],
        [UID.b5_13, [5, -13]],
    ]);
    // removed_uids 与 removed[] 同序（调用方常按其中一个对账，两者不许漂移）
    eq(r.removed_uids, r.removed.map(x => x.uid));
    eq(r.cells_planned, 3);
    eq(r.cells_placed, 3);
    eq(r.first_mismatch, null);
    // 声明集合与实删集合**逐 uid 相等**（不排序比较 —— 顺序也是契约的一部分）
    eq(r.changed.removed_uids, r.removed_uids);
    ok(validateMacroResult(r).ok, "返回值必须过契约信封校验");
});

t("remove_run：cells 形态与 uids 形态**解析到同一集合**（次选不能有不同语义）", () => {
    const a = removeRun({ uids: [UID.b4_13, UID.b5_13, UID.b4_14] }, CTX);
    const b = removeRun({ cells: [[4, -13], [5, -13], [4, -14]] }, CTX);
    assert.ok(a.ok && b.ok);
    eq(b.removed.map(x => x.uid), a.removed.map(x => x.uid));
});

t("remove_run：删会断链的带 → 报 would_disconnect（4 处：2 断供 + 2 断去路）", () => {
    const r = removeRun({ uids: [UID.b4_13, UID.b5_13, UID.b4_14] }, CTX);
    assert.ok(r.ok, JSON.stringify(r.error));
    /* 这 4 处是逐格推的，不是数出来的：
         (4,-13) 的上游 (4,-12)=10208 只有这一个去处 → orphaned-output
         (5,-13) 的上游 (5,-12)=10148 同上              → orphaned-output
         (4,-14) 的下游 (4,-15)=10144 再没有别的供料方 → starved-belt
         (5,-13) 的下游 (5,-14)=10150 同上              → starved-belt */
    eq(r.would_disconnect.length, 4);
    eq(r.would_disconnect.map(w => [w.kind, w.uid]), [
        ["starved-belt", UID.b4_15],
        ["starved-belt", UID.b5_14],
        ["orphaned-output", UID.b4_12],
        ["orphaned-output", UID.b5_12],
    ]);
    eq(r.consequences.orphaned_outputs.length, 2);
    eq(r.consequences.starved_belts.length, 2);
    eq(r.consequences.starved_machines.length, 0);
    ok(r.warnings.some(w => w.code === "would-disconnect"), "must_disconnect 必须是 warning（报告不阻止）");
});

t("remove_run：断开**不阻止执行** —— L4 的唯一正解就是先删再插，阻止它等于禁止正解", () => {
    const r = removeRun({ uids: [UID.b4_13, UID.b5_13, UID.b4_14] }, CTX);
    ok(r.ok, "ok 必须为 true");
    ok(r.would_disconnect.length > 0, "同时 must_disconnect 必须非空");
    ok(r.error === null);
});

t("remove_run：删带子**中间一段**只断 2 处，且断的是留下的邻居（不是被删的那些）", () => {
    // x=4 竖线 y=-9..-15：删中间 (4,-12)(4,-13)
    const mid = removeRun({ uids: [UID.b4_12, UID.b4_13] }, CTX);
    assert.ok(mid.ok, JSON.stringify(mid.error));
    eq(mid.would_disconnect.length, 2);
    const kinds = mid.would_disconnect.map(w => w.kind).sort();
    eq(kinds, ["orphaned-output", "starved-belt"]);
    // 上游 (4,-11)=10206 失去唯一去处；(4,-14)=10143 失去供料
    ok(mid.would_disconnect.some(w => w.uid === 10206 && w.kind === "orphaned-output"));
    ok(mid.would_disconnect.some(w => w.uid === UID.b4_14 && w.kind === "starved-belt"));
});

t("remove_run：删**线的末端**断 2 处 —— 下游饿死 + 上游矿机失去唯一去处", () => {
    /* ⚠️ 这条用例的期望值被修正过一次，值得留痕（原期望是 1，错的）：
       旧注释说「(4,-8) 在存档里是空的」——**假的**。逐格读存档：
         (4,-8) uid=10081 是 **miner**（r=0），它的 ejector 喷格 = (4,-9)；
         (4,-9) uid=10138 entry=bottom ⇒ 正好从矿机接货，exit=top ⇒ 下游 (4,-10)=10139。
       所以删 (4,-9) 断两处：下游 10139 饿死 + 矿机 10081 的唯一输出没去处。
       旧实现只报 1 处，因为 `inLink()` 用 `portAtCell.get(上格)` 查端口 ——
       而 portAtCell 的键是**端口的带格**（= 本带自己那格），不是机器本体格，
       因此「被机器喷的带子」永远查不到供料方。那是个真 bug，已修（按 slot 比）。 */
    const r = removeRun({ uids: [10138] }, CTX);
    assert.ok(r.ok, JSON.stringify(r.error));
    eq(r.would_disconnect.length, 2);
    eq(r.would_disconnect.map(x => [x.kind, x.uid]), [
        ["starved-belt", 10139],        // (4,-10)，唯一供料方就是被删的 (4,-9)
        ["orphaned-output", 10081],     // (4,-8) 矿机的唯一去处被删
    ]);
});

t("remove_run：孤立的一段（无上下游）→ 0 处断开，返回空数组而不是省略字段", () => {
    // 找一个真孤立的带子：不在任何机器/带子的下游、也没有下游
    const w = buildWorld(ENTITIES);
    const ctx = makeContext(w, ENTITIES);
    let lone = null;
    for (const b of ctx.belts.values()) {
        const r = analyzeRemoval(ctx, [b.uid]);
        if (r.length === 0) { lone = b; break; }
    }
    // 真实存档里未必存在完全孤立的带子；不存在时用「删整条 2 格链会得到 1 处」验证字段恒在
    const r = removeRun({ uids: lone ? [lone.uid] : [10138] }, CTX);
    assert.ok(r.ok, JSON.stringify(r.error));
    ok(Array.isArray(r.would_disconnect), "would_disconnect 恒为数组（不许省略）");
    if (lone) eq(r.would_disconnect.length, 0);
});

t("负例：删不存在的 uid → endpoint_not_found，不静默跳过", () => {
    const r = removeRun({ uids: [999999] }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "endpoint_not_found");
    eq(r.removed.length, 0, "失败时零删除");
    eq(r.changed.removed_uids, []);
    ok(/重新 obs/.test(r.error.hint), "失败必须给可执行下一步");
});

t("负例：混入 1 个不存在 uid + 2 个存在 → **整单拒绝**，不删那 2 个", () => {
    const r = removeRun({ uids: [UID.b4_13, 999999, UID.b5_13] }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "endpoint_not_found");
    eq(r.removed.length, 0);
    eq(r.cells_planned, 0);
    eq(r.changed.removed_uids, []);
});

t("负例：选集含机器 → not_a_run，整单拒绝（不「尽量删」）", () => {
    const r = removeRun({ uids: [UID.b4_13, UID.cutter] }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "not_a_run");
    eq(r.removed.length, 0);
    ok(/cutter/.test(r.error.hint) || /只处理带子/.test(r.error.message));
});

t("负例：cells 指向机器格 → not_a_run", () => {
    const r = removeRun({ cells: [[-8, -11]] }, CTX);   // cutter origin
    eq(r.ok, false);
    eq(r.error.code, "not_a_run");
});

t("负例：cells 指向空格 → endpoint_not_found（不许把空当带删）", () => {
    const r = removeRun({ cells: [[100, 100]] }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "endpoint_not_found");
});

t("负例：不连通选集 → run_not_contiguous；allow_scattered=true 才放行", () => {
    const bad = removeRun({ uids: [UID.b4_13, UID.b4_15] }, CTX);   // 中间隔一格
    eq(bad.ok, false);
    eq(bad.error.code, "run_not_contiguous");
    ok(/allow_scattered/.test(bad.error.hint));

    const good = removeRun({ uids: [UID.b4_13, UID.b4_15], opts: { allow_scattered: true } }, CTX);
    assert.ok(good.ok, JSON.stringify(good.error));
    eq(good.components.length, 2);
    eq(good.removed.length, 2);
});

t("负例：重复 uid / 空数组 / 裸坐标键 → 契约层就拒", () => {
    eq(removeRun({ uids: [UID.b4_13, UID.b4_13] }, CTX).error.code, "bad_type");
    eq(removeRun({ uids: [] }, CTX).error.code, "bad_type");
    const x = removeRun({ uids: [UID.b4_13], x: 4 }, CTX);
    eq(x.error.code, "unknown_field");
    eq(x.error.field, "x");
});

t("remove_run：removes[] 形态带 expect（可直接落 intent）", () => {
    const r = removeRun({ uids: [UID.b4_13] }, CTX);
    assert.ok(r.ok);
    eq(r.removes.length, 1);
    eq(r.removes[0].uid, UID.b4_13);
    eq(r.removes[0].expect, { type: "belt", x: 4, y: -13, r: 0 });
});

t("remove_run：位置形态 removeRun([uids], opts, ctx) 等价", () => {
    const r = removeRun([UID.b4_13, UID.b5_13], null, CTX);
    assert.ok(r.ok, JSON.stringify(r.error));
    eq(r.removed.map(x => x.uid).sort(), [UID.b4_13, UID.b5_13].sort());
});

t("remove_run：stranded_items 如实报 null（离线拿不到 debug_items，不用 0 冒充「没有」）", () => {
    const r = removeRun({ uids: [UID.b4_13] }, CTX);
    assert.ok(r.ok);
    eq(r.stranded_items, null);
    ok(r.warnings.some(w => w.code === "stranded-items-unknown"));
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. replace_run — L4 的真实改造
 * ══════════════════════════════════════════════════════════════════════════ */

const L4_REGION = [4, -14, 5, -13];     // 4 格：x=4..5, y=-14..-13
const L4_BUILDING = ["cutter", { kind: "trash", port: "left", confirm_waste: true }];

t("replace_run：在 (4,-13) 把 3 格带换成 cutter+trash（L4 的真实改造）", () => {
    const r = replaceRun({ region: L4_REGION, building: L4_BUILDING }, CTX);
    assert.ok(r.ok, JSON.stringify(r.error));

    // 删 3 格：(4,-14)(4,-13)(5,-13)
    eq(r.removed.map(x => [x.uid, x.cell]), [
        [UID.b4_14, [4, -14]],
        [UID.b4_13, [4, -13]],
        [UID.b5_13, [5, -13]],
    ]);
    // 留 1 格：(5,-14) —— 它是 cutter 右槽（RuRu----）唯一的下游，绝不能删
    eq(r.kept.map(x => [x.uid, x.cell]), [[UID.b5_14, [5, -14]]]);

    // 放 2 台：cutter origin (4,-13) 占 2 格；trash 落在左槽喷口 (4,-14)
    eq(r.placed.length, 2);
    const [cutter, trash] = r.placed;
    eq([cutter.kind, cutter.origin, cutter.cells], ["cutter", [4, -13], [[4, -13], [5, -13]]]);
    eq([trash.kind, trash.origin, trash.cells], ["trash", [4, -14], [[4, -14]]]);
    eq(trash.forPort.role, "left");

    // 流向由 region 内的带子内部推出（全部向上）
    eq(r.flow, "top");
    eq(r.summary, { removed: 3, placed: 2, kept: 1 });
    eq(r.cells_planned, 3 + 3);         // 删 3 + 放 3 格（cutter2 + trash1）
    eq(r.cells_placed, r.cells_planned);
    ok(validateMacroResult(r).ok);

    // 关键：这台 cutter 的输入/输出槽都接上了（这是后验推演出来的，不是假设）
    const ports = cutter.ports;
    eq(ports.find(p => p.kind === "accept").cell, [4, -12]);     // 上游 (4,-12) 在喂它
    eq(ports.find(p => p.role === "right").cell, [5, -14]);      // 右槽正是保留的那条带
});

t("replace_run：L4 的「先删 3 再插机器」与 remove_run 的删除集合**逐 uid 相等**", () => {
    const rm = removeRun({ uids: [UID.b4_13, UID.b5_13, UID.b4_14] }, CTX);
    const rp = replaceRun({ region: L4_REGION, building: L4_BUILDING }, CTX);
    assert.ok(rm.ok && rp.ok);
    eq(rp.removed.map(x => x.uid).sort(), rm.removed.map(x => x.uid).sort());
});

t("replace_run：删/留的分界线 = 「被新建筑 footprint 覆盖」—— (5,-14) 被留是设计不是侥幸", () => {
    const r = replaceRun({ region: L4_REGION, building: L4_BUILDING }, CTX);
    assert.ok(r.ok);
    const placedCells = new Set(r.placed.flatMap(p => p.cells.map(c => c.join(","))));
    for (const x of r.removed) ok(placedCells.has(x.cell.join(",")), `被删的 ${x.cell} 必须在新建筑格上`);
    for (const k of r.kept) ok(!placedCells.has(k.cell.join(",")), `保留的 ${k.cell} 不应在新建筑格上`);
    ok(r.warnings.some(w => w.code === "kept-belts"), "保留行为必须出现在 warning 里（不静默）");
});

t("replace_run：region 太小（不含 trash 落点）→ 报错并指出缺哪一格", () => {
    const r = replaceRun({ region: [4, -13, 5, -13], building: L4_BUILDING }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "precondition_failed");
    ok(/\(4,-14\)|4,-14/.test(r.error.message), `诊断要点出缺的格，实得：${r.error.message}`);
    ok(/region/.test(r.error.hint));
});

t("replace_run：只给 cutter 不给 trash → 合法（两个输出都还有去处，没有东西该被销毁）", () => {
    /* 这一条纠正了我最初的直觉，值得写进测试以免将来"顺手加个 trash"：
       region = [4,-14,5,-13]，cutter origin (4,-13) ⇒ 左槽喷 (4,-14)（region 内、被删）、
       右槽喷 (5,-14)（region 内、保留）。
       左槽喷口那格 (4,-14) 被删后是**空**的，但 trashSpecs 为空 ⇒
       「空着没人接」没有实体可归因，不会被判成 orphaned-output。
       宏如实返回 ok，并把 kept 列出来让调用方自己看。 */
    const r = replaceRun({ region: L4_REGION, building: "cutter" }, CTX);
    assert.ok(r.ok, `应成功：${JSON.stringify(r.error)}`);
    eq(r.placed.length, 1);
    eq(r.placed[0].kind, "cutter");
    eq(r.kept.map(k => k.cell), [[4, -14], [5, -14]]);
    ok(r.warnings.some(w => w.code === "kept-belts"), "保留的 (4,-14) 必须出现在 warning 里");
});

t("replace_run：region 圈进没有下游的空域 → 右槽 orphaned-output，hint 指路加 trash", () => {
    /* region = [4,-17,5,-17]：这 2 格都是带子，且是 x=4/x=5 竖线的**顶端**
       （它们下面有货、上面 y=-16 是 balancer，不是带子）。
       把 cutter 摆在这里 ⇒ 输出喷向 y=-18，(4,-18)=10132 有带子、(5,-18) 是空 ⇒
       右槽 orphaned-output。这是程序化搜索确认过的 32 个 region 之一。 */
    const r = replaceRun({ region: [4, -17, 5, -17], building: "cutter" }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "precondition_failed");
    ok(r.firstConflict, "firstConflict 必须非空");
    eq(r.firstConflict.what, "orphaned-output");
    ok(/trash/.test(r.error.hint), `hint 必须指路加 trash，实得：${r.error.hint}`);
});

t("负例：trash 没点名 port → missing_field（宏不猜哪一路是废料）", () => {
    const r = replaceRun({ region: L4_REGION, building: ["cutter", { kind: "trash" }] }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "missing_field");
    eq(r.error.field, "building[1].port");
});

/* ⚠️ 这一条原来写 `port:"left"`（当时 wasteRoles=["right"]，left 就是"非废料槽"）。
 * 2026-10-29 把 wasteRoles 修正为 ["left"]（实机三方证据）后，left 变成**合法废料槽**，
 * 于是这条测试的前提没了。改成**从真值派生**：取一个**不是** wasteRole 的输出槽。
 * 这样它测的是"点错了槽要签字"这条规则本身，而不是某个具体的 left/right。 */
t("负例：trash 点名了非 wasteRoles 的槽但没签字 → 拒绝（poka-yoke：销毁要有主）", () => {
    const tpl = templateByBuildingVariant("cutter", "default");
    const wasteSet = new Set(tpl.wasteRoles || []);
    const nonWaste = (tpl.outputs || []).map(q => q.role).find(r => !wasteSet.has(r));
    ok(!!nonWaste, "（前置）cutter 至少有一个非废料输出槽", { waste: [...wasteSet], outputs: (tpl.outputs || []).map(q => q.role) });
    const r = replaceRun({ region: L4_REGION, building: ["cutter", { kind: "trash", port: nonWaste }] }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "precondition_failed");
    eq(r.error.field, "building[1].confirm_waste");
    ok(/wasteRoles/.test(r.error.message), `message 应提到 wasteRoles，实得：${r.error.message}`, { nonWaste });
});

t("负例：trash 点名不存在的槽 → bad_type 并列出可用角色", () => {
    const r = replaceRun({ region: L4_REGION, building: ["cutter", { kind: "trash", port: "primary", confirm_waste: true }] }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "bad_type");
    ok(Array.isArray(r.error.candidates) && r.error.candidates.length === 2);
});

t("负例：region 碰到机器的 footprint（含非 origin 格）→ not_a_run", () => {
    /* cutter 10036 origin (-8,-11)，2×1 ⇒ footprint = (-8,-11) + (-7,-11)。
       只框**右半格** (-7,-11) 也必须被拦住 —— 只看 entities[].x/y 会漏掉这种。 */
    for (const region of [[-8, -11, -7, -11], [-7, -11, -7, -11], [-8, -11, -8, -11]]) {
        const r = replaceRun({ region, building: "cutter" }, CTX);
        eq(r.ok, false, `region ${JSON.stringify(region)} 应被拒`);
        eq(r.error.code, "not_a_run", `region ${JSON.stringify(region)} 的错误码`);
        eq(r.error.detail.offending[0].uid, UID.cutter);
    }
});

t("负例：region 放不下 footprint → occupied（不猜落点）", () => {
    // cutter 2×1，region 只有 1×1
    const r = replaceRun({ region: [4, -13, 4, -13], building: "cutter" }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "occupied");
});

t("负例：未知建筑 / 隧道 / hub → unsupported_building（不静默降级）", () => {
    for (const b of ["teleporter", "underground_belt", "hub"]) {
        const r = replaceRun({ region: L4_REGION, building: b }, CTX);
        eq(r.ok, false, `${b} 应被拒`);
        eq(r.error.code, "unsupported_building", `${b} 的错误码`);
    }
});

t("负例：building:\"belt\" 但 region 有空格 → precondition_failed（契约原义的「带子数===面积」）", () => {
    /* region = [5,-18,6,-18]：只有 (5,-18) 是带子，(6,-18) 是空的。
       注意机器检查**先**跑（那是误删 42 实体的形态），所以这里必须挑一个不含机器的盒子。
       [4,-17,5,-16] 会先撞上 balancer 10085 的 footprint，得到 not_a_run —— 也正确，
       但那样就测不到「空格」这条，所以用下面这个。 */
    const r = replaceRun({ region: [5, -18, 6, -18], building: "belt" }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "precondition_failed");
    ok(/空/.test(r.error.message), `message 要点出空格，实得：${r.error.message}`);
    eq(r.error.detail.emptyCells, [[5, -18], [6, -18]]);

    /* 同一 region 走**机器**路径是允许的（扩展路径放宽到「带子或空格」）：
       这是两条路径的**有意差异**，必须显式断言，否则将来有人会把放宽也搬到 belt 路径上。 */
    const m = replaceRun({ region: [5, -18, 6, -18], building: "cutter" }, CTX);
    ok(!(m.ok === false && m.error.code === "precondition_failed" && /空/.test(m.error.message)),
        "机器路径不应因空格被拒（它随后会以别的理由失败或成功）");
});

t("契约原义：building:\"belt\" 按邻居反解 rv；现有存档自洽 → 0 处 drift", () => {
    const r = replaceRun({ region: [4, -14, 5, -13], building: "belt" }, CTX);
    assert.ok(r.ok, JSON.stringify(r.error));
    eq(r.mode, "belt");
    eq(r.placed.length, 4);
    eq(r.mismatched.length, 0, "真实存档的 (r,rv) 应已自洽");
    for (const p of r.placed) {
        eq(p.code, 1 + p.rotationVariant);
        eq(p.rotationVariant, 0, "向上直线应解出 rv=0");
    }
});

t("负例：belt 路径「只有一侧有邻居证据」→ 拒绝而不是猜（三选一不是唯一解）", () => {
    /* 构造单侧证据：(4,-13)=10209 的**上游** (4,-12)=10208 删掉，
       于是本格只剩下游 (4,-14) 的 entry=bottom 作为证据（exit=top）。
       入口面有 3 种合法解（left/right/bottom），宏必须拒绝。 */
    const noUpstream = ENTITIES.filter(e => e.uid !== UID.b4_12);
    const r = replaceRun({ region: [4, -13, 4, -13], building: "belt" }, { entities: noUpstream });
    eq(r.ok, false);
    eq(r.error.code, "precondition_failed");
    ok(/不猜|3 种/.test(r.error.message + r.error.hint), `诊断要说明「不猜」：${r.error.message} | ${r.error.hint}`);
});

t("★ 单侧证据的 hint 必须是**动作**（2026-11-02 改写，HINT-AB-RESULT.md）", () => {
    /* 原来的 hint 是「把 region 缩到『两侧都有可参照邻居』的那几格」——
     * 要求模型自己判断「哪几格两侧都有邻居」，而 **prompt 里没有这个信息**。
     *
     * 实测（38 条多轮样本）：它是最高频的 hint（18/38），但模型读完仍然改不对。
     *
     * 现在改成给出**可执行的动作**（把哪个 uids 去掉 / 改用哪个模式），
     * 并把宏已经算出来的邻居证据写成句柄。
     *
     * 判据：模型读完能不能**不推理**就写出一个不同的调用。 */
    const noUpstream = ENTITIES.filter(e => e.uid !== UID.b4_12);
    const r = replaceRun({ region: [4, -13, 4, -13], building: "belt" }, { entities: noUpstream });
    eq(r.ok, false);

    const hint = String(r.error.hint || "");
    /* ① 必须给出动作 */
    ok(/把这个 uids 从 region 里去掉|改用 replace_run/.test(hint),
        `hint 必须给出可执行的动作，实际：${hint}`);
    /* ② 必须说清是哪一侧的证据（模型据此判断能不能补救） */
    ok(/只有一侧|两侧都/.test(hint), `hint 必须说明邻居证据的完整度，实际：${hint}`);
    /* ③ 不许出现坐标（契约 V4） */
    ok(!/\(\s*-?\d{1,4}\s*,\s*-?\d{1,4}\s*\)/.test(hint),
        `hint 里不许有坐标形态，实际：${hint}`);
});

t("契约原义：把某格的 rv 人为改坏 → 报 rv-drift 并按邻居解出正确值（这是本路径的用途）", () => {
    // (5,-13) 原本 rv=0 向上；改成 rv=2（右弯）模拟被游戏重算坏
    const broken = ENTITIES.map(e => e.uid === UID.b5_13 ? { ...e, rotation_variant: 2, code: 3 } : e);
    const r = replaceRun({ region: [5, -13, 5, -13], building: "belt" }, { entities: broken });
    assert.ok(r.ok, JSON.stringify(r.error));
    eq(r.mismatched.length, 1);
    eq(r.mismatched[0].cell, [5, -13]);
    eq(r.mismatched[0].requested, 1, "应解出 code=1（rv0 直带）");
    eq(r.mismatched[0].actual, 3, "现有是 code=3");
    eq(r.placed[0].rotationVariant, 0);
    ok(r.warnings.some(w => w.code === "rv-drift"));
});

t("负例：replace_run 的 range 键被拒（防 90° 的 r/rv 混入）", () => {
    const r = replaceRun({ region: L4_REGION, building: "cutter", r: 90 }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "unknown_field");
    eq(r.error.field, "r");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. trash_unused
 * ══════════════════════════════════════════════════════════════════════════ */

t("trash_unused：给铜线死路 (-10,-3) 接垃圾桶 → 落在出口格 (-10,-4)", () => {
    const r = trashUnused({ outlet: { uid: UID.cu_deadend } }, CTX);
    assert.ok(r.ok, JSON.stringify(r.error));
    /* 逐格推：(-10,-3) rv=0 r=0 ⇒ entry=bottom exit=top
       ⇒ 喷口 = (-10,-3) + DIRV[top] = (-10,-4)，且该格在世界里是空的 */
    eq(r.trashCell, [-10, -4]);
    eq(r.outletPort, { kind: "belt-exit", uid: UID.cu_deadend, role: "belt", index: 0, cell: [-10, -4], dir: "top" });
    eq(r.replaced_belt_uid, null);
    eq(r.cells_planned, 1);
    ok(validateMacroResult(r).ok);
});

t("trash_unused：cell 形态与 uid 形态指向同一格时结果相同", () => {
    const a = trashUnused({ outlet: { uid: UID.cu_deadend } }, CTX);
    const b = trashUnused({ outlet: { cell: [-10, -3] } }, CTX);
    assert.ok(a.ok && b.ok);
    eq(b.trashCell, a.trashCell);
});

t("trash_unused：机器单输出槽、且当前没接货 → 落在喷口格", () => {
    // balancer 10035 的 secondary 喷格 (-7,-4) 在真实存档里是空的
    const r = trashUnused({ outlet: { uid: UID.balancer, port: "secondary" }, opts: { confirm_waste: true } }, CTX);
    assert.ok(r.ok, JSON.stringify(r.error));
    eq(r.trashCell, [-7, -4]);
    eq(r.outletPort.role, "secondary");
    eq(r.outletPort.dir, "top");
});

t("负例：输出槽已经接了带子 → port_already_bound，绝不抢", () => {
    const r = trashUnused({ outlet: { uid: UID.cutter, port: "left" } }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "port_already_bound");
    eq(r.error.detail.boundTo, 10059);
    ok(/remove_run/.test(r.error.hint), "hint 要指路 remove_run");
});

t("负例：多输出机器给 auto → ambiguous_port 并列出候选角色", () => {
    const r = trashUnused({ outlet: { uid: UID.cutter } }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "ambiguous_port");
    eq(r.error.candidates.map(c => c.role), ["left", "right"]);
});

t("负例：单输出机器给了错的角色名 → bad_type 并列出可用角色", () => {
    const r = trashUnused({ outlet: { uid: 10079, port: "left" } }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "bad_type");
    eq(r.error.candidates.map(c => c.role), ["out"]);
});

t("负例：喷口格被机器占 → occupied（trash 必须正好在喷口格，不能挪一格）", () => {
    // cutter right 槽喷 (-7,-12)，那格是隧道 10077
    const r = trashUnused({ outlet: { uid: UID.cutter, port: "right" }, opts: { confirm_waste: true } }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "out_of_scope");     // 隧道单独一档，比 occupied 更准
    // 带子出口对着 balancer 也是 occupied
    const r2 = trashUnused({ outlet: { uid: UID.cu_corner } }, CTX);
    eq(r2.ok, false);
    eq(r2.error.code, "occupied");
});

t("负例：role 不在 wasteRoles 且未签字 → 拒绝；签字后放行", () => {
    /* balancer 10035 的 secondary 槽：喷口 (-7,-4) 是空的（所以不会被 port_already_bound 先拦）。
       它的 wasteRoles 是空表 ⇒ 未签字必须拒绝。 */
    const no = trashUnused({ outlet: { uid: UID.balancer, port: "secondary" } }, CTX);
    eq(no.ok, false);
    eq(no.error.code, "precondition_failed");
    ok(/confirm_waste/.test(no.error.field), `field 应指向 confirm_waste，实得 ${no.error.field}`);

    const yes = trashUnused({ outlet: { uid: UID.balancer, port: "secondary" }, opts: { confirm_waste: true } }, CTX);
    assert.ok(yes.ok, JSON.stringify(yes.error));
    eq(yes.trashCell, [-7, -4]);
});

t("负例：hub 当 outlet → endpoint_not_a_port（方向搞反了）", () => {
    const r = trashUnused({ outlet: { hub: {} } }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "endpoint_not_a_port");
    ok(/入口|ejector|源/.test(r.error.message + r.error.hint));
});

t("负例：outlet uid 不存在 → endpoint_not_found", () => {
    const r = trashUnused({ outlet: { uid: 424242 } }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "endpoint_not_found");
});

t("负例：带子出口已有下游 → port_already_bound（不是「死路」就不要塞 trash）", () => {
    const r = trashUnused({ outlet: { uid: UID.b4_13 } }, CTX);   // (4,-13)→(4,-14)
    eq(r.ok, false);
    eq(r.error.code, "port_already_bound");
});

t("负例：裸坐标键 → unknown_field（坐标一律由宏内部算）", () => {
    const r = trashUnused({ outlet: { uid: UID.cu_deadend }, cell: [-10, -4] }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "unknown_field");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 跨宏：L4 五 op 的可表达性（阶段 1 判据 1 的可执行版本）
 * ══════════════════════════════════════════════════════════════════════════ */

t("L4 可表达性：remove_run + replace_run 两条路径的产物**拓扑一致**", () => {
    const direct = replaceRun({ region: L4_REGION, building: L4_BUILDING }, CTX);
    assert.ok(direct.ok, JSON.stringify(direct.error));

    /* 等价的两步写法：先删 3 格 → 再在空出来的位置放 cutter+trash。
       第一步的 would_disconnect 必须**正好**是第二步补上的那几个口。 */
    const step1 = removeRun({ uids: direct.removed.map(x => x.uid) }, CTX);
    assert.ok(step1.ok, JSON.stringify(step1.error));
    eq(step1.removed.map(x => x.uid), direct.removed.map(x => x.uid));

    // 第二步（replace_run 在同一 region、此时那 3 格已空）应能放回同样的机器
    const after = ENTITIES.filter(e => !step1.removed_uids.includes(e.uid));
    const step2 = replaceRun({ region: L4_REGION, building: L4_BUILDING }, { entities: after });
    assert.ok(step2.ok, JSON.stringify(step2.error));
    eq(step2.placed.map(p => [p.kind, p.origin]), direct.placed.map(p => [p.kind, p.origin]));
});

t("L4 可表达性：三个宏的公开参数**没有一个裸坐标**（lintNoBareCoords 全绿）", () => {
    for (const [name, args] of [
        ["remove_run", { uids: [UID.b4_13] }],
        ["remove_run", { cells: [[4, -13]] }],
        ["replace_run", { region: L4_REGION, building: "belt" }],
        ["replace_run", { region: L4_REGION, building: L4_BUILDING }],
        ["trash_unused", { outlet: { uid: UID.cu_deadend } }],
        ["trash_unused", { outlet: { uid: UID.cutter, port: "left" }, opts: { confirm_waste: true } }],
    ]) {
        const lint = lintNoBareCoords(name, args);
        ok(lint.ok, `${name} ${JSON.stringify(args)} → ${lint.violations.join("; ")}`);
    }
});

t("注册表：四个宏都在 MACRO_IMPLS 里，且都能被按名调用", () => {
    eq(Object.keys(MACRO_IMPLS).sort(), ["remove_machine", "remove_run", "replace_run", "trash_unused"]);
    eq(MACRO_IMPLS.remove_run({ uids: [UID.b4_13] }, CTX).ok, true);
    eq(MACRO_IMPLS.trash_unused({ outlet: { uid: UID.cu_deadend } }, CTX).ok, true);
    /* remove_machine 在同一个注册表里；具体行为另有专测（见文件末尾的段）。 */
    eq(typeof MACRO_IMPLS.remove_machine, "function");
});

t("每个失败返回都带 hint（可执行的下一步，不是只说「失败了」）", () => {
    const failures = [
        removeRun({ uids: [999999] }, CTX),
        removeRun({ uids: [UID.cutter] }, CTX),
        removeRun({ uids: [UID.b4_13, UID.b4_15] }, CTX),
        replaceRun({ region: [4, -13, 5, -13], building: L4_BUILDING }, CTX),
        replaceRun({ region: [4, -17, 5, -17], building: "cutter" }, CTX),
        replaceRun({ region: L4_REGION, building: ["cutter", { kind: "trash", port: "left" }] }, CTX),
        trashUnused({ outlet: { uid: UID.cutter, port: "left" } }, CTX),
        trashUnused({ outlet: { uid: UID.cutter } }, CTX),
        trashUnused({ outlet: { uid: UID.balancer, port: "primary" } }, CTX),
    ];
    for (const r of failures) {
        eq(r.ok, false);
        ok(typeof r.error.hint === "string" && r.error.hint.length > 8,
            `${r.macro}/${r.error.code} 缺可执行 hint：${JSON.stringify(r.error)}`);
        ok(validateMacroResult(r).ok, `${r.macro}/${r.error.code} 的失败信封不合契约`);
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4b. 缺陷 1：宏之间的串接（计划态 pending 引用）
 * ══════════════════════════════════════════════════════════════════════════ */

t("缺陷 1【关键】：insert_machine → trash_unused 用上一步的 pending 串接，必须绿", () => {
    /* E2E §2 实测的断链：`insert_machine` 返回 uid:null（计划态没有 uid），
       而 trash_unused 的 outlet.uid 要求 >=0 ⇒ bad_type。于是「宏不能组合」。
       现在 insert_machine 额外返回 `pending`（自描述：footprint + 每个槽的世界格），
       trash_unused 认它，不需要世界里有这台机器。 */
    // (9,-13) 是一条线的末端（uid 10193，出口 top 指向 (9,-14) 空），放 cutter 会把
    // (9,-14) 这条既有带替换掉；这里用一块空地，语义最干净：cutter 左右两槽都空。
    const a = insertMachine({ at: [20, -40], facing: "top", machine: "cutter" }, CTX);
    assert.ok(a.ok, `上一步必须成功：${JSON.stringify(a.error)}`);
    eq(a.pending.uid, null, "计划态 —— 这正是以前串不上的原因");

    const b = trashUnused({ outlet: { pending: a.pending, port: "left" }, opts: { confirm_waste: true } }, CTX);
    assert.ok(b.ok, `宏必须能串接：${JSON.stringify(b.error)}`);
    eq(b.trashCell, [20, -41], "cutter left 槽（槽格 (20,-40) 面 top）的喷口格 = (20,-41)");
    eq(b.outletPort.role, "left");
    eq(b.pending.token, "trash_unused:trash@20,-41", "trash 本身也是计划态，可继续往下串");
});

t("缺陷 1：串接链的几何与真实世界一致（pending 的槽位格 === 落地后 obs 会给出的格）", () => {
    /* 用真实落点 (9,-13)：insert_machine 替换 (9,-14) 后，pending 描述的槽位格
       必须与「applyToWorld 折进世界、再读一眼」得到的格一致 —— 否则 pending 只是
       另一套自说自话的坐标。 */
    const a = insertMachine({ at: [9, -13], facing: "top", machine: "cutter" }, CTX);
    assert.ok(a.ok, JSON.stringify(a.error));
    const folded = applyToWorld(a, CTX);
    const synth = folded.entities.find(e => e.uid === -1);
    assert.ok(synth, "applyToWorld 必须给出合成实体");
    eq([synth.type, synth.x, synth.y], ["cutter", 9, -13]);
    /* 折叠后的世界也必须能被 trash_unused 当 ctx 用（世界模型认得合成实体），
       且两条路径（pending / 折进世界后的 cell）给出**同一个喷口格** —— 否则 pending
       只是另一套自说自话的坐标。 */
    const viaPending = trashUnused({ outlet: { pending: a.pending, port: "right" }, opts: { confirm_waste: true } }, CTX);
    const viaCell = trashUnused({ outlet: { cell: [9, -13], port: "right" }, opts: { confirm_waste: true } }, folded.ctx);
    assert.ok(viaPending.ok, JSON.stringify(viaPending.error));
    assert.ok(viaCell.ok, JSON.stringify(viaCell.error));
    eq(viaPending.trashCell, [10, -14], "cutter right 槽（槽格 (10,-13) 面 top）的喷口格");
    eq(viaCell.trashCell, viaPending.trashCell, "pending 的几何必须与落地后的世界一致");
});

t("缺陷 1：两种 pending 拼法都认 —— `{outlet:a.pending}` 与 `{outlet:{pending:a.pending,port}}`", () => {
    /* 任务书给的串接写法就是最自然的那种：`trashUnused({outlet: a.something}, ctx)`。
       要求调用方再包一层 {pending:…} 是形式税，而且两条拼法行为不同才是陷阱。
       裸传时 port 缺省 auto：单输出机器可直接用，多输出必须包一层点名（否则 ambiguous_port）。 */
    const single = insertMachine({ at: [20, -40], facing: "top", machine: "miner" }, CTX);
    assert.ok(single.ok, JSON.stringify(single.error));
    const b = trashUnused({ outlet: single.pending, opts: { confirm_waste: true } }, CTX);
    /* miner 的单输出槽喷口 = origin + top? 不 —— miner 的槽格是 origin、面 top ⇒ 喷格 (20,-41) */
    assert.ok(b.ok, `裸传 pending 必须能解析：${JSON.stringify(b.error)}`);
    eq(b.trashCell, [20, -41]);

    const cutter = insertMachine({ at: [20, -40], facing: "top", machine: "cutter" }, CTX);
    assert.ok(cutter.ok);
    /* 裸传多输出 pending：auto 不足以确定 → ambiguous_port（不猜哪一路是废料） */
    const amb = trashUnused({ outlet: cutter.pending, opts: { confirm_waste: true } }, CTX);
    eq(amb.ok, false);
    eq(amb.error.code, "ambiguous_port");
});

t("缺陷 1 负例：给 pending 一个不存在的 port → bad_type，并列出可用角色", () => {
    const a = insertMachine({ at: [20, -40], facing: "top", machine: "cutter" }, CTX);
    assert.ok(a.ok);
    const b = trashUnused({ outlet: { pending: a.pending, port: "primary" }, opts: { confirm_waste: true } }, CTX);
    eq(b.ok, false);
    eq(b.error.code, "bad_type");
    ok(/left.*right|right.*left/.test(b.error.hint), `hint 要列出可用角色：${b.error.hint}`);
});

t("缺陷 1 负例：pending 是 honest 的 —— 喷口格已被带子接货时绝不抢（port_already_bound）", () => {
    /* L4 的真实形态：cutter@(4,-13) 的 left 槽喷口 (4,-14) 上已有带子 10143，
       而它正朝机器接货（entry=bottom=OPP[top]）⇒ 那是下游，不是废料。 */
    const a = insertMachine({ at: [4, -13], facing: "top", machine: "cutter" }, CTX);
    assert.ok(a.ok, JSON.stringify(a.error));
    const b = trashUnused({ outlet: { pending: a.pending, port: "left" }, opts: { confirm_waste: true } }, CTX);
    eq(b.ok, false);
    eq(b.error.code, "port_already_bound");
    eq(b.error.detail.boundTo, 10143);
});

t("缺陷 1：replace_run 的 placed[] 每台新建筑也带 pending（打包宏同样可继续串）", () => {
    const r = replaceRun({ region: L4_REGION, building: L4_BUILDING }, CTX);
    assert.ok(r.ok, JSON.stringify(r.error));
    const cutter = r.placed.find(p => p.kind === "cutter");
    assert.ok(cutter.pending && isPendingRef(cutter.pending), "placed[].pending 必须是合法 PendingRef");
    eq(cutter.pending.ports.in.map(q => [q.role, q.slot, q.cell]), [["primary", [4, -13], [4, -12]]]);
    eq(cutter.pending.ports.out.map(q => [q.role, q.slot, q.cell]),
        [["left", [4, -13], [4, -14]], ["right", [5, -13], [5, -14]]],
        "planForOrigin 的 q.cell 已是**带格**；pending 必须给出同一口径（slot 反推回来）");
    /* 下游消费：给这台计划态 cutter 的 right 槽接 trash —— 它接货的带子 10150 还在 */
    const t = trashUnused({ outlet: { pending: cutter.pending, port: "right" }, opts: { confirm_waste: true } }, CTX);
    eq(t.ok, false);
    eq(t.error.code, "port_already_bound", "10150 正从 right 槽接货 ⇒ 绝对不能塞 trash");
});

t("缺陷 1：applyToWorld(replace_run) → 得到 180-3+2 = 179 实体的世界，且删集合逐 uid 正确", () => {
    const r = replaceRun({ region: L4_REGION, building: L4_BUILDING }, CTX);
    assert.ok(r.ok);
    const out = applyToWorld(r, CTX);
    eq(out.entities.length, ENTITIES.length - r.removed.length + r.placed.length);
    for (const rm of r.removed) assert.ok(!out.entities.some(e => e.uid === rm.uid), `uid=${rm.uid} 应已删`);
    const synth = out.entities.filter(e => e.uid < 0).map(e => [e.uid, e.type, e.x, e.y]);
    eq(synth, [[-1, "cutter", 4, -13], [-2, "trash", 4, -14]]);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4c. 缺陷 2：replace_run 的 consequences（与 remove_run 同口径）
 * ══════════════════════════════════════════════════════════════════════════ */

t("缺陷 2：replace_run 报出「谁指向 removed 格」—— 10148@(5,-12) 被 cutter 机身吃掉", () => {
    /* E2E §3.5 的漏报：10148 的出口指向 (5,-13)，那里改造后是 cutter 的**第二格机身**。
       cutter 唯一的输入槽在 (4,-13)（槽格），所以 (5,-13) 不会收货 ⇒ 真断线。
       旧实现只报 kept/removed 一侧 + sideEffects 的 kept-belt-starved，这条静默消失。 */
    const r = replaceRun({ region: L4_REGION, building: L4_BUILDING }, CTX);
    assert.ok(r.ok, JSON.stringify(r.error));
    const orphan = r.consequences.orphaned_outputs;
    eq(orphan.map(x => x.uid), [10148], "精确到 uid");
    eq(orphan[0].cell, [5, -12]);
    eq(orphan[0].eatenBy.type, "cutter");
    eq(orphan[0].eatenBy.cell, [4, -13], "吃掉它的是 cutter 的 origin");
    ok(/机身/.test(orphan[0].why), `why 必须说清真断线的机理：${orphan[0].why}`);
    /* 10208@(4,-12) 指向 (4,-13) 是**合法**的：那里正好是 cutter 输入槽的带格 */
    ok(!orphan.some(x => x.uid === 10208), "10208 指向输入槽带格，不能误报成断线");
    ok(r.warnings.some(w => w.code === "cut-upstream-feeds"), "必须浮到 warnings，不能只藏在字段里");
});

t("缺陷 2：consequences 与 remove_run 同形（四个数组恒在场，调用方不必判 ok 再取字段）", () => {
    const r = replaceRun({ region: L4_REGION, building: L4_BUILDING }, CTX);
    const rm = removeRun({ uids: [UID.b4_13, UID.b5_13, UID.b4_14] }, CTX);
    assert.ok(r.ok && rm.ok);
    for (const k of ["orphaned_outputs", "starved_belts", "starved_machines", "opaque"]) {
        ok(Array.isArray(rm.consequences[k]), `remove_run.consequences.${k} 必须是数组`);
        ok(Array.isArray(r.consequences[k]), `replace_run.consequences.${k} 必须是数组`);
    }
    eq(r.consequences.starved_belts.map(x => x.uid), [10144],
        "10144 失去上游（它原本从被删的 (4,-14) 接货，而新机器的 left 槽接的是 trash）");
    ok(Array.isArray(r.consequences.consumed_by_machine), "replace_run 多一档：被新机器接力的带子");
});

t("缺陷 2：consumed_by_machine 与 starved_belts 互补 —— 10150 是接力，不是断线", () => {
    /* cutter 的 right 槽喷口 (5,-14)，正是保留下来的 10150；它 entry=bottom=OPP[top] ⇒ 从机器接货。
       这是「接力」，旧实现把它算进 sideEffects 的 kept-belt-starved + starved-belt 两条。 */
    const r = replaceRun({ region: L4_REGION, building: L4_BUILDING }, CTX);
    assert.ok(r.ok);
    eq(r.consequences.consumed_by_machine.map(x => x.uid), [10150]);
    ok(!r.consequences.starved_belts.some(x => x.uid === 10150), "接力不是饿死");
    ok(r.warnings.some(w => w.code === "consumed-by-machine"));
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4d. 缺陷 3：dry_run 语义（恒 true = 本宏不写世界；调用方意图单列）
 * ══════════════════════════════════════════════════════════════════════════ */

t("缺陷 3：dry_run 恒 true（零写操作），调用方的 dry-run 意图在 requested_dry_run", () => {
    /* E2E §3.5 实测：不传 opts.dry_run 时返回 dry_run:false，被误读成「已写入」。
       实际什么都没写。现在 dry_run 恒 true，planned_only 恒 true，意图单列。 */
    for (const opts of [undefined, {}, { dry_run: true }, { dry_run: false }]) {
        const r = replaceRun({ region: L4_REGION, building: L4_BUILDING, ...(opts ? { opts } : {}) }, CTX);
        assert.ok(r.ok, JSON.stringify(r.error));
        eq(r.dry_run, true, `opts=${JSON.stringify(opts)} 时 dry_run 必须恒 true`);
        eq(r.planned_only, true);
        eq(r.requested_dry_run, opts ? opts.dry_run === true : false,
            "requested_dry_run 才是「本次有没有要求 dry-run」");
    }
    const fail = replaceRun({ region: [4, -13, 5, -13], building: L4_BUILDING }, CTX);
    eq(fail.ok, false);
    eq(fail.dry_run, true, "失败信封同口径");
    eq(fail.planned_only, true);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4e. 语义收紧：trash 剪断活链必须签字（E2E §4 V9 的静默通过）
 * ══════════════════════════════════════════════════════════════════════════ */

/* ⚠️ 这条原来写 `port:"right"`，注释还写着「right ∈ wasteRoles，旧实现直接放行」。
 * 2026-10-29 把 wasteRoles 修正为 ["left"] 后，right 成了非废料槽 ——
 * 但**这条测试要验的规则没变**：不管哪个槽，只要喷口格上的带子还在供货，
 * 接 trash 就是剪活链，必须签字。所以改成不写死槽名，而是**两个槽都试**：
 * 只要有一个槽会剪活链，就必须被拦。 */
t("语义闸【V9】：trash 接在仍有下游的喷口上且不签字 ⇒ 拒绝（剪活链必须签字）", () => {
    /* 不论 right 是不是 wasteRole：喷口格上的带子还有下游 ⇒ 剪活链 ⇒ 必须 confirm_waste。
       （旧实现里 wasteRoles 免签会让它静默通过 —— 那是 E2E §4 V9 记录的数据损失。） */
    const cutBy = [];
    for (const port of ["left", "right"]) {
        const r = replaceRun({ region: L4_REGION, building: ["cutter", { kind: "trash", port }] }, CTX);
        if (!r.ok && r.error.code === "precondition_failed" && /仍在供货|活链/.test(String(r.error.message))) {
            cutBy.push({ port, cuts: r.error.detail && r.error.detail.cuts });
        }
    }
    ok(cutBy.length > 0,
        "至少一个槽位会被「剪活链」闸拦住（否则这条防线是空的）",
        { tried: ["left", "right"], hits: cutBy.length });
    /* 若拦到了，细节必须点名具体 uid/downstream —— 让调用方能定位，不是笼统拒绝 */
    for (const h of cutBy) {
        ok(Array.isArray(h.cuts) && h.cuts.length > 0 && Number.isInteger(h.cuts[0].uid),
            `port="${h.port}" 的拒绝里带具体 uid`, h.cuts);
    }
    /* hint 必须告诉调用方「怎么签」—— 第六轮实验里模型看到"不可省"却不知道写哪 */
    for (const port of ["left", "right"]) {
        const r = replaceRun({ region: L4_REGION, building: ["cutter", { kind: "trash", port }] }, CTX);
        if (!r.ok) ok(/confirm_waste/.test(String(r.error.hint || "")),
            `port="${port}" 的拒绝 hint 提到 confirm_waste`, r.error.hint);
    }
});

t("语义闸【V9 正例】：签字后放行，并如实报 trash-cuts-chain（签了字也要留痕）", () => {
    const r = replaceRun({
        region: L4_REGION,
        building: ["cutter", { kind: "trash", port: "right", confirm_waste: true }],
    }, CTX);
    assert.ok(r.ok, JSON.stringify(r.error));
    eq(r.removed.map(x => x.uid), [10150, 10209, 10149], "V9 的形态：删掉的是右槽下游 10150");
    ok(r.warnings.some(w => w.code === "trash-cuts-chain"), "必须出现剪链警告");
    const w = r.warnings.find(x => x.code === "trash-cuts-chain");
    ok(/10150/.test(w.detail) && /10151/.test(w.detail), `detail 要指名被剪的链：${w.detail}`);
});

t("语义闸：L4 正解（left + confirm_waste）仍然通过 —— 闸门是签字，不是禁止唯一正解", () => {
    const r = replaceRun({ region: L4_REGION, building: L4_BUILDING }, CTX);
    assert.ok(r.ok, `L4 正解不能因新闸被拒：${JSON.stringify(r.error)}`);
    eq(r.removed.map(x => x.uid).sort((a, b) => a - b), [10143, 10149, 10209]);
});

t("语义闸：落点带子是死端时不需要额外签字（接一个死路 ≠ 剪一条活链）", () => {
    /* 铜线死路 (-10,-3) 的出口 (-10,-4) 是空的 ⇒ 从带子末端接 trash（trash_unused 路径）
       本来就没有链可剪。这条用例守住「闸门只对活链生效」，防止它退化成"处处要签字"。 */
    const r = trashUnused({ outlet: { uid: UID.cu_deadend } }, CTX);
    assert.ok(r.ok, JSON.stringify(r.error));
    eq(r.trashCell, [-10, -4]);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 零副作用：宏不得改世界（本次全部用例跑完后复查）
 * ══════════════════════════════════════════════════════════════════════════ */

t("全局：跑完 40+ 次调用后 entities 数组逐字节未变（宏零写操作）", () => {
    eq(JSON.stringify(ENTITIES), WORLD_SNAPSHOT);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 报告
 * ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
 * 第六轮：2 格宽机器放不进 1 格宽 region 时，报错必须**指出怎么改**
 *
 * 2026-10-28 第五轮实测：模型对两条并排链各调一次 replace_run，
 * 每次 region 只有 1 列宽 ⇒ 2×1 的 cutter 放不下 ⇒ occupied。
 * 原来的 hint 写「扩大到覆盖断口两侧」—— 对"分两次调用"这个真实病因毫无帮助。
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const { replaceRun } = await import("./remove.mjs");
    /* 用 L4-obs 夹具（含 goal/hub）；SAVE 是另一份只有 entities 的 dump */
    const obsPath = path.resolve(HERE, "../../../test/fixtures/saves/L4-obs.json");
    const obs = JSON.parse(fs.readFileSync(obsPath, "utf8")).result;
    const ctx2 = { entities: obs.entities };

    /* (4,-14)..(4,-11) 是 x=4 那一列 —— 1 格宽，放不下 2×1 的 cutter */
    const r = replaceRun(
        { region: [4, -14, 4, -11], building: ["cutter", { kind: "trash", port: "right", confirm_waste: true }] },
        ctx2,
    );
    t("2×1 机器放进 1 格宽 region ⇒ 必须拒绝", () => {
        ok(!r.ok, "竟然成功了 —— 1 格宽不该放得下 2×1 的 cutter");
        eq(r.error.code, "occupied", `期望 occupied，实得 ${r.error.code}`);
    });

    t("★ 拒绝提示说清「并排的另一条链也要框进来」", () => {
        const hint = String((r.error && r.error.hint) || "");
        ok(/并排/.test(hint), `hint 没提到并排：${hint.slice(0, 160)}`);
        ok(/\$path_of/.test(hint), `hint 没给出 \$path_of 的写法：${hint.slice(0, 160)}`);
        ok(/不要分两次|而不是分两次/.test(hint), `hint 没点明不要分两次调用：${hint.slice(0, 160)}`);
    });

    /* 对照：把两列一起框进去就能成 —— 证明提示说的是对的 */
    t("（对照）两列一起框 ⇒ 成功（证明提示给的方向是对的）", () => {
        const good = replaceRun(
            { region: [4, -15, 5, -10], building: ["cutter", { kind: "trash", port: "right", confirm_waste: true }] },
            ctx2,
        );
        ok(good.ok, good.ok ? "" : `${good.error.code}: ${good.error.message}`);
    });
}

for (const [st, name, msg] of results) {
    if (st === "ok") console.log(`\x1b[32m✓\x1b[0m ${name}`);
    else console.log(`\x1b[31m✗\x1b[0m ${name}\n      ${msg}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
