/**
 * fake_game.mjs — 离线的「假游戏」：一个可注入 verifyRuntime 的读取面 + 会变的世界。
 *
 * 为什么需要它（DIRECTION-FINAL 阶段 2 的前置条件）：
 *   阶段 2 的判据是「冷启动、没人算坐标，L4 打通」。要验这条，必须能**反复跑**
 *   同一个场景 —— 每次跑都真开一次游戏、装一次 mod、等 40 秒加载，是不可接受的。
 *   而 `verifyRuntime` 的 reader 从一开始就是可注入的（见 verify_runtime.test.mjs），
 *   所以「环境」这一层完全可以离线伪造。
 *
 * 关键的诚实边界（必须写在最显眼的地方）：
 *   这个假游戏**只伪造读取面**（obs / debug_items / production / step）。
 *   它**不伪造**宏的几何计算、不伪造 tx 的原子性、不伪造 gate 的判据 —— 那些都是真代码。
 *   所以它能证明的是「loop 的决策链是否走通」，**不能**证明「宏在这张存档上真的能落盘」。
 *   后者必须由实机跑一次（见 PHASE2 的实机验收节）。
 *
 * 用法：
 *   const g = FakeGame.fromSnapshot(obsDump, itemsDump);
 *   const r = await verifyRuntime(plan, { reader: g.reader(), behavior: {...} });
 *   g.apply(ops);            // 手工模拟 tx 的效果（不是真 tx —— 见下面 apply 的说明）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "../../test/fixtures/saves");

/** RPC 响应可能是裸 result，也可能是 {jsonrpc,id,result} 包着 —— 两种都吃。 */
function unwrap(x) {
    if (x && typeof x === "object" && x.result !== undefined && !Array.isArray(x.entities)) return x.result;
    return x;
}

export class FakeGame {
    /**
     * @param {object} obs   obs 的 result 部分
     * @param {object} [items] debug_items 的 result 部分（可缺）
     */
    constructor(obs, items = null, opts = {}) {
        this.obs = structuredClone(unwrap(obs));
        this.items = items ? structuredClone(unwrap(items)) : { paths: [], truncatedPaths: false };
        /* 离线世界的身份：夹具文件名（或调用方给的名字） + hub uid。
           没有它，`worldKeyOf` 会退到「hub uid + level」，而 L4 与 L5 夹具的
           hub uid 相同 —— 两个不同世界的记忆就会串在一起。 */
        this.fixtureWorldKey = (opts && typeof opts.worldKey === "string" && opts.worldKey.trim())
            ? opts.worldKey.trim()
            : (opts && opts.obsFile ? `fixture:${path.basename(opts.obsFile)}` : `fixture:${this.obs.goal?.requirement?.shape || "unknown"}`);
        this.tick = this.obs.tick || 0;
        this.production = { produced_total: {}, produced_per_sec: {}, window_seconds: 60 };
        /** 每次 reader 被调用都记一笔 —— loop 的 transcript 可以据此判断「它到底看了什么」 */
        this.calls = [];
        /** apply() 的流水，供断言「loop 提的动作真的落到世界上了」 */
        this.applied = [];
        this._nextUid = 1 + Math.max(0, ...this.obs.entities.map(e => e.uid));
    }

    /**
     * 从仓库里的真实 dump 建假游戏。
     *
     * ⚠️ `L4-obs.json` 与 `L5-obs.json` 是**两张不同的存档**，目标形状与布局都不同：
     *      L4：goal=RuRu----（level 4），(4,-13)(5,-13)(4,-14) 全是带子 —— 冷启动待改造态
     *      L5：goal=Cu----Cu（level 5），(4,-13) 已是 cutter、(4,-14) 已是 trash —— 改造后
     * 拿错夹具会**静默换关**：loop 报「L4 通过」而实际跑的是 L5。所以夹具名必须与
     * goal 显式对齐，且调用方应传 `{goal}` 让 fromFiles 在启动时断言（见 assertGoal）。
     *
     * `L5-items.json` 是 L5 的 debug_items dump。**L4 没有配套的 items dump**
     * （必须在实机上只读跑一次 `debug_items` 才有）—— 这是 PHASE2-CONTRACT §Q7 的
     * 已知缺口，loop 在 L4 冷启动上跑 L2/L3 时 items 会是空，此时 L3 会判 undecidable
     * 而不是假绿（这是故意的）。
     *
     * @param {string} [obsFile]
     * @param {string|null} [itemsFile]
     * @param {{goal?:string}} [opts] 给了 goal 就在构造时断言，防止静默换关
     */
    static fromFiles(obsFile = path.join(FIXTURES, "L5-obs.json"),
                     itemsFile = path.join(FIXTURES, "L5-items.json"),
                     opts = {}) {
        const obs = JSON.parse(fs.readFileSync(obsFile, "utf8"));
        let items = null;
        if (itemsFile) {
            try { items = JSON.parse(fs.readFileSync(itemsFile, "utf8")); } catch { /* items 可缺 */ }
        }
        const g = new FakeGame(obs, items, { ...opts, obsFile });
        if (opts.goal !== undefined) g.assertGoal(opts.goal);
        return g;
    }

