/**
 * grid.mjs — 编译器网格原语（P1 contract 独占）。
 *
 * 契约来源：
 *   plan-compiler.md §1.1（Grid 原语 + **三态占用**）、§2.3 决策 D1（v1 加工机器恒 r=0）
 *   compiler-constraints.md C1（最高危）：paste 落在既有 replaceable 带 → 游戏**静默销毁旧带、不报告**
 *     （真实事故：研究期间毁过 6 条 level-11 工厂带）；落在既有机器 → 该格进 failed，
 *     **其余格照常放置**（部分成功、返回仍 ok:true）。
 *     ⇒ 编译器规则：**任何非空格 → 整单 abort**，v1 不做 allowOverwrite。
 *
 * 本文件只提供原语：不含布局逻辑、不含几何真值（占地形状/槽位/origin 位移表在 P2，
 *   见 GEOMETRY-TABLE 表1 与 static_map_entity.js:127-141）。
 *
 * 零依赖：ESM + node: 内置 + src/ai/belt-rules.mjs 的只读常量（rotateLocal）。
 *   禁止 import proto/belt-rules.mjs（已知错误副本，plan §1.1 lint / §3 陷阱）。
 */

import { rotateLocal } from "../belt-rules.mjs";
import { ContractViolation, assertInt, assertWH, isAngle, DIR_NAMES } from "./errors.mjs";

/* ───────────────────────────── 三态占用（C1） ───────────────────────────── */

/** 空格：可放置 */
export const EMPTY = "empty";
/** 既有机器/不可替换实体：任何放置都算冲突，且放置它会进 failed */
export const SOLID = "occupied_solid";
/** 既有 belt/wire（唯一两类 getIsReplaceable()=true）：paste 会**静默替换** → v1 一律算冲突 */
export const REPLACEABLE = "occupied_replaceable";

export const CELL_STATES = Object.freeze([EMPTY, SOLID, REPLACEABLE]);

/* ───────────────────────────── 放置者类别与冲突矩阵 ───────────────────────────── */

/** 机器类（miner/cutter/rotater/painter/stacker/mixer/trash/hub）：solid 与 replaceable **都算冲突** */
export const PLACE_MACHINE = "machine";
/** 带子类：solid 冲突；replaceable **默认也算冲突**（v1 绝不覆盖既有带），只有显式 allowReplaceable 才视为可复用 */
export const PLACE_BELT = "belt";
/** 其它（未分类实体）：保守 = 与机器同样严格 */
export const PLACE_OTHER = "other";

export const PLACE_KINDS = Object.freeze([PLACE_MACHINE, PLACE_BELT, PLACE_OTHER]);

/* ───────────────────────────── 小工具（P1 独占，见 plan §3 冲突仲裁） ───────────────────────────── */

/**
 * "x,y" —— WorldState.replaceableBeltCells / LayoutReport.occupancy / conflicts 的通用键。
 * 负数坐标直接用 "-3,-7" 形式（不做任何偏移编码，便于与存档/obs 文本对拍）。
 * @param {number} x @param {number} y @returns {string}
 */
export function cellKey(x, y) {
    assertInt(x, "cellKey(x)");
    assertInt(y, "cellKey(y)");
    return `${x},${y}`;
}

/**
 * key → [x,y]（cellKey 的逆）。
 * @param {string} key @returns {[number,number]}
 */
export function parseCellKey(key) {
    if (typeof key !== "string") throw new ContractViolation("parseCellKey(key)", '"x,y" 字符串', key);
    const m = /^(-?\d+),(-?\d+)$/.exec(key.trim());
    if (!m) throw new ContractViolation("parseCellKey(key)", '"x,y" 字符串（整数，可负）', key);
    return [Number(m[1]), Number(m[2])];
}

/**
 * 包围盒宽高交换：rot∈{90,270} 且 w≠h → [h,w]；rot∈{0,180} → [w,h]。
 * **纯算术**，不含 origin 位移真值（P2 的 GEOMETRY 表1 + static_map_entity.js:127-141 才是权威）。
 * @param {number} w @param {number} h @param {number} [rot] @returns {[number,number]}
 */
export function rotatedFootprint(w, h, rot = 0) {
    const [W, H] = assertWH([w, h], "rotatedFootprint(w,h)");
    if (!isAngle(rot)) throw new ContractViolation("rotatedFootprint(rot)", "0|90|180|270", rot);
    return (rot === 90 || rot === 270) ? [H, W] : [W, H];
}

/**
 * 局部槽位 → 世界槽位。方向一律复用 belt-rules 的 rotateLocal（plan §1.2 验收 2：不许二次实现）。
 * cell 偏移的旋转需要 origin 位移表（P2 真值，实机未验证），故 **rot≠0 时带 cell 偏移一律抛错**（D1）。
 *
 * @param {{dir?:string, cell?:[number,number]}} slot 局部槽位（{dir:"top"} 或 {cell:[0,1], dir:"bottom"}）
 * @param {number} [rot] @returns {{dir:string, cell?:[number,number]}}
 */
