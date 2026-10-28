/**
 * loop/coords.mjs — 「LLM 不算坐标」的**机器化**：禁坐标 + 解析三种算子 + 溯源校验。
 *
 * 三道关口，逐层可脚本检查（v1 §2.1 的 L-A / L-B / L-C）：
 *
 *   L-A  `assertNoHumanCoords(llmPlan)`  原始 LLM JSON 里不许有字面坐标（V1–V6）。
 *   L-B  `resolveRefs(llmPlan, handles, obs)`  把 `$ref` / `$uids` / `$bbox_of` 解析成
 *        uid / cell / bbox，并为**每一个**解析出的坐标打一个 provenance 标签。
 *   L-C  `assertProvenance(resolved, txPlan, obs)`  落盘前复核：每条 op 的坐标都能沿着
 *        标签回到「obs 里真实存在的那个实体」或「当轮宏返回值里的那个 token」。
 *
 * ## 为什么 L-C 必须**重算**而不是「看一眼标签格式对就放行」
 *
 * 契约 §2.4 的变异测试要求：把解析结果里任一个 cell 的 x 加 1，`assertProvenance` 必须红。
 * 只拿正则校验 `obs:uid=N` 的**字符串形状**是红不了的 —— 标签没变，值变了。
 * 所以本文件的 `checkTag` 一律**回到 obs 重新取值**再比对：
 *   · `obs:uid=7`     → obs 里必须有 uid=7，且被校验的值必须等于它的 (x,y)/uid；
 *   · `computed:bbox_of[B1,B2]` → 用**当前 obs** 重建句柄表、重新并集 footprint，必须相等；
 *   · `macro:<token>` → token 必须能在当轮 tx 计划/宏返回里找到（找不到就红）。
 *
 * ## 三种 provenance 的**唯一**合法形态
 *
 *   `obs:uid=N`                  来自 obs 的既有实体（`$ref` / `$uids` 解析结果）
 *   `macro:<token>`              来自宏返回的 pending / terminal / placed[].origin / cells[]
 *   `computed:bbox_of[H1,H2,...]` `$bbox_of` 的并集结果（标签里存**句柄**，不存坐标 ——
 *                                否则「可审计」就变成了「把坐标抄了两遍」）
 *
 * 值是单个标签字符串；`$uids` 这种一对多的来源给**标签数组**（顺序与 uid 数组一致）。
 *
 * ## 本文件发现的契约偏差（写在这里而不是只写在报告里）
 *
 * 1. v1 §2.2 说 `{"$ref":"B7","asCell":true}` → `{cell:[handle.x, handle.y]}`「只用于
 *    insert_machine.at」，理由写「`{cell}` 形态会触发反解，2×1 机器恒 ambiguous_site」。
 *    红队 #10 已证该理由过时（`place.mjs:492-509` 现在按输入槽消歧）。**本实现按字面
 *    产出 `{cell:[x,y]}`（即宏的 any-cell 形态，会反解 origin）** —— 这恰好是红队建议的
 *    正确形态；如果谁要退回「裸 `[x,y]` = origin」，改 `asCell` 分支即可，但那时必须
 *    在 loop 侧对 2×1 机器显式做 `origin = cell - [1,0]` 的可审计推导（红队 #10 的修法二）。
 * 2. V4 的作用域是「**任何**字符串」。它是唯一会误伤「正文里同时出现两个数字」的规则
 *    （例如 `"窗口 2, 6 两片"` 会被判红）。这是**故意的保守**：loop 的 say/why 不需要
 *    这种写法，而误判的代价（拒一轮）远小于漏判（LLM 夹带坐标，下一轮自己抄进去）。
 *
 * 零依赖（只用 node 内置 + 仓库内只读模块），纯函数，无 IO。
 */
import { MACRO_NAMES, lintNoBareCoords } from "../macros/contract.mjs";
import { buildHandles, resolveHandle, bboxOf, HANDLE_RE } from "./handles.mjs";

/* ══════════════════════════════════════════════════════════════════════════
 * 0. 三种坐标来源（唯一闭集）
 * ══════════════════════════════════════════════════════════════════════════ */

