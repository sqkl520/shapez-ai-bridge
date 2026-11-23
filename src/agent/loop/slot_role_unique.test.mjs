/**
 * slot_role_unique.test.mjs —— 端口角色必须能指名到**具体哪一个槽**
 *
 * ## 为什么需要它（2026-11-23，三臂真调 LLM 实验抓到）
 *
 * `handles.mjs` 的 `slotRoleAt` 原来是 `list.find(sl => sl.dir === facingDir)` ——
 * 只看方向、取第一个匹配。而 stacker 的两个输入槽 **`dir` 都是 `"bottom"`**：
 *
 *     stacker#14684  inputs = [
 *       { role:"lower", dir:"bottom", cell:[-2,6] },
 *       { role:"upper", dir:"bottom", cell:[-1,6] },
 *     ]
 *
 * 于是任何从下方进料的带子都被标成 `下游=C4.lower`。实测（L12 真机快照）：
 *
 *     B90  下游=C4.lower 货=259   ← 实际接的是 **upper**
 *     B133 下游=C4.lower 货=0     ← 这个才真是 lower
 *
 * ## 后果不是渲染难看，是模型据此推错方向
 *
 * 同一份 prompt 里：
 *   · `MACHINE_STARVED` 说「stacker#14684 缺 [-2,6]」（那是 lower 的 approach 格）
 *   · BELTS 段说 B90 与 B133 **都**是 `下游=C4.lower`
 *
 * 模型读到「lower 已有两个来路」⇒「缺的必然是另一路」⇒ 去 `connect` 到 `upper`
 * ⇒ 撞 `target_already_fed`。
 *
 * 真调 LLM 实测（`.findings/VERIFY-WORLD-FROZEN-2026-11-23.md`）：
 * A/C 两臂合计 14 个 `connect`，**13 个目标是 `C4.upper`**，全部落空。
 *
 * ## 三条验收
 *
 * 1. stacker 的两路必须**分得开**（`lower` 与 `upper`，不能都叫 `lower`）
 * 2. hub 的 16 个同 name 入口必须**带索引**（`primary[N]`），否则 5 条不同的带子
 *    看起来接同一个口
 * 3. **不许有重复** —— 全表扫一遍，`下游=<机器>.<角色>` 每一个都唯一
 *
 * 第 3 条是这次的核心。实测修前 79 个快照**全部**命中、515 处重复；
 * 修后同一份快照 0 处。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildHandles } from "./handles.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.resolve(HERE, "../../../research/ai-plan/runs");

function loadRun(id) {
    const b = path.join(RUNS, id) + path.sep;
    const r = (f) => JSON.parse(fs.readFileSync(b + f, "utf8"));
    return { obs: r("obs-last.json"), items: r("items-last.json") };
}

const RUN = "r-20261123151728-52a3";

test("★ stacker 的两路进料必须分得开（lower vs upper）", () => {
    const { obs, items } = loadRun(RUN);
    const h = buildHandles(obs.result || obs, items.result || items);
    const b90 = h.byHandle.get("B90");
    const b133 = h.byHandle.get("B133");
    assert.ok(b90, "B90 必须在句柄表里");
    assert.ok(b133, "B133 必须在句柄表里");

    const roleOf = (e) => {
        const m = /下游=C4\.([a-z]+)/.exec(e.desc || "");
        return m ? m[1] : null;
    };
    const r90 = roleOf(b90);
    const r133 = roleOf(b133);
    assert.equal(r90, "upper", `B90 接的是 stacker 的 upper 槽，实得 ${r90}（desc: ${b90.desc}）`);
    assert.equal(r133, "lower", `B133 接的是 stacker 的 lower 槽，实得 ${r133}（desc: ${b133.desc}）`);
    assert.notEqual(r90, r133, "两路不能同名 —— 同名会让模型推错方向");
});

test("★ hub 的同名入口必须带索引", () => {
    const { obs, items } = loadRun(RUN);
    const h = buildHandles(obs.result || obs, items.result || items);
    /* hub 的 16 个入口全叫 `primary`，其中 `primary@top` 就有 4 个。
     * 只渲染 `H1.primary` 的话，多条不同的带子看起来接同一个口。 */
    const hubBelts = [...h.byHandle.values()]
        .filter(e => /下游=H1\./.test(e.desc || ""));
    assert.ok(hubBelts.length >= 2, `前提：至少 2 条带子进 hub，实得 ${hubBelts.length}`);
    for (const e of hubBelts) {
        assert.match(e.desc, /下游=H1\.primary\[\d+\]/,
            `hub 入口必须带索引，实得：${e.desc}`);
    }
});

test("★ 回归：全表 `下游=<机器>.<角色>` 不许有重复", () => {
    const { obs, items } = loadRun(RUN);
    const h = buildHandles(obs.result || obs, items.result || items);
    const seen = new Map();
    for (const [, e] of h.byHandle) {
        if (!e.desc) continue;
        const m = /下游=([A-Z]+\d+)\.([a-z]+(?:\[\d+\])?)/.exec(e.desc);
        if (!m) continue;
        const k = `${m[1]}.${m[2]}`;
        if (!seen.has(k)) seen.set(k, []);
        seen.get(k).push(e.handle);
    }
    const dups = [...seen].filter(([, v]) => v.length > 1);
    assert.equal(dups.length, 0,
        `这些 (机器.角色) 被多条带子共用，模型无法指名：`
        + JSON.stringify(dups.slice(0, 5).map(([k, v]) => [k, v])));
});

test("★ 单槽机器保持原样：不加多余索引", () => {
    /* 只有**确实重名**时才加后缀。单槽（如 cutter 的 primary 输入）
     * 必须保持 `primary`，不能变成 `primary[0]` ——
     * 那会让已经冻结的渲染文本漂移，而漂移本身是回归。 */
    const { obs, items } = loadRun(RUN);
    const h = buildHandles(obs.result || obs, items.result || items);
    const withIdx = [...h.byHandle.values()]
        .filter(e => /下游=[A-Z]+\d+\.[a-z]+\[\d+\]/.test(e.desc || ""));
    /* 带索引的应该只出现在真重名处（hub），不应该是全部 */
    const all = [...h.byHandle.values()].filter(e => /下游=[A-Z]+\d+\./.test(e.desc || ""));
    assert.ok(withIdx.length < all.length,
        `带索引的 ${withIdx.length} 条不应等于全部 ${all.length} 条 —— 单槽机器被误加了索引`);
});