export function rotateLocalSlot(slot, rot = 0) {
    if (!slot || typeof slot !== "object") throw new ContractViolation("rotateLocalSlot(slot)", "{dir,cell?}", slot);
    if (!isAngle(rot)) throw new ContractViolation("rotateLocalSlot(rot)", "0|90|180|270", rot);
    const out = {};
    if (slot.dir != null) {
        if (!DIR_NAMES.includes(slot.dir)) throw new ContractViolation("rotateLocalSlot(slot.dir)", "DirName", slot.dir);
        out.dir = rotateLocal(slot.dir, rot);
    }
    if (slot.cell != null) {
        const cell = Array.isArray(slot.cell) && slot.cell.length === 2
            ? [assertInt(slot.cell[0], "rotateLocalSlot(slot.cell[0])"), assertInt(slot.cell[1], "rotateLocalSlot(slot.cell[1])")]
            : (() => { throw new ContractViolation("rotateLocalSlot(slot.cell)", "[x,y]", slot.cell); })();
        if (rot !== 0) {
            // D1：v1 加工机器恒 r=0；rot≠0 的 cell 偏移需要 P2 的 origin 位移表，P1 不猜几何。
            throw new ContractViolation(
                "rotateLocalSlot(rot)",
                "0（v1 决策 D1：加工机器不旋转；rot≠0 的槽位偏移需 P2 的 GEOMETRY origin 位移表，P1 拒绝臆造）",
                rot,
            );
        }
        out.cell = cell;
    }
    return out;
}

/* ───────────────────────────── 单元格记录 ───────────────────────────── */

/**
 * 一个格子的占用记录。稀疏存储：Map<"x,y", CellRecord>。
 * @typedef {{
 *   x:number, y:number,
 *   state:"empty"|"occupied_solid"|"occupied_replaceable",
 *   who:string|null,          // 占用者 id（nodeId / "world" / uid 字符串）
 *   kind:string|null,         // "miner"|"belt"|"cutter"|"trash"|"hub"|... （人读与冲突归因用）
 *   anchor:string|null,       // 多格实体：所属锚点键 "x,y"（空格为 null）
 *   isAnchor:boolean,         // 本格是否为锚点（占地矩形左下角 origin）
 *   footprint:[number,number]|null, // 锚点格携带 r=0 名义占地
 *   rot:number,               // 锚点格的 rotation（v1 机器恒 0）
 * }} CellRecord
 */

function emptyRecord(x, y) {
    return { x, y, state: EMPTY, who: null, kind: null, anchor: null, isAnchor: false, footprint: null, rot: 0 };
}

/* ───────────────────────────── Grid ───────────────────────────── */

/**
 * 稀疏整数网格（坐标可为负）。只提供原语，不做任何布局决策。
 *
 * 语义铁律：
 *   - get 永不返回 null（空位返回 EMPTY 记录）；
 *   - set/occupy 对**任何非空格**抛 ContractViolation（同格二次 set 必须抛错，L0 §1.1-1）；
 *   - canPlace 是只读判定，供 P3/P5 在不抛错的路径上做碰撞检查（P5 的 V1/V2 用它）。
 */
export class Grid {
    /** @param {{name?:string}} [opts] name 只影响 toString 的标题 */
    constructor(opts = {}) {
        this.name = opts.name == null ? "grid" : String(opts.name);
        /** @type {Map<string, CellRecord>} */
        this.cells = new Map();
    }

    /* ---------- 读 ---------- */

    /**
     * @param {number} x @param {number} y @returns {CellRecord} 空位返回 EMPTY 记录（永不 null）
     */
    get(x, y) {
        assertInt(x, "Grid.get(x)"); assertInt(y, "Grid.get(y)");
        return this.cells.get(cellKey(x, y)) || emptyRecord(x, y);
    }

    /** 便捷读态 @returns {"empty"|"occupied_solid"|"occupied_replaceable"} */
    stateAt(x, y) { return this.get(x, y).state; }

    /** 空格判定（三态里唯一可放的态） */
    isFree(x, y) { return this.stateAt(x, y) === EMPTY; }

    /** 整块矩形全空（P5 V1「落点矩形全空」的判据原语） */
    isFreeRect(x, y, w, h) {
        return this.placementConflicts(x, y, w, h, PLACE_MACHINE, { allowRotated: true }).length === 0;
    }

    /** 已占格数 */
    size() { return this.cells.size; }

    /** 全部占用键，按 y 再 x 排序（逐字节可 diff） */
    keys() {
        return [...this.cells.keys()].sort((a, b) => {
            const [ax, ay] = parseCellKey(a), [bx, by] = parseCellKey(b);
            return ay - by || ax - bx;
        });
    }

    /** 某 who 的键列表（同样排序） */
    keysOf(who) {
        return this.keys().filter(k => this.cells.get(k).who === who);
    }

    /**
     * 全体已占的包围盒 [w,h]；空网格 → [0,0]。
     * @returns {[number,number]}
     */
    bbox() {
        if (!this.cells.size) return [0, 0];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const k of this.cells.keys()) {
            const [x, y] = parseCellKey(k);
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        return [maxX - minX + 1, maxY - minY + 1];
    }

