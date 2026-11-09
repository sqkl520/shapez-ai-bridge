/**
 * loop/memory.mjs —— **跨 run 的记忆**。
 *
 * ## 为什么需要这个文件
 *
 * 用户贴图那次复盘的数据：8 次 run 里 6 次 `goal_delta = 0`、实体数不变。
 * 更糟的是 **同一批宏在同一个诊断指纹下被反复重试** —— 模型每次 run 都从零开始，
 * 被剥夺了「我上次试过这个，没用」的记忆。
 *
 * 已有的机制（`st.fpSeen` / `mustChange` / `## LAST ROUND`）全都在
 * `runLoop` 的局部作用域里，run 结束就没了。
 *
 * ## 一条必须守住的分组
 *
 * 记忆**必须按 `goal_shape` 分组**。这不是洁癖：
 *
 *   level 5 的目标是 `Cu----Cu`，那条线的经验（「接 rotater 有用」）
 *   对 level 6 的 `Cu------`（不需要 rotater、需要长直铜）**是误导**。
 *
 * 实测的后果就是用户贴图那次：世界已经升到 level 6，旧的 level-5 产线没被拆，
 * 变成 41% 到不了 hub 的死带子。如果记忆也不分组，模型会拿着旧关卡的成功经验
 * 在新关卡上重演一遍。
 *
 * ## 记什么（只记「有信息量」的）
 *
 * | 结果 | 记？ | 理由 |
|---|---|---|
 * | `reverted`（被系统撤销） | ✅ **最高价值** | 机器已经判定这个动作有害 —— 最硬的负例 |
 * | `regressive`（把世界改坏） | ✅ | 负例，但要与 reverted 分开（后者更确定） |
 * | `inert`（世界没变） | ✅ | 「这个动作等于没做」，比犯错更浪费 |
 * | `positive`（交货） | ✅ | 正例 —— 值得优先重试 |
 * | `cleanup`（删死带子等） | ✅ | 正例，但权重低于 positive |
 * | `constructive` | ❌ | 「加了东西没交货」是**绝大多数中间步骤**的正常形态。
 *   记下来只会把 prompt 塞满噪音，而且它对下一步没有指导意义 |
 * | `churn` | ❌ | 等价替换，同上 |
 *
 * ## 不存原始 uid
 *
 * uid 在每次 run / 每次 tx 之后都会变（`restoreNextUid` 只在安全时才回收）。
 * 存 uid 等于存了一份会过期的指针。这里只存**宏名 + 关键参数摘要**，
 * 让模型知道「`replace_run` 在这类格子上试过、没用」，而不是「删 uid 10086」。
 *
 * 纯函数（除了 `loadMemory`/`saveMemory` 两个显式 IO 函数），可测。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** 记录格式版本。字段变了就 +1，旧文件直接忽略（宁可没有记忆，也不要读错形状）。 */
export const MEMORY_VERSION = 2;

/** 一个目标最多保留多少条记录（够用且不会把 prompt 撑爆）。 */
export const MAX_ENTRIES_PER_GOAL = 24;

/** 记忆文件名。放在 runDir 的**上一级** —— 它是跨 run 的，不属于任何一次 run。 */
export const MEMORY_FILE = "attempts.json";

/**
 * 每个世界最多记住多少个「观察到的关卡」。
 *
 * 一个世界正常只会在少数几个目标之间切换（每升一级换一次）。留 8 个
 * 足够覆盖一次长会话；再多只是让文件变大，且旧关卡的信息早已无用。
 */
export const MAX_WORLDS = 8;

/** 顶层结构：`{version, goals:{shape:[entries]}, worlds:{key:{last_goal,...}}}` */
const emptyMemory = () => ({ version: MEMORY_VERSION, goals: {}, worlds: {} });

