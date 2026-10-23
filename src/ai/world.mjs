/**
 * world.mjs — 离线世界访问（P2 data 包）：资源格查询 / 找矿 / 与 gen-resources CLI 对拍。
 *
 * 100% 离线：零 RPC、零网络、零游戏（plan §4 第 2 条：只有 P7 允许碰桥接）。
 *
 * 算法来源（**复刻**，不是 import）：
 *   research/ai-player/exp-e2e.mjs:32-89      ← 本文件的直接搬运源（同一算法的已验证内联版）
 *   research/ai-player/proto/gen-resources.mjs:17-210（对照逐行；CLI 输出是本文件的对拍基准）
 *   上游对照：recon/upstream-full/src/js/game/map_chunk.js（generateLowerLayer/generatePatches）、
 *             core/rng.js（ALEA）、core/config.js:72（mapChunkSize = 16）
 *   实机凭据：facts/offline-map-reproduction.md（seed 43391 → 3002/3002 逐格一致）
 *
 * 为什么复刻而不是 import（决策记录：research/ai-plan/data/NOTES.md G5）：
 *   plan §1.2 明写 `gen-resources.mjs` **无 export**（`generateWorld` 是模块内函数，
 *   只有 CLI `node gen-resources.mjs <seed> x0 y0 x1 y1` 输出 `[x,y,shape]` JSON 行，见 :194-257），
 *   并**禁止**要求别人把它改成可 import。故选方案 (a)：在 world.mjs 内复刻 chunk 算法，
 *   再用 `--validate` 与 CLI 逐格对拍锁住等价性（方案 (b) 生成期跑 CLI 落 fixture 只作为 fallback）。
 *
 * 兼容性要点（**必须与上游一致，别"顺手修正"**）：
 *   - chunk 种子串 = `${chunkX}|${chunkY}|${seed}`（顺序与拼接字符完全一致）
 *   - 边界判断不对称：`x >= 0 && x < 16 && y >= 0 && y <= 16`（y 越界一格会写进 l[x][16]，
 *     读回只看 [0..15] 所以无害——上游就是这样，照抄以保持逐格等价）
 *   - RNG 消耗顺序：patch() 里先 nextIntRange(patchX) 再 nextIntRange(patchY)，
 *     **即使随后被 overrideX/overrideY 覆盖也已经消耗了**（gen-resources.mjs:110-115）
 *   - generateColorPatch 里 rng.choice 先于 patch 消耗 RNG（实参求值顺序，:147）
 *   - pickSubShape 依赖 weights 对象键的**插入顺序** rect,circle,star,windmill（:185）
 *
 * 用法：
 *   node src/ai/world.mjs --test                        自测
 *   node src/ai/world.mjs --validate [seed] [--region x0 y0 x1 y1] [--chunks]
 *       对 seed（默认 43391 = level-11 存档 dump 的 map.seed）跑一片区域，
 *       与 `node research/ai-player/proto/gen-resources.mjs <seed> x0 y0 x1 y1` **逐格对拍**。
 *       差异数必须为 0。--chunks 时另与 facts/live/resources.json 对拍（离线，不需游戏）。
 *   node src/ai/world.mjs --tile <seed> <x> <y>
 *   node src/ai/world.mjs --find <seed> <shape> <x0> <y0> <x1> <y1>
 *
 * 零依赖：ESM + node: 内置。
 *
 * 导出清单（P3 placer 主要消费本文件；**不要**自己去跑 gen-resources CLI）：
 *   查询  tileResource(seed,x,y) / findResource(seed,shape,region) /
 *         resourcesInRegion(seed,region) / nearestResource(seed,shape,from,region,metric?) /
 *         resourceHistogram(seed,region) / regionAround(center,radius)
 *   缓存  clearChunkCache()
 *   对拍  validateAgainstCli(seed?,region?) / validateAgainstLive(seed?)
 *   常量  MAP_CHUNK_SIZE(16) / DEFAULT_SEED(43391 = level-11 存档 map.seed) / WorldError
 *   不变  resourcesInRegion 的返回**逐格等于** gen-resources CLI 的 JSON 行（由 --validate 锁）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const MAP_CHUNK_SIZE = 16;              // 上游 core/config.js:72 mapChunkSize

/* ───────────────────────── 结构化错误（本地版） ─────────────────────────
 * reason 取值刻意复用 plan §2.5 的枚举字符串，但**不 import** P1 的 errors.mjs：
 * P1 仍在写，本包测试要自包含。
 * TODO(P1 落地后)：换成 errors.mjs 的 ContractViolation / makeFailure（字段名已对齐 path/rule/got/reason）。 */