    /**
     * 断言当前存档的目标形状。**静默换关是本项目最容易发生的一类假绿**
     * （夹具换了、断言没换，于是「L4 通过」其实跑的是 L5）。
     * @param {string} want 例如 "RuRu----"
     */
    assertGoal(want) {
        const got = this.obs.goal && this.obs.goal.requirement && this.obs.goal.requirement.shape;
        if (got !== want) {
            throw new Error(`夹具目标不符：期望 goal="${want}"，实际 "${got}"。`
                + `（L4 用 test/fixtures/saves/L4-obs.json，L5 用 L5-obs.json —— 别拿错存档）`);
        }
        return true;
    }

    /** 深拷贝一份（每个用例都从同一个起点出发，避免用例间串味）。 */
    clone() {
        const g = new FakeGame(this.obs, this.items, { worldKey: this.fixtureWorldKey });
        g.tick = this.tick;
        g.production = structuredClone(this.production);
        g._nextUid = this._nextUid;
        return g;
    }

    /* ─────────────────────── 读取面（喂给 verifyRuntime） ─────────────────────── */

    reader() {
        return {
            obs: async (p = {}) => this.observe(p),
            debugItems: async (p = {}) => this.debugItems(p),
            production: async (p = {}) => this.observeProduction(p),
            step: async (ticks) => this.step(ticks),
            /* ── 跨 tx 检查点（离线版）──
             *
             * 与真 mod 的 `checkpointSave/Restore` 同语义，但**范围小得多**：
             * 真 mod 用 `entity.serialize()` 存完整组件、恢复走 `rollbackToSnapshot`
             * （4 轮收敛 + 先删后放 + nextUid 回收）；这里只做**实体表的深拷贝**。
             *
             * 为什么仍然要实现它：`loop` 的撤销路径必须能被离线测试覆盖。
             * 如果这里不提供，所有撤销相关测试都得连真桥 —— 而真桥独占、
             * 一次只能跑一个，实际上等于测不了。
             *
             * **诚实边界**：FakeGame 的 `apply()` 不做 immutable 回写，
             * 所以离线算出来的可达率本来就不可靠（见 `offline_boundary.mjs` 里
             * `V-health` 那条）。因此 `decideRollback` 在非 live 模式下
             * **只判定、不执行**（`dry:true`）。这里的 restore 实现是给
             * 显式调用准备的（测试可以手动调），不是生产路径。 */
            checkpointSave: async (p = {}) => this.checkpointSave(p),
            checkpointRestore: async (p = {}) => this.checkpointRestore(p),
            checkpointList: async () => this.checkpointList(),
            /* ★ 离线世界身份 ★
             * 与真桥的 `world_info` 同语义，但**故意不返回 seed**：
             * 夹具没有真实 seed，编一个会让记忆误以为它属于某个真世界。
             * `worldKeyOf` 认 `world_key` 这个字段（见 memory.mjs）。 */
            worldInfo: async () => ({ world_key: this.fixtureWorldKey, seed: null }),
        };
    }

    /** 存一份实体表快照。同名覆盖。 */
    checkpointSave(p = {}) {
        if (!this._checkpoints) this._checkpoints = new Map();
        const name = (p && typeof p.name === "string" && p.name.trim()) ? p.name.trim() : `ck-${this._checkpoints.size + 1}`;
        const entities = structuredClone(this.obs.entities);
        this._checkpoints.set(name, { entities, tick: this.tick, nextUid: this._nextUid });
        return { ok: true, name, entities: entities.length, skipped: 0, dropped: [], total_checkpoints: this._checkpoints.size };
    }