/**
 * 世界身份。
 *
 * ## 为什么不能只按 `goal_shape` 分组
 *
 * 「同一个目标形状」可能出现在**完全不同的世界**里：
 *   · 离线 L4 夹具（seed 43391）与真机存档（另一个 seed）；
 *   · 同一个 `research/ai-plan/runs` 目录跑过的不同实验；
 *   · 甚至同一关卡被 `new_game` 重开过一次。
 *
 * 拿离线夹具上「`remove_run` 被撤销」的负例去指导真机，会直接堵死一个
 * 在那个世界里本来正确的动作。所以每条记忆都带 `world`，取用时按 world 过滤。
 *
 * ## 这个 key 该怎么算
 *
 * 优先用 mod 的 `world_info.seed`（真世界的身份，换存档才变）。
 * 拿不到时退到「hub 的 uid + 关卡号」—— 这两个在一次世界内部稳定，
 * 换存档/换关卡都会变。**绝不能用 uid 集合或实体数**：它们每次 tx 都变，
 * 用它们当 key 会让记忆永远跨不过一次 run（等于没做）。
 */
export function worldKeyOf(worldInfo, obs) {
    const wi = worldInfo && typeof worldInfo === "object" ? worldInfo : null;
    if (wi && typeof wi.seed === "number" && Number.isFinite(wi.seed)) {
        return `seed:${wi.seed}`;
    }
    if (wi && typeof wi.world_key === "string" && wi.world_key.trim()) {
        return wi.world_key.trim();
    }
    const o = obs && obs.result && Array.isArray(obs.result.entities) ? obs.result : obs;
    const ents = (o && Array.isArray(o.entities)) ? o.entities : [];
    const hub = ents.find(e => e && e.type === "hub");
    const lvl = (o && o.goal && Number.isFinite(o.goal.level)) ? o.goal.level : "?";
    if (hub && Number.isInteger(hub.uid)) return `hubuid:${hub.uid}|L${lvl}`;
    /* 连 hub 都没有（残缺 obs）⇒ 归入「未知世界」，但仍按 goal 分组可用。
       用 "?" 而不是抛 —— 记忆是附加能力，不该让一次读不到 obs 变成 error。 */
    return `unknown|L${lvl}`;
}

const str = v => (typeof v === "string" ? v : "");
const isInt = v => typeof v === "number" && Number.isInteger(v);

/**
 * ★ 出闸消毒：记忆里**不许**出现坐标或 uid ★
 *
 * `why` 是从 `netEffects[].why` 与 rollback 的 `restore_why` 抄来的，后者可能含
 * mod 报错里的 `JSON.stringify(errors[0])` —— 那个对象带 `uid` 和 `(x,y)`，
 * 形状是 `"uid":10143` / `"x":5,"y":-3`，**现有的 `sanitize` 正则认不出来**
 * （它只认 `uid 123` 和裸 `[-3,5]`）。一旦写进 `attempts.json`，下次 run
 * 就会把坐标带进 prompt，坐标系防火墙当场破功。
 *
 * 所以记忆在**落盘之前**就自己清一遍，不依赖 prompt 那一层兜底。
 */
function safeWhy(v) {
    if (typeof v !== "string") return "";
    return v
        .replace(/"?(?:uid|entity_uid|nextUid)"?\s*[:=]\s*-?\d+/gi, "uid?")
        .replace(/"?[xy]"?\s*:\s*-?\d+/gi, "cell?")
        .replace(/\b-?\d+\s*,\s*-?\d+\b/g, "cell?")
        .replace(/\buids?\b\s*[=:]?\s*\d+/gi, "uid?")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
}

/** 宏名白名单之外的一律不进记忆（防止文件被手工改坏后把任意文本塞进 prompt）。 */
function safeMacros(v) {
    if (!Array.isArray(v)) return [];
    return v.filter(x => typeof x === "string" && /^[a-z][a-z0-9_]{0,30}$/.test(x)).slice(0, 6);
}

