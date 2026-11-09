/**
 * `checkpoint_*` —— 跨 tx 的撤销能力。
 *
 * ## 为什么需要这个测试
 *
 * `opTx` 内部的快照只活在**一次 tx 的调用栈**里（失败或 dry_run 时回滚，成功时丢弃）。
 * 所以 tx 之间没有任何撤销能力：某个 tx 成功落盘后才发现把世界改坏了
 * （实测：到 hub 的带子 140→133），完全没有退路。
 *
 * `agent/loop` 现在能判出「这一步改坏了」（`V-health` / `classifyNetEffect`），
 * 但只能眼睁睁看着。检查点补的就是这段。
 *
 * ## 两层测试
 *
 * 1. **结构约束**（源码静态检查）：RPC 注册、load_save/new_game 必须清空、
 *    restore 必须走 runGuarded、restore 之后必须有自证。
 *    这些是「删掉就回归」的断言，而且 mod 在游戏里起不来、只能这样守。
 *
 * 2. **真实逻辑**（vm 沙箱 + 假 root）：把 `checkpointSave/Restore` 抽出来在
 *    假 root 上跑，验证淘汰策略、上限、自证判定、清空语义。
 *    这部分能真正跑起来，因为它不依赖 shapez 全局 —— `snapshotWorld` 只读
 *    `root.entityMgr`，`rollbackToSnapshot` 依赖的几个函数在沙箱里打桩。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(__dirname, "../src/mod/shapez-ai-bridge.js"), "utf8");

let pass = 0, fail = 0;
const t = (name, fn) => {
    try { const r = fn(); if (r && typeof r.then === "function") throw new Error("用例不该返回 Promise"); pass++; console.log("✓ " + name); }
    catch (e) { fail++; console.log("✗ " + name + "  " + (e && e.message)); }
};
const ok = (c, m) => { if (!c) throw new Error(m || "expected truthy"); };
const eq = (a, b, m) => { if (a !== b) throw new Error(m || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 结构约束（源码静态检查）
 * ══════════════════════════════════════════════════════════════════════════ */

t("C1 四个 checkpoint RPC 都注册进 dispatch", () => {
    for (const m of ["checkpoint_save", "checkpoint_restore", "checkpoint_list", "checkpoint_clear"]) {
        ok(new RegExp(`case\\s+"${m}"\\s*:`).test(SRC), `dispatch 里缺 case "${m}"`);
    }
});

