/**
 * contract.mjs — 宏技能库的 **ABI 契约**（类型 + 校验 + 规格），不含任何实现。
 *
 * 谁读这个文件：
 *   · A3 / A4  按 MACRO_SPECS 实现宏；`validateXxxArgs()` 是它们的**唯一**入参入口
 *   · A2       按 REMOVES_SPEC / RETURN_ENVELOPE 改 gates
 *   · A6       按 ENDPOINT_RULE 生成调用（LLM 层不许自己拼坐标）
 *   · 任何 lint  `lintNoBareCoords()` 机器检查「宏调用里有没有裸坐标参数」
 *
 * 为什么契约要先于实现定死：
 *   这个项目踩过的坑全是**接口层**的 —— `place{r, rotationVariant}` 里两个参数语义重叠，
 *   于是 `r=90` 得到 code=1 直带（AI-CONTROL-STATUS §2）；43 实体方案 13 个朝向全反
 *   （L4-PLAN-A-REVIEW）；`delete{x,y}` 不认 uid，导致 L4 唯一正解「删 3 带」无法表达。
 *   这些都不是算法错，是**接口允许了错误的调用**。Anthropic 的 poka-yoke 原则：
 *   "Change the arguments so that it is harder to make mistakes."（RESEARCH-B §5.1B）
 *
 * 本文件**零依赖**、无副作用、不读写世界、不读 obs。
 * 纯函数：给定 args 只做结构校验与默认值归一，不做任何存在性判断
 * （"这个 uid 在不在世界里"是运行时的事，属于宏实现，不属于契约）。
 *
 * @version 1
 */

/* ══════════════════════════════════════════════════════════════════════════
 * 0. 坐标三分法 —— 本契约最重要的一条（对应 CONTRACT-MACROS.md §2）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 一个宏参数属于哪一类。**只有这四类，没有第五类。**
 *
 * - `endpoint`  端点：**指名一个已经存在的东西**（实体 + 槽位）。值必须原样来自 `obs`
 *               的 `entities[].uid`（首选）或 `entities[].x/y`（次选）。宏对它不做算术。
 * - `site`      落点：本次要在哪里**新放**一样东西。**每调用至多一个**，且值必须来自
 *               obs 的既有实体格（即在替换它）或上一个宏的返回值。不是"随便挑个空格"。
 * - `choice`    离散选择：不影响位置、只影响"怎么做"的枚举（`dir` / `facing` / `prefer` /
 *               `port`）。是**方位词**不是角度；给角度（0/90/180/270）一律拒绝。
 * - `computed`  算坐标：值依赖几何才能得出的东西 —— 路径格、转角、rv、槽位格、
 *               footprint 展开格、旋转后的 origin、hub 入口格、距离/格数。
 *               **这类参数一律不得出现在公开 ABI 里**，必须由宏内部算。
 *
 * 判据（可机器检查的口径）：**把一个参数改动 1 格，是在改变"要动哪条东西"，
 * 还是在改变"这条东西怎么走"？** 前者是端点/落点，后者是"怎么做"（choice）
 * 或"走哪儿"（computed）。而 computed 的共同点是 —— **它的合法值取决于世界，
 * 不取决于调用方想表达什么**。`len=4` 不取决于世界（4 就是 4），所以它是 choice，
 * 不是 computed；`at=[4,-13]` 取决于世界（那格必须真有带子），所以是 site。
 *
 * 推论：公开 ABI 里**端点最多 2 个**（connect 的 from/to）、**落点最多 1 个**
 * （insert_machine.at），**computed 一个都不许有**。
 * `lintNoBareCoords()` 按这个上界做机器检查。
 */
export const COORD_CLASSES = Object.freeze(["endpoint", "site", "choice", "computed"]);

/**
 * 公开 ABI 里**禁止出现的参数名**。
 *
 * 理由：这些名字在本仓库里已经有歧义历史 —— `r` 是 rotation 角度、`rotationVariant` 是
 * 带子形态位（0 直 / 1 左弯 / 2 右弯），两者语义**正交**却在 `place` 里并列，且
 * `place{r:90}` 在实机上得到过 code=1 直带（游戏按邻居自动定向覆盖了调用方的意图）。
 * 任何让 LLM 填这几个名字的接口，都是在重复那次事故。
 */
export const FORBIDDEN_ARG_KEYS = Object.freeze([
    "x", "y", "r", "rv", "rot", "rotation", "rotationVariant", "rotation_variant", "originalRotation",
]);

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 基础类型
 * ══════════════════════════════════════════════════════════════════════════ */

/** @typedef {[number, number]} Cell 世界格 [x, y]（y 向下为正；与游戏一致） */
/** @typedef {"top"|"right"|"bottom"|"left"} Face 世界方位。top=0°,right=90°,bottom=180°,left=270° */
/** @typedef {number} Uid 实体稳定 uid（obs 的 entities[].uid） */

/**
 * @typedef {object} Endpoint
 * @property {Uid}    [uid]   首选：直接指名实体（obs 给的值）
 * @property {Cell}   [cell]  次选：实体 origin 格（obs 给的值）。**不是目的地，是引用**
 * @property {string} [port]  槽位选择；缺省 "auto"。见 PORT_RESOLUTION
 *
 * `uid` 与 `cell` **二选一**，都给且不一致 → 2001 同族错误（不猜）。
 * 两者都不指代一个**已存在的实体**时，运行期报 `endpoint_not_found`。
 */

/**
 * @typedef {object} BoundingBox 闭区间包围盒 [x0,y0,x1,y1]，四边都含
 * @property {number} 0
 * @property {number} 1
 * @property {number} 2
 * @property {number} 3
 */

/** @typedef {[number,number,number,number]} BBox */

/** 槽位选择：
 *  - `"auto"`（缺省）：仅当该端点上候选槽位**恰好 1 个**时合法；
 *    目标端点是 hub 时例外 —— hub 有 16 个入口，`auto` 走入口分配并回报 `chosen_port`。
 *  - 角色名 `"out" | "left" | "right" | "primary" | "lower" | "upper" | "quad0..3"`：
 *    该角色在此实体上必须**唯一**，否则 `ambiguous_port` 并列出候选。
 *  - `{role:string, index:number}`：角色重复时按 index 消歧（如 hub 的 16 个 primary）。
 *  - `{entry:0..15}`：只对 hub 合法。索引顺序 = `op-templates.hubEntriesWorld()` 的输出顺序
 *    （顶排 4 → 底排 4 → 左列 4 → 右列 4）。**这是索引，不是坐标** —— 把"选哪个口"
 *    降成 0..15 的离散选择，正是 pin assignment 该在宏里做的事。
 */
export const PORT_FORMS = Object.freeze(["auto", "role", "{role,index}", "{entry}"]);