/** 校验单条记忆的形状。坏条目直接丢掉 —— 不让一个 `null` 把正常 run 打成 error。 */
function validEntry(e) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return false;
    if (typeof e.goal !== "string" || !e.goal.trim()) return false;
    if (typeof e.kind !== "string" || !e.kind) return false;
    if (!Array.isArray(e.macros)) return false;
    if (e.why !== undefined && e.why !== null && !Array.isArray(e.why)) return false;
    if (e.ctx !== undefined && e.ctx !== null && typeof e.ctx !== "object") return false;
    return true;
}

/** 整理一条（外部传入或磁盘读回的）记忆，补齐/清洗字段。 */
function normalizeEntry(e) {
    if (!validEntry(e)) return null;
    const why = (Array.isArray(e.why) ? e.why : []).slice(0, 2).map(safeWhy).filter(Boolean);
    const out = {
        goal: e.goal.trim(),
        world: str(e.world) || "unknown",
        macros: safeMacros(e.macros),
        action_set: str(e.action_set),
        kind: str(e.kind),
        why,
        ctx: (e.ctx && typeof e.ctx === "object" && !Array.isArray(e.ctx)) ? {
            belts_reaching_hub: Number.isFinite(e.ctx.belts_reaching_hub) ? e.ctx.belts_reaching_hub : null,
            belts_dead: Number.isFinite(e.ctx.belts_dead) ? e.ctx.belts_dead : null,
            entities: Number.isFinite(e.ctx.entities) ? e.ctx.entities : null,
        } : null,
        ts: str(e.ts),
    };
    /* 合并时保留的辅助信息（见 mergeMemory）：同一次尝试出现过的最硬结论、
       最近一次结论、累计次数。旧文件里没有这些字段 ⇒ 由 mergeMemory 补默认值。 */
    if (Number.isFinite(e.n)) out.n = e.n;
    if (typeof e.last_kind === "string") out.last_kind = e.last_kind;
    if (!out.macros.length) return null;               // 坏条目：没有可用宏名
    if (!out.kind) return null;
    return out;
}

/**
 * 从一次 run 的结果里提取「值得记住的尝试」。
 *
 * @param {object} p
 * @param {string} p.goalShape  目标形状（分组键）
 * @param {string} [p.world]   世界身份（`worldKeyOf` 的返回）。缺省 "unknown"。
 * @param {Array} p.netEffects  `runLoop` 的 `st.netEffects`（每步 `{round, kind, why, final?}`）
 * @param {Array} p.roundCalls  每轮的宏调用：`[{round, macros:[], actionSet:''}]`
 * @param {Array} [p.rollbacks] `st.rollbacks`
 * @param {object} [p.health]   末轮快照（只取少量标量做上下文）
 * @returns {Array<object>} 要写入记忆的条目
 */
