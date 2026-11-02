/**
 * prompt_rules.test.mjs — SYSTEM_PROMPT 的**规则编号与内容**守门测试。
 *
 * 这三条断言各自守一个已经发生过（或差点发生）的错误：
 *
 *   A. **编号连续 1..N，无跳跃、无重复。**
 *      改前实际顺序是 `1 2 3 4 5 11 12 6 7 8 9 10` —— 规则 11/12 是后插的，
 *      插在了 5 与 6 之间。编号跳跃会让模型以为中间缺了 6 条规则（编号在 prompt 里
 *      就是「这是第几条」的唯一信号），而重复编号则会让「规则 11 说……」这类引用指错。
 *
 *   B. **规则 10 必须处理「诊断说没地方放」的情况。**
 *      规则 10 的主调是「优先就地改造（replace_run）」，而诊断可能同时说
 *      `(a cutter fits at 0 place(s) on the goal corridor)`。两条指令互相否证时，
 *      模型最省事的出路是再试一次 —— 而 loop 里同指纹第 2 次强制换动作、第 3 次 halt
 *      （`BUDGET.SAME_FINGERPRINT_MAX = 2`）。所以规则 10 里必须写出「没地方放 ⇒ 别重复
 *      replace_run」这条出路，否则主调本身会把人推进死循环。
 *
 *   C. **重排不能丢规则。**
 *      重排最容易发生的事故是某条规则在挪动时被整块删掉或漏掉一行 —— 而 prompt 是
 *      纯字符串，没有任何类型系统会替你发现。所以这里把**改前**的 12 条规则文本
 *      硬编码成快照（`RULES_BEFORE`），断言：
 *        · 规则**文本集合**相同（12 条，一条不多一条不少）；
 *        · 除规则 10 外，其余 11 条与改前**逐字节相同**；
 *        · 规则 10 **以改前全文为前缀**（是追加例外，不是改写主调）。
 *      「集合相同」这个断言是故意不让快照自动生成的：快照一自动更新，这条测试就
 *      永远绿，也就永远不守任何东西。
 *
 * ## 关于规则正文的提取方式
 *
 * `SYSTEM_PROMPT` 不是导出的（它不该导出 —— 外面只该通过 `buildPrompt()` 看它）。
 * 所以这里用**公开 API**渲染一次，再从 `system` 里切出 `RULES` 段解析：
 * 这条路径与模型真正看到的东西完全一致，比 import 一个常量更能证明「prompt 里确实是这样」。
 *
 * 用法：node --test src/agent/loop/prompt_rules.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPrompt } from "./prompt.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVES = path.resolve(HERE, "../../../test/fixtures/saves");

/**
 * 渲染一次 S1（走公开 API，与真实调用同一条路径）。
 *
 * 夹具有两种形状：`L4-obs.json` / `L5-obs.json` 是 JSON-RPC 回包（有 `result`），
 * `half-L4-obs.json` 是 `{obs, items}`。两种都吃，免得这里为了迁就夹具形状
 * 而少测一张存档 —— 「换世界 S1 不变」正是最该在**不止一张**存档上验的一条。
 */
function renderSystem(goal = "Cu----Cu", saveName = "L5-obs.json") {
    const raw = JSON.parse(fs.readFileSync(path.join(SAVES, saveName), "utf8"));
    const obs = raw.result || raw.obs;
    assert.ok(obs && Array.isArray(obs.entities), `夹具 ${saveName} 解析出了 obs.entities`);
    return buildPrompt({ goal, obs, handles: null, diagnoses: [], candidates: [] }).system;
}

/**
 * 从 `system` 里切出 RULES 段，解析成 `[{num, text}]`（保持出现顺序）。
 *
 * 规则块 = 以 `/^\d+\.\s/` 开头的行，到下一个这样的行之前（尾部空行剥掉）。
 * 缩进的续行（`"    $bbox_of returns…"`）属于当前规则，不另起一块。
 */
export function parseRules(system) {
    const after = system.split("\nRULES\n")[1];
    assert.ok(after !== undefined, "S1 里有 RULES 段（分隔符 '\\nRULES\\n'）");
    const lines = after.split("\n");
    const blocks = [];
    let cur = null;
    for (const line of lines) {
        const m = line.match(/^(\d+)\.\s/);
        if (m) {
            if (cur) blocks.push(cur);
            cur = { num: Number(m[1]), lines: [line] };
        } else if (cur) {
            cur.lines.push(line);
        }
    }
    if (cur) blocks.push(cur);
    return blocks.map(b => {
        const ls = b.lines.slice();
        while (ls.length && ls[ls.length - 1].trim() === "") ls.pop();
        return { num: b.num, text: ls.join("\n") };
    });
}

