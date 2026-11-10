/**
 * processor_on_stream.test.mjs — 「机器在不在**这条流**上」的判据（`semantic.mjs#processorOnStream`）。
 *
 * ## 为什么要单独测
 *
 * 2026-10-31 实机三次（半成品世界，44 实体方案砍掉 cutter 产品侧到 hub 的 3 格带子）都报：
 *
 *     PROCESSOR_REQUIRED [L4/warn]
 *     ... the factory has 1 cutter(s) but none of them is on this stream
 *
 * 而 `cutter@(4,-17)` **就在这条流上** —— 它的输入来自 `(4,-16)` 的带子。
 * 模型被这句话带偏，三轮都在试「再放一台 cutter」（`replace_run` 两次失败），
 * 一次都没想过补那 3 格带子 —— 而 `DEAD_END` 指的就是那个断点。
 *
 * 根因**不是**「跨过 balancer 就看不见」（那份机制说明只对了一半）：
 * 真正的前提是 `buildStreams` 把 balancer 当**边界**，于是同一条货流被切成
 * 「矿机 → balancer」与「balancer → …→ cutter」两段。
 * 实测（`test/fixtures/saves/half-L4-obs.json`，42 实体）：
 *
 *     流头(2,-7) belts=1 end=balancer → processorOnStream=false   ← 旧判据把它报成「缺 cutter」
 *     流头(3,-7) belts=1 end=balancer → false
 *     流头(4,-7) belts=3 end=balancer → false
 *     流头(2,-9) belts=2 end=balancer → false
 *     流头(3,-11) belts=7 end=cutter  → true                      ← 只有这一段看见 cutter
 *
 * 所以修法是：从流的**终点**继续往下游走，遇到透传节点（`passthrough`，即 balancer）
 * 枚举**全部**输出槽，看能否走到一台 `kind`。判据仍然是**物理连通**。
 *
 * ## 四条验收（后两条是防「放宽过头」的负例）
 *
 *   A 正  cutter 直接接在流上 ⇒ true（原有行为不能坏）
 *   B 正  cutter 在流下游、中间隔 balancer ⇒ **必须 true**（这次要修的）
 *   C 负  cutter 在世界上但**完全不在**这条流上 ⇒ **必须 false**（放宽过头 = 把诊断删了）
 *   D 负  流下游是一台**别的**机器（stacker，不是 cutter）⇒ false
 *
 * 夹具全部用**真观测**（`test/fixtures/saves/L4-obs.json`，181 实体、7 台 balancer），
 * 不手算坐标 —— 坐标手抄会掩盖「判据看的不是真实几何」这类错。
 *
 * 运行：`node --test src/agent/loop/processor_on_stream.test.mjs`
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { processorOnStream } from "./semantic.mjs";
import { indexOf, at, isBelt, exitCellOf, exitDirOf, entryCellOf, accepts, runEnd } from "./topology.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVES = path.resolve(HERE, "../../../test/fixtures/saves");
const L4 = JSON.parse(fs.readFileSync(path.join(SAVES, "L4-obs.json"), "utf8")).result;

/* ★ 半成品世界：原来读的是 `.tmpverify/final-half/probe-obs.json` ★
 *
 * 那份是**未跟踪**的临时产物（实机一次 obs 的快照），2026-11-10 清理 scratch 时
 * 被误删，无法恢复。它的受跟踪副本一直是 `test/fixtures/saves/half-L4-obs.json`
 * —— 同样是 42 实体、`cutter@(4,-17)`、balancer 在 (2,-8)/(3,-10)，几何完全一致。
 *
 * 教训：测试夹具**不许依赖 .tmpverify/**。那里是实验装置目录，随时会被清掉；
 * 需要长期使用的实测快照必须搬进 `test/fixtures/` 并提交。 */
const HALF_L4 = JSON.parse(fs.readFileSync(path.join(SAVES, "half-L4-obs.json"), "utf8")).obs;

const clone = x => JSON.parse(JSON.stringify(x));

/* `buildStreams` / `isStreamHead` 没有导出（它们是 semantic.mjs 的内部件），
   这里**逐字复制**并与 `processorOnStream` 一起用 —— 复制的是「流怎么切」，
   被验收的判据本身仍然来自真实导出。 */
const sameCell = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];