export function extractAttempts({ goalShape, world = "unknown", netEffects, roundCalls, rollbacks = [], health = null } = {}) {
    const goal = str(goalShape).trim();
    if (!goal) return [];
    const worldId = str(world).trim() || "unknown";

    const byRound = new Map();
    for (const r of (Array.isArray(roundCalls) ? roundCalls : [])) {
        if (!r || !isInt(r.round)) continue;
        byRound.set(r.round, {
            macros: Array.isArray(r.macros) ? r.macros.map(String) : [],
            actionSet: str(r.actionSet),
        });
    }

    /* ★ 净效果与动作的轮次错开一格 ★
     *
     * 这是 `loop.mjs` 的实际时序，不读代码一定会搞错：
     *
     *   round N-1：plan → tx（动作发生）
     *   round N    ：轮首 observe → classifyNetEffect，把那条 tx 的结果
     *                push 成 `netEffects[{round: N, ...}]`
     *
     * 也就是说，一条 `round: N` 的净效果描述的是 **round N-1** 那套宏的结果。
     * 唯一例外是 `final:true` 的收尾观测 —— 它在 finally 里直接读「最后一次 tx
     * 之后」的世界，round 就是那次 tx 的轮号（N），动作也在 N。
     *
     * 若按 `byRound.get(e.round)` 直接取，记下来的会是「A 动作 → B 动作的结果」，
     * 那比没有记忆更糟：它会教模型一个错误的因果。 */
    const callsFor = (e) => {
        const r = Number(e.round);
        if (e.final === true) {
            /* 收尾观测是在 run 的最后一轮**之后**补拍的。它描述的那笔 tx
               就发生在 `round` 里 —— 所以用同轮的 `roundCalls`。
               但一次 run 也可能刚好停在那笔 tx 之前（预算、halt），
               此时同轮没有记录 ⇒ 退到「该轮之前最近的一笔真实 tx」。
               不这么做的话，收尾读数会因为没有 rc 被整条丢掉。 */
            if (byRound.has(r)) return byRound.get(r);
            const earlier = [...byRound.keys()].filter(k => k <= r).sort((a, b) => b - a);
            return earlier.length ? byRound.get(earlier[0]) : null;
        }
        return byRound.get(r - 1) || null;
    };

    /* `reverted` 与 `regressive` 分开记：前者是机器判定并执行了撤销（最硬的负例），
       后者只是「世界变差了」（可能是施工中途）。混为一谈会让模型以为
       「施工中被判 regressive 的动作都被撤销过」—— 而实际大多数没有撤。 */
    const revertedRounds = new Set(
        (Array.isArray(rollbacks) ? rollbacks : [])
            .filter(r => r && r.reverted === true && isInt(r.round))
            .map(r => r.round),
    );

    const out = [];
    for (const e of (Array.isArray(netEffects) ? netEffects : [])) {
        if (!e || !isInt(e.round)) continue;
        const kind = str(e.kind);
        if (kind === "constructive" || kind === "churn") continue;   // 噪音，见文件头

        const rc = callsFor(e);
        const macros = rc ? rc.macros : [];
        if (!macros.length) continue;                                 // 没有动作就没有可记的东西

        /* 撤销的记号来自 `rollbacks`（权威），不靠 netEffects 的 kind 猜 ——
           因为 `reverted` 在 netEffects 里可能被「下一轮的 inert」覆盖过。 */
        const effective = revertedRounds.has(e.round) ? "reverted" : kind;
        if (!["reverted", "regressive", "inert", "positive", "cleanup"].includes(effective)) continue;

        /* ★ 收尾观测（`final:true`）的同 action_set 合并规则 ★
         *
         * `loop.mjs` 的 finally 会再读一次世界，专门补上「run 停在最后一个 tx
         * 之后、等不到下一轮 observe」的结果。它与正式观测描述的是**同一笔 tx**。
         * 但 `actionSetHash` 只哈希宏名，两轮用同一个宏时 key 相同 ——
         * 于是后写的 inert 会把真实结论 regressive 洗掉（实测发生过）。
         *
         * 规则不是「无脑跳过 final」，而是**按硬度合并**：
         *   · 收尾读数更硬（例如正式观测 inert、收尾却 regressive）⇒ 采用它；
         *   · 否则保留正式观测，只把「最近一次结论」更新到收尾读数。
         * 这样既不会丢更硬的负例，也不会让一条 inert 抹掉被判过的破坏。 */
        if (e.final === true && rc) {
            const as = rc.actionSet || macros.join(",");
            const at = out.findIndex(x => x.action_set === as);
            if (at >= 0) {
                const prev = out[at];
                if (hardness(effective) < hardness(prev.kind)) {
                    out[at] = { ...prev, kind: effective, why: (Array.isArray(e.why) ? e.why : []).slice(0, 2).map(safeWhy).filter(Boolean) };
                }
                continue;
            }
        }

        out.push({
            goal,
            world: worldId,
            macros,
            action_set: rc.actionSet || "",
            kind: effective,
            why: (Array.isArray(e.why) ? e.why : []).slice(0, 2).map(safeWhy).filter(Boolean),
            ctx: health ? {
                belts_reaching_hub: Number.isFinite(health.belts_reaching_hub) ? health.belts_reaching_hub : null,
                belts_dead: Number.isFinite(health.belts_dead) ? health.belts_dead : null,
                entities: Number.isFinite(health.entities) ? health.entities : null,
            } : null,
            ts: new Date().toISOString(),
        });
    }
    return out;
}