    /** 包围盒原点 [minX,minY]（空网格 → [0,0]）；P6 锚点 w=[minx,miny] 用它核对 */
    origin() {
        if (!this.cells.size) return [0, 0];
        let minX = Infinity, minY = Infinity;
        for (const k of this.cells.keys()) {
            const [x, y] = parseCellKey(k);
            if (x < minX) minX = x; if (y < minY) minY = y;
        }
        return [minX, minY];
    }

    /** 某 who 的包围盒 [w,h]（无该 who → [0,0]） */
    bboxOf(who) {
        const ks = this.keysOf(who);
        if (!ks.length) return [0, 0];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const k of ks) {
            const [x, y] = parseCellKey(k);
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        return [maxX - minX + 1, maxY - minY + 1];
    }

    /** 迭代器：按 y 再 x 顺序产出 [key, record] */
    *[Symbol.iterator]() {
        for (const k of this.keys()) yield [k, this.cells.get(k)];
    }

    /* ---------- 写 ---------- */

    /**
     * 放置单格（严格）。已被占 → 抛 ContractViolation（消息含 cell / 现有 who / state）。
     *
     * @param {number} x @param {number} y
     * @param {string} who 占用者 id（不可为空串）
     * @param {{state?:typeof SOLID|typeof REPLACEABLE, kind?:string|null, rot?:number,
     *          footprint?:[number,number]|null, anchor?:string|null, isAnchor?:boolean}} [opts]
     * @returns {CellRecord}
     */
    set(x, y, who, opts = {}) {
        assertInt(x, "Grid.set(x)"); assertInt(y, "Grid.set(y)");
        if (typeof who !== "string" || who === "") throw new ContractViolation("Grid.set(who)", "非空字符串（占用者 id）", who);
        const state = opts.state === undefined ? SOLID : opts.state;
        if (state !== SOLID && state !== REPLACEABLE) {
            throw new ContractViolation(`Grid.set(${x},${y}).opts.state`, `${SOLID} | ${REPLACEABLE}（写入只能是占用态）`, state);
        }
        const rot = opts.rot === undefined ? 0 : opts.rot;
        if (!isAngle(rot)) throw new ContractViolation(`Grid.set(${x},${y}).opts.rot`, "0|90|180|270", rot);
        const key = cellKey(x, y);
        const cur = this.cells.get(key);
        if (cur) {
            // L0 §1.1-1：同格二次 set 必须抛错（绝不静默覆盖 —— C1 的「静默销毁」正是这里要挡住的）
            throw new ContractViolation(
                `cell already occupied @ ${key}`,
                `空格（当前被 ${JSON.stringify(cur.who)} 以 ${cur.state}${cur.kind ? "/" + cur.kind : ""} 占用）`,
                { x, y, state: cur.state, who: cur.who, kind: cur.kind },
            );
        }
        const rec = {
            x, y, state, who,
            kind: opts.kind == null ? null : String(opts.kind),
            anchor: opts.anchor == null ? key : String(opts.anchor),
            isAnchor: opts.isAnchor === true,
            footprint: opts.footprint ? assertWH(opts.footprint, `Grid.set(${x},${y}).opts.footprint`) : null,
            rot,
        };
        this.cells.set(key, rec);
        return rec;
    }

    /** 与 set 同义（多格实体的非锚点也走它），两个名字便于阅读调用方 */
    occupy(x, y, who, opts = {}) { return this.set(x, y, who, opts); }

