/**
 * loop/handles.mjs — 把 `obs` 变成**一张没有坐标系的图**：句柄表 + 短语。
 *
 * 这是阶段 2 唯一的「坐标系防火墙」（v2 §0 保留的第 2 条）：
 *   LLM 永远看不到 x / y / r / code / uid；它看到的只有 `B7 belt 上游=无 下游=C1.left 货=0 段=3`。
 *   「没人算坐标」由此从口号变成**结构性事实** —— 不是靠提示词要求它别算。
 *
 * ## 为什么句柄必须确定性编号
 *
 * 同一份 obs 跑两次，同一台机器必须拿到同一个句柄。否则：
 *   · 上一轮的诊断 `subject.handle=C1` 在下一轮指向另一台机器（诊断会指错对象）；
 *   · transcript 不可复现，`transcript_sha` 失去意义（验收判据 4 要求 5 次独立 run 可比）。
 * 所以编号规则写死为：「先按 (y,x) 排序，再按类型前缀分类，同类内从 1 递增」。
 * 加进这台存档的任何新实体只有在**排序位置更靠前**时才会改变既有编号 —— 这是可接受的，
 * 因为每轮都重新编号，且 `version` 会把「表变了」这件事暴露出来。
 *
 * ## 依赖
 *   · `op-templates` 的 `footprint` —— `$bbox_of` 的并集必须含 2×1 机器的第二格
 *     （`coldstart_l4.test.mjs` 的反例：只用 origin 时 bbox 漏 (5,-13)，cutter 放不下）。
 *   · `verify_runtime.slotsOf` —— 槽位世界几何的**唯一**实现。本文件不复制它，
 *     否则「槽位」会有两份真值（这个项目已因两份真值出过 3 次事故）。
 *
 * 零依赖（只用 node 内置 + 仓库内的只读模块），无 IO。
 */
import crypto from "node:crypto";
import { templateByBuildingVariant } from "../../ai/op-templates.mjs";
import { DIRV, OPP, beltEntry, beltExit } from "../../ai/belt-rules.mjs";
import { slotsOf, beltRvOf } from "../verify_runtime.mjs";

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 编号
 * ══════════════════════════════════════════════════════════════════════════ */

/** 类型 → 句柄前缀。顺序即同一 (y,x) 下的 tie-break 之外的第二关键字。 */
export const HANDLE_PREFIX = Object.freeze({
    hub: "H",
    cutter: "C",
    painter: "C",
    mixer: "C",
    stacker: "C",
    rotater: "C",
    miner: "M",
    belt: "B",
    underground_belt: "B",
    trash: "T",
    balancer: "L",
});
const FALLBACK_PREFIX = "X";

/** @param {string} type */
export function prefixOf(type) {
    return HANDLE_PREFIX[type] || FALLBACK_PREFIX;
}

const KEY = c => `${c[0]},${c[1]}`;

/** 实体在排序里的比较器：先 (y,x)，再 type（保证同为 (y,x) 时也稳定），最后 uid。 */
function cmpEntity(a, b) {
    if (a.y !== b.y) return a.y - b.y;
    if (a.x !== b.x) return a.x - b.x;
    if (a.type !== b.type) return String(a.type) < String(b.type) ? -1 : 1;
    return a.uid - b.uid;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. footprint / 版本
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 一个实体的世界占地格（origin + footprint 展开）。
 *
 * ⚠️ 非方形 footprint 在 rotation 90/270 时，上游会位移 origin（op-templates 的
 * `rotateCell` 对此直接抛「未实机验证」）。本函数**不猜**位移，只按 origin 展开，
 * 并在返回值里标 `assumed:true`。当前两张夹具里所有机器 r=0，所以这条不影响今天的判据；
 * 一旦遇到旋转的非方形机器，调用方应把它当成「bbox 可能偏一格」而不是权威。
 *
 * @param {{type:string, variant?:string, x:number, y:number, r?:number}} e
 * @returns {{cells:Array<[number,number]>, w:number, h:number, assumed:boolean}}
 */
export function footprintCells(e) {
    const tpl = templateByBuildingVariant(e.type, e.variant || "default");
    const [w, h] = tpl && Array.isArray(tpl.footprint) ? tpl.footprint : [1, 1];
    const cells = [];
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) cells.push([e.x + dx, e.y + dy]);
    const rot = (((Math.round((Number(e.r) || 0) / 90) * 90) % 360) + 360) % 360;
    return { cells, w, h, assumed: rot % 180 !== 0 && w !== h };
}