/**
 * 条目 → 去重键。
 *
 * **key 里不含 `kind`** —— 这是有意的：
 *
 * 同一次尝试（同一个目标 + 同一个 `action_set` + 同一套宏）在不同 run 里
 * 可能得到不同的结论。比如「`remove_run` 在施工中途判 regressive」，
 * 下一轮补上 `connect` 之后再跑一次同一步，结论可能变成 `inert` 甚至 `cleanup`。
 *
 * 若 key 含 `kind`，这两条会并存 —— prompt 里就会出现
 * 「`remove_run` → made the world worse」**和**「`remove_run` → changed nothing」
 * 两条互相矛盾的记录。模型无从判断该信哪个。
 *
 * 正确的语义是：**同一次尝试只有最新的一次结论**。旧的被替换掉。
 * （`mergeMemory` 里就是按这个 key 做「先删后插」。）
 */
export function entryKey(e) {
    if (!e) return "";
    /* macros 排序：`actionSetHash` 本身就是排序哈希，两条只差调用顺序的记录
       必须落到同一个 key（否则 prompt 里会出现"同一次尝试"的两条相反结论）。 */
    const macros = (Array.isArray(e.macros) ? e.macros : []).map(String).sort().join(",");
    return crypto.createHash("sha1")
        .update(`${str(e.goal)}|${str(e.world) || "unknown"}|${str(e.action_set)}|${macros}`)
        .digest("hex").slice(0, 16);
}

/** 结论的「硬度」：数值越小越该被保留（负例优先）。 */
const HARDNESS = Object.freeze({ reverted: 0, regressive: 1, positive: 2, cleanup: 3, inert: 4 });
const hardness = k => (HARDNESS[str(k)] === undefined ? 9 : HARDNESS[str(k)]);

/**
 * 合并新旧记忆。
 *
 *   · 同 `entryKey` 的**合并**（不是简单替换）：
 *     - `kind` 保留**最硬的结论**（reverted > regressive > positive > cleanup > inert），
 *       因为一次「被撤销」的负例不该被后来一次「碰巧没变化」抹掉；
 *     - `last_kind` 记最近一次结论，`n` 记累计次数，`why`/`ctx`/`ts` 取最新的；
 *   · 每个 goal 最多 `MAX_ENTRIES_PER_GOAL` 条，按「价值 + 时间」淘汰。
 *
 * 为什么 `kind` 不简单替换：红队实测指出，同宏名换目标再试一次得到 `inert`
 * 时会把最硬的 `reverted` 覆盖掉 —— 那等于把一次机器判定过的负例从记忆里删了。
 * 但也不能两条并存（会给出互相矛盾的指令），所以保留最硬的 + 记录最近一次。
 * 为什么 reverted 优先级最高：它是唯一「机器判定 + 实际执行 + 验证通过」的负例。
 * 为什么 inert 最低：它信息量最小（「没变化」），但比 constructive/churn 强 ——
 * 后两者根本不记。
 *
 * @param {object} old 旧记忆 `{version, goals:{shape:[entries]}, worlds:{key:{...}}}`
 * @param {Array} incoming 新条目
 * @param {object} [worldsIncoming] 要合并进去的 `worlds`（`{worldKey: {...}}`）
 * @returns {object} 新记忆
 */
