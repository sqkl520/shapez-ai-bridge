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
import {
    worldHealth, healthDelta, classifyNetEffect, shapeHash,
    formatHealth, formatDelta, formatNetEffect, formatDeadBySource, NET_EFFECT_LABEL,
} from "./loop/health.mjs";
import { removalRedundancy } from "./loop/redundancy.mjs";
/* 产能：`capacityOf` 是供给/处理两个数的**唯一**真值。
   `NO_PRODUCTION` 的 hint 里要报「加工能力只有供给的 N%」，数字从这里来，不重算。 */
import { capacityOf } from "./assess.mjs";
import { decideRollback, netEffectAfterRollback, ROLLBACK_KINDS } from "./loop/rollback.mjs";
import {
    loadMemory, saveMemory, extractAttempts, mergeMemory, attemptsForGoal,
    worldKeyOf, detectGoalChange, worldUpdate, MEMORY_FILE,
} from "./loop/memory.mjs";
import { findObsoleteLines, findStoredObsolete, describeObsoleteLine, isSanctionedTeardown } from "./loop/obsolete.mjs";

import { MACRO_IMPLS, replaceRun, removeRun, removeMachine, trashUnused } from "./macros/remove.mjs";
/* 升级是**唯一不产生 op** 的宏：它花 hub 里的库存改全局倍率，不动拓扑。
   所以它不经过 tx，而是走 reader.upgrade（mod 的顶层 RPC）。 */
import { upgradeUpgradeLine as upgradeLine, affordableUpgrades } from "./macros/upgrade.mjs";
import { insertMachine, extendLine } from "./macros/place.mjs";
import { connect } from "./macros/connect.mjs";
import { validateMacroCall, MACRO_NAMES } from "./macros/contract.mjs";
/* `indexOf`（原 buildIndex）/ `hubReachable` / `upstreamAt` / `inputFed` / `outputRouted`
 * 在 P-a0 里搬到了 `loop/topology.mjs`（几何真值的唯一实现）。
 * 这里仍然用 `hubReachable` 等旧名字 `export { … } from` 一次，**保持兼容** ——
 * 既有的 import 方（verify / 测试 / 第三方脚本）一个字都不用改。
 * 本文件内部现在只 import `indexOf`（改名 `buildIndex`）：结构判据全部走
 * `structuralDiagnoses`，下游可达性由它在内部按 tier 使用，不再在这里重复算。 */
import { at as atCell } from "./loop/topology.mjs";
import { indexOf as buildIndex, hubReachable, flowReachable, isBelt } from "./loop/topology.mjs";
import { structuralDiagnoses } from "./loop/structural.mjs";
/* 语义层（P-a）：形状传播 + 配方闭包 + 作业分配。**不自己 spawn** ——
   配方由 loop 首轮 observe 后预计算一次、放进 `ctx.recipe` 注入；
   这样 `diagnose` 仍然是纯函数（同 obs 调两次逐字节相同），指纹与 NO_PROGRESS_3X 才成立。 */
import { semanticDiagnoses, beltsCarryingShape } from "./loop/semantic.mjs";
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
    remove_machine: removeMachine,
    replace_run: replaceRun,
    trash_unused: trashUnused,
    insert_machine: insertMachine,
    extend_line: extendLine,
    connect: connect,
    upgrade: upgradeLine,
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

/* ★ 这里曾经有一个 `DIAGNOSE_CODES` 白名单，2026-11-21 删掉 ★
 *
 * 它导出、有注释、看着像「diagnose() 能产出的码」，但 `grep -rn DIAGNOSE_CODES src/`
 * 只有它自己那一行 —— **从来没被任何地方读过**。
 *
 * 留着它比删掉危险：
 *   · 加新诊断码时，人会以为要在这里登记（我这次就加了），然后以为登记完就完事；
 *   · 真正生效的登记点是 `constants.mjs` 的 `DIAG_CODES` 闭集
 *     （`mkDiag` 的 `owns()` 校验）和 `loop.mjs` 里的跨层 `RANK`；
 *   · 一份不生效的「真值」会让人做出错误判断，而它的存在本身就是证据。
 *
 * 这个仓库已经有过「同一个事实存两份、其中一份错」的事故
 * （`mustMix` 在 `MIXER_MISSING` 和 `feed_sources` 里各算一遍，后者还写错了）。
 * 不生效的那份必须删掉，不能留着当参考。 */

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
        /* ③ 宏**自己声明**要删的（`insert_machine` 的 footprint 带子）★
         *
         * `insert_machine` 的语义就是「就地插进一段带子」：机器占的那几格上
         * 原本的带子必须让位。这些带子由**几何唯一决定**，模型无从点名 ——
         * 它指一格带子说「机器插这儿」，压掉哪几格是宏算的。
         *
         * 实测（2026-11-10 第 9 关第 4 轮）：模型给出了完全正确的一步
         *   insert_machine {at: B420, machine: "painter"}
         * 宏返回 `removed_uids: [11205, 11206]`（就是自己 footprint 那两格），
         * 但 R13 只认 `$ref`/`$uids`/`$path_of` 指名的 ⇒ 判 `destroys_not_named`
         * ⇒ 整轮被拒。**没有任何写法能让模型「先点名」那两格**，因为它的意图
         * 本来就是「把机器插进这段带子」。
         *
         * 这与 `connect(allow_replace)` 的豁免同源（见 planToTxOps 的 R13 注释）：
         * 删除范围由 cells/footprint 唯一决定，不是 `$bbox_of` 猜的矩形。
         * R13 要防的是**误框**，不是宏按自己的语义拆自己脚下的带子。 */
        const res = c && c.result;
        if (res && typeof res === "object") {
            const decl = [];
            if (res.changed && Array.isArray(res.changed.removed_uids)) decl.push(...res.changed.removed_uids);
            if (Array.isArray(res.removed_uids)) decl.push(...res.removed_uids);
            for (const u of decl) if (typeof u === "number" && byUid.has(u)) out.add(u);
        }
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

/**
 * 带子类的 building 名 —— 「产物可撤销」判据的一半。
 *
 * 为什么单列一份而不是从 `planToTxOps.mjs` 的 `BELT_KINDS` 导入：
 * 那个常量是模块私有的，而且它的语义是「翻译时按带子处理」。
 * 这里的语义是「这类产物能被 `remove_run` 删掉」。**两者现在是同一个集合，
 * 但将来可能分叉**（比如加了 wire 类建筑）。分开写，各带理由。
 *
 * `remove_run` 的能力边界（`remove.mjs`）：「选集里有 N 个非带子实体（整单拒绝）」——
 * 所以只有带子/proto 隧道能删。机器和垃圾桶没有对应的删除宏。
 */
const REVERSIBLE_BUILDINGS = new Set(["belt", "underground_belt"]);
const isBeltBuilding = b => REVERSIBLE_BUILDINGS.has(String(b));

/** 动作集指纹：同一 fp 下「换了动作没有」的机器判据（v1 §1.6 的 actionSetHash）。 */
export function actionSetHash(macros) {
    /* ★ 去重：`["connect"]` 与 `["connect","connect"]` 是**同一个动作** ★
     *
     * 2026-11-21 实测（4 个 run 里的 3 个）：
     *
     *   r-20261121190439-6190   r1 ["connect"] → r2 ["connect","connect"]
     *   r-20261121100232-d10f   r1 ["connect","connect"] → r2 ["connect"]
     *
     * 两轮都只是在 `connect`，只是**条数不同**。而 `actionSetHash` 只排序不去重，
     * 于是 `"connect"` 与 `"connect,connect"` 算出两个不同的 hash ⇒
     * `countFingerprint` 认为「换过动作了」⇒ 不触发 `mustChange` ⇒
     * 模型可以无限次用 connect 的不同写法绕过「同一指纹第 2 次必须换动作」。
     *
     * 这正是「12 个 run 全是 2 轮就停、goal_delta 恒 0」的机制之一：
     * 判据以为有进展，实际上在原地打转。
     *
     * 语义上也该去重：`countFingerprint` 问的是「动作**种类**换了没有」，
     * 不是「调用条数变了没有」。同一条失败再来一次 connect，无论几次都是重试。 */
    const list = [...new Set((Array.isArray(macros) ? macros : []).map(String))].sort();
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

/**
 * `timeline.log` —— **一条人能读的 run 时间线**。
 *
 * ## 为什么 transcript.jsonl 不够
 *
 * 用户原话：「我觉得，应该需要日志输出，以便检查哪里出问题了」。
 *
 * `transcript.jsonl` 每行是一个 kind + 一坨结构化 data，它是**验收的证据**，
 * 不是**排查的读物**。实际复盘时要做的事是「这轮它干了什么、世界变好还是变坏」，
 * 而那需要把 5 行 JSON 交叉引用才能拼出来 —— 我上次就是这么干的（现场写 node -e）。
 *
 * 所以这里并列写一份纯文本。它**不含任何 transcript 没有的信息**（不新增真值源），
 * 只是同一批事实的人读投影。写失败绝不影响 run（catch 吞掉）——
 * 证据的权威副本是 transcript，这一份是给人看的便利。
 *
 * 格式（每轮固定 6 行，字段顺序固定，可 `diff` 两次 run）：
 *
 * ```
 * ── r1  L6 Cu------ 0/270  实体 136  带子 120(16 机器)  到hub 71/120 59% · 死 49  带上货 0
 *    诊断 CHAIN_UNFED×3 BELT_HANDOFF_REJECTED×3 (fp a1b2c3d4)
 *    模型 connect B12→C1  "rotater 输出没接到 hub"
 *    tx   applied 6/6
 *    之后 L6 Cu------ 0/270  实体 136  带子 126(16 机器)  到hub 71/126 56% · 死 55  带上货 0
 *      ▼ belts_dead 49→55(+6)  ▼ reach_pct 0.59→0.56(-0.03)
 *    净效果 regressive（改坏了） — 死带子 49→55
 * ```
 */
class Timeline {
    constructor(dir) {
        this.file = path.join(dir, "timeline.log");
        this.lines = [];
        /* ★ 立刻落盘，不再攒到最后 ★
         *
         * 原来是 `push()` 攒内存、`flush()` 一次性写。后果：**进程崩溃 = 日志全丢**，
         * 而 transcript 还在。实测三个 run 就是这么丢掉人读记录的
         * （r-20261112135950-ca86 / r-20261115153214-82b8 / r-20261118122101-e997
         * 都跑了 2–4 轮、有 plan 和 apply，但 timeline.log 一个字都没留下）。
         *
         * 用户的要求是「不是没了以后日志也没了」—— 一个缓冲到最后的日志设计
         * 恰恰在最需要它的时候（崩溃）什么都不留。所以改成 push 即追加。
         *
         * 代价：每个 run 多几百次小 write。timeline 单个不到 9 KB，
         * 这点 I/O 与一轮 LLM 调用（几秒）比可以忽略。
         * 仍然全部包在 try/catch 里 —— 日志不该有搞坏 run 的能力。 */
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.file, "", "utf8");   // 先清空，免得和旧内容混
            this.live = true;
        } catch { this.live = false; }
    }

    /** 追加若干行。**任何失败都吞掉**：这不是证据源，不该有能力搞坏一次 run。 */
    push(...lines) {
        for (const l of lines) {
            if (typeof l !== "string") continue;
            this.lines.push(l);
            if (this.live) {
                try { fs.appendFileSync(this.file, l + "\n", "utf8"); }
                catch { this.live = false; }   // 落盘失败就退回纯内存，flush 时再试一次
            }
        }
    }

    flush() {
        try {
            /* 已经逐行追加过；这里只在「落盘失败退回内存」时补写 */
            if (this.live) return this.file;
            fs.writeFileSync(this.file, this.lines.join("\n") + "\n", "utf8");
            this.live = true;
            return this.file;
        } catch { return null; }
    }
}

