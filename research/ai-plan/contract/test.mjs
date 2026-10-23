/**
 * test.mjs — P1 `contract` 的 L0 总验收（plan-compiler.md §1.1 的四条，逐条对应）。
 *
 * 运行：node research/ai-plan/contract/test.mjs        退出码 0 = L0 通过
 * 零依赖：ESM + node: 内置（用 child_process 跑各包的 `node <file> --test`，无框架）。
 *
 * 分工：
 *   src/ai/compiler/grid.mjs --test    → §1.1-1 的 Grid 原语判据（本文件检查其退出码）
 *   src/ai/compiler/types.mjs --test   → §1.1-2 金样例 round-trip + §1.1-4 summarizeBlueprint
 *   research/ai-plan/contract/lint-imports.mjs → §1.1-3 的 import lint 判据（词法级，单一来源）
 *   本文件                              → 复跑上面全部 + 跨文件的契约完备性/枚举逐字核对 + C1 冲突矩阵
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const COMPILER = path.join(ROOT, "src", "ai", "compiler");
const FIX = path.join(ROOT, "research", "ai-plan", "fixtures");
/** Windows 下绝对路径必须转 file:// URL 才能 dynamic import */
const imp = p => import(pathToFileURL(p).href);

let fails = 0;
/**
 * 两种写法都支持：
 *   say(boolean, msg[, detail])          —— 布尔判据
 *   say(got, want, msg)                  —— 值比较（消息里带上实得值）
 * 区分规则：首参是布尔且次参是字符串 → 布尔式；否则 → 比较式。
 */
const say = (a, b, c) => {
    let pass, m, detail = "";
    if (typeof a === "boolean" && typeof b === "string") { pass = a; m = b; detail = c || ""; }
    else {
        const A = JSON.stringify(a), B = JSON.stringify(b);
        pass = A === B; m = c; detail = `实得 ${A}，期望 ${B}`;
    }
    console.log(`${pass ? "✓" : "✗"} ${m}${pass || !detail ? "" : `\n      ${detail}`}`);
    if (!pass) fails++;
};

/* ═══════════ §1.1-1 / §1.1-2：三个源文件自带的自测退出码必须为 0 ═══════════ */
for (const [file, need] of [
    ["errors.mjs", "§2.5 reason 枚举 + 规范化失败对象"],
    ["grid.mjs", "§1.1-1 同格二次 set 抛错 / 2×1 occupyRect / 三态冲突矩阵 / 旋转尺寸交换"],
    ["types.mjs", "§1.1-2 三个金样例 round-trip + 缺字段结构化错误；§1.1-4 summarizeBlueprint 读通"],
]) {
    const r = spawnSync(process.execPath, [path.join(COMPILER, file), "--test"], { encoding: "utf8", cwd: ROOT });
    const out = (r.stdout || "") + (r.stderr || "");
    const bad = out.split("\n").filter(l => l.startsWith("✗") || l.includes("Error")).slice(0, 6).join(" | ");
    say(r.status === 0, `node src/ai/compiler/${file} --test 退出码 0 —— ${need}`, bad || out.slice(-300));
}