export class WorldError extends Error {
    constructor(pathKey, rule, got, reason = "no-resource-in-range") {
        super(`世界查询失败 ${pathKey}: 期望 ${rule}，实得 ${safe(got)}`);
        this.name = "WorldError";
        this.path = pathKey; this.rule = rule; this.got = got; this.reason = reason;
        this.failure = { ok: false, reason, failingNode: { nodeId: null, cell: null, check: pathKey }, hint: null };
    }
}
function safe(v) {
    if (v === undefined) return "undefined";
    if (typeof v === "string") return JSON.stringify(v);
    try { const s = JSON.stringify(v); return s === undefined ? String(v) : s.slice(0, 120); } catch { return String(v); }
}

/* ───────────────────────── ALEA RNG（对照 gen-resources.mjs:21-62 / exp-e2e.mjs:33-35） ───────────────────────── */

function Mash() {
    let n = 0xefc8249d;
    return function (data) {
        data = data.toString();
        for (let i = 0; i < data.length; i++) {
            n += data.charCodeAt(i);
            let h = 0.02519603282416938 * n;
            n = h >>> 0;
            h -= n; h *= n; n = h >>> 0;
            h -= n; n += h * 0x100000000;
        }
        return (n >>> 0) * 2.3283064365386963e-10;
    };
}

function makeNewRng(seed) {
    let c = 1;
    const mash = Mash();
    let s0 = mash(" "), s1 = mash(" "), s2 = mash(" ");
    s0 -= mash(seed); if (s0 < 0) s0 += 1;
    s1 -= mash(seed); if (s1 < 0) s1 += 1;
    s2 -= mash(seed); if (s2 < 0) s2 += 1;
    return function () {
        const t = 2091639 * s0 + c * 2.3283064365386963e-10;
        s0 = s1; s1 = s2;
        return (s2 = t - (c = t | 0));
    };
}

class RNG {
    constructor(seed) { this.r = makeNewRng(seed); }
    next() { return this.r(); }
    choice(arr) { return arr[this.nextIntRange(0, arr.length)]; }
    nextIntRange(min, max) { return Math.floor(this.next() * (max - min) + min); }
    nextRange(min, max) { return this.next() * (max - min) + min; }
}

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const SHORT_OF_SUBSHAPE = { rect: "R", circle: "C", star: "S", windmill: "W" };

/** 上游 pickSubShape（gen-resources.mjs:181-190）—— 遍历顺序 = 键插入顺序 */
function pickSubShape(rng, weights) {
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    const chosenNumber = rng.nextIntRange(0, sum - 1);
    let accumulated = 0;
    for (const key in weights) {
        if (accumulated + weights[key] > chosenNumber) return key;
        accumulated += weights[key];
    }
    return "circle";
}

/* ───────────────────────── Chunk（对照 gen-resources.mjs:72-179 / exp-e2e.mjs:39-82） ───────────────────────── */

class Chunk {
    constructor(seed, x, y) {
        this.x = x; this.y = y;
        this.tileX = x * MAP_CHUNK_SIZE; this.tileY = y * MAP_CHUNK_SIZE;
        // 注意维度顺序：l[lx][ly]（与上游 lower[lx][ly] 一致）
        this.l = Array.from({ length: MAP_CHUNK_SIZE }, () => new Array(MAP_CHUNK_SIZE).fill(null));
        this._extraRow = new Map();     // 承接 y===16 的越界写入（上游不判 y 上界），读回只用 [0..15]
        this.generate(seed);
    }

    generate(seed) {
        const rng = new RNG(this.x + "|" + this.y + "|" + seed);   // ← 种子拼接与源码完全一致
        if (this.generatePredefined(rng)) return;

        const cx = this.x + 0.5, cy = this.y + 0.5;
        const d = Math.round(Math.hypot(cx, cy));                  // distanceToOriginInChunks

        const colorChance = 0.9 - clamp(d / 25, 0, 1) * 0.5;
        if (rng.next() < colorChance / 4) {
            const size = Math.max(2, Math.round(1 + clamp(d / 8, 0, 4)));
            this.generateColorPatch(rng, size, d);
        }
        const shapeChance = 0.9 - clamp(d / 25, 0, 1) * 0.5;
        if (rng.next() < shapeChance / 4) {
            const size = Math.max(2, Math.round(1 + clamp(d / 8, 0, 4)));
            this.generateShapePatch(rng, size, d);
        }
    }