    /** 恢复到某个检查点。返回结构与真 mod 对齐（`ok` / `verified` / `why`）。 */
    checkpointRestore(p = {}) {
        const name = p && typeof p.name === "string" ? p.name.trim() : "";
        if (!this._checkpoints || !this._checkpoints.has(name)) {
            throw new Error(`checkpoint "${name}" not found`);
        }
        const rec = this._checkpoints.get(name);
        const before = new Set(this.obs.entities.map(e => e.uid));
        const want = new Set(rec.entities.map(e => e.uid));
        this.obs.entities = structuredClone(rec.entities);
        this.obs.entity_count = this.obs.entities.length;
        this._nextUid = rec.nextUid;
        let deleted = 0, restored = 0;
        for (const u of before) if (!want.has(u)) deleted++;
        for (const u of want) if (!before.has(u)) restored++;
        /* 与真 mod 一致：`ok` 要求 uid 集合完全相等（这里必然相等，因为是整表替换） */
        return {
            ok: true, name, verified: true, uid_set_equal: true, geometry_mismatch: 0,
            entities_deleted: deleted, entities_restored: restored,
            entities_kept: want.size - restored, why: [],
        };
    }

    checkpointList() {
        const m = this._checkpoints || new Map();
        return {
            ok: true,
            items: [...m.entries()].map(([name, r]) => ({
                name, entities: r.entities.length, skipped: 0, tick: r.tick, age_ms: 0,
            })),
            total_entities: [...m.values()].reduce((a, r) => a + r.entities.length, 0),
        };
    }

    observe(p = {}) {
        this.calls.push({ method: "obs", params: p });
        let ents = this.obs.entities;
        const filtered = Array.isArray(p.region) && p.region.length === 4;
        if (filtered) {
            const [x0, y0, x1, y1] = p.region;
            ents = ents.filter(e => e.x >= x0 && e.x <= x1 && e.y >= y0 && e.y <= y1);
        }
        const max = Number.isInteger(p.max_entities) ? p.max_entities : 50000;
        const truncated = ents.length > max;
        const out = ents.slice(0, max);
        /* ★ 与 mod 的语义逐字对齐（shapez-ai-bridge.js:1330-1344）★
           `entity_count` = **region 过滤之后**的数量（不是全量！），`truncated` = 它超过 max。
           `stats.total` 才是**全量**（mod 里 stats 用 `all.length`）。
           以前这里把 entity_count 写成全量，会让 verify 的 L0 在 region 用例里
           误判「没截断」，是 Q8-22 那类假绿的直接来源。 */
        const stats = {};
        const statsByType = {};
        for (const e of this.obs.entities) statsByType[e.type] = (statsByType[e.type] || 0) + 1;
        for (const e of out) stats[e.type] = (stats[e.type] || 0) + 1;

        /* ★ `resources` 必须按 mod 的门槛给，不能无条件带 ★
         *
         * 真 mod（`shapez-ai-bridge.js:1359`）只在 `req.include_resources === true` 时
         * 才往 obs 里塞 `resources`；默认 false。
         *
         * 本实现以前用 `...this.obs` 展开，**无条件**带上 resources —— 于是离线环境
         * 比真机多给了一份信息。后果实测：`pickBeltsForGoal` 的第二层判据（目标原料
         * 矿机线）在离线永远能算出来，而在真机上永远失效，导致 prompt 里一条正解带子
         * 都不出现。离线"看到 3/3"是真的，真机"看到 0/3"也是真的 —— 两者不一致，
         * 而这个脚手架差异正是第二轮验收审计的 B-1。
         *
         * 与 `code` 不写、`paths` 不按 region 过滤是同一类问题：**离线和真机必须同语义**。
         */
        const base = { ...this.obs };
        if (p.include_resources !== true) delete base.resources;
        else if (Array.isArray(p.region) && p.region.length === 4 && Array.isArray(base.resources)) {
            const [x0, y0, x1, y1] = p.region;
            base.resources = base.resources.filter(r => Array.isArray(r) && r[0] >= x0 && r[0] <= x1 && r[1] >= y0 && r[1] <= y1);
        }

        return {
            ...base,
            tick: this.tick,
            entities: out,
            region: filtered ? p.region.slice() : this.obs.region || null,
            entity_count: ents.length,
            truncated,
            stats: { total: this.obs.entities.length, by_type: statsByType },
            hub: this.obs.hub || this.obs.entities.find(e => e.type === "hub") || null,
        };
    }