export const COORD_SOURCES = Object.freeze({
    OBS_REF: "$ref",
    OBS_REFS: "$uids",
    DERIVED_BBOX: "$bbox_of",
});

/** 算子 → 它产生的 provenance 前缀。注意 `$ref` 两种形态都是 `obs:uid=`。 */
export const PROVENANCE_PREFIX = Object.freeze({
    OBS: "obs:uid=",
    MACRO: "macro:",
    COMPUTED: "computed:bbox_of[",
});

/**
 * provenance 标签的**唯一**合法形态（v2 §4 的审计口径 / v1 §2.4 的正则）。
 *
 * ⚠️ **与 V4 的坐标正则不冲突**：`macro:replace_run:cutter@4,-13` 里确实有 `4,-13`，
 * 但它不是 LLM 写的 —— 它是**宏返回值里的 token**，loop 原样搬运。所以：
 *   · 这条正则用于 `assertProvenance`（机器产出的标签）；
 *   · V4 用于 `assertNoHumanCoords`（LLM 写的文本）。
 * 两者的作用域不同，不能合并（合并会让「合法 token」被当成「LLM 夹带坐标」）。
 *
 * ⚠️ **与 v1 §2.4 的正则不同（已证实的契约 bug）**：v1 写的是
 * `^macro:[\w-]+@[^|]+$`，而宏**实际**产出的 token 是
 * `replace_run:cutter@4,-13`（`remove.mjs:1532`）和 `trash_unused:trash@4,-13`（`:1732`）——
 * 宏名与 kind 之间是**冒号**，`[\w-]+@` 在 `:` 处就断了，于是**每一个真实 token 都不匹配**。
 * 按 v1 字面实现，`assertProvenance` 会对所有宏溯源判红（＝宏放的机器永远无法溯源）。
 * 这里把前缀放宽成 `[\w-]+(?::[\w-]+)*@`，即「宏名，可带冒号分段，最后跟 @」。
 */
export const PROVENANCE_RE = /^(?:obs:uid=\d+|macro:[\w-]+(?::[\w-]+)*@[^|]+|computed:bbox_of\[.+?\])$/;

/** 坐标形态正则（V4）。**不带 global**：带 g 的 RegExp 有 lastIndex 状态，跨调用会漏判。 */
export const COORD_TEXT_RE = /\(?\s*-?\d{1,4}\s*,\s*-?\d{1,4}\s*\)?/;

/** V3 的键名清单。**不含 `len`** —— len 是格数（choice），不是坐标。 */
export const COORD_KEYS = Object.freeze([
    "x", "y", "r", "rv", "rot", "rotation", "rotationVariant", "region", "cell", "cells", "at",
]);

const COORD_KEY_SET = new Set(COORD_KEYS);
const ALLOWED_OPS = new Set(Object.values(COORD_SOURCES).map(s => s.slice(1)));
const isInt = v => typeof v === "number" && Number.isInteger(v);
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const isIntArr = (v, n) => Array.isArray(v) && v.length === n && v.every(isInt);
const pj = (path, k) => (path ? `${path}.${k}` : k);

/* ══════════════════════════════════════════════════════════════════════════
 * 1. assertNoHumanCoords —— L-A
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 在一个 JSON 树上做 V1–V6。命中即红，**全部列出**（不只报第一条 —— 修一轮就修完）。
 *
 * @param {any} llmPlan  LLM 输出的原始 JSON（或任何要被检查的计划）
 * @param {object|null} [handles]  `buildHandles()` 的表。给了才做 V5（幻觉句柄）。
 * @returns {{ok:boolean, violations:Array<{path:string, rule:string, reason:string, value:any}>,
 *            rulesRun:string[], rulesSkipped:string[]}}
 */