export function mergeMemory(old, incoming, worldsIncoming = null) {
    const base = (old && old.version === MEMORY_VERSION && old.goals && typeof old.goals === "object")
        ? old
        : emptyMemory();
    const goals = {};
    for (const [k, v] of Object.entries(base.goals)) {
        if (!Array.isArray(v)) continue;
        goals[k] = v.map(normalizeEntry).filter(Boolean);   // ★ 旧条目也逐条校验 ★
    }
    /* ★ `worlds` 也要带过去 ★
     *
     * 与 `loadMemory` 是**同一类 bug 的第二处**：只重建 `{version, goals}`
     * 会把 `worlds` 静默丢掉，于是「跨 run 记住上次目标」这一轮刚写入、
     * 下一轮就被自己的 merge 抹掉 —— 而且不报错。
     * 加顶层字段时两处都要改。 */
    const worlds = {};
    for (const [k, v] of Object.entries(base.worlds && typeof base.worlds === "object" ? base.worlds : {})) {
        const w = normalizeWorld(v);
        if (w) worlds[k] = w;
    }
    if (worldsIncoming && typeof worldsIncoming === "object") {
        for (const [k, v] of Object.entries(worldsIncoming)) {
            const w = normalizeWorld(v);
            if (!w || !str(k).trim()) continue;
            const key = str(k).trim();
            worlds[key] = { ...(worlds[key] || {}), ...w };
        }
    }
    /* 最多留 MAX_WORLDS 个世界：按 last_seen 倒序保留。 */
    const wkeys = Object.keys(worlds);
    if (wkeys.length > MAX_WORLDS) {
        wkeys.sort((a, b) => str(worlds[b].last_seen).localeCompare(str(worlds[a].last_seen)));
        for (const k of wkeys.slice(MAX_WORLDS)) delete worlds[k];
    }

    for (const raw of (Array.isArray(incoming) ? incoming : [])) {
        const e = normalizeEntry(raw);
        if (!e) continue;                                   // 坏条目静默跳过，不让它进 prompt
        const g = e.goal;
        const list = goals[g] || (goals[g] = []);
        const k = entryKey(e);
        const at = list.findIndex(x => entryKey(x) === k);
        if (at < 0) {
            list.push({ ...e, last_kind: e.kind, n: 1 });
            continue;
        }
        const prev = list[at];
        const prevHard = hardness(prev.kind);
        const newHard = hardness(e.kind);
        list[at] = {
            ...prev,
            /* 最硬的结论胜出；同硬度取最新（同一档位里最近一次更有参考价值）。 */
            kind: newHard < prevHard ? e.kind : prev.kind,
            last_kind: e.kind,
            n: (Number.isFinite(prev.n) ? prev.n : 1) + 1,
            why: e.why,
            ctx: e.ctx || prev.ctx,
            ts: e.ts,
        };
    }

    for (const g of Object.keys(goals)) {
        const list = goals[g];
        if (list.length <= MAX_ENTRIES_PER_GOAL) continue;
        list.sort((a, b) => {
            const pa = hardness(a.kind), pb = hardness(b.kind);
            if (pa !== pb) return pa - pb;
            return str(b.ts).localeCompare(str(a.ts));
        });
        goals[g] = list.slice(0, MAX_ENTRIES_PER_GOAL);
    }
    return { version: MEMORY_VERSION, goals, worlds };
}

/**
 * 比较「这次看到的目标」与「上次记住的目标」，判断是否发生了关卡变更。
 *
 * ## 为什么需要它（用户贴图那次的直接成因）
 *
 * 世界从 level 5（`Cu----Cu`）升到 level 6（`Cu------`）之后，旧产线**没有拆**，
 * 变成 41% 到不了 hub 的死带子；模型还在修那条造着上一个 level 形状的线。
 * 系统里没有任何东西注意到「目标变了」。
 *
 * ## 判据只有一条：形状变了
 *
 * 不看 `level`（它可能因为别的原因跳）、不看 `required`（同一关的数字会随
 * `throughput_only` 变）、不看 `delivered`（每轮都在涨）。只有
 * `requirement.shape` 变了才意味着**要造的东西变了** —— 那才是旧产线作废的信号。
 *
 * ⚠️ 形状集合相同但顺序不同（`Cu----Cu` vs `CuCu----`）算**不同**：这是两个目标。
 *
 * @param {object} p
 * @param {object|null} p.mem `loadMemory` 的返回
 * @param {string} p.world 世界身份
 * @param {string} p.goalShape 本次观察到的目标形状
 * @param {number|null} [p.level]
 * @returns {{changed:boolean, from:string|null, to:string, level_from:number|null, level_to:number|null,
 *            first_seen:boolean, why:string}}
 *   `first_seen` = 这个世界没有记录（第一次跑，不是变更）
 */
