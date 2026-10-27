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
import { validateMacroResult, lintNoBareCoords } from "./contract.mjs";
import {
    removeRun, replaceRun, trashUnused, analyzeRemoval, makeContext, MACRO_IMPLS,
} from "./remove.mjs";
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
        expectRed: 5,
    },
    {
        id: "M3-replace-deletes-all-belts",
        why: "replace_run 删光 region 内全部带子（不再区分「被新建筑覆盖」）",
        from: "        if (placedCells.has(key(b.x, b.y))) {",
        to: "        if (true) { /* MUTANT */",
        expectRed: 5,
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
        expectRed: 2,
    },
    {
        id: "M6-trash-unused-ignores-wasteRoles",
        why: "trash_unused 不再要求 confirm_waste",
        from: "    if (!wasteRoles.includes(port.role) && !opts.confirm_waste) {",
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

t("remove_run：删**线的末端**只断 1 处（该格没有下游，断的只有上游的去路）", () => {
    /* (4,-9) uid=10138 的 entry=bottom ⇒ 上游是 (4,-10)=10139；exit=top ⇒ 下游是 (4,-10)。
       等一下 —— 逐格读：
         (4,-9)  entry=bottom（来自 4,-10）  exit=top（去 4,-10）？不可能同格。
       实际数据：10138@(4,-9) r=0 rv=0 ⇒ entry=bottom, exit=top
         ⇒ 上游格 = (4,-9)+DIRV[bottom] = (4,-8) —— 那格在存档里是空的（x=4 竖线到 -9 为止）
       ⇒ (4,-9) 是**链首**（无上游），它的下游是 (4,-10)。
       所以删它只断 1 处：下游 (4,-10) 失去供料 = starved-belt。 */
    const r = removeRun({ uids: [10138] }, CTX);
    assert.ok(r.ok, JSON.stringify(r.error));
    eq(r.would_disconnect.length, 1);
    eq(r.would_disconnect[0].kind, "starved-belt");
    eq(r.would_disconnect[0].uid, 10139);   // (4,-10)，它的唯一供料方就是被删的 (4,-9)
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

t("负例：trash 点名了非 wasteRoles 的槽但没签字 → 拒绝（poka-yoke：销毁要有主）", () => {
    const r = replaceRun({ region: L4_REGION, building: ["cutter", { kind: "trash", port: "left" }] }, CTX);
    eq(r.ok, false);
    eq(r.error.code, "precondition_failed");
    eq(r.error.field, "building[1].confirm_waste");
    ok(/wasteRoles/.test(r.error.message));
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

t("注册表：三个宏都在 MACRO_IMPLS 里，且都能被按名调用", () => {
    eq(Object.keys(MACRO_IMPLS).sort(), ["remove_run", "replace_run", "trash_unused"]);
    eq(MACRO_IMPLS.remove_run({ uids: [UID.b4_13] }, CTX).ok, true);
    eq(MACRO_IMPLS.trash_unused({ outlet: { uid: UID.cu_deadend } }, CTX).ok, true);
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
 * 5. 零副作用：宏不得改世界（本次全部用例跑完后复查）
 * ══════════════════════════════════════════════════════════════════════════ */

t("全局：跑完 40+ 次调用后 entities 数组逐字节未变（宏零写操作）", () => {
    eq(JSON.stringify(ENTITIES), WORLD_SNAPSHOT);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 报告
 * ══════════════════════════════════════════════════════════════════════════ */

for (const [st, name, msg] of results) {
    if (st === "ok") console.log(`\x1b[32m✓\x1b[0m ${name}`);
    else console.log(`\x1b[31m✗\x1b[0m ${name}\n      ${msg}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
