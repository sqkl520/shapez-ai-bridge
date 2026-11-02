/**
 * loop/coords.mjs — 「LLM 不算坐标」的**机器化**：禁坐标 + 解析三种算子 + 溯源校验。
 *
 * 三道关口，逐层可脚本检查（v1 §2.1 的 L-A / L-B / L-C）：
 *
 *   L-A  `assertNoHumanCoords(llmPlan)`  原始 LLM JSON 里不许有字面坐标（V1–V6）。
 *   L-B  `resolveRefs(llmPlan, handles, obs)`  把 `$ref` / `$uids` / `$bbox_of` / `$path_of`
 *        解析成 uid / cell / bbox / 格集，并为**每一个**解析出的坐标打一个 provenance 标签。
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
 *   · `computed:path_of[B1,B2]` → 同上，但**先重算格集与连续性**：bbox 投影只有在格集
 *     恰好填满它时才算合法（否则「拐弯的链」会被静默扩成一块矩形 —— 见 §0 的裁决）；
 *   · `macro:<token>` → token 必须能在当轮 tx 计划/宏返回里找到（找不到就红）。
 *
 * ## 四种 provenance 的**唯一**合法形态
 *
 *   `obs:uid=N`                  来自 obs 的既有实体（`$ref` / `$uids` 解析结果）
 *   `macro:<token>`              来自宏返回的 pending / terminal / placed[].origin / cells[]
 *   `computed:bbox_of[H1,H2,...]` `$bbox_of` 的并集结果（标签里存**句柄**，不存坐标 ——
 *                                否则「可审计」就变成了「把坐标抄了两遍」）
 *   `computed:path_of[H1,H2,...]` `$path_of` 的格集结果（同样存句柄；值可以是 4 元 region
 *                                或 `[[x,y]…]` 格集 —— 重算后逐项比）
 *
 * 值是单个标签字符串；`$uids` 这种一对多的来源给**标签数组**（顺序与 uid 数组一致）。
 *
 * ## `$path_of` 的裁决（issue：「`$bbox_of` 会把拐弯的链静默扩成矩形」）
 *
 * 题目给了三选一：(a) 只给精确格集；(b) 只给最小矩形 + `contiguous` 标志；(c) 两者都给。
 * **选 (c)，并且把「投影」放在解析层、按参数的声明类型决定**：
 *
 *   1. 算子本身（`handles.mjs#pathOf`）返回 `{cells, region, contiguous, area, holes}` ——
 *      精确格集是**唯一**不可伪造的产物，region 只是它的一个函数。只给 (b) 会丢掉
 *      「哪几格」，只给 (a) 又会让 `replace_run.region`（只吃 4 元 bbox）无法表达。
 *   2. `resolveRefs` 按 `MACRO_SPECS[macro].params[].type` 选投影：
 *        · `BBox`   → **只有** `contiguous === true` 才投影成 region，否则报 `PATH_NOT_RECT`
 *                     （列出空洞格 + 原格集），**绝不**悄悄扩大；
 *        · `Cell[]` → 永远投影成精确格集（`remove_run.cells` 本来就允许稀疏）；
 *        · 其它位置 → `REF_SHAPE`（path_of 产出的是几何，不是身份）。
 *
 *   为什么这样能让「拐弯时宏必须拒绝」**可机器检查**：可检查性不在返回值里，而在
 *   `resolveRefs(...).violations` 里 —— 非连续 ⇒ 一定有一条 `PATH_NOT_RECT`，且 `calls`
 *   里**没有**这条调用（半解析的调用不进 calls）。任何「静默扩大」的实现都会让
 *   `violations.length === 0` 且产出一个 region，测试对这两点同时断言。
 *   若把 `contiguous` 直接塞给宏而不投影，宏只会回一个 `bad_type: region 必须是 [x0,y0,x1,y1]`
 *   —— 那个报错无法区分「LLM 写错形态」与「链拐弯了」，模型下一轮会继续猜。
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
import { MACRO_NAMES, MACRO_SPECS, lintNoBareCoords } from "../macros/contract.mjs";
import { buildHandles, resolveHandle, bboxOf, pathOf, HANDLE_RE } from "./handles.mjs";

/* ══════════════════════════════════════════════════════════════════════════
 * 0. 四种坐标来源（唯一闭集）
 * ══════════════════════════════════════════════════════════════════════════ */