export function detectGoalChange({ mem, world, goalShape, level = null } = {}) {
    const to = str(goalShape).trim();
    const key = str(world).trim() || "unknown";
    const no = { changed: false, from: null, to, level_from: null, level_to: level, first_seen: false, why: "" };
    if (!to) return { ...no, why: "当前目标读不到，不判定" };

    const rec = mem && mem.worlds && typeof mem.worlds === "object" ? mem.worlds[key] : null;
    const from = rec && typeof rec.last_goal === "string" ? rec.last_goal.trim() : "";
    const lf = rec && Number.isFinite(rec.last_level) ? rec.last_level : null;

    if (!from) {
        /* 第一次在这个世界上跑 —— **不是**变更。把它当成变更会让第一次 run 就
           被告知「目标变了，去拆旧线」，而那时根本没有旧线。 */
        return { ...no, first_seen: true, why: "这个世界还没有记录，视为首次观察" };
    }
    if (from === to) {
        return { ...no, from, level_from: lf, why: "目标未变" };
    }
    return {
        changed: true,
        from, to,
        level_from: lf, level_to: level,
        first_seen: false,
        why: `目标形状从 ${from} 变成 ${to}`,
    };
}

/**
 * 把本次观察到的目标写回 `worlds`（供 `mergeMemory` 的第三参）。
 *
 * `previous_goal` 与 `last_goal` 分开存：前者用来回答「发生过变更吗」，
 * 后者是「现在是什么」。只存一个的话，变更一次之后就再也看不出「从哪来的」。
 *
 * @returns {object} `{ [world]: {last_goal, previous_goal?, last_level, last_seen} }`
 */
export function worldUpdate({ mem, world, goalShape, level = null, now = null } = {}) {
    const to = str(goalShape).trim();
    const key = str(world).trim() || "unknown";
    if (!to) return {};
    const prev = mem && mem.worlds && mem.worlds[key] ? mem.worlds[key] : null;
    const prevGoal = prev && typeof prev.last_goal === "string" ? prev.last_goal.trim() : "";
    return {
        [key]: {
            last_goal: to,
            ...(prevGoal && prevGoal !== to ? { previous_goal: prevGoal } : {}),
            last_level: Number.isFinite(level) ? level : (prev && Number.isFinite(prev.last_level) ? prev.last_level : null),
            last_seen: str(now) || new Date().toISOString(),
        },
    };
}

/** 读记忆。文件不存在 / 坏 JSON / 版本不符 ⇒ 返回空记忆（**不抛**）。 */
export function loadMemory(file) {
    const empty = emptyMemory();
    if (!file) return empty;
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); } catch { return empty; }
    try {
        const j = JSON.parse(raw);
        if (!j || j.version !== MEMORY_VERSION || !j.goals || typeof j.goals !== "object" || Array.isArray(j.goals)) {
            return empty;
        }
        /* ★ 只读顶层结构是不够的 ★
         *
         * 一个「合法 JSON + 正确 version」的文件里可能有 `[null]`、`"string"`、
         * `{macros:"x", why:{}}` 这类畸形条目。若原样带下去，
         * `attemptsForGoal` 的 sort 与 `renderPriorAttempts` 的 `a.macros`
         * 会直接抛 —— 把一次正常 run 变成 `error`。
         *
         * 所以这里就逐条 `normalizeEntry`，坏条目丢掉、好条目清洗后返回。
         * 宁可少几条记忆，也不许记忆文件有能力搞坏一次 run。 */
        const goals = {};
        for (const [k, v] of Object.entries(j.goals)) {
            if (!Array.isArray(v)) continue;
            goals[k] = v.map(normalizeEntry).filter(Boolean);
        }
        /* ★ `worlds` 必须显式带上 ★
         *
         * 这是一次真实踩坑：上一版这里 `return { version, goals }` ——
         * 任何**其它**顶层字段（`worlds` 就是）都会被静默丢掉。
         * 于是「跨 run 记住上次的目标」永远读到 undefined，
         * 关卡变更检测形同不存在，而且**没有任何报错**。
         * 加字段时一定要回到这一行。 */
        const worlds = {};
        for (const [k, v] of Object.entries(j.worlds && typeof j.worlds === "object" ? j.worlds : {})) {
            const w = normalizeWorld(v);
            if (w) worlds[k] = w;
        }
        return { version: MEMORY_VERSION, goals, worlds };
    } catch { return empty; }
}

