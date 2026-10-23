/**
 * gen-resources.mjs — 离线复现 shapez 1.5.6 的资源图（由 map.seed 确定性生成）。
 *
 * 算法来源（逐行对照）：
 *   recon/upstream-full/src/js/game/map_chunk.js   (generateLowerLayer / generatePatches / internalGenerate*)
 *   recon/upstream-full/src/js/core/rng.js         (ALEA)
 *   recon/upstream-full/src/js/core/config.js:72   (mapChunkSize = 16)
 *
 * 用法：
 *   node research/ai-player/proto/gen-resources.mjs <seed> [x0 y0 x1 y1]
 *   node research/ai-player/proto/gen-resources.mjs 43391 --validate   # 与 facts/live/resources.json 对拍
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAP_CHUNK_SIZE = 16;

// ───────────────────────── ALEA RNG（对照 recon/upstream-full/src/js/core/rng.js） ─────────────────────────

function Mash() {
    let n = 0xefc8249d;
    return function (data) {
        data = data.toString();
        for (let i = 0; i < data.length; i++) {
            n += data.charCodeAt(i);
            let h = 0.02519603282416938 * n;
            n = h >>> 0;
            h -= n;
            h *= n;
            n = h >>> 0;
            h -= n;
            n += h * 0x100000000;
        }
        return (n >>> 0) * 2.3283064365386963e-10;
    };
}

function makeNewRng(seed) {
    let c = 1;
    const mash = Mash();
    let s0 = mash(" ");
    let s1 = mash(" ");
    let s2 = mash(" ");
    s0 -= mash(seed); if (s0 < 0) s0 += 1;
    s1 -= mash(seed); if (s1 < 0) s1 += 1;
    s2 -= mash(seed); if (s2 < 0) s2 += 1;
    return function () {
        const t = 2091639 * s0 + c * 2.3283064365386963e-10;
        s0 = s1;
        s1 = s2;
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

// ───────────────────────── 形状编码（对照 shape_definition.js / colors.js） ─────────────────────────

const SHORT_OF_SUBSHAPE = { rect: "R", circle: "C", star: "S", windmill: "W" };

// ───────────────────────── chunk 生成（对照 map_chunk.js） ─────────────────────────

class Chunk {
    constructor(seed, x, y) {
        this.x = x; this.y = y;
        this.tileX = x * MAP_CHUNK_SIZE; this.tileY = y * MAP_CHUNK_SIZE;
        this.lower = Array.from({ length: MAP_CHUNK_SIZE }, () => new Array(MAP_CHUNK_SIZE).fill(null));
        this.generate(seed);
    }

    generate(seed) {
        const rng = new RNG(this.x + "|" + this.y + "|" + seed);   // ← 种子拼接：与源码完全一致
        if (this.generatePredefined(rng)) return;

        const cx = this.x + 0.5, cy = this.y + 0.5;
        const d = Math.round(Math.hypot(cx, cy));                  // distanceToOriginInChunks

        // color patch: chance = 0.9 - clamp(d/25,0,1)*0.5; if rng.next() < chance/4
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

    generatePredefined(rng) {
        if (this.x === 0 && this.y === 0) { this.patch(rng, 2, "red", 7, 7); return true; }
        if (this.x === -1 && this.y === 0) { this.patch(rng, 2, "CuCuCuCu", MAP_CHUNK_SIZE - 9, 7); return true; }
        if (this.x === 0 && this.y === -1) { this.patch(rng, 2, "RuRuRuRu", 5, MAP_CHUNK_SIZE - 7); return true; }
        if (this.x === -1 && this.y === -1) { this.patch(rng, 2, "green"); return true; }
        if (this.x === 5 && this.y === -2) { this.patch(rng, 2, "SuSuSuSu", 5, MAP_CHUNK_SIZE - 7); return true; }
        return false;
    }

    /** 对照 internalGeneratePatch：注意 RNG 消耗顺序（先 patchX/patchY，即使会被 override 覆盖） */
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
                    // 注意：源码的边界判断是不对称的（x < size, y <= size）——原样复刻
                    if (x >= 0 && x < MAP_CHUNK_SIZE && y >= 0 && y <= MAP_CHUNK_SIZE) {
                        const odx = dx / circleScaleX;
                        const ody = dy / circleScaleY;
                        if (odx * odx + ody * ody <= circleRadiusSquare) {
                            if (!this.lower[x][y]) this.lower[x][y] = item;
                        }
                    }
                }
            }
        }
    }

    generateColorPatch(rng, size, d) {
        const avail = ["red", "green"];
        if (d > 2) avail.push("blue");
        const color = rng.choice(avail);      // ← choice 先于 patch 消耗 RNG（实参求值顺序）
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
            subShapes = [pickSubShape(rng, weights), pickSubShape(rng, weights), pickSubShape(rng, weights), pickSubShape(rng, weights)];
        }

        let windmillCount = 0;
        for (const s of subShapes) if (s === "windmill") ++windmillCount;
        if (windmillCount > 1) { subShapes[0] = "rect"; subShapes[1] = "rect"; }

        // getDefinitionFromSimpleShapes: 4 quadrant 顺序 = TR,BR,BL,TL，颜色 uncolored ('u')
        this.patch(rng, size, subShapes.map(s => SHORT_OF_SUBSHAPE[s] + "u").join(""));
    }
}

