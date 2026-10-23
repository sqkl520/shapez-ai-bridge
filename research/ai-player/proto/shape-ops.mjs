/**
 * shape-ops.mjs — shapez 1.5.6 形状运算的离线复刻（主 Agent 亲自核证版）。
 *
 * 每一行都对照 recon/upstream-full/src/js/game/shape_definition.js 的实现：
 *   getHash()                 :266   —— 形状字符串编码
 *   fromShortKey()            :139   —— 字符串解析
 *   cloneFilteredByQuadrants():471   —— 切割的底层
 *   cloneRotateCW/CCW/180()   :497/:511/:525
 *   cloneAndStackWith()       :538
 *   cloneAndPaintWith()       :609  / cloneAndPaintWith4Colors() :628
 * 与 shape_definition_manager.js 的 shapeAction* 包装（:92-:238）。
 */
import assert from "node:assert";

// 象限索引（shape_definition.js:33）：0=TR 1=BR 2=BL 3=TL（顺时针）
const TR = 0, BR = 1, BL = 2, TL = 3;

const SUB_TO_SHORT = { rect: "R", circle: "C", star: "S", windmill: "W" };
const SHORT_TO_SUB = { R: "rect", C: "circle", S: "star", W: "windmill" };
const COLOR_TO_SHORT = { red: "r", green: "g", blue: "b", yellow: "y", purple: "p", cyan: "c", white: "w", uncolored: "u" };
const SHORT_TO_COLOR = Object.fromEntries(Object.entries(COLOR_TO_SHORT).map(([k, v]) => [v, k]));

/** 形状 = 层数组（下→上）；每层 = 4 个 {sub,color} 或 null */
export const emptyShape = () => ({ layers: [] });

/** 解析 short key（shape_definition.js:139 fromShortKey） */
export function parse(shortKey) {
    const srcLayers = String(shortKey).split(":");
    const layers = [];
    for (const text of srcLayers) {
        assert(text.length === 8, "Invalid shape short key: " + shortKey);
        const quads = [null, null, null, null];
        for (let q = 0; q < 4; q++) {
            const sc = text[q * 2], cc = text[q * 2 + 1];
            const sub = SHORT_TO_SUB[sc];
            if (sub) {
                const color = SHORT_TO_COLOR[cc];
                assert(color, "Invalid color code: " + cc);
                quads[q] = { sub, color };
            } else {
                assert(sc === "-", "Invalid shape code: " + sc);
            }
        }
        layers.push(quads);
    }
    return { layers };
}

/** 生成 short key（shape_definition.js:266 getHash） */
export function hash(shape) {
    let id = "";
    for (let li = 0; li < shape.layers.length; li++) {
        const layer = shape.layers[li];
        for (let q = 0; q < 4; q++) {
            const item = layer[q];
            id += item ? SUB_TO_SHORT[item.sub] + COLOR_TO_SHORT[item.color] : "--";
        }
        if (li < shape.layers.length - 1) id += ":";
    }
    return id;
}

const clone = s => ({ layers: s.layers.map(l => l.map(x => (x ? { ...x } : null))) });

/** 只保留给定象限（shape_definition.js:471）—— 空层会被整层删掉 */
export function filterQuads(shape, include) {
    const newLayers = clone(shape).layers;
    for (let li = 0; li < newLayers.length; li++) {
        const quads = newLayers[li];
        let any = false;
        for (let q = 0; q < 4; q++) {
            if (include.indexOf(q) < 0) quads[q] = null;
            else if (quads[q]) any = true;
        }
        if (!any) { newLayers.splice(li, 1); li -= 1; }   // 空层剔除
    }
    return { layers: newLayers };
}

/** 顺时针：unshift(quads[3]); pop()  （shape_definition.js:497） */
export function rotateCW(shape) {
    const s = clone(shape);
    for (const q of s.layers) { q.unshift(q[3]); q.pop(); }
    return s;
}

/** 逆时针：push(quads[0]); shift() （shape_definition.js:511） */
export function rotateCCW(shape) {
    const s = clone(shape);
    for (const q of s.layers) { q.push(q[0]); q.shift(); }
    return s;
}

/** 180°：push(shift(), shift()) （shape_definition.js:525） */
export function rotate180(shape) {
    const s = clone(shape);
    for (const q of s.layers) { q.push(q.shift(), q.shift()); }
    return s;
}

// ── 游戏语义包装（shape_definition_manager.js） ──
/** :92 —— 竖直切：返回 [右半(2,3), 左半(0,1)]  ※注意顺序！ */
export const cutHalf = shape => [filterQuads(shape, [BL, TL]), filterQuads(shape, [TR, BR])];
/** :113 —— 四切：返回 [TR, BR, BL, TL] 四个单象限 */
export const cutQuad = shape => [TR, BR, BL, TL].map(q => filterQuads(shape, [q]));
/** :192 —— 把 upper 叠到 lower 上（lower 在下） */
export const stack = (lower, upper) => {
    // 忠实复刻 cloneAndStackWith 的"最小间隙为 1 层"合并语义（shape_definition.js:538）
    const bottom = lower.layers, top = upper.layers;
    if (!bottom.length || !top.length) throw new Error("cannot stack empty shape");
    const bottomHighest = [-1, -1, -1, -1];
    for (let l = bottom.length - 1; l >= 0; --l)
        for (let q = 0; q < 4; q++) if (bottom[l][q] && bottomHighest[q] < l) bottomHighest[q] = l;
    const topLowest = [4, 4, 4, 4];
    for (let l = 0; l < top.length; ++l)
        for (let q = 0; q < 4; q++) if (top[l][q] && topLowest[q] > l) topLowest[q] = l;
    const gaps = [0, 1, 2, 3].map(q => topLowest[q] - bottomHighest[q]);
    const layerToMergeAt = Math.max(1 - Math.min(...gaps), 0);

    const merged = clone(lower).layers;
    while (merged.length < layerToMergeAt + top.length) merged.push([null, null, null, null]);
    for (let l = 0; l < top.length; ++l) {
        const at = layerToMergeAt + l;
        for (let q = 0; q < 4; q++) {
            const b = merged[at][q], t = top[l][q];
            assert(!(b && t), "Shape merge: sub shape lost");
            merged[at][q] = b || (t ? { ...t } : null);
        }
    }
    merged.splice(4);                     // 最多 4 层
    return { layers: merged };
};
/** :212 —— 全形状上色（只影响非空象限） */
export const paint = (shape, color) => {
    const s = clone(shape);
    for (const l of s.layers) for (let q = 0; q < 4; q++) if (l[q]) l[q].color = color;
    return s;
};
/** :232 —— 4 色上色（colors[q] 为 null/undefined 则保持原色） */
export const paint4 = (shape, colors) => {
    const s = clone(shape);
    for (const l of s.layers) for (let q = 0; q < 4; q++) if (l[q] && colors[q]) l[q].color = colors[q];
    return s;
};