/**
 * 改前（HEAD: 7ea4506）的 12 条规则全文，**顺序按改前的实际出现顺序**
 * （`1 2 3 4 5 11 12 6 7 8 9 10`），用来做回归 C 的基线。
 *
 * ⚠️ 这个快照是**手工从改前渲染结果里抄下来的**，不是自动生成的。
 *    若有人为了「让测试通过」去重新生成它，回归 C 就失效了 —— 它的全部价值
 *    就在于「改前的样子被独立记录下来」。
 */
const RULES_BEFORE = Object.freeze([
    "1. Output RAW JSON only: no markdown fence, no prose before/after, no comments, no trailing commas.",
    "2. calls must be an array with 1 to 6 entries. An empty calls array is rejected as a failed plan.",
    "3. The ONLY allowed macro names are: connect, insert_machine, remove_run, remove_machine, extend_line, replace_run, trash_unused.\n"
        + "   Never emit build_line, paste_blueprint, or any other name: they are not part of this loop.",
    "4. NEVER output coordinates, positions, rotations, rotation variants, angles, or uids.\n"
        + "   No x/y numbers. No arrays of two or four numbers. Refer to existing things ONLY by handle.",
    "5. Point at existing things with reference operators:\n"
        + '     {"$ref":"B7"}                  one handle -> that entity\n'
        + '     {"$ref":"B7","asCell":true}    one handle -> the cell it occupies\n'
        + '     {"$uids":["B7","B8"]}          a set of handles -> the belts they name\n'
        + '     {"$bbox_of":["B7","B8"]}       a set of handles -> the smallest box covering them\n'
        + '     {"$path_of":["B7","B8"]}       a set of handles -> EXACTLY the cells of those entities\n'
        + "   Any other $-operator (offset, expand, arithmetic) is rejected. Handles must come from THIS prompt.",
    "11. To change a run of belts in place, use $path_of, NOT $bbox_of:\n"
        + "    $bbox_of returns the smallest RECTANGLE around the handles. When the run bends, or when\n"
        + "    two runs sit side by side, that rectangle also covers cells you did not name - and the\n"
        + "    macro will then refuse the call (occupied / not_a_run) even though your handles were right.\n"
        + "    $path_of returns exactly the cells of the named entities. If those cells do not fill their\n"
        + "    own rectangle (the run bends, or you picked across two separate runs), the call is REJECTED\n"
        + "    and the error tells you which cells are missing.\n"
        + "    On a straight one-wide run the two operators give the same region; that is the only case\n"
        + "    where $bbox_of is equally safe.",
    "12. A 2-cell-wide machine (cutter, stacker, mixer, balancer) needs a region at least 2 cells wide.\n"
        + "    If your targets form TWO parallel runs that feed the same place, put the handles of BOTH\n"
        + "    runs into ONE call - do not fire one call per run:\n"
        + '      replace_run { region: {"$path_of": [...run A handles..., ...run B handles...]}, ... }\n'
        + "    Splitting a parallel pair into two calls gives each call a 1-wide region, and a 2-wide\n"
        + "    machine cannot fit in it. Only split when the chain BENDS (the cells no longer fill their\n"
        + "    own rectangle) - that is a different situation from two parallel runs.\n"
        + "    If you are unsure how many runs feed the same place, make ONE call with every handle you\n"
        + "    consider relevant; the macro rejects a region that cannot hold the machine instead of\n"
        + "    silently placing it somewhere else.",
    "6. Argument names must be copied verbatim from the macro card. Unknown or misspelled arguments\n"
        + "   (e.g. source instead of from) are rejected and waste a round.",
    "7. A multi-CELL machine is addressed by ONE cell (use asCell) or by the handle of an existing\n"
        + "   entity; the macro derives the footprint and the rotation. Never try to derive them yourself.",
    "8. Do not invent handles. If a thing you need has no handle, say so in `say` and pick a macro\n"
        + "   that works with what IS listed.",
    "9. Prefer the smallest set of calls that can plausibly fix the top diagnosis. Explanations\n"
        + "   belong in `say`/`why` and must not contain numbers that look like positions.",
    "10. Most real tasks are MODIFICATIONS of an existing factory, not greenfield builds.\n"
        + "    Replacing a run of belts in place with a machine (replace_run) is the normal move;\n"
        + "    inserting a machine NEXT TO the existing run usually leaves the old run dead and is\n"
        + "    rarely what you want. If a diagnosis says a run delivers nothing, prefer converting\n"
        + "    that run over adding a parallel one. remove_run is also legitimate: sometimes the fix\n"
        + "    is to delete belts that lead nowhere.",
]);