function pickSubShape(rng, weights) {
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    const chosenNumber = rng.nextIntRange(0, sum - 1);
    let accumulated = 0;
    for (const key in weights) {                       // 插入顺序 rect,circle,star,windmill
        if (accumulated + weights[key] > chosenNumber) return key;
        accumulated += weights[key];
    }
    return "circle";
}

// ───────────────────────── 世界索引 ─────────────────────────

function generateWorld(seed, x0, y0, x1, y1) {
    const c0x = Math.floor(x0 / MAP_CHUNK_SIZE), c1x = Math.floor(x1 / MAP_CHUNK_SIZE);
    const c0y = Math.floor(y0 / MAP_CHUNK_SIZE), c1y = Math.floor(y1 / MAP_CHUNK_SIZE);
    const out = [];                                    // [x, y, shape]
    for (let cx = c0x; cx <= c1x; cx++) {
        for (let cy = c0y; cy <= c1y; cy++) {
            const ch = new Chunk(seed, cx, cy);
            for (let lx = 0; lx < MAP_CHUNK_SIZE; lx++) {
                for (let ly = 0; ly < MAP_CHUNK_SIZE; ly++) {
                    const it = ch.lower[lx][ly];
                    if (it) out.push([ch.tileX + lx, ch.tileY + ly, it]);
                }
            }
        }
    }
    return out;
}

// ───────────────────────── CLI ─────────────────────────

const args = process.argv.slice(2);
const seed = args[0] || "43391";

if (args.includes("--validate")) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const livePath = path.join(here, "..", "facts", "live", "resources.json");
    const live = JSON.parse(fs.readFileSync(livePath, "utf8"));
    const liveMap = new Map(live.map(([x, y, s]) => [`${x},${y}`, s]));
    const xs = live.map(r => r[0]), ys = live.map(r => r[1]);
    const gen = generateWorld(seed, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    const genMap = new Map(gen.map(([x, y, s]) => [`${x},${y}`, s]));

    let match = 0, mismatchShape = 0, liveOnly = 0, genOnly = 0;
    const liveChunks = new Map();   // chunk -> {match, miss}
    const mc = (x, y) => `${Math.floor(x / 16)},${Math.floor(y / 16)}`;
    for (const [k, v] of liveMap) {
        const g = genMap.get(k);
        const ck = mc(...k.split(",").map(Number));
        if (!liveChunks.has(ck)) liveChunks.set(ck, { match: 0, miss: 0 });
        if (g === undefined) { liveOnly++; liveChunks.get(ck).miss++; }
        else if (g === v) { match++; liveChunks.get(ck).match++; }
        else { mismatchShape++; liveChunks.get(ck).miss++; }
    }
    for (const k of genMap.keys()) if (!liveMap.has(k)) genOnly++;

    console.log(`seed=${seed}  区域: x[${Math.min(...xs)},${Math.max(...xs)}] y[${Math.min(...ys)},${Math.max(...ys)}]`);
    console.log(`live 资源格: ${liveMap.size}   离线生成: ${genMap.size}`);
    console.log(`✅ 完全一致: ${match}`);
    console.log(`❌ 形状不符: ${mismatchShape}`);
    console.log(`❌ live 有/离线无: ${liveOnly}`);
    console.log(`⚠️  离线有/live 无: ${genOnly}  （可能是未探索 chunk）`);

    const chunks = [...liveChunks.entries()];
    const perfect = chunks.filter(([, v]) => v.miss === 0).length;
    console.log(`\nchunk 级: ${perfect}/${chunks.length} 个 chunk 逐格完全一致`);
    const bad = chunks.filter(([, v]) => v.miss > 0).sort((a, b) => b[1].miss - a[1].miss).slice(0, 10);
    if (bad.length) {
        console.log(`不匹配 chunk（按缺失格数排序，前 10）:`);
        for (const [ck, v] of bad) console.log(`  chunk(${ck})  match=${v.match} miss=${v.miss}`);
    }
} else if (args.length >= 5) {
    const [x0, y0, x1, y1] = args.slice(1, 5).map(Number);
    const out = generateWorld(seed, x0, y0, x1, y1);
    for (const r of out) console.log(JSON.stringify(r));
} else {
    console.log(`用法: node gen-resources.mjs <seed> [x0 y0 x1 y1] | <seed> --validate`);
}