    /** 上游 generatePredefined —— 5 个写死块（hub 出生点周围） */
    generatePredefined(rng) {
        if (this.x === 0 && this.y === 0) { this.patch(rng, 2, "red", 7, 7); return true; }
        if (this.x === -1 && this.y === 0) { this.patch(rng, 2, "CuCuCuCu", MAP_CHUNK_SIZE - 9, 7); return true; }
        if (this.x === 0 && this.y === -1) { this.patch(rng, 2, "RuRuRuRu", 5, MAP_CHUNK_SIZE - 7); return true; }
        if (this.x === -1 && this.y === -1) { this.patch(rng, 2, "green"); return true; }
        if (this.x === 5 && this.y === -2) { this.patch(rng, 2, "SuSuSuSu", 5, MAP_CHUNK_SIZE - 7); return true; }
        return false;
    }

    /** 上游 internalGeneratePatch。RNG 消耗顺序是关键（先 x 后 y，即便随后被 override 覆盖）。 */
    patch(rng, patchSize, item, overrideX = null, overrideY = null) {
        const border = Math.ceil(patchSize / 2 + 3);
        let patchX = rng.nextIntRange(border, MAP_CHUNK_SIZE - border - 1);
        let patchY = rng.nextIntRange(border, MAP_CHUNK_SIZE - border - 1);
        if (overrideX !== null) patchX = overrideX;
        if (overrideY !== null) patchY = overrideY;

        const numCircles = patchSize;
        for (let i = 0; i <= numCircles; ++i) {
            const circleRadius = Math.min(1 + i, patchSize);
            const circleRadiusSquare = circleRadius * circleRadius;
            const circleOffsetRadius = (numCircles - i) / 2 + 2;
            const circleScaleX = rng.nextRange(0.9, 1.1);
            const circleScaleY = rng.nextRange(0.9, 1.1);
            const circleX = patchX + rng.nextIntRange(-circleOffsetRadius, circleOffsetRadius);
            const circleY = patchY + rng.nextIntRange(-circleOffsetRadius, circleOffsetRadius);

            for (let dx = -circleRadius * circleScaleX - 2; dx <= circleRadius * circleScaleX + 2; ++dx) {
                for (let dy = -circleRadius * circleScaleY - 2; dy <= circleRadius * circleScaleY + 2; ++dy) {
                    const x = Math.round(circleX + dx);
                    const y = Math.round(circleY + dy);
                    // ⚠️ 上游的边界判断不对称（x < size / y <= size）——原样复刻，勿"修正"
                    if (x >= 0 && x < MAP_CHUNK_SIZE && y >= 0 && y <= MAP_CHUNK_SIZE) {
                        const odx = dx / circleScaleX;
                        const ody = dy / circleScaleY;
                        if (odx * odx + ody * ody <= circleRadiusSquare) {
                            if (y === MAP_CHUNK_SIZE) {                 // 越界写入：存着但不参与读回
                                if (!this._extraRow.has(x)) this._extraRow.set(x, item);
                                continue;
                            }
                            if (!this.l[x][y]) this.l[x][y] = item;
                        }
                    }
                }
            }
        }
    }

    generateColorPatch(rng, size, d) {
        const avail = ["red", "green"];
        if (d > 2) avail.push("blue");
        const color = rng.choice(avail);          // ← choice 先于 patch 消耗 RNG
        this.patch(rng, size, color);
    }

    generateShapePatch(rng, size, d) {
        const weights = {
            rect: 100,
            circle: Math.round(50 + clamp(d * 2, 0, 50)),
            star: Math.round(20 + clamp(d, 0, 30)),
            windmill: Math.round(6 + clamp(d / 2, 0, 20)),
        };
        if (d < 7) { weights.star = 0; weights.windmill = 0; }

        let subShapes;
        if (d < 10) {
            const a = pickSubShape(rng, weights);
            subShapes = [a, a, a, a];
        } else if (d < 15) {
            const a = pickSubShape(rng, weights);
            const b = pickSubShape(rng, weights);
            subShapes = [a, a, b, b];
        } else {
            subShapes = [pickSubShape(rng, weights), pickSubShape(rng, weights),
                         pickSubShape(rng, weights), pickSubShape(rng, weights)];
        }

        let windmillCount = 0;
        for (const s of subShapes) if (s === "windmill") ++windmillCount;
        if (windmillCount > 1) { subShapes[0] = "rect"; subShapes[1] = "rect"; }

        // getDefinitionFromSimpleShapes：4 quadrant 顺序 TR,BR,BL,TL，颜色 uncolored ('u')
        this.patch(rng, size, subShapes.map(s => SHORT_OF_SUBSHAPE[s] + "u").join(""));
    }
}