export function assertNoHumanCoords(llmPlan, handles = null) {
    const violations = [];
    const add = (path, rule, reason, value) => violations.push({ path, rule, reason, value });

    const walk = (node, path, parentKey) => {
        if (Array.isArray(node)) {
            /* V1：任何 [int,int] —— 除非它整体是 $uids / $bbox_of 的值（那两个位置值必须是句柄，
               所以真出现整数数组时 V5/REF_SHAPE 会另外抓；这里只是不重复报 V1）。 */
            if (isIntArr(node, 2) && parentKey !== "$uids" && parentKey !== "$bbox_of") {
                add(path, "V1", "字面坐标 [int,int] —— 坐标只能来自 $ref / $uids / $bbox_of", node);
            }
            /* V2：任何 [int,int,int,int]（region 算术） */
            if (isIntArr(node, 4)) {
                add(path, "V2", "字面包围盒 [int,int,int,int] —— region 只能来自 $bbox_of", node);
            }
            node.forEach((v, i) => walk(v, `${path}[${i}]`, null));
            return;
        }
        if (isObj(node)) {
            if ("asCell" in node && !("$ref" in node)) {
                add(pj(path, "asCell"), "AS_CELL_SCOPE", "asCell 只能出现在 $ref 里", node.asCell);
            }
            for (const [k, v] of Object.entries(node)) {
                const p = pj(path, k);
                if (k.startsWith("$")) {
                    const op = k.slice(1);
                    /* V6：只认三种算子 */
                    if (!ALLOWED_OPS.has(op)) {
                        add(p, "V6", `未知的 $ 算子 "${k}" —— 只允许 ${Object.values(COORD_SOURCES).join(" / ")}`, k);
                    } else {
                        checkRefShape(k, v, p, add);
                        if (handles) {
                            /* V5：幻觉句柄 */
                            for (const h of handlesOf(k, v)) {
                                if (!HANDLE_RE.test(h) || !resolveHandle(handles, h)) {
                                    add(p, "V5", `句柄 "${h}" 不在当轮句柄表里（幻觉/过期）`, h);
                                }
                            }
                        }
                    }
                }
                /* V3：键名在清单内且值是数字 */
                if (COORD_KEY_SET.has(k) && typeof v === "number") {
                    add(p, "V3", `键 "${k}" 是坐标容器却被赋了数字 ${v}`, v);
                }
                walk(v, p, k);
            }
            return;
        }
        /* V4：字符串里出现坐标形态（含 say/why 夹带） */
        if (typeof node === "string" && COORD_TEXT_RE.test(node)) {
            add(path, "V4", "字符串里出现坐标形态（say/why 夹带坐标会被下一轮自己抄进去）", node);
        }
    };

    walk(llmPlan, "", null);
    return {
        ok: violations.length === 0,
        violations,
        rulesRun: handles ? ["V1", "V2", "V3", "V4", "V5", "V6"] : ["V1", "V2", "V3", "V4", "V6"],
        rulesSkipped: handles ? [] : ["V5"],
    };
}

/** 算子值里出现的句柄（$ref 单个；$uids/$bbox_of 数组）。 */
function handlesOf(opKey, v) {
    if (opKey === "$ref") return typeof v === "string" ? [v] : [];
    return Array.isArray(v) ? v : [];
}

