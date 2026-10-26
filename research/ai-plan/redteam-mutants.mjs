/**
 * redteam-mutants.mjs — 对 gates.test.mjs 做变异测试。
 *
 * 目的：证明「52 条全绿」不等于「断言有灵敏度」。
 * 做法：复制 src/agent/gates.mjs 到 .redteam/gates.mut.mjs，每次注入**一处**错
 *       （把某条判据变恒真 / 换掉 / 删掉），再跑同一套 gates.test.mjs（只改 import 路径）。
 *       mutant 存活 = 这套测试抓不到这个错 = 该判据在测试里没有 revisit。
 *
 * 不碰游戏、不改任何源文件。用法：node research/ai-plan/redteam-mutants.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve("D:/Projects/rea/Project work/shapez");
const DIR = path.join(ROOT, "research/ai-plan/.redteam");
fs.mkdirSync(DIR, { recursive: true });

/* 基线固定为 HEAD —— 本报告审查的是 1092 行的版本；
   工作区里的 src/agent/gates.mjs 在审查期间被另一个会话改过（已加入 G2'/G7/G8）。
   用 git show 取 HEAD 版本，保证「17 存活 / 9 被杀」可复现。 */
const base = execFileSync("git", ["show", "HEAD:src/agent/gates.mjs"], { cwd: ROOT, encoding: "utf8" });
/* 测试文件同样固定在 HEAD（审查时是 360 行 / 52 条）。 */
const testTpl = execFileSync("git", ["show", "HEAD:src/agent/gates.test.mjs"], { cwd: ROOT, encoding: "utf8" })
    .replace('from "./gates.mjs"', 'from "./gates.mut.mjs"');
fs.writeFileSync(path.join(DIR, "test.mut.mjs"), testTpl);