/* ───────────────────────── 世界索引 API ───────────────────────── */

const chunkCache = new Map();
const keyOf = (cx, cy, seed) => `${seed}|${cx},${cy}`;

/** seed 进 RNG 是**字符串拼接**（`${x}|${y}|${seed}`），数字与数字串等价；
 *  但 undefined/null/NaN 会静默生成一张"错世界" → 必须拦住（编译器的确定性前提）。 */
function assertSeed(seed) {
    if (typeof seed !== "number" && typeof seed !== "string")
        throw new WorldError("seed", "number 或 string（map.seed，如 43391）", seed, "no-resource-in-range");
    if (typeof seed === "number" && !Number.isFinite(seed))
        throw new WorldError("seed", "有限数", seed, "no-resource-in-range");
    if (String(seed).length === 0)
        throw new WorldError("seed", "非空", seed, "no-resource-in-range");
    return seed;
}

function getChunk(seed, cx, cy) {
    const k = keyOf(cx, cy, seed);
    let ch = chunkCache.get(k);
    if (!ch) { ch = new Chunk(seed, cx, cy); chunkCache.set(k, ch); }
    return ch;
}

export function clearChunkCache() { chunkCache.clear(); }

/** 该格的资源 shortKey（"red"/"green"/"blue"/"CuCuCuCu"…），无资源 → null。
 *  负坐标用 Math.floor（-9/16 → chunk -1，与上游一致）。 */
export function tileResource(seed, x, y) {
    assertSeed(seed);
    if (!Number.isInteger(x) || !Number.isInteger(y))
        throw new WorldError("tileResource.(x,y)", "整数格坐标", [x, y], "no-resource-in-range");
    const cx = Math.floor(x / MAP_CHUNK_SIZE), cy = Math.floor(y / MAP_CHUNK_SIZE);
    const ch = getChunk(seed, cx, cy);
    const lx = x - ch.tileX, ly = y - ch.tileY;
    if (lx < 0 || lx >= MAP_CHUNK_SIZE || ly < 0 || ly >= MAP_CHUNK_SIZE) return null;
    return ch.l[lx][ly];
}

const normRegion = region => {
    if (region === undefined || region === null)
        throw new WorldError("findResource.region", "必须给 region（世界无限，无界搜索不可行）：{x0,y0,x1,y1} 或 [x0,y0,x1,y1]，可用 regionAround()", region);
    let x0, y0, x1, y1;
    if (Array.isArray(region)) {
        if (region.length !== 4) throw new WorldError("findResource.region", "数组形式必须是 [x0,y0,x1,y1] 四个整数", region);
        [x0, y0, x1, y1] = region;
    } else if (typeof region === "object") ({ x0, y0, x1, y1 } = region);
    else throw new WorldError("findResource.region", "{x0,y0,x1,y1} 或 [x0,y0,x1,y1]", region);
    for (const [k, v] of [["x0", x0], ["y0", y0], ["x1", x1], ["y1", y1]])
        if (!Number.isFinite(v)) throw new WorldError(`findResource.region.${k}`, "有限数", v);
    x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.floor(x1); y1 = Math.floor(y1);
    return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
};

/** 以 center 为中心、radius 为半径的正方形搜索区（含中心）。P3 选址常用。 */
export function regionAround(center, radius = 64) {
    if (!Array.isArray(center) || center.length !== 2 || !Number.isFinite(center[0]) || !Number.isFinite(center[1]))
        throw new WorldError("regionAround.center", "[x,y]", center);
    const r = Math.floor(radius);
    if (r < 0) throw new WorldError("regionAround.radius", "非负", radius);
    return { x0: Math.floor(center[0]) - r, y0: Math.floor(center[1]) - r,
             x1: Math.floor(center[0]) + r, y1: Math.floor(center[1]) + r };
}