/** 归一化：去行尾空白 + 去首尾空行（只抹平台差异，不抹内容）。 */
const norm = t => t.split("\n").map(l => l.replace(/\s+$/, "")).join("\n").replace(/^\n+|\n+$/g, "");

/** 改前规则 10 的全文（回归 C 用它做「前缀」断言）。 */
const RULE10_BEFORE = norm(RULES_BEFORE.find(t => /^10\.\s/.test(t)));

/* ═══════════════════ A. 编号连续 1..N ═══════════════════ */

test("A. 规则编号连续 1..N —— 无跳跃、无重复、无乱序", () => {
    const rules = parseRules(renderSystem());
    const nums = rules.map(r => r.num);

    assert.ok(nums.length >= 10, `至少要解析出 10 条规则（实际 ${nums.length}）`);
    assert.deepEqual(
        nums,
        nums.map((_, i) => i + 1),
        `规则编号必须是 1..${nums.length} 且按顺序出现（实际 [${nums.join(", ")}]）`,
    );

    /* 负例说明：改前是 [1,2,3,4,5,11,12,6,7,8,9,10] —— 上面这条 deepEqual 会红，
       并直接把错序的完整数组打进失败消息里（不需要再猜是哪两条错位）。 */
    assert.equal(new Set(nums).size, nums.length, "编号无重复");
});

test("A'. 换一张存档 / 换一个 goal，规则编号仍连续（S1 不随世界变）", () => {
    const a = parseRules(renderSystem("Cu----Cu", "L5-obs.json")).map(r => r.num);
    const b = parseRules(renderSystem("RuRu----", "L4-obs.json")).map(r => r.num);
    const c = parseRules(renderSystem("RuRu----", "half-L4-obs.json")).map(r => r.num);
    assert.deepEqual(b, a, "换存档后编号序列相同");
    assert.deepEqual(c, a, "换半成品存档后编号序列相同");
});

/* ═══════════════════ B. 规则 10 必须处理「没地方放」 ═══════════════════ */

test("B. 规则 10 写明『fits at 0 place(s)』时不要重复 replace_run", () => {
    const rules = parseRules(renderSystem());
    const ten = rules.find(r => r.num === 10);
    assert.ok(ten, "存在规则 10");

    /* 语义断言：诊断原文的形态必须是**可被模型对上号**的那一串。
       `fits at 0 place(s)` 与 semantic.mjs:901 的诊断文本同源 —— 写成别的说法
       （例如 "no room"）模型就没法把规则与诊断对应起来。 */
    assert.match(
        ten.text,
        /fits at 0 place\(s\)|no site/i,
        "规则 10 里出现 'fits at 0 place(s)' 或 'no site'（与诊断原文同形）",
    );

    /* 更要紧的是**给出出路**，而不是只描述现象 */
    assert.match(ten.text, /do not repeat replace_run|remove_run/i,
        "规则 10 给出了出路：别重复 replace_run / 先 remove_run");

    /* 主调必须还在：优先就地改造。这是实测得出的（加并行线通常留下一条死链）。 */
    assert.match(ten.text, /in-place|in place/i, "规则 10 仍保留『就地改造』的主调");
    assert.match(ten.text, /replace_run/, "规则 10 点名 replace_run");

    /* 与 loop 的真实行为对齐：第 2 次强制换动作、第 3 次 halt。
       若 BUDGET.SAME_FINGERPRINT_MAX 改了，这句「第三次 halt」就成了假话。 */
    assert.match(ten.text, /third time the loop halts|halts/i,
        "规则 10 说明重复试会 halt（与 SAME_FINGERPRINT_MAX 的语义一致）");
});

test("B'. 规则 10 以改前全文为前缀 —— 是追加例外，不是改写主调", () => {
    const rules = parseRules(renderSystem());
    const ten = norm(rules.find(r => r.num === 10).text);
    assert.ok(
        ten.startsWith(RULE10_BEFORE),
        "新规则 10 的开头与改前逐字节相同（主调未被动过）\n"
        + `--- 改前 ---\n${RULE10_BEFORE}\n--- 现在 ---\n${ten}`,
    );
    assert.ok(ten.length > RULE10_BEFORE.length, "规则 10 是变长（追加了例外段），不是原样没改");
});

