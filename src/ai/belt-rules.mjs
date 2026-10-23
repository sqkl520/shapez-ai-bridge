/**
 * belt-rules.mjs — 传送带方向的离线规则库（编译器用，零依赖）。
 *
 * 三条已实机验证的命题（1906 条真实带子，validate-belt-rules.mjs）：
 *   A. belt code = 1 + rotationVariant                （rv0直/rv1左弯/rv2右弯）✅ 1906/1906
 *   B. 局部几何：三种 rv 的入口都在局部 bottom；出口局部 rv0=top, rv1=left, rv2=right；
 *      世界方向 = 局部方向按 rotation 旋转            ✅ 链闭合 1267 对 / 1 错（离群：与地下带重叠）
 *   C. 游戏最终态是 compute+迭代的不动点，82.5% 可由邻居复现 ——
 *      漂移全在"邻居含机器"的角落（belt.js 扫描含全部建筑的 ejector/acceptor）。
 *      编译器**不需要**复现 C：蓝图路径显式携带 rv（mod 的 immutable 粘贴，提交 a35a481）。
 *
 * 世界方向约定（y 向下）：top=[0,-1] right=[1,0] bottom=[0,1] left=[-1,0]。
 * rotation 角度 = ORDER 索引 × 90（top:0, right:90, bottom:180, left:270）。
 */

export const ORDER = ["top", "right", "bottom", "left"];
export const OPP = { top: "bottom", bottom: "top", left: "right", right: "left" };
export const DIRV = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };

export const norm360 = a => ((a % 360) + 360) % 360;
export const angleToDir = a => ORDER[norm360(a) / 90];
export const dirToAngle = d => ORDER.indexOf(d) * 90;

/** 局部方向 → 世界方向（rotation 角度制） */
export function rotateLocal(localDir, rotation) {
    const steps = (norm360(rotation) / 90) | 0;
    return ORDER[(ORDER.indexOf(localDir) + steps) % 4];
}

/** rv 的世界出口/入口方向。
 *  局部帧：三种 rv 入口恒在 bottom；出口 rv0=top / rv1=left / rv2=right。
 *  弯带的入与出是**垂直**关系（不是相反）——入口方向必须直接旋转局部 bottom，不能用 OPP[exit]。 */
export const EXIT_LOCAL = { 0: "top", 1: "left", 2: "right" };
export function beltExit(rv, rotation) { return rotateLocal(EXIT_LOCAL[rv], rotation); }
export function beltEntry(rv, rotation) { return rotateLocal("bottom", rotation); }

/**
 * 编译器核心求解：给定货流「从世界方位 inDir 进本格、朝世界方位 outDir 出本格」，
 * 求 (rotation, rv)。entry=inDir、exit=outDir 同时满足。
 * 有解 ⟺ in≠out 且为直角或直线；直线唯一解 rv0；直角在 rv1/rv2 中取满足者。
 */
export function solveTurn(inDir, outDir) {
    if (inDir === outDir) return null;                       // 同向穿过的不是带子该有的形态
    for (let s = 0; s < 4; s++) {
        const rot = s * 90;
        for (const rv of [0, 1, 2]) {
            if (beltEntry(rv, rot) === inDir && beltExit(rv, rot) === outDir) {
                return { rotation: rot, rotationVariant: rv };
            }
        }
    }
    return null;
}

export const BELT_CODE_BASE = 1;
export const beltCode = rv => BELT_CODE_BASE + rv;

/** 自测（node 直接跑本文件） */
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("ai/belt-rules.mjs")) {
    const eq = (a, b, m) => { const A = JSON.stringify(a), B = JSON.stringify(b); console.log(A === B ? "✓ " + m : "✗ " + m + ` got ${A} want ${B}`); if (A !== B) process.exitCode = 1; };
    eq(solveTurn("bottom", "top"), { rotation: 0, rotationVariant: 0 }, "直带 入下出上");
    eq(solveTurn("bottom", "left"), { rotation: 0, rotationVariant: 1 }, "左弯 入下出左");
    eq(solveTurn("bottom", "right"), { rotation: 0, rotationVariant: 2 }, "右弯 入下出右");
    eq(solveTurn("right", "top"), { rotation: 270, rotationVariant: 2 }, "入右出上 = rv2 转270");
    eq(solveTurn("left", "right"), { rotation: 90, rotationVariant: 0 }, "直带 东西向");
    eq(solveTurn("top", "bottom"), { rotation: 180, rotationVariant: 0 }, "直带 入上出下");
    eq(solveTurn("left", "left"), null, "同向无解");
    eq(beltCode(2), 3, "code=1+rv");
    eq(beltExit(1, 90), "top", "rv1 转90 出口=世界上");
    eq(beltEntry(2, 0), "bottom", "入口只看 rotation=局部 bottom 旋转");
}