/** 算子值的**结构**检查（与 V1–V6 正交：这是「三种算子的形状」，不是「有没有坐标」）。 */
function checkRefShape(opKey, v, path, add) {
    if (opKey === "$ref") {
        if (typeof v !== "string" || !HANDLE_RE.test(v)) {
            add(path, "REF_SHAPE", `$ref 的值必须是句柄字符串（如 "B7"），实得 ${JSON.stringify(v)}`, v);
        }
        return;
    }
    if (!Array.isArray(v) || v.length === 0) {
        add(path, "REF_SHAPE", `${opKey} 必须是非空的句柄数组`, v);
        return;
    }
    for (let i = 0; i < v.length; i++) {
        if (typeof v[i] !== "string" || !HANDLE_RE.test(v[i])) {
            add(`${path}[${i}]`, "REF_SHAPE", `${opKey}[${i}] 必须是句柄字符串，实得 ${JSON.stringify(v[i])}`, v[i]);
        }
    }
    if (opKey !== "$bbox_of" && new Set(v).size !== v.length) {
        add(path, "REF_SHAPE", `${opKey} 里有重复句柄（重复通常是拼接选集时的 bug）`, v);
    }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. resolveRefs —— L-B
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 把 LLM 计划里的三种算子解析成 uid / cell / bbox，并给每个坐标打 provenance。
 *
 * @param {object} llmPlan  `{calls:[{macro,args,why?}], say?}`
 * @param {ReturnType<typeof buildHandles>} handles
 * @param {object} obs
 * @returns {{ok:boolean,
 *            calls:Array<{macro:string, args:object, provenance:Object<string,string|string[]>}>,
 *            violations:Array<{path:string, rule:string, reason:string, value:any}>}}
 */
export function resolveRefs(llmPlan, handles, obs) {
    const violations = [];
    const calls = [];
    const add = (path, rule, reason, value) => violations.push({ path, rule, reason, value });

    /* 先跑 L-A：原始 JSON 就不许有坐标。带 handles → V5 也生效。 */
    const pre = assertNoHumanCoords(llmPlan, handles);
    violations.push(...pre.violations);

    const planCalls = llmPlan && Array.isArray(llmPlan.calls) ? llmPlan.calls : null;
    if (!planCalls) {
        add("calls", "PLAN_SHAPE", "calls 必须是数组（LLM 计划 = {calls:[…]}）", llmPlan && llmPlan.calls);
        return { ok: false, calls, violations };
    }

    const resolveNode = (node, path) => {
        if (Array.isArray(node)) {
            const out = [];
            const prov = [];
            node.forEach((v, i) => {
                const r = resolveNode(v, `${path}[${i}]`);
                if (r) { out.push(r.value); prov.push(...r.prov); }
            });
            return { value: out, prov };
        }
        if (isObj(node)) {
            if ("$ref" in node) {
                /* `port` 是**端点选择**（choice），不是坐标容器（见 contract.mjs 的 COORD_CLASSES）。
                   允许它跟着 $ref 走是必需的：`trash_unused.outlet` 在多输出机器上
                   **必须**点名 port，否则宏报 ambiguous_port，L4 那个 cutter 的废料口根本表达不了。
                   只放行这一种附加键，别的一律报错（防止 LLM 用它夹带别的坐标）。
                   ⚠️ v1 §2.2 的 `$ref` 规则只写了 `asCell`，没写 `port` —— 这是契约的洞，
                   按字面实现会让「多输出机器的端点选择」无法表达。 */
                const bad = Object.keys(node).filter(k => k !== "$ref" && k !== "asCell" && k !== "port");
                if (bad.length) add(path, "REF_SHAPE", `$ref 只允许 asCell / port 两个附加键，多出：${bad.join(",")}`, bad);
                const h = node.$ref;
                const entry = typeof h === "string" ? resolveHandle(handles, h) : null;
                if (!entry) {
                    add(path, "V5", `$ref 指向的句柄 "${h}" 不在当轮句柄表里（OBS_STALE）`, h);
                    return null;
                }
                const tag = `${PROVENANCE_PREFIX.OBS}${entry.uid}`;
                const port = node.port;
                const withPort = v => (port === undefined ? v : { ...v, port });
                if (node.asCell === true && port !== undefined) {
                    /* at 是落点，没有 port 语义（place 的落点不接受 port） */
                    add(pj(path, "port"), "REF_SHAPE", "asCell 与 port 不能同时给（落点没有槽位选择）", port);
                }
                if (node.asCell === true) {
                    /* {cell:[x,y]} 是宏的 **any-cell** 形态（会反解 origin）。
                       不要把它改回裸 [x,y]（那是 origin 形态，2×1 机器会静默删带，红队 #10）。 */
                    return { value: { cell: [entry.x, entry.y] }, prov: [[path, tag]] };
                }
                if (node.asCell !== undefined && node.asCell !== false) {
                    add(pj(path, "asCell"), "REF_SHAPE", "asCell 只接受 true/false", node.asCell);
                }
                return { value: withPort({ uid: entry.uid }), prov: [[path, tag]] };
            }
            if ("$uids" in node) {
                const list = Array.isArray(node.$uids) ? node.$uids : [];
                const entries = list.map(h => (typeof h === "string" ? resolveHandle(handles, h) : null));
                if (entries.some(e => !e)) {
                    add(path, "V5", "$uids 里有句柄不在当轮句柄表里（OBS_STALE）", list);
                    return null;
                }
                const tags = entries.map(e => `${PROVENANCE_PREFIX.OBS}${e.uid}`);
                return { value: entries.map(e => e.uid), prov: [[path, tags]] };
            }
            if ("$bbox_of" in node) {
                const list = Array.isArray(node.$bbox_of) ? node.$bbox_of : [];
                const entries = list.map(h => (typeof h === "string" ? resolveHandle(handles, h) : null));
                if (!list.length || entries.some(e => !e)) {
                    add(path, "V5", "$bbox_of 里有句柄不在当轮句柄表里（OBS_STALE）", list);
                    return null;
                }
                try {
                    const bbox = bboxOf(entries.map(e => e.uid), obs);
                    return { value: bbox, prov: [[path, `${PROVENANCE_PREFIX.COMPUTED}${list.join(",")}]`]] };
                } catch (e) {
                    add(path, "V5", `$bbox_of 无法计算：${e.message}`, list);
                    return null;
                }
            }
            const out = {};
            const prov = [];
            for (const [k, v] of Object.entries(node)) {
                const r = resolveNode(v, pj(path, k));
                if (r) { out[k] = r.value; prov.push(...r.prov); }
            }
            return { value: out, prov };
        }
        return { value: node, prov: [] };
    };

    planCalls.forEach((call, i) => {
        const at = `calls[${i}]`;
        if (!isObj(call)) { add(at, "PLAN_SHAPE", "每条 call 必须是对象", call); return; }
        const macro = call.macro;
        if (typeof macro !== "string" || !MACRO_NAMES.includes(macro)) {
            add(pj(at, "macro"), "MACRO", `macro 不在 6 个白名单内：${JSON.stringify(macro)}`, macro);
            return;
        }
        if (call.args === undefined) { add(pj(at, "args"), "PLAN_SHAPE", "call 缺 args", undefined); return; }
        const before = violations.length;
        const r = resolveNode(call.args, pj(at, "args"));
        if (!r) return;   // 整个 args 就是一个算子且解析失败

        /* V7：解析后的 args 必须过既有 lint（不新造规则，复用宏契约那一份） */
        const lint = lintNoBareCoords(macro, r.value);
        if (!lint.ok) {
            for (const reason of lint.violations) add(`${at}.args`, "V7", reason, r.value);
        }

        const provenance = {};
        for (const [p, tag] of r.prov) {
            /* 路径相对 args 更好读：calls[0].args.region → region */
            const rel = p.startsWith(`${at}.args.`) ? p.slice(`${at}.args.`.length) : p;
            provenance[rel] = tag;
        }
        /* 半解析的调用**不进 calls**：带着「少了一个字段的 args」往下走，
           会在宏那一层变成一个看起来合法的坏调用（缺 uids → missing_field），
           把「句柄过期」误诊成「LLM 参数错」。见下方文件头的诚实边界。 */
        if (violations.length > before) return;
        calls.push({ macro, args: r.value, provenance });
    });

    return { ok: violations.length === 0, calls, violations };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. assertProvenance —— L-C
 * ══════════════════════════════════════════════════════════════════════════ */

/** 取 `a.b[0].c` 形态的路径值；取不到返回 undefined。 */
export function getPath(obj, path) {
    if (!path) return obj;
    let cur = obj;
    for (const seg of String(path).split(".")) {
        const m = /^([^\[\]]*)((?:\[\d+\])*)$/.exec(seg);
        if (!m) return undefined;
        if (m[1]) { if (!isObj(cur) && !Array.isArray(cur)) return undefined; cur = cur[m[1]]; }
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
 * 校验一条 provenance 标签，并**用当前 obs 重算**它所声称的值。
 *
 * @returns {{ok:boolean, why:string|null}}
 */
function checkTag(tag, value, { obs, knownTokens }) {
    if (typeof tag !== "string" || !PROVENANCE_RE.test(tag)) {
        return { ok: false, why: `provenance 形态非法：${JSON.stringify(tag)}（只允许 obs:uid=N / macro:<token> / computed:bbox_of[…]）` };
    }
    if (tag.startsWith(PROVENANCE_PREFIX.OBS)) {
        const uid = Number(tag.slice(PROVENANCE_PREFIX.OBS.length));
        const e = ((obs && obs.entities) || []).find(x => x.uid === uid);
        if (!e) return { ok: false, why: `obs 里没有 uid=${uid}（provenance 指向一个不存在的实体）` };
        if (isObj(value) && isInt(value.uid)) {
            return value.uid === uid ? { ok: true, why: null }
                : { ok: false, why: `uid 与 provenance 不符：值 ${value.uid} ≠ ${uid}` };
        }
        if (isObj(value) && Array.isArray(value.cell)) {
            return (value.cell[0] === e.x && value.cell[1] === e.y) ? { ok: true, why: null }
                : { ok: false, why: `cell 与 obs 的 uid=${uid} 不符：值 [${value.cell}] ≠ [${e.x},${e.y}]` };
        }
        if (isInt(value)) return value === uid ? { ok: true, why: null } : { ok: false, why: `uid ${value} ≠ ${uid}` };
        if (isIntArr(value, 2)) {
            return (value[0] === e.x && value[1] === e.y) ? { ok: true, why: null }
                : { ok: false, why: `cell [${value}] ≠ uid=${uid} 的 origin [${e.x},${e.y}]` };
        }
        return { ok: false, why: `obs:uid= 标签被用在一个非 uid/cell 的值上：${JSON.stringify(value)}` };
    }
    if (tag.startsWith(PROVENANCE_PREFIX.COMPUTED)) {
        if (!isIntArr(value, 4)) return { ok: false, why: `bbox_of 标签必须对应 [x0,y0,x1,y1]，实得 ${JSON.stringify(value)}` };
        const inner = tag.slice(PROVENANCE_PREFIX.COMPUTED.length, -1);
        const hs = inner.split(",").map(s => s.trim()).filter(Boolean);
        if (!hs.length) return { ok: false, why: "bbox_of 标签里没有句柄" };
        const table = buildHandles(obs);
        const uids = [];
        for (const h of hs) {
            const e = resolveHandle(table, h);
            if (!e) return { ok: false, why: `bbox_of 标签里的句柄 ${h} 不在当前世界` };
            uids.push(e.uid);
        }
        let want;
        try { want = bboxOf(uids, obs); } catch (e) { return { ok: false, why: e.message }; }
        const same = want.every((v, i) => v === value[i]);
        return same ? { ok: true, why: null }
            : { ok: false, why: `bbox 与重算不符：值 [${value}] ≠ 由 ${hs.join(",")} 重算的 [${want}]` };
    }
    /* macro:<token> */
    if (knownTokens && knownTokens.size) {
        const token = tag.slice(PROVENANCE_PREFIX.MACRO.length);
        const hit = [...knownTokens].some(t => t === token || (typeof t === "string" && t.includes(token)));
        return hit ? { ok: true, why: null } : { ok: false, why: `token "${token}" 不在当轮宏返回值里` };
    }
    return { ok: true, why: null };   // 没有 token 清单时只校验形态（见文件头的诚实边界）
}

/**
 * L-C：落盘前的溯源复核。**两类检查都做**：
 *
 *   ① `resolved.calls[*].provenance` —— 解析出来的每个坐标都能回到 obs / 宏返回；
 *   ② `txPlan.ops[*]` —— 每条 op 的坐标都**带着** provenance，且检 ① 的同一套重算。
 *
 * ## `txPlan.ops[i].provenance` 的形态（planToTxOps 必须产出）
 *
 *   ```js
 *   { op:"place", building:"cutter", x:4, y:-13, r:0,
 *     provenance:{ x:"macro:replace_run@4,-13", y:"macro:replace_run@4,-13" } }
 *   { op:"delete", uid:10143, provenance:{ uid:"obs:uid=10143" } }
 *   ```
 *   也接受 `provenance` 是**单个字符串**（覆盖该 op 的全部坐标字段）。
 *
 * 判据口径（故意与「相等」区分）：
 *   · `obs:uid=N` → place 的 (x,y) 必须**等于**该实体的 origin（`$ref.asCell` 的语义）；
 *   · `computed:bbox_of[…]` → place 的 (x,y) 必须**落在**该 bbox **内**（「从这块选区推导出来」，
 *     不要求等于某个角 —— 否则 $bbox_of 只对单格实体可用）；
 *   · `macro:<token>` → token 必须在已知 token 集合里（txPlan.pendingByOp / placed[].pending.token）。
 *
 * @param {{calls:Array}|Array} resolved
 * @param {{ops:Array, pendingByOp?:object, placed?:Array}} txPlan
 * @param {object} obs
 * @param {{knownTokens?:Iterable<string>}} [opts]
 * @returns {{ok:boolean, violations:Array<{path:string, rule:string, reason:string, value:any}>}}
 */
export function assertProvenance(resolved, txPlan, obs, opts = {}) {
    const violations = [];
    const add = (path, rule, reason, value) => violations.push({ path, rule, reason, value });

    const knownTokens = new Set(opts.knownTokens || []);
    if (txPlan && isObj(txPlan.pendingByOp)) {
        for (const v of Object.values(txPlan.pendingByOp)) if (typeof v === "string") knownTokens.add(v);
    }
    if (txPlan && Array.isArray(txPlan.placed)) {
        for (const p of txPlan.placed) {
            const t = p && p.pending && p.pending.token;
            if (typeof t === "string") knownTokens.add(t);
        }
    }

    /* ── ① resolved：每个解析出的坐标 ── */
    const calls = Array.isArray(resolved) ? resolved : (resolved && Array.isArray(resolved.calls) ? resolved.calls : []);
    if (!calls.length && resolved && !Array.isArray(resolved)) {
        add("calls", "PROVENANCE_SHAPE", "resolved 里没有可校验的 calls", resolved);
    }
    calls.forEach((c, i) => {
        const at = Array.isArray(resolved) ? `[${i}]` : `calls[${i}]`;
        const prov = c && c.provenance;
        if (!isObj(prov)) {
            add(`${at}.provenance`, "MISSING_PROVENANCE", "这条调用没有 provenance 表", prov);
            return;
        }
        for (const [path, tag] of Object.entries(prov)) {
            const value = getPath(c.args, path);
            if (value === undefined) {
                add(`${at}.args.${path}`, "PROVENANCE_SHAPE", "provenance 指向一个 args 里不存在的路径", path);
                continue;
            }
            /* $uids / 多值：标签数组，逐项按 value[i] 校验 */
            if (Array.isArray(tag) && !(isIntArr(tag, 4))) {
                if (!Array.isArray(value) || value.length !== tag.length) {
                    add(`${at}.args.${path}`, "PROVENANCE_SHAPE",
                        `provenance 标签数 ${tag.length} 与值数组长度 ${Array.isArray(value) ? value.length : "非数组"} 不符`, tag);
                    continue;
                }
                tag.forEach((t, j) => {
                    const r = checkTag(t, value[j], { obs, knownTokens });
                    if (!r.ok) add(`${at}.args.${path}[${j}]`, "COORD_PROVENANCE", r.why, { tag: t, value: value[j] });
                });
                continue;
            }
            const r = checkTag(tag, value, { obs, knownTokens });
            if (!r.ok) add(`${at}.args.${path}`, "COORD_PROVENANCE", r.why, { tag, value });
        }
    });

    /* ── ② txPlan.ops：每条落盘坐标都要带溯源 ──
       在真正遍历前先判「这个 txPlan 有没有 provenance 这一层」。**不能默认它有**：
       `planToTxOps.mjs`（并行 agent）明确不产出 per-op provenance（它认为翻译器不该判溯源），
       于是两侧的契约在这一点上**不一致**。这里的选择是**显式拒绝**而不是静默放行：
       没有 per-op provenance 的 txPlan 一律判红，loop 必须自己补这一层（或把它加进 planToTxOps）。
       静默放行会让「每条落盘坐标可追溯」这条唯一能证伪的防线变成空炮（契约 §Q2.1 L-C）。 */
    const ops = txPlan && Array.isArray(txPlan.ops) ? txPlan.ops : null;
    if (!ops) {
        add("txPlan.ops", "PROVENANCE_SHAPE", "txPlan.ops 必须是数组", txPlan && txPlan.ops);
        return { ok: violations.length === 0, violations };
    }
    const hasAny = ops.some(op => isObj(op) && (isObj(op.provenance) || typeof op.provenance === "string"));
    if (ops.length && !hasAny) {
        add("txPlan.ops[*].provenance", "MISSING_PROVENANCE",
            `txPlan 的 ${ops.length} 条 op 都没有 provenance —— `
            + "落盘坐标无法追溯（planToTxOps 目前不产出这一层，loop 必须补齐后才能过 L-C）",
            { ops: ops.length });
        return { ok: violations.length === 0, violations };
    }

    /* ── ② txPlan.ops：上面已判过「有没有这一层」，这里逐条判 ── */
    ops.forEach((op, i) => {
        const at = `txPlan.ops[${i}]`;
        if (!isObj(op)) { add(at, "PROVENANCE_SHAPE", "op 必须是对象", op); return; }
        const prov = op.provenance;
        if (!isObj(prov) && typeof prov !== "string") {
            add(`${at}.provenance`, "MISSING_PROVENANCE",
                `op(${op.op}) 没有 provenance —— 每条落盘坐标都必须能追溯到 obs 或宏返回`, op);
            return;
        }
        const tagFor = f => (isObj(prov) ? prov[f] : prov);
        if (op.op === "delete") {
            if (!isInt(op.uid)) { add(`${at}.uid`, "OP_SHAPE", "delete 缺整数 uid", op.uid); return; }
            const tag = tagFor("uid");
            if (tag === undefined) { add(`${at}.provenance.uid`, "MISSING_PROVENANCE", "delete 的 uid 没有 provenance", op); return; }
            const r = checkTag(tag, op.uid, { obs, knownTokens });
            /* delete 只允许 obs:uid=N（删的必须是一个**已存在**的实体） */
            if (r.ok && !String(tag).startsWith(PROVENANCE_PREFIX.OBS)) {
                add(`${at}.provenance.uid`, "COORD_PROVENANCE", `delete 的 uid 只能来自 obs:uid=N，实得 ${tag}`, tag);
            } else if (!r.ok) add(`${at}.provenance.uid`, "COORD_PROVENANCE", r.why, tag);
            return;
        }
        if (op.op === "place" || op.op === "place_path") {
            for (const f of ["x", "y"]) {
                if (!isInt(op[f])) { add(`${at}.${f}`, "OP_SHAPE", `place 缺整数 ${f}`, op[f]); continue; }
                const tag = tagFor(f);
                if (tag === undefined) { add(`${at}.provenance.${f}`, "MISSING_PROVENANCE", `place 的 ${f} 没有 provenance`, op); continue; }
                /* bbox 的语义是「落在这块选区里」，不是「等于某个角」——
                   所以 computed 标签走单独的包含性判据，不走 checkTag 的相等判据。 */
                if (String(tag).startsWith(PROVENANCE_PREFIX.COMPUTED)) {
                    const bb = bboxOfFromTag(String(tag), obs);
                    if (!bb) { add(`${at}.provenance.${f}`, "COORD_PROVENANCE", `bbox 标签无法重算：${tag}`, tag); continue; }
                    const inside = op.x >= bb[0] && op.x <= bb[2] && op.y >= bb[1] && op.y <= bb[3];
                    if (!inside) add(`${at}.provenance.${f}`, "COORD_PROVENANCE",
                        `place 的 (${op.x},${op.y}) 不在 provenance bbox [${bb}] 内`, tag);
                    continue;
                }
                const r = checkTag(tag, op[f], { obs, knownTokens });
                if (!r.ok) add(`${at}.provenance.${f}`, "COORD_PROVENANCE", r.why, tag);
            }
            return;
        }
        /* 其它 op（bulk_delete 等）：不在这里判，交给 op 形状检查 */
    });

    return { ok: violations.length === 0, violations };
}

/** 从 `computed:bbox_of[H1,H2]` 标签重算 bbox（当前世界）；失败返回 null。 */
function bboxOfFromTag(tag, obs) {
    if (!String(tag).startsWith(PROVENANCE_PREFIX.COMPUTED)) return null;
    const inner = String(tag).slice(PROVENANCE_PREFIX.COMPUTED.length, -1);
    const hs = inner.split(",").map(s => s.trim()).filter(Boolean);
    if (!hs.length) return null;
    const table = buildHandles(obs);
    const uids = [];
    for (const h of hs) {
        const e = resolveHandle(table, h);
        if (!e) return null;
        uids.push(e.uid);
    }
    try { return bboxOf(uids, obs); } catch { return null; }
}