/* ═══════════ §1.1-3：import lint（全目录；判据单一来源 = lint-imports.mjs） ═══════════ */
{
    const L = await imp(path.join(HERE, "lint-imports.mjs"));
    // lint 自身的判据也要有测试：本 P1 开发时裸 `from\s*["']` 正则真被 ["from","to"] 误报过
    const tricky = 'const k = ["from", "to"]; import { a } from "./real.mjs";';
    const naive = [...tricky.matchAll(/from\s*["']([^"']+)["']/g)].map(m => m[1]);
    say(naive.length === 2, "反例确认：裸 from 正则会把字符串里的 \"from\" 当模块路径（所以需要词法级 lint）", naive.join(","));
    say(L.collectImportSpecifiers(tricky).join(), "./real.mjs", "lint 判据：只收真正的 import 规格符");
    say(L.isProtoBeltRules("../../research/ai-player/proto/belt-rules.mjs"), true, "lint 判据：认得 proto/belt-rules 相对路径");
    say(L.isProtoBeltRules("../belt-rules.mjs"), false, "lint 判据：src/ai/belt-rules.mjs（权威）放行");

    const files = fs.readdirSync(COMPILER).filter(f => f.endsWith(".mjs")).sort();
    say(files.length >= 3, `src/ai/compiler/ 含 errors/grid/types（实得 ${files.join(", ")}）`);
    const problems = L.lintDirectory(COMPILER);
    for (const f of files) {
        const mine = problems.filter(p => p.file.endsWith(f));
        say(mine.length === 0, `${f}：无 proto/belt-rules import、只引权威副本、零依赖`,
            mine.map(p => `${p.kind} → ${p.detail}`).join(" | "));
    }
    for (const kind of ["proto/belt-rules import", "非权威 belt-rules 路径", "零依赖违例（裸包名 import）"]) {
        const hit = problems.filter(p => p.kind === kind);
        say(hit.length, 0, `全目录：${kind} = 0 处`, hit.map(p => `${path.basename(p.file)}→${p.detail}`).join(" | "));
    }
}