export const COORD_SOURCES = Object.freeze({
    OBS_REF: "$ref",
    OBS_REFS: "$uids",
    DERIVED_BBOX: "$bbox_of",
    DERIVED_PATH: "$path_of",
    /* ★ `$ore` —— 按矿种取一格矿点 ★
     *
     * 真机实测（2026-11-03，level 5 / 目标 `Cu----Cu`）：模型三轮都**正确诊断**了
     * 「接在切割机上的那台矿机脚下没有矿」，并在 say 里直接说出了缺什么：
     *
     *   > "no ore-patch handle is exposed"
     *   > "no listed handle exposes the Cu patch"
     *
     * 它想放一台新矿机到铜矿上，但**矿格不是实体、没有句柄**，`insert_machine.at`
     * 只接受 `{cell}` / `[x,y]`，而模型不许写坐标。于是它只能猜（r1 猜了 `B7` 的格），
     * 或者退回 `{at:{uid:M1}}` 那种不合法形态（r2 被 `LLM_ARGS: unknown_field` 拒）。
     *
     * `$ore` 补的就是这一个洞：`{"$ore":"Cu"}` → `{cell:[x,y]}`（该矿种离 hub 最近的一格）。
     * 它和 `$ref` 的 `asCell` 形态产出同一个类型，所以 `insert_machine.at` 不用改。
     *
     * 只允许**矿种前缀**（`Cu` / `Ru` / `Rb`…），不接受完整形状串 ——
     * 资源层的键是 `CuCuCuCu` 这种，但让模型写全串没有收益，反而容易写错。
     * 解析时按前缀匹配（`Cu` 命中 `CuCuCuCu`），多种同色矿取格数最多的那个。 */
    ORE: "$ore",
});