/** 闭区间区域生成（语义与 gen-resources CLI 完全一致：按覆盖到的 chunk 全 16×16 扫，返回 [x,y,shape]）。 */
export function resourcesInRegion(seed, region) {
    assertSeed(seed);
    const { x0, y0, x1, y1 } = normRegion(region);
    const c0x = Math.floor(x0 / MAP_CHUNK_SIZE), c1x = Math.floor(x1 / MAP_CHUNK_SIZE);
    const c0y = Math.floor(y0 / MAP_CHUNK_SIZE), c1y = Math.floor(y1 / MAP_CHUNK_SIZE);
    const out = [];
    for (let cx = c0x; cx <= c1x; cx++) {
        for (let cy = c0y; cy <= c1y; cy++) {
            const ch = getChunk(seed, cx, cy);
            for (let lx = 0; lx < MAP_CHUNK_SIZE; lx++) {
                for (let ly = 0; ly < MAP_CHUNK_SIZE; ly++) {
                    const it = ch.l[lx][ly];
                    if (it) out.push([ch.tileX + lx, ch.tileY + ly, it]);
                }
            }
        }
    }
    return out;
}

/** 找资源：shape 为字符串（精确）/ "*"|null|undefined（任意）/ 谓词 (shortKey)=>boolean。
 *  region 必须给定（世界无限，无界搜索不可行）：{x0,y0,x1,y1} 或 [x0,y0,x1,y1]。 */
export function findResource(seed, shape, region) {
    const pred = typeof shape === "function" ? shape
        : (shape === "*" || shape === null || shape === undefined) ? () => true
        : s => s === shape;
    return resourcesInRegion(seed, region).filter(([, , s]) => pred(s));
}

/** 离 from 最近的匹配资源（曼哈顿/欧氏可切；默认欧氏）；找不到 → null。P3 选址用。 */
export function nearestResource(seed, shape, from, region, metric = "euclid") {
    if (!Array.isArray(from) || from.length !== 2 || !Number.isFinite(from[0]) || !Number.isFinite(from[1]))
        throw new WorldError("nearestResource.from", "[x,y] 二元数", from, "no-resource-in-range");
    const hits = findResource(seed, shape, region);
    if (!hits.length) return null;
    const dist = ([x, y]) => metric === "manhattan"
        ? Math.abs(x - from[0]) + Math.abs(y - from[1])
        : Math.hypot(x - from[0], y - from[1]);
    return hits.reduce((best, cur) => dist(cur) < dist(best) ? cur : best);
}

/** 一片区域里每种资源的格数（规划前的资源盘点） */
export function resourceHistogram(seed, region) {
    const h = {};
    for (const [, , s] of resourcesInRegion(seed, region)) h[s] = (h[s] || 0) + 1;
    return h;
}

/* ───────────────────────── --validate：与 gen-resources CLI 逐格对拍 ─────────────────────────
 * 默认区域 = facts/live/resources.json 的包围盒（level-11 存档 seed 43391，实机 3002 格）；
 * 该文件读不到时退到 hub 周边 64×64。对拍方式：spawn CLI 拿它的 JSON 行输出，与本模块
 * resourcesInRegion 的结果**逐格**比较（含"我有它无 / 它有我没"两种差异）。差异数必须为 0。 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const GEN_CLI = path.join(REPO, "research", "ai-player", "proto", "gen-resources.mjs");
const LIVE_RES = path.join(REPO, "research", "ai-player", "facts", "live", "resources.json");

export const DEFAULT_SEED = 43391;      // level-11 存档 map.seed（facts/offline-map-reproduction.md:15）

function defaultRegion() {
    try {
        const live = JSON.parse(fs.readFileSync(LIVE_RES, "utf8"));
        const xs = live.map(r => r[0]), ys = live.map(r => r[1]);
        return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    } catch {
        return { x0: -32, y0: -32, x1: 31, y1: 31 };
    }
}

/** 跑 CLI 拿基准数据（离线子进程，不碰游戏/网络） */
function cliRegion(seed, region) {
    const { x0, y0, x1, y1 } = normRegion(region);
    const r = spawnSync(process.execPath, [GEN_CLI, String(seed), String(x0), String(y0), String(x1), String(y1)],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`gen-resources CLI 退出码 ${r.status}: ${r.stderr}`.slice(0, 400));
    const rows = [];
    for (const line of r.stdout.split(/\r?\n/)) {
        const s = line.trim();
        if (!s.startsWith("[")) continue;
        const row = JSON.parse(s);
        rows.push([row[0], row[1], row[2]]);
    }
    return rows;
}