/**
 * obs 的内容哈希（稳定序）。用途：
 *   · `version = tick|obs_hash` —— `OBS_STALE` 的判据（handle 表与当前世界是否同一份）；
 *   · transcript 里记 `world_hash`，但 hash **不足以**定位「谁消失了」——
 *     `UNDECLARED_DESTRUCTION` 必须由 loop 存 before/after 的 uid 集合（v2 §2.4）。
 *
 * 口径：只取**身份与几何**字段（uid/type/variant/x/y/r/rv/code），按 uid 升序拼接。
 * 不含 tick、不含 items、不含 region —— 那些不是世界内容。
 */
export function obsHash(obs) {
    const ents = (obs && obs.entities) || [];
    const rows = ents
        .map(e => [e.uid, e.type, e.variant || "default", e.x, e.y, e.r | 0,
            e.rotation_variant === undefined ? (e.code - 1) | 0 : e.rotation_variant | 0, e.code === undefined ? -1 : e.code])
        .sort((a, b) => a[0] - b[0])
        .map(r => r.join(","));
    return crypto.createHash("sha256").update(rows.join("\n")).digest("hex").slice(0, 16);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. buildHandles
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * @typedef {object} HandleEntry
 * @property {string} handle  "B7" / "C1" / "H1" / ...
 * @property {number} uid
 * @property {string} type
 * @property {number} x
 * @property {number} y
 * @property {number} r
 * @property {number} rv        rotation_variant（缺失时由 code-1 推，仅 belt 有意义）
 * @property {number|null} code
 * @property {Array<[number,number]>} cells  footprint 展开格（确定序：先 y 再 x）
 * @property {string} desc      给 LLM 的短语（= describeEntity 的输出，**不含坐标**）
 */

/**
 * 建句柄表。**确定性**：同一份 obs 永远得到同一张表。
 *
 * @param {object} obs  obs 的 result（需 entities[]；tick 可缺）
 * @param {object|null} [items]  debug_items 的 result（只影响 `desc` 里的货量与段长，不影响编号）
 * @returns {{byHandle:Map<string,HandleEntry>, byUid:Map<number,string>, version:string,
 *            hubHandle:string|null, obsHash:string, tick:number|null, cellOf:Map<string,string>}}
 */
export function buildHandles(obs, items = null) {
    const ents = ((obs && obs.entities) || []).slice().sort(cmpEntity);
    const byHandle = new Map();
    const byUid = new Map();
    const cellOf = new Map();        // "x,y" → handle（footprint 内任何一格都能查到本实体）
    const counts = Object.create(null);
    let hubHandle = null;

    for (const e of ents) {
        const p = prefixOf(e.type);
        counts[p] = (counts[p] || 0) + 1;
        const handle = `${p}${counts[p]}`;
        const fp = footprintCells(e);
        const rv = typeof e.rotation_variant === "number"
            ? e.rotation_variant
            : (typeof e.code === "number" && e.type === "belt" ? e.code - 1 : 0);
        const entry = {
            handle, uid: e.uid, type: e.type, variant: e.variant || "default",
            x: e.x, y: e.y, r: e.r | 0, rv,
            code: typeof e.code === "number" ? e.code : null,
            cells: fp.cells,
        };
        byHandle.set(handle, entry);
        byUid.set(e.uid, handle);
        for (const c of fp.cells) if (!cellOf.has(KEY(c))) cellOf.set(KEY(c), handle);
        if (e.type === "hub" && hubHandle === null) hubHandle = handle;
    }

    const hash = obsHash(obs);
    const tick = obs && typeof obs.tick === "number" ? obs.tick : null;
    const table = {
        byHandle, byUid, cellOf, hubHandle, obsHash: hash, tick,
        version: `${tick === null ? "tick?" : tick}|${hash}`,
    };

    /* 免费补上 `desc`：prompt.mjs（S3 段）只读 `handle/type/variant/desc` 四个字段，
       没有 desc 就只剩「B7 belt」，LLM 看不出上下游。这里在**建表时**填好，
       而不是让 prompt 自己去推导（那会让 prompt 也需要 slotsOf 与路径索引 = 第二份几何真值）。
       注意 desc 与 describeEntity 是**同一份输出**（同一函数，不是两套实现）。 */
    for (const e of ents) {
        const h = byUid.get(e.uid);
        if (h) byHandle.get(h).desc = describeEntity(e, obs, items, table);
    }
    return table;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. resolveHandle / bboxOf
 * ══════════════════════════════════════════════════════════════════════════ */

/** 句柄形态：1–2 个大写字母 + 1–3 位数字（与 v1 §3.1 的 HANDLE 文法一致）。 */
export const HANDLE_RE = /^[A-Z]{1,2}[0-9]{1,3}$/;

/**
 * 句柄 → 实体（`HandleEntry`）。不存在或形态不对返回 null —— **不抛**，
 * 因为「LLM 幻觉了一个句柄」是**数据问题**（要转成 `OBS_STALE`），不是程序错误。
 *
 * @param {ReturnType<typeof buildHandles>} table
 * @param {string} h
 * @returns {HandleEntry|null}
 */
export function resolveHandle(table, h) {
    if (!table || typeof h !== "string" || !HANDLE_RE.test(h)) return null;
    return table.byHandle.get(h) || null;
}

/**
 * `$bbox_of(handles)` → 闭区间 bbox `[x0,y0,x1,y1]`。
 *
 * 按 **origin + footprint 并集**算，不是只看 origin 点：
 * 一台 2×1 的 cutter 占地含 (x+1,y)，只看 origin 会让 region 少一格，
 * `replace_run` 报「region 太小，放不下 2×1」（`coldstart_l4.test.mjs` 的反例即此）。
 *
 * @param {Array<number|string>} uids  实体 uid（也接受句柄，需给第三参）
 * @param {object} obs
 * @param {object|null} [table]  给句柄形态时必须提供
 * @returns {[number,number,number,number]}
 * @throws uid 不在世界（这是**程序错误**：调用方应先用 resolveHandle 判过）
 */
export function bboxOf(uids, obs, table = null) {
    const list = Array.isArray(uids) ? uids : [uids];
    if (!list.length) throw new Error("$bbox_of: 空列表 —— 空集没有包围盒（不要返回 [0,0,0,0] 那种假值）");
    /* obs 必须是 obs（带 entities），不是 entities 数组：传数组时 entry.uid 取不到，
       会得到「uid X 不在世界」这种把人引向错误方向的报错。 */
    const ents = obs && Array.isArray(obs.entities) ? obs.entities
        : (Array.isArray(obs) ? (() => { throw new Error("$bbox_of: 第二个参数是 obs（{entities:[…]}），不是 entities 数组"); })()
            : []);
    const byUid = new Map(ents.map(e => [e.uid, e]));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const u of list) {
        let e = null;
        if (typeof u === "number") e = byUid.get(u) || null;
        else if (table) {
            const h = resolveHandle(table, u);
            e = h ? byUid.get(h.uid) || null : null;
        }
        if (!e) throw new Error(`$bbox_of: ${typeof u === "number" ? `uid ${u}` : `句柄 ${u}`} 不在世界`);
        const fp = footprintCells(e);
        x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y);
        x1 = Math.max(x1, e.x + fp.w - 1); y1 = Math.max(y1, e.y + fp.h - 1);
    }
    return [x0, y0, x1, y1];
}