/** from 可以是字符串（必须唯一）或正则（用来区分同名分支，如两处 `if (before.truncated)`） */
const MUTANTS = [
    /* ── G4 ── */
    { id: "G4a-期望 rot 恒 0", from: `        const wantR = (ent.rot | 0) % 360;`, to: `        const wantR = 0;`,
      why: "全部夹具的 ent.rot 都是 0；唯一 r≠0 的夹具是「want 0 / got 90」的 cutter 反例，求值结果不变。gates.test.mjs:30-40" },
    { id: "G4b-期望 rot 取 rv", from: `        const wantR = (ent.rot | 0) % 360;`, to: `        const wantR = (ent.rotationVariant | 0) % 360;`,
      why: "所有夹具里 rot 与 rotationVariant 都是 0（或同为 0 的 cutter），两个字段在夹具上不可区分。" },
    { id: "G4c-朝向只查 cutter", from: `        if (gotR !== wantR) {`, to: `        if (ent.kind === "cutter" && gotR !== wantR) {`,
      why: "唯一的朝向反例是 cutter（gates.test.mjs:173-179）。事故发生在 **belt** 上 —— 套件的回归锁锁错了实体类型。" },
    { id: "G4d-朝向跳过 belt", from: `        if (gotR !== wantR) {`, to: `        if (ent.kind !== "belt" && gotR !== wantR) {`,
      why: "同上：没有任何一条夹具断言 belt 的 rot 必须被校验。" },
    { id: "G4e-新增集合退化为「after 有东西」", from: `    const addedByCell = new Map(added.map(e => [\`\${e.x},\${e.y}\`, e]));`,
      to: `    const addedByCell = new Map([...after.byUid.values()].map(e => [\`\${e.x},\${e.y}\`, e]));`,
      why: "所有夹具都构造成 after = before + added，所以「只认新增」与「认全部」在这些夹具上等价（gates.test.mjs:118-124）。" },
    { id: "G4f-不检查 uid 消失", from: `    if (gone.length > 0) {`, to: `    if (false) {`,
      why: "反向对照：这条**应被杀**，用来证明套件不是全瞎。" },
    { id: "G4g-缺实体不报", from: `    if (missing.length) {`, to: `    if (false) {`, why: "反向对照：应被杀。" },
    { id: "G4h-贴前截断不判", from: /^    if \(before\.truncated\) \{$/m, to: `    if (false) {`,
      why: "gates.mjs:378 的贴前截断分支零测试（套件只测了 after.truncated，gates.test.mjs:186-195）。" },

    /* ── G3 ── */
    { id: "G3a-自叠不报", from: `    if (Array.isArray(expectCells.collisions) && expectCells.collisions.length) {`, to: `    if (false) {`,
      why: "collisions 只在 expectedCells 层被测（gates.test.mjs:73-75），没有一条测试调用 gateG3 传一份自叠蓝图。" },
    { id: "G3b-未知 code 不报", from: `    if (Array.isArray(dryRun.unknown_code) && dryRun.unknown_code.length) {`, to: `    if (false) {`,
      why: "52 条测试里没有任何一条构造 unknown_code。" },
    { id: "G3c-数量判据 fail-open", from: `    if (dryRun.would_apply !== expectEntities) {`, to: `    if (dryRun.would_apply < expectEntities) {`,
      why: "测试只有「少 1 个」的反例（gates.test.mjs:99），没有「多 N 个」。" },
    { id: "G3d-数量判据整块关掉", from: `    if (dryRun.would_apply !== expectEntities) {`, to: `    if (false) {`, why: "反向对照：应被杀。" },

    /* ── G6b ── */
    { id: "G6b-a-真空绿不判", from: `    if (beltCells.size === 0) {`, to: `    if (false) {`,
      why: "没有任何夹具是「蓝图里没有普通带子」。gates.mjs:666-679 整段零覆盖。" },
    { id: "G6b-b-死路判据退回 === null", from: `        if (!p.boundAcceptor) {`, to: `        if (p.boundAcceptor === null) {`,
      why: "**名义上的回归锁实际测的是另一条判据**：gates.test.mjs:276-282 的夹具只覆盖 2 格带子中的 1 格，"
        + "所以它红是因为 uncovered（gates.mjs:735），不是因为 undefined acceptor。变异后仍红 ⇒ 这条锁是空的。" },
    { id: "G6b-c-未覆盖不报", from: `    if (uncovered.length) {`, to: `    if (false) {`, why: "反向对照：应被杀（3 条断言依赖它）。" },
    { id: "G6b-d-死路只在有货时报", from: `    if (deadEnds.length) {`, to: `    if (deadEnds.filter(d => d.items > 0).length) {`,
      why: "反向对照：应被杀（正是文档声称锁住「不看 itemsOnPath」的那条）。" },
    { id: "G6b-e-截断只在有未覆盖时报", from: `    if (truncated) {`, to: `    if (truncated && uncovered.length) {`,
      why: "反向对照：应被杀（第三轮新增的锁）。" },

    /* ── G6 ── */
    { id: "G6a-绝对阈值分支关掉", from: `    if (after.rate < target) {`, to: `    if (false) {`,
      why: "所有夹具的 p1 都带 6 片 ⇒ baselineRate 永不为 null ⇒ gates.mjs:591 这条分支在测试里不可达。" },
    { id: "G6b2-基线分支关掉", from: `    if (baselineRate !== null) {`, to: `    if (false) {`, why: "反向对照：应被杀。" },
    { id: "G6c-不排除最后一片", from: `    const done2 = slices2.slice(0, slices2.length - 1);`, to: `    const done2 = slices2.slice(0);`,
      why: "夹具每片计数都相同（gates.test.mjs:304-308 的 mkSlices），排除与否算出的平均数完全一样。" },
    { id: "G6d-全空片不判 undecidable", from: `    if (!anyData) {`, to: `    if (false) {`, why: "反向对照：应被杀。" },
    { id: "G6e-忽略 stacker/mixer 折算", from: `        const factor = INPUT_FACTOR[kind] || 1;`, to: `        const factor = 1;`,
      why: "expectedRateOf 既没 export，也没有任何测试间接打过（它是 G6 的阈值来源）。" },

    /* ── 主流程（runGates 调用路径）── */
    { id: "FLOW-a-G4 前后快照对调", from: `    const g4 = gateG4(intent, before, after);`, to: `    const g4 = gateG4(intent, after, before);`,
      why: "没有任何一条测试调用 runGates；所有断言都打在导出函数上。" },
    { id: "FLOW-b-G6 基线与采样对调", from: `    const g6 = gateG6(intent, baselineProd, prod2, expectedRateOf(intent, upgrades));`,
      to: `    const g6 = gateG6(intent, prod2, baselineProd, expectedRateOf(intent, upgrades));`,
      why: "同上：主流程参数顺序零覆盖。" },
    { id: "FLOW-c-debug_items region 写死", from: /    const region = \[\n        Math\.min\(ax, \.\.\.xs\) - pad, Math\.min\(ay, \.\.\.ys\) - pad,\n        Math\.max\(ax, \.\.\.xs\) \+ pad, Math\.max\(ay, \.\.\.ys\) \+ pad,\n    \]\.map\(Math\.round\);/m,
      to: `    const region = [-80, -80, 80, 80];`,
      why: "第二轮修过的 bug（M3-ROUND3.md 第 7 条）没有任何回归锁 —— 改回去测试仍全绿。" },

    /* ── 几何 ── */
    { id: "GEO-180/270 不向负方向长", from: `    const dx0 = (r === 180 || r === 270) ? -(w - 1) : 0;\n    const dy0 = (r === 180 || r === 270) ? -(h - 1) : 0;`,
      to: `    const dx0 = 0;\n    const dy0 = 0;`,
      why: "gates.test.mjs:43-48 只断言格数（length），从不断言 180/270 的**坐标**；条数不变 ⇒ 变异不可见。" },
];

const results = [];
for (const m of MUTANTS) {
    let mutated, note = null;
    if (m.from instanceof RegExp) {
        if (!m.from.test(base)) { results.push({ id: m.id, status: "BAD-FIXTURE", note: "正则不匹配" }); continue; }
        mutated = base.replace(m.from, m.to);
    } else {
        const n = base.split(m.from).length - 1;
        if (n !== 1) { results.push({ id: m.id, status: "BAD-FIXTURE", note: `from 出现 ${n} 次` }); continue; }
        mutated = base.replace(m.from, m.to);
    }
    fs.writeFileSync(path.join(DIR, "gates.mut.mjs"), mutated);
    let out = "", code = 0;
    try { out = execFileSync(process.execPath, [path.join(DIR, "test.mut.mjs")], { encoding: "utf8" }); }
    catch (e) { out = (e.stdout || "") + (e.stderr || ""); code = e.status === undefined ? 99 : e.status; }
    const fails = out.split("\n").filter(l => l.startsWith("✗")).map(l => l.trim().slice(2, 64));
    results.push({ id: m.id, status: code === 0 ? "SURVIVED" : "killed", fails, why: m.why, note });
}

console.log("═".repeat(104));
console.log("变异测试：每个 mutant 只改 gates.mjs 的一处判据，跑同一套 52 条自测");
console.log("═".repeat(104));
for (const r of results) {
    console.log(`${r.status.padEnd(10)} ${r.id}`);
    if (r.status === "SURVIVED") console.log(`           存活 —— ${r.why || ""}`);
    if (r.status === "killed") console.log(`           被 ${r.fails.length} 条断言抓到：${r.fails.slice(0, 2).join(" / ")}`);
    if (r.status === "BAD-FIXTURE") console.log(`           ${r.note}`);
}
const s = results.filter(r => r.status === "SURVIVED").length;
const k = results.filter(r => r.status === "killed").length;
const b = results.filter(r => r.status === "BAD-FIXTURE").length;
console.log("\n" + `存活 ${s} / 被杀 ${k} / 夹具无效 ${b} / 共 ${results.length}`);