/* ═══════════════════ C. 重排不能丢规则 ═══════════════════ */

test("C. 回归：规则文本集合与改前完全相同（只变了顺序）", () => {
    const after = parseRules(renderSystem()).map(r => norm(r.text));

    /* ⚠️ 2026-11-02：条数断言从「不变」改成「不少于」。
     *
     * 这条测试的本意是**防止重排时丢字**（当时的改动是重排 + 给规则 10 追加例外段），
     * 不是禁止新增规则。
     *
     * 后来加了规则 13（`connect` 优先级的实测结论，见 `THREE-FIXES-NET-EFFECT.md`：
     * 90 条样本里 `connect:occupied` 占 33%，是唯一的主要失败源）。
     * 用 `equal` 会把「新增一条有依据的规则」判成回归。
     *
     * 真正该守的是**下面那条逐字节比对**：改前每条都必须在场、一字不差。
     * 条数的下限守在这里，上限由「不许多出规则正文」那条守。 */
    assert.ok(after.length >= RULES_BEFORE.length,
        `规则条数不许减少（改前 ${RULES_BEFORE.length}，现在 ${after.length}）`);

    /* 逐条比对：除规则 10 外，改前每条都必须**一字不差**地仍在（只是位置变了）。
       这里用「按编号前缀取正文」而不是按位置 —— 位置正是这次要动的东西。 */
    const byBody = new Map(after.map(t => [t, true]));
    const missing = [];
    for (const before of RULES_BEFORE) {
        const b = norm(before);
        if (/^10\.\s/.test(b)) continue;               // 规则 10 单独由 B' 断言（它是唯一允许增长的）
        if (!byBody.has(b)) missing.push(b.slice(0, 80));
    }
    assert.deepEqual(missing, [], "改前 11 条规则（除 10）全部逐字节仍在，没有丢字/改写");

    /* 反向：改后不能凭空多出规则正文（条数已断言，这里防「一拆二」）
       —— 「新增规则」是白名单的：只有 13 允许是新的，且必须带实测依据。 */
    const ALLOWED_NEW = [/^13\.\s/];
    const beforeSet = new Set(RULES_BEFORE.map(norm));
    const extra = after.filter(t => !beforeSet.has(t)
        && !/^10\.\s/.test(t)
        && !ALLOWED_NEW.some(re => re.test(t)));
    assert.deepEqual(extra.map(t => t.slice(0, 80)), [], "除规则 10 外没有新增正文");
});

test("C'. 回归：六条必须原样保留的关键规则逐条点名（丢一条就红）", () => {
    /* 「集合相同」是结构性断言；这里再加一组**语义**断言，防止有人把两条合并成一条
       而集合检查恰好被绕开（例如整条规则被并进另一条的前缀里）。 */
    const all = parseRules(renderSystem()).map(r => r.text).join("\n");
    const musts = [
        [/Output RAW JSON only/, "规则 1（只输出 JSON）"],
        [/1 to 6 entries\. An empty calls array is rejected/, "规则 2（1..6 个调用）"],
        [/The ONLY allowed macro names are: connect, insert_machine/, "规则 3（宏白名单）"],
        [/\$path_of[\s\S]{0,120}EXACTLY the cells/, "规则 5（$path_of 语义）"],
        [/\$path_of, NOT \$bbox_of/, "规则 11（path_of vs bbox_of）"],
        [/A 2-cell-wide machine[\s\S]{0,80}at least 2 cells wide/, "规则 12（2 格宽机器）"],
        [/Most real tasks are MODIFICATIONS/, "规则 10（改造优先的主调）"],
    ];
    for (const [re, label] of musts) assert.match(all, re, `${label} 仍在 prompt 里`);
});

test("C''. 重排后 S1 仍然字节稳定，且不含坐标", () => {
    /* S1 是 Anthropic prompt cache 的前缀：它一旦随世界变化，缓存就失效。
       重排改了内容（预期），但不能改掉「同输入 → 同一串字节」这条。 */
    const a = renderSystem("Cu----Cu", "L5-obs.json");
    const b = renderSystem("Cu----Cu", "L5-obs.json");
    assert.equal(a, b, "同一输入渲染两次，system 完全相同");

    const coords = a.match(/\(?\s*-?\d{1,4}\s*,\s*-?\d{1,4}\s*\)?/g) || [];
    assert.deepEqual(coords, [], "S1 里没有坐标形态（新增的例外段没夹带数字对）");
});