function isStreamHead(idx, b) {
    const up = at(idx, entryCellOf(b));
    if (!up || !isBelt(up)) return true;
    return !(sameCell(exitCellOf(up), [b.x, b.y]) && accepts(idx, [b.x, b.y], exitDirOf(up)).ok);
}

function buildStreams(idx) {
    const heads = idx.ent.filter(b => isBelt(b) && isStreamHead(idx, b))
        .sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.uid - b.uid));
    const streams = [];
    for (const h of heads) {
        const list = [];
        const seen = new Set();
        let cur = h;
        let end = null;
        while (cur && !seen.has(cur.uid)) {
            seen.add(cur.uid);
            list.push(cur);
            const c = exitCellOf(cur);
            const d = exitDirOf(cur);
            const e = at(idx, c);
            if (!e) { end = { kind: "empty", by: null, accepted: false }; break; }
            if (isBelt(e)) {
                if (!accepts(idx, c, d).ok) { end = { kind: "belt", by: e.uid, accepted: false }; break; }
                cur = e;
                continue;
            }
            end = { kind: e.type, by: e.uid, accepted: accepts(idx, c, d).ok };
            break;
        }
        if (!end) end = { kind: "cycle", by: null, accepted: false };
        streams.push({ head: h, belts: list, end });
    }
    return streams;
}

/** 某个实体所在的流（按「它的输入带」反查）。 */
const streamFeeding = (streams, feederUid) =>
    streams.find(s => s.belts.some(b => b.uid === feederUid)) || null;
const streamEndingAt = (streams, endUid) =>
    streams.find(s => s.end && s.end.by === endUid) || null;

/** 拿到某个格上的实体（夹具里按坐标找，坐标来自真实 obs）。 */
const entAt = (obs, x, y) => {
    const e = obs.entities.find(en => en.x === x && en.y === y && en.type !== "hub");
    assert.ok(e, `夹具前提：(${x},${y}) 上没有实体`);
    return e;
};

/** 把一个已存在的实体改类型（反例 D 要「下游是别的机器」）。 */
function retype(obs, uid, type, code) {
    const e = obs.entities.find(en => en.uid === uid);
    assert.ok(e, `夹具前提：uid ${uid} 不存在`);
    e.type = type;
    e.code = code;
    return obs;
}

/** 夹具自检：L4 里确实有「流停在 balancer、而 balancer 下游还有带子」的形状，否则 B 组就是空测。 */
test("夹具自检：L4 的 balancer 真的把货流切成两段（有流停在 balancer 上）", () => {
    const idx = indexOf(L4);
    const streams = buildStreams(idx);
    const bal = at(idx, [4, -16]);
    assert.equal(bal && bal.type, "balancer", "(4,-16) 应当是 balancer");
    const fromBal = streams.filter(s => s.end && s.end.by === bal.uid);
    assert.ok(fromBal.length >= 1, "必须至少有流停在 balancer (4,-16) 上（否则 B 组无意义）");
    assert.ok(fromBal.some(s => s.end.accepted === true),
        "其中至少一条是**真的喂进** balancer 的（accepted=true），不是撞在它侧面上");
});

/* ══════════════════════════════════════════════════════════════════════════
 * A 正例：cutter 直接接在流上 ⇒ true
 * ══════════════════════════════════════════════════════════════════════════ */