/**
 * `$path_of(handles)` → **这些句柄所指实体的精确格集**，外加它能不能投影成矩形。
 *
 * 为什么需要它（第三轮真 LLM 实验的直接产物，`EXPERIMENT-COLDSTART.md` §15）：
 *   `$bbox_of` 给的是**最小外接矩形**，而 `replace_run.region` 要的是**恰好那几格**。
 *   当链拐弯（L 形）或两条链并行时，矩形会顺带框进没被指名的格子 ——
 *   实测 5 次里 #1 `occupied`、#3 `not_a_run`、#5 `precondition_failed` 全是这个来源。
 *
 * 语义（精确，不含近似）：
 *   · `cells`      = 按**输入顺序**展开每个实体的 footprint 格（不是 bbox，不补洞）；
 *   · `region`     = 覆盖这组格的**最小**闭区间矩形；
 *   · `contiguous` = 这组格**恰好填满**那个矩形（无空洞、无重复）。
 *   三者一起给，但**调用方不该把整个对象交给宏**：宏的 region 只吃 4 元 bbox。
 *   投影规则在 `coords.mjs`（region ← 只有 contiguous 才允许；cells ← 永远精确）。
 *
 * ⚠️ 诚实边界：`contiguous` 只判「格集是否填满自己的外接矩形」，**不判拓扑**。
 *    两条互不相邻但在矩形里恰好铺满的带子（例如并排 2×2）会被判 contiguous —
 *    这对 `replace_run` 是正确的（它要的就是一块地），但「这是不是同一条链」
 *    不在本算子的职责里（那要 `debug_items.paths`，本算子零 IO）。
 *
 * ⚠️ 另一个必须写出来的边界（第三轮实验 #5 的真实复盘）：
 *    `$path_of` 修的是**「矩形比点名的格多」**这一类失败（#1 occupied / #3 not_a_run /
 *    #5 的部分成因）。它**不**修「region 只有 1 格宽、2×1 机器放不下」——那种情况下
 *    `$path_of` 与 `$bbox_of` 给出**完全相同**的 region（实测 #5 的 7 格直线链就是
 *    contiguous:true、与 bbox 逐位相等）。所以「#5 会被 $path_of 救活」是**错的**：
 *    它救的是同一段链的拐弯/并排形态，不是窄 region 本身。
 *
 * @param {Array<number|string>} uids 实体 uid（也接受句柄，需给第三参）
 * @param {object} obs
 * @param {object|null} [table]
 * @returns {{cells:Array<[number,number]>, region:[number,number,number,number],
 *            contiguous:boolean, area:number, holes:Array<[number,number]>, unique:number}}
 * @throws 空列表 / uid 不在世界（程序错误：调用方应先用 resolveHandle 判过）
 */