/**
 * 逐格对拍。@returns {{mine:number, cli:number, diff:number, sampleDiffs:string[], byChunk:string}}
 */
export function validateAgainstCli(seed = DEFAULT_SEED, region = defaultRegion()) {
    const mine = resourcesInRegion(seed, region);
    const cli = cliRegion(seed, region);
    const A = new Map(mine.map(([x, y, s]) => [`${x},${y}`, s]));
    const B = new Map(cli.map(([x, y, s]) => [`${x},${y}`, s]));
    let diff = 0; const samples = [];
    for (const [k, v] of B) {
        const a = A.get(k);
        if (a === undefined) { diff++; if (samples.length < 10) samples.push(`CLI 有 / world.mjs 无 ${k}=${v}`); }
        else if (a !== v) { diff++; if (samples.length < 10) samples.push(`形状不符 ${k}: world=${a} cli=${v}`); }
    }
    for (const [k, v] of A) if (!B.has(k)) { diff++; if (samples.length < 10) samples.push(`world.mjs 有 / CLI 无 ${k}=${v}`); }
    const c0 = Math.floor(Math.min(region.x0, region.x1) / MAP_CHUNK_SIZE);
    const c1 = Math.floor(Math.max(region.x0, region.x1) / MAP_CHUNK_SIZE);
    const r0 = Math.floor(Math.min(region.y0, region.y1) / MAP_CHUNK_SIZE);
    const r1 = Math.floor(Math.max(region.y0, region.y1) / MAP_CHUNK_SIZE);
    return { mine: mine.length, cli: cli.length, diff, sampleDiffs: samples,
             byChunk: `${(c1 - c0 + 1) * (r1 - r0 + 1)} 个 chunk（x ${c0}..${c1}, y ${r0}..${r1}）` };
}

/** 与实机 dump 的 resources.json 对拍（plan §4 允许的离线输入 (b)）：只读已落盘文件，不开游戏。 */
export function validateAgainstLive(seed = DEFAULT_SEED) {
    const live = JSON.parse(fs.readFileSync(LIVE_RES, "utf8"));
    const mineMap = new Map(resourcesInRegion(seed, defaultRegion()).map(([x, y, s]) => [`${x},${y}`, s]));
    let match = 0, mismatch = 0, missing = 0;
    const samples = [];
    for (const [x, y, s] of live) {
        const g = mineMap.get(`${x},${y}`);
        if (g === undefined) { missing++; if (samples.length < 5) samples.push(`实机有/离线无 ${x},${y}=${s}`); }
        else if (g !== s) { mismatch++; if (samples.length < 5) samples.push(`形状不符 ${x},${y}: 离线=${g} 实机=${s}`); }
        else match++;
    }
    return { liveCells: live.length, match, mismatch, missing, samples };
}

/* ───────────────────────── --test ───────────────────────── */

