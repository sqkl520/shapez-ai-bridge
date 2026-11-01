/**
 * loop.mjs — 阶段 2 的**主状态机**：observe → diagnose → propose → plan → apply → verify → repair(判定)。
 *
 * 唯一真值：`research/ai-plan/PHASE2-CONTRACT-V2.md`（v2 补丁优先于 v1）。
 * 本文件不重写那 7 个模块里的任何一条判据 —— 它只做「接线 + 记账 + 何时停」，
 * 所有判定都调用它们已有的 API：
 *
 *   constants.mjs        BUDGET / DIAG_CODES / MODES / RUN_DIR / RETRIEVAL_TABLE
 *   handles.mjs          buildHandles / resolveHandle / bboxOf / describeEntity
 *   coords.mjs           assertNoHumanCoords / resolveRefs / assertProvenance
 *   planToTxOps.mjs      宏结果 → 一次 tx 的 ops[]（含 deriveFlows）
 *   verify.mjs           verifyRound / strictVerdict / applyVerdict / undeclaredDestruction
 *   llm.mjs              makeClient / parseLlmPlan / MockExhausted
 *   prompt.mjs           buildPrompt
 *   offline_boundary.mjs classifyChecks / phaseTwoVerdict   ← **成功判据必须走它**
 *
 * ## 本文件发现自己需要、但那 7 个模块不提供的三样东西（适配层，全部写在这里）
 *
 * 1. **per-op provenance**：`planToTxOps.mjs` 明确不产出 `ops[i].provenance`，
 *    而 `coords.mjs#assertProvenance` 对没有这一层的 txPlan **一律判红**
 *    （coords.mjs:504-517 的注释里写明了这个不一致，并要求 loop 自己补）。
 *    这里用 `sourceOfPlace()` 把每条 place 反查回「是哪个宏的哪条声明」，
 *    再按优先级挂 `macro:<token>` / `computed:bbox_of[…]` / `obs:uid=N` 三种标签之一。
 *    **连不上来源的 place 一律不挂标签** → assertProvenance 报 MISSING_PROVENANCE，
 *    而不是编一个看起来合法的标签（那就把唯一能证伪的防线变成了装饰）。
 *
 * 2. **tx 的离线替身**：`FakeGame` 只有 `apply(ops)`（原地改实体表），没有 tx。
 *    `fakeTx()` 把它包装成 bridge 的返回形状（`bridge:3387-3408`），
 *    **只用于不含 `diff`/`verify` 语义的离线链路**；`rolled_back` 恒 false、`verify` 恒 null，
 *    所以 `applyVerdict` 在这里只检 `ok/applied/diff` 三项。真实原子性必须实机验。
 *
 * 3. **HALT 原因闭集**：`constants.mjs` 的 `DIAG_CODES` 里没有「离线全绿但不构成达成」这一条，
 *    而 run_end 又必须给一个机器可检的 reason。这里声明 `HALT_REASONS = DIAG_CODES ∪ {OFFLINE_ONLY, DRY_RUN}`，
 *    并**只在此处**做加法（不改 constants.mjs —— 它是另一份已经冻结的真值）。
 *
 * ## 这个状态机刻意不做的事
 *
 *   · 不做「确定性修复表」（v1 §1.7 的 rv_settle / rebind）：`rv_settle` 在代码里不存在，
 *     `repairHints` 也不存在（红队诊断码可判定性抽查已证）。假装有它 = 多一条空炮防线。
 *   · 不自动回滚：tx 自己在 mod 侧是原子的；loop 侧回滚需要第二份世界快照的真值。
 *   · 不把 `verifyRuntime().ok` 当成功：成功判据只有 `phaseTwoVerdict().achieved`。
 *   · 不在离线模式下判 success：`offline-only` 是**决策链通过**，不是阶段 2 达成（V2 §6）。
 *
 * 零依赖（只用 node 内置 + 仓库内只读模块）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { BUDGET, DIAG_CODES, MODES, RUN_DIR, RETRIEVAL_TABLE } from "./loop/constants.mjs";
import { buildHandles, resolveHandle } from "./loop/handles.mjs";
import { assertNoHumanCoords, resolveRefs, assertProvenance } from "./loop/coords.mjs";
import { planToTxOps } from "./loop/planToTxOps.mjs";
import { verifyRound, applyVerdict, buildUidMap, worldUidSetHash } from "./loop/verify.mjs";
import { makeClient, parseLlmPlan, MockExhausted } from "./loop/llm.mjs";
import { buildPrompt } from "./loop/prompt.mjs";
import { classifyChecks, phaseTwoVerdict } from "./loop/offline_boundary.mjs";

import { MACRO_IMPLS, replaceRun, removeRun, trashUnused } from "./macros/remove.mjs";
import { insertMachine, extendLine } from "./macros/place.mjs";
import { connect } from "./macros/connect.mjs";
import { validateMacroCall, MACRO_NAMES } from "./macros/contract.mjs";
/* `indexOf`（原 buildIndex）/ `hubReachable` / `upstreamAt` / `inputFed` / `outputRouted`
 * 在 P-a0 里搬到了 `loop/topology.mjs`（几何真值的唯一实现）。
 * 这里仍然用 `hubReachable` 等旧名字 `export { … } from` 一次，**保持兼容** ——
 * 既有的 import 方（verify / 测试 / 第三方脚本）一个字都不用改。
 * 本文件内部现在只 import `indexOf`（改名 `buildIndex`）：结构判据全部走
 * `structuralDiagnoses`，下游可达性由它在内部按 tier 使用，不再在这里重复算。 */
import { indexOf as buildIndex } from "./loop/topology.mjs";
import { structuralDiagnoses } from "./loop/structural.mjs";
/* 语义层（P-a）：形状传播 + 配方闭包 + 作业分配。**不自己 spawn** ——
   配方由 loop 首轮 observe 后预计算一次、放进 `ctx.recipe` 注入；
   这样 `diagnose` 仍然是纯函数（同 obs 调两次逐字节相同），指纹与 NO_PROGRESS_3X 才成立。 */
import { semanticDiagnoses } from "./loop/semantic.mjs";
import { recipeForCached } from "./loop/recipe.mjs";
/* hub 入口判据需要世界几何：`slotsOf` 是槽位几何的**唯一**实现（handles/semantic/verify 同源），
   在这里抄一份就是第三份真值。 */
import { slotsOf, beltRvOf } from "./verify_runtime.mjs";
import FakeGame from "./fake_game.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SAVES = path.join(REPO, "test/fixtures/saves");
const LLM_FIXTURES = path.join(REPO, "test/fixtures/llm");

/* ══════════════════════════════════════════════════════════════════════════
 * 0. 常量与闭集
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 宏名 → 真实实现。**逐个来自宏文件**（不写第二份名字表）：`MACRO_NAMES` 是名字的真值，
 * 这里只补「哪个函数」，并在加载时断言两边是同集合 —— 少一个就是实机 2001。
 */
const MACRO_FNS = Object.freeze({
    remove_run: removeRun,
    replace_run: replaceRun,
    trash_unused: trashUnused,
    insert_machine: insertMachine,
    extend_line: extendLine,
    connect: connect,
});
for (const n of MACRO_NAMES) {
    if (typeof MACRO_FNS[n] !== "function") {
        throw new Error(`loop.mjs: 宏 "${n}" 没有实现入口（MACRO_NAMES 与 MACRO_FNS 不同集合）`);
    }
}

/**
 * run_end.reason 的闭集 = DIAG_CODES 的全部码 + 两个 run 级状态。
 *
 * 为什么需要后两个（而不是硬塞进 DIAG_CODES）：
 *   · `OFFLINE_ONLY` —— 离线全绿。它不是「诊断」，是「这次 run 证明了什么」的边界；
 *     offline_boundary 已经给出 `level:"offline-only"`，run_end 必须能原样表达它，
 *     否则「离线跑通」在 transcript 里没有可 grep 的落点。
 *   · `DRY_RUN` —— 只跑到 plan 就停（`--dry-run`），世界零写入。
 * 两者都**不在** `DIAG_CODES` 里，所以 `diagnose()` 永远不会产出它们；
 * 验收判据应写成 `reason ∈ DIAG_CODES ∪ HALT_REASONS`（红队 #8 的修法）。
 */
export const HALT_REASONS = Object.freeze([
    ...Object.keys(DIAG_CODES),
    "OFFLINE_ONLY",
    "DRY_RUN",
]);

/** 阶段 2 第一版里 diagnose 会产出的码（每个都有真实数据来源，见 `diagnose()`）。 */
export const DIAGNOSE_CODES = Object.freeze([
    "OBS_TRUNCATED", "PATHS_TRUNCATED", "PRODUCTION_UNAVAILABLE", "ITEMS_UNAVAILABLE",
    "LLM_TRANSPORT", "LLM_PARSE", "LLM_EMPTY_PLAN", "LLM_COORD", "LLM_UNKNOWN_MACRO",
    "LLM_ARGS", "LLM_LINT", "MACRO_REFUSED", "MACRO_HALF_DONE", "PLAN_REJECTED",
    "COORD_PROVENANCE", "PATH_NOT_RECT", "OBS_STALE",
    "TX_ROLLED_BACK", "NO_WORLD_CHANGE",
    "LANDING_MISSING", "LANDING_MISMATCH", "DELETE_NOT_REPLAYED",
    "SLOT_STARVED", "OUTPUT_UNROUTED", "FLOW_UNREACHABLE", "FLOW_UNVERIFIED", "DEAD_END",
    "NO_PRODUCTION", "PRODUCED_NOT_DELIVERED",
    "NO_DIAGNOSIS", "NO_PROGRESS", "NO_PROGRESS_3X",
    "BUDGET_ROUNDS", "BUDGET_LLM_CALLS", "BUDGET_TX", "BUDGET_TICKS", "BUDGET_WALL",
    "MOCK_EXHAUSTED", "INTERNAL",
]);

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 小工具
 * ══════════════════════════════════════════════════════════════════════════ */

const K = c => `${c[0]},${c[1]}`;
const isInt = n => typeof n === "number" && Number.isInteger(n);
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);

export const sha256 = s => `sha256:${crypto.createHash("sha256").update(String(s)).digest("hex")}`;
const hashJson = v => sha256(stableJson(v));

/** 稳定序列化（键排序）—— 同一个对象必须永远得到同一个 hash。 */
export function stableJson(v) {
    const walk = x => {
        if (Array.isArray(x)) return x.map(walk);
        if (isObj(x)) {
            const o = {};
            for (const k of Object.keys(x).sort()) o[k] = walk(x[k]);
            return o;
        }
        if (typeof x === "number" && !Number.isFinite(x)) return String(x);
        if (typeof x === "function") return "<fn>";
        return x;
    };
    try { return JSON.stringify(walk(v)); } catch { return JSON.stringify(String(v)); }
}

function unwrapObs(obs) {
    if (obs && typeof obs === "object" && !Array.isArray(obs.entities)
        && obs.result && Array.isArray(obs.result.entities)) return obs.result;
    return obs && typeof obs === "object" ? obs : {};
}

/**
 * 收集「LLM 真正指名的实体 uid」（R13 的输入）。
 *
 * 来源只认三种**指名**算子：`$ref` / `$uids` / `$path_of`（都是"这些句柄所指的实体"）。
 * **`$bbox_of` 不算** —— 它表达的是「覆盖这一块的矩形」，本身不指名具体对象；
 * 而它顺带框进没点名的格子，正是 R13 要拦的那类问题。
 *
 * 解析后的 `args` 里这些算子已经被换成 uid / cell / region 了，所以这里
 * **从原计划**（res.calls 之前的 llmPlan）读更可靠；但 resolveRefs 也把
 * provenance 记了下来。用 provenance 里 `obs:uid=N` 的那部分最直接。
 *
 * @returns {Set<number>} 被指名的 uid 集合（空集合 = 没有任何指名，R13 不判）
 */
function collectNamedUids(resolvedCalls, obs, handles) {
    const out = new Set();
    const byUid = new Map(((obs && obs.entities) || []).map(e => [e.uid, e]));
    for (const c of resolvedCalls || []) {
        /* ① 从 provenance 拿：`obs:uid=N` 就是「指名了一个已存在实体」 */
        const prov = c && c.provenance;
        if (prov && typeof prov === "object") {
            for (const v of Object.values(prov)) {
                if (typeof v !== "string") continue;
                const m = /^obs:uid=(\d+)$/.exec(v.trim());
                if (m) out.add(Number(m[1]));
            }
        }
        /* ② 从解析后的 args 拿：`{uid}` / `[uid,...]` 形态（resolveRefs 的产物） */
        const walk = v => {
            if (typeof v === "number" && byUid.has(v)) { out.add(v); return; }
            if (Array.isArray(v)) { v.forEach(walk); return; }
            if (v && typeof v === "object") {
                if (typeof v.uid === "number" && byUid.has(v.uid)) out.add(v.uid);
                for (const k of Object.keys(v)) {
                    if (k === "region") continue;   // region 是"一块地"，不指名对象
                    walk(v[k]);
                }
            }
        };
        if (c && c.args) walk(c.args);
    }
    void handles;
    return out;
}
function unwrapItems(items) {
    if (items && typeof items === "object" && !Array.isArray(items.paths)
        && items.result && typeof items.result === "object") return items.result;
    return items && typeof items === "object" ? items : null;
}

const nowIso = () => new Date().toISOString();

/** 句柄 → 给诊断用的 subject（**只有句柄，没有坐标**）。 */
function subjectOf(handles, uid, type) {
    if (handles && isInt(uid)) {
        const h = handles.byUid.get(uid);
        if (h) {
            const e = handles.byHandle.get(h);
            return { handle: h, type: (e && e.type) || type || null, uid };
        }
    }
    /* 没句柄时不许编一个（编出来的句柄会让 LLM 去引用一个不存在的东西）。
       用 token 形态表达「这是一个刚落的实体，本轮句柄表里还没有」—— prompt 只打印 handle，会显示 "-"。 */
    return { handle: null, type: type || null, uid: isInt(uid) ? uid : null, token: isInt(uid) ? `uid:${uid}` : null };
}

const owns = (code) => Object.prototype.hasOwnProperty.call(DIAG_CODES, code);

/** 诊断对象。**坐标绝不进这里**：只有句柄、角色名、计数、码。 */
function mkDiag(code, p = {}) {
    if (!owns(code)) throw new Error(`loop.mjs: 诊断码 "${code}" 不在 DIAG_CODES 闭集里（不许自造码）`);
    return {
        code,
        layer: p.layer || "meta",
        severity: p.severity || "blocker",
        subject: p.subject || { handle: null, type: null },
        ...(p.slot ? { slot: p.slot } : {}),
        expected: p.expected === undefined ? null : p.expected,
        observed: p.observed === undefined ? null : p.observed,
        evidence: {
            handles: Array.isArray(p.handles) ? p.handles.filter(Boolean) : [],
            uids: Array.isArray(p.uids) ? p.uids.filter(isInt) : [],
            ...(p.evidence || {}),
        },
        ...(Array.isArray(p.candidates) ? { candidates: p.candidates } : {}),
        ...(p.hint ? { hint: p.hint } : {}),
    };
}

/**
 * 失败指纹（v1 §1.6 的口径，**不含 message**）：`code + subject + evidence` 的 sha256。
 *
 * 为什么不含 message：message 里含坐标与数字格式，会随世界变化抖动，同一个错误会被当成
 * 新错误，于是「同一错误不重试第三次」的防线永远不触发（契约 §1.6 已经写明这一点）。
 * evidence 只取 `handles` / `uids` 两类稳定量（不含 cells —— 那是坐标）。
 */
export function fingerprintOf(diagnoses) {
    const rows = (Array.isArray(diagnoses) ? diagnoses : []).map(d => [
        d.code,
        d.layer || "",
        (d.subject && (d.subject.handle || d.subject.token)) || "-",
        ((d.evidence && d.evidence.handles) || []).slice().sort().join(","),
        ((d.evidence && d.evidence.uids) || []).slice().sort().join(","),
    ].join("|")).sort();
    return sha256(rows.join("\n"));
}