/** 算子 → 它产生的 provenance 前缀。注意 `$ref` 两种形态都是 `obs:uid=`。 */
export const PROVENANCE_PREFIX = Object.freeze({
    OBS: "obs:uid=",
    MACRO: "macro:",
    COMPUTED: "computed:bbox_of[",
    COMPUTED_PATH: "computed:path_of[",
    /* `$ore` 的产物同样是「一格地」，但它来自资源层而不是实体表。
     * 单独一个前缀，让审计能区分「这格是矿」和「这格是实体」。 */
    ORE: "ore:",
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
export const PROVENANCE_RE = /^(?:obs:uid=\d+|macro:[\w-]+(?::[\w-]+)*@[^|]+|computed:(?:bbox|path)_of\[.+?\]|ore:[A-Z][a-z]@-?\d+,-?\d+)$/;

/**
 * `computed:path_of[…]` 的**专属**前缀。单独导出是因为「重算 + 判连续」
 * 与 bbox 的「重算 + 判相等」判据不同，调用方必须能区分（不能靠 `startsWith(COMPUTED)`
 * 把两者混在一个分支里 —— 那正是「拐弯的链静默变矩形」会重新长出来的地方）。
 */
export const PATH_PROVENANCE_PREFIX = "computed:path_of[";

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
            /* V1：任何 [int,int] —— 除非它整体是 $uids / $bbox_of / $path_of 的值（那几个位置
               值必须是句柄，所以真出现整数数组时 V5/REF_SHAPE 会另外抓；这里只是不重复报 V1）。 */
            if (isIntArr(node, 2) && parentKey !== "$uids" && parentKey !== "$bbox_of" && parentKey !== "$path_of") {
                add(path, "V1", "字面坐标 [int,int] —— 坐标只能来自 $ref / $uids / $bbox_of / $path_of", node);
            }
            /* V2：任何 [int,int,int,int]（region 算术） */
            if (isIntArr(node, 4)) {
                add(path, "V2", "字面包围盒 [int,int,int,int] —— region 只能来自 $bbox_of / $path_of", node);
            }
            node.forEach((v, i) => walk(v, `${path}[${i}]`, null));
            return;
        }
        if (isObj(node)) {
            /* `asCell` 是「这一格地」的标记，`$ref` 与 `$ore` 都产出「一格地」，
             * 所以两者都允许带它。别的算子（`$uids`/`$bbox_of`/`$path_of`）
             * 产出的不是单格，带 asCell 没有意义 ⇒ 照旧报错。 */
            if ("asCell" in node && !("$ref" in node) && !("$ore" in node)) {
                add(pj(path, "asCell"), "AS_CELL_SCOPE", "asCell 只能出现在 $ref / $ore 里", node.asCell);
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

/** 算子值里出现的句柄（$ref 单个；$uids/$bbox_of/$path_of 数组）。 */
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
    /* `$ore` 的值是**矿种前缀**（`Cu`），不是句柄 —— 它压根不是数组。
     * 形状校验放在 `resolveNode` 里（那里能同时判前缀格式与「地图上有没有」）。 */
    if (opKey === "$ore") {
        if (typeof v !== "string" || !/^[A-Z][a-z]$/.test(v)) {
            add(path, "REF_SHAPE", `$ore 的值必须是两字母矿种前缀（如 "Cu"），实得 ${JSON.stringify(v)}`, v);
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
    if (opKey !== "$bbox_of" && opKey !== "$path_of" && new Set(v).size !== v.length) {
        add(path, "REF_SHAPE", `${opKey} 里有重复句柄（重复通常是拼接选集时的 bug）`, v);
    }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. resolveRefs —— L-B
 * ══════════════════════════════════════════════════════════════════════════ */

/** `calls[0].args.region` → `region`（provenance 的路径口径，与 calls 里一致）。 */
const relPath = p => String(p).split(".").slice(2).join(".");

/**
 * 目标参数**声明的**类型 → `"bbox" | "cells" | null`。
 *
 * 唯一真值来源是 `MACRO_SPECS[macro].params[].type`（不在这里抄第二份名单）：
 *   `BBox`   → bbox 投影（只接受恰好填满的格集）
 *   `Cell[]` → 精确格集投影
 *   其它     → null（`$path_of` 用错地方 ⇒ REF_SHAPE）
 *
 * 嵌套参数（`opts.x`）不参与：`$path_of` 只能出现在顶层的坐标参数上。
 *
 * @param {string|null} macro
 * @param {string} path 相对 args 的路径（`region` / `building[0].region` …）
 * @returns {"bbox"|"cells"|null}
 */
export function argKindOf(macro, path) {
    const rel = relPath(path);
    if (!rel.includes(".") && !rel.includes("[")) {
        const spec = MACRO_SPECS[macro];
        const p = spec && Array.isArray(spec.params) ? spec.params.find(x => x.name === rel) : null;
        if (p) {
            if (p.type === "BBox") return "bbox";
            if (p.type === "Cell[]") return "cells";
        }
    }
    return null;
}

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
/* ══════════════════════════════════════════════════════════════════════════
 * `$ore` 的解析：矿种前缀 → 离 hub 最近的那一格矿
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 找「该矿种离 hub 最近的一格」。
 *
 * @param {object} obs 世界快照（要 `resources`，可选 `hub`）
 * @param {string} prefix 两字母矿种前缀，如 `"Cu"`
 * @returns {{cell:[number,number], kind:string, count:number}|null}
 *   没数据 / 没有该矿种 ⇒ null（调用方据此报 ORE_NOT_FOUND，绝不返回假坐标）
 */
export function nearestOreCell(obs, prefix) {
    const list = obs && Array.isArray(obs.resources) ? obs.resources : null;
    if (!list || !list.length) return null;

    /* hub 位置：obs.hub 的 x/y 是左上角，4×4。用它的中心当"远"的基准，
       比用原点更准（hub 未必正好在原点，实测 L5 世界在 (-2,-2)）。 */
    const h = obs && obs.hub;
    const hx = h && Number.isFinite(h.x) ? h.x + ((Number.isFinite(h.w) ? h.w : 4) - 1) / 2 : 0;
    const hy = h && Number.isFinite(h.y) ? h.y + ((Number.isFinite(h.h) ? h.h : 4) - 1) / 2 : 0;

    let best = null;
    const counts = new Map();
    for (const r of list) {
        if (!Array.isArray(r) || r.length < 3) continue;
        const [x, y, kind] = r;
        if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
        if (typeof kind !== "string" || !kind.startsWith(prefix)) continue;
        counts.set(kind, (counts.get(kind) || 0) + 1);
        /* 曼哈顿距离：和 `renderGoalResource` 的远近档位同一个口径
           （那边为了「不许出现坐标」只输出档位，这里要真选一格，所以算真距离）。 */
        const d = Math.abs(x - hx) + Math.abs(y - hy);
        if (!best || d < best.d) best = { cell: [x, y], kind, d };
    }
    if (!best) return null;

    /* 同色有多种矿时，优先用格数最多的那种矿的最近格 ——
     * 但上面已经取了全局最近格，这里只在"最近格属于一个很小的矿"时提醒调用方。
     * 不做重选：矿机放哪一格都能挖，最近的就是最好的。 */
    return { cell: best.cell, kind: best.kind, count: counts.get(best.kind) || 0 };
}

/**
 * 把「LLM 写的 `$ore`」解析成 `{cell:[x,y]}`。
 * 只做一件事，所以单独导出便于测试。
 */
export function resolveOreRef(node, obs) {
    const raw = node && node.$ore;
    if (typeof raw !== "string" || !/^[A-Z][a-z]$/.test(raw)) return null;
    return nearestOreCell(obs, raw);
}

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

    /* `$path_of` 的投影要按**目标参数的声明类型**决定，而类型来自 `MACRO_SPECS[macro]`。
       `resolveNode` 是递归闭包，没有宏名参数；用一个在每次 `forEach` 前写一次的局部变量，
       比把宏名一路穿进 20 层递归更不容易漏（漏传会让投影静默退化到 REF_SHAPE）。 */
    let currentMacro = null;

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
            if ("$ore" in node) {
                /* `$ore` → `{cell:[x,y]}`：该矿种离 hub 最近的一格。
                 *
                 * 只允许 `at` 这类「一格地」的参数（与 `$ref` 的 `asCell` 同一类）。
                 * 契约上走的是 coordClass === "site"，和 `$ref+asCell` 一样。
                 *
                 * ⚠️ **不要**把它扩成 region / cell[]：矿脉是不规则形状，
                 * 一段矿的「矩形」会框进大量非矿格（和 `$bbox_of` 的老坑同型）。
                 * 模型要的是「在哪一格放矿机」，一格就够。 */
                const raw = node.$ore;
                if (typeof raw !== "string" || !/^[A-Z][a-z]$/.test(raw)) {
                    add(path, "REF_SHAPE",
                        `$ore 的值必须是两字母矿种前缀（如 "Cu"），实得 ${JSON.stringify(raw)}`, raw);
                    return null;
                }
                const hit = nearestOreCell(obs, raw);
                if (!hit) {
                    add(path, "ORE_NOT_FOUND",
                        `地图上没有 "${raw}" 这种矿（扫描区域内）—— 放矿机上去也不会产出`, raw);
                    return null;
                }
                /* 附加键：与 `$ref` 一致，只放行 asCell（进 site 参数时用） */
                const bad = Object.keys(node).filter(k => k !== "$ore" && k !== "asCell" && k !== "port");
                if (bad.length) {
                    add(path, "REF_SHAPE", `$ore 只允许 asCell / port 两个附加键，多出：${bad.join(",")}`, bad);
                }
                const tag = `${PROVENANCE_PREFIX.ORE}${raw}@${hit.cell[0]},${hit.cell[1]}`;
                return { value: { cell: hit.cell }, prov: [[path, tag]] };
            }
            if ("$path_of" in node) {
                /* `$path_of` 的投影**必须**按目标参数的声明类型决定（见文件头的裁决）：
                   `BBox` 只接受恰好填满的格集；`Cell[]` 接受精确格集。其它参数一律拒绝。
                   投影失败 ⇒ 一条 violation + 返回 null（半解析的调用不进 calls）。 */
                const list = Array.isArray(node.$path_of) ? node.$path_of : [];
                const entries = list.map(h => (typeof h === "string" ? resolveHandle(handles, h) : null));
                if (!list.length || entries.some(e => !e)) {
                    add(path, "V5", "$path_of 里有句柄不在当轮句柄表里（OBS_STALE）", list);
                    return null;
                }
                let p;
                try {
                    p = pathOf(entries.map(e => e.uid), obs);
                } catch (e) {
                    add(path, "V5", `$path_of 无法计算：${e.message}`, list);
                    return null;
                }
                const tag = `${PROVENANCE_PREFIX.COMPUTED_PATH}${list.join(",")}]`;
                const kind = argKindOf(currentMacro, path);
                if (kind === "bbox") {
                    /* ★ 关键：不连续就**拒绝**，绝不返回一个把它们都包住的矩形 ★
                       这是整个算子的存在理由 —— 第三轮实验的 #1/#3/#5 全部源于「静默扩大」。 */
                    if (!p.contiguous) {
                        add(path, "PATH_NOT_RECT",
                            `$path_of 指的 ${p.cells.length} 格没有填满它们的外接矩形 [${p.region}]：`
                            + `空洞 ${JSON.stringify(p.holes)}${p.unique < p.cells.length ? "（且有重复格）" : ""}`
                            + " —— 该参数只接受矩形，非连续选区必须拆成多次调用（或改用 agrees with 目标形状的连续段）",
                            { cells: p.cells, region: p.region, holes: p.holes });
                        return null;
                    }
                    return { value: p.region, prov: [[path, tag]] };
                }
                if (kind === "cells") {
                    return { value: p.cells.map(c => [c[0], c[1]]), prov: [[path, tag]] };
                }
                add(path, "REF_SHAPE",
                    `${path} 不是坐标参数（type=${JSON.stringify(kind)}），$path_of 只能给 region / cells`,
                    { param: relPath(path), kind });
                return null;
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
        currentMacro = macro;
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
function checkTag(tag, value, { obs, knownTokens, opLike = null }) {
    if (typeof tag !== "string" || !PROVENANCE_RE.test(tag)) {
        return { ok: false, why: `provenance 形态非法：${JSON.stringify(tag)}（只允许 obs:uid=N / macro:<token> / computed:bbox_of[…] / computed:path_of[…] / ore:<色>@x,y）` };
    }
    /* ★ `$ore` 的溯源：**用当前 obs 重算**，不是信任标签里写的坐标 ★
     *
     * 和 `computed:bbox_of[…]` 同一条纪律：标签只是「我是怎么算出来的」的记录，
     * 真值必须能从 obs 重新算出来并且相等。否则世界一变（矿被挖空、换了存档），
     * 旧标签就会指向一个现在已经不是矿的格子 —— 而落盘的矿机不会产出任何东西。
     *
     * 重算 = 再调一次 `nearestOreCell`。它只看 obs.resources 和 hub，纯函数。 */
    if (tag.startsWith(PROVENANCE_PREFIX.ORE)) {
        const m = /^ore:([A-Z][a-z])@(-?\d+),(-?\d+)$/.exec(tag);
        if (!m) return { ok: false, why: `ore 标签解析失败：${JSON.stringify(tag)}` };
        const [, color, tx, ty] = m;
        const now = nearestOreCell(obs, color);
        if (!now) {
            return { ok: false, why: `obs 里现在没有 ${color} 这种矿（标签说在 ${tx},${ty}）—— 世界变了或矿已被挖空` };
        }
        if (now.cell[0] !== Number(tx) || now.cell[1] !== Number(ty)) {
            return {
                ok: false,
                why: `$ore 的重算结果不一致：标签说 ${tx},${ty}，按当前 obs 重算是 ${now.cell[0]},${now.cell[1]}`,
            };
        }
        if (isObj(value) && Array.isArray(value.cell)) {
            if (value.cell[0] !== now.cell[0] || value.cell[1] !== now.cell[1]) {
                return { ok: false, why: `$ore 的落点与重算不符：值 ${JSON.stringify(value.cell)} vs 重算 ${JSON.stringify(now.cell)}` };
            }
        }
        return { ok: true, why: null };
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
    /* `computed:path_of[…]` —— **先于** bbox 分支判断（两者前缀不同，但语义必须分开：
       bbox 判「相等」，path 还要判「这组格真的填满了它」）。 */
    if (tag.startsWith(PATH_PROVENANCE_PREFIX)) {
        const inner = tag.slice(PATH_PROVENANCE_PREFIX.length, -1);
        const hs = inner.split(",").map(s => s.trim()).filter(Boolean);
        if (!hs.length) return { ok: false, why: "path_of 标签里没有句柄" };
        const table = buildHandles(obs);
        const uids = [];
        for (const h of hs) {
            const e = resolveHandle(table, h);
            if (!e) return { ok: false, why: `path_of 标签里的句柄 ${h} 不在当前世界` };
            uids.push(e.uid);
        }
        let p;
        try { p = pathOf(uids, obs); } catch (e) { return { ok: false, why: e.message }; }

        /* 形态 ①：4 元 region —— 必须等于重算的 region，**且**重算的格集必须真的填满它。
           少了后一条，「拐弯的链」被改宽一格也能混过去（region 相等的是被改过的那份）。 */
        if (isIntArr(value, 4)) {
            if (!p.contiguous) {
                return {
                    ok: false,
                    why: `path_of 标签对应的格集不连续（空洞 ${JSON.stringify(p.holes)}），`
                        + `不能投影成 region —— 这个值是被人工扩出来的`,
                };
            }
            const same = p.region.every((v, i) => v === value[i]);
            return same ? { ok: true, why: null }
                : { ok: false, why: `region 与重算不符：值 [${value}] ≠ 由 ${hs.join(",")} 重算的 [${p.region}]` };
        }
        /* 形态 ②：格集 —— 逐项逐位比（顺序也管住：重算是确定序，改序同样是改值） */
        if (Array.isArray(value) && value.length && value.every(c => isIntArr(c, 2))) {
            const same = value.length === p.cells.length
                && value.every((c, i) => c[0] === p.cells[i][0] && c[1] === p.cells[i][1]);
            return same ? { ok: true, why: null }
                : { ok: false, why: `格集与重算不符：值 ${JSON.stringify(value)} ≠ 由 ${hs.join(",")} 重算的 ${JSON.stringify(p.cells)}` };
        }
        return { ok: false, why: `path_of 标签必须对应 [x0,y0,x1,y1] 或 [[x,y]…]，实得 ${JSON.stringify(value)}` };
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
        if (!hit) return { ok: false, why: `token "${token}" 不在当轮宏返回值里` };
        /* ★ token 里嵌的坐标必须与被验的那个值一致 ★
         *
         * 实测漏洞（2026-10-28，loop.mjs 的实现者发现、主线程复核）：
         * 以前这里只判 token **存在**就放行。于是把 `place.x` 从 4 改成 5、
         * token 仍写 `macro:replace_run:cutter@4,-13`，`assertProvenance` **照样判绿**。
         * 而 `macro:` 恰恰是主力宏（replace_run / insert_machine）**全部**用的标签形态 ——
         * 也就是说「每条落盘坐标可追溯」这条唯一的可证伪防线，对最重要的路径是空的。
         *
         * 修法：token 形如 `<macro>:<kind>@<x>,<y>`，把 `@` 后面的坐标解出来，
         * 与**实际被验的坐标**（value 若是 [x,y] 就逐位比；若同时给了 op 就比 op 的 x/y）比。
         * 解不出坐标的 token（如 `remove_run:abc`）只校验存在性 —— 但那种形态
         * 必须在 PROVENANCE_PREFIX 的文档里写明「不带坐标断言」，不许默默放行。
         */
        const at = /@(-?\d+),(-?\d+)/.exec(token);
        if (at) {
            const tx = Number(at[1]), ty = Number(at[2]);
            let vx = null, vy = null;
            if (Array.isArray(value) && value.length >= 2 && typeof value[0] === "number") {
                vx = value[0]; vy = value[1];
            }
            if (vx === null && opLike && typeof opLike.x === "number") {
                vx = opLike.x; vy = opLike.y;
            }
            if (vx !== null && (vx !== tx || vy !== ty)) {
                return {
                    ok: false,
                    why: `token 里的坐标 @${tx},${ty} 与被验的坐标 ${vx},${vy} 不一致 —— `
                        + `落盘坐标被改过，但 provenance 标签没跟着改（这是最危险的一类：标签本身成了伪证）`,
                };
            }
        }
        return { ok: true, why: null };
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
                   所以 computed 标签走单独的包含性判据，不走 checkTag 的相等判据。
                   `path_of` 用**同一套**包含性判据：它投影出来的就是同一个 region（投影
                   已在 L-B 保证连续），place 落点只要求落在里面。 */
                if (String(tag).startsWith(PROVENANCE_PREFIX.COMPUTED)
                    || String(tag).startsWith(PATH_PROVENANCE_PREFIX)) {
                    const isPathTag = String(tag).startsWith(PATH_PROVENANCE_PREFIX);
                    const bb = regionOfTag(String(tag), obs);
                    if (!bb) { add(`${at}.provenance.${f}`, "COORD_PROVENANCE", `computed 标签无法重算：${tag}`, tag); continue; }
                    const inside = op.x >= bb[0] && op.x <= bb[2] && op.y >= bb[1] && op.y <= bb[3];
                    if (!inside) add(`${at}.provenance.${f}`, "COORD_PROVENANCE",
                        `place 的 (${op.x},${op.y}) 不在 provenance ${isPathTag ? "选区" : "bbox"} [${bb}] 内`, tag);
                    continue;
                }
                /* ★ 把整个 op 传下去：`macro:` 标签里的 @x,y 必须与 op 的实际坐标一致 ★
                   只传 op[f]（单个数字）的话，checkTag 无法知道另一维，
                   于是 x 被改、y 没改也能混过去。 */
                const r = checkTag(tag, op[f], { obs, knownTokens, opLike: op });
                if (!r.ok) add(`${at}.provenance.${f}`, "COORD_PROVENANCE", r.why, tag);
            }
            return;
        }
        /* 其它 op（bulk_delete 等）：不在这里判，交给 op 形状检查 */
    });

    return { ok: violations.length === 0, violations };
}

/** 从 `computed:bbox_of[H1,H2]` / `computed:path_of[H1,H2]` 标签重算选区（当前世界）；失败返回 null。 */
function regionOfTag(tag, obs) {
    const s = String(tag);
    const isPath = s.startsWith(PATH_PROVENANCE_PREFIX);
    const prefix = isPath ? PATH_PROVENANCE_PREFIX : PROVENANCE_PREFIX.COMPUTED;
    if (!s.startsWith(prefix)) return null;
    const inner = s.slice(prefix.length, -1);
    const hs = inner.split(",").map(x => x.trim()).filter(Boolean);
    if (!hs.length) return null;
    const table = buildHandles(obs);
    const uids = [];
    for (const h of hs) {
        const e = resolveHandle(table, h);
        if (!e) return null;
        uids.push(e.uid);
    }
    try {
        if (!isPath) return bboxOf(uids, obs);
        /* path 标签：投影前必须重算并确认连续 —— 不连续 ⇒ 不存在合法的 region 投影，
           返回 null（调用方判红）。只按 bboxOf 重算会让「被改宽一格的 region」混过去。 */
        const p = pathOf(uids, obs);
        return p.contiguous ? p.region : null;
    } catch { return null; }
}