t("C2 ★ load_save 必须清空检查点（换世界后 uid 全部失效）", () => {
    const start = SRC.indexOf("async loadSave(p) {");
    ok(start > 0, "找不到 loadSave");
    const body = SRC.slice(start, SRC.indexOf("\n    async ", start + 10));
    ok(/checkpointClearAll\(\s*["']load_save["']\s*\)/.test(body),
        "loadSave 里必须调 checkpointClearAll('load_save') —— 否则拿旧检查点恢复会把两个世界的实体混在一起");
});

t("C3 ★ new_game 必须清空检查点", () => {
    const start = SRC.indexOf("async newGame(p) {");
    ok(start > 0, "找不到 newGame");
    const body = SRC.slice(start, SRC.indexOf("\n    waitFor(", start));
    ok(/checkpointClearAll\(\s*["']new_game["']\s*\)/.test(body),
        "newGame 里必须调 checkpointClearAll('new_game')");
});

t("C4 load_save / new_game 把「清掉了几个」带回给调用方（不许静默失去撤销能力）", () => {
    ok(/checkpoints_cleared\s*:/.test(SRC), "返回值里必须有 checkpoints_cleared");
    eq((SRC.match(/checkpoints_cleared\s*:/g) || []).length, 2,
        "load_save 与 new_game 两处都要带（少一处就是静默）");
});

t("C5 checkpoint_restore 必须走 runGuarded（否则带子方向被游戏按邻居覆盖）", () => {
    const start = SRC.indexOf("async checkpointRestore(p = {}) {");
    ok(start > 0, "找不到 checkpointRestore");
    const body = SRC.slice(start, SRC.indexOf("\n    }\n", start));
    ok(/this\.runGuarded\s*\(/.test(body),
        "restore 必须在 runGuarded 里 —— 它与 tx 写同一种世界状态");
    ok(/this\._txDepth/.test(body),
        "restore 必须与 tx 互斥（_txDepth），否则两个写入交错");
});

t("C6 ★ restore 之后必须自证（不能只信 rollbackToSnapshot 的返回值）", () => {
    const start = SRC.indexOf("async checkpointRestore(p = {}) {");
    const body = SRC.slice(start, SRC.indexOf("\n    }\n", start));
    ok(/diffSnapshots\s*\(/.test(body),
        "restore 之后必须再 diff 一次 —— rollbackToSnapshot「每步都成功」不等于世界回到了快照");
    ok(/uid_set_equal/.test(body), "必须报 uid 集合是否相等");
    ok(/geometry_mismatch/.test(body), "必须报几何是否一致");
});

t("C7 自证只看几何（code/rotation/origin），不看组件逐字节", () => {
    const start = SRC.indexOf("async checkpointRestore(p = {}) {");
    const body = SRC.slice(start, SRC.indexOf("\n    }\n", start));
    ok(/want\.code\s*===\s*got\.code/.test(body), "必须比 code");
    ok(/want\.rotation\s*===\s*got\.rotation/.test(body), "必须比 rotation");
    ok(/origin\.x/.test(body) && /origin\.y/.test(body), "必须比 origin");
    /* 组件逐字节比较会让每次成功恢复都报失败 —— 因为 Belt.assignedPath 会被重算。 */
    ok(!/deepEqual\s*\(\s*want\s*,\s*got/.test(body), "不该整对象深比（组件里有会被重算的字段）");
});

t("C8 检查点有上限（数量 + 总实体数），且从最旧的开始丢", () => {
    ok(/CHECKPOINT_MAX_COUNT/.test(SRC), "必须有数量上限");
    ok(/CHECKPOINT_MAX_ENTITIES/.test(SRC), "必须有总实体上限（防 OOM）");
    ok(/checkpointDropOldest/.test(SRC), "必须有淘汰函数");
    const start = SRC.indexOf("checkpointDropOldest() {");
    const body = SRC.slice(start, SRC.indexOf("\n    }\n", start));
    ok(/st\.order\.shift\(\)/.test(body), "必须从 order 的头部（最旧）取");
});

t("C9 淘汰是「先按数量、再按总实体数」，且两个循环都留最后一个", () => {
    const start = SRC.indexOf("checkpointSave(p = {}) {");
    const body = SRC.slice(start, SRC.indexOf("\n    }\n", start));
    ok(/st\.order\.length\s*>\s*this\.constructor\.CHECKPOINT_MAX_COUNT/.test(body), "数量淘汰条件");
    ok(/st\.totalEntities\s*>\s*this\.constructor\.CHECKPOINT_MAX_ENTITIES\s*&&\s*st\.order\.length\s*>\s*1/.test(body),
        "总实体淘汰必须留至少一个（否则一个大世界连一个检查点都存不下）");
});

t("C10 restore 不删除检查点（可重复恢复），drop_after 才回退分支", () => {
    const start = SRC.indexOf("async checkpointRestore(p = {}) {");
    const body = SRC.slice(start, SRC.indexOf("\n    }\n", start));
    ok(!/st\.map\.delete\(name\)/.test(body), "restore 不该无条件删掉自己用的检查点");
    ok(/p\.drop_after\s*===\s*true/.test(body), "必须支持 drop_after");
    /* 分支回退只在 verified 时才做 —— 没恢复成功就丢检查点 = 把唯一的退路删了 */
    ok(/drop_after\s*===\s*true\s*&&\s*verified/.test(body),
        "drop_after 必须要求 verified，否则恢复失败时会把退路也删掉");
});

t("C11 同名 checkpoint 覆盖时，总实体数不许重复计算", () => {
    const start = SRC.indexOf("checkpointSave(p = {}) {");
    const body = SRC.slice(start, SRC.indexOf("\n    }\n", start));
    ok(/st\.map\.has\(name\)/.test(body), "必须先判断同名");
    ok(/st\.totalEntities\s*-=/.test(body), "覆盖前必须把旧的实体数减掉");
});

t("C12 找不到检查点时给 2004 且列出可用的（不是笼统 2001）", () => {
    const start = SRC.indexOf("async checkpointRestore(p = {}) {");
    const body = SRC.slice(start, SRC.indexOf("\n    }\n", start));
    ok(/2004/.test(body), "必须用 2004 not_found");
    ok(/Available:/.test(body), "hint 里必须列出可用的名字");
});

t("C13 restore 不许在 tx 内部执行（会递归）", () => {
    const start = SRC.indexOf("async checkpointRestore(p = {}) {");
    const body = SRC.slice(start, SRC.indexOf("\n    }\n", start));
    ok(/if\s*\(this\._txDepth\)/.test(body), "必须拒绝在 tx 内部调用");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 真实逻辑（vm 沙箱 + 假 root）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 从源码里切出一个方法体（含签名）。
 *
 * ⚠️ 不能用「找下一个 `\n    }\n`」—— 方法体内部只要有内层块（if/for/while），
 * 那个模式就会在**第一层内层块的结尾**被匹配到，切出来的代码是残的
 * （第一次跑就是 `Unexpected identifier 'diffSnapshots'`）。
 * 这里做真正的括号配对，并跳过字符串与注释。
 */
function sliceMethod(name) {
    /* 必须匹配「行首 + 4 空格 + 名字 + (」—— 只 `${name}(` 会命中**调用**点
       （实测：checkpointDropOldest 第一次命中的是 checkpointSave 里的 `this.checkpointDropOldest()`）。 */
    const re = new RegExp(`^    ${name}\\(`, "m");
    const m = re.exec(SRC);
    if (!m) throw new Error(`找不到 ${name}`);
    const start = m.index;
    /* ★ 要跳过参数表里的花括号 ★
     * `checkpointSave(p = {})` 的参数里有 `{}`。直接找第一个 `{` 会把**参数默认值**
     * 当成方法体的开始，于是括号配对从那里起算、在参数表结尾就「配平」了，
     * 切出来的是半个签名（实测生成 `checkpointSave(p = {})` 后被当成两个属性）。 */
    let i = SRC.indexOf("(", start);
    let pd = 0;
    for (; i < SRC.length; i++) {
        if (SRC[i] === "(") pd++;
        else if (SRC[i] === ")") { pd--; if (pd === 0) { i++; break; } }
    }
    i = SRC.indexOf("{", i);
    if (i < 0) throw new Error(`${name} 没有方法体`);
    let depth = 0;
    let inS = null, inLine = false, inBlock = false;
    for (; i < SRC.length; i++) {
        const c = SRC[i], next = SRC[i + 1];
        if (inLine) { if (c === "\n") inLine = false; continue; }
        if (inBlock) { if (c === "*" && next === "/") { inBlock = false; i++; } continue; }
        if (inS) {
            if (c === "\\") { i++; continue; }
            if (c === inS) inS = null;
            continue;
        }
        if (c === "/" && next === "/") { inLine = true; i++; continue; }
        if (c === "/" && next === "*") { inBlock = true; i++; continue; }
        if (c === '"' || c === "'" || c === "`") { inS = c; continue; }
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) return SRC.slice(start, i + 1);
        }
    }
    throw new Error(`${name} 的括号没有配对`);
}

/**
 * 把 checkpoint 相关的几个方法抽出来，在一个最小对象上跑。
 *
 * 为什么能跑：`snapshotWorld` 只读 `root.entityMgr.entities` 与 `entity.serialize()`；
 * `rollbackToSnapshot` 依赖 `deleteEntityByUid` / `restoreEntity` / `diffSnapshots` /
 * `restoreNextUid` / `snapshotWorld` —— 后四个在本文件里就能取到，前两个打桩。
 */
function makeSandbox() {
    const ctx = {
        console,
        rpcError: (code, name, detail, hint) => {
            const e = new Error(detail);
            e.__rpcError = { code, name, detail, hint };
            return e;
        },
    };
    vm.createContext(ctx);
    const names = [
        "snapshotWorld", "diffSnapshots", "diffJson", "checkpointStore", "checkpointClearAll",
        "checkpointSave", "checkpointDropOldest", "checkpointList",
    ];
    const srcs = names.map(n => sliceMethod(n));
    /* 静态 getter */
    const staticBlock = `
    const CHECKPOINT_MAX_COUNT = 3;        // 测试用小值，便于验证淘汰
    const CHECKPOINT_MAX_ENTITIES = 10;
    `;
    const code = `
    ${staticBlock}
    const MOD = {
    ${srcs.join(",\n")}
    };
    /* 注意：不能写 MOD.constructor = {...} 那种直接赋值 —— 那会覆盖对象原型上的
       constructor，之后 MOD 的属性查找与行为都会变得诡异（第一次跑即 Unexpected token）。
       源码里用的是 this.constructor.CHECKPOINT_MAX_*，所以这里必须让 MOD.constructor
       指向一个带那两个常量的普通对象 —— 用一个 null 原型的容器，避免继承干扰。 */
    MOD.constructor = Object.assign(Object.create(null), {
        CHECKPOINT_MAX_COUNT,
        CHECKPOINT_MAX_ENTITIES,
    });
    MOD.requireRoot = function () { return this.root; };
    MOD.ensureBuildingTables = function () { return {}; };
    /* snapshotWorld 里调 this.serializeEntity(e)。生产里它是真实现
       (:1800，走 entity.serialize() 存完整组件)；沙箱里打桩成同样的形状，
       否则每条实体会抛异常 ⇒ 全进 skipped ⇒ 快照恒空（第一次跑就是这样）。 */
    MOD.serializeEntity = function (e) {
        if (!e || !e.components || !e.components.StaticMapEntity) {
            throw this.rpcError(2001, "invalid_action", "serializeEntity: entity has no StaticMapEntity");
        }
        return e.serialize();
    };
    globalThis.__MOD = MOD;
    `;
    vm.runInContext(code, ctx);

    /* diffSnapshots 依赖 diffJson / 组件比较 —— 用真实实现即可（它只读数据） */
    const M = ctx.__MOD;
    const makeEntity = (uid, x, y, code = 1, rot = 0) => ({
        uid,
        layer: "regular",
        components: { StaticMapEntity: { code, rotation: rot, origin: { x, y } } },
        serialize() { return { uid, code, rotation: rot, origin: { x, y } }; },
    });
    const makeRoot = (n = 4) => {
        const ents = [];
        for (let i = 0; i < n; i++) ents.push(makeEntity(100 + i, i, 0));
        return { entityMgr: { entities: ents, nextUid: 100 + n }, time: { now: () => 1 } };
    };
    return { M, makeRoot, makeEntity, ctx };
}

t("C14 沙箱：save → list → 内容正确", () => {
    const { M, makeRoot } = makeSandbox();
    M.root = makeRoot(4);
    const r = M.checkpointSave({ name: "a" });
    eq(r.ok, true);
    eq(r.name, "a");
    eq(r.entities, 4);
    eq(r.total_checkpoints, 1);
    const list = M.checkpointList();
    eq(list.items.length, 1);
    eq(list.items[0].name, "a");
    eq(list.items[0].entities, 4);
});

t("C15 沙箱：超过数量上限时丢最旧的", () => {
    const { M, makeRoot } = makeSandbox();
    M.root = makeRoot(2);
    for (const n of ["a", "b", "c", "d"]) M.checkpointSave({ name: n });
    const list = M.checkpointList();
    eq(list.items.length, 3, "上限是 3");
    eq(list.items.map(i => i.name).join(","), "b,c,d", "最旧的 a 该被丢掉");
});

t("C16 沙箱：同名覆盖不重复计数", () => {
    const { M, makeRoot } = makeSandbox();
    M.root = makeRoot(3);
    M.checkpointSave({ name: "x" });
    eq(M.checkpointList().total_entities, 3);
    M.checkpointSave({ name: "x" });
    eq(M.checkpointList().total_entities, 3, "同名覆盖后总数不该翻倍");
    eq(M.checkpointList().items.length, 1);
});

t("C17 沙箱：总实体上限触发淘汰，且至少留一个", () => {
    const { M, makeRoot } = makeSandbox();
    M.root = makeRoot(6);                 // 每个检查点 6 个实体，上限 10
    M.checkpointSave({ name: "big1" });
    M.checkpointSave({ name: "big2" });
    const list = M.checkpointList();
    eq(list.items.length, 1, "6+6>10 ⇒ 只能留一个");
    eq(list.items[0].name, "big2", "留下的该是较新的那个");
});

t("C18 沙箱：clear 之后 list 为空、总数归零", () => {
    const { M, makeRoot } = makeSandbox();
    M.root = makeRoot(3);
    M.checkpointSave({ name: "a" });
    M.checkpointSave({ name: "b" });
    const c = M.checkpointClearAll("load_save");
    eq(c.cleared, 2);
    eq(c.reason, "load_save");
    eq(M.checkpointList().items.length, 0);
    eq(M.checkpointList().total_entities, 0);
});

t("C19 沙箱：快照真的存了 serialize() 的结果（含 code/rotation/origin）", () => {
    const { M, makeRoot } = makeSandbox();
    M.root = makeRoot(2);
    M.checkpointSave({ name: "a" });
    const snap = M.checkpointStore().map.get("a").snapshot;
    eq(snap.entities.size, 2);
    const p = snap.entities.get(100);
    ok(p, "uid 100 应该在快照里");
    eq(p.code, 1);
    eq(p.rotation, 0);
    eq(p.origin.x, 0);
    ok(typeof snap.nextUid === "number", "必须记录 nextUid（否则 uid 发号器回不去）");
});

t("C20 沙箱：没有 StaticMapEntity 的实体进 skipped，不进快照", () => {
    const { M, makeRoot } = makeSandbox();
    M.root = makeRoot(2);
    M.root.entityMgr.entities.push({ uid: 999, components: {} });   // 动态实体
    const r = M.checkpointSave({ name: "a" });
    eq(r.entities, 2, "动态实体不该进快照");
    eq(r.skipped, 1, "但必须报出来");
    eq(r.skipped_uids[0], 999);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