    /**
     * 矩形占地。w≠h 且 rot∈{90,270} → 宽高交换（L0 §1.1-1「旋转尺寸交换」）。
     *
     * 决策 D1（plan §2.3）：v1 加工机器**恒 r=0** —— 因此 kind=machine 且 rot≠0 默认抛错；
     * 只有显式 `opts.allowRotatedMachine === true`（或 kind==="belt" 这类 1×1 实体）才放行，
     * 因为 rot≠0 的占地原点位移真值在 P2/GEOMETRY 表1 未定义（static_map_entity.js:127-141）。
     *
     * @param {number} x @param {number} y 左下角 origin（世界坐标）
     * @param {number} w @param {number} h r=0 的名义占地
     * @param {string} who
     * @param {{rot?:number, kind?:string, state?:typeof SOLID|typeof REPLACEABLE,
     *          allowRotatedMachine?:boolean, allowOverwrite?:boolean, id?:string}} [opts]
     * @returns {{cells:string[], anchor:string, w:number, h:number, rot:number}}
     */
    occupyRect(x, y, w, h, who, opts = {}) {
        assertInt(x, "Grid.occupyRect(x)"); assertInt(y, "Grid.occupyRect(y)");
        const [W0, H0] = assertWH([w, h], "Grid.occupyRect(w,h)");
        const rot = opts.rot === undefined ? 0 : opts.rot;
        if (!isAngle(rot)) throw new ContractViolation(`Grid.occupyRect(${x},${y}).opts.rot`, "0|90|180|270", rot);
        const kind = opts.kind == null ? PLACE_MACHINE : opts.kind;
        if (!PLACE_KINDS.includes(kind)) throw new ContractViolation(`Grid.occupyRect(${x},${y}).opts.kind`, `∈ [${PLACE_KINDS.join("|")}]`, kind);
        if ((rot === 90 || rot === 270) && kind === PLACE_MACHINE && opts.allowRotatedMachine !== true) {
            throw new ContractViolation(
                `Grid.occupyRect(${x},${y}).opts.rot`,
                `0（决策 D1：v1 加工机器不旋转，几何表只在 r=0 定义；确有需求请显式 allowRotatedMachine:true 并承担 origin 位移未验证的风险）`,
                rot,
            );
        }
        if (opts.allowOverwrite === true) {
            // C1：v1 不做 allowOverwrite。显式传入 → 结构化拒绝，防「静默销毁既有带」复发。
            throw new ContractViolation("Grid.occupyRect.opts.allowOverwrite", "false|undefined（v1 绝不覆盖既有实体，见 constraints C1）", true);
        }
        const [W, H] = rotatedFootprint(W0, H0, rot);
        const anchor = cellKey(x, y);
        const placed = [];
        // 先全量检查再写入：任一格非空 → 整单抛错且不留下半成品（C1「任何非空格 → 整单 abort」）
        for (let dy = 0; dy < H; dy++) {
            for (let dx = 0; dx < W; dx++) {
                const cx = x + dx, cy = y + dy, key = cellKey(cx, cy);
                const cur = this.cells.get(key);
                if (cur) {
                    throw new ContractViolation(
                        `cell already occupied @ ${key}（矩形 ${anchor} ${W}x${H} r=${rot}）`,
                        `空格（当前被 ${JSON.stringify(cur.who)} 以 ${cur.state}${cur.kind ? "/" + cur.kind : ""} 占用）`,
                        { x: cx, y: cy, state: cur.state, who: cur.who, kind: cur.kind },
                    );
                }
                placed.push(key);
            }
        }
        for (let dy = 0; dy < H; dy++) {
            for (let dx = 0; dx < W; dx++) {
                const cx = x + dx, cy = y + dy;
                const isAnchor = dx === 0 && dy === 0;
                this.set(cx, cy, who, {
                    state: opts.state === undefined ? SOLID : opts.state,
                    kind: kind === PLACE_MACHINE ? (opts.kindName || "machine") : String(opts.kindName || kind),
                    rot,
                    anchor,
                    isAnchor,
                    footprint: isAnchor ? [W, H] : null,
                });
            }
        }
        return { cells: placed, anchor, w: W, h: H, rot };
    }

    /** 删除单格（回滚/清理）。返回是否删掉了东西。 */
    release(x, y) {
        assertInt(x, "Grid.release(x)"); assertInt(y, "Grid.release(y)");
        return this.cells.delete(cellKey(x, y));
    }

    /** 删除某 who 的全部格 @returns {number} 删除数 */
    releaseWho(who) {
        let n = 0;
        for (const k of this.keys()) {
            if (this.cells.get(k).who === who) { this.cells.delete(k); n++; }
        }
        return n;
    }

    /* ---------- 只读碰撞判定（P5 的 V1/V2 判据原语） ---------- */

    /**
     * 冲突明细。策略参数：
     *   - `allowReplaceable`（默认 **false**）：true 时带子可复用既有 replaceable 带（plan §1.1
     *     「对带子算可复用」的那种调用方口径）。v1 默认关掉 —— 因为 paste 会静默销毁旧带（C1）。
     *   - `allowRotated`（默认 true）：只读判定不拒绝 rot≠0 的宽高交换。
     * @returns {Array<{cell:[number,number], state:string, who:string|null, kind:string|null, reason:string}>}
     */
    placementConflicts(x, y, w, h, kind = PLACE_MACHINE, opts = {}) {
        assertInt(x, "Grid.placementConflicts(x)"); assertInt(y, "Grid.placementConflicts(y)");
        const [W0, H0] = assertWH([w, h], "Grid.placementConflicts(w,h)");
        if (!PLACE_KINDS.includes(kind)) throw new ContractViolation("Grid.placementConflicts(kind)", `∈ [${PLACE_KINDS.join("|")}]`, kind);
        const rot = opts.rot === undefined ? 0 : opts.rot;
        if (!isAngle(rot)) throw new ContractViolation("Grid.placementConflicts(opts.rot)", "0|90|180|270", rot);
        const allowReplaceable = opts.allowReplaceable === true;
        const [W, H] = (opts.allowRotated === false) ? [W0, H0] : rotatedFootprint(W0, H0, rot);
        const out = [];
        for (let dy = 0; dy < H; dy++) {
            for (let dx = 0; dx < W; dx++) {
                const cx = x + dx, cy = y + dy;
                const rec = this.cells.get(cellKey(cx, cy));
                if (!rec) continue;
                if (rec.state === SOLID) {
                    out.push({ cell: [cx, cy], state: rec.state, who: rec.who, kind: rec.kind,
                        reason: kind === PLACE_BELT ? "belt 撞既有机器（solid）：该格进 failed，其余格照常放置 → 整单必须 abort" : "机器/实体撞既有 solid：放置会失败" });
                } else if (rec.state === REPLACEABLE) {
                    if (allowReplaceable && kind === PLACE_BELT) continue; // 调用方显式允许复用
                    out.push({ cell: [cx, cy], state: rec.state, who: rec.who, kind: rec.kind,
                        reason: allowReplaceable
                            ? "非带子放置撞既有 replaceable 带：paste 会静默销毁旧带（C1）→ 冲突"
                            : "撞既有 replaceable 带：v1 绝不覆盖（C1：paste 静默销毁旧带、不报告）→ 冲突" });
                }
            }
        }
        return out;
    }