/** 校验并清洗一条 `worlds[key]` 记录。坏数据返回 null。 */
function normalizeWorld(v) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const out = {};
    if (typeof v.last_goal === "string" && v.last_goal.trim()) out.last_goal = v.last_goal.trim().slice(0, 64);
    if (typeof v.previous_goal === "string" && v.previous_goal.trim()) out.previous_goal = v.previous_goal.trim().slice(0, 64);
    if (Number.isFinite(v.last_level)) out.last_level = v.last_level;
    if (typeof v.last_seen === "string") out.last_seen = v.last_seen.slice(0, 40);
    return Object.keys(out).length ? out : null;
}

/** 写记忆（原子：先写 tmp 再 rename，避免半截文件）。失败返回 false，**不抛**。 */
export function saveMemory(file, mem) {
    if (!file) return false;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(mem, null, 1), "utf8");
        fs.renameSync(tmp, file);
        return true;
    } catch { return false; }
}

/**
 * 取某个目标下、**对下一步最有用**的若干条。
 *
 * 排序：先按价值（负例优先 —— 别重复错的），同价值取最新的。
 * 只返回 `limit` 条：prompt 是稀缺资源，而且第 6 条之后信息量急剧下降。
 *
 * @param {object} mem `loadMemory` 的返回
 * @param {string} goalShape
 * @param {{limit?:number, excludeActionSets?:string[], excludeHardNegatives?:boolean,
 *          world?:string, worldStrict?:boolean}} [opts]
 *   `excludeActionSets`：本次 run 已经用过的动作集。默认**只剔除弱记录**
 *   （inert/cleanup/positive）；`reverted`/`regressive` 这类硬负例必须保留 ——
 *   模型本轮重用同一套宏时，恰恰最该看见「上次这么干被撤销了」。
 *   `world`：当前世界身份。给了就只返回同世界的记录（`worldStrict:false` 时
 *   额外允许 `unknown`）；不给则不做世界过滤（兼容旧调用方）。
 * @returns {Array<object>}
 */
export function attemptsForGoal(mem, goalShape, opts = {}) {
    const g = str(goalShape).trim();
    if (!g || !mem || !mem.goals) return [];
    const list = Array.isArray(mem.goals[g]) ? mem.goals[g].map(normalizeEntry).filter(Boolean) : [];
    const exclude = new Set((opts.excludeActionSets || []).map(String));
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 6;
    const wantWorld = str(opts.world).trim();

    return list
        .filter(e => {
            /* ★ 世界隔离：不同 seed / 不同存档 / 离线夹具的经验不许串进真机 ★ */
            if (wantWorld && str(e.world) !== wantWorld) {
                if (opts.worldStrict === true || str(e.world) !== "unknown") return false;
            }
            if (!exclude.has(str(e.action_set))) return true;
            /* 本 run 已用过：弱记录重复没意义，硬负例必须留着。 */
            return hardness(e.kind) <= 1;
        })
        .sort((a, b) => {
            const pa = hardness(a.kind), pb = hardness(b.kind);
            if (pa !== pb) return pa - pb;
            return str(b.ts).localeCompare(str(a.ts));
        })
        .slice(0, limit);
}