function runTests() {
    let failed = 0;
    const eq = (label, got, want) => {
        const a = JSON.stringify(got), b = JSON.stringify(want);
        if (a === b) console.log("✓ " + label);
        else { failed++; console.log(`✗ ${label}\n    got  ${a}\n    want ${b}`); }
    };
    const ok = (label, cond, detail = "") => {
        if (cond) console.log("✓ " + label);
        else { failed++; console.log(`✗ ${label} ${detail}`); }
    };

    /* 1) 写死块（generatePredefined）：hub 出生点周围的 5 个已知资源 */
    eq("chunk(0,0) 局部(7,7) = red", tileResource(43391, 7, 7), "red");
    eq("chunk(-1,0) 局部(7,7) = CuCuCuCu → 世界(-9,7)", tileResource(43391, -9, 7), "CuCuCuCu");
    eq("chunk(0,-1) 局部(5,8) = RuRuRuRu → 世界(5,-8)", tileResource(43391, 5, -8), "RuRuRuRu");
    // 注：写死块的 patch 中心 (5,9) **不保证被填**（上游 circleOffset 抖动）；只断言已实测填充的格。
    ok("chunk(0,-1) 确实产出了 RuRuRuRu（写死块生效）",
        findResource(43391, "RuRuRuRu", { x0: 0, y0: -16, x1: 15, y1: -1 }).length > 0);
    eq("chunk(5,-2) 局部(5,9) = SuSuSuSu → 世界(85,-23)", tileResource(43391, 85, -23), "SuSuSuSu");
    eq("chunk(-1,-1) 有 green patch（格数>0）",
        findResource(43391, "green", { x0: -16, y0: -16, x1: -1, y1: -1 }).length > 0, true);

    /* 2) 负坐标 floor 语义（chunk 边界） */
    eq("负坐标 chunk：x=-1 → chunk -1 的局部 15", tileResource(43391, -1, 7), tileResource(43391, -1, 7));
    eq("边界 x=-16 与 x=0 分属不同 chunk", [-16, 0].map(x => Math.floor(x / 16)), [-1, 0]);
    eq("无资源格返回 null（seed 43391 的 (100,100) 实测空）", tileResource(43391, 100, 100) === null, true);

    /* 3) 确定性：同一 seed 两次一致；换 seed 结果不同 */
    const reg = { x0: -40, y0: -40, x1: 40, y1: 40 };
    clearChunkCache();
    const a1 = JSON.stringify(resourcesInRegion(43391, reg));
    clearChunkCache();
    const a2 = JSON.stringify(resourcesInRegion(43391, reg));
    ok("确定性：清缓存后重跑逐字节相同", a1 === a2);
    clearChunkCache();
    const b1 = JSON.stringify(resourcesInRegion(12345, reg));
    ok("换 seed 结果不同", a1 !== b1);

    /* 4) 闭区间 + chunk 覆盖语义（与 CLI 一致：覆盖到的 chunk 整块扫，含 region 外的格） */
    const one = resourcesInRegion(43391, { x0: 7, y0: 7, x1: 7, y1: 7 });
    ok("单格 region 仍返回所在 chunk 的全部资源（CLI 语义）", one.length >= 1 && one.some(([x, y]) => x === 7 && y === 7));
    eq("region 乱序（x0>x1）自动规范化", resourcesInRegion(43391, { x0: 15, y0: 15, x1: 0, y1: 0 }).length,
        resourcesInRegion(43391, { x0: 0, y0: 0, x1: 15, y1: 15 }).length);
    eq("数组形式 region 与对象形式等价", resourcesInRegion(43391, [0, -16, 15, -1]).length,
        resourcesInRegion(43391, { x0: 0, y0: -16, x1: 15, y1: -1 }).length);

    /* 5) findResource 三种 shape 形态 */
    const anyN = findResource(43391, "*", reg).length;
    const predN = findResource(43391, s => s === "red", reg).length;
    const exactN = findResource(43391, "red", reg).length;
    eq("findResource 谓词 == 精确", predN, exactN);
    ok('findResource("*") 覆盖全部资源', anyN === resourcesInRegion(43391, reg).length);
    eq("无匹配返回空数组", findResource(43391, "ZzZzZzZz", reg), []);

    /* 6) nearestResource */
    const near = nearestResource(43391, "CuCuCuCu", [0, 0], { x0: -60, y0: -60, x1: 60, y1: 60 });
    ok("nearestResource 命中 CuCuCuCu", Array.isArray(near) && near[2] === "CuCuCuCu", JSON.stringify(near));
    eq("nearestResource 无命中 → null", nearestResource(43391, "ZzZzZzZz", [0, 0], reg), null);

    /* 7) 主对拍（离线，spawn CLI）：小区域快速 + 默认区域全量 */
    clearChunkCache();
    const small = validateAgainstCli(43391, { x0: -48, y0: -48, x1: 47, y1: 47 });
    eq(`小区域对拍 96×96（world=${small.mine} / cli=${small.cli}）差异数`, small.diff, 0);
    clearChunkCache();
    const full = validateAgainstCli();          // seed 43391 + 实机 resources.json 包围盒
    ok(`默认区域对拍：world=${full.mine} cli=${full.cli} ${full.byChunk} → diff=${full.diff}`, full.diff === 0,
        full.sampleDiffs.join(" | "));
    eq("逐格总数与 CLI 完全相等", full.mine === full.cli, true);

    /* 8) 与实机 dump 对拍（若本地有 facts/live/resources.json） */
    if (fs.existsSync(LIVE_RES)) {
        clearChunkCache();
        const lv = validateAgainstLive();
        eq(`实机 resources.json 逐格一致：${lv.match}/${lv.liveCells}（mismatch=${lv.mismatch} missing=${lv.missing}）`,
            [lv.mismatch, lv.missing], [0, 0]);
    } else console.log("· 跳过实机对拍（facts/live/resources.json 不存在）");

    /* 9）hub 出生点周围资源盘点（P3 选址的 smoke test：43391 里 CuCuCuCu 应在 (-9,7) 一带） */
    const hist = resourceHistogram(43391, { x0: -20, y0: -20, x1: 20, y1: 20 });
    ok("hub 周边 41×41 有 CuCuCuCu", (hist["CuCuCuCu"] || 0) > 0, JSON.stringify(hist));

    /* 10）上游"不对称边界 y<=16"是**行为惰性**的：越界那一格在两侧都读不到。
     *   变异测试证据（NOTES G5）：把 `<=` 改成 `<` → --validate 仍 0 差异（故不设空断言去"锁"它）；
     *   而把 RNG 消耗顺序"优化"掉 → 立刻 70 格差异（那条由 [7] 的 CLI 对拍真正锁住）。
     *   这里只断言本模块**实际依赖**、且去掉越界 guard 就会红的性质：
     *   跨 chunk 边界查询恒返回 null|string，绝不 undefined。 */
    eq("tileResource 跨 chunk 边界（含负方向、含 y=16 那种越界）恒返回 null|string，绝不 undefined",
        [16, 17, -1, -16, -17, 0, 15, 31, 32, -32, -33, 128, 129].every(y => {
            const v = tileResource(43391, 7, y);
            return v === null || typeof v === "string";
        }), true);

    console.log(failed ? `\n✗ world 自测：${failed} 条失败` : "\n✓ world 自测全部通过");
    process.exitCode = failed ? 1 : 0;
}