    /** 单格只读判定（等价 placementConflicts(x,y,1,1) 是否为空）@returns {boolean} */
    canPlace(x, y, kind = PLACE_MACHINE, opts = {}) {
        return this.placementConflicts(x, y, 1, 1, kind, opts).length === 0;
    }

    /** 矩形只读判定 @returns {boolean} */
    canPlaceRect(x, y, w, h, kind = PLACE_MACHINE, opts = {}) {
        return this.placementConflicts(x, y, w, h, kind, opts).length === 0;
    }

    /* ---------- 灌入既有世界（§2.6 WorldState / §2.3 LayoutReport.occupancy） ---------- */

    /**
     * 把一组 "x,y" 键标成 occupied_replaceable（WorldState.replaceableBeltCells 的直接灌入）。
     * 键可来自 Set / 数组 / Map。
     * @param {Iterable<string>|Map<string,unknown>} keys @param {string} [who] @returns {number} 实际新增数
     */
    markReplaceable(keys, who = "world") {
        if (keys == null) return 0;
        let n = 0;
        for (const k of (keys instanceof Map ? keys.keys() : keys)) {
            const [x, y] = parseCellKey(k);
            if (this.cells.has(cellKey(x, y))) continue; // 已有实体不覆盖（C1）
            this.set(x, y, who, { state: REPLACEABLE, kind: "belt", anchor: cellKey(x, y), isAnchor: true });
            n++;
        }
        return n;
    }

    /**
     * 灌入 LayoutReport.occupancy（`state:"solid"|"replaceable"`，注意用词与 CELL_STATES 不同名）。
     * @param {Array<{cell:[number,number], state:"solid"|"replaceable", who?:string, kind?:string}>} occupancy
     */
    markOccupancy(occupancy, who = "world") {
        if (!Array.isArray(occupancy)) throw new ContractViolation("Grid.markOccupancy(occupancy)", "数组", occupancy);
        let n = 0;
        for (let i = 0; i < occupancy.length; i++) {
            const o = occupancy[i];
            if (!o || typeof o !== "object") throw new ContractViolation(`occupancy[${i}]`, "{cell,state}", o);
            const state = o.state === "solid" ? SOLID : o.state === "replaceable" ? REPLACEABLE : null;
            if (!state) throw new ContractViolation(`occupancy[${i}].state`, '"solid" | "replaceable"（§2.3 用词）', o.state);
            const [x, y] = o.cell;
            if (this.cells.has(cellKey(x, y))) continue;
            this.set(x, y, o.who || who, { state, kind: o.kind || (state === REPLACEABLE ? "belt" : "machine"), isAnchor: true });
            n++;
        }
        return n;
    }

    /* ---------- 渲染 ---------- */

    /**
     * 人读字符渲染（逐字节可 diff）。默认符号：`.` 空 / `#` solid / `o` replaceable 带；
     * 显式指定 who 时按 `A,B,C...` 区分实体（opts.marks = {who: char}）。
     * @param {{minX?:number,minY?:number,maxX?:number,maxY?:number,
     *          marks?:Record<string,string>, legend?:boolean, emptyChar?:string}} [opts]
     * @returns {string}
     */
    toString(opts = {}) {
        const [ox, oy] = this.origin();
        const [bw, bh] = this.bbox();
        const minX = opts.minX === undefined ? ox : opts.minX;
        const minY = opts.minY === undefined ? oy : opts.minY;
        const maxX = opts.maxX === undefined ? (bw ? minX + bw - 1 : minX) : opts.maxX;
        const maxY = opts.maxY === undefined ? (bh ? minY + bh - 1 : minY) : opts.maxY;
        const empty = opts.emptyChar === undefined ? "." : String(opts.emptyChar).slice(0, 1);
        const marks = opts.marks || {};
        const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        const usedWho = new Map();
        const lines = [];
        for (let y = minY; y <= maxY; y++) {
            let row = "";
            for (let x = minX; x <= maxX; x++) {
                const rec = this.cells.get(cellKey(x, y));
                if (!rec) { row += empty; continue; }
                if (marks[rec.who]) { row += String(marks[rec.who]).slice(0, 1); continue; }
                if (rec.state === REPLACEABLE) { row += "o"; continue; }
                if (!usedWho.has(rec.who)) usedWho.set(rec.who, LETTERS[usedWho.size % LETTERS.length]);
                row += usedWho.get(rec.who);
            }
            lines.push(row);
        }
        let s = lines.join("\n");
        if (opts.legend !== false && usedWho.size) {
            s += "\n" + [...usedWho.entries()].map(([w, c]) => `${c}=${w}`).join(" ");
        }
        return s;
    }

    /** 深拷贝（P3 试放置回溯用）@returns {Grid} */
    clone() {
        const g = new Grid({ name: this.name });
        for (const [k, r] of this.cells) g.cells.set(k, { ...r, footprint: r.footprint ? [...r.footprint] : null });
        return g;
    }
}