    debugItems(p = {}) {
        this.calls.push({ method: "debug_items", params: p });
        /* ★ 与真 mod 逐字对齐（shapez-ai-bridge.js:997-1004）★
           `pathCount` 是**全局**路径总数，**不受 region 影响**；
           `paths` 是**前 40 条**，也**不按 region 过滤**（mod 的 region 只用于
           belts/ejectors 这类逐格列表，不用于 paths）。
           这个曾经写错过：本实现按 region 过滤了 paths，于是 mock 里「缩 region 重读」
           能解决 PATHS_TRUNCATED，而真机上根本没这回事 ——
           mock 全绿、实机永久 undecidable。红队抓到的第 8 条。
           现在与 mod 一致：region 传了也不影响 paths/pathCount。 */
        void p.region;
        const all = this.items.paths || [];
        const MAX_PATHS = 40;
        const paths = all.slice(0, MAX_PATHS);
        return {
            ...this.items,
            paths,
            pathCount: all.length,                     // 全局，不随 region 变
            truncatedPaths: all.length > MAX_PATHS,    // 与 mod 的判据一致
        };
    }

    observeProduction(p = {}) {
        this.calls.push({ method: "production", params: p });
        return structuredClone(this.production);
    }

    step(ticks) {
        this.calls.push({ method: "step", params: { ticks } });
        const n = Number(ticks) || 0;
        this.tick += n;
        return { ok: true, advanced: n, tick: this.tick };
    }

    /* ─────────────────────── 写面（模拟 tx 的**效果**，不是 tx 本身） ───────────────────────
     *
     * ⚠️ 这个 apply 是「假的 tx」：它直接改内存里的实体表，不做原子性、不做回滚、不做
     *    逐格读回自证。它的用途只有一个 —— 让 loop 的下一轮 observe 看到上一轮的改动，
     *    从而能跑出「多轮迭代」的行为。**任何关于 tx 正确性的断言都必须走真桥接。**
     */

    apply(ops) {
        const out = { ok: true, applied: 0, failures: [], added: [], removed: [] };
        for (const op of ops) {
            try {
                if (op.op === "delete") {
                    const uid = op.uid;
                    const i = this.obs.entities.findIndex(e => e.uid === uid);
                    if (i < 0) { out.applied++; continue; }         // 幂等：删不存在的算成功
                    out.removed.push(uid);
                    this.obs.entities.splice(i, 1);
                    out.applied++;
                } else if (op.op === "place") {
                    const uid = this._nextUid++;
                    const e = {
                        uid,
                        type: op.building,
                        x: op.x, y: op.y,
                        r: op.r === undefined ? 0 : op.r,
                        variant: op.variant || "default",
                        rotation_variant: op.rotationVariant !== undefined ? op.rotationVariant : (op.rv !== undefined ? op.rv : 0),
                        code: op.code !== undefined ? op.code : null,
                        layer: "regular",
                    };
                    this.obs.entities.push(e);
                    out.added.push(uid);
                    out.applied++;
                } else {
                    out.ok = false;
                    out.failures.push({ op: op.op, reason: "fake_game 只模拟 delete/place" });
                }
            } catch (e) {
                out.ok = false;
                out.failures.push({ op: op.op, reason: String(e && e.message || e) });
            }
        }
        this.obs.entity_count = this.obs.entities.length;
        this.applied.push(out);
        return out;
    }

    /** 让「目标形状真的被交付了」这件事在假游戏里发生（仅用于测 loop 的成功路径）。 */
    setDelivered(shape, n) {
        const req = this.obs.goal && this.obs.goal.requirement;
        if (req) {
            req.delivered = n;
            req.progress = req.required ? n / req.required : 0;
        }
        this.production.produced_total[shape] = (this.production.produced_total[shape] || 0) + n;
    }

    get entityCount() { return this.obs.entities.length; }
    get goal() { return this.obs.goal; }
}

export default FakeGame;