/** 把一条 diagnose 行压成「码×次数」。 */
function diagCounts(diagnoses) {
    const m = new Map();
    for (const d of diagnoses || []) {
        const c = d && d.code ? d.code : "?";
        m.set(c, (m.get(c) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}×${n}`).join(" ");
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
export function candidatesFor(diagnoses) {
    const seen = [];
    /* ★ 先给每条诊断**至少一个**候选名额 ★
     *
     * 原来的实现是「按诊断顺序，每条取 top-3，凑满 6 个就返回」。那看起来公平，
     * 实际上有一条隐蔽的饥饿：前两条诊断就能把 6 个名额吃光，第三条及之后
     * 一条候选都进不去 —— 哪怕它是**唯一能修那条诊断**的宏。
     *
     * 实测（2026-11-13，688 实体的 level 9 世界）：`UPGRADE_AVAILABLE` 排第 6，
     * 它唯一的候选 `upgrade` 正好被那 6 个名额切掉。于是 prompt 里
     * **诊断说「去买升级」、卡片里却没有 `upgrade` 怎么写** ——
     * 模型看得到建议、看不到语法。这与 `macro-warnings-never-reached-prompt`
     * 是同一类缺陷（算出来 ≠ 送到），只是发生在候选层而不是 warnings 层。
     *
     * 现在两轮：
     *   ① 每条诊断先拿它**权重最高**的那一个候选（保证没有任何诊断被完全忽略）；
     *   ② 还有名额就按原顺序补 top-3 的其余项。
     *
     * 两轮都受 6 个上限约束，所以「最多 6 张卡」这条不变。 */
    const cap = 6;
    const usable = diagnoses
        .map((d, i) => ({ d, i, list: (RETRIEVAL_TABLE[d.code] || []).slice().sort((a, b) => b.weight - a.weight) }))
        .filter(x => x.list.length > 0);

    /* ① 每条诊断先拿它**权重最高的、还没出现过的**候选
     *
     * ⚠️ 「还没出现过的」这个条件是关键，不是优化。
     *
     * 第一版写成「每条取 list[0]」，结果 `NO_PRODUCTION` 的 top 是 `connect`
     * —— 而 `connect` 已经被 `MIXER_UNFED` 拿走了 ⇒ 那一轮**白白消耗掉一个诊断名额
     * 却什么都没加**。实测的后果：`trash_unused` 被挤出前 6，而它是
     * `DEAD_LINES` / `BELT_HANDOFF_REJECTED` 的第二选择，之前一直在列表里。
     *
     * 也就是说「保证每条诊断都有代表」这个目标没达成，反而让另一个宏消失了。
     * 现在按「这条诊断的第一个**新**候选」取 —— 已有代表就顺延到它的次选。
     *
     * ★ 但「每条一个」只在诊断数 ≤ cap 时才真的公平 ★
     *
     * 红队实测（2026-11-13）：7 条诊断时，前 6 条各拿一个，第 7 条
     * （`UPGRADE_AVAILABLE`，跨层 RANK 8，与 `DEAD_LINES`/`ORPHAN_MACHINES` 同分
     * 但按码名字母序排在最后）**第一轮就出局**。8 条时同样。
     *
     * 也就是说上一轮的修复只是把饥饿的阈值从「前 2 条」推到「前 6 条」——
     * 真实 level 9 世界（废线 + 孤儿机并存）正好有 7 条诊断，`upgrade` 仍然看不见。
     * 那正是「AI 不会用更高级的方法提高效率」这条抱怨没被真正解决的原因。
     *
     * 所以第一轮不能只是「按顺序每条一个」—— 那在诊断数 > cap 时等于
     * 「最后几条永远没代表」。真实 level 9 有 7 条诊断，`UPGRADE_AVAILABLE`
     * 排最后（RANK 8 但码名字母序靠后），永远出局。
     *
     * 修法：**给稀有候选优先权**。
     *
     * 观察：`connect` / `replace_run` / `insert_machine` 这类通用宏会出现在
     * 很多条诊断的候选表里；而 `upgrade` 只出现在 `UPGRADE_AVAILABLE` 一条里，
     * `remove_machine` 只出现在 `ORPHAN_MACHINES`。后者才是「只有这一个入口」的
     * 稀缺资源 —— 挤掉它就等于让那条诊断**完全无解**。
     *
     * 所以第一轮按「该宏在整张 RETRIEVAL_TABLE 里出现的次数」升序：
     * 专有宏先占位，通用宏留到第二轮（它们后面还有机会）。
     *
     * 这不是启发式调参，是「候选名额应该优先给不可替代的东西」这条原则的落地：
     * 挤掉 `connect` 的代价是「少一个选择」，挤掉 `upgrade` 的代价是
     * 「那条诊断这一轮没有任何可执行动作」。 */
    const rarity = (() => {
        const freq = new Map();
        for (const list of Object.values(RETRIEVAL_TABLE)) {
            for (const c of list) freq.set(c.macro, (freq.get(c.macro) || 0) + 1);
        }
        return m => freq.get(m) || 0;
    })();
    const byPriority = [...usable].sort((a, b) => {
        /* 首要键必须是**诊断的紧迫度**，不是宏的稀有度。
         *
         * 只按稀有度排会把 `upgrade` 顶到第一位（它只出现在一条诊断里），
         * 于是「该买升级了」压过「这台 mixer 永远跑不起来」。那是错的方向：
         * 买升级只让已有产线变快，产线断了它救不了。
         *
         * `diagnoses` 已经按跨层 RANK 排好，所以 `a.i` 就是紧迫度序。
         * 但**直接按 `a.i` 排又会回到原问题**（第 7 条永远出局）。
         *
         * 折中：先按「紧迫度分档」，同档内按稀有度。
         * 分档用 `a.i < cap` —— 也就是说「本来就在前 6 名之内」的诊断
         * 占前面的档，第 7 名及之后进后档；后档里稀有的先上，
         * 这样 `upgrade` 能在「前 6 条都已代表」之后抢到剩下的名额，
         * 而不会压过任何一条急的诊断。 */
        const ta = a.i < cap ? 0 : 1;
        const tb = b.i < cap ? 0 : 1;
        if (ta !== tb) return ta - tb;
        const ra = a.list.length ? rarity(a.list[0].macro) : 0;
        const rb = b.list.length ? rarity(b.list[0].macro) : 0;
        if (ra !== rb) return ra - rb;      // 同档内：越稀有越先拿名额
        return a.i - b.i;                    // 同稀有度按诊断原序（= 跨层 RANK）
    });

    for (const { list } of byPriority) {
        const m = (list.find(c => !seen.includes(c.macro)) || {}).macro;
        if (m && !seen.includes(m)) seen.push(m);
        if (seen.length >= cap) return seen;
    }
    /* ② 余下名额：按原顺序补齐每条的次选 */
    for (const { list } of usable) {
        for (const c of list.slice(1, 3)) {
            if (!seen.includes(c.macro)) seen.push(c.macro);
            if (seen.length >= cap) return seen;
        }
    }
    return seen;
}

/** 从 report 的某个 check 里取 evidence（不存在返回 null）。 */
function checkOf(report, name) {
    if (!report || !Array.isArray(report.checks)) return null;
    return report.checks.find(c => c && c.name === name) || null;
}

/**
 * 带上跑了多少件货 —— 与 `health.mjs` 的 `items_on_belts` 同一口径。
 *
 * 数 `items.paths[].itemsOnPath`（游戏自己数的每段路上的货），不是数 `belts` 行 ——
 * 后者是「每格上的货」，两者不等价。见 `health.mjs:155-172` 的同名逻辑。
 *
 * @returns {number|null} 读不到返回 null（**不是 0** —— 缺数据不等于没货）
 */
function itemsOnBeltsOf(items) {
    const it = items && items.result ? items.result : items;
    if (!it || !Array.isArray(it.paths)) return null;
    let n = 0;
    let seen = false;
    for (const p of it.paths) {
        const v = p && p.itemsOnPath;
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        n += v;
        seen = true;
    }
    return seen ? n : null;
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
    /* ★ 语义层**不能**被「配方解不出来」整个关掉（2026-11-20）★
     *
     * 原来这里是 `if (cx.recipe)` —— 配方缺席时整层跳过。
     * 而 L12 的求解器是**搜索超限**（`recipe.ok=false`），于是从第一轮起
     * 一条语义诊断都不产。`semanticDiagnoses` 内部其实早就处理了配方缺席
     * （`recipeUsable` 为假时用空 model，纯拓扑分支照常跑，
     * 见 `semantic.mjs:1140` 那段长注释）。
     *
     * 这个外层闸的代价在本轮实测出来：新加的 `PROCESSING_FAR_TOO_SLOW`
     * 在 L12 上算得出（1 台 stacker 处理 0.25/s 对供给 8/s），
     * 但真机跑起来诊断列表里**根本没有它** —— 因为它压根没被调用。
     * 而我本地直接调 `semanticDiagnoses` 时它是有的，所以这个断层
     * 只有真机才暴露得出来。
     *
     * 现在无条件调用：配方缺失由 `semanticDiagnoses` 自己按 `recipeUsable`
     * 逐条决定（依赖配方的分支自然不产），不需要外面再拦一道。 */
    {
        const semRes = dropInlets(semanticDiagnoses(o, it, goalShape, tbl, {
            recipe: cx.recipe || null,
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
                /* ★ 「没产出」和「产出了别的东西」是两件完全不同的事 ★
                 *
                 * 2026-11-21 真机 `r-20261121190439-6190`：模型第一次把线接对了
                 * （`feed_sources` 推荐 + `role@dir` 格式），tx 35/35 落盘，
                 * `produced_total` 从 `{}` 变成 `{----CgCg:4, ScScCgCg:9, CgScScCg:9}`，
                 * hub 库存 `CgScScCg` 2071 → 2080 —— **真的产、真的交付了**。
                 *
                 * 而产的是 `CgScScCg`，**上一关（L11）的目标形状**。
                 *
                 * 旧代码在这里报的是「窗口内目标形状零产出」，然后 hint 让模型
                 * 去「接上一条路」。于是它会继续修、继续产 L11 的形状 ——
                 * 因为**没有任何一条诊断告诉它「你在造错的东西」**。
                 *
                 * `WRONG_SHAPE_PRODUCED` 这个码从第一次提交就登记在
                 * `DIAG_CODES` 里，**但从来没有任何地方 emit 过它**
                 * （`grep -rn WRONG_SHAPE_PRODUCED src/` 只有 constants.mjs 三处）。
                 * 一条登记了三年的死码。
                 *
                 * 现在补上：产了东西但都不是目标形状 ⇒ 单独报，并说清产的是什么。 */
                /* ⚠️ 这里是 `diagnose()` 内部，参数名是 `production`，不是 `ob.production`
                 * —— `ob` 是 `runLoop` 里的变量，这里根本不存在。第一版写成
                 * `ob.production` 会抛 ReferenceError，而外层有 try/catch ⇒
                 * 整段静默不生效，症状是「加了诊断但一条都不报」。
                 * 本仓库在 `computed-but-never-delivered` 里记过同族形态。 */
                const producedAll = (production && production.produced_total
                    && typeof production.produced_total === "object")
                    ? production.produced_total : null;
                const otherShapes = producedAll
                    ? Object.entries(producedAll)
                        .filter(([k, v]) => k !== goalShape && Number(v) > 0)
                        .sort((a, b) => Number(b[1]) - Number(a[1]))
                        .slice(0, 3)
                    : [];
                if (otherShapes.length) {
                    const what = otherShapes.map(([k, v]) => `${k}×${v}`).join(", ");
                    out.push(mkDiag("WRONG_SHAPE_PRODUCED", {
                        layer: "L4", subject,
                        expected: `产出窗口里出现 ${goalShape}`,
                        observed: `窗口内在产 ${what} —— 一件 ${goalShape} 都没有`,
                        handles: [subject.handle], uids: hub ? [hub.uid] : [],
                        evidence: {
                            check: "L4-behavior",
                            produced: Object.fromEntries(otherShapes),
                            goal: goalShape,
                        },
                        candidates: ["connect", "insert_machine", "replace_run"],
                        hint: `**这条线是通的 —— 货真的产出来、也真的进了 hub。问题只是颜色/形状不对。**`
                            + ` 产的是 ${what}，有 3 个常见原因：`
                            + ` ① 喂进 painter 的**颜料颜色**不对（一个 painter 只吃一种颜料，`
                            + `喂错色出来的就是另一个形状）；`
                            + ` ② 缺一道工序（比如目标要两层却没接 stacker）；`
                            + ` ③ 这条线本来就是**上一关遗留**的，产的是上一关的目标形状。`
                            + ` 先看产出的颜色/齿形对不对，再决定是改颜料、补工序、还是拆掉重建 ——`
                            + `**继续在这条线上修堵塞不会有任何用**。`,
                    }));
                } else {
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
            /* ★ 世界已经腐化时，hint 要先说「清理」（2026-11-15 夜，L12 真机）★
             *
             * 实测：577 条带子、49 台机器、28 个垃圾桶，产出恒 0。
             * agent 连着 4/6 轮全撞 `connect:occupied` —— 世界被自己的旧线塞满了。
             * 而它每轮按 hint 换端口、换目标，下一轮又撞，世界只会更挤。
             *
             * 「没有产线在造目标」这句话在干净的世界里指向「去建一条」，
             * 在腐化的世界里指向「先清出空间」。同一个诊断，两种完全不同的下一步。
             * 判据用带子数：L12 需要的完整产线大约 60-100 条带子，
             * 577 条意味着绝大部分是废线。 */
            const beltCount = idx.ent.filter(e => e.belt || e.type === "belt" || e.type === "underground_belt").length;
            const trashCount = idx.ent.filter(e => e.type === "trash").length;
            /* ★ 「腐化」不能只看带子数 ★
             *
             * 原来的判据是 `beltCount >= 300` —— 于是 L12（716 条带子）被判成腐化，
             * hint 变成「先清理，别再往上加」。实测跑了十几轮，模型照做了，
             * 净效果是 cleanup / inert 反复出现，产出一直是 0。
             *
             * 那条判据漏了一件事：带子多不等于全是废线。L12 有 **602 条到 hub 的活带**
             * （`paths_with_items`），它们是真的在流动的干线。真正缺的是**工序级联**：
             * 目标要白色颜料，而白色 = 蓝+绿+红 三级混，一台 mixer 根本不够。
             *
             * 所以加一条并列判据：机器数正常（≥8 台）但 mixer 只有 0–1 台时，
             * 问题在「缺级联」而不是「太脏」。此时让 hint 指向补工序，而不是拆。
             * 这个区分是 L12 实测逼出来的：拆了十几轮，机器一台没加。 */
            const machineCount = idx.ent.filter(e => e && !e.belt && e.type !== "belt"
                && e.type !== "underground_belt" && e.type !== "hub" && e.type !== "trash").length;
            const mixerCount = idx.ent.filter(e => e && e.type === "mixer").length;
            const machineRich = machineCount >= 8;
            /* ★ 判据不能是「mixer 有几台」，也不能是「矿机接没接线」★
             *
             * 前几版依次试过：`mixerCount <= 1`、`< 4`、`paths_with_items < 30`、
             * 「矿机是否接上带子」。全部失败，原因各不相同但教训一样：
             *   · 数机器台数 —— 模型补够之后判据立刻翻转，指令掉头；
             *   · `paths_with_items` 是 health 的字段，`p` 是 production 对象，恒 undefined；
             *   · 「矿机接线」—— 实测 16 台里 10 台接了，判据说「接得挺好」，
             *     但那些带子并不通向 hub，产出照样是 0。
             *
             * 真正的问题是**工序有没有连成一条到 hub 的路**。
             * 直接量它：把「能到 hub 的带子数」和「带子总数」比 —— 如果大量带子
             * 到不了 hub，那说明它们各自为政，不是缺机器也不是脏。
            /* ★ 实测数据推翻了「腐化」这条判据本身 ★
             *
             * 2026-11-18 直接在 L12 世界上量：**701 条带子里 532 条能到 hub（76%）**。
             * 也就是说这个世界一点都不脏 —— 绝大多数带子是真的通到 hub 的活线。
             * 而「腐化」判据用的是 `beltCount >= 300`，它把「带子多」当成了「垃圾多」，
             * 于是每轮都让模型去拆一批正在工作的线。
             *
             * 这才是 0 产出的真正解释：不是缺机器、不是缺空间、更不是脏，
             * 而是**这些活着的带子运的不是目标形状**。
             *
             * 所以这条 hint 不再建议清理，而是直说这一点。
             * `rotten` 保留字段（下游有测试依赖它），但恒为 false ——
             * 「带子多」不再被当成脏的证据。 */
            let reachableBelts = null;
            try {
                const reach = hubReachable(o, idx);   // Set<uid>，见 topology.mjs:596
                const belts = idx.ent.filter(e => e && (e.belt || e.type === "belt" || e.type === "underground_belt"));
                reachableBelts = belts.filter(b => reach.has(b.uid)).length;
            } catch { reachableBelts = null; }
            const reachRatio = (reachableBelts !== null && beltCount > 0)
                ? reachableBelts / beltCount : null;
            const rotten = false;
            const poorlyLinked = reachRatio !== null && beltCount > 100 && reachRatio < 0.5;
            const needsCascade = machineRich && mixerCount >= 1 && !poorlyLinked;
            out.push(mkDiag("NO_PRODUCTION", {
                layer: "L4",
                subject,
                expected: `有产线在造 ${goalShape}`,
                observed: p ? `窗口内 ${goalShape} 产出 0（delivered ${delivered === null ? "?" : delivered}/${required === null ? "?" : required}）`
                    + (rotten ? `；世界已有 ${beltCount} 条带子 / ${trashCount} 个垃圾桶，产出仍然是 0` : "")
                    + (needsCascade ? `；已有 ${machineCount} 台机器、${beltCount} 条带子，但 mixer 只有 ${mixerCount} 台` : "")
                    : "production 不可用，无法确认任何产线在造目标形状",
                handles: [subject.handle], uids: hub ? [hub.uid] : [],
                evidence: {
                    stage: "initial", goal: goalShape,
                    ...(rotten ? { belts: beltCount, trash: trashCount, rotten: true } : {}),
                    ...(needsCascade ? { machines: machineCount, mixers: mixerCount, needs_cascade: true } : {}),
                },
                candidates: rotten
                    ? ["remove_run", "connect", "insert_machine", "trash_unused"]
                    : (needsCascade
                        ? ["insert_machine", "connect", "replace_run", "remove_run"]
                        : ["connect", "insert_machine", "trash_unused"]),
                hint: rotten
                    ? `这个世界已经堆了 ${beltCount} 条带子却一件都产不出来 —— 说明绝大部分是接不上的旧线。`
                        + `**先清理，别再往上加**：用 \`remove_run\` 把到不了 hub 的旧线成片拆掉，`
                        + `腾出空间之后，正解往往只要几十格。继续铺新线只会撞上自己。`
                    : (needsCascade
                        /* 这条 hint 说的是「工序建了但没接通」—— 与「缺工序」是两回事，
                         * 因为实测里模型已经把 mixer 补到 4 台了，缺的是接线。
                         *
                         * ★ 措辞顺序由**截断位置**决定，不是由行文习惯决定（2026-11-20）★
                         *
                         * 这里原来先铺垫三句（「世界有 N 台机器…」「所以问题不是…」「下一步：顺着…」），
                         * 把产能缺口放在第 280 字符。而 `prompt.mjs:2469` 对非白名单诊断的
                         * hint 截到 **180 字符** —— 那段产能提示**从来没有到达过模型**。
                         *
                         * 我上一轮"验证"它时只确认了 hint 被放进 prompt，没确认它**活过了截断**。
                         * 这正是本项目反复出错的那一类：算出来 ≠ 送到 ≠ 送达时还完整。
                         *
                         * 现在把最能改变动作的那句放在最前面。前 180 字符必须自带
                         * 「缺什么、加多少、为什么」三件事，后面的句子只做补充。 */
                        ? (() => {
                            /* 先算产能，因为它决定这句话的**开头**写什么。 */
                            let capLine = "";
                            try {
                                const cap = capacityOf(o);
                                const k = cap && cap.bottleneckMachine;
                                const u = cap && cap.utilization;
                                if (cap && cap.confidence === "ok" && cap.bottleneck === "process" && k
                                    && typeof u === "number" && u < 0.5) {
                                    const add = cap.process && Array.isArray(cap.process.machines)
                                        ? cap.process.machines.find(m => m.kind === k) : null;
                                    const n = add ? add.count : null;
                                    const needN = add && add.ratePerSec > 0
                                        ? Math.ceil(cap.supplyPerSec / add.ratePerSec) : null;
                                    capLine = `**${k} 只有 ${n} 台，产能 ${cap.process.capacityPerSec}/s，`
                                        + `而矿机在产 ${cap.supplyPerSec}/s —— ${Math.round((1 - u) * 100)}% 过不去。**`
                                        + `加工机器没有并联上限，`
                                        + (needN !== null ? `加到 ${needN} 台就吃得满。` : "")
                                        + `\`insert_machine {machine:"${k}", at:<空地>, facing:<朝外>}\` 一台一台加。\n`;
                                }
                            } catch { /* 产能算炸了不许影响诊断 */ }
                            return capLine
                                + `世界 ${beltCount} 条带子里 ${reachableBelts} 条（${Math.round((reachRatio || 0) * 100)}%）已通到 hub，`
                                + `但 hub 一件 ${goalShape} 都没收到 —— 通着的带子运的不是目标形状。`
                                + `顺序不能反：**先接通一条路，再并列复制那一段**；断线上加机器不产出任何东西。`
                                + `\`insert_machine\` / \`replace_run\` / \`connect\` 三个宏够用。`
                                + `**别再成片拆带子** —— 它们在正常工作。`;
                        })()
                        : "首轮没有 report：这是「目标形状没有产线在造」的初始诊断，不是对某条 check 的复述。"),
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
        WRONG_SHAPE_AT_HUB: 1, DISCARDED_INTERMEDIATE: 2,
        /* ★ `MIXER_UNFED` 必须排在**结构层之前** ★
         *
         * 跨层 RANK 是这个文件说了算的，`semantic.mjs` 自己的 CODE_RANK 只管层内。
         * 没登记在这里 ⇒ 落到默认的 50 ⇒ 排在 `DEAD_END`(9) /
         * `BELT_HANDOFF_REJECTED`(9) **之后**。
         *
         * 第 9 关实测的后果：`MIXER_UNFED` 说「这台 mixer 只有一路颜料，配方永远跑不起来」，
         * 而模型连着五轮在追 `BELT_HANDOFF_REJECTED` 和 dead painter —— 那些是**症状**，
         * 而配方的前提没满足时，下游怎么修都不会有产出。
         *
         * 排在 `< PROCESSOR_REQUIRED` 之前：机器已经在世界上、只是喂不进去，
         * 这种情形比「还没有机器」更具体，也更该先处理。 */
        MIXER_UNFED: 2, PROCESSOR_REQUIRED: 3,
        /* ★ `WRONG_SHAPE_PRODUCED` 必须排在 `NO_PRODUCTION` **之前** ★
         *
         * 两者都描述「窗口里没有目标形状」，但前者多一句关键信息：
         * **线是通的，只是造错了东西**。2026-11-21 真机实测，模型看到的是
         * 「零产出」，于是继续去修堵塞，而它其实已经产出了 9 件 L11 的形状。
         *
         * 排在 `NO_PRODUCTION` 前面，这份信息才不会被「零产出」那句盖掉。 */
        WRONG_SHAPE_PRODUCED: 4,
        NO_PRODUCTION: 5, PRODUCED_NOT_DELIVERED: 6, FLOW_UNREACHABLE: 7, FLOW_UNVERIFIED: 8,
        SLOT_STARVED: 9, OUTPUT_UNROUTED: 9,
        /* ★ `OUTPUT_STRANDED` 必须登记，否则落到默认 rank=50 被挤掉 ★
         *
         * 合并后有 `LIMITS = {PER_CODE:3, TOTAL:8}` —— 总量只留 8 条。
         * 语义层自己就能产 7 条，再加上结构层，排在后面的**整条消失**。
         * 我加了这个诊断但忘了登记 RANK，实测 `diagnose()` 的输出里根本没有它
         * （`semanticDiagnoses` 里有，合并时被挤掉）—— 症状是「写了诊断但一条都不报」。
         *
         * 这是本仓库第三次踩「新码没登记跨层 RANK」：`MACHINE_STARVED` 和
         * `WRONG_SHAPE_PRODUCED` 都栽过同一个坑。
         *
         * 排在 `OUTPUT_UNROUTED` 旁边：两者都是「输出口没去处」，同一档。
         * 它比 `MACHINE_STARVED` 低——缺进料更致命（整条链冻死），
         * 而悬空输出口只是「一半产物堵住」，机器至少还在转。 */
        OUTPUT_STRANDED: 9,
        /* ★ `DEAD_LINES` / `ORPHAN_MACHINES` 必须排在这些**症状码之前** ★
         *
         * 这两个码是 2026-11-13 才加的，当时只登记了 `semantic.mjs` 自己的 `CODE_RANK`
         * （只管层内排序），**忘了登记这张跨层表** —— 于是落到默认 50 分。
         *
         * 后果不是「排在后面一点」，是**整批消失**：总量上限是 8 条，而
         * `BELT_HANDOFF_REJECTED`(9) 和 `CHAIN_UNFED`(10) 光靠「每码 3 条」就能占满 6 格，
         * 再加 MIXER_UNFED / PROCESSOR_REQUIRED / NO_PRODUCTION 就已经 8 条了。
         * 实测 688 实体、636 带子的世界（43% 带子到不了 hub、11 台孤儿机器）：
         * **`diagnose()` 的产出里这两个码一条都没有**，模型连「该清理」这句话都看不到。
         * 于是清理永远不会发生 —— 与用户反复指屏幕说「废弃的不删」完全吻合。
         *
         * 排在 8（`DEAD_END`=9 之前）的依据是**因果方向**：
         * 那个世界里 `BELT_HANDOFF_REJECTED` / `CHAIN_UNFED` 点的带子**大多本身就是废线**
         * （275/636 到不了 hub）。让模型先去 connect 一条废线，等于把垃圾当活线修。
         * 不排更高（不进 1–4）是因为「配方前提没满足」比「地形脏」更该先处理 ——
         * 世界再脏，只要 mixer 喂不进去就永远没有产出。 */
        DEAD_LINES: 8, ORPHAN_MACHINES: 8,
        /* ★ `MACHINE_STARVED` 排 3：**这是第三次踩同一个坑**（2026-11-21）★
         *
         * 跨层 RANK 是本表说了算的，`semantic.mjs` 的 `CODE_RANK` 只管层内。
         * 没登记在这里 ⇒ 落到默认 **50** ⇒ 排在所有症状码之后。
         *
         * 实测（`r-20261121072433-521e`，8 条诊断）：
         *
         *     1.HUB_INLET_THIN(4)  2.NO_PRODUCTION(4)  3.BELT_HANDOFF_REJECTED(9)
         *     4.CHAIN_UNFED(10)    5.CHAIN_UNFED(10)
         *     6.MACHINE_STARVED(50) ← 成因，排在第 6
         *     7.MINER_UNWIRED(50)  8.MIXER_COLOR_AIMED(50)
         *
         * 而同一条链路里，`CHAIN_UNFED` 是**症状**（某条带的入口没上游），
         * `MACHINE_STARVED` 是**成因**（机器缺料 → 不产出 → 上游才堵）。
         * 症状排在成因前面，模型当然去修症状。
         *
         * 前两次同样的坑：
         *   · `DEAD_LINES` / `ORPHAN_MACHINES`（见上面那段）
         *   · `HUB_FED_BY_COLOR` / `HUB_INLET_THIN`（见下面那段）
         * 都是「码加了，跨层表忘了登记」⇒ 整批消失或排到最后。
         *
         * 排 3（`MIXER_UNFED`=2 之后、`NO_PRODUCTION`=4 之前）的依据是因果深度：
         * 「配方前提没满足」最该先修，其次是「机器缺料、整条链冻住」，
         * 再往后才是「没有产出」这种结果码。
         *
         * 零字符预算 —— 只是换个排序位置。 */
        MACHINE_STARVED: 3,
        /* ★ `UPGRADE_AVAILABLE` 与它们同级 ★
         *
         * 同一类：不是「坏了」，是「有一件零成本的好事没做」。但它比地形脏更值得说 ——
         * 清理废线只腾出空间，买升级直接让**所有同类机器变快**。
         *
         * 排在 8 而不是更前：产线断了的时候升级救不了（断线的瓶颈不在倍率），
         * 所以「配方跑不起来」必须仍然优先。而没有这类阻塞时，它就该进前 8。 */
        UPGRADE_AVAILABLE: 8,
        /* ★ 两个 hub 入口诊断必须排在大批地形诊断**之前** ★
         *
         * `DEAD_LINES` / `ORPHAN_MACHINES` 那段注释（上方）已经记过一次：
         * 一个诊断类没进这张表 ⇒ 默认 50 ⇒ 被 cap 8 整批挤掉 ⇒ 「整批消失」。
         *
         * 而 hub 入口是**因果最上游**：货送不进 hub，下游修多少条带子产出都是 0。
         * `HUB_FED_BY_COLOR` 更特殊 —— 它说的是「送的东西类型就不对」
         * （颜料进不了 `filter:"shape"` 的入口），这比「线断了」更该先看：
         * 线修好了照样进不去。
         *
         * 实测（L12）：这两个码原本都不在表里，默认 50，排在
         * `CHAIN_UNFED`(10) / `BELT_HANDOFF_REJECTED`(9) 之后，被 cap 压掉。 */
        HUB_FED_BY_COLOR: 3, HUB_INLET_THIN: 4,
        DEAD_END: 9, BELT_HANDOFF_REJECTED: 9,
        CHAIN_UNFED: 10, WASTE_NO_SINK: 10, RAW_MATERIAL_MISSING: 10,
        /* ★ 以下 5 个码补登记（2026-11-21）★
         *
         * `diag_registry.test.mjs` 扫出来的：它们由 `semantic.mjs` 产出、
         * 会进 `diagnose()` 的输出、会和别的诊断竞争 `LIMITS.TOTAL = 8`，
         * 但**从来没登记 RANK** ⇒ 落到默认 50，排在所有已登记码后面。
         *
         * `MINER_UNWIRED` 今天还在真机上出现过（排第 7）—— 它一直在靠运气，
         * 语义层刚好只产 7 条时才勉强塞进去。再加一条诊断就会被挤掉，
         * 而它的症状是「**写了诊断、测试全绿、真机一条都不报**」，极难查。
         *
         * 排位依据「修它的紧迫性」：
         *   · `MIXER_MISSING` / `MIXER_UNFED` 同级 2 —— 没有 mixer 时目标色永远不存在，
         *     在这之前修任何带子都是白费
         *   · `MINER_UNWIRED` / `ORE_UNMINED` 11 —— 「矿机就位只差接线」，
         *     是唯一可行施工顺序的中间态
         *   · `MIXER_COLOR_AIMED` 12 —— 朝向错，比「没接线」轻一档
         *   · `TRASH_OVERGROWN` 14 —— 清理类，最不紧迫 */
        MINER_UNWIRED: 11, ORE_UNMINED: 11,
        MIXER_COLOR_AIMED: 12,
        TRASH_OVERGROWN: 14,
        /* `MIXER_MISSING` 补在这里：与 `MIXER_UNFED` 同为 2，
           两者都描述「这台 mixer 现在什么也合不出来」。 */
        MIXER_MISSING: 2,
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
    /* 上限是**契约级**的（`p_b_wiring.test.mjs` T3 钉死「合并后总量 ≤8、每码 ≤3」）。
     * 不要因为「新加了一条诊断装不下」就抬这个数 —— 那等于改契约来迁就实现。
     * 正确的做法是让新诊断**排到该在的位置**，让不重要的让位。 */
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
    /* ★ `UNKNOWN_PARAM` 也要单独成码 ★
     *
     * `argKindOf` 返回 null 既可能是「参数存在但不是坐标类型」，
     * 也可能是「这个宏根本没这个参数」。
     *
     * 实测（2026-11-15，L12）：agent 对 `remove_run` 写了 `{region:$path_of(...)}`，
     * 而 `remove_run` 的参数是 `uids` / `cells` / `opts.*` —— 根本没有 region。
     * 旧版只报「不是坐标参数」，模型看不出是**参数名写错**，
     * 换着法子重试同一个不存在的参数，三轮全耗在这上面。
     *
     * 单独成码才能把 hint 写成「换参数名，合法的有这些」。 */
    if (rules.has("UNKNOWN_PARAM")) {
        const v = violations.find(x => x && x.rule === "UNKNOWN_PARAM") || {};
        const avail = (v.value && Array.isArray(v.value.available)) ? v.value.available : [];
        return reject("LLM_ARGS", {
            layer: "plan", stage,
            expected: "用的参数名在该宏的声明里存在",
            observed: v.reason || "参数名不存在",
            evidence: { stage, rules: [...rules], path: v.path || null, available: avail },
            hint: `换参数名。这个宏接受：${avail.join(" / ")}。`
                + `坐标算子（$ref / $uids / $bbox_of / $path_of）要放在真正的坐标参数上。`,
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
        /* 宏名来自违规对象本身（`coords.mjs` 在 `add(...)` 时带上 `value.macro`）——
           写死 `replace_run` 会在模型用的是别的宏时把它引到错误方向
           （2026-11-15，L12：模型用的是 `remove_run`，候选却always 是 `replace_run`）。 */
        const via = v.value && typeof v.value.macro === "string" ? v.value.macro : null;
        return reject("PATH_NOT_RECT", {
            layer: "plan", stage,
            expected: "交给 region 的 $path_of 格集恰好填满自己的外接矩形（连续选区）",
            observed: v.reason || "选区不连续",
            evidence: { stage, rules: [...rules], path: v.path || null },
            /* 候选是**该宏自身**（与 LLM_ARGS 同口径：给它重试一次的机会） */
            candidates: via ? [via] : ["replace_run"],
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
            if (at(r.trashCell)) {
                /* ★ 没有 `pending` ⇒ 必须合成 token（与 connect/extend_line 同源处理）★
                 *
                 * `trash_unused` 是唯一一个**有落点但没有 pending 引用**的宏：
                 * 它放一台 trash 到某个出口格，`trashCell` 就是那个格子，坐标由宏
                 * 从端口几何算出来。但落到 op 上之后既没有 `macro:` token（pending 为空），
                 * 也不满足 `obs:uid=` 判据（`e.x === op.x` —— trash 落在**出口格**，
                 * 不是被点名那条带子本身），于是**每一条都被判 MISSING_PROVENANCE**。
                 *
                 * 实测（2026-11-10 第 9 关）：模型一轮里三条 `trash_unused` 全部通过宏、
                 * 全部有落点，整轮却因为 `3 条 op 都没有 provenance` 被拒。
                 * 那条诊断的原文还写着「planToTxOps 目前不产出这一层，loop 必须补齐」——
                 * 补齐的地方就在这里，只是当初漏了 trash 这一支。
                 *
                 * token 形式与 connect 一致：`<macro>:<kind>@<x>,<y>`，
                 * 语义是「这一格的坐标来自这个宏在这一次调用里的返回值」。 */
                return {
                    call: c, index: i, entry: r,
                    token: `trash_unused:trash@${r.trashCell[0]},${r.trashCell[1]}`,
                    synthesized: true,
                };
            }
        } else if (c.macro === "connect" || c.macro === "extend_line") {            for (const cell of r.cells || []) {
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
 * 把一次 tx 的 ops 在**内存里**应用到一个 obs 上，返回新的 obs（不改原对象）。
 *
 * 用途只有一个：写盘**之前**算一遍「这一步会让世界变好还是变坏」。
 * 所以它只需要**够准到能算健康度**：实体表 + region。
 *
 * 三条刻意的简化（都不影响 health 的判据）：
 *   · 新实体的 uid 从「当前最大值 +1」递增 —— health 只数个数与连通性，不看具体 uid；
 *   · 带子的 `rotationVariant` 从 op 原样搬（planToTxOps 已经算好）；
 *   · 不模拟游戏里的「按邻居重算 rv」—— 那正是 `tx` 要开 `runGuarded` 的原因，
 *     而 health 的连通判据读的是 op 给的 rv，与写盘后的形态一致。
 *
 * @param {object} obs   当前 obs（`entities` 数组）
 * @param {Array} ops    `txPlan.ops`
 * @returns {object|null} 新的 obs；ops 形态不认识时返回 null（调用方据此跳过预演）
 */
export function applyTxOpsToObs(obs, ops) {
    if (!obs || !Array.isArray(obs.entities) || !Array.isArray(ops)) return null;
    const del = new Set();
    for (const op of ops) if (op && op.op === "delete" && isInt(op.uid)) del.add(op.uid);
    const entities = obs.entities.filter(e => e && !del.has(e.uid));
    let next = 1 + Math.max(0, ...entities.map(e => (isInt(e.uid) ? e.uid : 0)));
    for (const op of ops) {
        if (!op || op.op !== "place") continue;
        if (typeof op.building !== "string" || !isInt(op.x) || !isInt(op.y)) return null;
        entities.push({
            uid: next++,
            type: op.building,
            variant: "default",
            x: op.x, y: op.y,
            r: isInt(op.r) ? op.r : 0,
            rotation_variant: isInt(op.rotationVariant) ? op.rotationVariant : 0,
        });
    }
    return { ...obs, entities, entity_count: entities.length };
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
export function buildTxPlan(llmPlan, obs, items, handles, opts = {}) {
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
    /* ★ 「同一批里还有谁要把这个喂料格接上」★
     *
     * 真机 r-20261112210803-e1a3（第 9 关）：模型**同时**提交了两条
     *   connect {M2 → C7:color0, rebind} + connect {M3 → C7:color1, rebind}
     * —— 完全正确的做法（我的 hint 就是这么教的）。
     *
     * 但它们逐条独立规划，每条都看到「另一条槽的喂料格上还压着旧线」，
     * 于是 auto_relax 的守卫把**两条都拒了** —— 接 A 会穿 B、接 B 会穿 A，
     * 形成死锁。
     *
     * 而在这个批次里，那个「别人的喂料格」**本来就会被同一个 tx 重新接上**。
     * 所以先把这批调用要接的槽格算出来传给智能宏：被覆盖的格子若在这份名单里，
     * 就不算「拆掉别人的产线」。
     *
     * 只传目标机器的槽格（feed cell），不是整个 footprint ——
     * 判据要窄，宁可不豁免。 */
    const scratchFeedCells = (() => {
        const out = [];
        /* ⚠️ 不能用 `partialMode` —— 它在下面才定义（TDZ）。
           这里直接读 opts，语义相同：豁免只在「可能会部分执行」时才有意义。 */
        if (!(opts && opts.partial === true)) return out;
        for (const c of res.calls) {
            if (c.macro !== "connect") continue;
            const to = c.args && c.args.to;
            const uid = to && (typeof to.uid === "number" ? to.uid
                : (to.ref && handles && handles.byHandle && handles.byHandle.get(String(to.ref))
                    ? handles.byHandle.get(String(to.ref)).uid : null));
            if (!Number.isInteger(uid)) continue;
            const m = (o.entities || []).find(e => e && e.uid === uid);
            if (!m || m.type === "belt" || m.type === "underground_belt") continue;
            let slots = null;
            try {
                slots = slotsOf(m.type, m.variant || "default", m.x, m.y, m.r || 0, beltRvOf(m));
            } catch { continue; }
            for (const sl of (slots && slots.inputs) || []) {
                if (Array.isArray(sl.cell)) out.push(sl.cell);
            }
        }
        return out;
    })();
    /* partial 模式下收集失败（见 ③b）；非 partial 模式恒为空。 */
    const macroFailures = [];
    /* ★ 累积世界：后面的调用要看见前面已经铺好的带子 ★
     *
     * 真机 r-20261112210803-e1a3（第 9 关）：模型同时提交
     *   connect {M2 → C7:color0} + connect {M3 → C7:color1}
     * 两条路径命中了 5 个相同的格子 —— 因为**都按原始世界规划**，
     * 各自都不知道对方已经把那段铺掉了。落盘时 `R5: 同一格被两个 place 命中`。
     *
     * 「合并重叠路径」不是正解：M2 那条要走的 `(35,-12)` 正是 slot1 的喂料格，
     * 两条线**在拓扑上就是互斥的**。真正的解法是让第二条**看见**第一条，
     * 于是它自然会绕开或改用别的接法。
     *
     * 所以这里维护一份「到目前为止的世界」：每条成功的调用把它新增/删除的
     * 实体应用进去，下一条宏读到的是更新后的版本。
     *
     * 只对 connect/extend_line（纯铺带）生效 —— 那是唯一会大面积新增格子、
     * 且 `planToTxOps` 无法事后合并的宏。其它宏保持原样（它们产出机器/删除，
     * 合并不适用，也不该让它们看见半成品状态）。 */
    /* ⚠️ **必须逐个浅拷贝元素**，不能只 `.slice()` 数组。
     *
     * `.slice()` 只复制了数组本身，元素对象仍然是调用方 `o.entities` 里的**同一批对象**。
     * 而下面 `have.r = rot; have.rotation_variant = rv; have.code = code;`
     * 是**原地改写** —— 它会直接改掉调用方的 obs。
     *
     * 后果（红队实测，2026-11-13）：`buildTxPlan` 在预演闸门里取
     * `before = worldHealth({ obs: o })`，而 `o` 已经被前面的宏调用改写过了 ⇒
     * 基准失真 ⇒ 算出来的 `loss` / `deadGrowth` 连**符号都是反的**。
     * 实测某条 connect：真实是 `-76 可达带子 / +96 死带子`（两条阈值都该拦），
     * 闸门看到的是 `loss=-24 / deadGrowth=-4`（「改善」）⇒ 放行。
     *
     * 这条 bug 比它掩盖的那个更老（追到 `cbba883`），但它让「预演闸门」
     * 对**所有**改了朝向的 connect 都失去意义 —— 因为 `worldSoFar` 只在
     * connect / extend_line 之后更新，而那正是闸门最该拦住的两类宏。 */
    let worldSoFar = { entities: (o.entities || []).map(e => (e && typeof e === "object" ? { ...e } : e)) };
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
            r = fn(c.args, {
                entities: worldSoFar.entities,
                /* 同批里会被本 tx 重新接上的喂料格 —— 见上面 scratchFeedCells 的注释。
                   智能宏用它判断「覆盖这格算不算拆别人产线」。 */
                ...(scratchFeedCells.length ? { scratch_feed_cells: scratchFeedCells } : {}),
            });
        } catch (e) {
            return reject("INTERNAL", {
                layer: "plan", stage: "macro",
                expected: `${c.macro} 正常返回`, observed: `抛异常：${e && e.message ? e.message : e}`,
                evidence: { index: i, macro: c.macro },
            });
        }
        if (!r || r.ok !== true) {
            const e = (r && r.error) || {};
            /* ★ partial 模式：失败不立刻拒，记下来继续跑后面的 ★
             *
             * 「部分执行」的前提是知道**哪些能成**。如果第一个失败就 return，
             * 后面那 3 个本来能成的调用永远不会被尝试 —— 那就不是部分执行了。
             *
             * 只收集失败，继续循环。循环结束后由 ③b 决定提交哪些。
             * 非 partial 模式完全走原来的路径（立刻 reject），行为不变。 */
            if (opts && opts.partial === true) {
                macroFailures.push({
                    index: i, macro: c.macro,
                    code: e.code || null,
                    hint: e.hint || null,
                    message: e.message || (r && r.reason) || null,
                    /* ★ 宏的 `candidates` 必须带出来 ★
                     *
                     * 真机（第 9 关 r-20261112151848-86fe，2026-11-12）：
                     * 模型连 2 轮写 `connect to:{ref:"C7", port:"color"}`，
                     * 而 mixer 两个 color 槽的 role **都叫 color** ⇒ `ambiguous_port`。
                     *
                     * `connect` 其实在错误里算好了 `candidates: [{role,index,cell}…]` ——
                     * 那正是模型需要的消歧信息（它该写 `{role:"color", index:0}`）。
                     * 但这里只保留了 code/hint/message，**candidates 被丢掉**，
                     * 于是模型看到的只有「ambiguous_port」六个字，只能猜。
                     *
                     * 这类「宏已经算出答案、却没送到决策者眼前」的缺口在
                     * `macro-warnings-never-reached-prompt` 里记过一次，这是同一类。 */
                    candidates: Array.isArray(e.candidates) ? e.candidates : null,
                });
                continue;
            }
            /* ★ 2026-11-02：`observed` 里带上「第几个调用失败 / 共几个」 ★
             *
             * 原来只说「connect 返回 ok:false（occupied: …）」。模型不知道：
             *   · 这是 5 个调用里的第几个
             *   · 其它几个本来能不能行
             *   · 该把失败的删掉重试，还是整批换
             *
             * 实测（`FIVE-ROUNDS-FINAL.md`）：`calls≥4` 时执行率 **0/82**。
             * 全有或全无 + 不知道哪个坏了 ⇒ 模型只能整批重写，而重写又引入新错误。
             *
             * 这条**不改原子性**，只是让拒绝信息能定位。零风险。
             * 就算永远不做部分执行，这条也该有 —— 它让「重试」有的放矢。 */
            const totalCalls = Array.isArray(res.calls) ? res.calls.length : 1;
            const others = (Array.isArray(res.calls) ? res.calls : [])
                .map((c2, j) => ({ j, m: c2 && c2.macro }))
                .filter(x => x.j !== i)
                .map(x => `#${x.j + 1} ${x.m}`);
            return reject("MACRO_REFUSED", {
                layer: "plan", stage: "macro",
                expected: `${c.macro} 返回 ok:true`,
                observed: `${e.code || "?"}: ${e.message || (r && r.reason) || "无 message"}`
                    + ` [call ${i + 1}/${totalCalls}`
                    + (others.length ? `；其余 ${others.join("、")} 也一条 op 都没生成（原子性）` : "")
                    + `]`,
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
                    /* ★ 2026-11-02：把「第几个 / 共几个」**结构化**，别只写在 observed 字符串里 ★
                     *
                     * 红队（`REDTEAM-PARTIAL-APPLY.md` §Q4.1）指出：
                     * `observed` 里已经写了 `[call N/M]`，但那是**字符串**，
                     * 下游要拿它得解析 —— 而 `failures` 那边又不知道第几个失败的，
                     * 只好把同一个 hint 复制给每个宏（那是我引入的一个真 bug）。
                     *
                     * 结构化之后：`failures` 能只给**真正失败的那个**宏挂 hint，
                     * 其余的标 `unverified`（它们根本没被检验，不是「也失败了」）。 */
                    call_index: i,
                    call_total: Array.isArray(res.calls) ? res.calls.length : 1,
                },
                hint: e.hint || null,
                /* ★ `blocked_by_machine` ⇒ 把 remove_machine 排到最前 ★
                 *
                 * 真机实测（2026-11-03）：`insert_machine` 在「那格被一台无矿矿机占着」
                 * 时只会说 blocked_by_machine，而模型接着试 connect（被 trash 挡死）、
                 * 再试 insert_machine（还是 blocked）—— 三轮全废。
                 *
                 * 候选列表原来恒为那 6 个，`remove_machine` 压根不在里面，
                 * 所以模型**从来看不到**唯一能解这一步的宏。 */
                candidates: (e.code === "blocked_by_machine")
                    ? ["remove_machine", "replace_run", "insert_machine", "connect", "remove_run", "trash_unused"]
                    : ["connect", "remove_run", "insert_machine", "trash_unused", "replace_run", "extend_line"],
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
        executed.push({
            macro: c.macro, args: c.args, provenance: c.provenance, result: r,
            /* 这条调用**执行时**看到的世界（`worldSoFar` 的快照）。
               下游的单条翻译必须用它，而不是原始 obs —— 见 ③b 那段注释。
               ⚠️ 存副本：`worldSoFar` 后面会被整体换掉，存引用会读到之后的状态。 */
            worldBefore: { entities: worldSoFar.entities.slice() },
        });
        /* 累积世界：把这条 connect/extend_line 铺出来的格子并进 `worldSoFar`，
           让**下一条**宏看见它（见 worldSoFar 的注释）。
           ⚠️ 只处理「新增带子」这一种效果 —— 那是这里唯一会跟后续调用撞格的操作。
           被覆盖的旧带子也要从世界里删掉，否则下一条会以为那格还占着。 */
        if ((c.macro === "connect" || c.macro === "extend_line")
            && Array.isArray(r.cells) && r.cells.length) {
            const gone = new Set((r.changed && Array.isArray(r.changed.removed_uids))
                ? r.changed.removed_uids : []);
            /* ★ 复用原 uid，不要「删了再新建」★
             *
             * 第一版把 `gone` 里的实体删掉、再给新格子编 90000+ 号，
             * 结果下游 `R7: destroys 里的 uid=12085 不在当前 obs 里` ——
             * 因为宏报的 `removed_uids` 指的是**原来那几条带子**，
             * 而累积世界里它们的 uid 已经被我换掉了。
             *
             * 实际情形是「同一格换了个朝向」：带子还是那条带子。
             * 所以就地改 `r` / `rotation_variant` / `code`，uid 保持不变。 */
            const byCell = new Map();
            for (const e of worldSoFar.entities) {
                if (e && Number.isInteger(e.x) && Number.isInteger(e.y)) {
                    byCell.set(`${e.x},${e.y}`, e);
                }
            }
            const added = [];
            let ghost = -1;
            for (const c2 of r.cells) {
                if (!Number.isInteger(c2.x) || !Number.isInteger(c2.y)) continue;
                const k = `${c2.x},${c2.y}`;
                const rv = Number.isInteger(c2.rotationVariant) ? c2.rotationVariant : 0;
                const rot = Number.isInteger(c2.rotation) ? c2.rotation : 0;
                const code = Number.isInteger(c2.code) ? c2.code : 1;
                const have = byCell.get(k);
                if (have) {
                    have.r = rot; have.rotation_variant = rv; have.code = code;
                } else {
                    added.push({
                        uid: ghost--,          // 负数：本批内的临时号，绝不会与真实 uid 冲突
                        type: "belt", x: c2.x, y: c2.y,
                        r: rot, rotation_variant: rv, variant: "default", code,
                        layer: "regular",
                    });
                }
            }
            worldSoFar = { entities: [...worldSoFar.entities, ...added] };
        }
    }

    /* ③b ★ 部分执行（partial）：只留「成功 **且** 产物可撤销」的调用 ★
     *
     * ## 为什么是「可撤销」而不只是「成功」
     *
     * 红队（`REDTEAM-PARTIAL-APPLY.md`）用实测证明「提交全部成功子集」会假绿：
     *
     *   · 52% 的样本里「成功的那一半」是 `trash_unused` —— 它把 `DEAD_END` 的出口封死，
     *     症状消失但问题没解决
     *   · **trash / 机器一旦落盘不可撤销**：`remove_run` 只处理带子
     *     （`remove.mjs`「选集里有 N 个非带子实体（整单拒绝）」），
     *     6 个宏里没有一个能删机器
     *   · 提交全部成功子集 = 88 次不可逆写入，而只有 45% 是真目标动作
     *
     * 我测了按「产物可撤销」筛选的变体（`.tmpverify/redteam-partial/reversible.mjs`，177 条）：
     *
     *   A 全有或全无   提交 3.4%   目标动作  6   不可逆  5
     *   B 全部成功子集 提交 71.8%  目标动作 57   不可逆 88   ← 红队否掉的
     *   **E 可撤销子集 提交 30.5%  目标动作 54   不可逆  0**  ← 这个
     *
     * E 的提交率不如 B，但**目标动作密度 100%**（54/54 全是真目标动作），
     * 而且**一次不可逆都没有**。拿 41 个百分点的提交率换 88 次不可逆写入，
     * 这个交换是对的。
     *
     * ## 判据：看**产物**，不看宏名
     *
     * 一个调用可撤销 ⇔ 它产生的所有 op 都是「place 带子」或「delete 带子」。
     * 这两类都能用 `remove_run` / `place` 复原。机器和垃圾桶不能。
     *
     * 这个判据从**宏的真实返回值**推，不猜 —— 所以 `replace_run` 的 belt 模式
     * 自动算可撤销、机器模式自动算不可逆，不需要一张「宏名 → 可撤销」的表。
     *
     * ## 默认关闭
     *
     * `opts.partial !== true` 时完全走原来的「全有或全无」路径。
     * 这不是渐进开关，是**两套语义**：现有 336 条测试全部断言前者。
     */
    const partialMode = !!(opts && opts.partial === true);
    /* 被跳过的调用明细（partial 模式之外恒为空）。
       宏失败的先放进来 —— 它们是被跳过的第一批。 */
    const skippedAll = macroFailures.map(f => ({
        macro: f.macro, reason: "macro_failed", code: f.code, hint: f.hint,
        /* 宏算出的候选（`ambiguous_port` 的 `{role,index}` 就在这里）——
           一路带到 diagnose.evidence → prompt 的 "previous failures"。 */
        ...(Array.isArray(f.candidates) ? { candidates: f.candidates } : {}),
    }));
    /* ★ 2026-11-02 修：筛选条件不能再带 `executed.length < res.calls.length` ★
     *
     * 上一版写的是 `if (partialMode && executed.length < res.calls.length)` ——
     * 「只有存在失败调用时才筛可撤销性」。
     *
     * 那有个真漏洞（A/B 实测抓到，`.tmpverify/live-multiround/ab-partial.mjs`）：
     * 一个**全部成功**的计划（比如单条 `insert_machine`）会跳过筛选 ⇒
     * 直接提交 `place:cutter` ⇒ **不可逆写入**，而 `partial` 标记还是 false。
     *
     * 实测：真机 level 5 跑 `insert_machine`，`partial:false`、`skipped:[]`、
     * ops=`delete:, place:cutter` —— 按可撤销判据是 `false`，但它被提交了。
     *
     * 「可撤销」是**这个模式的硬约束**，与「有没有失败调用」无关：
     *   · 有失败 ⇒ 跳过失败的 + 跳过不可撤销的
     *   · 全成功 ⇒ 仍然要跳过不可撤销的（它们落盘就撤不回来）
     *
     * 所以条件只剩 `partialMode`。 */
    if (partialMode) {
        const reversible = [];
        /* ⚠️ 这里的 `skipped` 是**局部的**（只装「不可撤销」那批），
         * 最后**不直接**写进 `skippedAll` —— 因为 (a) 分支要把它整个回滚。
         * 之前直接往 `skippedAll` push，导致「全成功但都不可撤销」时
         * `skippedAll.length > 0` ⇒ `partial` 被算成 true ⇒ 完整执行被标成部分执行。 */
        const skippedLocal = [];
        for (let i = 0; i < executed.length; i++) {
            const ex = executed[i];
            /* 单条翻译，看它产生什么 op。`planToTxOps` 对单条调用的开销很小，
               而且这一步**不落盘**，只是推演。
             *
             * ★ 必须用**这条执行时的世界**，不是原始 obs ★
             *
             * 真机 r-20261112210803-e1a3：模型同时提交两条 connect，
             * 第二条在主循环里看见了第一条铺好的带子（`worldSoFar`），
             * 于是它规划出「复用 (35,-12) 并把它改成 corner」——
             * 但单条翻译这里用**原始 obs**，`(35,-12)` 还没带子，
             * 于是判成 `not_translatable ops:0` ⇒ **静默丢掉第二条**。
             * 结果 `ok:true`、只落了一条，模型完全不知道另一半没执行。
             *
             * `ex.worldBefore` 由主循环记录（见那里的注释）。 */
            const soloObs = ex.worldBefore || o;
            const solo = planToTxOps([ex], { obs: soloObs, items, namedUids: collectNamedUids([ex], soloObs, handles) });
            const ops = (solo && solo.ok === true) ? solo.ops : null;
            /* 「可撤销」= 产物能靠 `remove_run` 删回去。
             *
             * ★ 机器也放行，`trash` 除外（2026-11-20）★
             *
             * 按 `REVERSIBLE_BUILDINGS` 的原判据，放机器一律算不可撤销 ⇒ 一律跳过。
             * 真机 `r-20261120191053-fe5d` 证明那是错的：模型对 `ORE_UNMINED` 的反应
             * 完全正确 —— `insert_machine {at:{$ore:"Cu"}, facing:right, machine:"miner"}`，
             * 正是诊断 hint 让它做的。然后 `skipped: [{macro:"insert_machine",
             * reason:"irreversible"}]`，**静默跳过，世界一件没变**。
             *
             * 而 L12 需要的两件事（放矿机挖圆形矿、放 stacker 做并联）全是放机器。
             *
             * ## 为什么 `trash` 仍然要拦
             *
             * 556 个 run 的 plan 事件里 `irreversible` 跳过 303 次，分布：
             * `trash_unused` **41** / `insert_machine` 13 / `connect` 3。
             *
             * `trash` 被拦是对的：它封死出口止损，对造出目标形状零贡献，
             * 而封掉的 DEAD_END 出口事后很难发现（`REDTEAM-PARTIAL-APPLY.md`：
             * 88 次不可逆写入里只有 45% 是真目标动作）。
             *
             * ## 「放行」不等于「回滚得了」
             *
             * 机器仍然撤销不了（`remove_run` 不收非带子）。这里放弃的是
             * **「这一轮保证可回滚」这条性质**，换来的是「必需的动作能执行」。
             * 代价由既有的后验路径兜：`classifyNetEffect` 判 `regressive` 时
             * 仍会触发回滚（带子部分），机器留在原地但会被 `ORPHAN_MACHINES`
             * 在下一轮点出来。 */
            const IRREVERSIBLE_PLACE = new Set(["trash"]);
            const rev = Array.isArray(ops) && ops.length > 0 && ops.every(op =>
                (op.op === "delete")
                || (op.op === "place" && !IRREVERSIBLE_PLACE.has(String(op.building))));
            if (rev) reversible.push(ex);
            else {
                skippedLocal.push({
                    macro: ex.macro,
                    reason: ops ? "irreversible" : "not_translatable",
                    ops: ops ? ops.length : 0,
                });
            }
        }
        if (reversible.length) {
            executed.length = 0;
            executed.push(...reversible);
            /* 只有真的跳过了东西，才把它们记进 skippedAll（会影响 partial 标记）。 */
            skippedAll.push(...skippedLocal);
        } else {
            /* 一条可撤销的都没有 —— 分两种情况，处理方式**不同**：
             *
             * (a) **全部调用都成功**，只是产物都不可撤销（典型：单条 `insert_machine`）
             *     ⇒ **退回「全有或全无」**：提交全部，`partial:false`。
             *
             *     理由：这个计划是**完整**的 —— 模型就是想加一台机器，而那台机器
             *     确实能加上。「不可撤销」并不使这个计划变错，只意味着
             *     *如果后续出问题* 不能靠 remove_run 撤回。
             *
             *     ⚠️ 如果这里直接拒，模型就**永远无法加机器** —— 那比
             *     「加了撤不回来」严重得多。而 `insert_machine` 是产能修复的主力宏。
             *
             * (b) **有调用失败，剩下的都不可撤销**
             *     ⇒ 拒绝（`NO_REVERSIBLE_CALL`）。因为提交一个「不完整且不可撤销」
             *     的子集，既没达成计划、又撤不回来 —— 那是最糟的组合。
             *
             * 这个区分是 A/B 实测逼出来的（`.tmpverify/live-multiround/ab-partial.mjs`）：
             * 真机 level 5 的 round 1 是单条 `insert_machine`，全部成功但我上一版
             * 因为它不可撤销就拒了 —— 而那正是模型唯一能做的修法。 */
            const anyFailed = macroFailures.length > 0;
            if (!anyFailed) {
                /* (a) 全部成功：完整提交，不算 partial。
                   `executed` 原样保留（上面没动过它）。 */
            } else {
                /* (b) 有失败：拒绝。
                 *
                 * ⚠️ `evidence.skipped` 必须**同时**含两类：
                 *   · `macro_failed`（宏自己失败的）
                 *   · `irreversible`（宏成功但产物不可撤销的，在 `skippedLocal` 里）
                 *
                 * 上一版只用了 `skippedAll`，而它那时还没装 `skippedLocal`
                 * （那批只在 `reversible.length > 0` 的分支才 push）——
                 * 于是诊断里只有 `macro_failed`，模型不知道那些成功的也不能用。
                 * 实测被 `partial_apply.test.mjs` P4 抓到。 */
                const allSkipped = [...skippedAll, ...skippedLocal];
                /* ★ 真正的失败原因必须出现在 observed 里 ★
                 *
                 * 实测（90 轮 42 次被拒，全部同一个顶层码）：`observed` 只写
                 * 「connect:macro_failed ×3」，而**每一层下面是什么错误**被藏住了。
                 * 那次统计里真正的原因是 `ambiguous_port` 37 次、`port_already_bound` 35 次、
                 * `to_port_on_source` 12 次 —— 全是端口绑定问题，与「可撤销」无关。
                 *
                 * 模型拿到的 `NO_REVERSIBLE_CALL` + hint「换一条只涉及带子的修法」
                 * 于是理解成「再多试几次 connect」，正是同一个死循环。
                 * 把嵌套码摊到 observed 里，至少让它知道自己在撞什么。 */
                const nested = allSkipped
                    .map(s => s.code ? `${s.macro}:${s.code}` : `${s.macro}:${s.reason}`)
                    .join(", ");
                return reject("NO_REVERSIBLE_CALL", {
                    layer: "plan", stage: "partial",
                    expected: "至少一条产物可撤销的调用",
                    observed: `${res.calls.length} 个调用里 0 条可撤销（${nested}）`,
                    evidence: { skipped: allSkipped },
                    hint: (() => {
                        /* 按嵌套码分派处置 —— 端口问题有端口问题的解法，
                         * 跟「不可撤销」是两件事。 */
                        const codes = new Set(allSkipped.map(s => s.code).filter(Boolean));
                        if (codes.has("ambiguous_port")) {
                            return "**这不是「不可撤销」的问题，是端口没绑上。** "
                                + "`ambiguous_port` 的意思是那台机器在那一端有多个槽，必须写明是哪一个："
                                + "`port:{role:\"<角色>\",index:<第几个>}`。"
                                + "每条返回里 `candidates` 列了全部可选值，照抄其中一个即可。"
                                + "**下一次只提交一个调用**，把端口写全，确认它落地再做下一条。";
                        }
                        if (codes.has("port_already_bound")) {
                            return "**这不是「不可撤销」的问题，是那个端口已经被占。** "
                                + "按这个顺序试：① 同一台机器的另一个 ejector；"
                                + "② 两个都满就**换一台同类机器做源头**（世界里往往有空着口的）；"
                                + "③ 才考虑 `opts.rebind=true`（会让旧支路断流）。"
                                + "**下一次只提交一个调用。**";
                        }
                        if (codes.has("to_port_on_source")) {
                            return "**这不是「不可撤销」的问题：你把终端接到了源机器自己身上** —— "
                                + "那条带的输入端就长在源机器上，货会绕回起点。换一个更远的目标。";
                        }
                        return "这些调用只能放机器/垃圾桶，没有一条能靠 remove_run 撤销。"
                            + "换一条只涉及带子的修法（connect / extend_line / replace_run 的 belt 模式）。"
                            + "**下一次只提交一个调用**：两条一起提，任何一条失败都会让整个计划作废"
                            + "（因为剩下的撤不回来）。先做成一条、确认它落地，下一轮再做第二条。";
                    })(),
                });
            }
        }
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
    /* 传 `executed` 而不是 `res.calls`：只有前者带 `result`，而后者的
       `removed_uids` 是「宏按自己语义算出的删除」的唯一来源（见 collectNamedUids ③）。 */
    const namedUids = collectNamedUids(executed, o, handles);
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

    /* ⑤c ★ 执行前的净效果预演：把 ops 在内存里应用一遍，先算世界会变好还是变坏 ★
     *
     * ## 为什么需要（第 9 关实测的连续退化）
     *
     * `classifyNetEffect` 一直能判 `regressive`，但那是**事后**——世界已经被改了。
     * 第 9 关有一轮里，模型两次 `connect {allow_replace:true}` 覆盖了正在工作的带子，
     * 到 hub 的带子 320 → 254、死带子 184 → 282。判定层如实判了 regressive 并回滚，
     * 但那一轮的两步都是白做的；更糟的是模型**看不到自己那一步的代价**，
     * 下一轮接着用同样的写法。
     *
     * `applyToWorld` 的语义就是「把宏结果折进世界」，而 `worldHealth` 接受任意
     * obs —— 两者加起来就能在**写盘前**回答「这一步会让世界变好还是变坏」。
     *
     * ## 什么情况拒
     *
     * 只在**明显变坏**时拒。判据取自两个量，任一成立就拦：
     *
     *   · `belts_reaching_hub` 掉了超过 **25%**（相对损失）—— 第 9 关那条
     *     `connect{B124→C7, allow_replace}` 实测是 320 → 286（-11%），
     *     已经吃掉三分之一的可达带子；再松一点就拦不住了。
     *   · 或者**净掉 20 格以上**（绝对损失）—— 小世界（L4 只有 161 条带子）
     *     掉 20 格等于掉了八分之一，那也是明显变坏。
     *
     * ⚠️ 第一版写的是 `loss > txPlan.ops.length`（「掉得比 op 数还多才拦」）——
     * 那个阈值方向反了：一条 op 杀掉几十格连通性正是**常态**（覆盖一格能让整条分支
     * 断掉），而 op 数多的调用反而更难触发。实测那条 B124→C7 有 54 条 op、
     * 掉了 34 格 ⇒ 34 > 54 不成立 ⇒ 放行。判据必须看**世界损失**，不是 op 数。
     *
     * 这条阈值刻意留了余量：施工本来就会临时减少可达带子（`rollback.mjs` 的文件头
     * 写明了这一点）。要拦的是「几十条带子一起掉」，不是「少一两格」。
     *
     * 拒了之后把两侧的数字都交给模型 —— 它需要知道代价，而不是只收到一个 `no`。 */
    if (o && Array.isArray(o.entities) && txPlan.ops.length) {
        try {
            /* `buildTxPlan` 是纯函数，拿不到 `runLoop` 的 `curGoal`。
               目标从 obs 读（`goal.requirement.shape`），并允许调用方用
               `opts.goalShape` 覆盖 —— 换关那一轮两者会短暂不同。 */
            const simGoal = (typeof opts.goalShape === "string" && opts.goalShape)
                ? opts.goalShape
                : ((o.goal && o.goal.requirement && o.goal.requirement.shape) || null);
            const before = worldHealth({ obs: o, items, goalShape: simGoal });
            const afterObs = applyTxOpsToObs(o, txPlan.ops);
            /* ⚠️ 预演后的世界**没有**对应的 debug_items（`applyTxOpsToObs` 只改实体表），
               所以 `after` 只能拿几何口径。下面的判据据此只在**两边都可判定**时
               才启用类型口径 —— 不拿一边的类型数去减另一边的几何数。 */
            const after = afterObs ? worldHealth({ obs: afterObs, items: null, goalShape: simGoal }) : null;
            if (after && Number.isInteger(before.belts_reaching_hub) && Number.isInteger(after.belts_reaching_hub)) {
                const loss = before.belts_reaching_hub - after.belts_reaching_hub;
                const pct = before.belts_reaching_hub > 0 ? loss / before.belts_reaching_hub : 0;
                /* ★ 判据用**损失规模**，不用调用类型 ★
                 *
                 * 第一版按「本次调用有没有 `allow_replace` / `rebind` / `trash_unused`」
                 * 判定 risky。实测（2026-11-12 r-20261112095123-1134）漏掉了一次灾难：
                 *
                 *   r5  `connect(M15 → B207)` —— **不带** allow_replace
                 *       到 hub 的带子 246 → 186（-60），死带子 289 → 396（+107）
                 *
                 * `connect` 即使不覆盖带子，只要把货从原路径改走，下游整片就断了
                 * （`rebind` 的隐式效果）。类型判据拦不住它。
                 *
                 * 为什么原先要按类型分：`insert_machine` 放一台 cutter 到带子上，
                 * 会临时切断经过它的分支 —— L4 上那是**正解的第一步**（P0/P13 回归）。
                 *
                 * 但那个场景的损失是**一两条带子**，和这里的 60 条不是一个量级。
                 * 用规模区分就够了，不必猜调用方意图：
                 *   · 绝对损失 ≥20 格 —— 无论什么宏都拦（施工不会一次切掉 20 条）
                 *   · 或相对损失 ≥25% 且 ≥5 格 —— 小世界里的等比例破坏
                 *
                 * 保留 `risky` 只为**放宽**：`allow_replace` 类调用本来就会删带子，
                 * 给它更高的容忍阈值没有意义 —— 所以现在两者用同一条线。 */
                const risky = executed.some(c => {
                    const a = (c && c.args) || {};
                    const op = (a.opts && typeof a.opts === "object") ? a.opts : {};
                    if (op.allow_replace === true || op.rebind === true) return true;
                    if (c.macro === "trash_unused") return true;
                    return false;
                });
                void risky;
                /* ★ 损失只按「**可交付**」口径算，别用几何口径 ★
                 *
                 * `belts_reaching_hub` 是纯几何的：hub 的 16 个入口全是
                 * `filter:"shape"`（游戏源码 `MetaHubBuilding._setupEntityComponent`），
                 * 一条几何上通到 hub、末端却运颜料的带子**物理上永远交付不了**。
                 * 删它不该算「拆掉产能」。
                 *
                 * 实测（2026-11-18 L12）：模型提出删掉 4 条送颜料的 hub 入口带，
                 * 预演报「到 hub 的带子 543 → 390」拒了 9 次。而那 153 条「损失」
                 * **全是颜料**，真正能交付的产能一条没少（可交付数 390 → 390）。
                 *
                 * ## 前两版的错误（都记下来，免得再犯）
                 *
                 * 第一版：只看 `deliv < geo * 0.5` 这个静态比例。但本世界可交付占
                 * 71.8%，条件恒假 —— 那段代码**永远不可能生效**。
                 *
                 * 第二版：比 `after.belts_reaching_hub >= before.belts_deliverable`。
                 * **拿几何数比类型数**，这是两个口径。反例：删一条运形状的带子
                 * （B611，运 `ScSc----`）时，390 ≥ 390 也成立，而真实可交付损失是 153。
                 * 数字碰巧相等是因为间隙（153）恰好等于那个子图的规模。
                 *
                 * ## 正确做法
                 *
                 * 把删除的实体从 obs 里剪掉，用**同一份 items** 重跑类型闭包 ——
                 * 两个数就都是可交付口径了，可以直接比。
                 *   · 4 条颜料入口带：390 → 390（损失 0，放行，正确）
                 *   · B611（运形状）：  390 → 237（损失 153，拦住，正确）
                 *
                 * ⚠️ `applyTxOpsToObs` 不更新 items（货物位置会变），所以不能用它
                 * 算类型口径。这里只用 `txPlan.ops` 里的 delete 覆盖的 uid 做剪枝。
                 * 如果这一步有 place，新带子上还没有货，剪枝后重算依然一致。 */
                let deliverableLoss = null;
                try {
                    const delivBefore = Number.isInteger(before.belts_deliverable)
                        ? before.belts_deliverable : null;
                    if (delivBefore !== null && items) {
                        const deletedUids = new Set();
                        for (const op of txPlan.ops) {
                            if (op && op.op === "delete" && Number.isInteger(op.uid)) deletedUids.add(op.uid);
                            if (op && op.op === "bulk_delete" && Array.isArray(op.uids)) {
                                for (const u of op.uids) if (Number.isInteger(u)) deletedUids.add(u);
                            }
                        }
                        if (deletedUids.size) {
                            const pruned = { ...o, entities: o.entities.filter(e => e && !deletedUids.has(e.uid)) };
                            const typedAfter = flowReachable(pruned, buildIndex(pruned), { itemsDoc: items });
                            const prunedBelts = pruned.entities.filter(e => isBelt(e) || e.type === "underground_belt");
                            const delivAfter = prunedBelts.filter(b => typedAfter.has(b.uid)).length;
                            deliverableLoss = Math.max(0, delivBefore - delivAfter);
                        }
                    }
                } catch { deliverableLoss = null; }

                const deliv = Number.isInteger(before.belts_deliverable)
                    ? before.belts_deliverable : null;
                const geo = Number.isInteger(before.belts_reaching_hub) ? before.belts_reaching_hub : 0;
                /* 有可交付口径就用它；算不出来才退回几何口径（老行为）。 */
                const effectiveLoss = deliverableLoss !== null ? deliverableLoss : loss;
                const effectiveBase = deliverableLoss !== null ? (deliv || 0) : geo;
                const effectivePct = effectiveBase > 0 ? effectiveLoss / effectiveBase : 0;
                const mostlyUndeliverable = false;   // 静态比例判据已废弃（见上）
                /* ★ `loss` 可以是负数，而负数不是损失 ★
                 *
                 * 2026-11-20 真 LLM 实测（`r-20261120114323-f14c` r1）：
                 * 模型提议 `replace_run` + `connect`，预演显示
                 * **到 hub 的带子 390 → 391（+1）**，也就是这一步让世界变好了。
                 * 而它被判成「会让世界明显变差」并**在写盘前拦下**。
                 *
                 * 两个独立的错：
                 *   ① `loss = before - after` 在变好时是负数，而下面只判 `>= 20`，
                 *      所以负数是靠 `deliverableLoss` 恰好为 0 才没触发 —— 运气。
                 *   ② 提示文案写的是 `（-${loss}，${pct}%）` —— loss=-1 时
                 *      渲染成 **`--1`**，并且说「那 N 格背后挂着 -1 条到 hub 的带子」。
                 *      模型读到的是一句自我矛盾的话。
                 *
                 * 这里把损失夹到非负：**「没损失」就是 0，不是负增益计入损失**。 */
                const lossClamped = Math.max(0, effectiveLoss);
                const tooMuch = lossClamped >= 20 || (lossClamped >= 5 && effectivePct >= 0.25);
                /* ★ 「加了一堆死带子」也是改坏 ★
                 *
                 * 真机 r-20261112190707-de26（第 9 关）：模型完全按 hint 执行
                 * `connect {from:M3, to:B57}` —— 铺了 57 格，砍掉 4 格。
                 * 到 hub 的带子**一条没少**（这条判据放行），但死带子 394→447。
                 *
                 * 上面那条 `loss` 只看「现有的带子有没有被切掉」，
                 * 而这里新增的 57 格**全都通不到 hub** —— 它把世界改坏了，
                 * 只不过坏在「多」而不是「少」。
                 *
                 * 判据与上面同构，只是看另一个方向：死带子**净增** ≥20 格。
                 * 施工确实会临时产生死带子（新铺的一段在接上源头前都是死的），
                 * 所以门槛不设低 —— 一条 57 格的盲目铺线才是要拦的形态。 */
                const deadGrowth = (after.belts_dead - before.belts_dead);
                /* ★ 例外：新铺的线**接上了一台真实机器** ⇒ 不算「白铺」★
                 *
                 * 判据的本意是拦「盲目铺一条不知道通向哪的线」。
                 * 但如果这条线明确接上了世界里的另一台机器，它就不是白铺 ——
                 * 它只是**还没通电**（那台机器的上游还没供料）。
                 *
                 * 真机实测（r-20261113185147-57cc，2026-11-13，level 9）：
                 * 世界布局是 mixer @(34,-13)、painter @(-9,1)，**相距 57 格**。
                 * 而 `mixer → painter.color` 是 CpCpCpCp 配方**必需**的那条边
                 * （紫色必须先进 painter）。任何接法都要铺 ~58 格 ⇒
                 * `deadGrowth` 必然 ≥ 58 ⇒ 预演必然拦 ⇒ 这条正确的边**永远接不成**。
                 *
                 * 模型那一轮做的完全正确（它说「connect the mixer's free output to the
                 * painter's color port to complete the paint path toward the hub」），
                 * 被闸门拦下，然后下一轮它就去干别的了。
                 *
                 * 判据改成：**先看这些新带子的终点是不是一台机器**。
                 * 是 ⇒ 放行（这是配方连线，不是瞎铺）；否 ⇒ 仍然拦。
                 *
                 * 这样既保住了原来那条实测依据（M15→B207 那种接向一条普通带子的白铺），
                 * 也不会再把「接两台相距很远的机器」判成浪费。 */
                const landsOnMachine = (() => {
                    const added = Array.isArray(txPlan.ops)
                        ? txPlan.ops.filter(op => op && op.op === "place" && op.building === "belt") : [];
                    if (!added.length) return null;
                    const afterObs0 = after ? (afterObs || null) : null;
                    if (!afterObs0 || !Array.isArray(afterObs0.entities)) return null;
                    const idx2 = buildIndex(afterObs0);
                    const newCells = new Set(added.map(op => `${op.x},${op.y}`));
                    const D = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };

                    /* ★ 只看**末端**，不看任意一格 —— 这是这条豁免的关键 ★
                     *
                     * 第一版遍历**所有**新格、只看「邻居里有没有机器」就放行。
                     * 红队实测（2026-11-13，L4 夹具，`connect(B?,B?)` 单调用扫描）：
                     *
                     *   source=机器(矿机)  铺 29 格  ⇒ ALLOWED（死带子 +29，阈值 20 本该拦）
                     *   source=带子        铺 35 格  ⇒ REJECTED
                     *
                     * 同样的世界、同样的距离、同样的死带子增量，**只因为 from 是矿机**
                     * 就放行 —— 因为线的**第一格**邻着那台矿机。
                     *
                     * 而 `connect` 的 from 是机器正是最常见的形态（矿机出货）。
                     * 也就是说第一版的豁免覆盖面是「几乎所有从矿机出发的长线」，
                     * 那正是原判据（M15→B207 实测）要拦的东西。
                     *
                     * 现在只认**终点**：把新铺的带子按「货能走到哪」连成链，
                     * 取链的末端那一格，看它对面是不是一台机器。
                     * 起点那台机器不参与判定 —— 它是**源头**，不是这条路通向的地方。 */
                    const lastOp = added[added.length - 1];
                    const endCell = [lastOp.x, lastOp.y];
                    /* 从末端沿新铺格往外走一格 —— 那一格若是一台真机器，才算「接上了」。 */
                    for (const [dx, dy] of Object.values(D)) {
                        const n = atCell(idx2, [endCell[0] + dx, endCell[1] + dy]);
                        if (!n) continue;
                        if (n.type === "belt" || n.type === "underground_belt") continue;
                        if (n.type === "hub") continue;
                        if (newCells.has(`${n.x},${n.y}`)) continue;
                        return { handle: null, type: n.type, uid: n.uid };
                    }
                    return null;
                })();
                if (deadGrowth >= 20 && !landsOnMachine) {
                    /* ★ 「死带子变多」有两个完全相反的成因，hint 必须分开说 ★
                     *
                     * 原来这里只有一句：「这一步新铺了 N 格通不到 hub 的带子 ——
                     * 不是『删坏了』，是『白铺了』」。那句话假设了**新增**。
                     *
                     * 实测（r-20261118212231-034e 等 6 个 run）：模型提的是**纯删除**
                     * —— `remove_run {uids:[B452,B454,B455,B575]}`，一格没铺。
                     * 死带子 159→308 是因为那 4 条入口带是 4 条长链的**下游末端**，
                     * 删掉它们让上游 153 格失去可达性。这跟「白铺」正好相反。
                     *
                     * 模型收到的却是「你白铺了 149 格」—— 它没法照做，
                     * 因为它的计划里没有任何「铺」。
                     *
                     * 现在按这一步**实际做了什么**分流：净新增带子 ⇒ 原话；
                     * 净删减带子 ⇒ 说清「你删掉的这段是别人的下游」并给出代价。 */
                    const addedCells = txPlan.ops.filter(o => o && (o.op === "place" || o.op === "place_path")).length;
                    const removedCells = txPlan.ops.filter(o => o && (o.op === "delete" || o.op === "bulk_delete")).length;
                    const isPureRemoval = addedCells === 0 && removedCells > 0;
                    const lostReach = Math.max(0, (before.belts_reaching_hub || 0) - (after.belts_reaching_hub || 0));
                    /* ★ 纯删除且删的全是「本来就交付不了」的带子 ⇒ 不算改坏 ★
                     *
                     * `belts_reaching_hub` 是纯几何的；`belts_deliverable`（类型口径）
                     * 扣掉了「几何上通到 hub、末端却送颜料」的那些。而 hub 的 16 个入口
                     * 全是 `filter:"shape"`，颜料物理上永远进不去。
                     *
                     * 判据：`after.belts_reaching_hub`（预演后剩余的几何可达数）
                     * **≥** `before.belts_deliverable`（删之前真正能交付的数量）
                     * ⇒ 这一步删掉的带子全部落在「本来就不交付」那一侧，
                     * 真正能交付的产能一条都没少。
                     *
                     * 实测（2026-11-18 L12）：before 几何 543 / 可交付 390；
                     * 删掉 4 条颜料入口带后几何剩 **390** —— 恰好等于可交付数。
                     * 也就是说那 153 条「损失」**全是颜料**，一条形状线都没伤到。
                     * 而预演把它当成「拆掉 153 条产能」拒了 9 次。
                     *
                     * ⚠️ 这条只在 `isPureRemoval` 时成立：如果这一步既删又铺，
                     * `after` 的几何数里混进了新铺的带子，这个比较就不再有意义。 */
                    /* 与上面 `tooMuch` 用**同一个口径**：可交付损失算得出来就用它。
                       那 4 条颜料入口带的死带子增长是 149，可交付损失是 **0** ——
                       死带子多了，但能交付的东西一件没少。 */
                    /* ★ 必须同时要求 `isPureRemoval` ★
                     *
                     * 只判 `deliverableLoss === 0` 会漏掉**混合批次**：
                     * 「删一条送不进去的带子 + 顺手瞎铺一条新线」这种计划，
                     * 可交付损失是 0（删的那条本来就不交付），于是整单跳过了
                     * 「你白铺了 N 格」这道闸 —— 而新铺的那条线一条货都送不到 hub。
                     *
                     * 实测（验证 agent）：`connect C6→B180`（77 op，deadGrowth 81）
                     * 在 HEAD 上被拒，在只判 dl===0 的版本上被放行。
                     * 396 组随机机器→带子连接里翻掉了 1 组 —— 罕见，但确实是个洞。
                     *
                     * 这条闸的本意就是「纯删除不该因为留下死带子被拦」，
                     * 加上 `isPureRemoval` 才是它想说的意思。 */
                    if (isPureRemoval && deliverableLoss !== null && deliverableLoss === 0) {
                        /* 放行：全是送不进去的东西变成了死带子。 */
                    } else
                    return reject("PLAN_REJECTED", {
                        layer: "plan", stage: "simulate",
                        expected: isPureRemoval
                            ? "删除不应让大量上游带子失去到 hub 的通路"
                            : "这一步不会凭空增加大量通不到 hub 的带子",
                        observed: `预演：死带子 ${before.belts_dead} → ${after.belts_dead}`
                            + `（+${deadGrowth}），到 hub 的带子 ${before.belts_reaching_hub} → ${after.belts_reaching_hub}；`
                            + `这一步是 ${txPlan.ops.length} 条 op`,
                        evidence: {
                            stage: "simulate",
                            before: { reach: before.belts_reaching_hub, dead: before.belts_dead },
                            after: { reach: after.belts_reaching_hub, dead: after.belts_dead },
                            dead_growth: deadGrowth,
                            pure_removal: isPureRemoval,
                            lost_reach: lostReach,
                            /* 与上面那条闸门同名同义 —— 下游（测试与 prompt）按它取
                               「这一步的代价」，不因为拦在哪条判据上而改变形状。
                               夹到非负：这一条闸讲的是「白铺」，代价不会是负数。 */
                            loss: lossClamped,
                        },
                        candidates: isPureRemoval
                            ? ["remove_run", "connect", "replace_run"]
                            : ["connect", "remove_run", "trash_unused"],
                        hint: isPureRemoval
                            /* 纯删除：说清真实代价。模型没做错事，代价是真的。 */
                            ? `你删掉的是 ${removedCells} 处带子，但它们是**上游长链的下游末端** —— `
                                + `删掉之后上游有 ${lostReach} 格再也走不到 hub（死带子 +${deadGrowth}）。`
                                + `两种走法：① 如果你确认这些带子上的货本来就送不进 hub（比如送的是颜料），`
                                + `那这个代价可以接受 —— 但先把上游也一起清掉，别让它们变成死线：`
                                + `用 \`remove_run\` 把**整条链**一起删（\`region\` 覆盖整段，或 \`allow_scattered:true\` 选多段）。`
                                + `② 或者别删，改用 \`replace_run\` 把那几条入口带改成接 painter 的输出。`
                            : `这一步新铺了 ${deadGrowth} 格**通不到 hub** 的带子 —— `
                                + `不是"删坏了"，是"白铺了"。先确认那条线的终点能出货，再铺；`
                                + `或者换个更近的接法。`,
                    });
                }
                if (tooMuch) {
                    /* ★ 展示的指标必须是**判定用的那个** ★
                     *
                     * 判定走 `lossClamped`（优先可交付口径），而这里原来印的是几何
                     * `loss`。真机实测（`r-20261120114323-f14c` r1）：几何 390→391
                     * 是**变好**，可交付口径却掉了 26 条 —— 于是模型读到
                     * 「到 hub 的带子 390 → 391（--1，0%）」，被拒绝，却完全不知道
                     * 拒绝的理由是什么。两个数字指向相反方向，模型只能猜。
                     *
                     * 用 `deliverableLoss` 时把它**单独说出来**，并说明为什么与几何
                     * 数不一致（颜料进不了 hub，所以几何可达 ≠ 真的能交付）。 */
                    const usingDeliverable = deliverableLoss !== null;
                    const metricName = usingDeliverable
                        ? "能真正交付的形状带子" : "到 hub 的带子";
                    const beforeMetric = usingDeliverable ? deliv : before.belts_reaching_hub;
                    const afterMetric = usingDeliverable
                        ? Math.max(0, (deliv || 0) - lossClamped) : after.belts_reaching_hub;
                    return reject("PLAN_REJECTED", {
                        layer: "plan", stage: "simulate",
                        expected: `这一步不会大幅减少${metricName}`,
                        observed: `预演：${metricName} ${beforeMetric} → ${afterMetric}`
                            + `（-${lossClamped}，${Math.round(effectivePct * 100)}%），`
                            + `死带子 ${before.belts_dead} → ${after.belts_dead}；`
                            + `这一步是 ${txPlan.ops.length} 条 op`
                            + (usingDeliverable && before.belts_reaching_hub !== after.belts_reaching_hub
                                ? `（几何上到 hub 的带子是 ${before.belts_reaching_hub} → ${after.belts_reaching_hub}，`
                                    + `但几何可达只是「路能走通」——hub 的入口只收形状，运颜料的带子物理上交付不了）`
                                : ""),
                        evidence: {
                            stage: "simulate",
                            before: { reach: before.belts_reaching_hub, deliverable: deliv, dead: before.belts_dead },
                            after: { reach: after.belts_reaching_hub, dead: after.belts_dead },
                            metric: usingDeliverable ? "belts_deliverable" : "belts_reaching_hub",
                            loss: lossClamped, pct: Math.round(effectivePct * 1000) / 1000,
                            ops: txPlan.ops.length,
                            calls: executed.map(c => c.macro),
                        },
                        /* 最可能是 `allow_replace` 覆盖了正在工作的带子 —— 那句话必须说出口，
                           因为宏的 warning 只报「几格」，不报到 hub 少了多少。 */
                        hint: `这一步会让世界明显变差，已在写盘前拦下（世界没有被改）。`
                            + `最常见的原因是 \`connect {allow_replace:true}\` 或 \`trash_unused\` 覆盖/封死了**正在工作**的带子 ——`
                            + `宏只会说「覆盖了 N 格」，不会说那 N 格背后挂着 ${lossClamped} 条到 hub 的带子。`
                            + `换一条更短的路径（先不带 allow_replace 试），或先确认那几格确实是废料。`,
                    });
                }
            }
        } catch (e) {
            /* 预演失败**不许**变成拒绝：它是额外的安全网，不是判据本身。
               算不出来就放行，让已有的后验路径（verify + rollback）兜住。
               （`buildTxPlan` 是纯函数，拿不到 `runLoop` 的 timeline —— 只能 console。） */
            if (typeof process !== "undefined" && process.env && process.env.SHAPEZ_DEBUG_SIM) {
                console.error(`[simulate] skipped: ${String(e && e.message ? e.message : e).slice(0, 120)}`);
            }
        }
    }

    return {
        ok: true,
        /* ⚠️ `partial` / `skipped` 必须**同时**放在 `txPlan` 里：
         *
         * `verifyRound({txPlan: planned.txPlan, ...})` 传的是这一层
         * （`loop.mjs:2248`），而 `verifyRound` 再从 `txPlan.partial` 读出来
         * 传给 `strictVerdict`（`verify.mjs` 的 ⑤ 段）。
         *
         * 只放在外层 `planned.partial` 的话，判据层永远看不到 ⇒ 部分执行被算成成功。
         * 这正是红队警告的那个假绿。 */
        txPlan: {
            ...txPlan,
            ops: withProv.ops,
            partial: partialMode && skippedAll.length > 0,
            skipped: skippedAll,
        },
        calls: executed,
        resolved: res,
        provenance: { tagged: withProv.tagged, untagged: withProv.untagged.length },
        warnings: (txPlan.warnings || []).map(w => w && w.code).filter(Boolean),
        /* ★ 宏自己算出来的后果（P17 §6.1）★
         *
         * `warnings`（上一行）是 **txPlan** 层的；这里要的是**每个宏的返回值**里那些：
         * `removal-is-clean` / `would-disconnect` / `rv-drift` …
         * 它们一直存在、一直没人用 —— 只进了 transcript，从没进过 prompt。
         *
         * 保留 `detail`（去掉 `hint`：prompt 里没地方放，而 detail 才是「发生了什么」）。
         * 这是 renderLastRound 里 `consequences of last round's calls:` 的数据源。 */
        macro_warnings: executed.flatMap(ex =>
            ((ex && ex.result && Array.isArray(ex.result.warnings)) ? ex.result.warnings : [])
                .filter(w => w && w.code)
                .map(w => ({ macro: ex.macro, code: w.code, detail: w.detail || null }))
        ),
        /* ★ partial 标记 + 被跳过的明细 ★
         *
         * `partial: true` 意味着**这个计划没有完整执行** —— 有调用被跳过。
         *
         * ⚠️ 下游**必须**把它当「不算完全成功」：
         *   · `strictVerdict` 要加一条 `noPartialApply`（ok:false 且**不带 skipped**，
         *     否则 `classifyChecks` 第一句 `if (c.skipped) continue` 会把它吞掉 ——
         *     红队 `REDTEAM-PARTIAL-APPLY.md` 的 `holes.mjs` 实测过这个坑）
         *   · `world_state` 仍然是 `"applied"`（世界真的变了），但 `partial` 要单列
         *
         * `skipped` 里每条的 `reason`：
         *   · `macro_failed`   —— 宏自己返回 ok:false（带 code / hint）
         *   · `irreversible`   —— 宏成功了，但产物是机器/垃圾桶，撤销不了
         *   · `not_translatable` —— 单条翻译成 op 失败（几乎不该发生，防御性分支）
         */
        partial: partialMode && (skippedAll.length > 0),
        skipped: skippedAll,
    };
}

/**
 * `worldHealth()` + 删除冗余度。
 *
 * ★ 为什么必须走这个 helper，不许直接调 `worldHealth` ★
 *
 * `loop` 里有**三处**建 health 快照：轮首、撤销后、收尾。只在轮首挂
 * `redundancy` 是不够的 —— 后两处会把 `st.healthNow` 整个覆盖掉，
 * 于是 `run` 返回的 `health` 里就没有这个字段了。
 *
 * 这个 bug 是 `loop.test.mjs` 的端到端断言抓到的（"health 里必须有 redundancy" 红了）。
 * 它正好演示了本项目的反复教训：**加一个字段时，要数清有几个赋值点**。
 *
 * 冗余度是**世界属性**（有几格带子删了不伤下游），与哪一处建的快照无关，
 * 所以升格成 helper，而不是复制三段 try/catch。
 *
 * @param {object} p  同 `worldHealth` 的入参
 * @returns {object}  health（含 `redundancy`，失败时降级为带 `reason` 的 null 形态）
 */
function healthWithRedundancy(p) {
    const h = worldHealth(p);
    try {
        const obs = p && p.obs;
        const nBelts = (obs && Array.isArray(obs.entities))
            ? obs.entities.filter(e => e && e.type === "belt").length : 0;
        h.redundancy = removalRedundancy(obs, nBelts > BUDGET.REDUNDANCY_FULL_MAX
            ? { sample: BUDGET.REDUNDANCY_SAMPLE }
            : {});
    } catch (e) {
        h.redundancy = {
            belts: null, safe: null, breaking: null, safe_pct: null, break_kinds: null,
            reason: `threw: ${e && e.message ? e.message : e}`,
        };
    }
    return h;
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
    /* ★ 当前目标必须可变 ★
     *
     * `goal` 是**调用方给的**初始目标；世界可能在 run 中途升级（level 5 → 6），
     * 那时正确做法是采纳世界的目标继续跑，而不是 halt（halt 等于「赢一局就死机」）。
     * 但 `opts.goal` 本身不改 —— 调用方传的是「这次 run 想解决什么」，
     * 而 `curGoal` 是「世界现在要什么」。两者在升级后暂时不同，这是正常的。
     *
     * 上一次的名字 `const goal` 让所有下游（diagnose / prompt / 记忆落盘）
     * 都锁死在旧目标上，那正是用户贴图那次的成因。所以改成 let + 一个
     * 显式的 `curGoal` 变量，并在每轮轮首刷新。 */
    const goalInput = typeof opts.goal === "string" ? opts.goal : (opts.goal && (opts.goal.shape || opts.goal.goal));
    if (!goalInput || typeof goalInput !== "string") throw new TypeError("runLoop: goal 形状串必需");
    const goal = goalInput;
    let curGoal = goalInput;
    const budget = { ...BUDGET, ...(opts.budget || {}) };
    const runId = opts.runId || `r-${new Date(t0).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(2).toString("hex")}`;
    const runDirRoot = path.resolve(opts.runDir || path.join(REPO, RUN_DIR));
    const runDir = path.join(runDirRoot, runId);
    const tr = new Transcript(runDir, runId);
    const tl = new Timeline(runDir);

    /* ── 跨 run 记忆 ──
     *
     * 记忆放在 `runDirRoot` 下（不是本次 run 的目录里）—— 它是跨 run 的。
     * 同一个 `--run-dir` 下的多次 run 共享一份记忆；
     * 换 runDir（换世界/换实验）就自动换记忆，不需要额外参数。
     *
     * 读失败 → 空记忆，run 照常跑。没有记忆只是少了一份先验，不是错误。 */
    const memoryFile = path.resolve(runDirRoot, MEMORY_FILE);
    const memory = loadMemory(memoryFile);
    /* 世界身份：真桥走 `world_info`（mod 的 seed），离线夹具用 `fixtureWorldKey`
       （fixture 文件名 + hub uid）。拿不到就是 "unknown"。
       这个 key 只在**读记忆时**用一次，不随 tx 变化 —— 见 `worldKeyOf` 的注释。
       ⚠️ `obs` 必须**显式传入**，不能读 `st.lastObs`：那个引用在循环里每轮都被
       换掉，闭包里读到的是「当下的世界」而不是「算 key 那一刻的世界」。
       而 key 必须**一次定死** —— 如果它随世界变（比如退化的 `hubuid|L` 里含
       关卡号），升级之后 key 就变了，`worlds` 里那条记录永远匹配不上。 */
    const readWorldKey = async (obs) => {
        try {
            if (typeof reader.worldInfo === "function") {
                const wi = await reader.worldInfo();
                return worldKeyOf(wi, obs || null);
            }
        } catch { /* 读不到就退到 obs 里的 hub uid，不阻塞 run */ }
        return worldKeyOf(null, obs || null);
    };
    /* 本次 run 已经用过的动作集由 `## LAST ROUND` 负责讲；历史段保留硬负例
       （`attemptsForGoal` 内部按 kind 硬度判），只剔除弱记录。
       `st` 在下面才声明，但这个函数只在循环里被调用（那时 `st` 已存在）——
       闭包按调用时求值，不会触发 TDZ。 */
    const priorAttemptsFor = (gs, world) => attemptsForGoal(memory, gs, {
        limit: 6,
        excludeActionSets: (st.roundCalls || []).map(r => r.actionSet),
        world,
        worldStrict: true,
    });

    const ctx = {
        reader, llmClient, goal, mode, budget, apply: opts.apply || null, game: opts.game || null,
        dryRun: opts.dryRun === true,
        /* 实验开关：强制一轮只做一个宏。默认 false，不改变常态行为。 */
        forceOneCall: opts.forceOneCall === true || (budget && budget.FORCE_ONE_CALL === true),
    };

    /* ── 运行状态（全部随 run_end 落盘） ── */
    const st = {
        obs: null, items: null, production: null, handles: null,
        lastReport: null, lastPlanSummary: null,
        lastTx: null, lastObs: null, lastItems: null, lastProduction: null,
        worldTouched: false, lastApplyRolledBack: false, lastSuccessfulRound: 0,
        /* ★ 本次 run 的任务日志：每一轮「我说要做什么 / 世界变成什么样」★
         *
         * ## 为什么需要它（第 9 关实测的策略漂移）
         *
         * 第 9 关的 `MIXER_UNFED` 明确写着「红矿在 44 格外，这不是接一根线，
         * 是一条要单独规划的长支线」。模型第 4 轮的 `say` 原文：
         *
         *   place the existing mixer concept on the blue stream at B194 so the mix
         *   step sits in-line, **rather than building a far-off color branch first**
         *
         * 它**知道**那个选项，主动选择先做别的。然后下一轮完全忘了这个决定，
         * 又去试 connect、又去放 mixer —— 三轮下来一步没往支线走。
         *
         * 根因不是「信息没送到」（诊断写得很清楚），而是**跨轮没有目标坚持**：
         * 每轮都是新 prompt，`## LAST ROUND` 只带上一轮的动作与结果，
         * 不带「我前几轮决定过什么」。
         *
         * 这个数组记 `{round, say, calls, outcome}`。渲染时只取**最近几轮**，
         * 让模型看到自己的决策轨迹 —— 「我第 4 轮说过要先放 mixer，
         * 现在第 6 轮又回头来做同一件事，是不是该换条路」。
         *
         * 注意它**不是**跨 run 记忆（那是 `memory.mjs` / `attempts.json`）。
         * 两者互补：跨 run 记「这类动作在这个目标上历来有没有用」，
         * 这个记「本次 run 我打算干什么、已经走到哪」。 */
        runLog: [],
        rounds: 0,
        llmCalls: 0, txCount: 0, ticks: 0,
        diagnoses: [],        /** fp → {count, actions:Set} */
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
        /**
         * 上一轮 tx **之后**的世界体检快照（`worldHealth()`）。
         *
         * 这是「这一步是好是坏」的基准：本轮 tx 前再拍一张，两张相减就是净效果。
         * `null` = 还没拍过（首轮），此时不做判定 —— 没有 before 就没有 delta，
         * 用精心构造的假基准去凑一个 delta 只会得到假结论。
         */
        healthBefore: null,
        /** 上一轮的净效果判定（进 prompt，让模型知道自己上一步干了什么） */
        lastNetEffect: null,
        /** 本轮 tx 后的快照（供下一次循环当 before） */
        healthNow: null,
        /** 首轮快照（run_end 的累计对比用） */
        healthFirst: null,
        /** 每轮判定后的净效果序列（进 run_end，可 grep 出「越改越差」） */
        netEffects: [],
        /** 本 run 存过的检查点名（用于 run_end 与调试） */
        checkpointNames: [],
        /** 已撤销次数（`decideRollback` 的上限判据） */
        rolledBack: 0,
        /** 每次撤销的完整记录 */
        rollbacks: [],
        /** 撤销之后的一轮：让 `reverted` 的观感存活一轮（见轮首那段注释） */
        revertedPending: false,
        /** 每轮真正执行过的宏（供跨 run 记忆落盘） */
        roundCalls: [],
        /**
         * 本次 run 中途世界升级的记录（`{from,to,level_from,level_to,round}`）。
         *
         * 只在第一次检测到时置位。它有两个消费者：
         *   · `GOAL_CHANGED` 诊断（只报一轮，见 `goalChangedAnnounced`）；
         *   · `run_end` 的 `goal_changed` 字段（读日志的人据此判断这次 run
         *     跨了关，从而知道 `goal_delta` 为什么不能直接比）。
         */
        goalChanged: null,
        /** GOAL_CHANGED 是否已经报过（避免每轮都加、吃掉预算） */
        goalChangedAnnounced: false,
        /** 上一轮的 txPlan（授权拆除要用它的 `removes`） */
        lastTxPlan: null,
        /** 上一轮算出的残线清单（授权拆除的第二判据） */
        lastObsoleteLines: null,
        /**
         * 粘性目标：连续 ≥2 轮存在、且属于「成因类」的诊断码，每轮强制置顶。
         * `{code, since, rounds}`；null = 当前没有。
         * 详见轮首那段长注释 —— 它解决的是「模型每轮被更近的红点吸引、
         * 需要跨多轮的工程永远排不到前面」。
         */
        stickyGoal: null,
        /** 上一轮出现过的粘性候选码（用来判「连续两轮」） */
        stickySeen: [],
    };

    /**
     * 把一轮的计划压成一句人话：**落了什么**，不只是用了哪个宏。
     *
     * ## 为什么要它（第 9 关 r-20261112093135-cdeb）
     *
     * 模型 r1/r2/r3 连着放了 3 台矿机（`$ore:"blue"` ×2、`$ore:"red"` ×1，
     * 三台全部落盘成功）。r4/r5 它又回到**不带 `$ore` 的盲目 insert_machine** ——
     * 因为 `## THIS RUN` 只写了「r3 insert_machine → applied」，
     * 它不知道自己刚才已经把矿机放到位了。
     *
     * ## 只记「不随 uid 变的东西」
     *
     * tx 之后 uid 会变、句柄要重建，所以**不能**记 uid。记的是
     * `provenance.at`（形如 `ore:blue@37,-8`）与机器种类 ——
     * 那是下一轮模型能自己重新定位的东西。
     *
     * 没有 provenance 的调用退回「宏名 + 目标句柄」，同样不含 uid。
     *
     * @param {object} planned `buildTxPlan` 的返回（`calls[].args/provenance/result`）
     * @returns {string[]} 每个调用一句，最多 3 句（再多就是噪音）
     */
    function summarizeCalls(planned) {
        const out = [];
        for (const c of (planned && Array.isArray(planned.calls) ? planned.calls : [])) {
            if (!c || typeof c.macro !== "string") continue;
            const a = c.args && typeof c.args === "object" ? c.args : {};
            const prov = c.provenance && typeof c.provenance === "object" ? c.provenance : {};
            /* `insert_machine`：最要紧的是「什么机器、落在哪种矿上」 */
            if (c.macro === "insert_machine") {
                const kind = (a.machine && typeof a.machine === "object" ? a.machine.kind : a.machine) || "machine";
                const atProv = typeof prov.at === "string" ? prov.at : "";
                const ore = /^ore:([^@]+)@/.exec(atProv);
                if (ore) { out.push(`${kind} on ${ore[1]} ore`); continue; }
                const cell = a.at && Array.isArray(a.at.cell) ? a.at.cell : null;
                if (cell) { out.push(`${kind} at ${cell[0]},${cell[1]}`); continue; }
                out.push(kind);
                continue;
            }
            /* `connect` / `extend_line`：起止端点都是句柄，天然稳定 */
            if (c.macro === "connect" || c.macro === "extend_line") {
                const h1 = (c.result && c.result.from && c.result.from.handle) || "";
                const h2 = (c.result && c.result.to && c.result.to.handle) || "";
                if (h1 || h2) { out.push(`${c.macro} ${h1}→${h2}`.trim()); continue; }
            }
            /* 其余：宏名 + 首个 looks-like-handle 的字符串参数值 */
            const refs = [];
            for (const v of Object.values(a)) {
                if (typeof v === "string" && /^[A-Z]{1,2}\d{1,3}$/.test(v)) refs.push(v);
                if (v && typeof v === "object" && typeof v.ref === "string") refs.push(v.ref);
                if (v && typeof v === "object" && Array.isArray(v.$uids)) refs.push(...v.$uids.filter(x => typeof x === "string"));
            }
            out.push(refs.length ? `${c.macro} ${refs.slice(0, 3).join(",")}` : c.macro);
        }
        return out.slice(0, 3);
    }

    /**
     * 把某一轮的 runLog 条目标成给定结局（只标最后一条 `planned`）。
     *
     * `## THIS RUN` 的价值在「我说的」与「实际发生的」之间的对照。
     * tx 没跑起来时也必须落一个结局，否则那一轮会永远停在 `planned`，
     * 模型看到的是一句没有下文的打算 —— 比不显示更误导。
     */
    function markRunLog(round, kind) {
        for (let i = st.runLog.length - 1; i >= 0; i--) {
            if (st.runLog[i].round === round && st.runLog[i].outcome === "planned") {
                st.runLog[i].outcome = kind;
                return;
            }
        }
    }

    let outcome = "error";
    let reason = "INTERNAL";
    let verdict = null;
    let lastErr = null;
    /* 这两个在 finally 里填充、在返回值里要用 —— 所以作用域必须提到 try 之外。 */
    let savedFiles = [];
    let runTotal = null;
    let tlFile = null;
    /* 记忆保存的结果（进 run_end），在 finally 里填充。 */
    let memorySaved = false;
    /* 世界身份：首轮 observe 之后算一次（seed 在一次 run 内不变）。 */
    let currentWorldKey = null;
    /* 要写回 `worlds` 的本次世界状态（finally 里由 `worldUpdate` 填充）。 */
    let worldPatch = {};

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
        /* ★ 失败必须进 timeline —— 否则日志只剩「成功做了什么」★
         *
         * 用户要求：「复盘 AI 怎么想的应该做成 log 形式，而不是没了以后日志也没了」。
         *
         * 而实测（2026-11-19）：`timeline.log` 里**完全没有记录被拒的计划**。
         * 541 个 run 里 1466 次 plan 被拒 vs 1010 次 apply 成功 ——
         * **59% 的动作根本没落地**，而那 59% 在日志里一个字都没有。
         *
         * 恰恰是这部分最该复盘：模型想做什么、被什么拦住、它下一轮有没有换招。
         * 所以把「这一轮失败了、为什么」也写成人话。 */
        try {
            const d0 = Array.isArray(diagnoses) && diagnoses[0] ? diagnoses[0] : null;
            const code = d0 && d0.code ? d0.code : "?";
            const calls = (Array.isArray(macros) ? macros : []).join(",") || "none";
            /* ★「未落地」只对 apply/parse 成立；verify 是另一回事 ★
             *
             * 实测（验证 agent）：**24/24 个 `[verify]` 标记都紧跟在
             * `tx ✓ applied 2/2` 下面**，却写着「调用 replace_run 未落地」——
             * 上一行刚说它落地了。线性读日志的人会被直接带反。
             *
             * 真相是：verify 失败**不是「没落地」**，是「落地了但没达成目标」。
             * 同一个 `settleFailure` 被两个语义完全不同的阶段共用，
             * 而我只写了一套措辞。现在按阶段分开说。 */
            if (phase === "verify") {
                tl.push(`    ✗ 本轮未通过 [verify] ${code}  （tx 已落地，是世界没达成目标）`);
                tl.push(`      本轮调用 ${calls}`);
            } else {
                tl.push(`    ✗ 未落地 [${phase}] ${code}  调用 ${calls}`);
            }
            if (d0 && typeof d0.observed === "string" && d0.observed) {
                tl.push(`      ${d0.observed.slice(0, 200)}`);
            }
            if (d0 && typeof d0.hint === "string" && d0.hint) {
                tl.push(`      → ${d0.hint.slice(0, 200)}`);
            }
        } catch { /* 日志不该有能搞坏 run 的能力 */ }
        /* ★ 失败的这一轮也要写进 `lastPlanSummary` ★
         *
         * 原来这里只写 transcript 的 `repair_decide`，不更新 `lastPlanSummary`。
         * 后果：计划被拒之后，**下一轮 prompt 的 `## LAST ROUND` 显示
         * "none (this is round 1)"** —— 模型看不到自己上一轮失败过、更看不到为什么。
         *
         * 实机第 9 关：模型第 1 轮 `connect` 被 `target_already_fed` 拒，
         * 第 2 轮它换了个 `prefer` 又调了一次**几乎完全相同**的 connect。
         * 因为它读到的是「上一轮：无」。
         *
         * `failures` 的形态与成功路径一致（`renderLastRound` 直接吃）：
         * 失败的那个带 code + hint + observed，其余标 `unverified`。 */
        const d0 = Array.isArray(diagnoses) && diagnoses[0] ? diagnoses[0] : null;
        st.lastPlanSummary = {
            round: roundNo,
            calls: Array.isArray(macros) ? macros.slice() : [],
            verify: { checks: [], codes: (Array.isArray(diagnoses) ? diagnoses : []).map(d => d && d.code).filter(Boolean) },
            decision: "plan_rejected",
            failures: (Array.isArray(macros) ? macros : []).map(m => {
                /* ★ 从诊断的 evidence 里捞出**这个宏自己**的宏级 candidates ★
                 *
                 * `partial` 模式下 `NO_REVERSIBLE_CALL` 把每个失败宏的
                 * `{macro, code, hint, candidates}` 放进 `evidence.skipped`。
                 * `ambiguous_port` 的消歧答案就在那份 candidates 里
                 * （每个 `{role,index,cell}`），不带给模型它只能猜。
                 *
                 * 注意按 **macro 名** 匹配而不是按下标：诊断里的 skipped 顺序
                 * 与 `macros` 一致，但同名宏可能出现多次，配对靠下标更稳。 */
                const sk = (d0 && d0.evidence && Array.isArray(d0.evidence.skipped))
                    ? d0.evidence.skipped
                    : [];
                const hit = sk.find(s => s && s.macro === m);
                return {
                    macro: m,
                    /* 用宏自己的错误码（见上面 plan_rejected 分支的同款说明）——
                       汇总诊断的 `NO_REVERSIBLE_CALL` 对「怎么改」没有信息。 */
                    code: (hit && hit.code) ? hit.code : (d0 ? d0.code : "PLAN_REJECTED"),
                    hint: (hit && hit.hint) || (d0 && d0.hint ? d0.hint : null),
                    observed: d0 && typeof d0.observed === "string" ? d0.observed : null,
                    candidates: hit && Array.isArray(hit.candidates) ? hit.candidates : null,
                };
            }),
        };
        /* runLog 也落一个结局 —— 否则那一轮永远停在 `planned`。 */
        markRunLog(roundNo, "failed");
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

            /* 世界身份只读一次（seed 不会在一次 run 里变）。读不到就 "unknown"，
               那仍然按 goal 分组，只是不能跨世界隔离 —— 附加能力，绝不阻塞 run。 */
            if (currentWorldKey === null) currentWorldKey = await readWorldKey(ob.obs);

            /* ★ 首轮就把「我看到了这个目标」写进记忆，不等 finally ★
             *
             * 交叉评审指出的两个洞，都由这一行解决：
             *
             *   ① **全新 runDir / 某个世界第一次 run** 时记忆是空的。
             *      如果这个 run 中途升级，`rememberedGoal` 取不到 ⇒ 判不出
             *      「是升级」⇒ 退化成 `halt: GOAL_MISMATCH`，本 run 经验全丢。
             *   ② `worldUpdate` 只在 finally 写，意味着「上次目标」永远是
             *      **run 结束那一刻**的目标；中途升级的那一段完全不留痕。
             *
             * 首轮 observe 之后写一次，此后每轮若目标变了再写 ——
             * 这样同一次 run 内就有自证能力，不依赖上一次 run。
             *
             * 写失败不阻塞：记忆是附加能力。 */
            if (roundNo === 1) {
                const seenGoal = (ob.obs.goal && ob.obs.goal.requirement
                    && typeof ob.obs.goal.requirement.shape === "string")
                    ? ob.obs.goal.requirement.shape : goal;
                const seenLevel = Number.isFinite(ob.obs.goal && ob.obs.goal.level) ? ob.obs.goal.level : null;
                if (seenGoal && seenGoal !== goal) {
                    /* 首轮目标就与调用方不同 —— 这正是「升级发生在两次 run 之间」的形态。
                       先写一条「我上次见的是 goal（调用方的）」，再让下面的检测走升级分支；
                       但如果记忆里**根本没有**这个世界，就不能假定是升级（可能是传错）。 */
                } else if (seenGoal) {
                    /* 首轮与调用方一致：立即落盘，供本 run 中途升级时自证。 */
                    const patch0 = worldUpdate({
                        mem: memory, world: currentWorldKey, goalShape: seenGoal, level: seenLevel,
                    });
                    if (Object.keys(patch0).length) {
                        saveMemory(memoryFile, mergeMemory(memory, [], patch0));
                        /* 同步进当前这份 memory —— 否则本 run 后面的检测仍然读不到。 */
                        Object.assign(memory, mergeMemory(memory, [], patch0));
                    }
                }
            }

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

            /* ── ①c 世界体检快照（轮首） ──
             *
             * 放在**诊断之前、prompt 之前**，因为它有三个下游：
             *   1. timeline 的第一行（人读）；
             *   2. 上一轮 tx 的净效果基准 —— 上一轮 tx 之后拍的那张就是本轮的 before，
             *      所以「这步是好是坏」必须等**下一次 observe** 才有定论（世界是异步的：
             *      tx 返回 ok 不代表货已经在流）。这个顺序是刻意的，不是拖沓。
             *   3. run_end 的累计对比（首轮快照 vs 末轮快照）—— 回答「整次 run 到底改善了没有」。
             *
             * 注意它**只读已有数据**，不额外 RPC：obs/items/production 都是 observeOnce
             * 刚拿到的。加一次读取会让这一段的成本变成两次网络往返。
             */
            const healthNow = healthWithRedundancy({
                obs: ob.obs, items: ob.items, production: ob.production, goalShape: curGoal,
            });
            if (st.healthFirst === null) st.healthFirst = healthNow;
            st.healthNow = healthNow;

            /* 上一轮 tx 的净效果 —— 现在才有 after 可读。
               ★ 必须在覆盖 `st.healthBefore` **之前**比较 ★
               先赋值再比较，就是自己比自己，每轮都得到「无变化」——
               这个错误在第一次端到端跑里立刻现形了（timeline 里连着两条 inert）。 */
            let roundNetEffect = null;
            const beforeSnapshot = st.healthBefore;
            /* ★ 上一轮的净效果必须排在**上一轮**下面，不是这一轮的标题下 ★
             *
             * 原来是先 `tl.push("── r${roundNo}")` 再算上一轮的 delta ——
             * 于是 r1 的结果被写在了 r2 的标题下面。实测（验证 agent）：
             *
             *   ── r2  …  带上货 377
             *         ▲ items_on_belts 375→377(+2)
             *       净效果: cleanup …
             *
             * 那两行是 **r1** 的结果。按标题数效果的人，每一轮都会错位一格。
             * 现在把 delta/净效果先写，再写本轮标题。 */
            if (beforeSnapshot) {
                const dd0 = healthDelta(beforeSnapshot, healthNow);
                const ne0 = classifyNetEffect(beforeSnapshot, healthNow, dd0);
                /* 这两个值下面还要用（st.netEffects / markRunLog），
                   所以算一次、存起来，下面复用而不是重算 —— 重算会得到同一个数，
                   但多算一遍意味着两处可能漂移。 */
                roundNetEffect = ne0;
                st.netEffects.push({ round: roundNo, kind: ne0.kind, why: ne0.why });
                markRunLog(roundNo, ne0.kind);
                tl.push(`      ${formatDelta(dd0)}`);
                tl.push(`    ${formatNetEffect(ne0)}`);
            }
            tl.push(`── r${roundNo}  ${formatHealth(healthNow)}`);
            if (beforeSnapshot) {
                /* 净效果已在上面（标题之前）写过了，这里只保留 runLog 回填
                   与 `lastNetEffect` 的更新 —— 不要再 push 一次，
                   否则日志里每一轮会出现两遍同样的 delta。 */
                /* ★ 撤销的观感优先级高于这一轮的 inert ★
                 *
                 * 撤销发生时我们把 `healthBefore` 也重置成了「撤销后的世界」，
                 * 所以紧接的那一轮算出来必然是 `inert`（世界确实没再变）。
                 * 语义上没错，但对模型是**误导**：它上一轮的改动是被系统撤掉的，
                 * 不是「什么都没发生」。若照实传 inert，模型会得到
                 * 「我上一轮什么也没干」的结论 —— 而真相是「你干了，被否了」。
                 *
                 * 所以撤销之后的那一轮，`lastNetEffect` 保持 `reverted`
                 * （它在上一次循环里已经设好），本轮不再覆盖它。
                 * 时间线仍然如实记 inert —— 读日志的人看得到世界确实没变。 */
                if (st.revertedPending) {
                    st.revertedPending = false;       // 只保留一轮，之后恢复正常
                } else {
                    st.lastNetEffect = roundNetEffect;
                }
            } else {
                const deadSrc = formatDeadBySource(healthNow);
                if (deadSrc) tl.push(`    死带子源头 ${deadSrc}`);
            }

            /* 本轮的 tx 会在这个快照之后发生 ⇒ 它就是**下一轮**的 before。
               赋值放在比较**之后**，且在 tx 之前（理由见上：tx 之后没有 items 可读，
               而「带上的货」是判定里唯一能看见「线通了但货没动」的量）。 */
            st.healthBefore = healthNow;

            /* ── ①d 该不该撤销上一步（**在这里做，不在 verify 之后**）──
             *
             * 为什么在这一刻：撤销要用「上一轮 tx 之前」的检查点，而这里已经
             * 读到了「上一轮 tx 之后」的世界（`healthNow`）—— 两个快照都在手上，
             * 判定与执行可以一次做完。放到 verify 之后会多一次世界读取。
             *
             * 为什么在 `st.healthBefore = healthNow` **之后**：撤销成功后世界回到了
             * 上一轮之前，所以 `healthBefore` 需要被**重置**成撤销后的世界，
             * 否则下一轮的净效果会把「撤销」本身算成一次变化。见下面的回填。
             */
            if (roundNetEffect && typeof reader.checkpointRestore === "function") {
                const runTotalNow = (st.healthFirst && beforeSnapshot)
                    ? classifyNetEffect(st.healthFirst, beforeSnapshot)
                    : null;
                /* 「本轮有没有在加东西」——`constructive` 的信号。施工的特征是边拆边建。 */
                const hadWork = !!(roundNetEffect
                    && Array.isArray(roundNetEffect.why)
                    && roundNetEffect.why.some(w => /机器\s*\+\d+|带子\s*\+\d+/.test(String(w))));

                const dec = decideRollback({
                    netEffect: roundNetEffect,
                    runTotal: runTotalNow,
                    prevNetEffect: st.prevNetEffect || null,
                    mode,
                    budget,
                    rolledBackCount: st.rolledBack,
                    hadWorkThisRound: hadWork,
                    /* ★ 授权拆除 ★
                     *
                     * 用**上一轮**的计划（`st.lastTxPlan`）判断：本轮测的是
                     * 上一轮 tx 的净效果，所以「它拆了什么」也来自上一轮。
                     *
                     * 不传这个的后果（实测确认过的反向激励）：模型照着
                     * `OBSOLETE_LINE` 去拆残线 → 拆的正是那些能到 hub 的带子
                     * → 判 regressive → 连续两次被系统撤销。等于「照做就挨打」。 */
                    sanctionedTeardown: isSanctionedTeardown({
                        removes: st.lastTxPlan ? st.lastTxPlan.removes : null,
                        obsoleteLines: st.lastObsoleteLines || null,
                    }),
                });
                tl.push(`    撤销判定 ${dec.kind}${dec.rollback ? "（真撤销）" : ""}${dec.dry ? "（离线不执行）" : ""}`
                    + (dec.why.length ? ` — ${dec.why.slice(0, 2).join("；")}` : ""));

                if (dec.kind === "rolling_back") {
                    let restored = null;
                    if (dec.rollback) {
                        /* 恢复到**上一轮 tx 之前**的检查点。名字是 `r<上一轮轮号>`。 */
                        const target = st.checkpointNames.length
                            ? st.checkpointNames[st.checkpointNames.length - 1]
                            : null;
                        if (target) {
                            try {
                                restored = await reader.checkpointRestore({ name: target, drop_after: false });
                            } catch (e) {
                                restored = { ok: false, why: [`restore 抛异常：${e && e.message ? e.message : e}`] };
                            }
                        } else {
                            restored = { ok: false, why: ["没有可用的检查点"] };
                        }
                        st.rolledBack++;
                    }
                    const after = netEffectAfterRollback(dec, restored);
                    const rec = {
                        round: roundNo, decision: dec.kind, dry: !!dec.dry,
                        target: st.checkpointNames[st.checkpointNames.length - 1] || null,
                        verified: !!(restored && restored.verified),
                        reverted: !!(after && after.reverted),
                        why: (after && after.why) || dec.why,
                        restore_why: restored && Array.isArray(restored.why) ? restored.why : [],
                    };
                    st.rollbacks.push(rec);
                    tr.write("repair_decide", roundNo, {
                        phase: "rollback",
                        action: dec.rollback ? "rolled_back" : "rollback_planned_offline",
                        reason: dec.kind,
                        fingerprint: null,
                        action_set: null,
                        improved: after ? after.reverted : null,
                        codes: ["ROLLBACK"],
                        diagnoses: [],
                        rollback: rec,
                    });
                    tl.push(`    ${after && after.reverted ? "✓ 已撤销，世界回到上一轮之前" : "✗ 撤销未生效"}`
                        + (rec.restore_why.length ? ` — ${rec.restore_why.slice(0, 2).join("；")}` : ""));

                    if (after && after.reverted) {
                        /* 撤销成功后：把这一轮的净效果改写掉，并把 before 重置成
                           「撤销后的世界」—— 否则下一轮会把撤销算成一次变化。 */
                        const idx = st.netEffects.length - 1;
                        if (idx >= 0) st.netEffects[idx] = { round: roundNo, kind: "reverted", why: rec.why };
                        st.revertedThisRound = true;

                        /* ★ 必须重读世界，并把 before 也重置 ★
                         *
                         * 撤销把世界退回到了**上一轮 tx 之前**。此刻三份快照各是什么：
                         *
                         *   `healthNow`   本轮轮首读的（= 上一轮 tx 之后）→ **已失效**
                         *   `healthBefore` 本来是「本轮 tx 之前」的基准 →
                         *                 它现在**也失效了**：它记录的是撤销前的世界
                         *                 （176 条带子），而世界已经是 179 条了。
                         *
                         * 第一次实现只换了 `healthNow`、没换 `healthBefore`，结果下一轮
                         * 把「撤销」本身算成了一次 `constructive` 变化（实测：
                         * `177→179(+2) 带子 +2`），时间线上看起来像「模型又加了两条带子」。
                         * 那是**假的**：世界只是被我们还原了。
                         *
                         * 所以两个都要设成撤销后的真实读数。这样下一轮的 delta 是
                         * 「撤销后的世界 → 下一轮 tx 之后」，语义正确。
                         *
                         * 读失败不阻塞：两份都保持旧值，只在时间线里说清「撤销后读不到」。
                         * 用一份猜测的世界去记账比不记账更糟 —— 那会让下一次判定基于假数据。 */
                        try {
                            const ro = unwrapObs(await reader.obs({
                                max_entities: 50000, layer: "all",
                                include_stats: true, include_resources: true, max_resources: 20000,
                            }));
                            let ri = null;
                            try { ri = unwrapItems(await reader.debugItems({ region: debugItemsRegion(ro) })); } catch { ri = null; }
                            const rh = healthWithRedundancy({ obs: ro, items: ri, production: ob.production, goalShape: curGoal });
                            st.healthNow = rh;
                            st.healthBefore = rh;          // ← 见上：它同样失效了
                            st.lastObs = ro;
                            st.handles = buildHandles(ro, ri);
                            tl.push(`      撤销后 ${formatHealth(rh)}`);
                        } catch (e) {
                            tl.push(`      撤销后（读不到：${String(e && e.message ? e.message : e).slice(0, 60)}）`);
                        }
                        /* 撤销后本轮不该再基于「坏世界」的诊断继续走。
                         * 直接进下一轮：重新 observe、重新诊断，让模型在一个**干净**的
                         * 世界上重新决策。这也把「撤销」与「补救」分开 ——
                         * 在同一轮里两件事一起做，会让 transcript 无法分清谁起了作用。 */
                        st.obs = null;
                        st.diagnoses = [mkDiag("WORLD_REVERTED", {
                            layer: "meta",
                            expected: "改动把世界改坏了，已撤销",
                            observed: `第 ${roundNo} 轮 regressive，已恢复到该轮之前`,
                            evidence: { rollback: rec },
                            hint: "上一轮的改动被撤销了。重新诊断后再决定 —— 不要重复同一个动作。",
                        })];
                        tr.write("diagnose", roundNo, {
                            codes: ["WORLD_REVERTED"], fingerprint: fingerprintOf(st.diagnoses), diagnoses: st.diagnoses,
                        });
                        /* ★ 撤销之后给模型看的不是「没有上一步」，而是 `reverted` ★
                         *
                         * 置 null 会让下一轮的 prompt 完全没有 `## LAST STEP`（首轮才那样），
                         * 模型就不知道自己刚才被撤销过 —— 它很可能**再做一遍同样的动作**。
                         * 实测过这个失败模式：没有反馈时模型连续三轮给同一套宏。
                         *
                         * `reverted` 档在 prompt 里说得很明确：「世界已经回到原样，
                         * 不要试图修复 —— 没东西坏了。换一个动作。」 */
                        st.prevNetEffect = {
                            kind: "reverted",
                            why: (after && after.why) || dec.why,
                        };
                        st.lastNetEffect = st.prevNetEffect;
                        /* 撤销那一轮本身不问 LLM（直接 continue）。所以模型第一次看到
                           `reverted` 是在**下一轮** —— 那轮的 roundNetEffect 会是 inert
                           （世界确实没再变）。用这个标记让 reverted 的观感存活一轮，
                           不被 inert 覆盖。详见轮首那段注释。 */
                        st.revertedPending = true;
                        continue;
                    }
                }
                st.prevNetEffect = roundNetEffect;
            } else if (roundNetEffect) {
                st.prevNetEffect = roundNetEffect;
            }

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

            /* ★ 2026-11-02：每轮都查「goal 与世界一致吗」★
             *
             * `diagnose(obs, …, goal, …)` 用 `goal` 判「有没有产线在造它」。
             * 传错 goal ⇒ 它以为旧目标在正常生产 ⇒ 诊断可能变空、也可能全是无关的。
             *
             * 真机踩过（`LIVE-MULTIROUND-RESULT.md`）：runner 硬编码
             * `goal='RuRu----'`，而世界已经升到 level 5（目标 `Cu----Cu`）。
             * loop 报 `NO_DIAGNOSIS`，而真实原因是调用方传错了 ——
             * 那句「这是 loop 的缺陷」把人引向了错误的方向。
             *
             * 检查放在**每轮的轮首**（不是只在空诊断时）：
             * 因为传错 goal 也可能产出**非空但无关**的诊断，
             * 那比空诊断更危险（模型会照着无关的诊断去改）。
             *
             * `obs.goal.requirement.shape` 读不到时**不报**（离线夹具可能没有这个字段）。
             */
            {
                const obsGoal = ob.obs && ob.obs.goal && ob.obs.goal.requirement
                    && ob.obs.goal.requirement.shape;
                if (typeof obsGoal === "string" && obsGoal && obsGoal !== goal) {
                    /* ★ 先分清两种完全不同的情况 ★
                     *
                     *   (a) 调用方传错了 goal（runner 硬编码）—— 这是**配置错误**，
                     *       必须 halt：继续跑只会拿错误的诊断改世界。
                     *   (b) 世界自己在 run 中途升级了 —— 这是**正常进展**，
                     *       halt 等于「赢了一局就死机」，而且会丢掉本 run 已经
                     *       收集到的全部经验。
                     *
                     * 判据是**两个条件同时成立**：
                     *
                     *   ① 记忆里这个世界上次看到的目标 == **调用方传的 goal**；
                     *   ② 世界现在的目标 != 调用方传的 goal（进这个分支的前提）。
                     *
                     * 那说明：调用方没变（还是上次那个目标），是世界自己往前走了 —— 这是升级。
                     *
                     * ⚠️ 这里踩过一个坑：最初写成 `remembered.last_goal === obsGoal`
                     * （记忆里的目标 == 世界现在的目标）。**那个条件恒为假** ——
                     * 如果记忆里已经是 obsGoal，就根本进不了这个分支（前提是
                     * `goal !== obsGoal`）。于是升级检测形同不存在，而且不报任何错。
                     * 正确的对照物是**调用方传的 goal**，不是世界的当前目标。
                     *
                     * 记忆读不到 / 这个世界的第一次 run ⇒ 退化为 halt，
                     * 因为「我们没见过这个目标」与「调用方给错了」无法区分，
                     * 而误判成升级会让 loop 在错误目标上继续改世界（更危险）。 */
                    const obsLevel = Number.isFinite(ob.obs.goal.level) ? ob.obs.goal.level : null;
                    const remembered = memory.worlds && memory.worlds[currentWorldKey || ""]
                        ? memory.worlds[currentWorldKey] : null;
                    const rememberedGoal = (remembered && typeof remembered.last_goal === "string")
                        ? remembered.last_goal.trim() : "";
                    const callerMatchesHistory = !!rememberedGoal && rememberedGoal === goal;
                    const selfMoved = callerMatchesHistory && goal !== obsGoal;
                    if (selfMoved) {
                        /* 世界升级：采纳新目标，本 run 继续。
                         *
                         * 三件事必须同时做，否则会留下不一致的状态：
                         *   ① `st.recipe` 作废 —— 它是**旧目标**的解法，拿它判
                         *      `PROCESSOR_REQUIRED` 会给出错误的机器建议；
                         *   ② 记一条 `GOAL_CHANGED`（不是阻塞诊断，是给模型看的通告）；
                         *   ③ 把「旧目标」带进 evidence —— 模型据此判断哪些带子作废。 */
                        st.goalChanged = {
                            from: remembered.last_goal.trim(), to: obsGoal,
                            level_from: Number.isFinite(remembered.last_level) ? remembered.last_level : null,
                            level_to: obsLevel,
                            round: roundNo,
                        };
                        st.recipe = null;                 // 下一段会按新目标重算
                        curGoal = obsGoal;                // ★ 从这里起，本 run 的目标就是新目标
                        tl.push(`    ⚠ 世界升级：${st.goalChanged.from} → ${obsGoal}`
                            + `（L${st.goalChanged.level_from ?? "?"}→L${obsLevel ?? "?"}）—— 配方作废重算`);
                    } else {
                        const d = mkDiag("GOAL_MISMATCH", {
                            layer: "meta",
                            expected: `goal 与世界的当前目标一致（世界是 "${obsGoal}"）`,
                            observed: `调用方传的是 "${goal}"，而世界当前目标是 "${obsGoal}"`,
                            evidence: { passed_goal: goal, world_goal: obsGoal },
                            hint: "goal 要从 obs.goal.requirement.shape 读，不要硬编码 ——"
                                + " 世界会升级，目标形状跟着变。传错 goal 会让 diagnose() 看错对象。",
                        });
                        tr.write("diagnose", roundNo, { codes: [d.code], fingerprint: fingerprintOf([d]), diagnoses: [d] });
                        st.diagnoses = [d];
                        outcome = "halt"; reason = "GOAL_MISMATCH";
                        break;
                    }
                }
            }

            let diagnoses = diagnose(ob.obs, ob.items, ob.production, st.lastReport, curGoal, st.handles, { recipe: st.recipe });
            /* 观测面的问题（items/production 不可用）与业务诊断并列；它们不导致 halt。 */
            for (const p of ob.problems) if (!diagnoses.some(d => d.code === p.code && d.layer === p.layer)) diagnoses.push(p);

            /* ★ 粘性目标：一直没被解决的关键阻塞，每轮都提到最前 ★
             *
             * ## 为什么需要（第 9 关的「修症状」循环）
             *
             * `MIXER_UNFED` 一出现就说得很清楚：「红矿 44 格外，这是要规划的长支线」。
             * 但每一次新的 observe 都会重算出**当前**的一堆诊断 ——
             * 结构层那些 `BELT_HANDOFF_REJECTED` / `CHAIN_UNFED` 是眼前看得见的红点，
             * 模型每轮都被它们吸引过去，修了 8 轮、`tx=5`，
             * 而**一次都没往红矿那个方向走**。
             *
             * 根因：诊断是「每轮重新拍的快照」，没有「哪件事一直没做成」的概念。
             * 一个需要跨很多轮才能完成的工程，每一轮都会被更近的红点挤到后面。
             *
             * ## 判据（尽量窄）
             *
             * 只钉**成因类**的码（`STICKY_CODES`），且必须连续存在 ≥2 轮才升级成粘性 ——
             * 只出现一轮就消失的诊断多半是上一轮改动的瞬时后果，钉住它反而会误导。
             * 钉住之后每轮强制置顶，直到它消失（= 做成了）或超过 `STICKY_MAX_ROUNDS`
             * （= 判定这条路走不通，放开让模型自由选择）。
             *
             * 这与「必须换动作」那条纪律不冲突：那条管的是**同一个动作**不许重试，
             * 这条管的是**同一个目标**不许被忘掉。 */
            const STICKY_CODES = new Set(["MIXER_UNFED", "PROCESSOR_REQUIRED"]);
            const present = diagnoses
                .filter(d => STICKY_CODES.has(d.code) && d.severity === "blocker")
                .map(d => d.code);
            if (st.stickyGoal) {
                st.stickyGoal.rounds++;
                /* 它还在吗？不在 ⇒ 做成了（或世界变了），解除。 */
                if (!present.includes(st.stickyGoal.code)) {
                    tl.push(`    粘性目标「${st.stickyGoal.code}」已解除（存在 ${st.stickyGoal.rounds} 轮）`);
                    st.stickyGoal = null;
                } else if (st.stickyGoal.rounds > (BUDGET.STICKY_MAX_ROUNDS || 6)) {
                    tl.push(`    粘性目标「${st.stickyGoal.code}」超时解除 —— 这条路走不通，换方向`);
                    st.stickyGoal = null;
                }
            }
            if (!st.stickyGoal) {
                /* 新候选：连续两轮都出现才钉 */
                const prev = st.stickySeen || null;
                const cand = present.find(c => prev && prev.includes(c));
                if (cand) {
                    st.stickyGoal = { code: cand, since: roundNo, rounds: 2 };
                    tl.push(`    粘性目标「${cand}」置顶 —— 它已连续出现，且是成因不是症状`);
                }
                st.stickySeen = present;
            }
            if (st.stickyGoal) {
                /* 置顶：把它挪到数组最前，其余顺序不变。 */
                const i = diagnoses.findIndex(d => d.code === st.stickyGoal.code);
                if (i > 0) diagnoses = [diagnoses[i], ...diagnoses.slice(0, i), ...diagnoses.slice(i + 1)];
            }

            /* ── 残线：在造别的形状 / 或账本里有别的目标的存量 ──
             *
             * ★ 两路证据，互补而不是重复 ★
             *
             * · `findObsoleteLines`（60 秒产出窗口）—— 「旧线**还活着**」。
             *   这是**唯一能及时拦住它**的时刻：线还在跑，拆掉损失最小。
             * · `findStoredObsolete`（`hub.stored_shapes` 累计账本）—— 「旧线**已经停了**」。
             *   窗口归零之后窗口法一条都报不出来，而用户贴图那次正是这个形态
             *   （0 条入口带子有货）。账本跨关不清零，是那时的唯一证据。
             *
             * 只有前者时，最需要诊断的场景恰恰是盲的 —— 这是交叉评审指出、
             * 我实测确认过的真缺陷，不是阈值问题。
             *
             * 它**不冲突**于 `NO_PRODUCTION`：那条让模型去**建**，这条让它先**拆**。
             * 动作方向相反的两件事合成一条，模型会在两者间摇摆。 */
            /* 传 `recipe`：配方闭包里的形状是**必经的中间产物**，不是残线。
               真机实测（2026-11-09，目标 Cu------）：不传会报出 `----CuCu`，
               而它是 mine→cut 的中间形态 —— 报成残线会让模型去拆一条正常工作的链。 */
            const residualWindow = findObsoleteLines(ob.production, curGoal, { recipe: st.recipe });
            const residualStored = findStoredObsolete({
                hub: ob.obs && ob.obs.hub, goalShape: curGoal, recipe: st.recipe,
                /* ★ 只有确认换过关才认账本证据 ★
                 * `stored_shapes` 里有**所有更早关卡**的遗留物（L4 上就有
                 * CuCuCuCu / ----CuCu）。不要求「确实换关」的话，每个世界都有残线证据 ⇒
                 * 授权拆除恒成立 ⇒ 回滚永不触发（实测把 E11 打红了）。 */
                levelChanged: !!st.goalChanged,
            });
            /* 合并成一张「该拆的线」清单（供 prompt 与授权拆除共用）。
               同一形状只留一条：窗口证据优先（它是活的，更紧迫）。 */
            const residual = [...residualWindow];
            const seenShape = new Set(residual.map(r => r.shape));
            for (const s of residualStored) {
                if (!seenShape.has(s.shape)) { residual.push(s); seenShape.add(s.shape); }
            }
            /* 只在**换关那一轮**把窗口证据变成诊断。
             *
             * 为什么不每轮都报：残线在拆掉之前每轮都存在，每轮一条诊断会
             * 吃掉预算、还会稀释真正重要的那几条。而「换关」是它第一次
             * 值得被点名的时刻 —— 那时模型最容易继续在旧线上修。 */
            if (st.goalChanged && residualWindow.length) {
                for (const line of residualWindow) {
                    /* ★ 必须给句柄，否则这条诊断无法施工 ★
                     *
                     * 原来 `evidence.handles` 是空的：模型读到「有一条该拆的线」，
                     * 却没有任何句柄能交给 `remove_run`。同一轮的 `PROCESSOR_REQUIRED`
                     * 却给了 `stream_handles` —— 差别不在模型，在我们这边。
                     *
                     * `beltsCarryingShape` 从形状传播里把「哪些带子正在搬这个形状」
                     * 拿回来（产出窗口只有形状名，没有位置）。拿不到就照旧留空，
                     * 不编。 */
                    const lineHandles = beltsCarryingShape(ob.obs, st.recipe, line.shape, st.handles, { max: 8 });
                    diagnoses.push(mkDiag("OBSOLETE_LINE", {
                        layer: "L4",
                        severity: "warn",
                        subject: lineHandles.length
                            ? (subjectOf(st.handles, null, lineHandles[0]) || { handle: lineHandles[0], type: "belt" })
                            : { handle: null, type: null },
                        expected: `产线在造目标形状 ${curGoal}`,
                        observed: describeObsoleteLine(line, curGoal)
                            + (lineHandles.length
                                ? `（这条线现在跑在 ${lineHandles.slice(0, 4).join(" / ")} 上）`
                                : ""),
                        handles: lineHandles,
                        evidence: {
                            shape: line.shape, produced: line.produced, delivered: line.delivered,
                            share: line.share, ratio: line.ratio, goal: curGoal,
                            stream_handles: lineHandles,
                        },
                        hint: lineHandles.length
                            ? "这条线服务的是别的形状。它还在挖、还在切、还在占着地方，而产出全部堆积或倒掉。"
                                + "把 `ev.handles` 的句柄交给 remove_run 拆掉，或交给 replace_run 改成产出目标。"
                            : "这条线服务的是别的形状。要么把它拆掉腾出空间，要么改道让它产出目标；"
                                + "在它上面继续修堵塞不会有产出。",
                        candidates: ["remove_run", "trash_unused", "replace_run"],
                    }));
                }
            }

            /* ── 换关通告：本次 run 中途世界升级了 ──
             *
             * 只在**刚发生的那一轮**加一次（`st.goalChanged` 已置位且本轮首次）。
             * 它的作用是把「目标换了」这件事明确摆到模型面前 —— 光靠
             * `PRODUCTION` 段那句「产的不是目标」不够，因为模型会以为那只是暂时的。 */
            if (st.goalChanged && !st.goalChangedAnnounced) {
                st.goalChangedAnnounced = true;
                diagnoses.push(mkDiag("GOAL_CHANGED", {
                    layer: "L4",
                    expected: `本次 run 的目标是 ${goal}`,
                    observed: `世界从 ${st.goalChanged.from} 升到了 ${st.goalChanged.to}`
                        + `（level ${st.goalChanged.level_from ?? "?"} → ${st.goalChanged.level_to ?? "?"}）`,
                    evidence: {
                        from: st.goalChanged.from, to: st.goalChanged.to,
                        level_from: st.goalChanged.level_from, level_to: st.goalChanged.level_to,
                        round: st.goalChanged.round,
                    },
                    hint: "目标换了，配方已按新目标重算。服务旧目标的那条线现在是残线 ——"
                        + "先拆它，或者把它改道；不要继续在旧线上修。",
                    candidates: ["remove_run", "replace_run", "connect"],
                }));
            }

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
            /* ★ 指纹里排除「环境性诊断」★
             *
             * `NO_PROGRESS_3X` 的判据是「同一个指纹第 3 次出现 ⇒ halt」。
             * 它要抓的是「模型反复撞同一个墙」，所以指纹必须只含**能被模型改变**的东西。
             *
             * `OBSOLETE_LINE` / `GOAL_CHANGED` 不是那种东西：
             *   · 残线在拆掉之前**每轮都会存在**。它进指纹 ⇒ 第 3 轮必然 halt ——
             *     而那时模型可能刚开始动手拆，等于在它来得及行动前就判死。
             *   · `GOAL_CHANGED` 只在换关那一轮出现一次，但它描述的是**世界自己**
             *     做的事（升级），把这个算进「模型没进展」的计数是错的。
             *
             * `OBSOLETE_LINE` 仍会渲染进 prompt、仍占一个诊断编号，只是不参与
             * 「同一指纹出现了几次」这个计数。 */
            const ENV_CODES = new Set(["OBSOLETE_LINE", "GOAL_CHANGED"]);
            const fpDiags = diagnoses.filter(d => d && !ENV_CODES.has(d.code));
            /* 全是环境码时退回全量：空列表的指纹是常量，那会让第 3 轮必然 halt
               （每次都"同一个指纹"）。这时宁可让指纹包含它们。 */
            const fpNow = fingerprintOf(fpDiags.length ? fpDiags : diagnoses);
            tr.write("diagnose", roundNo, { codes: diagnoses.map(d => d.code), fingerprint: fpNow, diagnoses });
            tl.push(`    诊断 ${diagCounts(diagnoses)} (fp ${String(fpNow).replace(/^sha256:/, "").slice(0, 10)})`);
            st.diagnoses = diagnoses;

            /* 轮首计数：同一世界诊断第 3 次出现 ⇒ **在花掉这一轮的 LLM 调用之前**停；
               第 2 次则强制换动作（候选宏由 countFingerprint 写进 st.candidatesOverride）。 */
            /* ★ 必须传**过滤后**的列表 ★
             *
             * `countFingerprint` 内部自己调 `fingerprintOf`。上面刚把
             * `OBSOLETE_LINE` / `GOAL_CHANGED` 排除出指纹 —— 如果这里传全量，
             * 那次排除就白做了：残线仍然每轮进计数，第 3 轮照样 halt。
             * （这类「算了但没用上」的 bug 在本项目出现过，所以显式写出来。） */
            const seenNow = countFingerprint(fpDiags.length ? fpDiags : diagnoses, roundNo);
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
                        goal: curGoal, obs: ob.obs, handles: st.handles,
                        /* ★ 必须显式传：production 是 `observeOnce()` 的**第三个字段**
                           （`ob.production`），不在 `ob.obs` 里。过去这里漏了它，于是
                           prompt 每一轮都渲染 `unavailable`，模型永远看不见产线真实速率。 */
                        production: ob.production,
                        /* ★ 带上货量（`itemsOnBelts`）—— 与 production 同一个「第三个字段」★
                         *
                         * 2026-11-20 真 LLM 实测：L12 上 `produced_total`/`delivered_total`
                         * 都是空，CAPACITY 于是说「no goods are moving at all」。
                         * 而 `ob.items` 里明明有 376 件货在带上跑。
                         *
                         * 那句错话会让模型**重建一条本来好好的线**。有了这个数，
                         * 交付闸就能分清「真的没动」与「动了但没到 hub」——
                         * 两者要修的位置在产线的两端，完全不同。
                         *
                         * 口径与 `health.mjs` 的 `items_on_belts` 一致：数
                         * `items.paths[].itemsOnPath`，那是游戏自己数的。 */
                        itemsOnBelts: itemsOnBeltsOf(ob.items),
                        /* ★ `items` 是进度读数的数据源（2026-11-22）★
                         *
                         * `progressLedger` 靠 `items.belts[].item` 判「带上有没有这个形状」，
                         * 而那是游戏自己给的真实货物字符串 —— 不是形状传播推算。
                         *
                         * 实测（506 个 L12 快照）：本关目标形状**一次都没出现过**，
                         * 而模型每一轮都在修一条 2026-11-16 就冻结的 L11 产线。
                         * 不加这个参数，那行永远不出现（`buildPrompt` 里有个
                         * `itemsDoc ? … : null` 的门），功能等于没做。 */
                        items: ob.items,
                        diagnoses,
                        candidates: cands,
                        lastRound: st.lastPlanSummary || null,
                        /* 本次 run 的任务日志（跨轮目标坚持，见 st.runLog 的注释）。 */
                        runLog: st.runLog,
                        /* 粘性目标：需要跨多轮才能完成的成因，别被更近的红点挤掉。 */
                        stickyGoal: st.stickyGoal,
                        /* ★ 上一步的净效果（2026-11-03）★
                         *
                         * `lastRound` 只说「上一轮调了什么宏、verify 红在哪」，
                         * 它**不含「世界因此变好还是变坏」**。实测的后果：模型可以连续
                         * 三轮把死带子从一处挪到另一处，每轮 verify 都红、
                         * 每轮都不知道自己刚刚让局面更糟了。
                         *
                         * 这里给的是**机器算出来的判定**（`classifyNetEffect`），不是模型自评。
                         * `null`（首轮）＝ prompt 里整段不出现。 */
                        lastNetEffect: st.lastNetEffect || null,
                        /* ★ 跨 run 记忆（2026-11-03）★
                         *
                         * 只给**本目标**下的历史（`attemptsForGoal` 按 `goal_shape` 分组）。
                         * 并且剔除本次 run 已经用过的动作集 —— 那些由 `## LAST ROUND`
                         * 负责讲，「历史」段重复它们只是浪费预算。
                         *
                         * 注意 goal 用的是**调用方传的** `goal`；它与世界的当前目标是否
                         * 一致由轮首的 `GOAL_MISMATCH` 检查保证（不一致会直接 halt）。 */
                        priorAttempts: priorAttemptsFor(curGoal, currentWorldKey),
                        /* 换关通告与残线清单：让模型知道「目标换了」以及「哪条线该拆」。
                           两者都由本轮的诊断侧算好（`findObsoleteLines`），
                           prompt 只负责渲染，不重算 —— 否则两处口径会漂移。 */
                        goalChanged: st.goalChanged || null,
                        obsoleteLines: residual,
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
                             * 再高不涨（`STATE_BELTS_MAX = 12` 是独立上限）。
                             *
                             * ★ 2026-11-15 夜：in_chars_max 从 16000 提到 24000 ★
                             *
                             * 世界膨胀到 524 实体 / 59 台机器 / 485 条带子之后，
                             * 光是**不可截断**的部分（S1 规则 4725 + S2 卡片 1618 +
                             * 8 条诊断 1611 + S5 上一轮 + 目标/配方）就把 16000 吃满：
                             *
                             *   真机 16529 > 16000 ⇒ `PROMPT_OVER_BUDGET` ⇒
                             *   整个 run `outcome:INTERNAL`，只跑了 2 轮就停。
                             *
                             * 我加了三道降级兜底（压机器表到 0、压带子到 0、压诊断 hint），
                             * 全都压到底了还是超 —— 因为超的部分**按契约不许截断**。
                             *
                             * 这时候正确做法不是继续截，而是把上限调大：契约说
                             * 「宁可直接抛错，也不静默丢目标」，前提是「抛错」意味着
                             * 「这个 prompt 真的装不下」，而不是「我们自己把预算定小了」。
                             * 24000 字符 ≈ 7000 token，远在模型窗口之内。 */
                            in_chars_max: 24000,
                            /* ★ 4600 → 5300（2026-11-21，真机验证之后）★
                             *
                             * 4600 是当年「`when:` 行不出现 + 带子名额基本用满」调出的平衡点。
                             * 但世界变了 —— 增加 `HUB stored` 段、矿种/距离标注、压缩后的
                             * 挖矿缺口提示之后，4600 已经养不起四样东西。
                             *
                             * 真机实测（L12，`r-20261121100232-d10f` 同 obs）：
                             *
                             *   tok=4600 → 带子 10 条 / CAPACITY 无 / HUB stored 无 / 挖矿提示 有
                             *   tok=4800 → 带子 10 条 / CAPACITY 有 / HUB stored 无 / 挖矿提示 无
                             *   tok=5300 → 带子 16 条 / CAPACITY 有 / HUB stored 有 / 挖矿提示 有
                             *
                             * 也就是说 4600 那个「够用」是假象 —— 它靠**牺牲 6 条带子**换来
                             * 表面不超预算。而带子是模型**唯一能就地改造**的东西，
                             * 我们花了几轮专门保护它（`prompt.mjs` 里那段「带子优先」）。
                             *
                             * 5300 档的实测总长度 18296 字符 ≈ 5227 token，
                             * 远在一个 20 万 token 窗口之内。用 600 token 换 6 条带子 +
                             * 两条直接关系到「这一关能不能做出来」的事实，账很清楚。
                             *
                             * ⚠️ 这不是「调到测试通过为止」：4800 档我试过，它把
                             * 「没有矿机挖白色颜料」那句挤掉了，而 `CwCwCwCw` 正需要白颜料 ——
                             * 那一条比 HUB stored 更硬。两个都要，就得给够预算。 */
                            prompt_tokens_max: 5300,
                            /* 实验开关（默认 false）：强制「一轮一个动作」。
                               由 `--force-one-call` 或 `budget.FORCE_ONE_CALL` 打开。
                               见 prompt.mjs 里 INSTRUCTION_SINGLE 的注释。 */
                            forceOneCall: opts && opts.forceOneCall === true,
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

                /* timeline：模型说了什么、要调什么。`say` 是模型自己的话（已过坐标 lint），
                   它是排查时最有信息量的一行 —— 「它当时到底以为自己在干什么」。 */
                if (parsed && parsed.ok && parsed.plan) {
                    const say = typeof parsed.plan.say === "string" ? parsed.plan.say.replace(/\s+/g, " ").trim() : "";
                    /* ★ 参数必须进日志 —— 只写宏名等于什么都没说 ★
                     *
                     * 实测（验证 agent）：「调用 connect,connect,connect」+「tx ✓ applied 2/2」
                     * 能看出它试了三次、成了两次，但**看不出它指的是哪些格子/端口**。
                     * 而 L12 的全部失败模式就是端口绑定（`ambiguous_port` /
                     * `port_already_bound`）—— 唯一能解释失败的那个字段恰好没打。
                     *
                     * 压缩成一行：`connect B107→C4{color,0}` 这种。
                     * 只取 `from`/`to`/`at`/`uids`/`machine`/`facing` 这几个有信息量的键，
                     * 其余丢掉 —— 这是给人读的，不是序列化。 */
                    const brief = (v, depth = 0) => {
                        if (v === null || v === undefined) return "?";
                        if (typeof v === "string") return v;
                        if (typeof v === "number" || typeof v === "boolean") return String(v);
                        if (depth > 1) return "…";
                        if (Array.isArray(v)) return `[${v.slice(0, 3).map(x => brief(x, depth + 1)).join(",")}${v.length > 3 ? ",…" : ""}]`;
                        if (typeof v === "object") {
                            if (typeof v.$ref === "string") return v.$ref;
                            if (typeof v.$ore === "string") return `$ore:${v.$ore}`;
                            if (v.port !== undefined) {
                                const p = v.port;
                                const ps = typeof p === "object" && p
                                    ? `${p.role || ""}${p.index !== undefined ? `,${p.index}` : ""}`
                                    : String(p);
                                return `${brief(v.cell ?? v.uid ?? v.$ref ?? "?", depth + 1)}{${ps}}`;
                            }
                            if (v.cell !== undefined) return `@${brief(v.cell, depth + 1)}`;
                            return Object.keys(v).slice(0, 3).map(k => `${k}:${brief(v[k], depth + 1)}`).join(",");
                        }
                        return String(v);
                    };
                    const argOf = (c) => {
                        const a = (c && c.args) || {};
                        const bits = [];
                        if (a.from !== undefined) bits.push(brief(a.from));
                        if (a.to !== undefined) bits.push("→" + brief(a.to));
                        if (a.at !== undefined) bits.push("@" + brief(a.at));
                        if (a.uids !== undefined) bits.push(`uids=${brief(a.uids)}`);
                        if (a.region !== undefined) bits.push(`region=${brief(a.region)}`);
                        if (a.machine !== undefined) bits.push(String(a.machine));
                        if (a.facing !== undefined) bits.push(`facing:${a.facing}`);
                        if (a.opts && typeof a.opts === "object") {
                            const keys = Object.keys(a.opts).filter(k => a.opts[k] === true);
                            if (keys.length) bits.push(`{${keys.join(",")}}`);
                        }
                        return bits.join(" ");
                    };
                    const calls = (parsed.plan.calls || []).map(c => {
                        const w = typeof c.why === "string" && c.why.trim() ? `"${c.why.replace(/\s+/g, " ").trim()}"` : "";
                        const args = argOf(c);
                        return `${c.macro}${args ? " " + args : ""}${w ? " " + w : ""}`;
                    });
                    tl.push(`    模型 ${calls.join(" ; ") || "(无调用)"}${say ? `\n         say: ${say}` : ""}`);
                } else if (code) {
                    tl.push(`    模型 ✗ ${code}`);
                }

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
                /* ★ partial 由 `budget.PARTIAL_APPLY` 控制（2026-11-02）★
                 *
                 * 为什么走 budget 而不是加一个新参数：
                 * `runLoop` 的 opts 已经有一堆开关（dryRun / apply / recipeSpawn…），
                 * 再加一个会让调用方多记一个名字。而 `budget` 本来就是「这次 run 的
                 * 行为参数」的容器（它已经含 LLM_CALLS_MAX / ROUNDS_MAX 等）。
                 *
                 * **默认 `true`（2026-11-02 起）** —— `BUDGET.PARTIAL_APPLY: true`。
                 * 理由与风险见 `constants.mjs` 里那段的完整说明。
                 * 想关掉：`budget: { PARTIAL_APPLY: false }`。
                 *
                 * ⚠️ 这条注释上一版写的是「默认 false，现有测试与真机行为完全不变」——
                 * 那是在还没决定打开时写的。现在打开了，所以真机行为**确实变了**：
                 * 部分执行会提交、判据会判 `PARTIAL_APPLY`。 */
                const partialApply = budget.PARTIAL_APPLY === true;

                /* ★ `upgrade` 是唯一**不经过 buildTxPlan** 的宏 ★
                 *
                 * 另外七个宏的产物是 op 列表（place / delete），经 tx 落盘、经 verify 对账。
                 * 升级不增删任何实体，没有任何 op 可以生成 —— 它花 hub 里的库存改全局倍率，
                 * 走的是 mod 的顶层 RPC `upgrade{id}`。
                 *
                 * 硬把它塞进 `buildTxPlan` 会有三个坏结果：
                 *   ① `buildTxPlan` 是**同步纯函数**（它要被指纹/测试反复调用），而 RPC 是异步的；
                 *   ② 它会产出一个 `ops: []` 的 tx —— 那个空 tx 仍然会被 verify 判成
                 *      `NO_WORLD_CHANGE`，于是一次**成功的升级**会被记成失败；
                 *   ③ `partial` 模式的可撤销判据（「产物全是 place/delete 带子」）对它会恒真，
                 *      升级于是被当成「可撤销动作」，而它扣掉的形状**拿不回来**。
                 *
                 * 所以在这里把 `upgrade` 拆出去先执行：它有自己的结果信封，
                 * 成功与否都原样记进 plan 行，剩下的调用照常走 tx。 */
                const upCalls = parsed.plan.calls.filter(c => c && c.macro === "upgrade");
                const txCalls = parsed.plan.calls.filter(c => c && c.macro !== "upgrade");
                const upgradeResults = [];
                /* 参数校验失败 ⇒ 不再走下面的 upgrade-only 分支（那会把
                   `lastPlanSummary` 覆盖成 `upgrade_failed`，把真实的拒绝码弄丢）。 */
                let upgradeArgsRejected = false;
                for (const uc of upCalls) {
                    let ur = null;
                    /* ★ 参数必须先过契约校验 —— 升级绕过了 buildTxPlan ★
                     *
                     * 真机实测（2026-11-13，产线跑到 537/600 时）：模型写
                     *   `upgrade {machine: {$ref:"C2"}}`
                     * —— 它以为升级是**针对某台机器**的（合理的误解：
                     * 「提升 painter 的吞吐」听起来就是升级那台机器）。
                     *
                     * 而 `upgrade` 在 `buildTxPlan` **之前**执行（它不产生 op，
                     * 走顶层 RPC），所以它从未经过 `validateMacroCall`。
                     * 参数错误于是只在 `upgradeLine` 内部爆掉，而那里的失败
                     * 只记进 `upgradeResults`，**从来没有当作 plan 拒绝报给模型**。
                     *
                     * 结果：整轮 `outcome=error reason=INTERNAL`，模型连
                     * 「允许的参数：id, opts」这句 hint 都没看到 ——
                     * 而那句话是宏早就写好的。
                     *
                     * 这里补上前置校验：失败就按正常的 plan 拒绝路径走，
                     * 让 hint 进 LAST ROUND，模型下一轮就知道该写什么。 */
                    const vc = validateMacroCall("upgrade", uc.args || {});
                    if (!vc.ok) {
                        const d = mkDiag("LLM_ARGS", {
                            layer: "plan", stage: "macro_args",
                            expected: "upgrade 的参数在契约里",
                            observed: `${vc.error.code}: ${vc.error.message}`,
                            hint: vc.error.hint || "允许的参数：id, opts",
                            evidence: { macro: "upgrade", args: Object.keys(uc.args || {}) },
                            candidates: ["upgrade"],
                        });
                        tr.write("plan", roundNo, {
                            ok: false, rejected: d, stage: "macro_args",
                            calls: parsed.plan.calls.map(c => c.macro),
                            tx_plan: null, ops: 0,
                        });
                        st.diagnoses = [d];
                        st.lastMacros = parsed.plan.calls.map(c => c.macro);
                        st.lastExecutedMacros = [];
                        st.lastPlanSummary = {
                            round: roundNo, calls: st.lastMacros.slice(),
                            verify: { checks: [], codes: ["LLM_ARGS"] },
                            decision: "plan_rejected",
                            failures: [{ macro: "upgrade", code: vc.error.code, hint: vc.error.hint || null }],
                        };
                        /* ★ 设标记后 `break`，并让外层知道这一轮已经处理完 ★
                         *
                         * `break` 只是跳出内层 LLM 重试环。回到外层的 `if (!planned)`
                         * 分支时，那条分支会读 `st.lastPlanSummary` 决定 outcome。
                         *
                         * ⚠️ 这里踩过一个坑：`innerDecided = true` 时外层会 `break`
                         * 出整个 run，而 `outcome`/`reason` 还停在**初始化值**
                         * （`error` / `INTERNAL`）—— 真机那次就是这么变成
                         * `outcome=error reason=INTERNAL` 的，模型什么都没看到。
                         *
                         * 所以现在外层那条分支会从 `lastPlanSummary` 里取真实的
                         * decision 和 codes 来定 outcome。这里只要保证两者的形状对得上：
                         * `decision: "plan_rejected"` + `verify.codes: [真实码]`。 */
                        upgradeArgsRejected = true;
                        innerDecided = true;
                        break;
                    }
                    /* ★ `dryRun` 必须在这里拦，不能等到 tx 阶段 ★
                     *
                     * 红队实测（2026-11-13）：`--dry-run` 模式下模型提议
                     * `upgrade{id:…}`，`reader.upgrade({id})` **照样发出去了**，
                     * hub 库存真的被扣（`upgrade 的真实购买次数 = 1`）。
                     *
                     * 原因是升级在**第 3615 行**执行，而 `ctx.dryRun` 的闸门在
                     * **第 3856 行** —— 中间隔了 240 行，那条闸门管的是 tx 写入。
                     * 升级不走 tx，于是整条 dry-run 契约对它失效。
                     *
                     * `LoopOpts.dryRun` 的注释写的是「只跑到 plan，**世界零写入**」。
                     * 而升级是不可逆的库存支出 —— 恰恰是 dry-run 最该保护的那类动作。
                     * 任何用 `--dry-run` 做的验证跑，只要模型提议升级，就会真扣库存。 */
                    if (opts && opts.dryRun === true) {
                        upgradeResults.push({
                            ok: true, macro: "upgrade", id: (uc.args && uc.args.id) || null,
                            bought: false, spent: [], would_spend: null,
                            reason: "dry-run: not sent",
                            dry_run: true,
                        });
                        continue;
                    }
                    try {
                        ur = await upgradeLine(uc.args || {}, { reader });
                    } catch (e) {
                        ur = {
                            ok: false, macro: "upgrade",
                            error: { code: "INTERNAL", message: `upgrade 抛异常：${e && e.message ? e.message : e}` },
                        };
                    }
                    upgradeResults.push(ur);
                    /* ⚠️ 这里**不能**用 `tr.write("macro", …)`：`RUN_KINDS` 是闭集
                       （契约 §1.4），未知 kind 会直接抛，把一次正常的 run 变成 INTERNAL。
                       升级的结果记在 `plan` / `apply` 行里（`upgrades` 字段），
                       那本来就是「这一轮规划了什么、落盘了什么」的归属地。 */
                }
                /* 只有升级、没有别的调用 ⇒ 不进 tx 流水线，直接把结果记成本轮。 */
                if (!upgradeArgsRejected && txCalls.length === 0 && upCalls.length > 0) {
                    const anyOk = upgradeResults.some(u => u && u.ok === true);
                    const bought = upgradeResults.filter(u => u && u.bought === true);
                    st.lastMacros = ["upgrade"];
                    st.lastExecutedMacros = bought.map(u => "upgrade");
                    st.lastPlanSummary = {
                        round: roundNo, calls: ["upgrade"],
                        verify: { checks: [], codes: [] },
                        decision: anyOk ? "upgrade_only" : "upgrade_failed",
                        upgrades: upgradeResults.map(u => ({
                            ok: !!(u && u.ok), id: (u && u.id) || null,
                            bought: !!(u && u.bought),
                            reason: (u && u.reason) || (u && u.error && u.error.message) || null,
                        })),
                    };
                    /* 买了东西就是世界状态变了 —— 下一轮要重新观测，
                       不能因为「没有 op」就被 `NO_WORLD_CHANGE` 判成没进展。 */
                    if (bought.length) st.upgradesBought = (st.upgradesBought || 0) + bought.length;
                    /* ★ 必须 `break` 到**外层轮循环**，不能 `continue` 内层 ★
                     *
                     * 红队实测（2026-11-13）：这里原来是 `continue`，而它在一个
                     * 12 空格缩进的**内层 LLM 重试环**里（第 3449 行）—— 不是外层
                     * 轮循环（第 2790 行，8 空格缩进）。
                     *
                     * `continue` 于是跳回「再问一次 LLM」，而**不消耗轮次**：
                     *   · `st.rounds` 不推进 ⇒ `ROUNDS_MAX` 可被 upgrade-only 轮绕过；
                     *   · 那一轮没有 `healthBefore`/`healthAfter` 快照 ⇒
                     *     `netEffects` 里完全没有它 ⇒ `c2f6a48` 修的
                     *     `classifyNetEffect` 升级分支在这条路径上**从不被调用**；
                     *   · `worldTouched` 恒 false ⇒ 收尾不重观测 ⇒
                     *     `run_total` 判 `inert`（「世界没有任何变化」），
                     *     而 hub 库存实实在在少了 —— 与事实相反。
                     *
                     * 那次的实测输出：`rounds=1 / net_effects=[] / run_total=inert /
                     * preserved.world_state="untouched"`，而升级真的买了。
                     *
                     * 设 `innerDecided` 后 `break` ⇒ 走「内层已定 outcome」那条出口
                     * 回外层，轮次正常推进，下一轮重新观测时自然会把库存变化算进去。 */
                    innerDecided = true;
                    break;
                }
                /* 只把**剩下的**调用送进 tx 流水线。用局部变量而不是改 `parsed`
                   （它是 `const`，而且下游还有多处读它，重赋值会静默分成两份真相）。 */
                const txPlan0 = { ...parsed.plan, calls: txCalls };

                const p = buildTxPlan(txPlan0, ob.obs, ob.items, st.handles, { partial: partialApply });
                if (!p.ok) {
                    tr.write("plan", roundNo, {
                        ok: false, rejected: p.diagnosis, stage: p.stage,
                        calls: parsed.plan.calls.map(c => c.macro),
                        tx_plan: null, ops: 0,
                        /* ★ 已经执行过的升级必须单独记下来 ★
                         *
                         * 升级在 `buildTxPlan` **之前**就落盘了（它不走 tx），
                         * 所以 tx 侧被拒**不会**撤销它。真机实测
                         * （r-20261113180132-31ba，2026-11-13）：
                         * 模型同一批提了 `upgrade{id:"painting"}` + 一条 `connect`，
                         * connect 因 `bad_type` 被拒 ⇒ 整批判 `NO_REVERSIBLE_CALL`，
                         * plan 行只写了 `calls:[upgrade, connect]` + 拒绝原因。
                         * 而实机上 painting **已经从 L0 变成 L1** —— 库存扣了、倍率涨了。
                         *
                         * 后果不是「数据不好看」：run 结束时的净效果判成 `inert`
                         * （「世界没有任何变化」），因为没有任何 op 落地。于是
                         * **一次真实的、不可逆的库存支出，在 transcript 里不存在**。
                         * 下次排查会看到「模型说要买升级 → 计划被拒 → 什么都没发生」，
                         * 与事实正好相反。
                         *
                         * 这是本项目最高频缺陷（「算出来 ≠ 送到」）的镜像：
                         * 这次是「做了 ≠ 记下」。 */
                        ...(upgradeResults.length ? {
                            upgrades: upgradeResults.map(u => ({
                                ok: !!(u && u.ok), id: (u && u.id) || null,
                                bought: !!(u && u.bought),
                                spent: (u && u.spent) || [],
                                reason: (u && u.reason) || (u && u.error && u.error.message) || null,
                            })),
                        } : {}),
                    });
                    st.diagnoses = [p.diagnosis];
                    st.lastMacros = parsed.plan.calls.map(c => c.macro);
                    /* ★ plan 阶段被拒也必须进 timeline ★
                     *
                     * 这条路径**不走 `settleFailure`** —— 它自己设 st.* 然后 break，
                     * 所以我在 settleFailure 里加的那段日志在这里永远不触发。
                     * 实测（验证 agent）：4 个 run 里 **11 次 plan 被拒、0 条日志**；
                     * 而 547 个 run 的语料里 plan 被拒有 1477 次，
                     * 占全部失败的 57% —— **最该复盘的那一类，日志里一个字都没有**。
                     *
                     * 模型想做什么、被哪条闸拦、它拿到了什么提示 —— 这三样
                     * 才是「AI 怎么想的」的核心，而现在只存在于机器格式里。 */
                    try {
                        const rej = p.diagnosis || {};
                        tl.push(`    ✗ 未落地 [plan] ${rej.code || "?"}  调用 ${st.lastMacros.join(",") || "none"}`);
                        if (typeof rej.observed === "string" && rej.observed) {
                            tl.push(`      ${rej.observed.slice(0, 200)}`);
                        }
                        if (typeof rej.hint === "string" && rej.hint) {
                            tl.push(`      → ${rej.hint.slice(0, 200)}`);
                        }
                        /* 哪一个调用真的失败了 —— 上面那段 `failures` 已经算过，
                           这里只把结论摊到人读日志里。 */
                        const ev = rej.evidence || {};
                        const sk = Array.isArray(ev.skipped) ? ev.skipped : [];
                        if (sk.length) {
                            tl.push(`      跳过的调用 ${sk.map(s => `${s.macro}:${s.code || s.reason}`).join(", ")}`);
                        }
                    } catch { /* 日志不该有搞坏 run 的能力 */ }
                    /* plan 阶段被拒 ⇒ **一条 op 都没生成** ⇒ 没有任何宏真正执行过。
                       清空：下一轮的「必须换动作」不该剔除这些（它们没被检验过）。 */
                    st.lastExecutedMacros = [];
                    st.lastPlanSummary = {
                        round: roundNo, calls: st.lastMacros.slice(),
                        verify: { checks: [], codes: [p.diagnosis.code] }, decision: "plan_rejected",
                        /* ★ 2026-11-02 修：只给**真正失败的那个**宏挂 hint ★
                         *
                         * 红队（`REDTEAM-PARTIAL-APPLY.md` §Q4.1）指出我上一版
                         * 把 `p.diagnosis.hint` 复制给了**每一个**宏 ——
                         * 那会让模型以为 4 个调用都撞了同一个错，而实际只有第 N 个。
                         *
                         * 现在直接用 `evidence.call_index`（本轮刚结构化的）：
                         *   · 第 `call_index` 个 → 带 code + hint（它真的失败了）
                         *   · 其余           → 标 `unverified`，不给 hint
                         *     （它们**根本没被检验**，不是「也失败了」）
                         *
                         * 这个区分很重要：`unverified` 的宏下一轮**不必换**，
                         * 而失败的那个**必须换**。混在一起会让模型整批重写。 */
                        failures: (() => {
                            const ev = (p.diagnosis && p.diagnosis.evidence) || {};
                            const failIdx = typeof ev.call_index === "number" ? ev.call_index : -1;
                            /* ★ `observed` 必须一起交给模型 ★
                             *
                             * 原来只传 `{macro, code, hint}`。对宏自己的失败够用
                             * （code 就说清了是 `occupied` 还是 `no_path`），
                             * 但**预演闸门**（`stage:"simulate"`）的全部信息量都在
                             * `observed` 里：「到 hub 的带子 254 → 232（-22），
                             * 死带子 282 → 311」。只给 `code:"PLAN_REJECTED"` 加一句
                             * 「会让世界明显变差」，模型不知道自己那一步**有多**糟，
                             * 下一轮换个写法接着试 —— 第 9 关实测就是这么循环的。
                             *
                             * 这是本项目最高频的缺陷形态（「算出来 ≠ 送达」）的第 N 次复发：
                             * 数字算出来了、写进了 diagnosis，却没进 prompt。 */
                            const observed = (p.diagnosis && typeof p.diagnosis.observed === "string"
                                && p.diagnosis.observed) ? p.diagnosis.observed : null;
                            /* ★ 哪些宏**真的**失败了：`call_index` 或 skipped 名单 ★
                             *
                             * `MACRO_REFUSED` 这类单调用失败带 `call_index`；
                             * 而 `NO_REVERSIBLE_CALL` 是**多调用汇总**诊断，
                             * 它的 evidence 里**没有** `call_index`，只有
                             * `skipped: [{macro, reason, code, candidates}]`。
                             *
                             * 上一版只认 `call_index` ⇒ 汇总诊断下 `failIdx === -1`
                             * ⇒ **每个宏都被标成 `unverified`**，于是：
                             *   · 模型看到「都没被检验」，以为不必换（实际全失败了）；
                             *   · 挂在那里的 candidates 永远渲染不出来。
                             * 实测第 9 关 r-20261112155503-1dae：连 3 轮 ambiguous_port，
                             * evidence 里明明有 {role,index}，模型一次都没看到。 */
                            const sk = Array.isArray(ev.skipped) ? ev.skipped : [];
                            const failedNames = new Set(sk
                                .filter(s => s && s.reason === "macro_failed")
                                .map(s => s.macro));
                            return st.lastMacros.map((m, k) => {
                                const failed = (failIdx >= 0) ? (k === failIdx) : failedNames.has(m);
                                if (!failed) return { macro: m, code: "unverified", hint: null };
                                const hit = sk.find(s => s && s.macro === m);
                                /* ★ 用**宏自己的**错误码，不是汇总诊断的码 ★
                                 *
                                 * `NO_REVERSIBLE_CALL` 只说明「没有可撤销的调用」，
                                 * 它对「该怎么改」零信息。真正有用的是宏报的
                                 * `ambiguous_port` / `blocked_by_machine` / `occupied` ——
                                 * 那才是模型要改的东西，也是 prompt 选择渲染方式的依据
                                 * （只有 `ambiguous_port` 会渲染候选清单）。
                                 *
                                 * 实测 r-20261112155503-1dae：prompt 里写的是
                                 * `connect → NO_REVERSIBLE_CALL`，模型完全看不出
                                 * 真正撞的是端口歧义，于是又一次写 `port:"color"`。 */
                                const macroCode = (hit && hit.code) ? hit.code : p.diagnosis.code;
                                return {
                                    macro: m, code: macroCode,
                                    hint: (hit && hit.hint) || p.diagnosis.hint || null,
                                    ...(observed ? { observed } : {}),
                                    ...(hit && Array.isArray(hit.candidates) ? { candidates: hit.candidates } : {}),
                                };
                            });
                        })(),
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
                /* 内层既没给计划也没定 outcome ⇒ 计划被拒（零写入）。回外层：换动作/换世界。
                 *
                 * ⚠️ `innerDecided === true` 表示「内层已经定了结果」（halt / error /
                 * 只有升级的轮次 / 参数校验失败），此时 `break` 是对的 —— 但
                 * `reason` 不能就这么留在初始化值 `"INTERNAL"` 上。
                 *
                 * 真机实测（2026-11-13，产线 537/600）：模型写 `upgrade {machine:…}`
                 * 参数错，新加的前置校验正确地写了 plan 行（code=LLM_ARGS）、
                 * 也把 hint 记进了 lastPlanSummary —— 然后整轮还是
                 * `outcome=error reason=INTERNAL`。因为这里 `break` 之后
                 * 没人再给 `reason` 赋值。
                 *
                 * 把「内层已经明确说过的结果」如实搬出来：
                 *   · lastPlanSummary.decision 说明这一轮是怎么结束的；
                 *   · verify.codes 里有具体诊断码时用那个。
                 * 两者都没有才退回 INTERNAL。 */
                if (!innerDecided) continue;
                /* ⚠️ 不能用 `outcome !== "error"` 当「这一轮还没定结果」的判据 ——
                 * `outcome` 的**初始值**就是 `"error"`（第 2639 行 `let outcome = "error"`）。
                 * 从没赋过值时它也是 "error"，于是这个守卫会把该修的情况全跳过。
                 * 真正的判据是 `lastErr === null`：只有 catch 到异常时它才非 null。 */
                if (lastErr === null) {
                    const dec = st.lastPlanSummary && st.lastPlanSummary.decision;
                    const codes = (st.lastPlanSummary && st.lastPlanSummary.verify
                        && Array.isArray(st.lastPlanSummary.verify.codes))
                        ? st.lastPlanSummary.verify.codes : [];
                    if (dec === "plan_rejected" && codes.length) {
                        /* 计划被拒 ≠ 这次 run 出错了。它是一个**正常的诊断结果**：
                           模型写错了、宏拒了、下一轮会看到 hint。记 halt 并带上真实码。 */
                        outcome = "halt";
                        reason = codes[0];
                    } else if (dec === "upgrade_failed") {
                        /* 升级失败不是 run 出错 —— 它是「这一轮模型提了个做不到的事」。
                           归到 `NO_WORLD_CHANGE`（闭集里已有，语义是「这一轮世界没动」），
                           而不是新造一个码破闭集。 */
                        outcome = "halt";
                        reason = "NO_WORLD_CHANGE";
                    }
                }
                break;
            }
            /* ★ 记进本次 run 的任务日志（见 st.runLog 的注释）★
             *
             * 存的是**模型自己的意图**（say）与它实际要做的动作。
             * outcome 先记 `planned`，tx 之后再回填真实净效果 ——
             * 这样下一轮渲染时能说「第 3 轮你说要做 X，结果改坏了」。 */
            /* ★ 记进本次 run 的任务日志（见 st.runLog 的注释）★
             *
             * 存的是**模型自己的意图**（say）与它实际要做的动作。
             * outcome 先记 `planned`，tx 之后再回填真实净效果 ——
             * 这样下一轮渲染时能说「第 3 轮你说要做 X，结果改坏了」。
             *
             * ⚠️ 还必须记下**落了什么**，不只是宏名。
             *
             * 实测（2026-11-12 第 9 关 r-20261112093135-cdeb）：模型 r1/r2/r3 连着
             * 放了 3 台矿机（`$ore:"blue"` ×2、`$ore:"red"` ×1，全部落盘成功），
             * 但 r4/r5 又回到**不带 $ore 的盲目 insert_machine** ——
             * 因为它只看到「r3 insert_machine → ...」，不知道自己刚才放了什么。
             *
             * 记 `detail`：每个调用的「做了什么」一句人话。tx 之后 uid 会变，
             * 所以**不记 uid**，只记矿种与落点（「miner on blue ore」）——
             * 那是不随 uid 变化的、模型下一轮能自己重新定位的东西。 */
            st.runLog.push({
                round: roundNo,
                say: typeof planned.say === "string" ? planned.say.replace(/\s+/g, " ").trim() : "",
                calls: planned.calls.map(c => c.macro),
                detail: summarizeCalls(planned),
                outcome: "planned",
            });
            tr.write("plan", roundNo, {
                ok: true, rejected: null, stage: "ok",
                calls: planned.calls.map(c => c.macro),
                provenance: planned.provenance,
                /* ★ partial 明细（2026-11-02）★
                 *
                 * `partial:true` 意味着**这个计划没有被完整执行**。
                 * 事后读 transcript 的人必须能看到「哪些被跳过了」，
                 * 否则「提交了 3 个 op」和「原计划有 5 个调用」这两件事分不开。 */
                partial: planned.partial === true,
                skipped: planned.partial === true
                    ? (planned.skipped || []).map(s => ({ macro: s.macro, reason: s.reason }))
                    : [],
                tx_plan: {
                    ops: planned.txPlan.ops.length,
                    destroys: planned.txPlan.destroys,
                    placements: planned.txPlan.placements.length,
                    flows: planned.txPlan.flows.length,
                    pending: Object.keys(planned.txPlan.pendingByOp).length,
                },                warnings: planned.warnings,
            });

            /* plan 全绿 ⇒ 每个宏都通过了校验、即将进 tx。**从这里起才算「真正执行过」**
               （宏内部可能有自己的 dry-run，但 plan 过了就意味着它们都会产生 op）。
               跨 run 记忆**不在这里记** —— 见 tx 成功后那段注释。

               ⚠️ 顺序很重要：这里**先**写 `lastExecutedMacros`，而上面那道
               「必须换动作」的检查读的也是它。两者必须在同一处对齐，见下面那段。 */
            const prevExecuted = st.lastExecutedMacros.slice();
            st.lastExecutedMacros = planned.calls.map(c => c.macro);
            /* 记下本轮的 txPlan 与残线清单 —— 下一轮判定「拆的是不是残线」要用。
               放在这里（tx 之前）是对的：即便 tx 失败，下一轮也确实没有可拆的东西，
               判据自然为假，不会误豁免。 */
            st.lastTxPlan = planned.txPlan;
            st.lastObsoleteLines = residual;

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
            /* ★ 读 `prevExecuted`（本轮赋值**之前**的值），不是 `st.lastExecutedMacros` ★
             *
             * 2026-11-12 真机（第 9 关 r-20261111170332-1d9e）：第 1、2 轮 `connect`
             * 都被 `NO_REVERSIBLE_CALL` 拒（宏失败，没进 tx）⇒ 上一轮**什么都没执行**。
             * 第 3 轮模型换成了 `insert_machine`，plan 全绿（ops=2、placements=1、
             * partial=false）—— 结果这道检查拿**刚被自己写进去**的
             * `lastExecutedMacros = ["insert_machine"]` 去比，
             * 判成「仍然用了 insert_machine（与上一轮相同）」，
             * 直接 `halt: NO_PROGRESS`，**把这一轮自己的 tx 也跳过了**（tx=0）。
             *
             * 语义上这条检查问的是「上一轮执行过的那套动作，这次又照抄了吗」，
             * 所以必须读上一轮留下的值。 */
            if (st.mustChange && prevExecuted.length) {
                const now = planned.calls.map(c => c.macro);
                if (actionSetHash(now) === actionSetHash(prevExecuted)) {
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

            /* ★ 写之前先存检查点 ★
             *
             * `opTx` 内部的快照只活在一次调用的调用栈里（失败/dry_run 时回滚，
             * 成功时丢弃）。所以一旦这个 tx 成功落盘、事后才发现把世界改坏了，
             * 就**没有任何退路** —— 实测就是这么积累出 41% 死带子的。
             *
             * 检查点存的是 `entity.serialize()` 的完整组件状态，恢复走
             * mod 的 `rollbackToSnapshot`（4 轮收敛 + 先删后放 + nextUid 回收）。
             *
             * 失败不阻塞：拿不到检查点意味着这一轮**不能撤销**，
             * 那是能力缺失，不是世界出问题 —— 记下来，继续跑。 */
            st.txCount++;
            const ckName = `r${roundNo}`;
            let ckSaved = null;
            if (typeof reader.checkpointSave === "function") {
                try {
                    ckSaved = await reader.checkpointSave({ name: ckName });
                    st.checkpointNames.push(ckName);
                } catch (e) {
                    ckSaved = null;
                    tl.push(`    ⚠ 检查点失败：${String(e && e.message ? e.message : e).slice(0, 80)}`);
                }
            }
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
                markRunLog(roundNo, "failed");
                break;                          // 没有写面就不该继续转（下一轮还是同一个错误）
            }
            const av = applyVerdict(ap.tx, { requestedOps: planned.txPlan.ops.length });
            st.lastApplyRolledBack = ap.tx.rolled_back === true;
            tl.push(`    tx   ${av.ok ? "✓" : "✗"} applied ${ap.tx.applied}/${ap.tx.requested}`
                + `${ap.tx.rolled_back === true ? "  (rolled_back)" : ""}`
                + `${planned.partial === true ? `  partial: 跳过 ${(planned.skipped || []).length} 个宏` : ""}`
                + `${av.ok ? "" : `  why: ${av.why.join(" / ")}`}`);
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
                markRunLog(roundNo, "failed");
                st.obs = null;                  // 世界可能已被回滚/部分改：下一轮必须重读
                continue;
            }
            st.worldTouched = true;

            /* ★ 只在 tx **真的成功落盘之后**才把这套宏记进跨 run 记忆 ★
             *
             * 红队抓到的真 bug：上一版把 `st.roundCalls.push` 放在 plan 全绿之后、
             * tx 之前。于是 dry_run / BUDGET_TX / NO_PROGRESS / tx 失败回滚 / 写面缺失
             * 这些「一个 op 都没落地」的轮次，也会留下一条「模型试过这套宏」的记录；
             * 而下一轮轮首的 `netEffects[{round:N}]` 会被 `extractAttempts` 归因到
             * `round N-1` —— 也就是那套**从未执行**的动作。结果是记忆里出现
             * 「remove_run 让世界没变化」这种假因果，还会把一个从没试过的动作
             * 提前判成负例。
             *
             * 判据复用 `st.worldTouched`：它只在 `applyVerdict.ok === true` 之后被置位。
             * 「模型选过但没执行」由 `## LAST ROUND` 与 plan 的 rejected 记录负责，
             * 不属于跨 run 经验。 */
            st.roundCalls.push({
                round: roundNo,
                macros: st.lastExecutedMacros.slice(),
                actionSet: actionSetHash(st.lastExecutedMacros),
            });

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
                goalShape: curGoal,
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
                /* ★ 宏算出来的后果，交给下一轮 prompt（P17 §6.1）★
                 *
                 * 只在 continue 路径上给 —— 上面 `success` / `offline_only` 两条
                 * 都要 `break` 出去了，下一轮不存在，塞进去也没人读。
                 * 放在这里而不是更早：partial 之后 `planned.calls` 已定稿。 */
                macro_warnings: planned.macro_warnings || [],
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

            /* ── 收尾观测：把**最后一次 tx 之后**的世界补上 ──
             *
             * 净效果是「本轮轮首 vs 上轮轮首」，所以最后一次 tx 的结果**永远等不到**
             * 下一轮去读它 —— 而 run 又常常停在这之后（BUDGET_ROUNDS / NO_PROGRESS /
             * 模型说完了）。不补这一刀，timeline 的累计段就会漏掉最后一步，
             * 而那一步往往正是「把它改坏了」的那一步（实测：一次 run 的最后一步
             * 把到 hub 的带子从 140 砍到 133，旧版完全没记）。
             *
             * 只在**确实写过世界**且取数不为空时补 —— 读失败就跳过，绝不因为
             * 一次诊断性读取让 run 变成 error（这是 finally）。
             */
            if (st.worldTouched && st.healthBefore && !ctx.dryRun) {
                try {
                    const fo = unwrapObs(await reader.obs({
                        max_entities: 50000, layer: "all",
                        include_stats: true, include_resources: true, max_resources: 20000,
                    }));
                    let fi = null;
                    try { fi = unwrapItems(await reader.debugItems({ region: debugItemsRegion(fo) })); } catch { fi = null; }
                    let fp = null;
                    try { fp = await reader.production({ slices: 6 }); } catch { fp = null; }
                    const hf = healthWithRedundancy({ obs: fo, items: fi, production: fp, goalShape: curGoal });
                    const dd = healthDelta(st.healthBefore, hf);
                    const eff = classifyNetEffect(st.healthBefore, hf, dd);
                    st.netEffects.push({ round: st.rounds, kind: eff.kind, why: eff.why, final: true });
                    st.lastNetEffect = eff;
                    st.healthNow = hf;
                    tl.push(`── 收尾世界 ${formatHealth(hf)}`);
                    tl.push(`      ${formatDelta(dd)}`);
                    tl.push(`    ${formatNetEffect(eff)}`);
                } catch (e) {
                    tl.push(`── 收尾世界 （读不到：${String(e && e.message ? e.message : e).slice(0, 80)}）`);
                }
            }

            /* ── 整次 run 的累计效果 ──
             *
             * 「每步净效果」是局部的（这一步 vs 上一步），它看不见「三轮各改一点、
             * 最后比一开始还差」这种累积破坏。这里用**首轮快照 vs 末轮快照**再算一次，
             * 两个量回答的是不同的问题：
             *   · 每步  → 模型该不该接着这么干；
             *   · 累计  → 这次 run 值不值得留下。 */
            let runTotalLocal = null;
            if (st.healthFirst && st.healthNow) {
                const dd = healthDelta(st.healthFirst, st.healthNow);
                runTotalLocal = classifyNetEffect(st.healthFirst, st.healthNow, dd);
                runTotal = runTotalLocal;
                tl.push("");
                tl.push(`══ 累计（首轮 → 末轮）  ${formatDelta(dd)}`);
                tl.push(`   ${formatNetEffect(runTotalLocal)}`);
            }

            /* ── 落盘跨 run 记忆（必须在 finally 里 —— 任何 exit 都该留下经验）──
             *
             * 为什么放在 `try/finally` 的 finally：`outcome` 可能是 success / halt /
             * error / 预算耗尽 / 异常。一次失败的 run 恰恰是**最有信息量**的（全是负例），
             * 只在成功路径写记忆等于把教训扔掉。
             *
             * 为什么写失败不抛：记忆是附加能力，绝不能因为它让一次成功的 run 变成 error。 */
            try {
                /* 本次 run 观测到的**最终**目标（可能因为中途升级而与 `goal` 不同）。 */
                const observedGoal = (st.lastObs
                    && st.lastObs.goal
                    && typeof st.lastObs.goal.requirement?.shape === "string")
                    ? st.lastObs.goal.requirement.shape
                    : curGoal;
                const observedLevel = (st.lastObs && st.lastObs.goal && Number.isFinite(st.lastObs.goal.level))
                    ? st.lastObs.goal.level : null;
                const attempts = extractAttempts({
                    /* ★ 用**观测到的**当前目标，不用调用方传的 `goal` ★
                     *
                     * 世界可能在 run 中途升级（level 5 → 6）。调用方的 `goal` 一旦
                     * 过期，把新世界的净效果记到旧目标下就是**双重污染**：
                     * 既给了旧目标假经验，又让新目标缺经验。
                     * 轮首的 `GOAL_MISMATCH`/`GOAL_CHANGED` 已处理前置判断，
                     * 但 finally 仍然要写 —— 所以这里必须自己读一次当前目标。 */
                    goalShape: observedGoal,
                    world: currentWorldKey || "unknown",
                    netEffects: st.netEffects,
                    roundCalls: st.roundCalls,
                    rollbacks: st.rollbacks,
                    health: st.healthNow,
                });
                /* ★ 把观察到的目标写回 `worlds` ★
                 *
                 * 这是**下次 run 能检测到换关**的唯一依据。不写的话 `last_goal`
                 * 永远停在第一次跑时的值，换关检测形同不存在（而且不报错）。
                 * 即使 `attempts` 为空也要写 —— 一次什么都没做成的 run
                 * 同样是一条「我看到了这个目标」的证据。 */
                worldPatch = worldUpdate({
                    mem: memory,
                    world: currentWorldKey || "unknown",
                    goalShape: observedGoal,
                    level: observedLevel,
                });
                if (attempts.length) {
                    memorySaved = saveMemory(memoryFile, mergeMemory(memory, attempts, worldPatch));
                    tl.push(`══ 记忆 本次写入 ${attempts.length} 条（目标 ${observedGoal}）`
                        + (memorySaved ? "" : "  ⚠ 写盘失败"));
                } else if (Object.keys(worldPatch).length) {
                    /* 没有可记的尝试，但**世界状态仍然要更新** —— 否则「上次目标」
                       永远停在第一次跑时的值，下次换关检测就会误判。 */
                    memorySaved = saveMemory(memoryFile, mergeMemory(memory, [], worldPatch));
                    tl.push(`══ 记忆 无可记尝试，但更新了世界目标（${observedGoal}）`
                        + (memorySaved ? "" : "  ⚠ 写盘失败"));
                }
            } catch (e) {
                tl.push(`══ 记忆 ⚠ 提取失败：${String(e && e.message ? e.message : e).slice(0, 80)}`);
            }

            tl.push(`══ 收尾 outcome=${outcome}${reason ? ` reason=${reason}` : ""}`
                + ` 轮 ${st.rounds} · LLM ${st.llmCalls} · tx ${st.txCount}`);
            tlFile = tl.flush();
            if (tlFile) files.push("timeline.log");
            savedFiles = files.slice();

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
                    /* 每步的净效果序列 + 整次累计 —— 这两个是「这次 run 干了什么」
                       的机器可读版；人读版在 timeline.log。 */
                    net_effects: st.netEffects || [],
                    memory_saved: memorySaved,
                    memory_file: MEMORY_FILE,
                    goal_changed: st.goalChanged ? { ...st.goalChanged } : null,
                    final_goal: curGoal,
                    run_total: runTotal ? { kind: runTotal.kind, why: runTotal.why } : null,
                    timeline: tlFile ? "timeline.log" : null,
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
        timeline_path: path.join(runDir, "timeline.log"),
        run_dir: runDir,
        preserved: {
            dir: runDir,
            files: savedFiles,
            world_state: st.lastApplyRolledBack ? "rolled_back" : (st.worldTouched ? "applied" : "untouched"),
            last_successful_round: st.lastSuccessfulRound,
        },
        /* 每步净效果 + 整次累计：调用方（runner / 人）不必再读 transcript 就能判断
           「这次 run 到底有没有让世界变好」。 */
        net_effects: st.netEffects.slice(),
        /* 撤销记录：每次「判定要撤」都在这里，含是否真的撤了、是否验证通过。
           与 `net_effects` 的 `reverted` 配对读 —— 前者说「发生了什么」，
           后者说「我们怎么处置的」。 */
        rollbacks: st.rollbacks.slice(),
        checkpoints: st.checkpointNames.slice(),
        memory_saved: memorySaved,
        memory_file: memoryFile,
        goal_changed: st.goalChanged ? { ...st.goalChanged } : null,
        final_goal: curGoal,
        run_total: runTotal ? { kind: runTotal.kind, why: runTotal.why } : null,
        health: st.healthNow || null,
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
        /* `resource_radius`：矿点扫描半徑。
         *
         * mod 那边默认 256 —— 旧值 64 是 L5 时代定的，只够覆盖脚边的铜矿。
         * L12 需要 white 颜料，最近的 `RuRuWuWu` 在距 hub 239 格外，
         * 半径 64 完全看不见，agent 于是连续四轮报
         * 「Cb ore and white paint are not in the scanned area」，
         * 在旧产线上反复打补丁，却不知道真正该做的是去远处开矿。
         *
         * 「看不见目标矿」和「目标矿不存在」是两回事 —— 不告诉模型这个区别，
         * 它就只能靠猜。这里显式给足，让远处有什么矿是**可见**的事实。 */
        async obs(p) { return call("obs", { max_entities: 50000, layer: "all", include_stats: true, include_resources: true, max_resources: 20000, resource_radius: 256, ...p }); },
        async debugItems(p) { return call("debug_items", p || {}); },
        async production(p) { return call("production", p || { slices: 6 }); },
        async step(ticks) { return call("act", { op: "step", ticks }); },
        async tx(ops) { return call("act", { op: "tx", ops }); },
        /* 升级：**顶层 RPC，不是 act/tx**。
         *
         * 它不产生任何 op（不改世界拓扑），所以不能塞进 `tx` 的 op 列表里 ——
         * `tx` 落的是实体增删，而升级改的是全局倍率与 hub 库存。
         * mod 侧的 `upgrades(params)` 已经完整：不给 id 列四条链的档位，
         * 给 id 就买下一档，并返回 before/after/spent 供对账。
         *
         * 这个方法必须挂在 reader 上而不是别处：loop 的所有世界读写都走 reader
         * （V2 §5.5「两处口径不同 = 两份世界」），`upgrade.mjs` 也是按
         * `ctx.reader.upgrade` 去找它的。漏了这一步，宏会返回 `tx_unavailable`
         * ——「算出来 ≠ 送到」在这个项目里已经复发过太多次。 */
        async upgrade(p) { return call("upgrade", p || {}); },
        /* 世界的身份（seed / hub / 版本）。跨 run 记忆用它隔离不同存档 ——
           没有它，离线夹具的经验会串进真机。mod 侧实现见 `worldInfo()` :800。 */
        async worldInfo() { return call("world_info", {}); },
        /* 跨 tx 检查点（撤销能力）。mod 侧实现见 `checkpointSave` / `checkpointRestore`。
         *
         * 为什么放在 reader 上而不是单独一个客户端：loop 的所有世界读写都走 reader
         * （V2 §5.5 第 5 条「两处口径不同 = 两份世界」）。把撤销也放进来，
         * FakeGame 与真桥就都能提供它 —— 否则「只有真机能撤销」会让离线测试
         * 永远覆盖不到这条路径。 */
        async checkpointSave(p) { return call("checkpoint_save", p || {}); },
        async checkpointRestore(p) { return call("checkpoint_restore", p || {}); },
        async checkpointList() { return call("checkpoint_list", {}); },
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
    /* 这三个 flag 曾被**静默忽略**（只认 --goal/--mock/--llm/--dry-run/--json）。
       后果不是报错，而是「以为在打代理，其实打了官方地址」，或者反过来
       「以为连不上，其实只是没传」—— 排查方向会被引到完全错误的地方。
       现在显式接上：不传就是 null，走 llm.mjs 自己的默认值。 */
    const baseUrl = argVal(argv, "--base-url");
    const model = argVal(argv, "--model");
    const apiKey = argVal(argv, "--api-key") || process.env.ANTHROPIC_API_KEY || null;
    /* 代理上的模型会先吐很长的 thinking 块再把 JSON 写在最后。`AnthropicClient`
       的默认 1200 会被 thinking 吃满 —— 实测 `stop_reason=max_tokens`、`content`
       里一个 text 块都没有，然后 parse 报 `LLM_NOT_JSON: output is empty`。
       这个失败形态**看起来像模型不会输出 JSON**，实际上只是预算不够，排查方向
       会被带偏一整轮（`experiment-coldstart.mjs` 里同一个坑踩过一次）。
       所以 --llm 模式给一个够用的默认值，仍可用 --max-tokens 覆盖。 */
    const maxTokens = Number(argVal(argv, "--max-tokens") || (useLive ? 20000 : 1200));
    /* 参数是垃圾时不要让它变成 NaN 一路流进 AbortSignal.timeout —— 那个报错
       （`The value of "delay" is out of range`）与真实原因毫无关系。 */
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
        console.error(`✗ --max-tokens 必须是正整数，实得 ${argVal(argv, "--max-tokens")}`);
        return 1;
    }

    if (!goal) {
        console.error("用法：node src/agent/loop.mjs --goal RuRu---- (--mock <scenario> | --llm) [--dry-run] [--json]");
        console.error("      [--base-url <url>] [--model <id>]   代理/网关；密钥读 ANTHROPIC_API_KEY");
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
            llmClient = makeClient({
                mode: "live",
                maxTokens,
                /* thinking 块也算在 max_tokens 里，所以超时必须跟着放大 ——
                    否则预算够了、请求先被 fetch 超时掐掉。 */
                timeoutMs: Math.max(60000, maxTokens * 14),
                ...(apiKey ? { apiKey } : {}),
                ...(baseUrl ? { baseUrl } : {}),
                ...(model ? { model } : {}),
            });
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
        /* 实验开关：`--force-one-call` ⇒ 每轮只允许一个宏。默认关。 */
        forceOneCall: argv.includes("--force-one-call"),
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
        /* 终端上一眼回答「这次 run 把世界弄好了还是弄坏了」——
           这两行是 timeline.log 的存在理由的浓缩版。 */
        if (res.run_total) console.log(formatNetEffect(res.run_total).replace(/^净效果/, "整次 run"));
        if (Array.isArray(res.net_effects) && res.net_effects.length) {
            const seq = res.net_effects.map(e => `${e.round}${e.final ? "终" : ""}:${e.kind}`).join(" → ");
            console.log(`每步: ${seq}`);
        }
        if (res.timeline_path) console.log(`timeline: ${res.timeline_path}`);
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