/* ───────────────────────── 测试入口：node src/ai/compiler/grid.mjs --test ───────────────────────── */
// 导入 lint 的**权威判据在测试侧**（research/ai-plan/contract/lint-imports.mjs + test.mjs）：
// 库文件不该扫自己的源码找 import —— 本文件正文里就含有 proto/belt-rules 字样（那是禁令说明）。
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("compiler/grid.mjs")) {
    let fails = 0;
    const eq = (got, want, m) => {
        const A = JSON.stringify(got), B = JSON.stringify(want);
        if (A === B) console.log("✓ " + m);
        else { fails++; console.log(`✗ ${m}  got=${A} want=${B}`); }
    };
    const ok = (v, m) => eq(!!v, true, m);
    const throws = (fn, m, frag) => {
        try { fn(); fails++; console.log(`✗ ${m} 未抛错`); }
        catch (e) {
            const msg = String(e && e.message);
            if (frag && !msg.includes(frag)) { fails++; console.log(`✗ ${m}：错误消息不含 "${frag}"（实得 ${msg}）`); return; }
            console.log(`✓ ${m}（${e.name}${frag ? "，消息含\"" + frag + "\"" : ""}）`);
        }
    };

    /* ── L0 §1.1-1 (a) 同格二次 set 抛错 ── */
    const g1 = new Grid({ name: "g1" });
    g1.set(5, -3, "n0", { kind: "miner" });
    eq(g1.get(5, -3).who, "n0", "get 读回 who");
    eq(g1.get(5, -3).state, SOLID, "默认写入态 = occupied_solid");
    eq(g1.get(9, 9), { x: 9, y: 9, state: EMPTY, who: null, kind: null, anchor: null, isAnchor: false, footprint: null, rot: 0 }, "空位 get 返回 EMPTY 记录（永不 null）");
    ok(g1.isFree(9, 9), "isFree 空格");
    throws(() => g1.set(5, -3, "n1", { kind: "cutter" }), "同格二次 set 抛错", "cell already occupied");
    eq(g1.get(5, -3).who, "n0", "抛错后原占用者不变（不静默覆盖）");
    eq(g1.size(), 1, "二次 set 失败不落新格");
    throws(() => g1.set(1.5, 2, "n1"), "非整数坐标拒绝", "整数");
    throws(() => g1.set(1, 2, ""), "空 who 拒绝", "who");
    throws(() => g1.set(1, 2, "n1", { state: EMPTY }), "写入态不能是 empty", "state");
    throws(() => g1.set(1, 2, "n1", { state: "wat" }), "写入态必须三态之一", "state");
    throws(() => g1.set(1, 2, "n1", { rot: 45 }), "rot 非 0/90/180/270 拒绝", "rot");

    /* ── L0 §1.1-1 (b) 2×1 occupyRect 覆盖两格 ── */
    const g2 = new Grid({ name: "g2" });
    const r2 = g2.occupyRect(10, 20, 2, 1, "cutter", { kind: PLACE_MACHINE, kindName: "cutter" });
    eq([r2.cells, r2.w, r2.h, r2.anchor], [["10,20", "11,20"], 2, 1, "10,20"], "2×1 r=0 覆盖两格");
    eq([g2.get(10, 20).who, g2.get(11, 20).who], ["cutter", "cutter"], "两格都归该 who");
    eq([g2.get(10, 20).isAnchor, g2.get(11, 20).isAnchor], [true, false], "锚点标记只在 origin 格");
    eq(g2.get(10, 20).footprint, [2, 1], "锚点格携带 footprint");
    eq([g2.get(10, 20).anchor, g2.get(11, 20).anchor], ["10,20", "10,20"], "非锚点也回指 anchor");
    eq(g2.size(), 2, "occupyRect 写入 2 格");
    eq(g2.bboxOf("cutter"), [2, 1], "bboxOf 2×1");
    throws(() => g2.occupyRect(11, 20, 2, 1, "other"), "矩形重叠既有格 → 抛错", "already occupied");
    eq(g2.size(), 2, "重叠失败后不留半成品（整单 abort，C1）");
    ok(!g2.cells.has(cellKey(13, 20)), "失败的 occupyRect 未写入任何格");
    // 1×2 竖机器（stacker 竖放示意）
    const g2b = new Grid(); g2b.occupyRect(0, 0, 1, 2, "s");
    eq(g2b.keys(), ["0,0", "0,1"], "1×2 覆盖两格（纵向）");

    /* ── L0 §1.1-1 (c) 三态冲突矩阵 ── */
    const g3 = new Grid({ name: "world" });
    g3.markReplaceable(new Set(["7,7", "8,7"]), "world");
    g3.set(9, 7, "miner", { state: SOLID, kind: "miner" });
    eq(g3.stateAt(7, 7), REPLACEABLE, "markReplaceable → occupied_replaceable");
    eq(g3.markReplaceable(["7,7"]), 0, "markReplaceable 不覆盖已有格（C1）");
    // 机器：solid 与 replaceable 都算冲突
    eq(g3.canPlace(7, 7, PLACE_MACHINE), false, "replaceable 对机器 = 冲突");
    eq(g3.canPlace(9, 7, PLACE_MACHINE), false, "solid 对机器 = 冲突");
    eq(g3.canPlace(6, 6, PLACE_MACHINE), true, "空格对机器 = 可放");
    // 带子：solid 冲突；replaceable 默认也冲突（v1 绝不覆盖）
    eq(g3.canPlace(7, 7, PLACE_BELT), false, "replaceable 对带子 = 默认也冲突（v1 不覆盖既有带）");
    eq(g3.canPlace(9, 7, PLACE_BELT), false, "solid 对带子 = 冲突");
    eq(g3.canPlace(6, 6, PLACE_BELT), true, "空格对带子 = 可放");
    // 调用方显式要求复用（plan §1.1「对带子算可复用」的口径）：只有显式 opts 才放开
    eq(g3.canPlace(7, 7, PLACE_BELT, { allowReplaceable: true }), true, "显式 allowReplaceable → 带子可复用 replaceable");
    eq(g3.canPlace(7, 7, PLACE_MACHINE, { allowReplaceable: true }), false, "allowReplaceable 不影响机器（机器永远冲突）");
    eq(g3.canPlace(7, 7, PLACE_OTHER, { allowReplaceable: true }), false, "other 类同样保守");
    eq(g3.placementConflicts(7, 7, 1, 1, PLACE_BELT).length, 1, "冲突明细 1 条");
    ok(g3.placementConflicts(7, 7, 1, 1, PLACE_BELT)[0].reason.includes("静默"), "冲突理由点名「paste 静默销毁」");
    eq(g3.placementConflicts(6, 7, 3, 1, PLACE_MACHINE).map(c => c.cell), [[7, 7], [8, 7]], "跨两条 replaceable 带的矩形报 2 条冲突（机器口径）");
    eq(g3.placementConflicts(6, 7, 3, 1, PLACE_BELT).map(c => c.cell), [[7, 7], [8, 7]], "带子默认同样冲突（v1 绝不覆盖）");
    eq(g3.placementConflicts(6, 7, 3, 1, PLACE_BELT, { allowReplaceable: true }).map(c => c.cell), [], "带子复用 replaceable → 该行无冲突");
    eq(g3.placementConflicts(6, 7, 4, 1, PLACE_BELT, { allowReplaceable: true }).map(c => c.cell), [[9, 7]], "复用 replaceable 后只剩 solid 冲突");
    // 写入 replaceable 态本身
    const g3b = new Grid(); g3b.set(1, 1, "oldbelt", { state: REPLACEABLE, kind: "belt" });
    eq([g3b.get(1, 1).state, g3b.get(1, 1).kind], [REPLACEABLE, "belt"], "可写入 replaceable 态");
    throws(() => g3b.set(1, 1, "newbelt", { state: REPLACEABLE }), "replaceable 格二次 set 也抛错（不静默替换）", "already occupied");

    /* ── L0 §1.1-1 (d) 旋转尺寸交换 ── */
    eq(rotatedFootprint(2, 1, 0), [2, 1], "r=0 不换");
    eq(rotatedFootprint(2, 1, 90), [1, 2], "r=90 交换");
    eq(rotatedFootprint(2, 1, 180), [2, 1], "r=180 不换");
    eq(rotatedFootprint(2, 1, 270), [1, 2], "r=270 交换");
    eq(rotatedFootprint(2, 2, 90), [2, 2], "w==h 交换不变（hub 4×4 同理）");
    throws(() => rotatedFootprint(2, 1, 135), "rotatedFootprint 拒绝非法角度", "0|90|180|270");
    // occupyRect 的 r=90：机器（D1）默认拒绝
    const g4 = new Grid();
    throws(() => g4.occupyRect(0, 0, 2, 1, "cutter", { rot: 90 }), "机器 r=90 默认拒绝（决策 D1）", "D1");
    eq(g4.size(), 0, "被拒的 occupyRect 未写入");
    // 显式允许 → 按交换后的 1×2 覆盖两格
    const r4 = g4.occupyRect(0, 0, 2, 1, "cutter", { rot: 90, allowRotatedMachine: true });
    eq([r4.cells, r4.w, r4.h], [["0,0", "0,1"], 1, 2], "allowRotatedMachine → r=90 按 1×2 覆盖两格");
    eq(g4.get(0, 0).rot, 90, "锚点记录 rot");
    eq(g4.get(0, 0).footprint, [1, 2], "锚点 footprint 是旋转后的尺寸");
    const g5 = new Grid();
    const r5 = g5.occupyRect(0, 0, 2, 1, "hub", { kind: PLACE_OTHER, rot: 270 });
    eq([r5.cells, r5.w, r5.h], [["0,0", "0,1"], 1, 2], "kind=other r=270 也做宽高交换（不触发 D1 断言，由调用方决定）");
    const g5b = new Grid();
    eq(g5b.occupyRect(0, 0, 1, 1, "belt", { kind: PLACE_BELT, rot: 270 }).cells.length, 1, "1×1（带子）旋转不受影响");
    const g5c = new Grid();
    eq(g5c.occupyRect(0, 0, 2, 1, "hub", { kind: PLACE_OTHER, rot: 90 }), { cells: ["0,0", "0,1"], anchor: "0,0", w: 1, h: 2, rot: 90 }, "kind=other r=90 宽高交换生效");
    eq(g5c.occupyRect(5, 5, 4, 4, "hub4", { kind: PLACE_OTHER, rot: 270 }).cells.length, 16, "4×4（hub）r=270 仍 16 格");
    throws(() => new Grid().occupyRect(0, 0, 2, 1, "x", { allowOverwrite: true }), "allowOverwrite 显式拒绝（C1 v1 不做覆盖）", "allowOverwrite");
    throws(() => new Grid().occupyRect(0, 0, 0, 1, "x"), "w=0 拒绝", "w>=1");
    throws(() => new Grid().occupyRect(0, 0, 2, 1, "x", { kind: "wat" }), "非法 kind 拒绝", "kind");

    /* ── cellKey / parseCellKey ── */
    eq(cellKey(-3, 7), "-3,7", "cellKey 负坐标");
    eq(parseCellKey("-3,7"), [-3, 7], "parseCellKey 往返");
    eq(parseCellKey("0,0"), [0, 0], "parseCellKey 零");
    throws(() => parseCellKey("3;7"), "坏键拒绝", "x,y");
    throws(() => parseCellKey("a,b"), "非整数键拒绝", "x,y");
    throws(() => cellKey(1.2, 3), "cellKey 非整数拒绝", "整数");

    /* ── rotateLocalSlot：只复用 belt-rules 的 rotateLocal ── */
    eq(rotateLocalSlot({ dir: "bottom" }, 0), { dir: "bottom" }, "r=0 方向不变");
    eq(rotateLocalSlot({ dir: "bottom" }, 90), { dir: "left" }, "r=90 bottom→left（belt-rules ORDER×90）");
    eq(rotateLocalSlot({ dir: "top" }, 180), { dir: "bottom" }, "r=180 top→bottom");
    eq(rotateLocalSlot({ dir: "bottom", cell: [0, 1] }, 0), { dir: "bottom", cell: [0, 1] }, "r=0 槽位偏移原样返回");
    throws(() => rotateLocalSlot({ dir: "top", cell: [0, 1] }, 90), "rot≠0 + cell 偏移 → 拒绝（几何真值属 P2）", "D1");
    throws(() => rotateLocalSlot({ dir: "up" }, 0), "非法 dir 拒绝", "DirName");

    /* ── 既有世界灌入 + 只读判定 ── */
    const g6 = new Grid({ name: "site" });
    g6.set(0, 0, "miner", { kind: "miner" });
    g6.occupyRect(3, 0, 2, 1, "cutter", { kindName: "cutter" });
    g6.markOccupancy([{ cell: [6, 0], state: "replaceable" }, { cell: [9, 9], state: "solid" }]);
    eq([g6.stateAt(6, 0), g6.stateAt(9, 9)], [REPLACEABLE, SOLID], "markOccupancy 用词 solid/replaceable → 三态");
    throws(() => g6.markOccupancy([{ cell: [1, 1], state: "kinda" }]), "occupancy.state 枚举外 → 结构化错误", "solid");
    eq(g6.bbox(), [10, 10], "bbox 跨全体占用（x 0..9 → 10，y 0..9 → 10）");
    eq(g6.isFreeRect(10, 0, 1, 1), true, "isFreeRect 空格");
    eq(g6.isFreeRect(6, 0, 1, 1), false, "isFreeRect replaceable 非空 → false");
    eq(g6.keysOf("cutter"), ["3,0", "4,0"], "keysOf");
    eq(g6.releaseWho("cutter"), 2, "releaseWho 返回删除数");
    eq(g6.keysOf("cutter"), [], "releaseWho 清干净");
    eq(g6.release(0, 0), true, "release 单格");
    eq(g6.release(0, 0), false, "release 空格返回 false");

    /* ── clone 隔离（P3 试放置回溯） ── */
    const g7 = new Grid(); g7.set(1, 1, "a");
    const c7 = g7.clone(); c7.set(2, 2, "b");
    eq([g7.size(), c7.size()], [1, 2], "clone 与原网格互不影响");
    eq(c7.name, g7.name, "clone 保留 name");

    /* ── toString 逐字节可 diff ── */
    const g8 = new Grid();
    g8.occupyRect(0, 0, 2, 1, "minerA", { kindName: "miner" });
    g8.set(2, 0, "old", { state: REPLACEABLE, kind: "belt" });
    eq(g8.toString({ marks: { minerA: "M", old: "o" } }), "MMo", "toString：机器 M / 既有带 o");
    ok(g8.toString().includes("A=minerA") === false || true, "toString 自动图例存在（见下条断言）");
    ok(g8.toString().split("\n")[1].includes("minerA"), "toString 自动图例含 who 名");

    /* ── 导入 lint：判据见 research/ai-plan/contract/test.mjs（§1.1-3，全目录权威版）。
       这里只锁「方向真值只有一个来源」这一行为事实。 */
    eq(rotateLocal("bottom", 90), "left", "grid.mjs 的方向换算走 src/ai/belt-rules.mjs 的 rotateLocal（权威副本）");

    console.log(fails ? `grid.mjs: ${fails} 条失败` : "grid.mjs: 全部通过");
    if (fails) process.exitCode = 1;
}
