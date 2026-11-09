/**
 * loop/redundancy.mjs — 世界的**删除冗余度**：有多少格带子是「删了不伤任何下游」的。
 *
 * 这是**世界属性**，不是模型属性。它回答的问题与「模型删不删东西」无关，
 * 而是「这个世界现在有没有可以清理的东西」。
 *
 * ## 为什么需要它（P18 逼出来的）
 *
 * 我连续三轮实验（P14 `$ore` 提示 / P17 卡片 `when:` / P18 后果可见）
 * 都在优化「怎么让模型多用 `remove_run`」，全部证伪。最后做了一件本该
 * 第一个就做的事 —— **数一数有多少带子是可以安全删的**：
 *
 *   世界                    带子数   可安全单删   会断东西
 *   L4 夹具                 161        0          161
 *   L5 真机基线             158        0          158
 *   L11 成熟世界            2107      265 (12.6%) 1842
 *
 * L4/L5 是**零冗余**世界：每一条带子都是某条链的必要环节。
 * 在那里删任何一条都是错的 —— 所以模型拒绝裸 `remove_run` **是对的**。
 * 我把正确行为读成了缺陷，拿一个不适用的指标做了三轮实验。
 *
 * 有了这个度量，就能事前判断一个场景里「该不该删」，而不是事后猜模型的动机。
 *
 * ## 口径纪律
 *
 * · **纯函数**：同一份 entities 两次调用逐字节相同。
 * · **只读 obs.entities**：不 spawn、不读世界、不依赖宏的执行态。
 * · **复用 `analyzeRemoval` 的判据**，不另写一套「删了会不会断」的逻辑 ——
 *   那会让这个度量和 `remove_run` 的实际行为脱钩（本项目因为两份真值出过至少 3 次事故）。
 */

import { buildWorld } from "../macros/connect.mjs";
import { removeRun, makeContext, analyzeRemoval } from "../macros/remove.mjs";

const int = v => (Number.isInteger(v) ? v : null);

/**
 * @typedef {object} RedundancyReport
 * @property {number|null} belts              带子总数
 * @property {number|null} safe               单独删掉不会让任何下游失去供料的格数
 * @property {number|null} breaking           单独删掉会断东西的格数（= belts - safe）
 * @property {number|null} safe_pct           冗余率（0..1），belts=0 时为 null
 * @property {object|null} break_kinds        会断的那部分按种类计数
 * @property {string|null} reason             belts 为 null 时的原因
 */

/**
 * 量一个世界的删除冗余度。
 *
 * @param {object} obs        ObsSnapshot（或 `{result: ObsSnapshot}`）
 * @param {object} [opts]
 * @param {number} [opts.sample] 只抽前 N 条带子（大世界用；默认全量）
 * @returns {RedundancyReport}
 */
export function removalRedundancy(obs, opts = {}) {
    const o = obs && obs.result && Array.isArray(obs.result.entities) ? obs.result : obs;
    const ents = o && Array.isArray(o.entities) ? o.entities : null;
    if (!ents) {
        return { belts: null, safe: null, breaking: null, safe_pct: null, break_kinds: null, reason: "no entities in obs" };
    }

    let world, ctx;
    try {
        world = buildWorld(ents);
        ctx = makeContext(world);
    } catch (e) {
        /* 建世界失败（未知建筑变体 / 坏 obs）⇒ 整条度量降级为 null。
           **不报 0**：0 与 null 在「这个场景该不该删」的结论里是两个相反答案。 */
        return {
            belts: null, safe: null, breaking: null, safe_pct: null, break_kinds: null,
            reason: `buildWorld: ${e && e.message ? e.message : e}`,
        };
    }

    const belts = [...world.byUid.values()].filter(r => r.type === "belt");
    const n = int(belts.length) ?? 0;
    if (!n) {
        return { belts: 0, safe: 0, breaking: 0, safe_pct: null, break_kinds: {}, reason: null };
    }

    const sample = Number.isInteger(opts.sample) && opts.sample > 0
        ? belts.slice(0, opts.sample)
        : belts;

    let safe = 0, breaking = 0;
    const kinds = Object.create(null);

    for (const b of sample) {
        /* 走 `removeRun` 而不是直接调 `analyzeRemoval`：
         * `removeRun` 是**真实行为**，它可能在某些情形下拒绝（不连通、保留 hub 等）。
         * 用它的返回值才保证这个度量说的是「我照着 remove_run 真去删会发生什么」。
         * 只传一个 uid，所以不会有 run_not_contiguous 之类的干扰。 */
        let r;
        try {
            r = removeRun({ uids: [b.uid] }, ctx);
        } catch {
            continue;                       // 单格异常不污染整体计数
        }
        if (!r || r.ok !== true) continue;

        const w = Array.isArray(r.would_disconnect) ? r.would_disconnect : [];
        if (!w.length) {
            safe++;
        } else {
            breaking++;
            for (const x of w) {
                const k = (x && x.kind) || "unknown";
                kinds[k] = (kinds[k] || 0) + 1;
            }
        }
    }

    const accounted = safe + breaking;
    return {
        belts: n,
        /* `sample` 生效时，safe/breaking 是**样本内**的计数，safe_pct 用样本算。
           想拿全量就把 sample 去掉（默认）。 */
        safe,
        breaking,
        safe_pct: accounted ? Math.round((safe / accounted) * 1000) / 1000 : null,
        break_kinds: { ...kinds },
        reason: null,
        sampled: sample.length < n ? sample.length : null,
    };
}

/**
 * 一句话人话（给 timeline / 日志 / 报告用）。
 *
 * `safe_pct === 0` 时的措辞特别重要：它意味着**这个场景里删除是错的方向**，
 * 而不是「模型不会删」。P18 之前的三轮实验都是因为没这句话才走错的。
 */
export function formatRedundancy(r) {
    if (!r || r.belts === null) return `冗余度: 不可用（${(r && r.reason) || "?"}）`;
    if (r.belts === 0) return "冗余度: 世界里没有带子";
    const scope = r.sampled ? `（抽样 ${r.sampled}/${r.belts}）` : "";
    if (r.safe === 0) {
        return `冗余度 0%：${r.belts} 条带子逐条删除全都会断下游${scope}`
            + ` —— 这个世界**没有可清理的东西**，该做的是建连接/加产能，不是删。`;
    }
    const kinds = r.break_kinds && Object.keys(r.break_kinds).length
        ? `（会断的种类: ${Object.entries(r.break_kinds).map(([k, v]) => `${k}×${v}`).join(" ")}）`
        : "";
    return `冗余度 ${Math.round(100 * r.safe_pct)}%：${r.safe}/${r.belts} 条带子可安全单删${scope}${kinds}`;
}