test("A 正例：cutter 直接由流内带子喂 ⇒ processorOnStream=true", () => {
    const idx = indexOf(L4);
    const streams = buildStreams(idx);
    const cutter = entAt(L4, -8, -11);
    assert.equal(cutter.type, "cutter");
    /* 停在 cutter 上的那条流（旧判据的第一分支：end.kind === kind） */
    const st = streamEndingAt(streams, cutter.uid);
    assert.ok(st, "夹具前提：有一条流以这台 cutter 为终点");
    assert.equal(processorOnStream(idx, st, "cutter"), true, "流的终点就是 cutter ⇒ 在流上");

    /* 再验第二条分支：cutter 由**流内**带子直接喂（流本身没到 cutter 上）。
       取 cutter 的输入带所在流，但把 end 换成空 —— 只剩「输入槽由流内带子喂」这条路。 */
    const s = L4.entities.find(e => e.type === "belt" && e.x === -8 && e.y === -10);
    if (s) {
        const st2 = streamFeeding(streams, s.uid);
        assert.ok(st2, "夹具前提：cutter 的输入带属于某条流");
        assert.equal(processorOnStream(idx, { ...st2, end: { kind: "empty", by: null, accepted: false } },
            "cutter"), true, "输入槽由流内带子喂 ⇒ 在流上（与 end 无关）");
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * B 正例（这次的修复）：cutter 在流下游、中间隔 balancer ⇒ 必须 true
 * ══════════════════════════════════════════════════════════════════════════ */

test("B 正例 ★ 半成品世界的病灶：流停在 balancer，cutter 在它下游 ⇒ true", () => {
    /* 直接用**实机复现的那份 obs**（半成品世界：cutter@(4,-17)，输入来自 (4,-16)）。 */
    const obs = HALF_L4;
    const idx = indexOf(obs);
    const streams = buildStreams(idx);
    const cutter = obs.entities.find(e => e.type === "cutter");
    assert.deepEqual([cutter.x, cutter.y], [4, -17], "夹具前提：cutter 在 (4,-17)");

    /* 四条矿机侧的流，全部停在 balancer —— 旧判据对它们一律返回 false（这就是误报）。 */
    const heads = [[2, -7], [3, -7], [4, -7], [2, -9]];
    for (const [x, y] of heads) {
        const st = streams.find(s => s.head.x === x && s.head.y === y);
        assert.ok(st, `夹具前提：流头 (${x},${y}) 存在`);
        assert.equal(st.end.kind, "balancer", `(${x},${y}) 的流停在 balancer 上`);
        assert.equal(processorOnStream(idx, st, "cutter"), true,
            `(${x},${y}) 的货经 balancer 最终进 cutter(4,-17) ⇒ 必须判「在流上」。`
            + "修复前这里是 false，正是 live 三次的误报。");
    }
});

test("B2 正例：balancer 的**两个**输出槽都要跟（只跟 primary 会漏）", () => {
    /* L4 的 balancer (4,-16)（uid 10085）：
         primary   (4,-17) → 有带子 → 10084 → 10083 → hub（这条链上**没有** cutter）
         secondary (5,-17) → 空格
       现在往 secondary 上真的铺一条链到一台新 cutter。
       只跟 primary 的实现会返回 false（它顺着 hub 方向走完了），
       跟全部输出槽的实现必须返回 true —— 这是这条判据唯一和「随便看看」区分开的证据。 */
    const w = clone(L4);
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    const belt = (x, y) => {
        w.entities.push({ uid: next++, type: "belt", x, y, r: 0, variant: "default", rotation_variant: 0, code: 1, layer: "regular" });
    };
    belt(5, -17);
    belt(5, -18);
    belt(5, -19);
    w.entities.push({ uid: next++, type: "cutter", x: 5, y: -20, r: 0, variant: "default", rotation_variant: 0, code: 9, layer: "regular" });

    const idx = indexOf(w);
    const streams = buildStreams(idx);
    const st = streams.find(s => s.end && s.end.by === 10085 && s.end.accepted);
    assert.ok(st, "夹具前提：有流喂进 balancer (4,-16)");

    /* 自检：primary 那一路确实到不了 cutter（否则这个用例什么也没证明）。 */
    const primaryEnd = runEnd(idx, [4, -17], "top");
    assert.ok(!(primaryEnd.kind === "cutter"), "自检：primary 那一路的终点不是 cutter");
    assert.equal(processorOnStream(idx, st, "cutter"), true,
        "cutter 只接在 secondary 上 ⇒ 必须 true（只跟 primary 的实现会错判成 false）");
});

/* ══════════════════════════════════════════════════════════════════════════
 * C 反例（关键）：cutter 在世界上，但完全不在**这条**流上 ⇒ false
 * ══════════════════════════════════════════════════════════════════════════ */

test("C 反例 ★ 独立的另一条产线上的 cutter ⇒ false（放宽过头 = 把诊断删了）", () => {
    const obs = HALF_L4;
    const idx = indexOf(obs);
    const streams = buildStreams(idx);

    /* 流头 (5,-18)：从 (5,-19) 绕一大圈沿 x=1 往南走，终点是空格。
       它**不经过任何 balancer**，与 cutter(4,-17) 毫无关系 —— 世界里有 cutter，但不在它下游。 */
    const st = streams.find(s => s.head.x === 5 && s.head.y === -18);
    assert.ok(st, "夹具前提：流头 (5,-18) 存在");
    assert.notEqual(st.end.kind, "balancer", "这条流不经过 balancer（否则不算反例）");
    assert.equal(processorOnStream(idx, st, "cutter"), false,
        "世界里有 cutter，但它不在 (5,-18) 这条流的连通下游 ⇒ 必须是 false");

    /* 更强的反例：L4 上把 balancer 全部换成 dead end 后，cutter 仍是世界上唯一的 cutter，
       但它只接在 (-8,-11) 那一段 —— 从 (2,-8) 的矿机流出发（物理上到不了 cutter）。 */
    const L4idx = indexOf(L4);
    const L4streams = buildStreams(L4idx);
    const minerStream = L4streams.find(s => s.head.x === 2 && s.head.y === -9);
    if (minerStream) {
        const r = processorOnStream(L4idx, minerStream, "cutter");
        /* 这条流的那个 balancer 是否通往 cutter 由真实几何决定；不做硬断言，
           只断言它**不心虚地返回 true**：如果返回 true，必须真的能从 balancer 走到 cutter。 */
        if (r) {
            assert.ok(streamLeadsToCutter(L4idx, minerStream),
                "返回 true 就必须有物理通路（不许凭「世界上有 cutter」返回 true）");
        }
    }
    void at;
});

/** 独立佐证：沿透传节点走，真的到得了 cutter（用于上面「返回 true 必须有通路」的断言）。 */
function streamLeadsToCutter(idx, st) {
    const end = st.end;
    if (!end || !Number.isInteger(end.by)) return false;
    const start = idx.byUid.get(end.by);
    if (!start || start.type !== "balancer") return false;
    const seen = new Set();
    const queue = [start];
    while (queue.length) {
        const n = queue.shift();
        if (!n || seen.has(n.uid)) continue;
        seen.add(n.uid);
        /* balancer 2×1，两个输出槽都在本地 top（rotation 0 时朝上） */
        for (const [dx, dy] of [[0, -1], [1, -1]]) {
            const e = at(idx, [n.x + dx, n.y + dy]);
            if (!e) continue;
            if (e.type === "cutter") return true;
            if (e.type === "balancer") queue.push(e);
        }
    }
    return false;
}

/* ══════════════════════════════════════════════════════════════════════════
 * D 反例：流下游有机器，但**不是** kind ⇒ false
 * ══════════════════════════════════════════════════════════════════════════ */

test("D 反例：流下游是一台 stacker（不是 cutter）⇒ false", () => {
    /* 半成品世界原样：先确认「下游是 cutter」时为 true。 */
    const obs = HALF_L4;
    const cutter = obs.entities.find(e => e.type === "cutter");
    assert.deepEqual([cutter.x, cutter.y], [4, -17]);

    /* 把那台 cutter 改成 stacker：几何/位置/连通性全部不变，只有类型变了。
       判据若正确，「cutter 在不在流上」必须立刻变 false —— 否则它看的不是类型，
       而是「下游有没有*某台*机器」。 */
    const mutated = clone(obs);
    const m = mutated.entities.find(e => e.uid === cutter.uid);
    m.type = "stacker";
    const idx = indexOf(mutated);
    const streams = buildStreams(idx);
    const st = streams.find(s => s.head.x === 4 && s.head.y === -7);
    assert.ok(st, "夹具前提：流头 (4,-7) 存在");
    assert.equal(processorOnStream(idx, st, "cutter"), false,
        "同一位置换成 stacker 之后，这条流上就没有 cutter 了 ⇒ false");
    assert.equal(processorOnStream(idx, st, "stacker"), true,
        "对照：问 stacker 时答案必须是 true（证明 false 不是因为流断了）");
});

test("D2 反例：整条下游链断在空格上 ⇒ false（不许把「断头」当「在流上」）", () => {
    const obs = HALF_L4;
    /* 删掉 (3,-11) 那一格带子：balancer (3,-10) 一路到 cutter 的通路断在这里。 */
    const cut = clone(obs);
    cut.entities = cut.entities.filter(e => !(e.type === "belt" && e.x === 3 && e.y === -11));
    const idx = indexOf(cut);
    const streams = buildStreams(idx);
    const st = streams.find(s => s.head.x === 4 && s.head.y === -7);
    assert.ok(st, "夹具前提：流头 (4,-7) 仍存在（断的是它下游的下游）");
    assert.equal(processorOnStream(idx, st, "cutter"), false,
        "货流在 (3,-11) 断了 ⇒ 到不了 cutter ⇒ false（这时该报的是 DEAD_END）");
});