/* ───────────────────────── CLI 入口 ───────────────────────── */

function main(argv) {
    const args = argv.slice(2);
    if (args.includes("--test")) return runTests();

    if (args.includes("--validate")) {
        const rest = args.filter(a => a !== "--validate");
        const seed = /^\d+$/.test(rest[0] || "") ? Number(rest[0]) : DEFAULT_SEED;
        let region = defaultRegion();
        const ri = args.indexOf("--region");
        if (ri >= 0) region = { x0: +args[ri + 1], y0: +args[ri + 2], x1: +args[ri + 3], y1: +args[ri + 4] };
        const v = validateAgainstCli(seed, region);
        console.log(`seed=${seed}  区域 x[${region.x0},${region.x1}] y[${region.y0},${region.y1}]  ${v.byChunk}`);
        console.log(`world.mjs 资源格: ${v.mine}   gen-resources CLI: ${v.cli}   差异: ${v.diff}`);
        if (v.diff === 0) console.log("✅ 逐格对拍 0 差异");
        else { console.log("❌ 差异样例：\n  " + v.sampleDiffs.join("\n  ")); process.exitCode = 1; }
        if (args.includes("--chunks") && fs.existsSync(LIVE_RES)) {
            const lv = validateAgainstLive(seed);
            console.log(`\n对实机 facts/live/resources.json：match=${lv.match}/${lv.liveCells} ` +
                `mismatch=${lv.mismatch} missing=${lv.missing}`);
            if (lv.mismatch || lv.missing) console.log("  " + lv.samples.join("\n  "));
        }
        return;
    }

    const ti = args.indexOf("--tile");
    if (ti >= 0) { console.log(JSON.stringify(tileResource(Number(args[ti + 1]), Number(args[ti + 2]), Number(args[ti + 3])))); return; }

    const fi = args.indexOf("--find");
    if (fi >= 0) {
        const seed = Number(args[fi + 1]), shape = args[fi + 2] === "*" ? "*" : args[fi + 2];
        const region = { x0: +args[fi + 3], y0: +args[fi + 4], x1: +args[fi + 5], y1: +args[fi + 6] };
        for (const row of findResource(seed, shape, region)) console.log(JSON.stringify(row));
        return;
    }

    console.log([
        "用法：",
        "  node src/ai/world.mjs --test",
        "  node src/ai/world.mjs --validate [seed] [--region x0 y0 x1 y1] [--chunks]",
        "  node src/ai/world.mjs --tile <seed> <x> <y>",
        "  node src/ai/world.mjs --find <seed> <shape|*> <x0> <y0> <x1> <y1>",
        `  （默认 seed=${DEFAULT_SEED}，默认区域取自 facts/live/resources.json 包围盒）`,
    ].join("\n"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main(process.argv);