export function pathOf(uids, obs, table = null) {
    const list = Array.isArray(uids) ? uids : [uids];
    if (!list.length) throw new Error("$path_of: 空列表 —— 空集没有格集（不要返回空数组假装成功）");
    const ents = obs && Array.isArray(obs.entities) ? obs.entities
        : (Array.isArray(obs) ? (() => { throw new Error("$path_of: 第二个参数是 obs（{entities:[…]}），不是 entities 数组"); })()
            : []);
    const byUid = new Map(ents.map(e => [e.uid, e]));
    const cells = [];
    for (const u of list) {
        let e = null;
        if (typeof u === "number") e = byUid.get(u) || null;
        else if (table) {
            const h = resolveHandle(table, u);
            e = h ? byUid.get(h.uid) || null : null;
        }
        if (!e) throw new Error(`$path_of: ${typeof u === "number" ? `uid ${u}` : `句柄 ${u}`} 不在世界`);
        for (const c of footprintCells(e).cells) cells.push(c);
    }
    const xs = cells.map(c => c[0]), ys = cells.map(c => c[1]);
    const region = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const area = (region[2] - region[0] + 1) * (region[3] - region[1] + 1);

    const seen = new Set();
    const dupes = [];
    for (const c of cells) {
        const k = KEY(c);
        if (seen.has(k)) dupes.push(c);
        seen.add(k);
    }
    /* 空洞：矩形内没被覆盖的格（只取前 8 个，用于报错；不改变判据） */
    const holes = [];
    for (let y = region[1]; y <= region[3] && holes.length < 8; y++) {
        for (let x = region[0]; x <= region[2] && holes.length < 8; x++) {
            if (!seen.has(KEY([x, y]))) holes.push([x, y]);
        }
    }
    /* contiguous 的判据同时管住两种「不能投影成矩形」的形态：
       ① 矩形里有洞（L 形链、跨链选集）；② 重复格（同一实体被点名两次，格数 > 面积）。 */
    const contiguous = dupes.length === 0 && cells.length === area;
    return { cells, region, contiguous, area, holes, unique: seen.size };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. describeEntity —— 给 LLM 看的短语（**绝不含坐标**）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 句柄表缓存：obs 对象 → 表。同一份 obs 被描述 181 次时不重建表（描述是 O(n) 的，表是 O(n log n)）。
 *
 *  ⚠️ 缓存键只含 obs —— 因为**编号不看 items**（见 buildHandles）。若将来编号开始依赖 items，
 *  这个缓存必须同时按 items 分桶，否则同一份 obs + 不同 items 会拿到旧表。 */
const TABLE_CACHE = new WeakMap();
function cachedTable(obs, items) {
    if (obs && typeof obs === "object") {
        let t = TABLE_CACHE.get(obs);
        if (!t) { t = buildHandles(obs, items); TABLE_CACHE.set(obs, t); }
        return t;
    }
    return buildHandles(obs, items);
}

/** 路径索引缓存：items 对象 → index。同一个 items 被描述 181 次时不重建（建一次是 O(总格数)）。 */
const PATH_INDEX_CACHE = new WeakMap();

/** 路径索引：cell → {path, indexInPath, pathId}（同一格只记第一条路径，与 checkFlow 同口径）。 */
function pathIndex(items) {
    if (items && typeof items === "object") {
        const hit = PATH_INDEX_CACHE.get(items);
        if (hit) return hit;
        const made = buildPathIndex(items);
        PATH_INDEX_CACHE.set(items, made);
        return made;
    }
    return buildPathIndex(items);
}

function buildPathIndex(items) {
    const idx = new Map();
    const paths = (items && Array.isArray(items.paths)) ? items.paths : [];
    paths.forEach((p, i) => {
        const cells = p.cells || [];
        cells.forEach((c, j) => {
            const k = KEY(c);
            if (!idx.has(k)) idx.set(k, { path: p, i, pathId: i, indexInPath: j, len: cells.length });
        });
    });
    return idx;
}

/** 某格上的实体句柄（用 footprint 索引，机器第二格也能查到）。 */
function handleAt(table, cell) {
    return table.cellOf.get(KEY(cell)) || null;
}

/** 机器参考写法：`C1` / `C1.left`（role 给出时带 role）。 */
function ref(handle, role) {
    if (!handle) return "无";
    return role ? `${handle}.${role}` : handle;
}

/**
 * 一个实体在**当前世界**里的短语。输出形如：
 *   `B7 belt 上游=无 下游=C1.left 货=0 段=3`
 *   `C1 cutter 输入=bottom(←B12) 输出=top:left(→无)/top:right(→B9)`
 *
 * **绝对不含数字坐标**。允许出现的数字只有计数（货量、段长、槽位序），
 * 这不是约定而是被测试钉住的：对 L5 全部 181 实体跑一遍，输出不得匹配坐标正则。
 *
 * @param {object} e      obs.entities[] 的一项
 * @param {object} obs
 * @param {object|null} items  debug_items 的 result
 * @param {object|null} table  已建好的句柄表（buildHandles 内部调用时传入，避免递归重建）
 * @returns {string}
 */
export function describeEntity(e, obs, items = null, table = null) {
    const tbl = table || cachedTable(obs, items);
    const self = tbl.byUid.get(e.uid);
    const h = self || "?";
    const idx = pathIndex(items);
    const type = e.type;

    /* ── 带子 / 隧道：上下游 + 货量 + 段长 ── */
    if (type === "belt" || type === "underground_belt") {
        const rv = typeof e.rotation_variant === "number" ? e.rotation_variant : Math.max(0, (e.code | 0) - 1);
        const inDir = beltEntry(rv, e.r | 0);
        const outDir = beltExit(rv, e.r | 0);
        const upCell = [e.x + DIRV[inDir][0], e.y + DIRV[inDir][1]];
        const dnCell = [e.x + DIRV[outDir][0], e.y + DIRV[outDir][1]];

        const upH = handleAt(tbl, upCell);
        const upRole = slotRoleAt(tbl, obs, upCell, OPP[inDir], "out");
        const dnH = handleAt(tbl, dnCell);
        const dnRole = slotRoleAt(tbl, obs, dnCell, OPP[outDir], "in");

        const pi = idx.get(KEY([e.x, e.y]));
        const goods = pi ? (pi.path.itemsOnPath | 0) : 0;
        const seg = pi ? pi.len : 1;

        /* 隧道：入口/出口的方位语义与普带相同（code 22/23 的 sender/receiver），
           但「上游/下游」这个词对它不成立（另一端在别处），所以用 入口/出口。
         *
         * ⚠️ **必须标出 sender / receiver 与「不可作为端点」**。
         *
         * `rotation_variant` 对隧道是 **sender(0) / receiver(1) 标志位**，
         * 不是转弯形态（`underground_belt.js:30-37` 的 `overlayMatrices` 顺序即
         * 「Sender / Receiver」，`EXPERIENCE-SOURCE-FACTS.md` §8.2 有出处）。
         *
         * 实测（`EXECUTION-RATE-BOTTLENECK.md`）：模型把 `B85` 当输出源去 `connect`，
         * 宏报 `endpoint_not_a_port: from 指向的实体没有 ejector`。3/58 条栽在这上面。
         *
         * 而 `connect.mjs:194-199` 明写「隧道的连接语义还需要处理成对 portal ——
         * 那是独立特性，不在本修复范围」。**所以隧道端点在 connect 里一律不可用**
         * —— desc 必须直说，让模型改用配对端或干脆绕开。 */
        if (type === "underground_belt") {
            const rv = typeof e.rotation_variant === "number" ? e.rotation_variant : Math.max(0, (e.code | 0) - 1);
            const role = rv === 0 ? "sender(源)" : "receiver(汇)";
            return `${h} underground_belt ${role} 入口=${inDir}(←${ref(upH, upRole)}) 出口=${outDir}(→${ref(dnH, dnRole)}) 货=${goods}`
                + ` [隧道端点不能当 connect 的 from/to，用配对端]`;
        }
        return `${h} belt 上游=${ref(upH, upRole)} 下游=${ref(dnH, dnRole)} 货=${goods} 段=${seg}`;
    }

    /* ── hub：16 个入口全列会把 S3 预算吃光，且 LLM 对它只有「接进/接出」两件事。
       所以压成「入口数 + 已接哪几个」。 ── */
    if (type === "hub") {
        const s = slotsOf(type, e.variant || "default", e.x, e.y, e.r | 0, beltRvOf(e));
        const total = s ? s.inputs.length : 0;
        const fed = (s ? s.inputs : [])
            .map(sl => handleAt(tbl, sl.cell))
            .filter(Boolean);
        return `${h} hub 入口=${total} 已接=${fed.length}${fed.length ? "(" + fed.join("/").replace(/([A-Z]+\d+)/g, "←$1") + ")" : ""}`;
    }

    /* ── 机器：槽位逐条列出（slot 的世界方位 + 对端句柄） ── */
    const s = slotsOf(type, e.variant || "default", e.x, e.y, e.r | 0, beltRvOf(e));
    if (!s) {
        /* constant_signal 这类没有模板的实体：只说类型，不猜几何 */
        return `${h} ${type}`;
    }
    const inParts = s.inputs.map(sl => {
        const other = handleAt(tbl, sl.cell);
        /* ⚠️ 输入槽也要标 role，理由与下面输出槽那段完全一样。
         *
         * 原来这里渲染 `输入=bottom(←B100)` —— 只给了方位，没给 role。
         * 实测（`AB-REAL-SAVE-RESULT.md`，30 条真实存档样本）：
         * 模型照着写 `{"to":{"$ref":"C1","port":"bottom"}}`，
         * 而宏的 port 只认角色名：`to.port="bottom" 不是合法角色`（候选是 `primary`）。
         * 这是 `connect` 失败的主因之一（30 条里 4 次 `bad_type`）。
         *
         * 注意 cutter 的**输入** role 是 `primary`、**输出** role 才是 `left|right` ——
         * 两边同名不同义，所以必须分开标，不能只标一边。 */
        return `${sl.dir}:${sl.role}(${other ? "←" + other : "←无"})`;
    });
    const outParts = s.outputs.map(sl => {
        const other = handleAt(tbl, sl.cell);
        return `${sl.dir}:${sl.role}(→${other || "无"})`;
    });
    const bits = [`${h} ${type}`];
    if (inParts.length) bits.push(`输入=${inParts.join("/")}`);
    /* ⚠️ 输出槽的写法必须点明「port 参数该填什么」。
     *
     * 原来这里只渲染 `输出=top:primary(→B22)/top:secondary(→无)`。
     * 实测（`EXPERIENCE-AB-RESULT.md`）：模型照着这个写
     * `{"outlet":{"$ref":"L1","port":"top:secondary"}}`，而宏的 `port`
     * 只接受 `primary|secondary|left|right|quad0..3|auto`（`contract.mjs:1373`），
     * **`top:` 前缀会让它报 `bad_type`**。
     *
     * 45 条样本里出现 9 次这个写法（A2 6 次 / B2 3 次 / B2+C 0 次），
     * 全部在宏层被拒。这不是玩法错误，是**描述格式与参数格式不一致**。
     *
     * 修法：方位保留（它对规划有用），但把 role 单独标成 `port=...`，
     * 让「哪个是方位、哪个是要填的值」不再混淆。 */
    if (outParts.length) {
        bits.push(`输出=${outParts.join("/")}`);
        bits.push(`port=${s.outputs.map(sl => sl.role).join("|")}`);
    }
    /* 输入角色的合法值单独给一份。`port=` 这个名字在两边都出现，
       但**角色集合不同**（cutter 输入只有 primary，输出是 left|right），
       所以不能合并成一行，否则模型会拿输出角色去填输入端口。 */
    if (inParts.length && s.inputs.some(sl => sl.role)) {
        bits.push(`in.port=${[...new Set(s.inputs.map(sl => sl.role).filter(Boolean))].join("|")}`);
    }
    if (!inParts.length && !outParts.length) bits.push("无槽位");
    return bits.join(" ");
}

/**
 * 某格上的实体，是不是「朝 facingDir 这个方向」的某个槽（in/out），返回该槽 role。
 * 用于把「下游=B9」细化成「下游=C1.left」。
 */
function slotRoleAt(table, obs, cell, facingDir, side) {
    const h = handleAt(table, cell);
    if (!h) return null;
    const ent = table.byHandle.get(h);
    if (!ent) return null;
    const s = slotsOf(ent.type, ent.variant, ent.x, ent.y, ent.r, beltRvOf(ent));
    if (!s) return null;
    const list = side === "in" ? s.inputs : s.outputs;
    /* 槽的 dir 是「机器 → 外侧」；带子从外面看进来时方向相反，已由调用方取 OPP */
    const hit = list.find(sl => sl.dir === facingDir);
    return hit ? hit.role : null;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 给 prompt 用的批量描述（S3 段）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 生成 prompt 的 S3「世界状态」段：机器全列 + **最多 N 条**带子（v2 §3.4 的预算规则：
 * 超预算只允许截断带子列表，goal/hub/diagnosis 永不截断）。
 *
 * @param {object} obs
 * @param {object|null} items
 * @param {{beltsMax?:number, focus?:string[]}} [opts] focus = 必须包含的句柄（诊断相关的带子）
 * @returns {{lines:string[], truncated:boolean, listed:number, total:number}}
 */
export function describeWorld(obs, items = null, opts = {}) {
    const max = Number.isInteger(opts.beltsMax) ? opts.beltsMax : 12;
    const table = cachedTable(obs, items);
    const all = ((obs && obs.entities) || []).slice().sort(cmpEntity);
    const hOf = e => table.byUid.get(e.uid) || "?";

    const machines = all.filter(e => e.type !== "belt" && e.type !== "underground_belt");
    const belts = all.filter(e => e.type === "belt" || e.type === "underground_belt");

    /* focus 优先：诊断点名的带子必须在场，否则 LLM 看不到要改的东西。 */
    const focus = new Set(opts.focus || []);
    const focused = belts.filter(e => focus.has(hOf(e)));
    const rest = belts.filter(e => !focus.has(hOf(e)));
    const picked = [...focused, ...rest].slice(0, Math.max(max, focused.length));

    const lines = [];
    for (const e of [...machines, ...picked]) lines.push(describeEntity(e, obs, items));

    /* 隧道与带子混排会破坏「机器表 + 带子表」的可读性，但保持同一集合更省字符：
       这里按「机器的显示序 + 带子的显示序」输出，与句柄编号序一致（都按 y,x 排过）。 */
    return {
        lines,
        truncated: belts.length > picked.length,
        listed: picked.length,
        total: belts.length,
    };
}