/** 宏级错误码。闭集 —— 调用方（LLM / loop）按 code 分支，不按 message 分支。 */
export const ERROR_CODES = Object.freeze({
    unknown_field: "参数里有未定义的键（含被禁的裸坐标键）",
    missing_field: "必填参数缺失",
    bad_type: "参数类型/取值不合法",
    bad_arity: "坐标类参数超过本契约允许的上界（见 COORD_CLASSES）",
    endpoint_not_found: "端点 uid/cell 在当前世界不存在（obs 过期或已被别人删掉）",
    endpoint_not_a_port: "端点存在，但不是能连的端口（没有对应的 ejector/acceptor）",
    ambiguous_port: "端口选择不唯一，必须显式给 port",
    ambiguous_site: "落点能对应多个合法摆法（或反解出的端口不唯一），必须显式消歧",
    port_already_bound: "源端口已经有接收方；再连一条会让旧的饿死",
    target_already_fed: "目标端口已经有供料方",
    no_path: "在现有障碍下找不到合法路径（不是参数错，是几何不可行）",
    occupied: "目标格被不可替换的建筑占着",
    blocked_by_machine: "footprint 覆盖到机器（宏只替换带子，绝不删机器）",
    not_a_run: "选择里含非带子实体（本宏只处理带子）",
    run_not_contiguous: "给的带子不连成一段（通常是选集错了）",
    unsupported_building: "该 building 在本宏的 v1 支持矩阵之外",
    out_of_scope: "超出 v1 范围（多层 / 隧道 / wire / 旋转机器的某一面）",
    tx_unavailable: "mod 未提供事务能力，原子执行不可保证 → 拒绝执行而不是半做",
    precondition_failed: "前置条件不满足（详见 error.detail）",
    partial_apply: "只做成了一部分 —— 事务层失职，必须立刻回滚并上报",
    verification_failed: "落地后读回与计划不一致（first_mismatch 给出第一处）",
    internal: "宏实现内部错误（不该出现；出现即为 bug）",
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 校验工具（纯函数）
 * ══════════════════════════════════════════════════════════════════════════ */

/** @typedef {{code:string, field:string|null, message:string, hint?:string, candidates?:any[]}} MacroError */
/** @typedef {{ok:true, error:null, value:any} | {ok:false, error:MacroError, value:null}} Validation */

const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = v => typeof v === "number" && Number.isInteger(v);
const isNum = v => typeof v === "number" && Number.isFinite(v);
const isFace = v => v === "top" || v === "right" || v === "bottom" || v === "left";
const isCell = v => Array.isArray(v) && v.length === 2 && isInt(v[0]) && isInt(v[1]);
const isBBox = v => Array.isArray(v) && v.length === 4 && v.every(isInt)
    && v[0] <= v[2] && v[1] <= v[3];

/** @returns {Validation} */
const ok = value => ({ ok: true, error: null, value });
/** @returns {Validation} */
const fail = (code, field, message, hint) => ({
    ok: false,
    error: { code, field, message, ...(hint ? { hint } : {}) },
    value: null,
});

/**
 * 统一收口：未知字段一律报错（不静默忽略）。
 * 与 mod 的 `validateAction()` 同一条纪律（PROTOCOL §5「未知字段/未知 op 一律 2001」）。
 */
function rejectUnknownKeys(args, allowed, macro) {
    for (const k of Object.keys(args)) {
        if (k === "op" || k === "macro") continue;
        if (!allowed.includes(k)) {
            if (FORBIDDEN_ARG_KEYS.includes(k)) {
                return fail("unknown_field", k,
                    `${macro} 不接受裸坐标参数 '${k}'`,
                    `坐标必须由宏内部计算。端点请用 uid（来自 obs.entities[].uid）；`
                    + `点位的选择只能通过端点/落点参数表达。见 CONTRACT-MACROS.md §2`);
            }
            return fail("unknown_field", k,
                `${macro} 不认识参数 '${k}'`,
                `允许的参数：${allowed.join(", ")}`);
        }
    }
    return null;
}

/**
 * 端点校验（结构层）：uid 与 cell 二选一。
 * **不判断存在性** —— 那是运行时（宏实现）的事。
 */
function validateEndpoint(v, field) {
    if (!isObj(v)) {
        return fail("bad_type", field,
            `${field} 必须是 {uid} 或 {cell:[x,y]} 或 {hub:{...}} 形式的端点对象`,
            "端点指名一个**已存在**的实体。obs.entities[] 里能直接拿 uid。");
    }
    const hasUid = v.uid !== undefined;
    const hasCell = v.cell !== undefined;
    const hasHub = v.hub !== undefined;
    const n = [hasUid, hasCell, hasHub].filter(Boolean).length;
    if (n !== 1) {
        return fail("bad_type", field,
            `${field} 必须在 uid / cell / hub 中**恰好给一个**（现在给了 ${n} 个）`,
            "同时给多个时宏无法判断你想要哪个 —— 与 place 的 rv/orig 别名冲突同一类错误。");
    }
    const port = v.port;
    if (port !== undefined) {
        const p = validatePort(port, `${field}.port`);
        if (!p.ok) return p;
    }
    for (const k of Object.keys(v)) {
        if (!["uid", "cell", "hub", "port"].includes(k)) {
            return fail("unknown_field", `${field}.${k}`, `${field} 不认识键 '${k}'`);
        }
    }
    if (hasUid && !isInt(v.uid)) {
        return fail("bad_type", `${field}.uid`, `${field}.uid 必须是整数（obs 的 uid）`, `实得 ${JSON.stringify(v.uid)}`);
    }
    if (hasUid && v.uid < 0) {
        return fail("bad_type", `${field}.uid`, `${field}.uid 必须 >= 0`, `实得 ${v.uid}`);
    }
    if (hasCell && !isCell(v.cell)) {
        return fail("bad_type", `${field}.cell`,
            `${field}.cell 必须是 [x,y] 整数对`,
            "cell 是**对既有实体 origin 的引用**，不是你可以随意填的目的地。");
    }
    const hubRef = hasHub ? v.hub : null;
    if (hasHub) {
        const h = v.hub;
        if (!isObj(h) || Object.keys(h).some(k => !["uid", "cell", "entry"].includes(k))) {
            return fail("bad_type", `${field}.hub`, `${field}.hub 只允许 {uid?} / {cell?} / {entry?:0..15}`);
        }
        if (h.entry !== undefined && !(isInt(h.entry) && h.entry >= 0 && h.entry <= 15)) {
            return fail("bad_type", `${field}.hub.entry`, `hub.entry 必须是 0..15 的整数`,
                "索引顺序 = op-templates.hubEntriesWorld() 输出顺序（顶4 底4 左4 右4）");
        }
    }
    return ok({
        ...(hasUid ? { uid: v.uid } : {}),
        ...(hasCell ? { cell: [v.cell[0], v.cell[1]] } : {}),
        ...(hasHub ? { hub: { ...hubRef } } : {}),
        ...(port !== undefined ? { port } : { port: "auto" }),
    });
}

function validatePort(port, field) {
    if (port === "auto") return ok("auto");
    if (typeof port === "string") {
        if (!/^[a-z][a-z0-9_]{0,31}$/.test(port)) {
            return fail("bad_type", field, `${field} 角色名必须是小写标识符`, `实得 ${JSON.stringify(port)}`);
        }
        return ok(port);
    }
    if (isObj(port)) {
        const keys = Object.keys(port);
        if (keys.length === 1 && keys[0] === "entry") {
            if (!(isInt(port.entry) && port.entry >= 0 && port.entry <= 15)) {
                return fail("bad_type", `${field}.entry`, `${field}.entry 必须是 0..15 的整数`);
            }
            return ok({ entry: port.entry });
        }
        if (keys.every(k => k === "role" || k === "index")) {
            if (typeof port.role !== "string" || !isInt(port.index) || port.index < 0) {
                return fail("bad_type", field, `${field} 的 {role,index} 需要 role:string + index:>=0 整数`);
            }
            return ok({ role: port.role, index: port.index });
        }
        return fail("bad_type", field, `${field} 只允许 {role,index} 或 {entry}`);
    }
    return fail("bad_type", field, `${field} 必须是 "auto" | 角色名 | {role,index} | {entry}`);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 六个宏的入参校验
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * connect(from, to, opts?)
 *
 * 从 from 的某个 ejector 连一条带到 to 的某个 acceptor。路径、转角、每格 (rotation, rv)、
 * 以及失败时的 rip-up，全部在内部完成 —— 调用方一个坐标都不给。
 *
 * @param {{from:Endpoint, to:Endpoint, opts?:object}} args
 * @returns {Validation} value = 归一后的 {from, to, opts}
 */
export function validateConnectArgs(args) {
    const A = "connect";
    if (!isObj(args)) return fail("bad_type", null, `${A} 的入参必须是对象`);
    const unk = rejectUnknownKeys(args, ["from", "to", "opts"], A);
    if (unk) return unk;
    if (args.from === undefined) return fail("missing_field", "from", `${A} 缺 from`);
    if (args.to === undefined) return fail("missing_field", "to", `${A} 缺 to`);

    const from = validateEndpoint(args.from, "from");
    if (!from.ok) return from;
    const to = validateEndpoint(args.to, "to");
    if (!to.ok) return to;

    const opts = args.opts === undefined ? {} : args.opts;
    if (!isObj(opts)) return fail("bad_type", "opts", `${A}.opts 必须是对象`);
    const allowed = ["rebind", "allow_replace", "max_cells", "prefer", "dry_run"];
    for (const k of Object.keys(opts)) {
        if (!allowed.includes(k)) return fail("unknown_field", `opts.${k}`, `${A}.opts 不认识 '${k}'`);
    }
    if (opts.rebind !== undefined && typeof opts.rebind !== "boolean") {
        return fail("bad_type", "opts.rebind", "rebind 必须是布尔");
    }
    if (opts.allow_replace !== undefined && typeof opts.allow_replace !== "boolean") {
        return fail("bad_type", "opts.allow_replace", "allow_replace 必须是布尔");
    }
    if (opts.dry_run !== undefined && typeof opts.dry_run !== "boolean") {
        return fail("bad_type", "opts.dry_run", "dry_run 必须是布尔");
    }
    if (opts.max_cells !== undefined && !(isInt(opts.max_cells) && opts.max_cells >= 1 && opts.max_cells <= 5000)) {
        return fail("bad_type", "opts.max_cells", "max_cells 必须是 1..5000 的整数",
            "默认 2000。超过这个量级说明不是「连一条线」，是该用 build_line。");
    }
    if (opts.prefer !== undefined && !["shortest", "fewest_turns", "reuse_existing"].includes(opts.prefer)) {
        return fail("bad_type", "opts.prefer",
            `prefer 必须是 shortest | fewest_turns | reuse_existing`, `实得 ${JSON.stringify(opts.prefer)}`);
    }

    /* 同一个端点的同一个端口不能自己连自己 */
    const same = (a, b) => (a.uid !== undefined && b.uid !== undefined && a.uid === b.uid)
        || (a.cell !== undefined && b.cell !== undefined && a.cell[0] === b.cell[0] && a.cell[1] === b.cell[1]);
    if (same(from.value, to.value) && from.value.port === to.value.port) {
        return fail("precondition_failed", "to",
            "from 与 to 是同一个实体的同一个端口",
            "自连没有物理意义。若想让货绕回来，源和宿必须是不同实体。");
    }

    return ok({
        from: from.value,
        to: to.value,
        opts: {
            rebind: opts.rebind === true,
            allow_replace: opts.allow_replace === true,
            max_cells: opts.max_cells === undefined ? 2000 : opts.max_cells,
            prefer: opts.prefer === undefined ? "fewest_turns" : opts.prefer,
            dry_run: opts.dry_run === true,
        },
    });
}

/**
 * insert_machine(at, facing, machine, opts?)
 *
 * 在 at 放一台机器，朝向 facing。footprint、rotation、旋转后的 origin、槽位世界格全部内部算。
 *
 * `at` 的确切语义（**v1 定死**，理由见下）：
 *   游戏里 `place{x,y,r}` 的 x/y 就是 `origin`（`static_map_entity.js:117` `this.origin`），
 *   而 `getTileSpaceBounds()`（同文件 :127-141）在 r=180/270 时让**可见 bbox** 向负方向长，
 *   origin 本身**不动**。所以「机器站上去的任意一格」在 r≠0 时是多义的 ——
 *   同一组格子可能对应 1~2 个 origin。v1 把两种意图拆成两种形状，不猜：
 *     · `[x,y]`                    → 直接给 **origin**（来自 obs `entities[].x/y` 或上一宏返回值）
 *     · `{cell:[x,y], part:"any"}` → 给「机器要占的其中一格」，宏按 footprint 反解 origin；
 *                                    命中多个 → `ambiguous_site` 并列出候选，不猜。
 *
 * `facing` 的定义（最容易被误用，故写死）：
 *   **机器 primary output 喷射的**世界方向。不是 `place.r`、不是输入来向、不是 rv。
 *   rotation 由 `rotate(模板.primaryOutputDir, r) === facing` 反解。
 *   例：cutter 的 primary output 在局部是 top，所以 facing="top" ⇒ r=0；
 *       painter(default) 的 primary output 在局部是 right，所以 facing="right" ⇒ r=0。
 *   两者 r 都是 0 但世界流向不同 —— 这正是"facing 不是 r"的证明。
 *
 * @param {{at:Cell|{cell:Cell,part?:"any"}, facing:Face, machine:string|{kind:string,variant?:string}, opts?:object}} args
 * @returns {Validation}
 */
export function validateInsertMachineArgs(args) {
    const A = "insert_machine";
    if (!isObj(args)) return fail("bad_type", null, `${A} 的入参必须是对象`);
    const unk = rejectUnknownKeys(args, ["at", "facing", "machine", "opts"], A);
    if (unk) return unk;

    if (args.at === undefined) return fail("missing_field", "at", `${A} 缺 at`);
    let at = null;
    if (isCell(args.at)) {
        at = { kind: "origin", cell: [args.at[0], args.at[1]] };
    } else if (isObj(args.at)) {
        for (const k of Object.keys(args.at)) {
            if (!["cell", "part"].includes(k)) {
                return fail("unknown_field", `at.${k}`, `${A}.at 不认识键 '${k}'`);
            }
        }
        if (!isCell(args.at.cell)) {
            return fail("bad_type", "at.cell", `${A}.at.cell 必须是 [x,y] 整数对`);
        }
        if (args.at.part !== undefined && args.at.part !== "any") {
            return fail("bad_type", "at.part", `${A}.at.part 只接受 "any"`,
                "v1 只支持「机器要占的其中任意一格」这一种反解。");
        }
        at = { kind: "any-cell", cell: [args.at.cell[0], args.at.cell[1]] };
    } else {
        return fail("bad_type", "at",
            `${A}.at 必须是 [x,y]（= 机器 origin）或 {cell:[x,y]}（机器要占的任意一格）`,
            "两种形态语义不同，不能用同一形状表达：前者宏不做算术，后者要反解 origin（可能多解）。");
    }

    if (args.machine === undefined) return fail("missing_field", "machine", `${A} 缺 machine`);
    let kind = null, variant = "default";
    if (typeof args.machine === "string") {
        kind = args.machine;
    } else if (isObj(args.machine)) {
        for (const k of Object.keys(args.machine)) {
            if (!["kind", "variant"].includes(k)) {
                return fail("unknown_field", `machine.${k}`, `${A}.machine 不认识 '${k}'`);
            }
        }
        kind = args.machine.kind;
        variant = args.machine.variant === undefined ? "default" : args.machine.variant;
        if (typeof variant !== "string") return fail("bad_type", "machine.variant", "machine.variant 必须是字符串");
    } else {
        return fail("bad_type", "machine", `${A}.machine 必须是字符串或 {kind,variant}`);
    }
    if (typeof kind !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(kind)) {
        return fail("bad_type", "machine", `${A}.machine(kind) 必须是小写建筑标识（如 "cutter"）`, `实得 ${JSON.stringify(kind)}`);
    }

    if (args.facing !== undefined && !isFace(args.facing)) {
        return fail("bad_type", "facing",
            `${A}.facing 必须是 top|right|bottom|left`,
            "facing = primary output 的世界喷射方向。**不是角度、不是 r、不是 rotationVariant。**"
            + "不要把 0/90/180/270 填进来。");
    }

    const opts = args.opts === undefined ? {} : args.opts;
    if (!isObj(opts)) return fail("bad_type", "opts", `${A}.opts 必须是对象`);
    for (const k of Object.keys(opts)) {
        if (!["replace_belts", "dry_run"].includes(k)) {
            return fail("unknown_field", `opts.${k}`, `${A}.opts 不认识 '${k}'`);
        }
    }
    if (opts.replace_belts !== undefined && typeof opts.replace_belts !== "boolean") {
        return fail("bad_type", "opts.replace_belts", "replace_belts 必须是布尔",
            "缺省 true：insert 的本义就是「就地插进一段带子」，带子让位给机器；"
            + "机器（不可替换建筑）永远会被 blocked_by_machine 挡住，与这个开关无关。");
    }

    return ok({
        at,
        facing: args.facing === undefined ? null : args.facing,
        machine: { kind, variant },
        opts: {
            replace_belts: opts.replace_belts !== false,
            dry_run: opts.dry_run === true,
        },
    });
}

/**
 * remove_run(uids | cells, opts?)
 *
 * 删掉一段带子。**uid 优先**：cells 只是拿不到 uid 时的次选，且必须是 obs 里真实存在的
 * 带子格；任何一格解析到机器就整单拒绝（不"尽量删"）。
 *
 * @param {{uids?:Uid[], cells?:Cell[], opts?:object}} args
 * @returns {Validation}
 */
export function validateRemoveRunArgs(args) {
    const A = "remove_run";
    if (!isObj(args)) return fail("bad_type", null, `${A} 的入参必须是对象`);
    const unk = rejectUnknownKeys(args, ["uids", "cells", "opts"], A);
    if (unk) return unk;

    const hasUids = args.uids !== undefined;
    const hasCells = args.cells !== undefined;
    if (hasUids === hasCells) {
        return fail(hasUids ? "bad_type" : "missing_field", hasUids ? "cells" : "uids",
            `${A} 必须在 uids 与 cells 中**恰好给一个**`,
            "uid 稳定且精确（obs.entities[].uid）；cells 会随世界变化而漂移。优先 uid。");
    }

    let uids = null, cells = null;
    if (hasUids) {
        if (!Array.isArray(args.uids) || args.uids.length === 0) {
            return fail("bad_type", "uids", `${A}.uids 必须是非空数组`);
        }
        if (!args.uids.every(u => isInt(u) && u >= 0)) {
            return fail("bad_type", "uids", `${A}.uids 必须全是 >=0 的整数 uid`);
        }
        const seen = new Set();
        for (const u of args.uids) {
            if (seen.has(u)) {
                return fail("bad_type", "uids", `${A}.uids 有重复 uid ${u}`,
                    "重复通常是拼接选集时的 bug；去重后再调用。");
            }
            seen.add(u);
        }
        uids = [...args.uids];
    } else {
        if (!Array.isArray(args.cells) || args.cells.length === 0) {
            return fail("bad_type", "cells", `${A}.cells 必须是非空数组`);
        }
        if (!args.cells.every(isCell)) {
            return fail("bad_type", "cells", `${A}.cells 必须全是 [x,y] 整数对`);
        }
        const seen = new Set();
        for (const c of args.cells) {
            const k = `${c[0]},${c[1]}`;
            if (seen.has(k)) return fail("bad_type", "cells", `${A}.cells 有重复格 ${k}`);
            seen.add(k);
        }
        cells = args.cells.map(c => [c[0], c[1]]);
    }

    const opts = args.opts === undefined ? {} : args.opts;
    if (!isObj(opts)) return fail("bad_type", "opts", `${A}.opts 必须是对象`);
    for (const k of Object.keys(opts)) {
        if (!["allow_scattered", "dry_run"].includes(k)) {
            return fail("unknown_field", `opts.${k}`, `${A}.opts 不认识 '${k}'`);
        }
    }
    if (opts.allow_scattered !== undefined && typeof opts.allow_scattered !== "boolean") {
        return fail("bad_type", "opts.allow_scattered", "allow_scattered 必须是布尔");
    }

    return ok({
        ...(uids ? { uids } : { cells }),
        opts: {
            allow_scattered: opts.allow_scattered === true,
            dry_run: opts.dry_run === true,
        },
    });
}

/**
 * extend_line(from, len, dir?)
 *
 * 从 `from`（一段带子的**末端**，或一台机器的输出口）沿 dir 再接 len 格。
 * 首格位置由 from 的出口算，调用方不给坐标。
 *
 * @param {{from:Endpoint, len:number, dir?:Face, opts?:object}} args
 * @returns {Validation}
 */
export function validateExtendLineArgs(args) {
    const A = "extend_line";
    if (!isObj(args)) return fail("bad_type", null, `${A} 的入参必须是对象`);
    const unk = rejectUnknownKeys(args, ["from", "len", "dir", "opts"], A);
    if (unk) return unk;

    if (args.from === undefined) return fail("missing_field", "from", `${A} 缺 from`);
    const from = validateEndpoint(args.from, "from");
    if (!from.ok) return from;

    if (args.len === undefined) return fail("missing_field", "len", `${A} 缺 len`);
    if (!(isInt(args.len) && args.len >= 1 && args.len <= 500)) {
        return fail("bad_type", "len", `${A}.len 必须是 1..500 的整数`, `实得 ${JSON.stringify(args.len)}`);
    }
    if (args.dir !== undefined && !isFace(args.dir)) {
        return fail("bad_type", "dir",
            `${A}.dir 必须是 top|right|bottom|left`,
            "dir 是**世界方向**。不给则沿用 from 当前出口方向（直行）。");
    }
    const opts = args.opts === undefined ? {} : args.opts;
    if (!isObj(opts)) return fail("bad_type", "opts", `${A}.opts 必须是对象`);
    for (const k of Object.keys(opts)) {
        if (!["dry_run"].includes(k)) return fail("unknown_field", `opts.${k}`, `${A}.opts 不认识 '${k}'`);
    }

    return ok({
        from: from.value,
        len: args.len,
        dir: args.dir === undefined ? null : args.dir,
        opts: { dry_run: opts.dry_run === true },
    });
}

/**
 * replace_run(region, building, opts?)
 *
 * 把 #region 内的带子**原位换成另一种建筑**，保持每格的 entry/exit 拓扑不变
 * （新建筑若支持 rv/rotation，由宏按每格邻接反解）。
 * 只在 region 内**全部是带子**时执行；含任何机器 → not_a_run（整单拒绝）。
 *
 * `building` 在本版支持矩阵里只有 "belt"（用途：修复被游戏重算坏的 rv）。
 * 隧道需要 sender/receiver 成对，属于 out_of_scope；传了就明确报错，不静默降级。
 *
 * @param {{region:BBox, building:string|{kind:string,variant?:string}, opts?:object}} args
 * @returns {Validation}
 */
export function validateReplaceRunArgs(args) {
    const A = "replace_run";
    if (!isObj(args)) return fail("bad_type", null, `${A} 的入参必须是对象`);
    const unk = rejectUnknownKeys(args, ["region", "building", "opts"], A);
    if (unk) return unk;

    if (args.region === undefined) return fail("missing_field", "region", `${A} 缺 region`);
    if (!isBBox(args.region)) {
        return fail("bad_type", "region",
            `${A}.region 必须是闭区间包围盒 [x0,y0,x1,y1]，且 x0<=x1, y0<=y1`,
            "region 是**唯一**允许出现包围盒的宏参数，但它必须与 obs 的既有实体对齐 —— "
            + "宏会逐格校验，含机器整单拒绝。");
    }
    if (args.building === undefined) return fail("missing_field", "building", `${A} 缺 building`);
    let kind = null, variant = "default";
    if (typeof args.building === "string") kind = args.building;
    else if (isObj(args.building)) {
        for (const k of Object.keys(args.building)) {
            if (!["kind", "variant"].includes(k)) {
                return fail("unknown_field", `building.${k}`, `${A}.building 不认识 '${k}'`);
            }
        }
        kind = args.building.kind;
        variant = args.building.variant === undefined ? "default" : args.building.variant;
    } else {
        return fail("bad_type", "building", `${A}.building 必须是字符串或 {kind,variant}`);
    }
    if (typeof kind !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(kind)) {
        return fail("bad_type", "building", `${A}.building(kind) 必须是小写建筑标识`);
    }
    if (kind !== "belt") {
        return fail("unsupported_building", "building",
            `${A} 在本版只支持 building="belt"（实得 "${kind}"）`,
            "隧道需要 sender/receiver 成对建模（v1 范围外）；wire 要换层；机器请用 insert_machine。"
            + "这里明确报错而不是静默降级 —— 静默降级正是 paste 静默覆盖旧带那次事故的形态。");
    }
    const opts = args.opts === undefined ? {} : args.opts;
    if (!isObj(opts)) return fail("bad_type", "opts", `${A}.opts 必须是对象`);
    for (const k of Object.keys(opts)) {
        if (!["dry_run"].includes(k)) return fail("unknown_field", `opts.${k}`, `${A}.opts 不认识 '${k}'`);
    }
    return ok({
        region: [args.region[0], args.region[1], args.region[2], args.region[3]],
        building: { kind, variant },
        opts: { dry_run: opts.dry_run === true },
    });
}

/**
 * trash_unused(outlet, opts?)
 *
 * 给一个**没有去处**的输出槽接垃圾桶：在 outlet 的喷射方向落一格 trash（1×1，四边全收）。
 *
 * 为什么不能"顺手"在任何输出上接垃圾桶：切割机两个输出一个是要的、一个是废料，
 * 选错边就把产品销毁了。所以本宏的 `port` 语义被收紧：
 *   · `"auto"` 只在该实体**恰好有 1 个** ejector 槽时合法（运行期判定）；
 *   · 多输出机器（cutter/cutter-quad）必须点名 `left`/`right`/`quad0..3`，否则 `ambiguous_port`；
 *   · 该槽**当前必须没有接收方**，有就拒绝 —— 绝不抢别人的供料。
 * 另外 `opts.confirm_waste`：当该槽不在模板 `wasteRoles` 里时，必须显式承认"这一路确实是废料"。
 * 这是一层额外的 poka-yoke —— 接口逼调用方为"销毁"这个后果签字。
 *
 * @param {{outlet:Endpoint, opts?:object}} args
 * @returns {Validation}
 */
export function validateTrashUnusedArgs(args) {
    const A = "trash_unused";
    if (!isObj(args)) return fail("bad_type", null, `${A} 的入参必须是对象`);
    const unk = rejectUnknownKeys(args, ["outlet", "opts"], A);
    if (unk) return unk;

    if (args.outlet === undefined) return fail("missing_field", "outlet", `${A} 缺 outlet`);
    const outlet = validateEndpoint(args.outlet, "outlet");
    if (!outlet.ok) return outlet;

    /* 只堵一种情况：hub 的 {entry} 是**入口**索引，不是输出槽。 */
    if (isObj(outlet.value.hub) && outlet.value.hub.entry !== undefined) {
        return fail("bad_type", "outlet.hub.entry",
            `${A} 不接受 hub 的 entry 索引 —— 它是**入口**，不是输出槽`,
            "trash 接的是**源**（ejector）。给 hub 装垃圾说明方向搞反了："
            + "hub 只收不产，它没有 ejector。");
    }

    const opts = args.opts === undefined ? {} : args.opts;
    if (!isObj(opts)) return fail("bad_type", "opts", `${A}.opts 必须是对象`);
    for (const k of Object.keys(opts)) {
        if (!["confirm_waste", "replace_belt", "dry_run"].includes(k)) {
            return fail("unknown_field", `opts.${k}`, `${A}.opts 不认识 '${k}'`);
        }
    }
    if (opts.confirm_waste !== undefined && typeof opts.confirm_waste !== "boolean") {
        return fail("bad_type", "opts.confirm_waste", "confirm_waste 必须是布尔");
    }
    if (opts.replace_belt !== undefined && typeof opts.replace_belt !== "boolean") {
        return fail("bad_type", "opts.replace_belt", "replace_belt 必须是布尔");
    }

    return ok({
        outlet: outlet.value,
        opts: {
            confirm_waste: opts.confirm_waste === true,
            replace_belt: opts.replace_belt === true,
            dry_run: opts.dry_run === true,
        },
    });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 宏注册表（规格）
 * ══════════════════════════════════════════════════════════════════════════ */

/** @typedef {{name:string, type:string, required:boolean, coordClass?:string, description:string}} ParamSpec */

/**
 * @typedef {object} MacroSpec
 * @property {string} name
 * @property {string} summary        一句话
 * @property {ParamSpec[]} params
 * @property {string[]} preconditions  违反即失败的条件（运行期必查）
 * @property {string[]} whenNotToUse   poka-yoke：接口自己劝退的用法
 * @property {string} returns
 * @property {string[]} lowerOps      内部会调的**低层 op**（mod 层）
 * @property {string[]} sideEffects   会改什么、不会改什么
 * @property {string[]} invariants    实现必须维持的不变量（A3/A4 的单测判据）
 */

/** @type {Readonly<Record<string, MacroSpec>>} */
export const MACRO_SPECS = Object.freeze({
    connect: {
        name: "connect",
        summary: "从 from 的 ejector 连一条带到 to 的 acceptor；路径/转角/rv 全在内部算。",
        params: [
            { name: "from", type: "Endpoint", required: true, coordClass: "endpoint", description: "源端口。uid 来自 obs；port 缺省 auto（该实体只有一个输出槽时合法）。" },
            { name: "to", type: "Endpoint", required: true, coordClass: "endpoint", description: "宿端口。必须指向**已存在**的实体；要到空地请先放宿、或改用 build_line。" },
            { name: "opts.rebind", type: "boolean", required: false, description: "源端口已被别的接收方占用时，是否允许改接（会让旧的那条饿死）。默认 false。" },
            { name: "opts.allow_replace", type: "boolean", required: false, description: "是否允许覆盖路径上的既有带子（只覆盖带子，永不覆盖机器）。默认 false。" },
            { name: "opts.max_cells", type: "int 1..5000", required: false, description: "路径格数上限，默认 2000。超了说明不是「连一条线」。" },
            { name: "opts.prefer", type: "shortest|fewest_turns|reuse_existing", required: false, description: "路径偏好，默认 fewest_turns（拐角有代价）。" },
            { name: "opts.dry_run", type: "boolean", required: false, description: "只算不写，返回计划。" },
        ],
        preconditions: [
            "from 与 to 都能在**当前 obs** 里解析到唯一实体（uid 优先；cell 必须是该实体 origin）。",
            "from 解析出的端口是 ejector；to 解析出的端口是 acceptor。",
            "from.port 当前**没有** bound acceptor（已有则需 opts.rebind=true，否则 port_already_bound）。",
            "to.port 当前**没有**供料方（否则 target_already_fed）。",
            "路径首格 = from 出口格，末格 = to 入口格的前一格；两端方向必须与既有实体的朝向一致（宏不得为接线而改动机器朝向）。",
            "路径经过的格：空 → 可用；belt → 仅 allow_replace=true 时可覆盖并计 cost；机器/hub → occupied（整单失败）。",
            "路径格数 ≤ opts.max_cells。",
            "mod 支持 tx（事务）——否则 tx_unavailable。",
            "v1 不支持隧道穿越；需要跨线时返回 no_path 并在 error.detail 里给出被挡的走廊，而不是偷偷用隧道。",
        ],
        whenNotToUse: [
            "宿不存在时不要用：connect 不接受「连到某个空格」。先把宿（机器/垃圾桶/hub）放好。",
            "要新建一整条产线（矿机→工序→hub）时不要用：那是 build_line，会一次规划矿位与工序。",
            "想把一条带的侧面「接进」另一条直线带时不要用：带子只接收同向货流（BELT-TOPOLOGY-RULES 规则 1），"
                + "侧向汇入必须让下游带子转向，那需要改既有拓扑 —— connect 会以 no_path / occupied 拒绝，而不是硬接。",
            "源端口已经有接收方时不要用（除非你**就是要**抢过来并接受旧支路断流，此时显式 rebind=true）。",
            "两台机器紧贴、槽位本来就对齐时不要用：那是 0 格连接，用 insert_machine 后直接验证 boundAcceptor 即可。",
        ],
        returns: "MacroResult（cells_planned = 计划铺的带格数；cells_placed = 读回一致的格数；first_mismatch = 第一处 code/rotation/rv 与计划不符）",
        lowerOps: ["obs", "debug_items", "place（逐格，按 rv 自证）", "paste_blueprint（带 rv 的精确拐角）", "delete{uid}（A1 交付；覆盖旧带时）", "tx（A1 交付）"],
        sideEffects: ["新增带子实体", "allow_replace=true 时销毁路径上的旧带子（必须回滚可还原）", "不动机器、不动 hub"],
        invariants: [
            "连接完成后，from 出口的 boundAcceptor 是路径首格；路径末格的 boundAcceptor 是 to 的槽位。",
            "每一格的 (rotation, rv) 必须由 solveTurn(entry,exit) 反解并**读回自证**；不允许依赖游戏的邻居自动定向。",
            "cells_planned === cells_placed 或 ok=false（tx 下不存在半成）。",
        ],
    },

    insert_machine: {
        name: "insert_machine",
        summary: "放一台 machine 并朝向 facing；footprint/origin/槽位由宏算，调用方只指一格。",
        params: [
            { name: "at", type: "[x,y] | {cell:[x,y],part:\"any\"}", required: true, coordClass: "site", description: "`[x,y]` = 机器 origin（来自 obs 的 entities[].x/y，或上一宏返回值）；`{cell}` = 机器要占的其中一格（通常是那条带子），宏反解 origin。v1 拆成两种形状是为了不猜 180/270 的多解。" },
            { name: "facing", type: "Face", required: false, coordClass: "choice", description: "primary output 的世界喷射方向。**旋转不变以外的机器必填**；不给且机器有多个朝向时 → ambiguous_site。" },
            { name: "machine", type: "string|{kind,variant}", required: true, description: "建筑标识，如 \"cutter\"；变体如 {kind:\"painter\",variant:\"mirrored\"}。" },
            { name: "opts.replace_belts", type: "boolean", required: false, description: "footprint 内的带子是否让位（默认 true）。机器永远不会被让位。" },
            { name: "opts.dry_run", type: "boolean", required: false, description: "只算不写。" },
        ],
        preconditions: [
            "at 的格必须是 obs 里真实存在的格（带子 / 空 / 上一宏返回值）；宏不接受「凭空算出来的格」。",
            "`{cell}` 形态下，按 machine+facing 的 footprint 反解 origin：命中恰好 1 个 → 采用；命中 >1 → ambiguous_site 并列出候选（不猜）。",
            "`facing` 缺失且机器在 4 向上几何不同（cutter/painter/mixer/stacker/rotater/miner）→ ambiguous_site。"
                + "只有 ROTATABLE=false（trash/hub）或几何四向等价时才允许省略。",
            "机器 footprint（按 facing 解出的 rotation 展开、按 getTileSpaceBounds 的 origin 语义）内，**每一格**必须是：空 / 带子（且 replace_belts=true）。",
            "footprint 覆盖到任何机器或 hub → blocked_by_machine（整单失败，绝不删机器）。",
            "机器必须在该存档已解锁（查 op-templates 的 unlockLevel）；未解锁 → precondition_failed。",
            "若 footprint 内有带子被替换，它们必须能被 serialize 快照（tx）；否则 tx_unavailable。",
        ],
        whenNotToUse: [
            "周围没有带子/机器可接时不要用：孤立的机器不产不耗，只是占格。要新建整条线用 build_line。",
            "机器是 4 边全收、方向无意义的建筑（trash）时不要用：用 trash_unused，它会检查 outlet 是否真的没去处。",
            "想「换一台机器」时不要用：insert_machine 不搬机器（uid 会变）。删旧再放新是有代价的动作，必须走显式计划（removes[] + tx）。",
            "想调整既有机器朝向时不要用：那是删除+重放，会丢运行期状态；朝向错误应该由 connect 的 no_path 或 G7/G8 报出来，不该靠重放掩盖。",
            "想放一台「占多格但你要规划它周围所有线」的机器时不要用：本宏只保证机器本身与它**已被带子覆盖**的旧拓扑兼容；周围接线用 connect。",
        ],
        returns: "MacroResult + {origin:[x,y], rotation:0|90|180|270, cells:[[x,y]], removed_uids:[], wiring:[{slot,cell,dir,status}]}；wiring.status ∈ ok|nothing|mismatch",
        lowerOps: ["obs", "op-templates（槽位/footprint/ROTATABLE 真值）", "delete{uid}（A1 交付）", "place", "tx（A1 交付）"],
        sideEffects: ["新增 1 台机器", "替换 footprint 内的带子（销毁其 uid，必须可回滚还原）", "不新建带子、不接线"],
        invariants: [
            "origin 由 `{cell}` 形态反解，或由 `[x,y]` 形态直接采用；**两种形态不得混用**（一个走算术、一个不走）。",
            "机器槽位的世界格 = origin + rotate(localCell)（origin 位移规则见 CAPABILITY_ASSUMPTIONS.rotated_machine_slots），不得由调用方给。",
            "落地后读回 code 必须等于 op-templates 给出的 code；不等即 verification_failed。",
            "facing 反解出 r≠0 时，落地后必须用 debug_items/obs 读回**实际**槽位邻接并写进 wiring；"
                + "任一 status=mismatch 即 ok=false（不静默接受「大概能用」）。",
        ],
    },

    remove_run: {
        name: "remove_run",
        summary: "删掉一段带子（uid 优先，cells 次选）；整段原子删除。",
        params: [
            { name: "uids", type: "Uid[]", required: false, coordClass: "endpoint", description: "要删的带子 uid（来自 obs）。与 cells 二选一。" },
            { name: "cells", type: "Cell[]", required: false, coordClass: "endpoint", description: "要删的带子 origin 格（来自 obs）。与 uids 二选一，必须逐格命中带子。" },
            { name: "opts.allow_scattered", type: "boolean", required: false, description: "允许删不连通的多段。默认 false（不连通通常是选集错）。" },
            { name: "opts.dry_run", type: "boolean", required: false, description: "只报告不执行。" },
        ],
        preconditions: [
            "每个 uid/cell 都解析到一个**带子**（belt / underground_belt）。任何一格解析到机器/hub → not_a_run，整单拒绝。",
            "选集在 4-邻接下连通（除非 allow_scattered=true）。",
            "每一条带子都能被 serialize 快照（tx）；否则 tx_unavailable —— 不可恢复的删除一律不做。",
            "删除后必须报告 affected：哪些既有机器输出因此变成无去处（orphaned_outputs），哪些带上的物品被丢弃（stranded_items）。这两项**不阻止**执行，但必须如实出现。",
        ],
        whenNotToUse: [
            "目的是给机器让位时不要单独用：insert_machine 自己会处理 footprint 内带子并保持原子性；拆成两步会在中间态留下「机器没放、带子已删」的断线。",
            "要清一大片区域时不要用：用 bulk_delete（带 dry_run 看 items 清单），remove_run 只用于**指名**的一段。",
            "不确定某格是什么时不要用：先 obs；cells 解析到机器会被整单拒绝，这是设计（宁可失败，不可误删）。",
        ],
        returns: "MacroResult + {removed_uids, removed_cells, stranded_items:int, orphaned_outputs:[{uid,port,cell,dir}]}",
        lowerOps: ["obs", "debug_items（settled 判断）", "delete{uid}（A1 交付）", "tx（A1 交付）"],
        sideEffects: ["销毁带子实体", "带上的在途物品消失（如实报告，不算失败）"],
        invariants: [
            "删除集合与声明集合**逐 uid 相等**（G-delete-replay 的判据）。",
            "tx 失败时零删除（不存在「删了一半」）。",
        ],
    },

    extend_line: {
        name: "extend_line",
        summary: "从一段带子的末端（或机器输出口）沿 dir 再接 len 格，首格由 from 的出口算。",
        params: [
            { name: "from", type: "Endpoint", required: true, coordClass: "endpoint", description: "既有带子的末端，或机器输出口。" },
            { name: "len", type: "int 1..500", required: true, coordClass: "choice", description: "要新增的格数（不含 from 自身）。" },
            { name: "dir", type: "Face", required: false, coordClass: "choice", description: "世界方向；缺省沿用 from 当前出口（直行）。给不同方向 = 一个 90° 转弯。" },
            { name: "opts.dry_run", type: "boolean", required: false, description: "只算不写。" },
        ],
        preconditions: [
            "from 解析到唯一实体；若是带子，它必须是**末端**（出口方向的下游没有 acceptor，即 boundAcceptor===null）。",
            "from 若是机器，必须是输出槽且该槽当前无接收方。",
            "dir 与 from 当前出口夹角 ∈ {0°, 90°}；180° 掉头 → precondition_failed（带子做不到同格掉头）。",
            "路径上 len 格必须全空（allow_replace 不在本宏提供 —— 需要覆盖就用 connect 或 replace_run）。",
            "len ≤ 与最近障碍的距离；否则 occupied 并给出首个被挡格。",
        ],
        whenNotToUse: [
            "目标是一个具体的东西时不要用：extend_line 只保证「延长了」，不保证「接上了」。要接到某处请用 connect。",
            "需要拐两个弯时不要用：一次只允许一个 90° 转向；多段请分多次调用（每次 from = 上次返回的 terminal）。",
            "为绕过障碍时不要用：那是布线，用 connect。",
        ],
        returns: "MacroResult + {added_uids, cells, terminal:{cell, exit}, terminal_orphaned:boolean}",
        lowerOps: ["obs", "debug_items（末端 boundAcceptor 判定）", "place / place_path", "tx（A1 交付，用于失败回滚）"],
        sideEffects: ["新增带子实体", "不改既有实体"],
        invariants: [
            "首格 = from 的出口格 + dir 单位向量；末格出口 = dir。",
            "每格 (rotation, rv) 由 solveTurn 反解并读回自证。",
            "terminal_orphaned=true 时必须出现在返回值里 —— 不许静默留下死端。",
        ],
    },

    replace_run: {
        name: "replace_run",
        summary: "把 region 内的带子原位换成另一种建筑，保持每格 entry/exit 拓扑。本版仅支持 building=\"belt\"。",
        params: [
            { name: "region", type: "BBox", required: true, coordClass: "endpoint", description: "闭区间包围盒 [x0,y0,x1,y1]。逐格校验：全部必须是带子。" },
            { name: "building", type: "string|{kind,variant}", required: true, description: "目标建筑。本版只接受 \"belt\"。" },
            { name: "opts.dry_run", type: "boolean", required: false, description: "只报告不执行。" },
        ],
        preconditions: [
            "region 内**每一格**都是带子（belt / underground_belt）；含任何机器/hub/空格 → not_a_run 或 precondition_failed，列出前 5 个反例。",
            "region 的边界必须与实体格对齐：宏会核对 region 内带子数 === region 面积；不等说明框选偏了（这是最常见的误删来源，PROTOCOL §5 记录过一次误删 42 个实体）。",
            "目标 building 在本版支持矩阵内（只有 belt）。",
            "替换会销毁旧 uid 并产生新 uid —— 必须有 tx 与快照，否则 tx_unavailable。",
        ],
        whenNotToUse: [
            "想删除带子时不要用：remove_run（replace 不减少实体数，用错会留下一条「换了个 uid 的同样的带子」）。",
            "想把带子换成机器时不要用：insert_machine（replace_run 保持 1×1 拓扑，不展开 footprint）。",
            "想铺隧道时不要用：v1 明确不支持（sender/receiver 成对），会报 unsupported_building。",
            "region 框不准时不要用：先 bulk_delete dry_run 看 items，或用 remove_run(uids) 精确指名。",
        ],
        returns: "MacroResult + {replaced_uids, removed_uids, added_uids, mismatched:[{cell,field,requested,actual}]}",
        lowerOps: ["obs", "belt-rules（solveTurn）", "delete{uid}", "place", "tx（A1 交付）"],
        sideEffects: ["销毁并重建 region 内每个带子（uid 全变）", "不改 region 外的任何实体"],
        invariants: [
            "替换后每格的 entry/exit 与替换前逐格相等（用 belt-rules 双跑对拍）。",
            "region 外的实体 uid 集合逐字节不变。",
        ],
    },

    trash_unused: {
        name: "trash_unused",
        summary: "给一个没有去处的输出槽（必须显式指定 port）接垃圾桶。",
        params: [
            { name: "outlet", type: "Endpoint", required: true, coordClass: "endpoint", description: "输出端口。单输出实体可给 port=\"auto\"；多输出（cutter 2 / cutter-quad 4）必须点名 left|right|quad0..3。" },
            { name: "opts.confirm_waste", type: "boolean", required: false, description: "当该端口不属于模板声明的 wasteRoles 时，必须显式确认「这一路确实是废料」。默认 false → 拒绝。" },
            { name: "opts.replace_belt", type: "boolean", required: false, description: "喷射方向的下一格若是带子，是否允许让位。默认 false。" },
            { name: "opts.dry_run", type: "boolean", required: false, description: "只报告不执行。" },
        ],
        preconditions: [
            "outlet 解析到唯一实体与**唯一** ejector 槽：port=\"auto\" 仅在该实体恰好 1 个 ejector 时合法，否则 ambiguous_port 并列出候选 role。",
            "该槽当前 boundAcceptor === null（已经有接收方 → port_already_bound，绝不抢）。",
            "喷射方向的下一格必须空，或是 opts.replace_belt=true 且为带子；机器/ hub → occupied。",
            "该槽的 role ∈ 模板 wasteRoles 时可直接执行；否则必须 confirm_waste=true。"
                + "⚠️ wasteRoles 是**半切场景**的约定（'----CuCu' 要的是左列，右列才是废料），"
                + "不是「这一侧永远没用」—— L4 的 RuRu---- 恰好要右列、丢左列。"
                + "所以：目标形状决定哪一侧是废料，宏查不出目标，只能要求调用方签字。",
        ],
        whenNotToUse: [
            "输出要接 hub 或下游工序时不要用：那是 connect。",
            "只是想暂时缓冲/合流时不要用：trash 是**永久销毁**，用 balancer。",
            "端口已经接了东西时不要用：先把那条拆掉（remove_run）并想清楚为什么它会空转。",
        ],
        returns: "MacroResult + {trash_uid, cell, replaced_belt_uid?}",
        lowerOps: ["obs", "debug_items（boundAcceptor）", "op-templates（wasteRoles / slot 表）", "place", "delete{uid}（replace_belt 时）", "tx（A1 交付）"],
        sideEffects: ["新增 1 台 trash", "replace_belt=true 时销毁 1 格带子", "之后该槽的产物被永久销毁"],
        invariants: [
            "只在该槽**当前无接收方**时执行（执行前再查一次，避免 obs 过期）。",
            "trash 必须正好落在喷口格；偏一格就完全收不到货（4 边全收，但不同格就是不同实体）。",
        ],
    },
});

/** 宏名列表（稳定顺序，供 LLM 层与文档共用） */
export const MACRO_NAMES = Object.freeze(Object.keys(MACRO_SPECS));

/* ══════════════════════════════════════════════════════════════════════════
 * 4b. 能力矩阵 —— 把「哪些结论是实机的、哪些是假设」钉在契约里
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 宏实现依赖的、**尚未在实机闭环**的前提。任何一条被推翻，宏的某个分支必须改，
 * 而不是「实现里悄悄绕一下」。
 *
 * 为什么要单列：这个项目最大的成本不是写错代码，是**把假设当结论用**——
 * `WHY-NO-CUTTER-INSERT.md` 的「旋转机器不可用」曾让 L4 的正确解法被判死；
 * 而 `world-full.json`（2805 实体实机 dump）里 r≠0 的加工机器到处都是。
 * 结论不写进契约，下一个 agent 会再踩一遍。
 *
 * `status` 语义（三档，不许含糊）：
 *   · "live-verified"  实机跑通、产物/连接逐项对拍过
 *   · "observed"       实机**存在**（存档里有真实例、拓扑自洽），但没在产线上单独跟踪
 *   · "assumed"        纯推断 / 只在单测里成立
 */
export const CAPABILITY_ASSUMPTIONS = Object.freeze({
    rotated_machine_slots: {
        claim: "r≠0 的加工机器（cutter/painter/mixer/rotater）的槽位 = 局部槽位按 rotation 旋转，"
            + "世界格 = origin + rotate(localCell)，origin 不因 rotation 位移。",
        status: "observed",
        evidence: "facts/live/world-full.json（2805 实体）。按上式复算：16 台 r≠0 的 cutter 里 15 台输入口"
            + "正对一条 feeding belt；44 台 r≠0 的 painter 输入口 73/88 命中；23 台 r≠0 的 mixer 输出口 23/23 有接收方。"
            + "反证：换成「绕 bbox 中心旋转」的换算只剩 6/16 的 cutter 命中。",
        contradicts: "`research/ai-plan/WHY-NO-CUTTER-INSERT.md` 的结论「r≠0 的加工机器在 1.5.6 上不收货」——"
            + "该结论来自一次受控实验（r=180 的 cutter 无产出），与本 dump 冲突。"
            + "两者至少要重跑一次才能定论；**在定论之前 insert_machine 遇到 r≠0 必须如实返回 "
            + "`verification_failed` 而不是假设成功**。",
        affectsMacros: ["insert_machine"],
        action: "A3/A4 实现时：facing 反解出 r≠0 就先照上式算，但**落地后必须读回槽位/连接自证**；"
            + "自证失败即 verification_failed，不许降级成「大概能用」。A9 用受控实验裁定上面那条冲突。",
    },

    machine_place_sets_rv: {
        claim: "`place{building,x,y,r}` 能可靠产生指定 (rotation, rotationVariant) 的带子。",
        status: "assumed",
        evidence: "BELT-TOPOLOGY-RULES 规则 2 实测：`place` 的 rv 由游戏按邻居猜，"
            + "且拐角只在放置那一刻算一次；`place{r:90}` 曾得到 code=1 直带（AI-CONTROL-STATUS §2）。",
        contradicts: "mod 的 `placeOne` 在没给 rv 时调用 `computeOptimalDirectionAndRotationVariantAtTile`。",
        affectsMacros: ["connect", "extend_line", "replace_run", "insert_machine"],
        action: "**connect / extend_line 的拐角不得依赖 place 猜**：必须用 `paste_blueprint` 携带显式 "
            + "code=1+rv（emit 路径，已实机验证 immutable 粘贴不改 rv），或 place 后读回 code 自证并重试。"
            + "这是 macro 实现里最容易写错、也最容易「看起来绿」的一处。",
    },

    hub_16_entries: {
        claim: "hub 的 16 个入口 = op-templates.hubEntriesWorld() 的表；带子末格在入口外一格、朝向 hub。",
        status: "observed",
        evidence: "上游 hub.js:73-91 + 四份实机数据同源（见 op-templates 注释）。"
            + "但「带子直接插进 hub 槽位」本身在 GEOMETRY 表1 里仍是 ⬜（未实机单测）。",
        contradicts: "无直接反证；L3 的 CuCuCuCu 端到端曾 met=true（12 实体、delivered 0→1），"
            + "说明至少底排入口可用。",
        affectsMacros: ["connect"],
        action: "connect 到 hub 时，opts 里 `port:{entry:n}` 必须按这张表解释；"
            + "实现要按「距离排序 + 逐个试 + 整段回滚」的既有做法（place.mjs:2470 已验证），不要另写分配器。",
    },

    trash_accepts_four_sides: {
        claim: "trash 四边全收（1×1，r 恒 0），任意方向喷来的货都能吃。",
        status: "live-verified",
        evidence: "op-templates AUX（trash.js:74-92）+ M1b/M2a/M3 实机产物比对；"
            + "L4-PLAN-A0 的 (4,-14) trash 布局亦依赖此。",
        contradicts: "无。但注意：**方向无关 ≠ 位置无关** —— 偏一格就完全收不到。",
        affectsMacros: ["trash_unused"],
        action: "trash_unused 的落点必须精确等于 outlet 的喷口格（outlet 槽位格 + 该槽 dir 的单位向量）。",
    },
});

/** @returns {boolean} 该能力是否已实机闭环（"assumed" 一律 false） */
export function isLiveVerified(capability) {
    const c = CAPABILITY_ASSUMPTIONS[capability];
    return !!(c && c.status === "live-verified");
}

/** 拿某宏的全部未闭环前提（A6 的 loop 在 proposal 阶段用来降置信度） */
export function openAssumptionsFor(macroName) {
    return Object.entries(CAPABILITY_ASSUMPTIONS)
        .filter(([, c]) => c.affectsMacros.includes(macroName) && c.status !== "live-verified")
        .map(([k, c]) => ({ key: k, status: c.status, claim: c.claim }));
}

/** @returns {MacroSpec|null} */
export function getMacroSpec(name) {
    return MACRO_SPECS[name] || null;
}

/** 各宏的入参校验器（实现方必须经由这里，不允许自己解构 args）。 */
export const MACRO_VALIDATORS = Object.freeze({
    connect: validateConnectArgs,
    insert_machine: validateInsertMachineArgs,
    remove_run: validateRemoveRunArgs,
    extend_line: validateExtendLineArgs,
    replace_run: validateReplaceRunArgs,
    trash_unused: validateTrashUnusedArgs,
});

/**
 * 统一入口：按宏名校验。`{op: "connect", ...}` 或 `{macro: "connect", ...}` 都认。
 * @param {string} name
 * @param {object} args
 * @returns {Validation}
 */
export function validateMacroCall(name, args) {
    const v = MACRO_VALIDATORS[name];
    if (!v) {
        return fail("bad_type", "op", `未知宏 "${name}"`, `可用宏：${MACRO_NAMES.join(", ")}`);
    }
    return v(args);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 统一返回信封
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 每个宏**只有一个**返回形状。DIRECTION-FINAL 阶段 1 钉死了
 * `{ok, cells_planned, cells_placed, first_mismatch}` 四个字段，这里把其余补全。
 *
 * 语义要点（实现方必须遵守，否则调用方无法分诊）：
 *   · `cells_planned` = 计划**写**的世界格数（新增 + 替换/删除），不是实体数。
 *   · `cells_placed`  = 读回与计划**一致**的格数。tx 下它只能等于 planned，否则 ok 必须为 false。
 *   · `first_mismatch`= 第一处不一致（按路径/格顺序的**确定序**，不是随机序），
 *                      比的是读回的 code / rotation / rotation_variant，不是"有没有东西"。
 *                      只比存在性会让「放歪了的带子」通过 —— 正是 P7 F1/F2 记录的静默事故。
 *   · `error`         = 只在 ok=false 时非 null；与 `warnings` 互斥使用（警告不阻断）。
 */
export const RETURN_ENVELOPE = Object.freeze({
    required: ["ok", "cells_planned", "cells_placed", "first_mismatch"],
    fields: {
        ok: "boolean — 宏的整体成败（tx 下等价于「全部做成」）",
        macro: "string — 宏名",
        cells_planned: "int — 计划写入的格数",
        cells_placed: "int — 读回一致的格数",
        first_mismatch: "null | {cell, field, requested, actual}",
        changed: "{added_uids:Uid[], removed_uids:Uid[]}",
        warnings: "Array<{code, cell?, detail, hint?}>",
        error: "null | MacroError（code ∈ ERROR_CODES）",
        tick: "number — 结束时游戏时钟（便于对账）",
        dry_run: "boolean — 本次是否只算未写",
    },
});

/** @typedef {{ok:boolean, macro:string, cells_planned:number, cells_placed:number,
 *   first_mismatch:null|{cell:Cell, field:string, requested:any, actual:any},
 *   changed:{added_uids:Uid[], removed_uids:Uid[]},
 *   warnings:Array<object>, error:null|MacroError, tick?:number, dry_run?:boolean}} MacroResult */

/**
 * 返回信封的结构校验（供宏的单测 / A6 的 loop 用）。
 * @param {any} r
 * @returns {Validation}
 */
export function validateMacroResult(r) {
    if (!isObj(r)) return fail("bad_type", null, "宏返回值必须是对象");
    for (const k of RETURN_ENVELOPE.required) {
        if (!(k in r)) return fail("missing_field", k, `宏返回值缺字段 ${k}`);
    }
    if (typeof r.ok !== "boolean") return fail("bad_type", "ok", "ok 必须是布尔");
    if (!isInt(r.cells_planned) || r.cells_planned < 0) return fail("bad_type", "cells_planned", "cells_planned 必须是 >=0 整数");
    if (!isInt(r.cells_placed) || r.cells_placed < 0) return fail("bad_type", "cells_placed", "cells_placed 必须是 >=0 整数");
    const fm = r.first_mismatch;
    if (fm !== null) {
        if (!isObj(fm) || !isCell(fm.cell) || typeof fm.field !== "string") {
            return fail("bad_type", "first_mismatch", "first_mismatch 必须是 null 或 {cell:[x,y], field:string, requested, actual}");
        }
    }
    if (r.ok && fm !== null) {
        return fail("precondition_failed", "first_mismatch",
            "ok=true 但 first_mismatch 非 null —— 自相矛盾",
            "要么整体成功（mismatch 必为 null），要么失败并给出第一处；不允许「成功了但有错位」。");
    }
    if (!r.ok && r.error === null) {
        return fail("precondition_failed", "error", "ok=false 时 error 必须非 null",
            "失败必须结构化（DIRECTION-FINAL 阶段 2 判据 4：不许静默）。");
    }
    if (r.error !== null && r.error !== undefined) {
        if (!isObj(r.error) || typeof r.error.code !== "string") {
            return fail("bad_type", "error", "error 必须是 {code,...}");
        }
        if (!(r.error.code in ERROR_CODES)) {
            return fail("bad_type", "error.code", `error.code "${r.error.code}" 不在闭集里`, `闭集：${Object.keys(ERROR_CODES).join(", ")}`);
        }
    }
    if (r.ok && r.cells_placed !== r.cells_planned) {
        return fail("precondition_failed", "cells_placed",
            `ok=true 但 cells_placed(${r.cells_placed}) !== cells_planned(${r.cells_planned})`,
            "原子执行下二者必须相等；不等说明有半成，必须 ok=false。");
    }
    return ok(r);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. intent schema 扩展：removes[]
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * `removes[]` 的一项。
 *
 * 用 uid 而不是坐标，理由有三条（都来自实机事故）：
 *   1. `delete{x,y}` 在 181 实体存档上误删过一次 42 个实体（PROTOCOL §5）—— 坐标错一格就牵连邻里。
 *   2. uid 在存档往返后保持稳定（PROTOCOL §4），是唯一的精确身份。
 *   3. rollback 的恢复原语 `restoreEntity(payload)` 的载荷里带的就是 uid；
 *      坐标无法恢复被删实体的 uid，会让 G-rollback-restore 的「uid 集合逐字节相等」不可达（A1 `3306ade`）。
 *
 * `expect` **必填**：它是「写 intent 时的 obs 快照」与「执行时的世界」之间的一致性校验。
 * 没有它，一个过期的 intent 会删掉新长出来的、同坐标的别的东西。
 *
 * @typedef {object} RemoveItem
 * @property {Uid} uid
 * @property {{type:string, x:number, y:number, r?:0|90|180|270}} expect 必填；执行前逐字段核对
 * @property {string} [reason] 人读的理由（进日志与诊断，不参与判定）
 * @property {boolean} [optional] true = 不存在时跳过而不判红（用于幂等重跑）；缺省 false
 */

/** removes[] 的规格（文档与 A2 的 gate 共用同一份真值） */
export const REMOVES_SPEC = Object.freeze({
    /** intent 里可选的顶层字段 */
    field: "removes",
    item: {
        uid: "int >= 0（obs.entities[].uid）",
        expect: "{type:string, x:int, y:int, r?:0|90|180|270} —— 必填",
        reason: "string（可选，人读）",
        optional: "boolean（可选，缺省 false）",
    },
    /** 允许删除的建筑种类。hub 永远不可删（getIsRemovable=false）。 */
    deletableTypes: Object.freeze(["belt", "underground_belt", "balancer", "cutter", "rotater", "stacker", "mixer", "painter", "trash"]),
    /** 执行顺序：removes 必须**先于** paste。理由：粘贴的 footprint 可能是刚被删掉的格子；
     *  反过来做，dry_run 会把「我要腾的位置」报成 blocked，计划永远无法通过 G3。 */
    order: Object.freeze(["preflight", "tx.begin", "removes", "paste", "tx.commit", "verify"]),
    /** 与 G3 的关系：dry_run.destroys 必须是 removes 的子集。
     *  未声明的销毁 → 红（这是「销毁必须在计划里声明且可恢复」的机器化表达）。
     *  ⚠️ 已知局限（A2 必须在 gate 里写明，不许假装没有）：G3 的 dry_run 发生在
     *  `tx.begin` **之前**，而 removes 在 tx 内执行。两者之间世界仍可能变化
     *  （别的 agent / 游戏主循环 / 玩家）。所以 dry_run 的结论是「当时成立」，
     *  执行时的真值由 `G-delete-replay` 用消除后的 obs 复核，不靠这份预检。 */
    g3Rule: "dryRun.destroys[].uid ⊆ removes[].uid，否则 G3 红",
    /** 与 G4 的关系（两条都要）： */
    g4Rule: "vanished_uids ⊆ removes[].uid；added_entities === entities.length",
    /** G-delete-replay（DIRECTION-FINAL 阶段 0 新增的第二道闸）：
     *  **声明的删除必须逐 uid 真的发生**，不是"至少没多删"。
     *  判据取**相等**而不是子集：声明了却还在 = 静默 no-op（计划说删了、实际没删，
     *  下游 G6b 会拿一条其实还堵着的线去判"连通"，是假绿的新入口）。
     *  `optional:true` 的项允许缺席（幂等重跑），因此比较的是
     *  `vanished_uids === removes.filter(!optional).map(uid)`。 */
    gDeleteReplayRule: "vanished_uids === removes.filter(r => !r.optional).map(r => r.uid)（集合相等，非子集）",
    /** 回滚：删本 plan 新增 + 用快照恢复本 plan 删除。判据是 uid 集合逐字节相等。 */
    rollbackRule: "回滚后 uid 集合 === 执行前 uid 集合（逐字节）",
});

/**
 * 校验 intent.removes（结构层，不查世界）。
 *
 * @param {any} intent
 * @returns {Validation} value = 归一后的 removes 数组（缺省 []）
 */
export function validateIntentRemoves(intent) {
    if (!isObj(intent)) return fail("bad_type", null, "intent 必须是对象");
    const raw = intent.removes;
    if (raw === undefined) return ok([]);
    if (!Array.isArray(raw)) {
        return fail("bad_type", "removes", "intent.removes 必须是数组", "每项 {uid, expect:{type,x,y}, reason?}");
    }
    const seen = new Set();
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const it = raw[i];
        const at = `removes[${i}]`;
        if (!isObj(it)) return fail("bad_type", at, `${at} 必须是对象`);
        for (const k of Object.keys(it)) {
            if (!["uid", "expect", "reason", "optional"].includes(k)) {
                return fail("unknown_field", `${at}.${k}`, `${at} 不认识键 '${k}'`,
                    "敲错字段名会让校验静默失效（例如写成 'uuid'），所以未知键一律拒绝。");
            }
        }
        if (!isInt(it.uid) || it.uid < 0) {
            return fail("bad_type", `${at}.uid`, `${at}.uid 必须是 >=0 的整数`);
        }
        if (seen.has(it.uid)) {
            return fail("bad_type", `${at}.uid`, `${at}.uid ${it.uid} 重复`,
                "同一条被删两次说明选集有 bug；去重后再写。");
        }
        seen.add(it.uid);
        if (it.expect === undefined) {
            return fail("missing_field", `${at}.expect`, `${at} 缺 expect`,
                "expect 是与 obs 快照的一致性凭据。没有它，过期 intent 会删掉同坐标的新东西。");
        }
        const e = it.expect;
        if (!isObj(e)) return fail("bad_type", `${at}.expect`, `${at}.expect 必须是对象`);
        for (const k of Object.keys(e)) {
            if (!["type", "x", "y", "r"].includes(k)) {
                return fail("unknown_field", `${at}.expect.${k}`, `${at}.expect 不认识键 '${k}'`);
            }
        }
        if (typeof e.type !== "string" || !e.type) {
            return fail("bad_type", `${at}.expect.type`, `${at}.expect.type 必须是非空字符串（obs 的 type）`);
        }
        if (!isInt(e.x) || !isInt(e.y)) {
            return fail("bad_type", `${at}.expect`, `${at}.expect.x/y 必须是整数`);
        }
        if (e.r !== undefined && ![0, 90, 180, 270].includes(e.r)) {
            return fail("bad_type", `${at}.expect.r`, `${at}.expect.r 必须是 0|90|180|270`);
        }
        if (it.reason !== undefined && typeof it.reason !== "string") {
            return fail("bad_type", `${at}.reason`, `${at}.reason 必须是字符串`);
        }
        if (it.optional !== undefined && typeof it.optional !== "boolean") {
            return fail("bad_type", `${at}.optional`, `${at}.optional 必须是布尔`);
        }
        const del = realDeletableCheck(it.expect.type, at);
        if (del) return del;
        out.push({
            uid: it.uid,
            expect: { type: e.type, x: e.x, y: e.y, ...(e.r !== undefined ? { r: e.r } : {}) },
            ...(it.reason !== undefined ? { reason: it.reason } : {}),
            optional: it.optional === true,
        });
    }
    return ok(out);
}

function realDeletableCheck(type, at) {
    if (type === "hub") {
        return fail("precondition_failed", `${at}.expect.type`,
            "hub 不可删除（getIsRemovable=false）",
            "不可能有合法的 removes 项指向 hub；这条通常是 uid 抄错了。");
    }
    return null;
}

/**
 * removes 的**存在性/一致性**校验（需要 obs）。A2 的 `G-remove-preflight` 调它。
 *
 * @param {Array} removes  来自 validateIntentRemoves().value
 * @param {Array<{uid:number,type:string,x:number,y:number,r:number}>} entities  obs.entities
 * @returns {Validation} value = {ok:RemoveItem[], missing:RemoveItem[], mismatched:[...]}
 */
export function checkRemovesAgainstObs(removes, entities) {
    if (!Array.isArray(removes)) return fail("bad_type", "removes", "removes 必须是数组");
    if (!Array.isArray(entities)) return fail("bad_type", "entities", "entities 必须是 obs.entities 数组");
    const byUid = new Map(entities.map(e => [e.uid, e]));
    const good = [], missing = [], mismatched = [];
    for (const r of removes) {
        const e = byUid.get(r.uid);
        if (!e) {
            if (r.optional) continue;
            missing.push(r);
            continue;
        }
        const diffs = [];
        if (e.type !== r.expect.type) diffs.push({ field: "type", requested: r.expect.type, actual: e.type });
        if (e.x !== r.expect.x) diffs.push({ field: "x", requested: r.expect.x, actual: e.x });
        if (e.y !== r.expect.y) diffs.push({ field: "y", requested: r.expect.y, actual: e.y });
        if (r.expect.r !== undefined && e.r !== r.expect.r) diffs.push({ field: "r", requested: r.expect.r, actual: e.r });
        if (diffs.length) mismatched.push({ uid: r.uid, diffs });
        else good.push(r);
    }
    if (missing.length || mismatched.length) {
        return {
            ok: false,
            error: {
                code: "precondition_failed",
                field: "removes",
                message: `${missing.length} 个 uid 不存在，${mismatched.length} 个与 expect 不符 —— intent 已过期`,
                hint: "重新 obs 后重写 removes。uid 对但不符通常意味着世界已经变了（别的东西占了同一 uid？不可能——那就是抄错了）。",
                ...(missing.length ? { candidates: missing.slice(0, 5).map(m => m.uid) } : {}),
            },
            value: { ok: good, missing, mismatched },
        };
    }
    return ok({ ok: good, missing, removedOptional: [], mismatched: [] });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 7. lint：公开 ABI 里不许出现裸坐标
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 机器检查一次宏调用是否违反坐标三分法（DIRECTION-FINAL 阶段 1 判据 2 的落地）。
 *
 * 规则（可执行，不靠人看）：
 *   1. 参数键不得命中 FORBIDDEN_ARG_KEYS。
 *   2. coordClass ∈ {endpoint, site} 的参数最多 2 个，其中 site 最多 1 个。
 *   3. 除 `cell` / `cells` / `region` / `at` 这四个**被契约点名**的参数外，
 *      任何数组型参数若其元素是 [int,int]，一律判红 —— 那是在传坐标序列。
 *
 * @param {string} name 宏名
 * @param {object} args
 * @returns {{ok:boolean, violations:string[]}}
 */
export function lintNoBareCoords(name, args) {
    const v = [];
    const spec = MACRO_SPECS[name];
    if (!spec) return { ok: false, violations: [`未知宏 ${name}`] };
    const a = args || {};
    for (const k of Object.keys(a)) {
        if (FORBIDDEN_ARG_KEYS.includes(k)) {
            v.push(`参数 '${k}' 是裸坐标/裸旋转，公开 ABI 禁止（见 FORBIDDEN_ARG_KEYS）`);
        }
    }
    let endpoints = 0, sites = 0;
    for (const p of spec.params) {
        if (p.coordClass === "endpoint") endpoints++;
        if (p.coordClass === "site") sites++;
    }
    const argEndpointCount = spec.params.filter(p => p.coordClass === "endpoint" && a[p.name.split(".")[0]] !== undefined).length;
    const argSiteCount = spec.params.filter(p => p.coordClass === "site" && a[p.name] !== undefined).length;
    if (argEndpointCount > 2) v.push(`端点参数 ${argEndpointCount} 个，上界 2`);
    if (argSiteCount > 1) v.push(`落点参数 ${argSiteCount} 个，上界 1`);
    const cellish = new Set(["cell", "cells", "region", "at"]);
    for (const [k, val] of Object.entries(a)) {
        if (cellish.has(k)) continue;
        if (Array.isArray(val) && val.length && val.every(x => Array.isArray(x) && x.length === 2 && x.every(isInt))) {
            v.push(`参数 '${k}' 是坐标数组，但不在契约点名的 {cell,cells,region,at} 里`);
        }
    }
    return { ok: v.length === 0, violations: v, specEndpointCount: endpoints, specSiteCount: sites };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 8. 自测（node src/agent/macros/contract.mjs 直接跑）
 * ══════════════════════════════════════════════════════════════════════════ */

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("agent/macros/contract.mjs");
if (isMain) {
    let bad = 0;
    const t = (name, cond) => {
        if (cond) console.log("✓ " + name);
        else { console.log("✗ " + name); bad++; }
    };
    const V = (f, args) => f(args);

    t("connect 正常", V(validateConnectArgs, { from: { uid: 10001, port: "out" }, to: { uid: 10002, port: "primary" } }).ok);
    t("connect 裸坐标被拒", !V(validateConnectArgs, { from: { x: 1, y: 2 }, to: { uid: 3 } }).ok);
    t("connect 顶层 x 被点名", (() => {
        const r = V(validateConnectArgs, { from: { uid: 1 }, to: { uid: 2 }, x: 5 });
        return !r.ok && r.error.code === "unknown_field" && r.error.field === "x";
    })());
    t("connect 自连被拒", !V(validateConnectArgs, { from: { uid: 1, port: "out" }, to: { uid: 1, port: "out" } }).ok);
    t("connect uid+cell 同时给被拒", !V(validateConnectArgs, { from: { uid: 1, cell: [0, 0] }, to: { uid: 2 } }).ok);
    t("connect port entry 越界被拒", !V(validateConnectArgs, { from: { uid: 1 }, to: { hub: { entry: 16 } } }).ok);

    t("insert_machine 正常", V(validateInsertMachineArgs, { at: [4, -13], facing: "top", machine: "cutter" }).ok);
    t("insert_machine 角度当 facing 被拒", !V(validateInsertMachineArgs, { at: [4, -13], facing: 0, machine: "cutter" }).ok);
    t("insert_machine 带 r 被拒", !V(validateInsertMachineArgs, { at: [4, -13], facing: "top", machine: "cutter", r: 0 }).ok);
    t("insert_machine 变体对象", (() => {
        const r = V(validateInsertMachineArgs, { at: [0, 0], facing: "right", machine: { kind: "painter", variant: "mirrored" } });
        return r.ok && r.value.machine.variant === "mirrored";
    })());

    t("remove_run uids 正常", V(validateRemoveRunArgs, { uids: [10209, 10149] }).ok);
    t("remove_run uids+cells 互斥", !V(validateRemoveRunArgs, { uids: [1], cells: [[0, 0]] }).ok);
    t("remove_run 重复 uid 被拒", !V(validateRemoveRunArgs, { uids: [1, 1] }).ok);
    t("remove_run 空数组被拒", !V(validateRemoveRunArgs, { uids: [] }).ok);

    t("extend_line 正常", V(validateExtendLineArgs, { from: { uid: 5 }, len: 4, dir: "top" }).ok);
    t("extend_line len=0 被拒", !V(validateExtendLineArgs, { from: { uid: 5 }, len: 0 }).ok);
    t("extend_line dir 非法被拒", !V(validateExtendLineArgs, { from: { uid: 5 }, len: 2, dir: 90 }).ok);

    t("replace_run 正常", V(validateReplaceRunArgs, { region: [3, -14, 5, -12], building: "belt" }).ok);
    t("replace_run 隧道明确拒绝", (() => {
        const r = V(validateReplaceRunArgs, { region: [0, 0, 1, 1], building: "underground_belt" });
        return !r.ok && r.error.code === "unsupported_building";
    })());
    t("replace_run 反序 bbox 被拒", !V(validateReplaceRunArgs, { region: [5, 5, 1, 1], building: "belt" }).ok);

    t("trash_unused 的 hub entry 被拒（方向搞反）", (() => {
        const r = V(validateTrashUnusedArgs, { outlet: { hub: { entry: 3 } } });
        return !r.ok && r.error.code === "bad_type";
    })());
    t("trash_unused 单输出 auto 合法（运行期再判唯一性）",
        V(validateTrashUnusedArgs, { outlet: { uid: 10001 } }).ok);
    t("trash_unused 正常", V(validateTrashUnusedArgs, { outlet: { uid: 9, port: "left" } }).ok);

    t("removes 缺 expect 被拒", !validateIntentRemoves({ removes: [{ uid: 1 }] }).ok);
    t("removes 正常", validateIntentRemoves({ removes: [{ uid: 1, expect: { type: "belt", x: 4, y: -13 } }], goal: "g", anchor: [0, 0], entities: [] }).ok);
    t("removes 重复 uid 被拒", !validateIntentRemoves({ removes: [{ uid: 1, expect: { type: "belt", x: 0, y: 0 } }, { uid: 1, expect: { type: "belt", x: 1, y: 0 } }] }).ok);
    t("removes 指向 hub 被拒", !validateIntentRemoves({ removes: [{ uid: 1, expect: { type: "hub", x: 0, y: 0 } }] }).ok);

    t("checkRemoves 命中", checkRemovesAgainstObs(
        [{ uid: 1, expect: { type: "belt", x: 4, y: -13 } }],
        [{ uid: 1, type: "belt", x: 4, y: -13, r: 0 }]).ok);
    t("checkRemoves 不符被抓", (() => {
        const r = checkRemovesAgainstObs(
            [{ uid: 1, expect: { type: "belt", x: 4, y: -13 } }],
            [{ uid: 1, type: "belt", x: 5, y: -13, r: 0 }]);
        return !r.ok && r.value.mismatched.length === 1;
    })());
    t("checkRemoves 缺失被抓", !checkRemovesAgainstObs([{ uid: 7, expect: { type: "belt", x: 0, y: 0 } }], []).ok);

    t("表单校验：ok 但 mismatch 非 null 自相矛盾", !validateMacroResult({
        ok: true, macro: "connect", cells_planned: 3, cells_placed: 3,
        first_mismatch: { cell: [0, 0], field: "code", requested: 1, actual: 3 },
        changed: { added_uids: [], removed_uids: [] }, warnings: [], error: null,
    }).ok);
    t("表单校验：ok 但半成被拒", !validateMacroResult({
        ok: true, macro: "connect", cells_planned: 3, cells_placed: 2,
        first_mismatch: null, changed: { added_uids: [], removed_uids: [] }, warnings: [], error: null,
    }).ok);
    t("表单校验：合法", validateMacroResult({
        ok: true, macro: "connect", cells_planned: 3, cells_placed: 3,
        first_mismatch: null, changed: { added_uids: [1], removed_uids: [] }, warnings: [], error: null,
    }).ok);

    t("lint：connect 带 x/y 报红", !lintNoBareCoords("connect", { from: { uid: 1 }, to: { uid: 2 }, x: 3 }).ok);
    t("lint：合法调用为绿", lintNoBareCoords("connect", { from: { uid: 1 }, to: { uid: 2 } }).ok);
    t("lint：remove_run 的 cells 是契约点名，放行", lintNoBareCoords("remove_run", { cells: [[0, 0]] }).ok);
    t("宏名齐全", MACRO_NAMES.length === 6);
    t("insert_machine `{cell}` 形态归一", (() => {
        const r = V(validateInsertMachineArgs, { at: { cell: [4, -13] }, facing: "top", machine: "cutter" });
        return r.ok && r.value.at.kind === "any-cell" && r.value.at.cell[0] === 4;
    })());
    t("insert_machine origin 形态与 cell 形态不混", (() => {
        const r = V(validateInsertMachineArgs, { at: [4, -13], facing: "top", machine: "cutter" });
        return r.ok && r.value.at.kind === "origin";
    })());
    t("每个宏都有 preconditions / whenNotToUse / returns / lowerOps", MACRO_NAMES.every(n => {
        const s = MACRO_SPECS[n];
        return s.preconditions.length > 0 && s.whenNotToUse.length > 0
            && typeof s.returns === "string" && s.returns.length > 0
            && Array.isArray(s.lowerOps) && s.lowerOps.length > 0;
    }));
    t("每个宏都没有 computed 类公开参数（坐标全在宏里）", MACRO_NAMES.every(n =>
        MACRO_SPECS[n].params.every(p => p.coordClass !== "computed")));
    t("空参数/未知宏给出可读错误", (() => {
        const r = validateMacroCall("nope", {});
        return !r.ok && /可用宏/.test(r.error.hint || "");
    })());
    t("capability: 旋转机器槽位尚未实机闭环", !isLiveVerified("rotated_machine_slots"));
    t("capability: insert_machine 被这条假设覆盖", openAssumptionsFor("insert_machine").some(a => a.key === "rotated_machine_slots"));
    t("capability: remove_run 无未闭环前提", openAssumptionsFor("remove_run").length === 0);

    console.log(bad === 0 ? "\n全部通过" : `\n${bad} 条失败`);
    if (bad) process.exitCode = 1;
}