export const K = { TR, BR, BL, TL };
export const ALL_COLORS = ["red", "green", "blue", "yellow", "purple", "cyan", "white"];

// ───────────────────────── 自检 ─────────────────────────
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("proto/shape-ops.mjs")) {
    const eq = (a, b) => { const A = hash(a), B = hash(b); if (A !== B) throw new Error(`expected ${B}, got ${A}`); };

    // 1. 往返
    for (const k of ["CuCuCuCu", "CgScScCg", "----CuCu", "RuRuSuSu", "CuCuCuCu:CwCwCwCw"]) {
        eq(parse(k), parse(hash(parse(k))));
    }
    console.log("✓ 字符串往返 (parse/hash)");

    // 2. 旋转：CuCuCuCu 不变；非对称形状验证置换
    eq(rotateCW(parse("CuCuCuCu")), parse("CuCuCuCu"));
    eq(rotateCW(parse("RuSuRuSu")), parse("SuRuSuRu"));      // [RSRS] -> [SRSR]
    eq(rotate180(parse("RuRu----")), parse("----RuRu"));     // 半形状翻 180°
    console.log("✓ rotateCW / rotate180 象限置换");

    // 3. 切割：cutHalf 返回 [quads(2,3), quads(0,1)] = [左列, 右列]  ← 顺序与源码 manager.js:92 一致
    //    CgScScCg = TR:Cg BR:Sc BL:Sc TL:Cg
    eq(cutHalf(parse("CgScScCg"))[0], parse("----ScCg"));    // quads 2,3 = BL,TL = 左列
    eq(cutHalf(parse("CgScScCg"))[1], parse("CgSc----"));    // quads 0,1 = TR,BR = 右列
    console.log("✓ cutHalf 顺序 = [quads(2,3), quads(0,1)]（源码 manager.js:92 实测语义）");

    // 4. ★ 端到端：用地图真有的原料造出 level-11 目标 CgScScCg
    //    地图有 CuCuCuCu（纯圆）与 SuSuSuSu（纯星）+ red/green/blue 颜料
    //    ⚠️ 颜色是位域（colors.js:61 bitfieldToColor）：red=1 green=2 blue=4，混合 = 按位或
    //       所以 cyan(110) = green | blue —— 需用 **mixer** 先把绿+蓝混成青
    const cu = parse("CuCuCuCu"), su = parse("SuSuSuSu");
    const suCyan = paint(su, "cyan");                    // SuSuSuSu + 青 = ScScScSc
    eq(suCyan, parse("ScScScSc"));
    const cuGreen = paint(cu, "green");                  // CuCuCuCu + 绿 = CgCgCgCg
    eq(cuGreen, parse("CgCgCgCg"));

    // 目标 CgScScCg 的四象限 = TR:Cg BR:Sc BL:Sc TL:Cg
    //   → 上排(TR,TL) 全是 Cg，下排(BR,BL) 全是 Sc  → **横向**两半
    //   纵向右半旋转得到横向半：ScSc---- --CW--> --ScSc--（下排）；CgCg---- --CCW--> Cg----Cg（上排）
    const rightSc = cutHalf(suCyan)[1];                  // "ScSc----"
    eq(rightSc, parse("ScSc----"));
    const bottomRow = rotateCW(rightSc);                 // "--ScSc--"
    eq(bottomRow, parse("--ScSc--"));

    const rightCg = cutHalf(cuGreen)[1];                 // "CgCg----"
    eq(rightCg, parse("CgCg----"));
    const topRow = rotateCCW(rightCg);                   // "Cg----Cg"
    eq(topRow, parse("Cg----Cg"));

    const target = stack(bottomRow, topRow);             // 下排在下、上排在上
    eq(target, parse("CgScScCg"));
    console.log("✓ ★ 端到端：CuCuCuCu + SuSuSuSu + 绿/青颜料 ⇒ CgScScCg");
    console.log("   推演链：SuSuSuSu --paint cyan--> ScScScSc --cutHalf[1]--> ScSc---- --rotateCW--> --ScSc--");
    console.log("           CuCuCuCu --paint green--> CgCgCgCg --cutHalf[1]--> CgCg---- --rotateCCW--> Cg----Cg");
    console.log("           stack(--ScSc--, Cg----Cg) = CgScScCg  ✅ 与实机 level-11 目标一致");
    console.log("   ⇒ 7 步：2×paint + 2×cutHalf + 2×rotate + 1×stack（2 形状原料 + 颜料物流：青需 mixer 混绿+蓝）");
}