/** 动作集指纹：同一 fp 下「换了动作没有」的机器判据（v1 §1.6 的 actionSetHash）。 */
export function actionSetHash(macros) {
    const list = (Array.isArray(macros) ? macros : []).map(String).sort();
    return sha256(list.join(","));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. transcript
 * ══════════════════════════════════════════════════════════════════════════ */

/** transcript 的 kind 闭集（契约 §1.4）。新增 kind 必须同时改这里与测试。 */
export const RUN_KINDS = Object.freeze([
    "run_start", "observe", "diagnose", "propose", "plan", "apply", "verify",
    "repair_decide", "run_end",
]);

class Transcript {
    constructor(dir, runId) {
        this.dir = dir;
        this.runId = runId;
        this.file = path.join(dir, "transcript.jsonl");
        this.seq = 0;
        fs.mkdirSync(dir, { recursive: true });
    }

    /**
     * 追加一行。**任何写失败都不许让 loop 静默继续**（transcript 是验收的唯一证据），
     * 但也不许把一次成功的 run 变成 error —— 所以只抛给调用方一次，由它决定。
     */
    write(kind, round, data) {
        if (!RUN_KINDS.includes(kind)) throw new Error(`loop.mjs: 未知 transcript kind "${kind}"`);
        const row = {
            seq: ++this.seq,
            ts: nowIso(),
            run_id: this.runId,
            round: isInt(round) ? round : 0,
            kind,
            data: data === undefined ? {} : data,
        };
        fs.appendFileSync(this.file, JSON.stringify(row) + "\n", "utf8");
        return row;
    }

    put(name, obj) {
        try {
            fs.writeFileSync(path.join(this.dir, name), JSON.stringify(obj, null, 1), "utf8");
            return name;
        } catch { return null; }
    }
}

/** 读回一份 transcript（测试/回放用）。坏行直接抛 —— 半截 JSON 不许被静默跳过。 */
export function readTranscript(file) {
    const raw = fs.readFileSync(file, "utf8");
    return raw.split("\n").filter(s => s.trim()).map((line, i) => {
        try { return JSON.parse(line); } catch (e) {
            throw new Error(`transcript 第 ${i + 1} 行不是合法 JSON：${e.message}`);
        }
    });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. observe
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * `debug_items` 必须带 `region`（长度 4 的数字数组），否则真 mod 直接抛 2001：
 *
 *   src/mod/shapez-ai-bridge.js:903-908
 *     debugItems(params) {
 *         const region = params.region;
 *         if (!Array.isArray(region) || region.length !== 4) throw rpcError(2001, …);
 *
 * `FakeGame.debugItems` 接受 `{}`（假世界没有 region 概念，这不是 bug），
 * 所以缺参数在离线**永远**不会被发现 —— 曾经就是这样：真桥上 `items` 恒 null，
 * 于是 `checkFlow` 的 `paths=null` → `L3-flow` 永久 undecidable → strict 判红 →
 * `outcome` 永不为 success。
 *
 * ## region 从哪来（为什么不直接抄 verify_runtime）
 *
 * `verify_runtime.mjs:904-906` 的口径是「**计划 placements 的 origin bbox 外扩 6 格**」——
 * 那个调用点手里有 plan。本函数在 observe 阶段**还没有 plan**，所以拿不到同一个输入。
 * 能拿到的、且语义等价的唯一量是 `obs.entities`：
 *
 *   · loop 的 obs 请求**不带 region**（`observeOnce` 的全量读法），所以 obs 的实体 bbox
 *     就是整个世界的外接矩形 —— 它是任何未来计划 bbox 的超集；
 *   · `debug_items` 的 region 只用于过滤 `belts`/`ejectors`/`pending` 这类**逐格列表**
 *     （`paths`/`pathCount` 是全局的、不按 region 过滤，见 mod 的 `paths.slice(0,40)`），
 *     所以「宁可大一点」不会造成任何假绿/假红，只会多返回几行不会读的明细；
 *   · pad 沿用 verify_runtime 的 6（同一个常量口径，不发明第二套）。
 *
 * 兜底顺序：实体 bbox → `obs.region` → `[0,0,0,0]`。空世界时给一个合法的最小矩形，
 * **不是**「假装没问题」—— `ITEMS_UNAVAILABLE` 仍会照常因 paths 为空而报出来。
 *
 * @param {object|null} obs  unwrapObs 之后的 obs
 * @returns {[number,number,number,number]}
 */
const DEBUG_ITEMS_PAD = 6;      // 与 verify_runtime.mjs:905 的 pad 同口径
export function debugItemsRegion(obs) {
    const ents = (obs && Array.isArray(obs.entities)) ? obs.entities : [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
    for (const e of ents) {
        /* 用循环而不是 `Math.min(...xs)`：世界可以有 50000 个实体（obs 的 max_entities 上限），
           而 `Math.min(...arr)` 的超参数上限约 6.5 万 —— 贴着边界跑，改一版 mod 就会 stack overflow。 */
        if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
        if (e.x < x0) x0 = e.x;
        if (e.y < y0) y0 = e.y;
        if (e.x > x1) x1 = e.x;
        if (e.y > y1) y1 = e.y;
        n++;
    }
    if (n) {
        return [x0 - DEBUG_ITEMS_PAD, y0 - DEBUG_ITEMS_PAD, x1 + DEBUG_ITEMS_PAD, y1 + DEBUG_ITEMS_PAD]
            .map(Math.round);
    }
    const r = obs && obs.region;
    if (Array.isArray(r) && r.length === 4 && r.every(v => typeof v === "number" && Number.isFinite(v))) {
        return r.map(Math.round);
    }
    return [0, 0, 0, 0];
}

/**
 * 读一次世界。四个读取面分别容错：一个坏了不代表另外三个也不能用，
 * 但**坏了这件事必须成为诊断**（不许把「没读到」当成「没问题」）。
 *
 * `obs` 的取数口径与 `verify_runtime.mjs` 的 `BRIDGE_READER` 逐字一致
 * （`max_entities:50000, layer:"all", include_stats:true`）—— 两处口径不同 =
 * 两份世界，V2 §5.5 第 5 条。
 */
async function observeOnce(reader) {
    const out = { obs: null, items: null, production: null, problems: [] };
    let obsErr = null;
    try {
        out.obs = unwrapObs(await reader.obs({ max_entities: 50000, layer: "all", include_stats: true, include_resources: true, max_resources: 20000 }));
    } catch (e) {
        obsErr = e;
        out.problems.push(mkDiag("INTERNAL", {
            layer: "L0", expected: "obs 可读", observed: `obs 抛异常：${e && e.message ? e.message : e}`,
            evidence: { stage: "observe", method: "obs" },
        }));
    }
    if (out.obs) {
        if (out.obs.truncated === true) {
            out.problems.push(mkDiag("OBS_TRUNCATED", {
                layer: "L0",
                expected: "完整世界（truncated=false）",
                observed: `entity_count=${out.obs.entity_count} truncated=true`,
                evidence: { entity_count: out.obs.entity_count },
                hint: "截断时任何落地/槽位/货流判据都不可信；loop 直接 halt，不拿这份数据判红或判绿。",
            }));
        }
    }
    try {
        /* ★ 必须带 region ★ —— 真 mod 的 `debugItems` 第一句就校验它
           （`shapez-ai-bridge.js:903-908`），缺了就抛 2001。
           region 的取法见 `debugItemsRegion()` 的注释（obs 实体 bbox 外扩 6 格）。 */
        out.items = unwrapItems(await reader.debugItems({ region: debugItemsRegion(out.obs) }));
    } catch (e) {
        out.problems.push(mkDiag("ITEMS_UNAVAILABLE", {
            layer: "L0", expected: "debug_items 可读", observed: `抛异常：${e && e.message ? e.message : e}`,
            evidence: { stage: "observe", method: "debug_items" },
        }));
    }
    const it = out.items;
    if (it && Array.isArray(it.paths) && isInt(it.pathCount) && it.pathCount > it.paths.length) {
        /* 与 mod 的语义对齐（`paths.slice(0,40)` + 全局 pathCount）。**不能靠缩 region 修**：
           mod 的 paths 不按 region 过滤（红队 #12），所以这条是「L3 永远不可判定」的信标。 */
        out.problems.push(mkDiag("PATHS_TRUNCATED", {
            layer: "L3",
            expected: `paths 完整（pathCount=${it.pathCount}）`,
            observed: `只给了 ${it.paths.length}/${it.pathCount} 条路径`,
            evidence: { paths: it.paths.length, path_count: it.pathCount },
            hint: "L3 因此 undecidable → strict 红。这是诚实的红：不许把「没看见」读成「连通了」。",
        }));
    }
    if (it === null) {
        out.problems.push(mkDiag("ITEMS_UNAVAILABLE", {
            layer: "L0", expected: "debug_items 返回 {paths[]}", observed: "null / 无 paths[]",
            evidence: { stage: "observe", method: "debug_items" },
        }));
    }
    try {
        out.production = await reader.production({ slices: 6 });
    } catch (e) {
        out.problems.push(mkDiag("PRODUCTION_UNAVAILABLE", {
            layer: "L4", expected: "production 可读", observed: `抛异常：${e && e.message ? e.message : e}`,
            evidence: { stage: "observe", method: "production" },
        }));
    }
    if (out.production && typeof out.production !== "object") out.production = null;
    if (!out.production) {
        out.problems.push(mkDiag("PRODUCTION_UNAVAILABLE", {
            layer: "L4", expected: "production 有 window_seconds", observed: "缺失",
            evidence: { stage: "observe", method: "production" },
        }));
    }
    out.obsError = obsErr;
    return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. diagnose
 * ══════════════════════════════════════════════════════════════════════════ */

/* 几何索引 / hub 可达 / 上下游判据都搬到 `loop/topology.mjs`（P-a0）。
 * 这里保留同名 re-export，是为了让既有 import 方（verify/测试/第三方脚本）不改也能跑。
 * **语义不变**：`indexOf` 的 footprint 展开、`hubReachable` 的反向爬行与旧实现逐字一致
 * （`topology.test.mjs` 里有与旧实现的逐 uid 对拍）。 */
export {
    indexOf as buildIndex, hubReachable, upstreamAt, inputFed, outputRouted,
    indexOf,
} from "./loop/topology.mjs";

/** prompt 里 top-N 的候选宏：按诊断码查静态表，取每条码的 top-3，去重后最多 6 张卡。 */
function candidatesFor(diagnoses) {
    const seen = [];
    for (const d of diagnoses) {
        const list = RETRIEVAL_TABLE[d.code] || [];
        for (const c of list.slice(0, 3)) {
            if (!seen.includes(c.macro)) seen.push(c.macro);
            if (seen.length >= 6) return seen;
        }
    }
    return seen;
}

/** 从 report 的某个 check 里取 evidence（不存在返回 null）。 */
function checkOf(report, name) {
    if (!report || !Array.isArray(report.checks)) return null;
    return report.checks.find(c => c && c.name === name) || null;
}

/** severity 的排序权重（blocker 先出）。与 `semantic.mjs` 的 SEVERITY_RANK 同口径。 */
const SEVERITY_OF = Object.freeze({ blocker: 0, warn: 1, info: 2 });

/**
 * hub 的**入口带子** uid 集合（含隧道：隧道的 receiver 也可能正对入口）。
 *
 * 为什么要这一份：`CHAIN_UNFED` 等世界层诊断在拓扑上完全正确地指出「这条入口没有上游」，
 * 但 hub 的 16 个入口里 13 个空着是**正常状态**。把它交给模型 = 让它去给入口接料，
 * 与「病在上游产线」正好相反（v2 §4 的实测教训：入口带子被顶到 BELTS 段第 1–3 位）。
 *
 * 判据只看几何：入口槽的 approach 格上是什么实体。**不判来向**（来向不对属于
 * `BELT_HANDOFF_REJECTED`，那也可能是真坏 —— 但它的 subject 是**送方**，不是入口本身）。
 *
 * @returns {Set<number>} uid 集合（没有 hub 时为空集）
 */
function hubInletUids(obs, idx) {
    const out = new Set();
    if (!idx || !Array.isArray(idx.ent)) return out;
    const hub = idx.ent.find(e => e && e.type === "hub");
    if (!hub) return out;
    let slots = null;
    try { slots = slotsOf(hub.type, hub.variant, hub.x, hub.y, hub.r || 0, beltRvOf(hub)); }
    catch { return out; }
    if (!slots || !Array.isArray(slots.inputs)) return out;
    for (const sl of slots.inputs) {
        const e = (idx.byCell && idx.byCell.get(K(sl.cell))) || null;
        if (!e) continue;
        if (e.type === "belt" || e.type === "underground_belt") out.add(e.uid);
    }
    return out;
}

const GOAL_TARGET = 0;

/**
 * 诊断。**纯函数**：只读 obs / items / production / report / goal / handles，不写世界、不读时钟。
 *
 * @param {object} obs          ObsSnapshot（`reader.obs` 的 result）
 * @param {object|null} items   `debug_items` 的 result
 * @param {object|null} production `production` 的 result
 * @param {object|null} report  `verifyRound` 的返回；首轮为 null
 * @param {string|object|null} goal 形状串或 `{shape, required, delivered, progress}`
 * @param {object|null} handles `buildHandles(obs, items)` 的表
 * @param {object} [ctx]        可选上下文（P-b 接线）
 * @param {object} [ctx.recipe] 由 loop **预计算并注入**的配方（`recipeForCached` 的返回）。
 *   缺席 ⇒ 语义层整体降级为空，`diagnose` 绝不 spawn（纯函数性：同 obs 两次调用必须逐字节相同）。
 * @returns {Array<object>} Diagnosis[]（每条 code ∈ DIAG_CODES，**只带句柄不带坐标**）
 */
export function diagnose(obs, items, production, report, goal, handles, ctx = {}) {
    const cx = (ctx && typeof ctx === "object") ? ctx : {};
    const o = unwrapObs(obs);
    const it = unwrapItems(items);
    const out = [];
    const idx = buildIndex(o);
    const tbl = handles || buildHandles(o, it);
    const goalShape = typeof goal === "string" ? goal : (goal && (goal.shape || goal.goal)) || null;
    const req = (o.goal && o.goal.requirement) || {};
    const required = isInt(req.required) ? req.required : null;
    const delivered = isInt(req.delivered) ? req.delivered : null;

    /* ── ①② 结构层：**整段交给 `loop/structural.mjs`**（P-a0） ──
     *
     * 这一段原来是「可达 且 输入槽全空 / 输出槽全空」与「可达 且 出口为空」。
     * 实测（`research/ai-plan/tmp/DIAGNOSE-BASELINE.md` §3b）：
     *   · 旧 `DEAD_END` 的两个条件**互斥** —— 可达正是从 hub 反向走出来的，
     *     出口为空的带子不可能进入可达集 ⇒ 它**永远不可能触发**（删 40 条带子，触发 0 次）；
     *   · 删掉全部矿机 / 全部 trash 时，旧实现只报 `NO_PRODUCTION`。
     *
     * P-a0 的纪律是「**结构判据不依赖可达性**，可达性只用于排序（tier）」。
     * 结构层只判拓扑；形状/配方留给 P-a。
     * ⚠️ 旧代码在这里调 `hubReachable(o, idx)` 做过滤器；**现在不调了** ——
     *    tier 由 `structuralDiagnoses` 内部算，重复算一遍只会让两处口径有机会漂移。 */

    /* ── ④b hub 入口带子过滤器（v2 §4 的落地） ──
     *
     * 实测（`DIAGNOSE-V2-REDTEAM-VERDICT.md` §4）：`CHAIN_UNFED` 会以 `B136`（hub 的 primary 入口）
     * 为 subject 报出来。它**拓扑上是对的**（那条入口确实没有上游），但把模型引去给 hub 入口接料，
     * 与「病在上游的产线」正好相反 —— 那 16 个入口里 13 个空着是正常状态。
     *
     * ⚠️ 只过滤**世界层**（结构层 / 语义层）的产出。报告层（`③`）的 `LANDING_*` / `DELETE_NOT_REPLAYED`
     *    走 `mkDiag` 产出，描述的是「上一轮你把它删了/没放上」—— 它们**必须**保留，否则
     *    「删了入口却没报错」会让 loop 静默吞掉一次真实的落地失败。
     *    按 `layer` 判分不出来（结构层的 layer 也是 "L2"），所以过滤点必须在**合并前**。
     *
     * 不静默丢弃：条数记进首条诊断的 `evidence.suppressed_hub_inlets`。
     *
     * 另外把 hub 入口句柄从**所有**世界层诊断的 `evidence.handles` 里摘掉。
     * 只过滤 subject 不够：`semantic.mjs` 的某条诊断会把入口带子放进 `handles`
     * （它是这条流的近邻，语义上没错），而 `prompt.pickBelts` 正是按 `evidence.handles`
     * 决定哪些带子进 BELTS 段 —— 留在里面就等于把入口顶上去，与 v2 §4 的目标相反。
     * 摘掉的句柄记进 `evidence.hub_inlets`（独立字段，不参与 pickBelts），不丢信息。 */
    const inletUids = hubInletUids(o, idx);
    const dropInlets = (list) => {
        const kept = [];
        let n = 0;
        for (const d of list) {
            const uid = d && d.subject && d.subject.uid;
            if (isInt(uid) && inletUids.has(uid)) { n++; continue; }
            /* 顺手把 evidence.handles 里的入口句柄挪到 hub_inlets。
               `byHandle` 的值是 HandleEntry（有 `.uid`），不是 uid 本身 —— 两种形态都认。 */
            if (d && d.evidence && Array.isArray(d.evidence.handles)) {
                const tblIn = tbl && tbl.byHandle ? tbl.byHandle : null;
                const moved = [];
                const rest = d.evidence.handles.filter(h => {
                    const e = tblIn ? tblIn.get(h) : null;
                    const uidH = typeof e === "number" ? e : (e && isInt(e.uid) ? e.uid : null);
                    if (uidH !== null && inletUids.has(uidH)) { moved.push(h); return false; }
                    return true;
                });
                if (moved.length) {
                    d.evidence.handles = rest;
                    d.evidence.hub_inlets = [...(d.evidence.hub_inlets || []), ...moved];
                }
            }
            kept.push(d);
        }
        return { kept, n };
    };
    const structRes = dropInlets(structuralDiagnoses(o, it, goalShape, tbl, { recipe: cx.recipe || null }));
    out.push(...structRes.kept);

    /* ── ①②b 语义层（P-a）：形状传播 + 配方闭包 + 作业分配 ──
     *
     * **只在 `ctx.recipe` 存在且 ok 时产出**（`semanticDiagnoses` 自己判，缺配方返回 `[]`）。
     * 配方由 loop **预计算一次**后注入 —— 这里绝不 spawn。理由不是洁癖：
     * `diagnose` 每轮跑、输出进 `fingerprintOf`，一旦引入 spawn，「同 obs 两次结果不同」
     * 就会让指纹抖动，`NO_PROGRESS_3X` 静默失效（契约 §6 决定三）。
     *
     * 语义层的两条 `PROCESSOR_REQUIRED` 共用同一个码、severity 不同（scope:stream=warn /
     * scope:factory=blocker）—— 那是 v2 §2 的裁决，不是这里的分歧。
     *
     * `level` 口径与 `ctx.recipe` 一致：都取 **obs.goal.level**（solver 的解是同一个关卡的解）。
     * 两侧取自同一字段，所以「配方按 L 门控 / 语义按 L 判可修」不会分裂。 */
    let semanticDropped = 0;
    if (cx.recipe) {
        const semRes = dropInlets(semanticDiagnoses(o, it, goalShape, tbl, {
            recipe: cx.recipe,
            level: (o.goal && Number.isFinite(o.goal.level)) ? o.goal.level : undefined,
        }));
        out.push(...semRes.kept);
        semanticDropped = semRes.n;
    }
    const inletDropped = structRes.n + semanticDropped;

    /* ── ③ report 层：把 verifyRound 的 checks 映射成诊断（每条 check 只映射一次） ── */
    if (report && Array.isArray(report.checks)) {
        const l0 = checkOf(report, "L0-observation");
        if (l0 && l0.ok !== true && l0.undecidable === true) {
            out.push(mkDiag("OBS_TRUNCATED", {
                layer: "L0", expected: "完整世界", observed: l0.reason || "L0 不可判定",
                evidence: { check: "L0-observation" },
            }));
        }

        const l1 = checkOf(report, "L1-landing");
        if (l1 && l1.ok !== true && l1.undecidable !== true) {
            const ev = l1.evidence || {};
            const first = (ev.missing && ev.missing[0]) || null;
            const why = l1.reason || "L1 未通过";
            if (ev.removed_still_there && ev.removed_still_there.length) {
                const uids = ev.removed_still_there.map(x => x.uid).filter(isInt);
                out.push(mkDiag("DELETE_NOT_REPLAYED", {
                    layer: "L1", expected: "声明的删除真的发生",
                    observed: `${uids.length} 个 uid 仍在世界里`,
                    subject: subjectOf(tbl, uids[0], null), handles: uids.map(u => subjectOf(tbl, u, null).handle),
                    uids, evidence: { check: "L1-landing" },
                }));
            } else {
                const bad = (ev.wrong_type && ev.wrong_type[0]) || (ev.wrong_rot && ev.wrong_rot[0])
                    || (ev.wrong_rv && ev.wrong_rv[0]) || (ev.wrong_code && ev.wrong_code[0])
                    || (ev.wrong_dir && ev.wrong_dir[0]) || (ev.wrong_uid && ev.wrong_uid[0]) || null;
                const code = first ? "LANDING_MISSING" : "LANDING_MISMATCH";
                const uid = (first && isInt(first.uid)) ? first.uid : (bad && isInt(bad.uid) ? bad.uid : null);
                out.push(mkDiag(code, {
                    layer: "L1", expected: "计划声明的实体在世界里一致",
                    observed: why,
                    subject: subjectOf(tbl, uid, first ? first.kind : null),
                    handles: [subjectOf(tbl, uid, null).handle], uids: isInt(uid) ? [uid] : [],
                    evidence: { check: "L1-landing" },
                    candidates: ["replace_run", "insert_machine", "connect"],
                }));
            }
        }

        const l2 = checkOf(report, "L2-slots");
        if (l2 && l2.ok !== true && l2.undecidable !== true && l2.skipped !== true) {
            const ev = l2.evidence || {};
            for (const u of (ev.unfed_inputs || []).slice(0, 3)) {
                const uid = u.cell ? (idx.byCell.get(K([u.cell[0], u.cell[1]])) || {}).uid : null;
                out.push(mkDiag("SLOT_STARVED", {
                    layer: "L2", expected: `${u.kind} 的输入槽有上游`,
                    observed: `输入槽 ${(u.slots || []).map(s => s.role).join("/")} 无上游`,
                    subject: subjectOf(tbl, uid, u.kind), uids: isInt(uid) ? [uid] : [],
                    evidence: { check: "L2-slots" },
                    candidates: ["connect", "insert_machine", "trash_unused"],
                }));
            }
            for (const u of (ev.unrouted_outputs || []).slice(0, 3)) {
                const uid = u.cell ? (idx.byCell.get(K([u.cell[0], u.cell[1]])) || {}).uid : null;
                out.push(mkDiag("OUTPUT_UNROUTED", {
                    layer: "L2", expected: `${u.kind} 的输出槽有去处`,
                    observed: `输出槽 ${(u.slots || []).map(s => s.role).join("/")} 无去处`,
                    subject: subjectOf(tbl, uid, u.kind), uids: isInt(uid) ? [uid] : [],
                    evidence: { check: "L2-slots" },
                    candidates: ["trash_unused", "connect", "extend_line"],
                }));
            }
        }

        const l3 = checkOf(report, "L3-flow");
        if (l3) {
            const hasPlacements = !!(report.evidence && report.evidence.has_placements);
            const unresolved = (report.evidence && report.evidence.flows_unresolved) || 0;
            if (l3.degraded === true || (unresolved > 0 && hasPlacements)) {
                out.push(mkDiag("FLOW_UNVERIFIED", {
                    layer: "L3", severity: "blocker",
                    expected: "显式 flows 且逐条走通",
                    observed: l3.degraded === true ? `L3 降级：${l3.reason || "degraded"}` : `${unresolved} 条 flow 的端点解析不到`,
                    evidence: { check: "L3-flow" },
                }));
            } else if (l3.ok !== true && l3.undecidable !== true && l3.skipped !== true) {
                const unreached = ((l3.evidence && l3.evidence.unreached) || []);
                const f0 = unreached[0] || {};
                const fromUid = isInt(f0.from) ? f0.from
                    : (f0.flow && isInt(f0.flow.from) ? f0.flow.from : null);
                const toUid = isInt(f0.to) ? f0.to
                    : (f0.flow && isInt(f0.flow.to) ? f0.flow.to : null);
                const sh = subjectOf(tbl, fromUid, null).handle;
                const th = subjectOf(tbl, toUid, null).handle;
                out.push(mkDiag("FLOW_UNREACHABLE", {
                    layer: "L3", severity: "blocker",
                    subject: subjectOf(tbl, fromUid, null),
                    expected: "声明的货流沿游戏自己的 path 走得到",
                    observed: `${unreached.length} 条走不到（首条 ${f0.why || "path 不通"}）`,
                    handles: [sh, th].filter(Boolean),
                    uids: [fromUid, toUid].filter(isInt),
                    evidence: { check: "L3-flow" },
                    candidates: ["connect", "remove_run", "insert_machine"],
                }));
            } else if (l3.skipped === true) {
                out.push(mkDiag("FLOW_UNVERIFIED", {
                    layer: "L3", expected: "L3 必须跑过", observed: "L3 skipped（没有可验的连通）",
                    evidence: { check: "L3-flow" },
                }));
            }
        }

        const l4 = checkOf(report, "L4-behavior");
        if (l4 && l4.ok !== true && l4.skipped !== true && l4.evidence) {
            const ev = l4.evidence;
            const produced = typeof ev.produced_window_after === "number" ? ev.produced_window_after : 0;
            const delWin = typeof ev.delivered_in_window_after === "number" ? ev.delivered_in_window_after : 0;
            const delta = typeof ev.goal_delivered_delta === "number" ? ev.goal_delivered_delta : null;
            const hub = idx.ent.find(e => e.type === "hub");
            const subject = subjectOf(tbl, hub && hub.uid, "hub");
            if (produced > 0 && delWin === 0 && (delta === null || delta <= 0)) {
                out.push(mkDiag("PRODUCED_NOT_DELIVERED", {
                    layer: "L4", subject,
                    expected: `产出的 ${goalShape} 送达 hub`,
                    observed: `窗口内产出 ${produced} 件，交付 0 件`,
                    handles: [subject.handle], uids: hub ? [hub.uid] : [],
                    evidence: { check: "L4-behavior" },
                    candidates: ["connect", "trash_unused"],
                }));
            } else if (produced <= 0 && (delta === null || delta <= 0)) {
                out.push(mkDiag("NO_PRODUCTION", {
                    layer: "L4", subject,
                    expected: `${goalShape} 有产出`,
                    observed: l4.reason || "窗口内目标形状零产出",
                    handles: [subject.handle], uids: hub ? [hub.uid] : [],
                    evidence: { check: "L4-behavior" },
                    candidates: ["connect", "insert_machine", "trash_unused"],
                }));
            }
        }

        /* apply 的裁决也进诊断（verifyRound 把 A-tx 放进 checks） */
        const atx = checkOf(report, "A-tx");
        if (atx && atx.ok !== true) {
            out.push(mkDiag(atx.hardStop ? "TX_ROLLED_BACK" : "TX_ROLLED_BACK", {
                layer: "tx", expected: "tx 干净落盘",
                observed: atx.reason || "tx 未成功",
                evidence: { check: "A-tx", hard_stop: !!atx.hardStop },
            }));
        }
    }

    /* ── ④ goal 层：首轮没有 report 时，用 production + goal 计数说「没有产线在造目标形状」 ── */
    const l4check = checkOf(report, "L4-behavior");
    const reportSaysNothingProduced = !!(l4check && l4check.ok !== true && l4check.skipped !== true);
    if (!reportSaysNothingProduced) {
        const p = production && typeof production === "object" ? production : null;
        const producedTotal = p && p.produced_total && typeof p.produced_total === "object" ? p.produced_total : null;
        const madeGoal = producedTotal && goalShape ? (producedTotal[goalShape] || 0) : 0;
        const goalUnmet = required === null || delivered === null || delivered < required;
        if (goalShape && goalUnmet && madeGoal <= 0) {
            const hub = idx.ent.find(e => e.type === "hub");
            const subject = subjectOf(tbl, hub && hub.uid, "hub");
            out.push(mkDiag("NO_PRODUCTION", {
                layer: "L4",
                subject,
                expected: `有产线在造 ${goalShape}`,
                observed: p ? `窗口内 ${goalShape} 产出 0（delivered ${delivered === null ? "?" : delivered}/${required === null ? "?" : required}）`
                    : "production 不可用，无法确认任何产线在造目标形状",
                handles: [subject.handle], uids: hub ? [hub.uid] : [],
                evidence: { stage: "initial", goal: goalShape },
                candidates: ["connect", "insert_machine", "trash_unused"],
                hint: "首轮没有 report：这是「目标形状没有产线在造」的初始诊断，不是对某条 check 的复述。",
            }));
        }
    }

    /* ── ⑤ 排序：语义层（最可行动）→ goal 级 → 结构层（按具体度）→ 报告层 ──
       确定性排序是必须的：指纹与 prompt 都依赖诊断顺序稳定。
       结构层内部已经按 `evidence.tier` 排过一次（见 `structural.mjs`）；这里的 RANK 只决定
       **跨层**的顺序，所以同码下用稳定 tie-break 保住那一次排序的结果（见下方对 tier 的比较）。 */
    const RANK = {
        OBS_TRUNCATED: 0, PATHS_TRUNCATED: 0,
        /* 语义层排在最前：它们直接说「缺哪一步工序 / 哪条流送错形状」，
           比「窗口内零产出」更接近可执行动作。v2 §4：WRONG_SHAPE_AT_HUB 必须可见。 */
        WRONG_SHAPE_AT_HUB: 1, DISCARDED_INTERMEDIATE: 2, PROCESSOR_REQUIRED: 3,
        NO_PRODUCTION: 4, PRODUCED_NOT_DELIVERED: 5, FLOW_UNREACHABLE: 6, FLOW_UNVERIFIED: 7,
        SLOT_STARVED: 8, OUTPUT_UNROUTED: 8,
        DEAD_END: 9, BELT_HANDOFF_REJECTED: 9,
        CHAIN_UNFED: 10, WASTE_NO_SINK: 10, RAW_MATERIAL_MISSING: 10,
        LANDING_MISSING: 11, LANDING_MISMATCH: 11, DELETE_NOT_REPLAYED: 11,
        TX_ROLLED_BACK: 12, NO_WORLD_CHANGE: 12,
        /* info 级：排在所有可行动诊断之后，让总量上限先压掉它（v2 §6：info 不占显眼位置） */
        SHAPE_UNKNOWN: 40,
    };
    /* ── ④b 之后：hub 入口过滤已发生在世界层合并之前（见上方 `dropInlets`）。
       这里只把被压掉的条数挂到首条世界层诊断上 —— 不静默丢弃。 */
    if (inletDropped) {
        const first = out.find(d => d.layer !== "meta") || out[0];
        if (first) first.evidence.suppressed_hub_inlets = inletDropped;
    }

    out.sort((a, b) => {
        const ra = RANK[a.code] === undefined ? 50 : RANK[a.code];
        const rb = RANK[b.code] === undefined ? 50 : RANK[b.code];
        if (ra !== rb) return ra - rb;
        if (a.code !== b.code) return a.code < b.code ? -1 : 1;
        /* 严重度优先于 tier：同一码下 blocker 先于 warn/info（PROCESSOR_REQUIRED 的两种 scope） */
        const sa = SEVERITY_OF[a.severity] === undefined ? 9 : SEVERITY_OF[a.severity];
        const sb = SEVERITY_OF[b.severity] === undefined ? 9 : SEVERITY_OF[b.severity];
        if (sa !== sb) return sa - sb;
        /* 结构层自己的 tier（0 走廊内 / 1 hub 可达 / 2 其它）—— 只对结构码存在 */
        const ta = a.evidence && Number.isInteger(a.evidence.tier) ? a.evidence.tier : 9;
        const tb = b.evidence && Number.isInteger(b.evidence.tier) ? b.evidence.tier : 9;
        if (ta !== tb) return ta - tb;
        const ha = (a.subject && a.subject.handle) || "";
        const hb = (b.subject && b.subject.handle) || "";
        return ha < hb ? -1 : ha > hb ? 1 : 0;
    });

    /* 候选宏：静态表 top-3 的并集（RETRIEVAL_TABLE 是 v2 §7 的第一版 retrieve）。 */
    for (const d of out) {
        if (!Array.isArray(d.candidates)) {
            const c = (RETRIEVAL_TABLE[d.code] || []).slice(0, 3).map(x => x.macro);
            if (c.length) d.candidates = c;
        }
    }

    /* ── ⑥ 合并后的统一上限（v2 §6：每码 ≤3、总量 ≤8） ──
     *
     * 结构层与语义层各自在上限内，但**合并后**会超（L5：结构层自己就占满 8 条，
     * 再并入语义层必然破 8）。上限必须在合并之后统一施加，否则「每码 ≤3」变成
     * 「每层每码 ≤3」—— 同一个码可以出现 6 条。
     *
     * 超限**不静默丢弃**，而且两种超限分开记（混记会让 prompt 说错话）：
     *   · 每码被压掉的 → 该码第一条的 `evidence.suppressed`（「这个码还有 N 条没显示」）；
     *   · 总量被压掉的 → 首条诊断的 `evidence.suppressed_total`（「还有 N 条别的诊断没显示」）。
     *     两者混成一句会让模型以为「还有 2 条 PROCESSOR_REQUIRED」，而实际上它一条都不少。 */
    const LIMITS = { PER_CODE: 3, TOTAL: 8 };
    const kept = [];
    const perCode = new Map();
    const droppedByCode = new Map();
    let droppedTotal = 0;
    for (const d of out) {
        const n = perCode.get(d.code) || 0;
        if (n >= LIMITS.PER_CODE) {
            droppedByCode.set(d.code, (droppedByCode.get(d.code) || 0) + 1);
            continue;
        }
        if (kept.length >= LIMITS.TOTAL) {
            droppedTotal++;
            continue;
        }
        perCode.set(d.code, n + 1);
        kept.push(d);
    }
    for (const d of kept) {
        const n = droppedByCode.get(d.code);
        if (n) {
            d.evidence.suppressed = (d.evidence.suppressed || 0) + n;
            droppedByCode.delete(d.code);
        }
    }
    /* 某码被总量上限压到一条不剩：它的数量并入「总量被压掉」的计数 */
    for (const n of droppedByCode.values()) droppedTotal += n;
    if (droppedTotal && kept.length) {
        kept[0].evidence.suppressed_total = (kept[0].evidence.suppressed_total || 0) + droppedTotal;
    }
    out.length = 0;
    out.push(...kept);
    return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. plan 阶段：LLM 计划 → TxPlan（零写入）
 * ══════════════════════════════════════════════════════════════════════════ */

const reject = (code, p) => ({ ok: false, code, diagnosis: mkDiag(code, p), stage: p && p.stage });

/** 把 plan 阶段某一步的红转成一条 Diagnosis（码必须是闭集里的）。 */
function planRejectFromViolations(violations, stage) {
    const rules = new Set((violations || []).map(v => v && v.rule));
    if (rules.has("V5")) {
        return reject("OBS_STALE", {
            layer: "plan", stage,
            expected: "LLM 引用的句柄都在当轮句柄表里",
            observed: (violations.find(v => v && v.rule === "V5") || {}).reason || "句柄不存在",
            hint: "句柄表每轮重建；LLM 引用了上一轮或幻觉的句柄。",
            evidence: { stage, rules: [...rules] },
        });
    }
    if (rules.has("V7")) {
        return reject("LLM_LINT", {
            layer: "plan", stage,
            expected: "解析后的 args 通过 lintNoBareCoords",
            observed: (violations.find(v => v && v.rule === "V7") || {}).reason || "lint 拒绝",
            evidence: { stage, rules: [...rules] },
        });
    }
    /* ★ `PATH_NOT_RECT` 必须单独成码（第三轮实验的直接产物）★
     * 它既不是「LLM 夹带坐标」（那是模型做错事），也不是「宏拒绝」（宏根本没跑到）——
     * 是**出题人给的算子表达不了它的合法意图**：`$path_of` 指的格集拐弯了，region 无法表达。
     * 归进 LLM_COORD 会让下一轮提示「坐标只能来自算子」，而它**已经在用**算子；
     * 归进 MACRO_REFUSED 又会给出「换个宏」的候选，而它选的宏是对的。
     * 单独成码才能把 hint 写成「拆成更小的连续段」。 */
    if (rules.has("PATH_NOT_RECT")) {
        const v = violations.find(x => x && x.rule === "PATH_NOT_RECT") || {};
        return reject("PATH_NOT_RECT", {
            layer: "plan", stage,
            expected: "交给 region 的 $path_of 格集恰好填满自己的外接矩形（连续选区）",
            observed: v.reason || "选区不连续",
            evidence: { stage, rules: [...rules], path: v.path || null },
            /* 候选是**该宏自身**（与 LLM_ARGS 同口径：给它重试一次的机会） */
            candidates: ["replace_run"],
            hint: "把这段链拆成各自连续（不含空洞）的几段，分别调用；或只选真正要改的那几格。"
                + "不要为了『让它变成矩形』而把没指名的格子加进来。",
        });
    }
    return reject("LLM_COORD", {
        layer: "plan", stage,
        expected: "LLM 输出里没有字面坐标（V1–V6）",
        observed: (violations[0] && `${violations[0].rule}: ${violations[0].reason}`) || "坐标禁令命中",
        evidence: { stage, rules: [...rules], count: (violations || []).length },
        hint: "坐标只能来自 $ref / $uids / $bbox_of / $path_of；say/why 里也不许出现数字对。",
    });
}

/**
 * 把一条 place op 反查回「哪个宏的哪条声明」。
 *
 * 这个映射是 planToTxOps 不提供的那一层（见文件头适配层第 1 条）。
 * 只做**查找**，不做补全：找不到就返回 null，让 assertProvenance 判红。
 *
 * ## `connect` / `extend_line` 的 token 是**合成**的，但仍然是宏算出来的
 *
 * 这两个宏「铺一串带子」，没有 pending 语义（没有「新 uid 待分配」的东西）：
 * 宏返回的 `cells[]` 里既没有 `token` 也没有 `pending`。于是三级来源对它们全落空
 * —— 实机半成品世界跑的、唯一一条 connect 计划就是这样被判成 COORD_PROVENANCE 的。
 *
 * 但契约 `coords.mjs:26` 明确把 `cells[]` 列为 `macro:<token>` 的合法来源之一。
 * 所以这里按既有命名惯例（`<macro>:<kind>@<x>,<y>`，与 `replace_run:cutter@4,-13` 同形）
 * 从**宏返回值自己的格子**合成 token：`connect:belt@1,-5`。
 *
 * 为什么这不算「编造标签」：坐标取自宏返回值（`entry.x/entry.y`），不是取自 op。
 * 若 op 的坐标被改过，要么 `sourceOfPlace` 反查不到（untagged → 红），
 * 要么 reverse 出来的 token 里的 @x,y 与 op 对不上（`checkTag` 的坐标断言 → 红）。
 * 唯一需要 loop 额外做的事是把它登记进 `knownTokens` —— 见 attachProvenance 的返回值。
 *
 * `entry.building` 与 op 的 building 必须一致：不一致说明 txPlan 被改过（宏不可能
 * 在两处说不同的建筑），这时**不挂标签**，宁可红。
 */
function sourceOfPlace(calls, op) {
    for (let i = 0; i < calls.length; i++) {
        const c = calls[i];
        const r = c && c.result;
        if (!r || !isObj(r)) continue;
        const at = (cell) => Array.isArray(cell) && cell[0] === op.x && cell[1] === op.y;
        if (c.macro === "insert_machine") {
            if (at(r.origin)) return { call: c, index: i, entry: r, token: (r.pending && r.pending.token) || null };
        } else if (c.macro === "replace_run") {
            for (const p of r.placed || []) {
                if (p && at(p.origin)) return { call: c, index: i, entry: p, token: (p.pending && p.pending.token) || null };
            }
        } else if (c.macro === "trash_unused") {
            if (at(r.trashCell)) return { call: c, index: i, entry: r, token: (r.pending && r.pending.token) || null };
        } else if (c.macro === "connect" || c.macro === "extend_line") {
            for (const cell of r.cells || []) {
                if (!cell || cell.x !== op.x || cell.y !== op.y) continue;
                /* 与 planToTxOps 的 kind 推法同口径（`cell.building || "belt"`）；
                   不一致 ⇒ 这一格不是这条 op 的来源，**跳过**（继续找，不就地认领）。 */
                const kind = cell.building || "belt";
                if (kind !== op.building) continue;
                return { call: c, index: i, entry: cell, token: `${c.macro}:${kind}@${cell.x},${cell.y}`, synthesized: true };
            }
        }
    }
    return null;
}

/**
 * 给 txPlan 的每条 op 挂 provenance（coords.mjs#assertProvenance 要求的那一层）。
 *
 * 三级优先（**只挑一条**，不合并、不猜）：
 *   ① 宏返回里的 pending token → `macro:<token>`（最精确：坐标是宏算的）
 *      1b. `connect` / `extend_line` 没有 pending，但 `cells[]` 是契约允许的来源
 *           （coords.mjs:26）→ 用同样的 `<macro>:<kind>@<x>,<y>` 形从**宏返回的格子**合成
 *   ② 该调用的 args 里有 `$bbox_of`（解析后是 4 元 bbox）→ `computed:bbox_of[…]`
 *      （assertProvenance 对 place 用「落在 bbox 内」判，不是相等）
 *   ③ 该调用只引用了 `$ref`/`$uids`，且 op 的 (x,y) 正好等于被引实体的 origin → `obs:uid=N`
 * 都不成立 → 不挂标签（宁可红，也不编造一条可追溯性）。
 *
 * ## 返回值里的 `tokens` 不是可选的
 *
 * `checkTag` 对 `macro:` 标签会先判「token 在当轮宏返回值里」。三个有 pending 的宏由
 * `planToTxOps` 把 token 写进 `txPlan.pendingByOp`，`assertProvenance` 自动收；
 * **合成 token 没有这条通道**，所以必须由调用方显式作为 `opts.knownTokens` 传下去
 * （见 buildTxPlan ⑤）。不传的话断言会红在「token 不在当轮宏返回值里」——
 * 那是正确行为：光挂标签不进白名单，等于放行一条没人复核过的字符串。
 *
 * 为什么不直接塞进 `txPlan.pendingByOp`：那张表的语义是「**这一条 op 落盘后要回读真 uid**」
 * （verify.mjs#buildUidMap 按 op 下标查 `tx.results[i].uid`）。connect 的格子也会拿到 uid，
 * 但把它们混进去会改变 apply 之后的桥接结果，属于**另一件事**；provenance 这一层
 * 不该顺手改动执行侧的语义。
 *
 * @returns {{ops:Array, tagged:number, untagged:Array, tokens:string[]}}
 *          `tokens` = 本次合成出来的 macro token（不含 pendingByOp 里已有的那些）。
 */
export function attachProvenance(txPlan, resolvedCalls, obs) {
    const byUid = new Map(((obs && obs.entities) || []).filter(e => e && isInt(e.uid)).map(e => [e.uid, e]));
    const calls = Array.isArray(resolvedCalls) ? resolvedCalls : (resolvedCalls && resolvedCalls.calls) || [];
    const ops = [];
    let tagged = 0;
    const untagged = [];
    const tokens = new Set();

    for (const op of (txPlan && txPlan.ops) || []) {
        const copy = { ...op };
        if (op.op === "delete" && isInt(op.uid)) {
            if (byUid.has(op.uid)) { copy.provenance = { uid: `obs:uid=${op.uid}` }; tagged++; }
            else untagged.push({ op, why: "delete 的 uid 不在 obs 里" });
            ops.push(copy);
            continue;
        }
        if (op.op !== "place") { ops.push(copy); continue; }

        const src = sourceOfPlace(calls, op);
        let tag = null;
        if (src) {
            if (src.token) tag = `macro:${src.token}`;
            if (!tag) {
                const prov = src.call.provenance || {};
                for (const [p, t] of Object.entries(prov)) {
                    const v = resolvedValueAt(src.call.args, p);
                    if (typeof t === "string" && Array.isArray(v) && v.length === 4 && v.every(isInt)) { tag = t; break; }
                }
            }
            if (!tag) {
                const prov = src.call.provenance || {};
                for (const t of Object.values(prov)) {
                    const tags = Array.isArray(t) ? t : [t];
                    for (const one of tags) {
                        if (typeof one !== "string" || !one.startsWith("obs:uid=")) continue;
                        const uid = Number(one.slice("obs:uid=".length));
                        const e = byUid.get(uid);
                        if (e && e.x === op.x && e.y === op.y) { tag = one; break; }
                        if (e && e.type === op.building) {
                            /* $ref 指向的实体被宏换算成 origin（例如 insert_machine 的 at 指向
                               一段带子、机器落在相邻格）—— 这时 obs 标签**不成立**，不挂。 */
                        }
                    }
                    if (tag) break;
                }
            }
        }
        if (tag) { copy.provenance = { x: tag, y: tag }; tagged++; if (src.synthesized) tokens.add(src.token); }
        else untagged.push({ op, why: src ? "宏返回里没有可用的溯源 token/bbox/同格实体" : "找不到产出这条 place 的宏声明" });
        ops.push(copy);
    }
    return { ops, tagged, untagged, tokens: [...tokens] };
}

/** 从 args 里按 `a.b[0].c` 取值（与 coords.mjs#getPath 同语义，独立实现避免导出面扩大）。 */
function resolvedValueAt(obj, p) {
    let cur = obj;
    for (const seg of String(p).split(".")) {
        const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(seg);
        if (!m) return undefined;
        if (m[1]) { if (!isObj(cur)) return undefined; cur = cur[m[1]]; }
        for (const ix of m[2].match(/\[\d+\]/g) || []) {
            const i = Number(ix.slice(1, -1));
            if (!Array.isArray(cur)) return undefined;
            cur = cur[i];
        }
        if (cur === undefined) return undefined;
    }
    return cur;
}

/**
 * 复核 `macro:<token>` 标签里的坐标与 op 的坐标**一致**。
 *
 * 为什么需要这一层（coords.mjs 的已知边界，不是它的 bug）：
 *   `assertProvenance` 对 `macro:` 标签只校验「这个 token 在当轮宏返回的 token 集合里」
 *   （coords.mjs:412-418 的 `checkTag`），**不比 token 里嵌的坐标与 op 的 (x,y)**。
 *   于是契约 §2.4 的变异测试（「把任一个 cell 的 x 加 1，assertProvenance 必须红」）
 *   在 `macro:` 标签上**过不了** —— 标签没变、值变了，而 checkTag 只看标签。
 *   实测确认：把 cutter 的 place.x 从 4 改成 5，`assertProvenance` 仍返回 ok:true。
 *
 * 本文件不改 coords.mjs（它是另一份已被测试钉住的真值），而是在**自己的适配层**补上
 * 这一条：token 形如 `replace_run:cutter@4,-13`，`@` 后的就是宏算出来的 origin，
 * 它必须等于这条 place op 的 (x,y)。对不上 ⇒ COORD_PROVENANCE（与其它溯源失败同码）。
 *
 * @returns {{ok:boolean, violations:Array<{index:number, token:string, op:[number,number], token_cell:[number,number]}>}}
 */
export function verifyMacroTokenCoords(txPlan) {
    const TOKEN_CELL = /@(-?\d+),(-?\d+)\s*$/;
    const violations = [];
    (txPlan && Array.isArray(txPlan.ops) ? txPlan.ops : []).forEach((op, i) => {
        if (!op || op.op !== "place") return;
        const prov = op.provenance;
        if (!isObj(prov)) return;
        for (const f of ["x", "y"]) {
            const tag = prov[f];
            if (typeof tag !== "string" || !tag.startsWith("macro:")) continue;
            const m = TOKEN_CELL.exec(tag);
            if (!m) continue;                       // 无 `@x,y` 的 token：无从复核，交给 assertProvenance
            const cell = [Number(m[1]), Number(m[2])];
            const want = f === "x" ? cell[0] : cell[1];
            if (op[f] !== want) {
                violations.push({ index: i, token: tag, op: [op.x, op.y], token_cell: cell });
            }
        }
    });
    return { ok: violations.length === 0, violations };
}

/**
 * 计划阶段。**任一步红 ⇒ 零写入**（本函数从头到尾不碰世界；宏都是 dry-run 规划器）。
 *
 * @returns {{ok:true, txPlan, calls, resolved, provenance:{tagged,untagged}, warnings:string[]}
 *         | {ok:false, code, diagnosis, stage}}
 */
export function buildTxPlan(llmPlan, obs, items, handles) {
    const o = unwrapObs(obs);

    /* ① L-A：原始 LLM JSON 里不许有字面坐标 */
    const la = assertNoHumanCoords(llmPlan, handles);
    if (!la.ok) return planRejectFromViolations(la.violations, "assertNoHumanCoords");

    /* ② L-B：解析三种算子（resolveRefs 内部会再跑一遍 L-A，重复是便宜的） */
    const res = resolveRefs(llmPlan, handles, o);
    if (!res.ok) return planRejectFromViolations(res.violations, "resolveRefs");
    if (!res.calls.length) {
        return reject("LLM_EMPTY_PLAN", {
            layer: "plan", stage: "resolveRefs",
            expected: "至少一条可执行的调用", observed: "解析后 calls 为空",
            evidence: { stage: "resolveRefs" },
        });
    }

    /* ③ 逐条 macro：先过契约校验（结构错误 = LLM_ARGS），再调**真宏** */
    const executed = [];
    for (let i = 0; i < res.calls.length; i++) {
        const c = res.calls[i];
        if (!MACRO_NAMES.includes(c.macro)) {
            return reject("LLM_UNKNOWN_MACRO", {
                layer: "plan", stage: "validate",
                expected: `宏名 ∈ {${MACRO_NAMES.join(",")}}`, observed: JSON.stringify(c.macro),
                evidence: { index: i, macro: c.macro },
            });
        }
        const v = validateMacroCall(c.macro, c.args);
        if (!v.ok) {
            const e = v.error || {};
            return reject("LLM_ARGS", {
                layer: "plan", stage: "validate",
                expected: `${c.macro} 的 args 符合契约`,
                observed: `${e.code || "bad_args"}: ${e.message || ""}`.trim(),
                evidence: { index: i, macro: c.macro, field: e.field || null },
                /* v2 §5.2：结构错误的候选是**该宏自身**（LLM 能看到自己的错误并重试一次） */
                candidates: [c.macro],
                hint: e.hint || "参数名必须逐字来自宏卡片。",
            });
        }
        const fn = MACRO_FNS[c.macro];
        let r;
        try {
            /* 传**解析后的原始 args**（不是 v.value）：`validateMacroCall` 会补默认值
               （例如 replace_run 给 building 补 `confirm_waste:false`），而那个默认值
               与「LLM 没写」是两件事 —— 宏自己也会再校验一次，传原文更接近事实。 */
            r = fn(c.args, { entities: o.entities || [] });
        } catch (e) {
            return reject("INTERNAL", {
                layer: "plan", stage: "macro",
                expected: `${c.macro} 正常返回`, observed: `抛异常：${e && e.message ? e.message : e}`,
                evidence: { index: i, macro: c.macro },
            });
        }
        if (!r || r.ok !== true) {
            const e = (r && r.error) || {};
            return reject("MACRO_REFUSED", {
                layer: "plan", stage: "macro",
                expected: `${c.macro} 返回 ok:true`,
                observed: `${e.code || "?"}: ${e.message || (r && r.reason) || "无 message"}`,
                /* ★ 2026-11-02：给 evidence 补上 `handles`，让这条诊断**可区分** ★
                 *
                 * `fingerprintOf` 只读 `code / layer / subject.handle / evidence.handles / evidence.uids`。
                 * 原来的 `MACRO_REFUSED` 里一个都没有（只有 index/macro/macro_code/field），
                 * 所以**所有**宏失败算同一个指纹（实测：M1→C1 / C1→H1 / B130→H1 全部
                 * `sha256:8458c10d1`）。
                 *
                 * ⚠️ **这条修不了「多轮重试被提前掐断」那个问题** —— 我一开始以为能，
                 * 实测证明不能：`runLoop` 每轮轮首会**重新跑 `diagnose(ob.obs, …)`**
                 * 覆盖 `st.diagnoses`（`loop.mjs:1700`），所以 `MACRO_REFUSED` 根本
                 * 到不了下一轮的指纹计数。真正掐断重试的是「世界没变 ⇒ 世界诊断相同」。
                 *
                 * 那为什么还要改？因为这条诊断会被写进 transcript、也会进
                 * `settleFailure`。让它带着「哪种失败」的信息，对**读 transcript 的人**
                 * 和**将来任何按指纹分组的地方**都有价值。
                 * 改的是「诊断表达力」，不是「重试次数」—— 两者别混。 */
                evidence: {
                    index: i, macro: c.macro, macro_code: e.code || null, field: e.field || null,
                    handles: [`${c.macro}@${e.code || "?"}`],
                },
                hint: e.hint || null,
                candidates: ["connect", "remove_run", "insert_machine", "trash_unused", "replace_run", "extend_line"],
            });
        }
        const planned = r.cells_planned;
        const placed = r.cells_placed;
        if (isInt(planned) && isInt(placed) && planned !== placed) {
            return reject("MACRO_HALF_DONE", {
                layer: "plan", stage: "macro",
                expected: "cells_planned === cells_placed",
                observed: `${c.macro}: planned ${planned} ≠ placed ${placed}`,
                evidence: { index: i, macro: c.macro },
            });
        }
        executed.push({ macro: c.macro, args: c.args, provenance: c.provenance, result: r });
    }

    /* ④ 翻译成一次 tx 的 ops（含 deriveFlows）
     *
     * ★ 必须传 `namedUids`（R13）★
     *
     * 实测漏洞（2026-10-29）：LLM 只给句柄（如 B69/B81/B82），`$bbox_of` 算出矩形，
     * `replace_run` 在矩形里挑落点，**删掉了没点名的 10150、漏掉了点名的 10143**，
     * 而宏返回 ok:true —— 一个"成功"的 tx 会在世界里删掉 LLM 从未指名的东西。
     *
     * `namedUids` = 所有 `res.calls[].args` 里由 `$ref`/`$uids`/`$path_of` 解析出来的
     * 实体 uid 集合。planToTxOps 用它断言「删的就是点名的」，多一个就拒。
     *
     * 注意：`$bbox_of` **不贡献** namedUids —— 它表达的是「覆盖这一块的矩形」，
     * 本身不指名具体对象。这也正是它会顺带框进别的东西的原因。
     */
    const namedUids = collectNamedUids(res.calls, o, handles);
    const txPlan = planToTxOps(executed, { obs: o, items, namedUids });
    if (!txPlan || txPlan.ok !== true) {
        const e = (txPlan && txPlan.error) || {};
        const kind = e.kind || "";
        const code = kind === "MACRO_REFUSED" ? "MACRO_REFUSED"
            : kind === "MACRO_HALF_DONE" ? "MACRO_HALF_DONE" : "PLAN_REJECTED";
        return reject(code, {
            layer: "plan", stage: "planToTxOps",
            expected: "planToTxOps 接受合并后的计划",
            observed: `${e.rule || "?"}: ${e.message || "拒绝"}`,
            evidence: { rule: e.rule || null, kind: e.kind || null },
            candidates: ["remove_run", "insert_machine", "replace_run", "connect"],
        });
    }
    if (!txPlan.ops.length) {
        return reject("PLAN_REJECTED", {
            layer: "plan", stage: "planToTxOps",
            expected: "至少一条 tx op", observed: "ops 为空（空计划不许当成功）",
            evidence: { stage: "planToTxOps" },
        });
    }
    if (txPlan.ops.length > BUDGET.TX_OPS_MAX) {
        return reject("PLAN_REJECTED", {
            layer: "plan", stage: "planToTxOps",
            expected: `ops ≤ ${BUDGET.TX_OPS_MAX}`, observed: `${txPlan.ops.length} 条`,
            evidence: { ops: txPlan.ops.length, limit: BUDGET.TX_OPS_MAX },
        });
    }

    /* ⑤ L-C：每条落盘坐标都要能追溯。**先补 per-op provenance 再判**——
       不补的话 assertProvenance 对任何计划都红（它明确要求这一层，见 coords.mjs:504）。
       ⚠️ 必须传 `executed`（带 `result`）而不是 `res.calls`（只有解析结果）：
       `sourceOfPlace` 要靠宏返回值反查这条 place 是哪个宏落的。两者都带 `provenance`
       （executed 是从 resolved 原样复制过来的），所以溯源校验不受影响。 */
    const withProv = attachProvenance(txPlan, executed, o);
    /* `knownTokens`：`connect` / `extend_line` 的 macro token 是**从 cells[] 合成**的
       （见 sourceOfPlace），不像 pending 那样能由 planToTxOps 写进 `pendingByOp`。
       不把它显式传下去，checkTag 会红在「token 不在当轮宏返回值里」—— 而那句红色
       指向的恰好就是这里缺的一根线。 */
    const lc = assertProvenance({ calls: executed }, { ...txPlan, ops: withProv.ops }, o, { knownTokens: withProv.tokens });
    if (!lc.ok) {
        return reject("COORD_PROVENANCE", {
            layer: "plan", stage: "assertProvenance",
            expected: "每条 op 的坐标都能回到 obs 句柄或宏返回 token",
            observed: (lc.violations[0] && lc.violations[0].reason) || "溯源失败",
            evidence: {
                stage: "assertProvenance",
                violations: lc.violations.length,
                untagged: withProv.untagged.length,
                rules: [...new Set(lc.violations.map(v => v && v.rule).filter(Boolean))],
            },
        });
    }

    /* ⑤b L-C+：`macro:` token 里嵌的坐标必须与 op 的坐标一致（coords.mjs 不查这一条，见函数注释）。 */
    const tc = verifyMacroTokenCoords({ ops: withProv.ops });
    if (!tc.ok) {
        const v = tc.violations[0];
        return reject("COORD_PROVENANCE", {
            layer: "plan", stage: "verifyMacroTokenCoords",
            expected: `op 的落点等于宏返回 token 里的 origin（${v.token}）`,
            observed: `op 落在 (${v.op[0]},${v.op[1]})，token 说 (${v.token_cell[0]},${v.token_cell[1]})`,
            evidence: { stage: "verifyMacroTokenCoords", violations: tc.violations.length },
            hint: "标签没变、值变了：坐标在「宏返回 → 挂标签 → 落盘」之间被改过。",
        });
    }

    return {
        ok: true,
        txPlan: { ...txPlan, ops: withProv.ops },
        calls: executed,
        resolved: res,
        provenance: { tagged: withProv.tagged, untagged: withProv.untagged.length },
        warnings: (txPlan.warnings || []).map(w => w && w.code).filter(Boolean),
    };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. apply 阶段
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * FakeGame 的 `apply(ops)` → bridge 的 tx 返回形状（**只用于离线**）。
 *
 * 与真 tx 的差别（必须知道，否则会误读离线结果）：
 *   · `rolled_back` 恒 false、`verify` 恒 null、`dry_run` 恒 false —— FakeGame 没有事务；
 *   · `results[i].uid` 用「第 k 个 place ↔ applied.added[k]」桥接（与 verify.test 同口径）；
 *   · `failures` 是 FakeGame 的 failures（只有不认识的 op 才会产生）。
 */
export function fakeTx(game, ops) {
    const r = game.apply(ops);
    const placeIdxs = ops.map((o, i) => (o.op === "place" ? i : -1)).filter(i => i >= 0);
    const results = ops.map((o, i) => {
        if (o.op === "delete") return { index: i, op: "delete", ok: true, uid: o.uid, applied: true };
        const k = placeIdxs.indexOf(i);
        return { index: i, op: o.op, ok: true, uid: k >= 0 ? r.added[k] : undefined, applied: true };
    });
    return {
        ok: r.ok !== false, op: "tx",
        applied: r.applied, requested: ops.length,
        rolled_back: false, dry_run: false, aborted: false,
        failures: r.failures || [],
        diff: { added: r.added || [], removed: r.removed || [], modified: [] },
        net: null, verify: null, rollback: null,
        results,
    };
}

/**
 * 发一次 tx。**唯一入口**：调用方给的 `apply` > `reader.tx`（真桥）> FakeGame 替身。
 * 任何异常都转成 `{ok:false, unavailable:true}` —— 由调用方映射成 TX_UNAVAILABLE。
 */
async function doApply(ctx, ops) {
    try {
        if (typeof ctx.apply === "function") return { tx: await ctx.apply(ops, ctx) };
        if (ctx.reader && typeof ctx.reader.tx === "function") return { tx: await ctx.reader.tx(ops) };
        if (ctx.game && typeof ctx.game.apply === "function") {
            return { tx: fakeTx(ctx.game, ops), fake: true };
        }
        return { tx: null, error: "没有可用的写面：apply / reader.tx / game.apply 都不存在" };
    } catch (e) {
        return { tx: null, error: `tx 抛异常：${e && e.message ? e.message : e}` };
    }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 7. 主状态机
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * @typedef {object} LoopOpts
 * @property {object} reader       {obs, debugItems, production, step, tx?}（真桥或 FakeGame.reader()）
 * @property {string|object} goal  形状串（"RuRu----"）
 * @property {object} llmClient    {propose(bundle)}
 * @property {"live"|"mock"|"replay"} mode
 * @property {string} runDir       落盘根目录（`<runDir>/<run_id>/transcript.jsonl`）
 * @property {object} [budget]     覆盖 BUDGET 的任意子集（测试注入用）
 * @property {boolean} [dryRun]    只跑到 plan，世界零写入
 * @property {Function} [apply]    (ops) => tx；给了就用它（优先于 reader.tx）
 * @property {object} [game]       FakeGame 实例（离线写面；给了才能 apply）
 * @property {Function} [recipeSpawn] 配方 solver 的 spawn 注入（签名同 `spawnSync`）。
 *   **只给测试/回放用**：生产不传，走真实 solver。它与 `recipe.mjs` 自己的 `opts.spawn` 同一语义，
 *   目的就是让「recipe 每 run 只跑一次」这条能被机器验证，而不是靠读代码。
 */

/**
 * 跑一次 loop。
 *
 * @param {LoopOpts} opts
 * @returns {Promise<{run_id:string, outcome:"success"|"halt"|"error", reason:string|null,
 *   level:"none"|"offline-only"|"live", rounds:number, llm_calls:number, tx_count:number,
 *   transcript_path:string, run_dir:string, preserved:object, verdict:object|null,
 *   report:object|null, diagnoses:Array}>}
 */
export async function runLoop(opts = {}) {
    const t0 = Date.now();
    const { reader, llmClient } = opts;
    if (!reader || typeof reader.obs !== "function") throw new TypeError("runLoop: reader.obs 必需");
    if (!llmClient || typeof llmClient.propose !== "function") throw new TypeError("runLoop: llmClient.propose 必需");
    const mode = opts.mode || "mock";
    if (!MODES.includes(mode)) throw new TypeError(`runLoop: mode "${mode}" 不在 ${MODES.join("|")}`);
    const goal = typeof opts.goal === "string" ? opts.goal : (opts.goal && (opts.goal.shape || opts.goal.goal));
    if (!goal || typeof goal !== "string") throw new TypeError("runLoop: goal 形状串必需");
    const budget = { ...BUDGET, ...(opts.budget || {}) };
    const runId = opts.runId || `r-${new Date(t0).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(2).toString("hex")}`;
    const runDirRoot = path.resolve(opts.runDir || path.join(REPO, RUN_DIR));
    const runDir = path.join(runDirRoot, runId);
    const tr = new Transcript(runDir, runId);

    const ctx = {
        reader, llmClient, goal, mode, budget, apply: opts.apply || null, game: opts.game || null,
        dryRun: opts.dryRun === true,
    };

    /* ── 运行状态（全部随 run_end 落盘） ── */
    const st = {
        obs: null, items: null, production: null, handles: null,
        lastReport: null, lastPlanSummary: null,
        lastTx: null, lastObs: null, lastItems: null, lastProduction: null,
        worldTouched: false, lastApplyRolledBack: false, lastSuccessfulRound: 0,
        /** 轮数 = **observe 的次数**。解析/计划被拒**不**消耗它（只消耗 llm_calls）——
            世界没变时重新 observe 只会得到同一份数据，那是浪费而不是重试。 */
        rounds: 0,
        llmCalls: 0, txCount: 0, ticks: 0,
        diagnoses: [],
        /** fp → {count, actions:Set} */
        fpSeen: new Map(),
        /** 上一轮用过的宏（供「必须换动作」时从候选中剔除，以及机器判定是否照抄） */
        lastMacros: [],
        /**
         * 上一轮**真正执行过**的宏（`lastMacros` 的子集）。
         *
         * 为什么不能直接剔 `lastMacros`（2026-10-31 半成品世界实验）：
         *   模型一轮可以给多个调用。若**排在前面的宏**在 plan 阶段就失败，`planToTxOps`
         *   按 R1「一条宏失败 ⇒ 一条 op 都不生成」整轮拒绝 —— **后面的宏根本没执行过**。
         *
         *   实测：第 1 轮 `[replace_run, connect]`，`replace_run` 因 `out_of_scope` 被拒，
         *   `connect` 一次都没跑。第 2 轮却把两个一起剔了 ⇒ **正确答案 `connect` 被一个
         *   它从未参与过的失败牵连出局**。
         *
         *   所以「换动作」只该换**导致这次失败的那个动作**。没轮到的 = 没试过 = 保留。
         */
        lastExecutedMacros: [],
        candidatesOverride: null,
        /** 本轮的诊断指纹第 2 次出现 ⇒ 必须换动作（见 countFingerprint） */
        mustChange: false,
        /**
         * **每 run 一次**的配方（`recipeForCached` 的返回）。首轮 observe 之后算，
         * 之后每轮直接复用 —— 这正是 `diagnose` 保持纯函数的前提（它不 spawn）。
         *
         * `null` = 还没算；`{ok:false, reason}` = **算过但失败了**（失败也要存，
         * 否则不可解的目标每轮重跑一次组合爆炸，实测 `CgScCgCg` 单次 1.6s）。
         */
        recipe: null,
    };

    let outcome = "error";
    let reason = "INTERNAL";
    let verdict = null;
    let lastErr = null;

    const budgetLeft = () => ({
        rounds: budget.ROUNDS_MAX - st.rounds,
        llm_calls: budget.LLM_CALLS_MAX - st.llmCalls,
        tx: budget.TX_MAX - st.txCount,
        ticks: budget.TICKS_MAX - st.ticks,
        wall_ms: budget.WALL_MS_MAX - (Date.now() - t0),
    });

    /** 预算检查（顶部调用）。返回 null 表示还有余量。 */
    const budgetStop = () => {
        const left = budgetLeft();
        if (left.wall_ms <= 0) return "BUDGET_WALL";
        if (left.ticks <= 0) return "BUDGET_TICKS";
        if (left.rounds <= 0) return "BUDGET_ROUNDS";
        if (left.llm_calls <= 0) return "BUDGET_LLM_CALLS";
        if (left.tx <= 0) return "BUDGET_TX";
        return null;
    };

    /**
     * **轮首**的失败指纹计数（每轮一次，在 propose 之前）。
     *
     * 为什么在轮首数而不是在轮尾数：契约 T1-02 要求「第 3 轮前 halt，transcript 有
     * **3 条 diagnose、2 条 apply**」。轮首数 ⇒ 第 3 轮看见同一个世界诊断时直接停手，
     * 那一轮既没有 propose 也没有 apply。轮尾数则会先花掉第 3 轮的 LLM 调用与 tx，
     * 得到「3 条 diagnose、3 条 apply」—— 钱已经花了才停。
     *
     * 指纹取**轮首的世界诊断**（不是轮尾的失败诊断）：它是从同一份 obs/report 推出的，
     * 世界不变它就一模一样；轮尾的失败诊断带 message 派生的字段，反而会抖动。
     *
     * 规则（v2 §4 的两层简化，2026-11-02 修订）：
     *   · 第 1 次：正常继续；
     *   · 第 2 次：允许继续，但**必须换动作** —— 候选宏剔除上一轮用过的；
     *     剔空 ⇒ 无可换 ⇒ `halt: NO_PROGRESS`；剔完仍用了同一套宏 ⇒ `halt: NO_PROGRESS`；
     *   · 第 3 次：`halt: NO_PROGRESS_3X`。
     *
     * ## 2026-11-02 修订：计数键加上「动作集」
     *
     * 原规则是「同一 fp 第 3 次就 halt，**无论动作是否相同**」。
     *
     * 实测发现的副作用：`runLoop` 每轮轮首重跑 `diagnose()` 覆盖诊断，
     * 所以计划被宏拒绝时**世界诊断不变**。模型想「换个修法再试」，
     * 第 2 轮被剔掉一半候选，第 3 轮直接 halt（`llm_calls=2 rounds=3`）。
     * 单条宏成功率约 32%，2 次机会 ⇒ 约 10%，与实测的执行率吻合。
     *
     * 新规则：**同一个 (fp, 动作集) 重复才累加；换了动作集就从 1 重新计。**
     * 语义是「诊断没变且动作也没变才算 stall」—— 试了不同的修法但世界没变，
     * 是探索，不是停滞。
     *
     * ⚠️ 防刷靠 `ROUNDS_MAX`，不靠指纹。换动作会让计数归零，所以模型理论上
     * 能靠不停换动作刷满轮次 —— 但轮次本身是硬上限，刷不出更多。
     *
     * ⚠️ 动作集用 `st.lastMacros`（**计划里**的宏）而不是 `lastExecutedMacros`
     * （真正跑过的）：计划在 `buildTxPlan` 阶段被拒时一条都没跑，后者恒空，
     * 三套不同的被拒计划会全是空集 ⇒ 键相同 ⇒ 立刻 halt。而那正是最需要重试的场景。
     *
     * ⚠️ 第 1 轮 `lastMacros` 是空的（还没试过任何东西）。它的键是
     * `fp#<空动作>`，与第 2 轮的真实动作集不同 ⇒ 第 2 轮从 1 重新计。
     * 这是**正确**的：第 1 轮和第 2 轮试的是不同的东西。
     *
     * @returns {{fp, count, haltReason, mustChange}}
     */
    const countFingerprint = (diagnoses, roundNo) => {
        const fp = fingerprintOf(diagnoses);
        const actKey = actionSetHash(st.lastMacros || []);
        const key = `${fp}#${actKey}`;
        const rec = st.fpSeen.get(key) || { count: 0, fp, actKey };
        rec.count += 1;
        st.fpSeen.set(key, rec);

        let haltReason = null;
        let mustChange = false;
        if (rec.count >= 3) haltReason = "NO_PROGRESS_3X";
        else if (rec.count === 2) {
            mustChange = true;
            /* ★ 剔掉「上一轮试过且失败」的宏 ★
             *
             * 优先用 `lastExecutedMacros`（真正跑过的）—— 那是「已被世界检验过」的。
             * 但如果整轮在 plan 阶段就被拒，它恒为空，而**那正是最需要换动作的场景**：
             * 模型刚写了一套注定不行的宏，下一轮必须换。
             *
             * 2026-11-02 修：`last` 为空时退回 `st.lastMacros`（计划里写过的）。
             * 原来的注释说「保留全部候选，交给模型自己换」——
             * 实测（`loop.test.mjs` 第 5 条）那会导致第 2 轮**什么都不变**、
             * 于是第 3 轮才 halt，多花一次 LLM 调用，而且模型没有任何信号。
             *
             * 现在：`last` 为空 ⇒ 用 `lastMacros`；两者都空 ⇒ 才保留全量。 */
            const last = (st.lastExecutedMacros && st.lastExecutedMacros.length)
                ? st.lastExecutedMacros
                : (st.lastMacros || []);
            if (last.length) {
                const next = candidatesFor(diagnoses).filter(m => !last.includes(m));
                if (!next.length) haltReason = "NO_PROGRESS";
                else st.candidatesOverride = next;
            }
            /* last 为空 ⇒ 不设 override（保留全量候选） */
        } else {
            st.candidatesOverride = null;
        }
        tr.write("repair_decide", roundNo, {
            phase: "world_fingerprint",
            fingerprint: fp,
            seen: rec.count,
            action: haltReason ? "halt" : "continue",
            reason: haltReason,
            must_change_action: mustChange,
            codes: diagnoses.map(d => d.code),
            candidates_next: st.candidatesOverride,
        });
        return { fp, count: rec.count, haltReason, mustChange };
    };

    /**
     * 一轮失败后的记账（**不写 diagnose**）。
     *
     * 契约 §1.4 的顺序是「每轮一条 diagnose → … → repair_decide」。轮首那条 diagnose 描述
     * **世界**，这里的失败描述**这一轮为什么没过去**；两者混写会让「同一指纹出现了几次」
     * 变成一件要数两种行的事。所以失败明细放在 `repair_decide.diagnoses` 里（全文，不截断）。
     *
     * @param {string} phase parse|plan|apply|verify|llm_transport|llm_exhausted
     */
    const settleFailure = (diagnoses, macros, roundNo, phase) => {
        st.diagnoses = diagnoses;
        st.lastMacros = Array.isArray(macros) ? macros.slice() : [];
        tr.write("repair_decide", roundNo, {
            phase: phase || null,
            fingerprint: fingerprintOf(diagnoses),
            action_set: actionSetHash(st.lastMacros),
            /* `improved` 需要跨轮的硬失败数比较。第一版**不做**：离线的可比量（L3 恒红）
               与实机不同，跨环境比较会得到假进展。留 null 并在这里说明，不留空字段。 */
            improved: null,
            action: "continue",
            reason: null,
            codes: diagnoses.map(d => d.code),
            diagnoses,
        });
        return { fp: fingerprintOf(diagnoses) };
    };

    try {
        tr.write("run_start", 0, {
            goal, mode,
            obs_hash: null,
            entity_count: null,
            budget: { ...budget },
            dry_run: ctx.dryRun,
            llm: llmClient.constructor ? llmClient.constructor.name : "custom",
            node: process.version,
        });

        for (;;) {
            /* ── 预算（顶部） ── */
            const bs = budgetStop();
            if (bs) {
                outcome = "halt"; reason = bs;
                /* 这里**不写 diagnose**：预算是 meta 事件，不是世界诊断。
                   每轮严格一条 diagnose 的规矩不能为了「有个地方写 reason」而破；
                   reason 在 run_end 里，明细在 HALT.json 里。 */
                break;
            }
            const roundNo = st.rounds + 1;
            st.rounds = roundNo;

            /* ── ① observe ── */
            const ob = await observeOnce(reader);
            if (!ob.obs) {
                outcome = "error"; reason = "INTERNAL"; lastErr = ob.obsError;
                tr.write("observe", roundNo, { error: String(ob.obsError && ob.obsError.message || "obs 不可读") });
                break;
            }
            st.obs = ob.obs; st.items = ob.items; st.production = ob.production;
            st.lastObs = ob.obs; st.lastItems = ob.items; st.lastProduction = ob.production;
            st.handles = buildHandles(ob.obs, ob.items);

            /* ── ①b 配方：**每 run 一次**（首轮 observe 之后，因为需要 `obs.goal.level`） ──
             *
             * 为什么在这里：`diagnose` 必须保持纯函数（每轮调用 + 进 fingerprint）。
             * 配方是唯一需要 spawn 的外部信息，所以在 loop 里算一次、注入进去。
             * 之后每轮直接复用 `st.recipe` —— **包括第 2/3 轮**，因为目标形状与关卡在
             * 一次 run 里不会变（变了就是另一次 run）。
             *
             * 失败也要存：`recipeForCached` 内部已经把失败结果缓存住了，但 `st.recipe`
             * 是**每 run 一层**的保险 —— 不可解目标每次重跑组合爆炸（实测单次 1.6s）。
             * 抛错也 catch 成 `{ok:false}`：solver 是外部进程，它出什么事都不许让 loop 崩。
             * 记在 observe 行里（不新增 transcript kind —— 那是契约 §1.4 的闭集）。 */
            if (st.recipe === null) {
                const lvl = (ob.obs.goal && Number.isFinite(ob.obs.goal.level)) ? ob.obs.goal.level : undefined;
                const recipeOpts = lvl === undefined ? { level: 4 } : { level: lvl };
                /* 注入点只给测试用（见 LoopOpts.recipeSpawn）。生产不传 ⇒ 走真 solver。 */
                if (typeof opts.recipeSpawn === "function") recipeOpts.spawn = opts.recipeSpawn;
                try {
                    st.recipe = recipeForCached(goal, recipeOpts);
                } catch (e) {
                    st.recipe = { ok: false, reason: "internal", message: String(e && e.message ? e.message : e) };
                }
            }
            tr.write("observe", roundNo, {
                tick: typeof ob.obs.tick === "number" ? ob.obs.tick : null,
                truncated: ob.obs.truncated === true,
                entity_count: ob.obs.entity_count,
                paths: ob.items && Array.isArray(ob.items.paths) ? ob.items.paths.length : null,
                paths_truncated: !!(ob.items && isInt(ob.items.pathCount) && Array.isArray(ob.items.paths) && ob.items.pathCount > ob.items.paths.length),
                world_hash: worldUidSetHash(ob.obs),
                problems: ob.problems.map(d => d.code),
                recipe: {
                    ok: !!(st.recipe && st.recipe.ok === true),
                    steps: (st.recipe && st.recipe.ok === true && Array.isArray(st.recipe.steps)) ? st.recipe.steps.length : 0,
                    level: Number.isFinite(st.recipe && st.recipe.level) ? st.recipe.level : null,
                    ...(st.recipe && st.recipe.ok !== true && st.recipe.reason ? { reason: st.recipe.reason } : {}),
                },
            });

            /* ── ② diagnose ── */
            const bad = ob.problems.filter(d => d.code === "OBS_TRUNCATED");
            if (bad.length) {
                /* 截断时**不拿这份数据做判据**，也不继续（任何后续判断都不成立）。 */
                const diag = [...bad, ...diagnose(ob.obs, ob.items, ob.production, null, goal, st.handles, { recipe: st.recipe })];
                tr.write("diagnose", roundNo, { codes: diag.map(d => d.code), fingerprint: fingerprintOf(diag), diagnoses: diag });
                st.diagnoses = diag;
                outcome = "halt"; reason = "OBS_TRUNCATED";
                break;
            }

            let diagnoses = diagnose(ob.obs, ob.items, ob.production, st.lastReport, goal, st.handles, { recipe: st.recipe });
            /* 观测面的问题（items/production 不可用）与业务诊断并列；它们不导致 halt。 */
            for (const p of ob.problems) if (!diagnoses.some(d => d.code === p.code && d.layer === p.layer)) diagnoses.push(p);

            if (!diagnoses.length) {
                diagnoses = [mkDiag("NO_DIAGNOSIS", {
                    layer: "meta", expected: "至少一条诊断", observed: "diagnose() 返回空",
                    hint: "空诊断是 loop 的缺陷，不是「一切正常」—— 停手比瞎猜便宜。",
                })];
                tr.write("diagnose", roundNo, { codes: diagnoses.map(d => d.code), fingerprint: fingerprintOf(diagnoses), diagnoses });
                st.diagnoses = diagnoses;
                outcome = "halt"; reason = "NO_DIAGNOSIS";
                break;
            }

            /* diagnose 行**先写**（每轮恰一条），再做指纹判定 —— 顺序与契约 §1.4 的
               「diagnose 在 repair_decide 之前」一致，读 transcript 的人不会看到倒序。 */
            const fpNow = fingerprintOf(diagnoses);
            tr.write("diagnose", roundNo, { codes: diagnoses.map(d => d.code), fingerprint: fpNow, diagnoses });
            st.diagnoses = diagnoses;

            /* 轮首计数：同一世界诊断第 3 次出现 ⇒ **在花掉这一轮的 LLM 调用之前**停；
               第 2 次则强制换动作（候选宏由 countFingerprint 写进 st.candidatesOverride）。 */
            const seenNow = countFingerprint(diagnoses, roundNo);
            if (seenNow.haltReason) { outcome = "halt"; reason = seenNow.haltReason; break; }
            if (seenNow.mustChange) {
                /* 「必须换动作」不能只靠候选列表暗示 —— prompt 里显式点名上一轮用过什么。
                   这是 v2 §4「同 fp 第 2 次必须换动作」唯一可执行的落点。 */
                st.mustChange = true;
            } else {
                st.mustChange = false;
            }

            /* ── ③+④ propose + plan ──
             *
             * 这两段合在一个**内层重试环**里，因为 v2 §4 删掉了 `LLM_CALLS_PER_ROUND`：
             * 「解析失败也算一轮」的旧规则与「同轮重试」互相否证，v2 的裁决是
             * **解析失败消耗 call 预算、但不消耗 round**。
             *
             * 内层**只重试 LLM 层**（传输失败 / 解析失败）—— 那时世界没变，重问是唯一有
             * 意义的事。**计划被拒（plan 阶段）一律回外层**：它意味着「这套动作在当前世界上
             * 不成立」，要换的是动作或世界，不是重问同一个 prompt。混在内层重试会让
             * 「同一指纹 3 次」这条规则被绕开（同一个拒绝可以被重问 3 次而不计轮）。
             *
             * 内层每次失败的诊断写进 `repair_decide.diagnoses`，不另写 `diagnose`
             * （每轮严格一条的规矩见 settleFailure 的注释）。 */
            let planned = null;
            /** 内层是否已经替外层定了 outcome（halt/error）。false 且 planned===null ⇒ 计划被拒，回下一轮。 */
            let innerDecided = false;
            const llmFails = [];
            for (;;) {
                if (st.llmCalls >= budget.LLM_CALLS_MAX) { outcome = "halt"; reason = "BUDGET_LLM_CALLS"; innerDecided = true; break; }
                const cands = st.candidatesOverride || candidatesFor(diagnoses);
                let bundle;
                try {
                    bundle = buildPrompt({
                        goal, obs: ob.obs, handles: st.handles,
                        /* ★ 必须显式传：production 是 `observeOnce()` 的**第三个字段**
                           （`ob.production`），不在 `ob.obs` 里。过去这里漏了它，于是
                           prompt 每一轮都渲染 `unavailable`，模型永远看不见产线真实速率。 */
                        production: ob.production,
                        diagnoses,
                        candidates: cands,
                        lastRound: st.lastPlanSummary || null,
                        /* 复用 loop 已算好的配方：`buildPrompt` 自己 spawn 一次 solver 要 200–400ms，
                           每轮一次是白花的钱，而且两次结果可能不一致（solver 不可解时）。 */
                        recipe: st.recipe,
                        budget: {
                            rounds_left: budgetLeft().rounds, llm_calls_left: budgetLeft().llm_calls,
                            tx_left: budgetLeft().tx, ticks_left: budgetLeft().ticks, wall_ms_left: budgetLeft().wall_ms,
                            /* ★ 必须显式传预算上限，否则真实大存档上 CAPACITY 段整段消失 ★
                             *
                             * `PROMPT_RULES.PROMPT_TOKENS_MAX = 2800` ⇒ targetChars = min(2800×3.5, 12000)
                             * = **9800 字符**，那是按 37 条带子的小场景调出来的值。
                             * 实测（`research/ai-plan/PROMPT-BUDGET-DEFECT.md`）：
                             *
                             *   L4-obs.json（真实存档，181 实体 / 163 带子 / 7 条诊断）
                             *     默认     → 9895 字符，belts 0/163，CAPACITY **dropped-for-budget**
                             *     16000/4600 → 10593 字符，belts 12/163，CAPACITY **存在**
                             *
                             * 分配顺序（`prompt.mjs:1706`）是「先定带子、余量才给 CAPACITY」，
                             * 所以预算不够时**第一个死的是 CAPACITY** —— 恰好是信息量最大的一段。
                             *
                             * `system` 段逐字节不变（实测），只有 `user` 变长。16000/4600 是饱和点，
                             * 再高不涨（`STATE_BELTS_MAX = 12` 是独立上限）。 */
                            in_chars_max: 16000,
                            prompt_tokens_max: 4600,
                        },
                    });
                } catch (e) {
                    /* PROMPT_OVER_BUDGET：重问不会变小，直接停。 */
                    const d = mkDiag("INTERNAL", {
                        layer: "llm", expected: "prompt 在预算内",
                        observed: `${e && e.code ? e.code + ": " : ""}${e && e.message ? e.message : e}`,
                        evidence: { stage: "buildPrompt" },
                    });
                    tr.write("propose", roundNo, { error: d.observed, code: e && e.code ? e.code : null });
                    st.diagnoses = [d];
                    outcome = "halt"; reason = "INTERNAL"; innerDecided = true;
                    break;
                }

                let llmOut = null, llmErr = null;
                st.llmCalls++;
                try {
                    llmOut = await llmClient.propose(bundle);
                } catch (e) {
                    llmErr = e;
                }
                const parsed = llmErr ? null : parseLlmPlan(llmOut && llmOut.text);
                const code = llmErr
                    ? (llmErr instanceof MockExhausted || (llmErr && llmErr.code === "MOCK_EXHAUSTED") ? "MOCK_EXHAUSTED" : "LLM_TRANSPORT")
                    : (parsed.ok ? null : mapParseCode(parsed.error.code));
                tr.write("propose", roundNo, {
                    llm_call: st.llmCalls,
                    usage: llmOut ? (llmOut.usage || null) : null,
                    candidates: cands,
                    prompt_chars: bundle.system.length + bundle.user.length,
                    tokens_estimate: bundle.tokens_estimate,
                    raw_sha: llmOut && typeof llmOut.text === "string" ? sha256(llmOut.text) : null,
                    plan: parsed && parsed.ok ? parsed.plan : null,
                    error: llmErr ? `${code}: ${llmErr.message}`
                        : (parsed && !parsed.ok ? `${parsed.error.code}: ${parsed.error.message}` : null),
                });

                if (code) {
                    const d = mkDiag(code, {
                        layer: "llm",
                        expected: "一次可解析的 LLM 回复（合法 JSON、1..6 条 calls、宏名在白名单内）",
                        observed: llmErr ? llmErr.message : `${parsed.error.code}: ${parsed.error.message}`,
                        evidence: { llm_call: st.llmCalls, ...(llmErr ? {} : { parse_code: parsed.error.code }) },
                    });
                    settleFailure([d], st.lastMacros, roundNo, code === "LLM_TRANSPORT" || code === "MOCK_EXHAUSTED" ? "llm_transport" : "parse");
                    st.lastPlanSummary = { round: roundNo, calls: [], verify: { checks: [], codes: [code] }, decision: "llm_failed" };
                    /* 夹具耗尽不是「再试一次」能变的（llm.mjs 文件头要求）。 */
                    if (code === "MOCK_EXHAUSTED") { outcome = "halt"; reason = "MOCK_EXHAUSTED"; innerDecided = true; break; }
                    llmFails.push(code);
                    /* 同一 LLM 层错误连续 3 次 ⇒ 重问只可能得到同一个答案（prompt 一字未变）。 */
                    const sameThree = llmFails.length >= 3 && llmFails.slice(-3).every(c => c === code);
                    if (sameThree) { outcome = "halt"; reason = code; innerDecided = true; break; }
                    continue;
                }

                /* ④ plan（零写入） */
                const p = buildTxPlan(parsed.plan, ob.obs, ob.items, st.handles);
                if (!p.ok) {
                    tr.write("plan", roundNo, {
                        ok: false, rejected: p.diagnosis, stage: p.stage,
                        calls: parsed.plan.calls.map(c => c.macro),
                        tx_plan: null, ops: 0,
                    });
                    st.diagnoses = [p.diagnosis];
                    st.lastMacros = parsed.plan.calls.map(c => c.macro);
                    /* plan 阶段被拒 ⇒ **一条 op 都没生成** ⇒ 没有任何宏真正执行过。
                       清空：下一轮的「必须换动作」不该剔除这些（它们没被检验过）。 */
                    st.lastExecutedMacros = [];
                    st.lastPlanSummary = {
                        round: roundNo, calls: st.lastMacros.slice(),
                        verify: { checks: [], codes: [p.diagnosis.code] }, decision: "plan_rejected",
                    };
                    tr.write("repair_decide", roundNo, {
                        phase: "plan",
                        fingerprint: fingerprintOf([p.diagnosis]),
                        action_set: actionSetHash(st.lastMacros),
                        improved: null,
                        action: "continue",
                        reason: null,
                        codes: [p.diagnosis.code],
                        diagnoses: [p.diagnosis],
                    });
                    break;                      // 回外层：换动作/换世界，而不是重问同一份 prompt
                }
                planned = p;
                break;
            }
            if (!planned) {
                /* 内层既没给计划也没定 outcome ⇒ 计划被拒（零写入）。回外层：换动作/换世界。 */
                if (!innerDecided) continue;
                break;
            }
            tr.write("plan", roundNo, {
                ok: true, rejected: null, stage: "ok",
                calls: planned.calls.map(c => c.macro),
                provenance: planned.provenance,
                tx_plan: {
                    ops: planned.txPlan.ops.length,
                    destroys: planned.txPlan.destroys,
                    placements: planned.txPlan.placements.length,
                    flows: planned.txPlan.flows.length,
                    pending: Object.keys(planned.txPlan.pendingByOp).length,
                },                warnings: planned.warnings,
            });

            /* plan 全绿 ⇒ 每个宏都通过了校验、即将进 tx。**从这里起才算「真正执行过」**。
               （宏内部可能有自己的 dry-run，但 plan 过了就意味着它们都会产生 op。） */
            st.lastExecutedMacros = planned.calls.map(c => c.macro);

            if (ctx.dryRun) {
                st.lastPlanSummary = { round: roundNo, calls: planned.calls.map(c => c.macro), verify: { checks: [] }, decision: "dry_run" };
                outcome = "halt"; reason = "DRY_RUN";
                break;
            }

            /* 「同 fp 第 2 次必须换动作」的**执行面**：候选被剔过还要用同一套宏 ⇒ 停。
               只靠 prompt 提示是不够的（LLM 完全可能照抄上一轮），所以这里做机器判定。

               ★ 比的必须是 `lastExecutedMacros`（真正执行过的），不是 `lastMacros` ★

               实测（2026-11-01 最终验证）：第 1 轮 `connect` 因为**参数校验失败**
               （`unknown_field: opts.reuse_existing`）根本没执行；第 2 轮模型去掉
               那个坏参数、给了合法的 `connect`，`plan` 通过了 —— 结果这里拿
               `lastMacros`（含未执行的那个）一比，判成「照抄上一轮」，
               直接 `halt: NO_PROGRESS`，**把一次正确的修复合上了**。

               与「候选剔除」用的是同一口径：没被执行的动作不算「试过」，
               拿它去证明「没换动作」是在惩罚一个未被检验的假设。
               上一轮什么都没执行 ⇒ `lastExecutedMacros` 为空 ⇒ 这条检查不该触发。 */
            if (st.mustChange && st.lastExecutedMacros.length) {
                const now = planned.calls.map(c => c.macro);
                if (actionSetHash(now) === actionSetHash(st.lastExecutedMacros)) {
                    const d = mkDiag("NO_PROGRESS", {
                        layer: "meta",
                        expected: "同一失败指纹下换一套动作",
                        observed: `仍然用了 ${[...new Set(now)].join(",")}（与上一轮相同）`,
                        evidence: { stage: "plan", repeated: [...new Set(now)] },
                        hint: "候选宏已剔除上一轮用过的；LLM 照抄了旧计划。换动作前不再花钱。",
                    });
                    settleFailure([d], now, roundNo, "must_change");
                    outcome = "halt"; reason = "NO_PROGRESS";
                    break;
                }
            }

            /* ── ⑤ apply：一次 tx；判据只用 applyVerdict（绝不读 tx.verify） ── */
            if (st.txCount >= budget.TX_MAX) { outcome = "halt"; reason = "BUDGET_TX"; break; }
            st.txCount++;
            /* ★ 发出去的 ops 必须剥掉 `provenance` ★
             *
             * `provenance` 是 loop **本地**的溯源标签（`assertProvenance` 用它证明
             * 「每条落盘坐标都能追回 obs 句柄或宏 token」）。它**不是**给游戏的字段。
             *
             * 而 mod 的 `validateAction` 对未知字段是**硬拒**（2001 `unknown field`，
             * `shapez-ai-bridge.js:2400-2412`），`place` 的允许字段里没有 `provenance`。
             *
             * 实测（2026-11-01 受控实验）：带上 provenance 直接发 ⇒ tx 2001 全轮失败，
             * `dry_run` 也是 `rolled_back:true`。剥掉之后 `applied:3/3` 正常。
             *
             * 所以：**校验用带标签的，落盘用剥干净的**。两者不能是同一份数组。 */
            const wireOps = planned.txPlan.ops.map(({ provenance: _p, ...rest }) => rest);
            const ap = await doApply(ctx, wireOps);
            st.lastTx = ap.tx;
            if (!ap.tx) {
                const d = mkDiag("TX_UNAVAILABLE", {
                    layer: "tx", expected: "一次 tx 返回", observed: ap.error || "写面缺失",
                    evidence: { stage: "apply" },
                });
                tr.write("apply", roundNo, { error: ap.error || "写面缺失", tx_ok: false });
                settleFailure([d], planned.calls.map(c => c.macro), roundNo, "apply");
                st.lastPlanSummary = { round: roundNo, calls: planned.calls.map(c => c.macro), verify: { checks: [] }, decision: "tx_unavailable" };
                break;                          // 没有写面就不该继续转（下一轮还是同一个错误）
            }
            const av = applyVerdict(ap.tx, { requestedOps: planned.txPlan.ops.length });
            st.lastApplyRolledBack = ap.tx.rolled_back === true;
            tr.write("apply", roundNo, {
                tx_ok: av.ok,
                applied: ap.tx.applied, requested: ap.tx.requested,
                rolled_back: ap.tx.rolled_back === true,
                /* 成功时 tx.verify 是 null —— 这里显式记 null，别让读的人以为「没记就是没验」 */
                uid_set_equal: ap.tx.rolled_back === true && ap.tx.verify ? ap.tx.verify.uid_set_equal : null,
                fake_tx: ap.fake === true,
                diff: ap.tx.diff ? {
                    added: (ap.tx.diff.added || []).length,
                    removed: (ap.tx.diff.removed || []).length,
                } : null,
                why: av.why,
            });
            if (av.hardStop) {
                const d = mkDiag("TX_ROLLED_BACK", {
                    layer: "tx", expected: "回滚后世界洗干净", observed: av.why.join(" / "),
                    evidence: { hard_stop: true },
                });
                st.diagnoses = [d];
                settleFailure([d], planned.calls.map(c => c.macro), roundNo, "apply");
                outcome = "halt"; reason = "TX_ROLLED_BACK";
                break;
            }
            if (!av.ok) {
                const noChange = av.why.some(w => /NO_WORLD_CHANGE/.test(w));
                const code = noChange ? "NO_WORLD_CHANGE" : (ap.tx.rolled_back === true ? "TX_ROLLED_BACK" : "TX_ROLLED_BACK");
                const d = mkDiag(code, {
                    layer: "tx", expected: "tx 干净落盘（ok && !rolled_back && applied==requested && 世界变了）",
                    observed: av.why.join(" / "),
                    evidence: { stage: "apply" },
                });
                settleFailure([d], planned.calls.map(c => c.macro), roundNo, "apply");
                st.lastPlanSummary = { round: roundNo, calls: planned.calls.map(c => c.macro), verify: { checks: [] }, decision: "tx_failed" };
                st.obs = null;                  // 世界可能已被回滚/部分改：下一轮必须重读
                continue;
            }
            st.worldTouched = true;

            /* pending token → 真 uid（只用 results[i].uid） */
            const bridged = buildUidMap(ap.tx, planned.txPlan.pendingByOp);
            if (bridged.missing.length) {
                tr.write("apply", roundNo, { pending_missing: bridged.missing });
            }

            /* ── ⑥ verify ── */
            const report = await verifyRound({
                reader,
                txPlan: planned.txPlan,
                uidMap: bridged.uidMap,
                beforeObs: ob.obs,
                mode,
                goalShape: goal,
                flows: planned.txPlan.flows,
                tx: ap.tx,
                behavior: mode === "live"
                    ? { ticks: Math.min(2400, Math.max(0, budget.TICKS_MAX - st.ticks)) }
                    : false,
            });
            st.lastReport = report;

            /* 验证后再读一次世界：给 run_end 的 final_world_hash、也给下一轮一个**当前**快照。
               （verifyRound 内部那次 afterObs 没有返回，这是唯一能看到「验证之后的世界」的读法。） */
            const afterObs = unwrapObs(await reader.obs({ max_entities: 50000, layer: "all", include_stats: true, include_resources: true, max_resources: 20000 }));
            st.obs = afterObs;
            st.lastObs = afterObs;          // ★ 必须更新：run_end.world_hash 要的是**最终**世界
            st.handles = buildHandles(afterObs, null);
            st.obsFresh = true;

            const checks = report.checks || [];
            const cls = classifyChecks({ checks }, { mode });
            const goalDelta = readGoalDelta(report, mode);
            const verdictNow = phaseTwoVerdict({
                mode,
                strict: report.strict,
                /* 只把**可信**的检查交给判据：classifyChecks 已经判定哪些在当前离线环境下
                   既不能算绿也不能算红；把不可信的检查一起传进去会让离线永远判 "none"，
                   从而无法表达「离线全绿」这一事实本身。不可信项逐条记在下面。 */
                checks: cls.trustworthy,
                goalDelta,
            });
            verdict = verdictNow;
            const hardFails = checks.filter(c => c && c.ok !== true && !c.skipped).map(c => c.name);
            tr.write("verify", roundNo, {
                checks: checks.map(c => ({
                    name: c.name, ok: c.ok,
                    ...(c.skipped ? { skipped: true } : {}),
                    ...(c.degraded ? { degraded: true } : {}),
                    ...(c.undecidable ? { undecidable: true } : {}),
                    ...(c.reason ? { reason: c.reason } : {}),
                })),
                strict: report.strict,
                hardFails,
                apply: report.apply,
                /* V2 §2.4：hash 不足以定位「谁消失了」——落 uidDiff 的具体 uid 列表 */
                uid_diff: report.uidDiff || [],
                untrustworthy: cls.untrustworthy,
                goal_delta: goalDelta,
                world_hash: worldUidSetHash(afterObs),
                level: verdictNow.level,
                achieved: verdictNow.achieved,
                why: verdictNow.why,
            });

            st.ticks += mode === "live" ? 2400 : 0;

            if (verdictNow.achieved) {
                st.lastSuccessfulRound = st.rounds;
                outcome = "success"; reason = null;
                st.lastPlanSummary = {
                    round: roundNo, calls: planned.calls.map(c => c.macro),
                    verify: { checks, codes: [] }, decision: "success",
                };
                break;
            }
            if (verdictNow.level === "offline-only") {
                /* 离线全绿：决策链走通，但**不构成阶段 2 达成**（V2 §6）。停下来并写明。 */
                st.lastSuccessfulRound = st.rounds;
                outcome = "halt"; reason = "OFFLINE_ONLY";
                st.lastPlanSummary = {
                    round: roundNo, calls: planned.calls.map(c => c.macro),
                    verify: { checks, codes: [] }, decision: "offline_only",
                };
                break;
            }

            /* ── ⑦ repair 決策 ── */
            const failDiag = diagnoses.filter(d => d.layer !== "meta");
            settleFailure(failDiag.length ? failDiag : diagnoses, planned.calls.map(c => c.macro), roundNo, "verify");
            st.lastPlanSummary = {
                round: roundNo,
                calls: planned.calls.map(c => c.macro),
                verify: { checks, codes: failDiag.map(d => d.code) },
                decision: "continue",
            };
            /* 失败指纹已在**轮首**计数（见 countFingerprint）：
               「同一世界诊断第 3 次」只可能在下一次轮首被看见，那一轮不花钱即停。 */
        }
    } catch (e) {
        /* 未捕获异常：**不在这里写 run_end** —— 统一交给 finally，
           这样错误路径与正常路径的 run_end 形状完全一致（含 level / preserved）。
           finally 若也写不进去，runLoopCli 会看到 outcome==="error" 并给非 0 退出码。 */
        outcome = "error";
        reason = "INTERNAL";
        lastErr = e;
    } finally {
        /* ── run_end **必须**写（try/finally），含 outcome/level/preserved ── */
        {
            const files = [];
            const put = (n, v) => { if (tr.put(n, v)) files.push(n); };
            if (st.lastObs) put("obs-last.json", st.lastObs);
            if (st.lastItems) put("items-last.json", st.lastItems);
            if (st.lastProduction) put("production-last.json", st.lastProduction);
            if (st.lastPlanSummary) put("plan-last.json", st.lastPlanSummary);
            if (st.lastTx) put("tx-last.json", st.lastTx);
            if (st.lastReport) put("verify-last.json", st.lastReport);
            files.push("transcript.jsonl");

            const worldState = st.lastApplyRolledBack ? "rolled_back" : (st.worldTouched ? "applied" : "untouched");
            const preserved = {
                dir: runDir,
                files,
                /* `--resume` 在阶段 2 第一版**没有实现**：写一个能跑的命令但让它失败，
                   比写 null 更糟。这里显式 null + note。 */
                resume: null,
                note: "--resume 未实现（阶段 2 第一版）：HALT.json + transcript.jsonl 足以人工续跑",
                world_state: worldState,
                last_successful_round: st.lastSuccessfulRound,
            };
            if (outcome !== "success") {
                const halt = {
                    reason,
                    at_round: st.rounds,
                    fingerprint: st.diagnoses.length ? fingerprintOf(st.diagnoses) : null,
                    remaining_budget: budgetLeft(),
                    diagnoses: st.diagnoses,
                    next_actions: nextActionsFor(reason, st.diagnoses),
                    world_state: worldState,
                };
                if (tr.put("HALT.json", halt)) files.push("HALT.json");
            }
            try {
                tr.write("run_end", st.rounds, {
                    outcome,
                    reason,
                    level: verdict ? verdict.level : "none",
                    preserved,
                    rounds: st.rounds,
                    llm_calls: st.llmCalls,
                    tx_count: st.txCount,
                    goal_delta: verdict ? readGoalDelta(st.lastReport, mode) : 0,
                    verdict: verdict ? { achieved: verdict.achieved, level: verdict.level, why: verdict.why } : null,
                    world_hash: st.lastObs ? worldUidSetHash(st.lastObs) : null,
                    error: lastErr ? String(lastErr && lastErr.message ? lastErr.message : lastErr) : null,
                });
            } catch (e) {
                /* 连 run_end 都写不进去：至少让进程以非 0 退出（见 runLoopCli）。 */
                if (lastErr === null) lastErr = e;
            }
        }
    }

    return {
        run_id: runId,
        outcome,
        reason,
        level: verdict ? verdict.level : "none",
        rounds: st.rounds,
        llm_calls: st.llmCalls,
        tx_count: st.txCount,
        transcript_path: tr.file,
        run_dir: runDir,
        preserved: {
            dir: runDir,
            world_state: st.lastApplyRolledBack ? "rolled_back" : (st.worldTouched ? "applied" : "untouched"),
            last_successful_round: st.lastSuccessfulRound,
        },
        verdict,
        report: st.lastReport,
        diagnoses: st.diagnoses,
        ...(lastErr ? { error: String(lastErr && lastErr.message ? lastErr.message : lastErr) } : {}),
    };
}

/** `parseLlmPlan` 的码 → DIAG_CODES 的码（LLM_NOT_JSON 不在闭集里，映射到 LLM_PARSE）。 */
function mapParseCode(code) {
    switch (code) {
        case "LLM_EMPTY_PLAN": return "LLM_EMPTY_PLAN";
        case "LLM_UNKNOWN_MACRO": return "LLM_UNKNOWN_MACRO";
        case "LLM_ARGS": return "LLM_ARGS";
        case "LLM_NARRATION": return "LLM_LINT";
        case "LLM_TOO_MANY_CALLS": return "LLM_PARSE";
        case "LLM_TOO_LONG": return "LLM_PARSE";
        case "LLM_SCHEMA": return "LLM_PARSE";
        case "LLM_NOT_JSON": return "LLM_PARSE";
        default: return "LLM_PARSE";
    }
}

/** 从 verifyRound 的 L4 evidence 取 goal 的累计交付增量（live 才有；其余恒 0）。 */
/**
 * 从 L4-behavior 的证据里取「本轮新增交付」。
 *
 * ★ 跨关时不能用 `goal_delivered_delta` ★
 *   `delivered` 是**当前关卡**的计数，升级会归零 ⇒ 跨关时 delta 是个大负数
 *   （实测 -69），那是「目标换了」，不是「货没了」。
 *   `checkBehavior` 已经把它记成 null，这里改用 hub 的**累计**账本
 *   `target_stored_delta` —— 升级不清零，是跨关时唯一可用的权威增量。
 *
 * 这条链上任何一环退回「delta 必须 > 0」，都会把真实成功判成失败。
 */
function readGoalDelta(report, mode) {
    if (!report || !Array.isArray(report.checks)) return 0;
    const l4 = report.checks.find(c => c && c.name === "L4-behavior");
    const ev = l4 && l4.evidence;
    if (!ev) return 0;

    const crossed = ev.level_changed === true
        || (typeof ev.level_before === "number" && typeof ev.level_after === "number"
            && ev.level_before !== ev.level_after);

    /* 跨关：只认 hub 累计账本。读不到就是 0（没有证据，不猜）。 */
    if (crossed) {
        const s = ev.target_stored_delta;
        return typeof s === "number" && Number.isFinite(s) ? Math.max(0, s) : 0;
    }

    const d = ev.goal_delivered_delta;
    if (typeof d === "number" && Number.isFinite(d)) return d;
    /* delta 不可用（null/缺失）时退回累计账本 —— 它同样是「货进了 hub」的证据。 */
    const s = ev.target_stored_delta;
    return typeof s === "number" && Number.isFinite(s) ? Math.max(0, s) : 0;
}

/** HALT.json 的 next_actions：给人看的三条以内，按码给（不是给 LLM 的提示）。 */
function nextActionsFor(reason, diagnoses) {
    const acts = [];
    const codes = new Set((diagnoses || []).map(d => d.code));
    if (codes.has("OBS_TRUNCATED")) acts.push("用更小的 region 重读，或确认 mod 的 max_entities 与 obs 口径一致");
    if (codes.has("PATHS_TRUNCATED")) acts.push("paths>40 时 L3 永久 undecidable：必须靠 L4 的行为判，不要试图缩短 region");
    if (codes.has("NO_PRODUCTION")) acts.push("检查目标形状是否有产线在造（cutter/rotater 链），再决定 replace_run 的 region");
    if (codes.has("FLOW_UNREACHABLE") || codes.has("FLOW_UNVERIFIED")) acts.push("先让 L3 有显式 flows（planToTxOps 的派生流），再判连通");
    if (codes.has("MOCK_EXHAUSTED")) acts.push("夹具没有下一轮：补 round-NN.json，或确认这条场景本来就该在这里停");
    if (reason === "NO_PROGRESS_3X") acts.push("同一失败指纹连续 3 次：换动作或人工分析，不要继续重试");
    if (reason === "OFFLINE_ONLY") acts.push("离线全绿只是决策链通过；阶段 2 达成必须在 live 模式看到 goal_delivered_delta>0");
    if (reason === "BUDGET_LLM_CALLS") acts.push("提高 LLM_CALLS_MAX 或先修掉反复触发的解析/结构错误");
    if (!acts.length) acts.push("读 transcript.jsonl 与 verify-last.json 定位首个红项");
    return acts.slice(0, 3);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 8. 真桥 reader
 * ══════════════════════════════════════════════════════════════════════════ */

const BRIDGE_BASE = (process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777").replace(/\/+$/, "");
let rpcSeq = 1;

async function rpc(method, params = {}, timeoutMs = 180000) {
    const res = await fetch(`${BRIDGE_BASE}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcSeq++, method, params }),
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

/**
 * 真桥的读取面 + 写面。**参数与 `verify_runtime.mjs` 的 `BRIDGE_READER` 逐字一致**
 * （V2 §5.5 第 5 条：两处口径不同 = 两份世界）。
 * `tx` 走 `act{op:"tx", ops}`（mod 的 `opTx`，`bridge:2490`）。
 */
export function makeBridgeReader(baseUrl) {
    const base = (baseUrl || BRIDGE_BASE).replace(/\/+$/, "");
    const call = async (method, params, timeoutMs) => {
        const res = await fetch(`${base}/rpc`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: rpcSeq++, method, params }),
            signal: AbortSignal.timeout(timeoutMs || 180000),
        });
        const body = await res.json();
        if (body.error) {
            const e = new Error(`${method}: ${body.error.message || "rpc error"}`);
            e.rpc = body.error;
            throw e;
        }
        return body.result;
    };
    return {
        async obs(p) { return call("obs", { max_entities: 50000, layer: "all", include_stats: true, include_resources: true, max_resources: 20000, ...p }); },
        async debugItems(p) { return call("debug_items", p || {}); },
        async production(p) { return call("production", p || { slices: 6 }); },
        async step(ticks) { return call("act", { op: "step", ticks }); },
        async tx(ops) { return call("act", { op: "tx", ops }); },
    };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 9. CLI
 * ══════════════════════════════════════════════════════════════════════════ */

function argVal(argv, name) {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined;
}

/**
 * CLI 入口。退出码：
 *   0 success / 2 halt / 1 error（契约 §6.2 的 3 = 计划被拒但预算未尽，本版未单独使用）。
 */
export async function runLoopCli(argv = process.argv.slice(2)) {
    const goal = argVal(argv, "--goal");
    const mock = argVal(argv, "--mock");
    const useLive = argv.includes("--llm");
    const dryRun = argv.includes("--dry-run");
    const asJson = argv.includes("--json");
    const obsFile = argVal(argv, "--obs");
    const itemsFile = argVal(argv, "--items");
    const runDir = argVal(argv, "--run-dir");
    const maxCalls = argVal(argv, "--max-calls");
    const maxRounds = argVal(argv, "--max-rounds");

    if (!goal) {
        console.error("用法：node src/agent/loop.mjs --goal RuRu---- (--mock <scenario> | --llm) [--dry-run] [--json]");
        return 1;
    }
    if (!mock && !useLive) {
        console.error("必须给 --mock <scenario> 或 --llm（不猜模式：猜错会把离线跑通读成实机达成）");
        return 1;
    }

    let reader, game = null, llmClient, mode;
    try {
        if (mock) {
            mode = "mock";
            const obs = obsFile ? path.resolve(obsFile) : path.join(SAVES, "L4-obs.json");
            const items = itemsFile ? path.resolve(itemsFile) : null;
            game = FakeGame.fromFiles(obs, items, { goal });
            reader = game.reader();
            llmClient = makeClient({ mode: "mock", dir: LLM_FIXTURES, scenario: mock });
        } else {
            mode = "live";
            reader = makeBridgeReader();
            llmClient = makeClient({ mode: "live" });
        }
    } catch (e) {
        console.error(`✗ 初始化失败：${e && e.message ? e.message : e}`);
        return 1;
    }

    const budget = {};
    if (maxCalls !== undefined) budget.LLM_CALLS_MAX = Number(maxCalls);
    if (maxRounds !== undefined) budget.ROUNDS_MAX = Number(maxRounds);

    const res = await runLoop({
        reader, goal, llmClient, mode,
        runDir: runDir ? path.resolve(runDir) : undefined,
        budget, dryRun, game,
    });

    if (asJson) {
        console.log(JSON.stringify(res, null, 2));
    } else {
        console.log("═".repeat(64));
        console.log(`run ${res.run_id}  mode=${mode}  outcome=${res.outcome}  level=${res.level}`);
        console.log(`reason=${res.reason || "-"}  rounds=${res.rounds}  llm_calls=${res.llm_calls}  tx=${res.tx_count}`);
        for (const d of res.diagnoses || []) {
            console.log(`  · ${d.code}  ${d.layer}  subject=${(d.subject && d.subject.handle) || "-"}  ${d.observed || ""}`);
        }
        console.log(`transcript: ${res.transcript_path}`);
        if (res.verdict && res.verdict.why && res.verdict.why.length) {
            console.log("why:");
            for (const w of res.verdict.why) console.log(`  - ${w}`);
        }
    }
    return res.outcome === "success" ? 0 : res.outcome === "halt" ? 2 : 1;
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("agent/loop.mjs");
if (isMain) {
    runLoopCli().then(code => { process.exitCode = code; }).catch(e => {
        console.error("✗ 未捕获异常：" + (e && e.stack ? e.stack : e));
        process.exitCode = 1;
    });
}

export default runLoop;
