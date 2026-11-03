/**
 * `tx` 必须跑在 immutable 语义下 —— 否则带子方向被游戏按邻居覆盖。
 *
 * ## 这个测试守的是什么
 *
 * 上游 `systems/belt.js:165-190`：
 *
 *     if (!this.root.immutableOperationRunning && (...)) {
 *         // computeOptimalDirectionAndRotationVariantAtTile() 重算并覆盖
 *     }
 *
 * 也就是说：`tx` 里传了精确的 `rotationVariant`，落盘后会被游戏按邻居改掉，
 * 除非外面包了 `logic.performImmutableOperation()`。
 *
 * 真机实测（2026-11-03）：
 *   改前 (4,-8): r=0 rv=0   ← 我们要的
 *   落盘后     : r=180      ← 被重算覆盖
 *   加了 runGuarded 之后: r=0 rv=0  ✅
 *
 * 而这个仓库里 `runGuarded()` 早就有（它同时管 bulk 与 immutable、且不嵌套 ——
 * 上游 `logic.js:190` 对重入是 assert 失败），`paste_blueprint` 也早就走那条路。
 * **只有 `tx` 漏了**，而且很久没暴露：绝大多数 tx 是「顺着已有链路放/删带子」，
 * 游戏重算出来的方向和我们要的一致。只有「刻意扭成非自然方向」时才会输。
 *
 * ## 为什么用源码静态检查
 *
 * mod 跑在游戏渲染进程里，依赖 `shapez` 全局、Electron、真实 root —— 单元测试
 * 起不来。这个文件能守的是**结构约束**（`opTx` 的执行循环必须在 `runGuarded`
 * 里），那正好是这次修的形态，而且真的会回归（删掉那层 package 就红）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(__dirname, "../src/mod/shapez-ai-bridge.js"), "utf8");

let pass = 0, fail = 0;
const t = (name, fn) => {
    try { fn(); pass++; console.log("✓ " + name); }
    catch (e) { fail++; console.log("✗ " + name + "  " + (e && e.message)); }
};
const ok = (c, m) => { if (!c) throw new Error(m || "expected truthy"); };

/** 取 `opTx(root, a)` 方法体（从签名到下一个同缩进的 `}`）。 */
function opTxBody() {
    const start = SRC.indexOf("    async opTx(root, a) {");
    ok(start > 0, "找不到 opTx 定义");
    /* 用「下一个 4 空格缩进的 }」当结束 —— 和 installRafWatchdog 的取法一致。 */
    const end = SRC.indexOf("\n    }\n", start);
    ok(end > start, "找不到 opTx 的结束");
    return SRC.slice(start, end);
}

/* ── T1：★ 核心 ★ tx 的执行循环必须在 runGuarded 里 ── */
t("T1 opTx 用 runGuarded 包住执行循环", () => {
    const body = opTxBody();
    ok(/this\.runGuarded\s*\(/.test(body),
        "opTx 里必须有 this.runGuarded(...) —— 否则带子方向会被游戏按邻居覆盖");
});

/* ── T2：runGuarded 包住的是**执行**，不是快照/校验 ── */
t("T2 runGuarded 包住的是 performAction 那一层", () => {
    const body = opTxBody();
    const guard = body.indexOf("this.runGuarded(");
    ok(guard > 0, "没有 runGuarded");
    const after = body.slice(guard);
    ok(/performAction\s*\(/.test(after),
        "runGuarded 之后应当紧跟着 performAction —— 包错了层等于没包");
});

/* ── T3：runGuarded 自己存在且管 immutable ── */
t("T3 runGuarded 同时管 bulk 与 immutable", () => {
    const start = SRC.indexOf("    runGuarded(root, fn) {");
    ok(start > 0, "找不到 runGuarded 定义");
    const end = SRC.indexOf("\n    }\n", start);
    const body = SRC.slice(start, end);
    ok(/performImmutableOperation/.test(body), "runGuarded 必须调 performImmutableOperation");
    ok(/performBulkOperation/.test(body), "runGuarded 必须调 performBulkOperation");
});

/* ── T4：runGuarded 不嵌套（上游对重入是 assert 失败，不是无害的） ── */
t("T4 runGuarded 不嵌套（先检查 immutableOperationRunning）", () => {
    const start = SRC.indexOf("    runGuarded(root, fn) {");
    const end = SRC.indexOf("\n    }\n", start);
    const body = SRC.slice(start, end);
    ok(/!root\.immutableOperationRunning/.test(body),
        "必须先判 !root.immutableOperationRunning —— 上游 logic.js:190 对重入 assert 失败");
    ok(/!root\.bulkOperationRunning/.test(body), "bulk 同理");
});

/* ── T5：paste_blueprint 也走这条路（回归：别把那条改掉） ── */
t("T5 paste_blueprint 也用 performImmutableOperation", () => {
    const idx = SRC.indexOf("performImmutableOperation");
    ok(idx > 0, "文件里必须至少有一处用到它");
    /* paste 那段用的是 root.logic.performImmutableOperation 直调 */
    ok(/performBulkOperation\(\(\)\s*=>\s*root\.logic\.performImmutableOperation/.test(SRC)
        || SRC.split("performImmutableOperation").length > 3,
        "paste_blueprint 那条路应当还在（它是这次修复的样板）");
});

/* ── T6：opTx 里不许出现「裸的」执行循环（防回归：把 runGuarded 又摘掉） ── */
t("T6 opTx 里 performAction 出现在 runGuarded 之后", () => {
    const body = opTxBody();
    const guard = body.indexOf("runGuarded");
    const perf = body.indexOf("performAction");
    ok(guard > 0 && perf > guard,
        `performAction(${perf}) 必须在 runGuarded(${guard}) 之后`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