/* ═══════════ §1.1-4：金样例存在 + 蓝图段可解码（types.mjs 之外的第二双眼） ═══════════ */
{
    for (const f of ["plan-l1.json", "report-layout.json", "report-validator.json"]) {
        let obj = null, err = "";
        try { obj = JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8")); } catch (e) { err = String(e.message); }
        say(obj !== null, `fixtures/${f} 存在且是合法 JSON`, err);
    }
    const bpMod = await imp(path.join(ROOT, "src", "shared", "blueprint.mjs"));
    const plan = JSON.parse(fs.readFileSync(path.join(FIX, "plan-l1.json"), "utf8"));
    const sum = bpMod.summarizeBlueprint(plan.blueprint);
    say(sum.count, plan.entities.length, `summarizeBlueprint 读通金样例蓝图（${sum.count} 实体 / ${sum.text_length} 字符）`);
    const dec = bpMod.decodeBlueprint(plan.blueprint);
    say(dec.entities.length, plan.entities.length, "decodeBlueprint 回推实体数一致（stride=4 切分无损）");
    const allEqual = dec.entities.every((e, i) => {
        const p = plan.entities[i];
        return e.code === p.code && e.dx === p.dx && e.dy === p.dy && e.rot === p.rot;
    });
    say(allEqual, true, "逐格 (code,dx,dy,rot) 与 CompiledPlan.entities 全等（plan §1.6 L1 门的 P1 侧预锁）");
    say(sum.exported_from, "1.5.6", `gv=${sum.exported_from} 与 compat.json / docs/PROTOCOL.md:162 基线一致（不符 mod 报 2006）`);
}

/* ═══════════ 契约完备性：§2.5 reason 与 §2.4 check id 一个都不能漏、一个都不能多 ═══════════ */
{
    const { FAILURE_REASONS, CHECK_IDS } = await imp(path.join(COMPILER, "errors.mjs"));
    // 逐字抄 plan §2.5（`validate:<Vn>` 是参数化模板，不是字面量 —— 见 CONTEST.md 第 2 条）
    const PLAN_REASONS = [
        "dag-not-placeable:crossing-needs-tunnel", "dag-not-placeable:fanin>2", "dag-not-placeable:column-conflict-unresolved",
        "out-of-scope:multilayer", "out-of-scope:wire", "out-of-scope:tunnel", "out-of-scope:rotated-machine",
        "no-resource-in-range", "no-site-large-enough", "throughput:stacker-bottleneck", "belt-turn-unsolvable",
        "unlock:machine-not-available", "emit:mismatch", "live:paste-rejected-2002", "live:await-timeout", "live:intent-diff",
    ];
    const PLAN_CHECKS = ["V1-occupancy", "V2-no-overwrite-existing-belt", "V3-belt-fixed-point", "V4-slot-alignment",
        "V5-degree", "V6-crossing", "V7-throughput", "V8-scope", "V9-unused-outlet", "V10-unlock-report", "S1-shape-replay"];
    for (const r of PLAN_REASONS) say(FAILURE_REASONS.includes(r), true, `§2.5 reason 落地：${r}`);
    for (const c of PLAN_CHECKS) say(CHECK_IDS.includes(c), true, `§2.4 check id 落地：${c}`);
    say(FAILURE_REASONS.length, PLAN_REASONS.length, "§2.5 枚举无多余项");
    say(CHECK_IDS.length, PLAN_CHECKS.length, "§2.4 枚举无多余项");
}

/* ═══════════ C1 三态占用矩阵（P1 存在的理由，独立复述一遍） ═══════════ */
{
    const G = await imp(path.join(COMPILER, "grid.mjs"));
    const g = new G.Grid();
    g.set(0, 0, "old", { state: G.REPLACEABLE, kind: "belt" });
    g.set(5, 0, "mach", { state: G.SOLID, kind: "cutter" });
    const cases = [
        [0, 0, G.PLACE_MACHINE, {}, false, "既有 replaceable 带 × 机器 → 冲突"],
        [0, 0, G.PLACE_BELT, {}, false, "既有 replaceable 带 × 带子 → v1 默认冲突（绝不覆盖）"],
        [0, 0, G.PLACE_BELT, { allowReplaceable: true }, true, "既有 replaceable 带 × 带子 + 显式复用 → 可放"],
        [5, 0, G.PLACE_BELT, {}, false, "既有机器（solid）× 带子 → 冲突"],
        [5, 0, G.PLACE_BELT, { allowReplaceable: true }, false, "allowReplaceable 救不了 solid"],
        [2, 0, G.PLACE_MACHINE, {}, true, "空格 × 机器 → 可放"],
    ];
    for (const [x, y, kind, opts, want, m] of cases) say(g.canPlace(x, y, kind, opts), want, `C1 冲突矩阵：${m}`);
    const before = g.size();
    let threw = false;
    try { g.occupyRect(0, 0, 3, 1, "new"); } catch { threw = true; }
    say(threw && g.size() === before, true, "C1「任何非空格 → 整单 abort」：occupyRect 失败后一个格都不写");
}

/* ═══════════ 类型校验器确实被 Grid/Plan 两侧共享（防止 P1 自己两份实现漂移） ═══════════ */
{
    const T = await imp(path.join(COMPILER, "types.mjs"));
    const plan = JSON.parse(fs.readFileSync(path.join(FIX, "plan-l1.json"), "utf8"));
    say(T.assertCompiledPlan(plan, "plan").ok, true, "types.assertCompiledPlan 放行金样例（完整 CompiledPlan）");
    say(T.assertLayoutReport(plan.layout, "layout").cornerCount, 0, "types.assertLayoutReport 可独立消费 LayoutReport（P4/P5 的用法）");
    say(T.assertValidatorReport(plan.validation, "v").pass, true, "types.assertValidatorReport 可独立消费 ValidatorReport");
    // 金样例的 beltIntent 完整性（P7 逐格对拍的凭据）
    const intents = plan.entities.filter(e => e.kind === "belt");
    say(intents.every(e => e.inDir && e.outDir), true, `beltIntent 每格都有 inDir/outDir（${intents.length} 格，P7 对拍凭据）`);
    say(intents.every(e => e.code === 1 + e.rotationVariant), true, "每根带子 code === 1 + rv（belt-rules.mjs:55-56）");
}

/* ═══════════ 金样例的**几何审计**（用 P1 自己的 Grid + belt-rules 复查，不信任生成脚本） ═══════════ */
{
    const G = await imp(path.join(COMPILER, "grid.mjs"));
    const T = await imp(path.join(COMPILER, "types.mjs"));
    const B = await imp(path.join(ROOT, "src", "ai", "belt-rules.mjs"));
    const FOOTPRINT = { miner: [1, 1], belt: [1, 1], trash: [1, 1], hub: [4, 4], cutter: [2, 1], stacker: [2, 1], painter: [2, 1], mixer: [2, 1], rotater: [1, 1] };

    /** 对一份 entities 做四件几何审计；返回不合规清单。
     *  terminals = 允许作为「出口终点」的外部格键集合（既有世界，如 hub 4×4）。 */
    function auditEntities(label, ents, terminals = new Set()) {
        const problems = [];
        // 1) 占地互不重叠（多格机器按 footprint 铺开）：Grid.occupyRect 是唯一判据
        const g = new G.Grid({ name: label });
        for (const e of ents) {
            const [w, h] = FOOTPRINT[e.kind] || [1, 1];
            try { g.occupyRect(e.dx, e.dy, w, h, e.nodeId, { kind: e.kind === "belt" ? G.PLACE_BELT : G.PLACE_MACHINE, kindName: e.kind }); }
            catch (x) { problems.push(`重叠 ${e.nodeId}@${e.dx},${e.dy}: ${String(x.message).split("（")[0]}`); }
        }
        // 逐格归属（含多格机器的非锚格）—— 槽位对齐判据要用
        const owner = new Map();
        for (const e of ents) {
            const [w, h] = FOOTPRINT[e.kind] || [1, 1];
            for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
                const k = G.cellKey(e.dx + dx, e.dy + dy);
                if (!owner.has(k)) owner.set(k, e);
            }
        }
        const belts = ents.filter(e => e.kind === "belt");
        // 2) 链闭合 + 槽位对齐：每根带子的出口必须落在实体（或声明的外部终点）上且方向互补
        for (const u of belts) {
            const v0 = B.DIRV[u.outDir];
            const vx = u.dx + v0[0], vy = u.dy + v0[1];
            const v = owner.get(G.cellKey(vx, vy));
            if (!v) {
                if (!terminals.has(G.cellKey(vx, vy))) problems.push(`悬空出口 ${u.nodeId}：出口 ${u.outDir} 指向空处 (${vx},${vy})`);
                continue;
            }
            if (v.inDir && B.OPP[u.outDir] !== v.inDir) problems.push(`槽位不接 ${u.nodeId}→${v.nodeId}：exit=${u.outDir} 下游 inDir=${v.inDir}（应 ${B.OPP[u.outDir]}）`);
        }
        // 3) (r,rv) 与 inDir/outDir 自洽：solveTurn 反查恒等（红队 #1 的正解判据）
        for (const e of belts) {
            const s = B.solveTurn(e.inDir, e.outDir);
            if (!s || s.rotation !== e.rot || s.rotationVariant !== e.rotationVariant) {
                problems.push(`solveTurn 不自洽 ${e.nodeId}(r=${e.rot},rv=${e.rotationVariant},${e.inDir}→${e.outDir})`);
            }
        }
        // 4) 机器槽位朝向符合 GEOMETRY 表1（矿机出 top / trash 与 hub 无输出 / 机器恒 r=0）
        for (const e of ents) {
            if (e.kind === "belt") continue;
            if (e.kind === "miner" && (e.outDir !== "top" || e.inDir !== null)) problems.push(`矿机槽位违规 ${e.nodeId}`);
            if ((e.kind === "trash" || e.kind === "hub") && e.outDir !== null) problems.push(`${e.kind} 不该有输出 ${e.nodeId}`);
            if (e.rot !== 0) problems.push(`机器 r≠0（决策 D1）${e.nodeId}`);
        }
        return { problems, belts, grid: g, owner };
    }

    /* ── plan-l1（零拐角、全竖直线；plan §2.7） ── */
    const p1 = T.assertCompiledPlan(JSON.parse(fs.readFileSync(path.join(FIX, "plan-l1.json"), "utf8")), "plan");
    // hub 是既有世界：它的 16 格作为「允许终点」参与链闭合判定（物流进 hub 底排）
    const hubCells = new Set(p1.layout.occupancy.map(o => G.cellKey(o.cell[0], o.cell[1])));
    const a1 = auditEntities("plan-l1", p1.entities, hubCells);
    say(a1.problems, [], "plan-l1：几何审计 0 违规（占地/链闭合/solveTurn/槽位朝向）");
    say(a1.belts.length, p1.stats.beltTiles, `plan-l1：带子数与 stats 一致（${a1.belts.length}）`);
    say(p1.entities.filter(e => e.kind === "belt" && e.rotationVariant !== 0).length, 0, "plan-l1：零拐角（§2.7 第一原则）");
    say([p1.stats.corners, p1.layout.cornerCount], [0, 0], "plan-l1：stats.corners === layout.cornerCount === 0");
    say(p1.grid === undefined && p1.layout.grid.split("\n").length, p1.stats.bbox[1], "plan-l1：layout.grid 行数 === bbox 高（逐字节可 diff）");
    // hub 4×4 只在 occupancy，绝不进 entities（否则 paste 会砸掉 hub）
    say(p1.entities.some(e => e.kind === "hub"), false, "plan-l1：hub 不作为实体输出（既有世界，只在 layout.occupancy）");
    say(p1.layout.occupancy.length, 16, "plan-l1：occupancy 记满 hub 4×4（16 格）");
    // 规划区与 hub 零重叠（V1 的原语口径）
    {
        const occ = new Set(p1.layout.occupancy.map(o => G.cellKey(o.cell[0], o.cell[1])));
        const hits = p1.entities.filter(e => occ.has(G.cellKey(e.dx, e.dy)));
        say(hits, [], "plan-l1：落点与 hub 4×4 零重叠（V1-occupancy 判据）");
    }

    /* ── 双分支汇合的 beltIntent（P4/P7 对拍凭据 + M4-SUCCESS 实机期望值） ── */
    const mi = JSON.parse(fs.readFileSync(path.join(HERE, "merge-belt-intent.json"), "utf8"));
    const am = auditEntities("merge", mi.entities);
    say(am.problems, [], "report-layout beltIntent：几何审计 0 违规（含两个拐角 + 西向车道）");
    say(mi.entities.filter(e => e.kind === "belt" && e.rotationVariant !== 0).length, 2, "report-layout：恰 2 个拐角（M4-SUCCESS 关键 1：只让一条分支拐弯）");
    for (const w of mi.live_expectations) {
        const got = mi.entities.find(e => e.dx === w.cell[0] && e.dy === w.cell[1]);
        say(got ? [got.rot, got.rotationVariant, got.code] : null, [w.rot, w.rotationVariant, w.code],
            `拐角 ${w.cell} == 实机 ${w.world} 的 (r,rv,code)（${w.source}）`);
    }
    // 车道不同行（陷阱表 #5）：两条通道若各有 lane，必须互不相同
    const lay = JSON.parse(fs.readFileSync(path.join(FIX, "report-layout.json"), "utf8"));
    const lanes = lay.lanes.map(l => l.row);
    say(new Set(lanes).size, lanes.length, "report-layout：车道行号互不相同（陷阱表 #5）");
    say(lay.conflicts.every(c => ["cell-occupied", "lane-column", "crossing", "no-turn", "hub-contention"].includes(c.kind)), true, "report-layout：conflicts.kind ∈ §2.3 枚举");
    say(lay.placements.every(p => p.rot === 0), true, "report-layout：placements 全部 r=0（决策 D1）");
    // stacker 双输入的层映射（GEOMETRY 表1：左格=下层、右格=上层）
    const stIn = lay.channels.filter(c => c.to.nodeId === "st");
    say(stIn.map(c => [c.to.cell, c.slotRole]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        [[[0, 1], "lower"], [[1, 1], "upper"]],
        "report-layout：stacker 左格=lower、右格=upper（M3 实机确认的槽位→层映射）");

    /* ── 审计的**反向对照**：绿色必须是有意义的绿，所以故意注入错，逐项验它会被抓到 ── */
    {
        const cloneE = () => JSON.parse(JSON.stringify(p1.entities));
        // a) 改 rv 但不改方向 → solveTurn 不自洽要被抓（红队 #1 的错法）
        const e2 = cloneE(); const b2 = e2.find(e => e.kind === "belt"); b2.rotationVariant = 1;
        say(auditEntities("neg-solveTurn", e2, hubCells).problems.length > 0, true, "反向对照：rv 改了而方向没改 → 审计抓到（solveTurn 不自洽）");
        // b) 两实体同格 → 占地重叠要被抓
        const e3 = cloneE(); e3[1].dx = e3[0].dx; e3[1].dy = e3[0].dy;
        say(auditEntities("neg-overlap", e3, hubCells).problems.some(s => s.startsWith("重叠")), true, "反向对照：两实体同格 → 审计抓到占地重叠");
        // c) 矿机改成出 left（违反 GEOMETRY 表1）→ 要被抓到，并且 plan 级 assert 也要拒
        const e4 = cloneE(); e4.find(e => e.kind === "miner").outDir = "left";
        say(auditEntities("neg-slot", e4, hubCells).problems.some(s => s.includes("矿机槽位")), true, "反向对照：矿机出 left → 审计抓到（表1 恒 top）");
        // d) 悬空出口：把最上一条带子的出口指向空处
        const e5 = cloneE(); const top = e5.filter(e => e.kind === "belt").sort((a, b) => a.dy - b.dy)[0]; top.dx = 7; top.dy = 7; top.inDir = "bottom"; top.outDir = "top"; top.nodeId = "orphan";
        say(auditEntities("neg-dangling", e5, new Set()).problems.some(s => s.includes("悬空出口")), true, "反向对照：出口指向空处 → 审计抓到悬空出口");
        // e) 机器 r=90 → 决策 D1 要拒（plan 级）
        const raw6 = JSON.parse(fs.readFileSync(path.join(FIX, "plan-l1.json"), "utf8"));
        raw6.entities.find(e => e.kind === "cutter").rot = 90;
        let d1 = "";
        try { T.assertCompiledPlan(raw6, "plan"); d1 = "未抛错"; } catch (x) { d1 = String(x.message).includes("rot") ? "抓到 rot" : "抓到但非 rot: " + x.message.slice(0, 60); }
        say(d1, "抓到 rot", "反向对照：机器 r=90 → assertCompiledPlan 按决策 D1 拒绝");
        // f) 用 proto 的错误公式（beltEntry = OPP[beltExit]）会把拐角判反 —— 直接对照两种公式
        const wrongEntry = d => B.OPP[d];   // ❌ proto/belt-rules.mjs:49 的写法
        const corner = mi.entities.find(e => e.dx === 1 && e.dy === 3);
        say(corner.inDir === wrongEntry(corner.outDir), false,
            "反向对照：proto 的错误公式 beltEntry=OPP[beltExit] 会把本拐角判反（所以只许 import src/ai/belt-rules.mjs）");
        say(B.beltEntry(corner.rotationVariant, corner.rot), corner.inDir, "正解对照：权威 beltEntry(rv,r) === inDir");
    }
}

console.log(fails ? `\nP1 contract L0: ${fails} 条失败` : "\nP1 contract L0: 全部通过");
process.exitCode = fails ? 1 : 0;
