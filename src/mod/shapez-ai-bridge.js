/**
 * shapez-ai-bridge — 让 AI 操作 shapez.io 的游戏内 Mod
 *
 * 用法：把本文件复制到 %APPDATA%\shapez.io\mods\ （或 mac/linux 对应目录），重启游戏。
 * 本 Mod 不含任何游戏源码；全部集成经由官方 exposeExports 暴露的 window.shapez 模块
 * 与 ModInterface 基础设施完成。详见仓库 docs/PROTOCOL.md（协议契约）。
 *
 * 架构（协议 §1）：渲染进程没有 Node 权限（nodeIntegration:false + sandbox:true），
 * 所以本 Mod 只做「WebSocket 客户端」，连到外部桥接进程（src/bridge/bridge.mjs）。
 * 浏览器原生 WebSocket 在渲染进程恒可用。
 */

/* eslint-disable no-unused-vars */

const METADATA = {
    id: "shapez-ai-bridge",
    name: "AI Bridge (MCP)",
    version: "0.1.0",
    author: "shapez-ai-bridge contributors",
    description:
        "WebSocket bridge that exposes observations and actions for AI agents (MCP-compatible). See docs/PROTOCOL.md.",
    website: "https://github.com/sqkl520/shapez-ai-bridge",
    minimumGameVersion: "1.5.6",
    // true = this mod does not touch savegame structure, so it is NOT written into
    // the savegame's mod list. The game's loader filter is `!doesNotAffectSavegame`
    // (recon/bundle.pretty.js `_getModsListForSavega`), i.e. false would make every
    // save record the mod and warn "missing mods" after uninstall. We only read the
    // world and place/remove entities through official APIs — the savegame shape is
    // unchanged, so true is the correct value.
    doesNotAffectSavegame: true,
    settings: {
        ws_url: "ws://127.0.0.1:7777/mod",
        allow_step: true, // allow step/await fast-forward (briefly freezes rendering)
        allow_write: true, // allow placement/deletion actions
        max_entities: 20000, // hard cap on entities in one observation
    },
};

const BRIDGE_PROTOCOL = 1;
const BRIDGE_MOD_VERSION = "0.1.0";
// Fallback only. The real version is read at runtime from shapez.BUILD_OPTIONS
// (the game's own build metadata, bundled as BUILD_VERSION / BUILD_COMMIT_HASH).
// A mod that hard-codes the version can never notice a game update — the red
// team flagged exactly that (the 1002/2006 checks would silently never fire).
const GAME_VERSION_FALLBACK = "1.5.6";
const MINIMUM_GAME_VERSION = "1.5.6";

/** The running game's true version, read from the game itself when available. */
function detectGameVersion() {
    try {
        const shapez = /** @type {any} */ (window).shapez;
        if (shapez && shapez.BUILD_OPTIONS && typeof shapez.BUILD_OPTIONS.BUILD_VERSION === "string") {
            return shapez.BUILD_OPTIONS.BUILD_VERSION;
        }
    } catch (e) {
        /* fall through */
    }
    return GAME_VERSION_FALLBACK;
}

function detectBuildHash() {
    try {
        const shapez = /** @type {any} */ (window).shapez;
        if (shapez && shapez.BUILD_OPTIONS && typeof shapez.BUILD_OPTIONS.BUILD_COMMIT_HASH === "string") {
            return shapez.BUILD_OPTIONS.BUILD_COMMIT_HASH;
        }
    } catch (e) {
        /* fall through */
    }
    return null;
}

// 重连参数（协议 §8）
const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30000;

// step/await 安全上限（协议 §8）
const MAX_STEP_TICKS = 20000;

/**
 * 继承官方 Mod 基类（mod_examples 的官方模式：class Mod extends shapez.Mod）。
 * window.shapez 由 modloader 在本文件 eval 之前 exposeExports() 建立，故此处可直接引用。
 * 基类构造为 Mod({app, modLoader, meta, settings, saveSettings})。
 */
class Mod extends shapez.Mod {
    constructor(args) {
        super(args);
        this.app = args.app;
        this.modLoader = args.modLoader;
        this.metadata = args.meta;
        this.settings = args.settings;
        this.saveSettings = args.saveSettings;
        this.modInterface = args.modLoader.modInterface;
        this.signals = args.modLoader.signals;

        /** @type {WebSocket|null} */
        this.ws = null;
        this.connected = false;
        this.reconnectDelay = RECONNECT_MIN_MS;
        this.reconnectTimer = null;
        this.shuttingDown = false;

        /** 当前游戏根对象；由 MOD_SIGNALS.gameStarted 注入 */
        this.root = null;

        // rpc 请求计数（本侧只回应，不主动发请求；id 由桥接分配）
        this.logPrefix = "[shapez-ai-bridge]";
    }

    init() {
        this.log("mod initialized; bridge url =", this.settings.ws_url, "; game version:", this.gameVersion());
        this.hookGameLifecycle();
        this.connect();
    }

    /** 运行中游戏的真实版本（读游戏的构建元数据，只解析一次）。 */
    gameVersion() {
        if (!this._gameVersion) {
            this._gameVersion = detectGameVersion();
            const hash = detectBuildHash();
            if (hash) this.log("detected game build:", this._gameVersion, "@", hash);
            if (this._gameVersion !== MINIMUM_GAME_VERSION) {
                // 硬失败路径的另一半：让桥接（按 compat.json）拒绝路由。
                // mod 侧不主动拒绝——版本兼容策略由桥接统一裁决。
                this.warn(
                    "game version", this._gameVersion, "differs from the tested baseline", MINIMUM_GAME_VERSION,
                    "- the bridge will reject routing unless compat.json lists this version"
                );
            }
        }
        return this._gameVersion || GAME_VERSION_FALLBACK;
    }

    /** 当前游戏的构建哈希（用于诊断；拿不到时为 null）。 */
    buildHash() {
        if (this._buildHash === undefined) this._buildHash = detectBuildHash();
        return this._buildHash;
    }

    // ─────────────────────────── 日志 ───────────────────────────

    log(...args) {
        console.log(this.logPrefix, ...args);
    }

    warn(...args) {
        console.warn(this.logPrefix, ...args);
    }

    error(...args) {
        console.error(this.logPrefix, ...args);
    }

    // ─────────────────────── 游戏生命周期 ───────────────────────

    hookGameLifecycle() {
        // root 在游戏进入世界时准备好（bundle: MOD_SIGNALS.gameStarted.dispatch(core.root)）
        this.signals.gameStarted.add(root => {
            this.root = root;
            this.log("game started; root captured");
            this.logPhaseStatus("game_started");
        });
        // 退出到菜单时 root 失效
        this.signals.stateEntered.add(state => {
            const key = state && state.getKey ? state.getKey() : String(state);
            if (key !== "InGameState") {
                if (this.root) this.log("left game state ->", key, "; dropping root");
                this.root = null;
            }
        });
    }

    logPhaseStatus(phase) {
        try {
            const status = this.statusInternal();
            this.log(`phase=${phase} in_game=${status.in_game} level=${status.hub_level}`);
        } catch (e) {
            this.warn("logPhaseStatus failed:", e);
        }
    }

    // ─────────────────────── WebSocket 连接 ───────────────────────

    connect() {
        if (this.shuttingDown) return;
        let ws;
        try {
            ws = new WebSocket(this.settings.ws_url);
        } catch (e) {
            this.error("WebSocket ctor failed:", e);
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;

        ws.onopen = () => {
            this.connected = true;
            this.reconnectDelay = RECONNECT_MIN_MS;
            this.log("connected to bridge");
            this.sendHello();
        };

        ws.onmessage = ev => {
            // 只接受文本帧
            if (typeof ev.data !== "string") return;
            let msg;
            try {
                msg = JSON.parse(ev.data);
            } catch (e) {
                this.warn("bad json from bridge:", e);
                return;
            }
            this.handleBridgeMessage(msg);
        };

        ws.onclose = ev => {
            this.connected = false;
            this.ws = null;
            this.log("disconnected from bridge (code", ev.code + ")");
            this.scheduleReconnect();
        };

        ws.onerror = () => {
            // onclose 一定跟随触发，重连逻辑放那边，避免双发
        };
    }

    scheduleReconnect() {
        if (this.shuttingDown || this.reconnectTimer) return;
        const delay = this.reconnectDelay;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
        this.reconnectDelay = Math.min(RECONNECT_MAX_MS, Math.round(this.reconnectDelay * 1.5));
    }

    // ─────────────────────── 协议收发 ───────────────────────

    sendRaw(obj) {
        if (!this.ws || this.ws.readyState !== 1 /* OPEN */) return false;
        try {
            this.ws.send(JSON.stringify(obj));
            return true;
        } catch (e) {
            this.error("send failed:", e);
            return false;
        }
    }

    sendHello() {
        this.sendRaw({
            jsonrpc: "2.0",
            method: "hello",
            params: {
                protocol: BRIDGE_PROTOCOL,
                mod_version: BRIDGE_MOD_VERSION,
                game_version: this.gameVersion(),
                features: [
                    "observe",
                    "act",
                    "batch",
                    "step",
                    "await",
                    "blueprint",
                    "screenshot",
                    "save",
                    "new_game",
                ],
            },
        });
    }

    handleBridgeMessage(msg) {
        // 桥接只发请求（带 id）或通知（无 id）。本 Mod 对未知 method 回 -32601。
        if (msg && msg.id !== undefined && msg.method !== undefined) {
            // 状态切换类 RPC 必须串行（红队发现：并发 load_save/new_game 时第二次
            // moveToState 会撞上游戏的状态机 fade 保护而被静默忽略，但 mod 仍回 ok）。
            // 用一条 Promise 链保证顺序执行；其余 RPC 走原路径不被拖慢。
            if (msg.method === "load_save" || msg.method === "new_game") {
                this.stateChain = (this.stateChain || Promise.resolve()).then(
                    () => this.handleRpc(msg),
                    () => this.handleRpc(msg)
                );
                return;
            }
            this.handleRpc(msg).catch(err => {
                this.sendError(msg.id, 2003, "mod_error", String(err && err.stack ? err.stack : err));
            });
            return;
        }
        // 通知（无 id）暂不处理。
    }

    async handleRpc(msg) {
        const { id, method, params } = msg;
        try {
            let result;
            switch (method) {
                case "status":
                    result = this.statusInternal();
                    break;
                case "obs":
                    result = this.observe(params || {});
                    break;
                case "act":
                    result = await this.performAction(params || {});
                    break;
                case "batch":
                    result = await this.performBatch(params || {});
                    break;
                case "screenshot":
                    result = await this.screenshot(params || {});
                    break;
                case "save_now":
                    result = await this.saveNow();
                    break;
                case "list_saves":
                    result = this.listSaves();
                    break;
                case "load_save":
                    result = await this.loadSave(params || {});
                    break;
                case "new_game":
                    result = await this.newGame(params || {});
                    break;
                default:
                    this.sendError(id, -32601, "method_not_found", "Unknown method: " + method);
                    return;
            }
            this.sendRaw({ jsonrpc: "2.0", id, result });
        } catch (err) {
            if (err && err.__rpcError) {
                this.sendError(id, err.__rpcError.code, err.__rpcError.name, err.__rpcError.detail, err.__rpcError.hint);
            } else {
                this.error("rpc", method, "failed:", err);
                this.sendError(id, 2003, "mod_error", String(err && err.message ? err.message : err));
            }
        }
    }

    sendError(id, code, codeName, detail, hint) {
        const data = { code_name: codeName, detail: detail === undefined ? null : detail };
        if (hint) data.hint = hint;
        this.sendRaw({ jsonrpc: "2.0", id, error: { code, message: codeName + ": " + detail, data } });
    }

    /** 抛一个带错误码的异常（handleRpc 会转成 JSON-RPC error） */
    rpcError(code, codeName, detail, hint) {
        const err = new Error(codeName + ": " + detail);
        err.__rpcError = { code, name: codeName, detail, hint };
        return err;
    }

    // ─────────────── 只读/可写门槛 ───────────────

    assertWritable(what) {
        if (!this.settings.allow_write) {
            throw this.rpcError(1004, "read_only", what + " is disabled by mod settings (allow_write=false)");
        }
    }

    assertSteppable() {
        if (!this.settings.allow_step) {
            throw this.rpcError(1004, "read_only", "step/await is disabled by mod settings (allow_step=false)");
        }
    }

    /** 需要游戏世界；否则 1003 */
    requireRoot() {
        if (!this.root) {
            throw this.rpcError(
                1003,
                "not_in_game",
                "Game world is not loaded (still in menu / loading / no savegame)",
                "Load or create a savegame in-game first"
            );
        }
        return this.root;
    }

    // ─────────────── status ───────────────

    statusInternal() {
        const root = this.root;
        const out = {
            protocol: BRIDGE_PROTOCOL,
            mod_version: BRIDGE_MOD_VERSION,
            game_version: this.gameVersion(),
            in_game: !!root,
            features: ["observe", "act", "batch", "step", "await", "blueprint", "screenshot", "save", "new_game"],
            allow_write: !!this.settings.allow_write,
            allow_step: !!this.settings.allow_step,
        };
        if (root) {
            out.tick = root.time.now();
            out.paused = root.time.getIsPaused();
            out.speed = this.speedIdToName(root.time.getSpeed().getId());
            out.hub_level = root.hubGoals.level;
        }
        return out;
    }

    speedIdToName(id) {
        if (id === "paused") return "paused";
        if (id === "fast-forward") return "fast_forward";
        return "regular";
    }

    // ─────────────── 建筑 id ↔ code 表 ───────────────

    /** 懒构建：building gameId（"belt"）→ metaInstance；code（数字）→ {buildingId, variant, rotationVariant} */
    ensureBuildingTables() {
        if (this._buildingTable) return this._buildingTable;
        const shapez = /** @type {any} */ (window).shapez;
        const table = { byId: {}, byCode: {}, variantsByCode: {} };
        try {
            const registry = shapez.gMetaBuildingRegistry;
            for (const meta of registry.getEntries()) {
                table.byId[meta.getId()] = meta;
            }
            // gBuildingVariants: code -> {metaClass, metaInstance, variant, rotationVariant, tileSize}
            const variants = shapez.gBuildingVariants;
            for (const code in variants) {
                const v = variants[code];
                const id = v.metaInstance && v.metaInstance.getId ? v.metaInstance.getId() : null;
                table.byCode[code] = {
                    buildingId: id,
                    metaInstance: v.metaInstance,
                    variant: v.variant,
                    rotationVariant: v.rotationVariant,
                };
            }
        } catch (e) {
            this.error("failed to build building tables:", e);
        }
        this._buildingTable = table;
        return table;
    }

    /** 把实体翻译成观测条目 */
    entityToObs(entity, table) {
        const sme = entity.components.StaticMapEntity;
        if (!sme) return null;
        const codeInfo = table.byCode[sme.code];
        return {
            uid: entity.uid,
            type: codeInfo ? codeInfo.buildingId : "code_" + sme.code,
            x: sme.origin.x,
            y: sme.origin.y,
            r: sme.rotation,
            variant: codeInfo ? codeInfo.variant : "default",
            rotation_variant: codeInfo ? codeInfo.rotationVariant : 0,
            code: sme.code,
            layer: entity.layer || "regular",
        };
    }

    // ─────────────── 观测 ───────────────

    observe(p) {
        const root = this.requireRoot();
        const req = this.validateObsRequest(p);
        const table = this.ensureBuildingTables();

        const region = req.region; // [x0,y0,x1,y1] 或 null
        const layer = req.layer || "regular";

        // 枚举实体
        let all = [];
        const em = root.entityMgr;
        // 快速路径：全量数组（entityMgr.entities 是权威）。
        // （chunk 增量留给后续优化；先保证正确性。）
        const src = em.entities;
        for (let i = 0; i < src.length; ++i) {
            const e = src[i];
            if (!e || !e.components || !e.components.StaticMapEntity) continue;
            if (e.queuedForDestroy || e.destroyed) continue;
            if (layer !== "all" && (e.layer || "regular") !== layer) continue;
            all.push(e);
        }

        const statsByType = {};
        let regionBbox = null;
        if (all.length > 0) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const e of all) {
                const o = e.components.StaticMapEntity.origin;
                if (o.x < minX) minX = o.x;
                if (o.y < minY) minY = o.y;
                if (o.x > maxX) maxX = o.x;
                if (o.y > maxY) maxY = o.y;
            }
            regionBbox = [minX, minY, maxX, maxY];
        }

        const effectiveRegion = region || regionBbox;

        // 过滤 + 统计（stats 永远基于全量）
        const list = [];
        for (const e of all) {
            const obs = this.entityToObs(e, table);
            const t = obs ? obs.type : "unknown";
            statsByType[t] = (statsByType[t] || 0) + 1;
            if (!effectiveRegion) {
                list.push(e);
            } else if (this.entityIntersectsRegion(e, effectiveRegion)) {
                list.push(e);
            }
        }

        const truncated = list.length > req.max_entities;
        const slice = truncated ? list.slice(0, req.max_entities) : list;

        const out = {
            protocol: BRIDGE_PROTOCOL,
            mod_version: BRIDGE_MOD_VERSION,
            game_version: this.gameVersion(),
            in_game: true,
            tick: root.time.now(),
            paused: root.time.getIsPaused(),
            speed: this.speedIdToName(root.time.getSpeed().getId()),
            layer: root.currentLayer || "regular",
            camera: this.cameraSnapshot(root),
            region: effectiveRegion,
            entities: slice.map(e => this.entityToObs(e, table)).filter(Boolean),
            entity_count: list.length,
            truncated,
        };

        if (req.include_stats) {
            out.stats = { total: all.length, by_type: statsByType };
        }

        if (req.include_hub) {
            out.hub = this.hubSnapshot(root);
        }

        out.goal = this.goalSnapshot(root);

        if (req.include_resources) {
            out.resources = this.resourceSnapshot(root, effectiveRegion, req.max_resources);
        }

        return out;
    }

    /**
     * 实体是否与区域相交。多格建筑（hub 4×4 等）按 tile-space bounds 的 AABB 相交判断，
     * 只用 origin 会漏掉「原点在区域外但本体压进区域」的实体。
     */
    entityIntersectsRegion(e, region) {
        const sme = e.components.StaticMapEntity;
        if (!sme) return false;
        const o = sme.origin;
        let w = 1;
        let h = 1;
        try {
            if (sme.getTileSpaceBounds) {
                const b = sme.getTileSpaceBounds();
                if (b && typeof b.w === "number") {
                    w = b.w;
                    h = b.h;
                }
            }
        } catch (err) {
            /* 保守用 1x1 */
        }
        return o.x + w - 1 >= region[0] && o.y + h - 1 >= region[1] && o.x <= region[2] && o.y <= region[3];
    }

    validateObsRequest(p) {
        if (p === null || typeof p !== "object" || Array.isArray(p)) {
            throw this.rpcError(2001, "invalid_action", "obs params must be an object");
        }
        const known = new Set([
            "region",
            "max_entities",
            "include_hub",
            "include_resources",
            "include_stats",
            "max_resources",
            "layer",
        ]);
        for (const k in p) {
            if (!known.has(k)) {
                throw this.rpcError(2001, "invalid_action", "unknown obs field: " + k, "Allowed: " + [...known].join(", "));
            }
        }
        let region = null;
        if (p.region !== undefined && p.region !== null) {
            if (
                !Array.isArray(p.region) ||
                p.region.length !== 4 ||
                p.region.some(v => typeof v !== "number" || !Number.isFinite(v))
            ) {
                throw this.rpcError(2001, "invalid_action", "region must be [x0,y0,x1,y1] numbers");
            }
            region = p.region.slice();
            if (region[0] > region[2] || region[1] > region[3]) {
                throw this.rpcError(2001, "invalid_action", "region min must be <= max");
            }
        }
        let maxEntities = p.max_entities === undefined ? 2000 : p.max_entities;
        if (!Number.isInteger(maxEntities) || maxEntities < 1 || maxEntities > 50000) {
            throw this.rpcError(2001, "invalid_action", "max_entities must be int in [1, 50000]");
        }
        maxEntities = Math.min(maxEntities, this.settings.max_entities || 50000);
        const layer = p.layer === undefined ? "regular" : p.layer;
        if (layer !== "regular" && layer !== "wires" && layer !== "all") {
            throw this.rpcError(2001, "invalid_action", "layer must be regular|wires|all");
        }
        return {
            region,
            max_entities: maxEntities,
            include_hub: p.include_hub !== false,
            include_resources: p.include_resources === true,
            include_stats: p.include_stats !== false,
            max_resources: Number.isInteger(p.max_resources) ? Math.min(p.max_resources, 20000) : 2000,
            layer,
        };
    }

    cameraSnapshot(root) {
        try {
            const c = root.camera;
            const center = c.center || (c.desiredCenter || null);
            return {
                x: center ? center.x : 0,
                y: center ? center.y : 0,
                zoom: typeof c.zoomLevel === "number" ? Number(c.zoomLevel.toFixed(4)) : 1,
            };
        } catch (e) {
            return { x: 0, y: 0, zoom: 1 };
        }
    }

    hubSnapshot(root) {
        try {
            const stored = {};
            const raw = root.hubGoals.storedShapes || {};
            for (const k in raw) stored[k] = raw[k];
            return {
                stored_shapes: stored,
                has_free_paste: !!root.gameMode.getHasFreeCopyPaste(),
                blueprint_shape_key: root.gameMode.getBlueprintShapeKey ? root.gameMode.getBlueprintShapeKey() : null,
            };
        } catch (e) {
            return { stored_shapes: {}, has_free_paste: false, blueprint_shape_key: null };
        }
    }

    goalSnapshot(root) {
        try {
            const goal = root.hubGoals.currentGoal;
            const shapedef = goal.definition;
            const delivered = root.hubGoals.getCurrentGoalDelivered();
            const shortKey = shapedef && shapedef.getHash ? shapedef.getHash() : String(shapedef);
            return {
                level: root.hubGoals.level,
                requirement: {
                    shape: shortKey,
                    required: goal.required,
                    delivered,
                    progress: goal.required > 0 ? Math.min(1, delivered / goal.required) : 0,
                    throughput_only: !!goal.throughputOnly,
                },
                upgrade_levels: Object.assign({}, root.hubGoals.upgradeLevels),
            };
        } catch (e) {
            return null;
        }
    }

    /**
     * 资源（lower layer）：用 chunk 的 lowerLayer 表按区域扫。
     * 资源实体是 ShapeItem 实例；shortKey 用 .getHash()（对 ShapeItem 有效——实测存档里形状序列化为 "CuCuCuCu" 等）。
     */
    resourceSnapshot(root, region, maxResources) {
        const out = [];
        try {
            const map = root.map;
            const chunkSize = 16; // globalConfig.mapChunkSize 实测 = 16
            if (!region) region = [-64, -64, 64, 64];
            const c0x = Math.floor(region[0] / chunkSize);
            const c1x = Math.floor(region[2] / chunkSize);
            const c0y = Math.floor(region[1] / chunkSize);
            const c1y = Math.floor(region[3] / chunkSize);
            for (let cx = c0x; cx <= c1x && out.length < maxResources; ++cx) {
                for (let cy = c0y; cy <= c1y && out.length < maxResources; ++cy) {
                    const chunk = map.getChunk(cx, cy, true);
                    if (!chunk || !chunk.lowerLayer) continue;
                    for (let lx = 0; lx < chunkSize; ++lx) {
                        const col = chunk.lowerLayer[lx];
                        if (!col) continue;
                        for (let ly = 0; ly < chunkSize; ++ly) {
                            const item = col[ly];
                            if (!item) continue;
                            const wx = chunk.tileX + lx;
                            const wy = chunk.tileY + ly;
                            if (wx < region[0] || wx > region[2] || wy < region[1] || wy > region[3]) continue;
                            out.push([wx, wy, this.itemToShortKey(item)]);
                            if (out.length >= maxResources) break;
                        }
                    }
                }
            }
        } catch (e) {
            this.warn("resourceSnapshot failed:", e);
        }
        return out;
    }

    itemToShortKey(item) {
        // 优先用游戏自己的规范键（BaseItem.getAsCopyableKey）：
        // ShapeItem → definition.getHash()（"CuCuCuCu"），ColorItem → 颜色名等。
        try {
            if (item && typeof item.getAsCopyableKey === "function") {
                const k = item.getAsCopyableKey();
                if (typeof k === "string" && k) return k;
            }
        } catch (e) {
            /* fallthrough */
        }
        try {
            if (item && item.definition && item.definition.getHash) return item.definition.getHash();
        } catch (e) {
            /* ignore */
        }
        try {
            if (item && item.getHash) return item.getHash();
        } catch (e) {
            /* ignore */
        }
        return String(item);
    }

    // ─────────────── 动作实现 ───────────────

    /** 把 building 名解析成 meta 实例；未知 → 2001 */
    resolveBuilding(root, buildingId) {
        const table = this.ensureBuildingTables();
        // 别名宽容：把 "underground_belt"/"undergroundbelt" 之类归一
        const norm = s => String(s).toLowerCase().replace(/[\s-]+/g, "_");
        const want = norm(buildingId);
        for (const id in table.byId) {
            if (norm(id) === want) return table.byId[id];
        }
        // 再放宽：去掉下划线比较
        const want2 = want.replace(/_/g, "");
        for (const id in table.byId) {
            if (norm(id).replace(/_/g, "") === want2) return table.byId[id];
        }
        const available = Object.keys(table.byId).sort().join(", ");
        throw this.rpcError(2001, "invalid_action", "unknown building: " + buildingId, "Available: " + available);
    }

    /** 解析请求的变体（默认 / chainable / ...） */
    resolveVariant(root, meta, variantName) {
        if (variantName === undefined || variantName === null) return "default";
        const want = String(variantName);
        if (want === "default") return "default";
        // 校验该建筑是否支持
        if (meta.getAvailableVariants) {
            try {
                const avail = meta.getAvailableVariants(root);
                if (Array.isArray(avail) && avail.includes(want)) return want;
            } catch (e) {
                /* fallthrough */
            }
        }
        // 宽容：直接返回让游戏自己判
        return want;
    }

    /**
     * 放一个建筑。返回放置后的 entity 或 null。
     * 参照游戏自身 HUDBuildingPlacerLogic.tryPlaceCurrentBuildingAt 的调用形态：
     *   computeOptimalDirectionAndRotationVariantAtTile({root, tile, rotation, variant, layer})
     *   logic.tryPlaceBuilding({origin, rotation, rotationVariant, originalRotation, building, variant})
     *
     * rotationVariantOverride：蓝图粘贴专用。带子的弯道变体（直/左转/右转）在游戏里由
     * 邻居派生（belt.js computeOptimalDirectionAndRotationVariantAtTile），这使粘贴结果
     * 依赖邻居是否已就位。蓝图里的 code 已经带了正确的 rotationVariant，粘贴时应当直接采用。
     * 传 null（默认）→ 保持原有"自动定向"行为；传数字 → 强制使用该值。
     */
    placeOne(root, meta, x, y, rotation, variant, rotationVariantOverride = null, originalRotationOverride = null) {
        const Vector = this.VectorCtor(root);
        const origin = new Vector(x, y);
        const rot = this.normalizeRotation(rotation);
        let optimal;
        if (rotationVariantOverride !== null) {
            optimal = { rotation: rot, rotationVariant: rotationVariantOverride };
        } else {
            optimal = { rotation: rot, rotationVariant: 0 };
            try {
                if (meta.computeOptimalDirectionAndRotationVariantAtTile) {
                    optimal = meta.computeOptimalDirectionAndRotationVariantAtTile({
                        root,
                        tile: origin,
                        rotation: rot,
                        variant,
                        layer: meta.getLayer(),
                    });
                }
            } catch (e) {
                /* 保住默认值 */
            }
        }
        const entity = root.logic.tryPlaceBuilding({
            origin,
            rotation: optimal.rotation,
            rotationVariant: optimal.rotationVariant,
            // v2 蓝图可给出真实 originalRotation；缺省仍是 rot（历史语义）
            originalRotation: originalRotationOverride === null ? rot : this.normalizeRotation(originalRotationOverride),
            building: meta,
            variant,
        });
        if (entity) {
            // 与游戏原生放置一致：dispatch entityManuallyPlaced，
            // 让监听它的系统（地下带 stale-area、常量信号初始化等）正确重算。
            try {
                root.signals.entityManuallyPlaced.dispatch(entity);
            } catch (e) {
                /* 信号监听器异常不应影响放置结果 */
            }
        }
        return entity || null;
    }

    VectorCtor(root) {
        // 从已知实体反推 Vector 构造器；游戏未进世界时兜底用 window.shapez.Vector
        const shapez = /** @type {any} */ (window).shapez;
        return shapez.Vector;
    }

    normalizeRotation(r) {
        let v = Number(r);
        if (!Number.isFinite(v)) return 0;
        v = Math.round(v / 90) * 90;
        v = ((v % 360) + 360) % 360;
        return v;
    }

    /** 校验并规范化动作对象（未知字段 → 2001） */
    validateAction(a) {
        if (a === null || typeof a !== "object" || Array.isArray(a)) {
            throw this.rpcError(2001, "invalid_action", "action must be an object");
        }
        if (typeof a.op !== "string") {
            throw this.rpcError(2001, "invalid_action", "action.op must be a string");
        }
        const specs = this.actionSpecs();
        const spec = specs[a.op];
        if (!spec) {
            throw this.rpcError(2001, "invalid_action", "unknown op: " + a.op, "Allowed: " + Object.keys(specs).sort().join(", "));
        }
        for (const k in a) {
            if (k === "op") continue;
            if (!spec.fields.has(k)) {
                // 只读 op 不认识的字段：报错（协议要求"未知字段报错而不是忽略"）
                throw this.rpcError(
                    2001,
                    "invalid_action",
                    `unknown field '${k}' for op '${a.op}'`,
                    "Allowed fields: " + ["op", ...spec.fields].join(", ")
                );
            }
        }
        return spec;
    }

    actionSpecs() {
        // 每个 op 的允许字段集合（协议 §5）
        return {
            noop: { fields: new Set([]) },
            place: { fields: new Set(["building", "x", "y", "r", "variant"]) },
            place_path: { fields: new Set(["building", "from", "to", "r", "variant"]) },
            delete: { fields: new Set(["x", "y", "layer"]) },
            bulk_delete: { fields: new Set(["region", "layer", "dry_run"]) },
            paste_blueprint: { fields: new Set(["text", "x", "y", "charge", "dry_run"]) },
            export_blueprint: { fields: new Set(["region"]) },
            set_speed: { fields: new Set(["speed"]) },
            step: { fields: new Set(["ticks", "collect"]) },
            await: { fields: new Set(["until", "timeout_ticks", "chunk", "collect"]) },
            camera: { fields: new Set(["x", "y", "zoom"]) },
            save: { fields: new Set([]) },
            load: { fields: new Set(["internal_id"]) },
            new_game: { fields: new Set(["game_mode"]) },
        };
    }

    /** 单动作分发。所有 op 在此处进入。 */
    async performAction(a) {
        // 无世界时：noop/status 类也要能工作，但涉及世界的都要 1003
        const spec = this.validateAction(a);
        const root = this.root;
        switch (a.op) {
            case "noop":
                return { ok: true, op: "noop" };
            case "camera":
                this.requireRoot();
                return this.opCamera(root, a);
            case "export_blueprint":
                this.requireRoot();
                return this.opExportBlueprint(root, a);
            case "save":
                this.assertWritable("save");
                return await this.saveNow();
            case "load":
                this.assertWritable("load");
                return await this.loadSave({ internal_id: a.internal_id });
            case "new_game":
                this.assertWritable("new_game");
                return await this.newGame({ game_mode: a.game_mode });
            case "step":
                this.requireRoot();
                this.assertWritable("step");
                this.assertSteppable();
                return this.opStep(root, a);
            case "await":
                this.requireRoot();
                this.assertWritable("await");
                this.assertSteppable();
                return this.opAwait(root, a);
            case "set_speed":
                this.requireRoot();
                this.assertWritable("set_speed");
                return this.opSetSpeed(root, a);
            case "place":
                this.requireRoot();
                this.assertWritable("place");
                return this.opPlace(root, a);
            case "place_path":
                this.requireRoot();
                this.assertWritable("place_path");
                return this.opPlacePath(root, a);
            case "delete":
                this.requireRoot();
                this.assertWritable("delete");
                return this.opDelete(root, a);
            case "bulk_delete":
                this.requireRoot();
                this.assertWritable("bulk_delete");
                return this.opBulkDelete(root, a);
            case "paste_blueprint":
                this.requireRoot();
                this.assertWritable("paste_blueprint");
                return this.opPasteBlueprint(root, a);
            default:
                throw this.rpcError(2001, "invalid_action", "unhandled op: " + a.op);
        }
    }

    async performBatch(p) {
        if (p === null || typeof p !== "object" || !Array.isArray(p.actions)) {
            throw this.rpcError(2001, "invalid_action", "batch requires {actions: [...]}");
        }
        if (p.actions.length > 5000) {
            throw this.rpcError(2001, "invalid_action", "batch too large (max 5000)");
        }
        for (const k in p) {
            if (k !== "actions") {
                throw this.rpcError(2001, "invalid_action", "unknown batch field: " + k);
            }
        }
        const results = [];
        for (const a of p.actions) {
            try {
                const r = await this.performAction(a);
                results.push(Object.assign({ ok: true }, r));
            } catch (err) {
                if (err && err.__rpcError) {
                    results.push({
                        ok: false,
                        op: a && a.op,
                        error: { code: err.__rpcError.code, code_name: err.__rpcError.name, detail: err.__rpcError.detail },
                    });
                    // 硬错误（1003/1004）中断后续动作，避免无意义重复
                    if (err.__rpcError.code === 1003 || err.__rpcError.code === 1004) {
                        break;
                    }
                } else {
                    results.push({ ok: false, op: a && a.op, error: { code: 2003, code_name: "mod_error", detail: String(err) } });
                }
            }
        }
        return { results };
    }

    // ─────────────── 具体 op 实现 ───────────────

    opCamera(root, a) {
        const { x, y, zoom } = a;
        if (typeof x !== "number" || typeof y !== "number") {
            throw this.rpcError(2001, "invalid_action", "camera requires numeric x,y");
        }
        const Vector = this.VectorCtor(root);
        try {
            if (root.camera.setDesiredCenter) {
                root.camera.setDesiredCenter(new Vector(x, y));
            } else {
                root.camera.center = new Vector(x, y);
            }
            if (typeof zoom === "number") {
                if (!(zoom > 0) || zoom > 10) throw this.rpcError(2001, "invalid_action", "zoom out of range (0,10]");
                if (root.camera.setDesiredZoom) root.camera.setDesiredZoom(zoom);
                else root.camera.zoomLevel = zoom;
            }
        } catch (e) {
            if (e && e.__rpcError) throw e;
            throw this.rpcError(2003, "mod_error", "camera move failed: " + e);
        }
        return { ok: true, op: "camera" };
    }

    opPlace(root, a) {
        this.requireInt(a.x, "x");
        this.requireInt(a.y, "y");
        const meta = this.resolveBuilding(root, a.building);
        const variant = this.resolveVariant(root, meta, a.variant);
        const rot = this.normalizeRotation(a.r === undefined ? 0 : a.r);
        const entity = this.placeOne(root, meta, a.x, a.y, rot, variant);
        if (!entity) {
            const hint = this.describeTileOccupant(root, a.x, a.y);
            throw this.rpcError(2002, "game_rejected", "cannot place " + a.building + " at (" + a.x + "," + a.y + ")", hint);
        }
        return {
            ok: true,
            op: "place",
            entity_uid: entity.uid,
            type: meta.getId(),
            applied: 1,
            failed: [],
            tick: root.time.now(),
        };
    }

    opPlacePath(root, a) {
        const from = a.from;
        const to = a.to;
        if (
            !Array.isArray(from) ||
            !Array.isArray(to) ||
            from.length !== 2 ||
            to.length !== 2 ||
            !from.every(Number.isInteger) ||
            !to.every(Number.isInteger)
        ) {
            throw this.rpcError(2001, "invalid_action", "from/to must be integer [x,y]");
        }
        const dx = to[0] - from[0];
        const dy = to[1] - from[1];
        if (dx !== 0 && dy !== 0) {
            throw this.rpcError(
                2001,
                "invalid_action",
                "place_path supports axis-aligned lines only (dx=0 or dy=0)",
                "Use multiple place_path calls for L-shapes, or paste_blueprint"
            );
        }
        if (dx === 0 && dy === 0) {
            throw this.rpcError(2001, "invalid_action", "from and to are the same tile");
        }
        const len = Math.abs(dx) + Math.abs(dy) + 1;
        if (len > 5000) {
            throw this.rpcError(2001, "invalid_action", "path too long (max 5000 tiles)");
        }
        const meta = this.resolveBuilding(root, a.building);
        const variant = this.resolveVariant(root, meta, a.variant);

        // 方向语义（实测自真实存档 + 游戏源码 enumDirectionToAngle）：
        // rotation = 前进方向；top:0, right:90, bottom:180, left:270。
        let rot;
        if (a.r !== undefined && a.r !== null) {
            rot = this.normalizeRotation(a.r);
        } else if (dx > 0) rot = 90;
        else if (dx < 0) rot = 270;
        else if (dy > 0) rot = 180;
        else rot = 0;

        const sx = Math.sign(dx);
        const sy = Math.sign(dy);
        const failed = [];
        let applied = 0;
        let firstUid = null;
        root.logic.performBulkOperation(() => {
            for (let i = 0; i < len; ++i) {
                const x = from[0] + sx * i;
                const y = from[1] + sy * i;
                const entity = this.placeOne(root, meta, x, y, rot, variant);
                if (entity) {
                    applied++;
                    if (firstUid === null) firstUid = entity.uid;
                } else {
                    failed.push({ x, y, reason: "game_rejected", hint: this.describeTileOccupant(root, x, y) });
                }
            }
        });
        if (applied === 0) {
            throw this.rpcError(
                2002,
                "game_rejected",
                "place_path placed 0 of " + len + " tiles",
                failed.length ? failed[0].hint : "Check start tile and building unlock status"
            );
        }
        return {
            ok: true,
            op: "place_path",
            applied,
            failed,
            first_uid: firstUid,
            tick: root.time.now(),
        };
    }

    describeTileOccupant(root, x, y) {
        try {
            const ent = root.map.getLayerContentXY(x, y, "regular");
            if (!ent) return "Tile is free — placement likely failed for another reason (unlock level? cost? layer?)";
            const table = this.ensureBuildingTables();
            const sme = ent.components.StaticMapEntity;
            const info = table.byCode[sme.code];
            return "Tile occupied by " + (info ? info.buildingId : "code_" + sme.code) + " (uid " + ent.uid + ", rot " + sme.rotation + ")";
        } catch (e) {
            return "Could not inspect tile: " + e;
        }
    }

    opDelete(root, a) {
        this.requireInt(a.x, "x");
        this.requireInt(a.y, "y");
        const layer = a.layer || "regular";
        if (layer !== "regular" && layer !== "wires") {
            throw this.rpcError(2001, "invalid_action", "layer must be regular|wires");
        }
        const ent = root.map.getLayerContentXY(a.x, a.y, layer);
        if (!ent) {
            throw this.rpcError(2002, "game_rejected", "nothing to delete at (" + a.x + "," + a.y + ")", "Tile is empty on layer " + layer);
        }
        const ok = root.logic.tryDeleteBuilding(ent);
        if (!ok) {
            throw this.rpcError(2002, "game_rejected", "delete rejected at (" + a.x + "," + a.y + ")", "Building may be non-removable (e.g. hub)");
        }
        return { ok: true, op: "delete", applied: 1, freed_uid: ent.uid, tick: root.time.now() };
    }

    opBulkDelete(root, a) {
        const region = a.region;
        if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isInteger)) {
            throw this.rpcError(2001, "invalid_action", "region must be integer [x0,y0,x1,y1]");
        }
        if (region[0] > region[2] || region[1] > region[3]) {
            throw this.rpcError(2001, "invalid_action", "region min must be <= max");
        }
        const area = (region[2] - region[0] + 1) * (region[3] - region[1] + 1);
        if (area > 1000000) {
            throw this.rpcError(2001, "invalid_action", "region too large (max 1e6 tiles)");
        }
        const layer = a.layer || "regular";
        if (layer !== "regular" && layer !== "wires" && layer !== "all") {
            throw this.rpcError(2001, "invalid_action", "layer must be regular|wires|all");
        }
        const toDelete = [];
        for (const e of root.entityMgr.entities) {
            if (!e || !e.components || !e.components.StaticMapEntity) continue;
            if (e.queuedForDestroy || e.destroyed) continue;
            if (layer !== "all" && (e.layer || "regular") !== layer) continue;
            const o = e.components.StaticMapEntity.origin;
            if (o.x >= region[0] && o.x <= region[2] && o.y >= region[1] && o.y <= region[3]) {
                toDelete.push(e);
            }
        }

        // dry_run：只报告将被删除的对象，不执行。
        // 存在的理由：区域边界算错一格就会误删真实工厂（实测发生过 4 次），
        // 调用方应当先 dry_run 核对清单，再真正删除。
        if (a.dry_run === true) {
            const table = this.ensureBuildingTables();
            const items = toDelete.map(e => {
                const sme = e.components.StaticMapEntity;
                const info = table.byCode[sme.code];
                return {
                    uid: e.uid,
                    x: sme.origin.x,
                    y: sme.origin.y,
                    type: info ? info.buildingId : "code_" + sme.code,
                    rotation: sme.rotation,
                };
            });
            const byType = {};
            for (const it of items) byType[it.type] = (byType[it.type] || 0) + 1;
            return {
                ok: true,
                op: "bulk_delete",
                dry_run: true,
                would_delete: items.length,
                by_type: byType,
                items,
                tick: root.time.now(),
            };
        }

        let removed = 0;
        const failed = [];
        root.logic.performBulkOperation(() => {
            for (const e of toDelete) {
                if (root.logic.tryDeleteBuilding(e)) removed++;
                else {
                    const sme = e.components.StaticMapEntity;
                    failed.push({ x: sme.origin.x, y: sme.origin.y, uid: e.uid, reason: "rejected" });
                }
            }
        });
        return { ok: true, op: "bulk_delete", applied: removed, failed, tick: root.time.now() };
    }

    opSetSpeed(root, a) {
        const want = a.speed;
        const shapez = /** @type {any} */ (window).shapez;
        let Ctor;
        if (want === "paused") Ctor = shapez.PausedGameSpeed;
        else if (want === "regular") Ctor = shapez.RegularGameSpeed;
        else if (want === "fast_forward") Ctor = shapez.FastForwardGameSpeed;
        else {
            throw this.rpcError(2001, "invalid_action", "speed must be paused|regular|fast_forward");
        }
        if (!Ctor) throw this.rpcError(2003, "mod_error", "speed class not exported: " + want);
        const current = root.time.getSpeed().getId();
        const target = want === "fast_forward" ? "fast-forward" : want;
        if (current !== target) {
            root.time.setSpeed(new Ctor(root));
        }
        return { ok: true, op: "set_speed", speed: want, tick: root.time.now() };
    }

    /**
     * 无渲染同步快进 N 逻辑 tick。
     * 复刻游戏自身 puzzle 校验循环（bundle.pretty.js _startReview）：
     *   time.performTicks(deltaMs, core.boundInternalTick) 每次消费一个 deltaMs 预算 → 跑一次 updateLogic。
     * 注意 performTicks 在 speed=paused 时不推进（timeMultiplier=0），且 hud 暂停时预算清零。
     */
    stepTicks(root, ticks) {
        if (!Number.isInteger(ticks) || ticks < 1 || ticks > MAX_STEP_TICKS) {
            throw this.rpcError(2001, "invalid_action", "ticks must be int in [1, " + MAX_STEP_TICKS + "]");
        }
        if (root.hud.shouldPauseGame()) {
            // 2002 game_rejected（不是 2003 mod_error）：世界状态不允许推进，
            // 调用方应"关掉对话框再试"，属于需重新规划的状态问题（红队指出的语义误用）。
            throw this.rpcError(
                2002,
                "game_rejected",
                "game logic is paused by an open dialog/overlay; step would not advance",
                "Close the in-game dialog (or avoid opening menus) and retry"
            );
        }
        const shapez = /** @type {any} */ (window).shapez;
        const deltaMs = root.dynamicTickrate.deltaMs;
        const core = root.gameState && root.gameState.core;
        if (!core || !core.boundInternalTick) {
            throw this.rpcError(2003, "mod_error", "game core not ready");
        }
        const prevSpeed = root.time.getSpeed();
        const wasPaused = prevSpeed.getId() === "paused";
        if (wasPaused) {
            root.time.setSpeed(new shapez.RegularGameSpeed(root));
        }
        const t0 = performance.now();
        const tick0 = root.time.now();
        try {
            for (let i = 0; i < ticks; ++i) {
                root.time.performTicks(deltaMs, core.boundInternalTick);
            }
        } finally {
            if (wasPaused) root.time.setSpeed(prevSpeed);
        }
        const wallMs = performance.now() - t0;
        const advanced = root.time.now() - tick0;
        // 真实 tick 数 = 逻辑时间增量 ÷ 每 tick 秒数。
        // 不能用调用次数：performTicks 每次按预算消费，paused 时一次调用推进 0 tick，
        // fast_forward（×3 时间乘数）时一次调用可推进多个 tick（红队发现）。
        const deltaSeconds = root.dynamicTickrate.deltaSeconds || 1 / 60;
        const actualTicks = Math.round(advanced / deltaSeconds);
        return { ticks_run: actualTicks, ticks_requested: ticks, ticks_advanced_seconds: advanced, wall_ms: Math.round(wallMs) };
    }

    opStep(root, a) {
        const ticks = a.ticks === undefined ? 60 : a.ticks;
        const collect = !!a.collect;
        const base = this.captureDiffBaseline(root);
        const out = this.stepTicks(root, ticks);
        const res = {
            ok: true,
            op: "step",
            ticks_run: out.ticks_run,
            ticks_requested: out.ticks_requested,
            ticks_advanced_seconds: out.ticks_advanced_seconds,
            wall_ms: out.wall_ms,
            tick: root.time.now(),
        };
        // 差分摘要：AI 无需再发一次观测即可知道推进是否有效（可省往返与 token）。
        const diff = this.computeDiff(root, base);
        if (diff) res.diff = diff;
        if (collect) {
            res.observation = this.observe({ max_entities: 2000 });
        }
        return res;
    }

    opAwait(root, a) {
        const until = a.until;
        const VALID = ["hub_delivered_increased", "level_increased", "entities_changed"];
        if (!VALID.includes(until)) {
            throw this.rpcError(2001, "invalid_action", "until must be one of: " + VALID.join(", "));
        }
        const timeout = a.timeout_ticks === undefined ? 1200 : a.timeout_ticks;
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_STEP_TICKS * 5) {
            throw this.rpcError(2001, "invalid_action", "timeout_ticks must be int in [1, " + MAX_STEP_TICKS * 5 + "]");
        }
        const chunk = a.chunk === undefined ? 60 : a.chunk;
        if (!Number.isInteger(chunk) || chunk < 1 || chunk > MAX_STEP_TICKS) {
            throw this.rpcError(2001, "invalid_action", "chunk must be int in [1, " + MAX_STEP_TICKS + "]");
        }
        const baseline = this.awaitBaseline(root, until);
        const diffBase = this.captureDiffBaseline(root);
        let ticksRun = 0; // 请求量（预算视角）
        let actualTicks = 0; // 真实推进的 tick 数（stepTicks 回报）
        let met = false;
        const t0 = performance.now();
        while (ticksRun < timeout) {
            const n = Math.min(chunk, timeout - ticksRun);
            const stepOut = this.stepTicks(root, n);
            ticksRun += n;
            actualTicks += stepOut.ticks_run || 0;
            if (this.awaitCheck(root, until, baseline)) {
                met = true;
                break;
            }
        }
        const res = {
            ok: true,
            op: "await",
            until,
            met,
            timeout: !met,
            ticks_run: actualTicks,
            ticks_requested: ticksRun,
            wall_ms: Math.round(performance.now() - t0),
            tick: root.time.now(),
        };
        const diff = this.computeDiff(root, diffBase);
        if (diff) res.diff = diff;
        if (a.collect) {
            res.observation = this.observe({ max_entities: 2000 });
        }
        return res;
    }

    awaitBaseline(root, until) {
        switch (until) {
            case "hub_delivered_increased":
                return { level: root.hubGoals.level, delivered: root.hubGoals.getCurrentGoalDelivered() };
            case "level_increased":
                return { level: root.hubGoals.level };
            case "entities_changed":
                return { count: root.entityMgr.entities.length };
        }
        return {};
    }

    /**
     * step/await 的差分摘要（借鉴 civ6-mcp 的 end_turn 模式）：
     * "这段时间里世界发生了什么" —— 交付数变化、等级变化、实体数变化、速度变化。
     * 让 AI 不必在快进后再发一次完整观测就能知道推进是否有效（省 token、省往返）。
     */
    captureDiffBaseline(root) {
        try {
            return {
                tick: root.time.now(),
                level: root.hubGoals.level,
                delivered: root.hubGoals.getCurrentGoalDelivered(),
                required: root.hubGoals.currentGoal ? root.hubGoals.currentGoal.required : null,
                entityCount: root.entityMgr.entities.length,
                speed: this.speedIdToName(root.time.getSpeed().getId()),
            };
        } catch (e) {
            return null;
        }
    }

    /** 与 captureDiffBaseline 配对；返回人类/AI 可读的增量字段。 */
    computeDiff(root, base) {
        if (!base) return null;
        try {
            const now = this.captureDiffBaseline(root);
            if (!now) return null;
            const diff = {
                ticks_elapsed: Math.round((now.tick - base.tick) * 10) / 10,
                delivered_delta: now.delivered - base.delivered,
                entities_delta: now.entityCount - base.entityCount,
                level_changed: now.level !== base.level,
                level: now.level,
            };
            if (now.level !== base.level) diff.level_from = base.level;
            if (now.required !== null) {
                diff.delivered = now.delivered;
                diff.required = now.required;
            }
            return diff;
        } catch (e) {
            return null;
        }
    }

    awaitCheck(root, until, baseline) {
        switch (until) {
            case "hub_delivered_increased":
                // 升级会让 delivered 归零/从头计；跨级也算推进
                return (
                    root.hubGoals.level > baseline.level ||
                    (root.hubGoals.level === baseline.level && root.hubGoals.getCurrentGoalDelivered() > baseline.delivered)
                );
            case "level_increased":
                return root.hubGoals.level > baseline.level;
            case "entities_changed":
                return root.entityMgr.entities.length !== baseline.count;
        }
        return false;
    }

    requireInt(v, name) {
        if (!Number.isInteger(v)) {
            throw this.rpcError(2001, "invalid_action", name + " must be an integer");
        }
    }

    // ─────────────── 蓝图（SZBP1，协议 §6） ───────────────

    /**
     * 蓝图文本格式：`SZBP1.` + LZString-URI-safe 压缩的 JSON
     * JSON: {"v":1,"gv":"1.5.6","w":[minx,miny],"e":[code,dx,dy,rot, ...]}
     * 压缩用游戏自带的 compressX64（与存档同一算法，已验证与 npm lz-string 互通）。
     */
    opExportBlueprint(root, a) {
        const region = a.region;
        if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isInteger)) {
            throw this.rpcError(2001, "invalid_action", "region must be integer [x0,y0,x1,y1]");
        }
        if (region[0] > region[2] || region[1] > region[3]) {
            throw this.rpcError(2001, "invalid_action", "region min must be <= max");
        }
        const picks = [];
        for (const e of root.entityMgr.entities) {
            if (!e || !e.components || !e.components.StaticMapEntity) continue;
            if (e.queuedForDestroy || e.destroyed) continue;
            const sme = e.components.StaticMapEntity;
            if (this.entityIntersectsRegion(e, region)) {
                picks.push({ code: sme.code, x: sme.origin.x, y: sme.origin.y, rot: sme.rotation, orig: sme.originalRotation });
            }
        }
        if (picks.length === 0) {
            throw this.rpcError(2002, "game_rejected", "region contains no buildings", "Nothing to export");
        }
        if (picks.length > 5000) {
            throw this.rpcError(2002, "game_rejected", "too many buildings in region (max 5000)", "Split the region");
        }
        let minX = Infinity;
        let minY = Infinity;
        for (const p of picks) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
        }
        const flat = [];
        for (const p of picks) {
            flat.push(p.code, p.x - minX, p.y - minY, p.rot);
        }
        // v2：平行数组 o 承载每格的 originalRotation（带子事后重算以它为基准，belt.js:160）。
        // 缺它时「导出→贴到别处」或「贴完在拐角旁补一格」会让拐角翻向（P7-F2 实机取证）。
        const origs = picks.map(p => (typeof p.orig === "number" ? p.orig : p.rot));
        const payload = { v: 2, gv: this.gameVersion(), w: [minX, minY], e: flat, o: origs };
        const json = JSON.stringify(payload);
        const shapez = /** @type {any} */ (window).shapez;
        const text = "SZBP1." + shapez.compressX64(json);
        return {
            ok: true,
            op: "export_blueprint",
            text,
            count: picks.length,
            anchor: [minX, minY],
            region,
            tick: root.time.now(),
        };
    }

    opPasteBlueprint(root, a) {
        const text = a.text;
        if (typeof text !== "string" || !text.startsWith("SZBP1.")) {
            throw this.rpcError(2001, "invalid_action", "blueprint text must start with SZBP1.");
        }
        this.requireInt(a.x, "x");
        this.requireInt(a.y, "y");
        const charge = a.charge === undefined ? "auto" : a.charge;
        if (charge !== "auto" && charge !== false && charge !== true) {
            throw this.rpcError(2001, "invalid_action", 'charge must be "auto", true or false');
        }
        const shapez = /** @type {any} */ (window).shapez;
        let payload;
        try {
            const json = shapez.decompressX64(text.slice(6));
            payload = JSON.parse(json);
        } catch (e) {
            throw this.rpcError(2001, "invalid_action", "blueprint text is corrupted: " + e);
        }
        if (!payload || (payload.v !== 1 && payload.v !== 2) || !Array.isArray(payload.e) || payload.e.length % 4 !== 0) {
            throw this.rpcError(2001, "invalid_action", "blueprint payload malformed (expect v1|v2 e[code,dx,dy,rot,...])");
        }
        // v2：可选的平行数组 o（每格 originalRotation）。长度必须严格对齐 ——
        // 长度不符宁可拒，也不静默截断/错位（stride=5 的静默错位事故就是这么来的）。
        if (payload.o !== undefined) {
            if (!Array.isArray(payload.o) || payload.o.length !== payload.e.length / 4) {
                throw this.rpcError(
                    2001,
                    "invalid_action",
                    "blueprint payload malformed: o.length must equal entity count"
                );
            }
        }
        if (payload.gv !== this.gameVersion()) {
            throw this.rpcError(
                2006,
                "blueprint_incompatible",
                "blueprint was exported from game version " + payload.gv + ", current is " + this.gameVersion(),
                "Re-export the blueprint with this game version"
            );
        }
        const table = this.ensureBuildingTables();
        const count = payload.e.length / 4;

        // 解析条目一次（真粘贴与 dry_run 共用）
        const items = [];
        for (let i = 0; i < count; ++i) {
            items.push({
                code: payload.e[i * 4],
                dx: payload.e[i * 4 + 1],
                dy: payload.e[i * 4 + 2],
                rot: payload.e[i * 4 + 3],
            });
        }

        // dry_run：只预检不落地。存在的理由（实机取证 facts/... → live/results/belt-silent-overwrite.json）：
        // 真粘贴落在既有 belt/wire 上会「静默替换」——旧 uid 消失、响应 failed:[]、零报告；
        // 落在既有机器上则整条目失败（碰撞拒）但其它条目照常。调用方必须先 dry_run 核对。
        if (a.dry_run === true) {
            const blocked = [];
            const destroys = [];
            const unknownCode = [];
            const wouldApplyCells = [];
            const seen = new Set();
            const bbox = { x0: null, y0: null, x1: null, y1: null };
            for (const it of items) {
                const wx = a.x + it.dx, wy = a.y + it.dy;
                const info = table.byCode[it.code];
                const key = wx + "," + wy;
                const dup = seen.has(key);
                seen.add(key);
                const kind = info ? info.buildingId : "code_" + it.code;
                if (!info) unknownCode.push({ code: it.code, cell: [wx, wy], dx: it.dx, dy: it.dy });
                if (bbox.x0 === null) { bbox.x0 = bbox.x1 = wx; bbox.y0 = bbox.y1 = wy; }
                else {
                    if (wx < bbox.x0) bbox.x0 = wx; else if (wx > bbox.x1) bbox.x1 = wx;
                    if (wy < bbox.y0) bbox.y0 = wy; else if (wy > bbox.y1) bbox.y1 = wy;
                }
                // 占用检查逐格（非 belt 建筑占 origin+1 区格 —— getTileSpaceBounds 语义）
                const cells = [[wx, wy]];
                if (info && info.metaInstance && info.metaInstance.getDimensions) {
                    try {
                        const dim = info.metaInstance.getDimensions(info.variant);
                        const w = it.rot === 90 || it.rot === 270 ? dim.y : dim.x;
                        const h = it.rot === 90 || it.rot === 270 ? dim.x : dim.y;
                        for (let cx = 0; cx < w; cx++) for (let cy = 0; cy < h; cy++) {
                            if (!(cx === 0 && cy === 0)) cells.push([wx + cx, wy + cy]);
                        }
                    } catch (e) { /* 尺寸拿不到则只查 origin */ }
                }
                let rejectedHere = null;
                for (const [cx, cy] of cells) {
                    const ent = root.map.getLayerContentXY(cx, cy, "regular");
                    if (!ent) continue;
                    const sme = ent.components.StaticMapEntity;
                    const einfo = sme ? table.byCode[sme.code] : null;
                    const etype = einfo ? einfo.buildingId : "code_" + (sme ? sme.code : "?");
                    const replaceable = einfo && einfo.metaInstance && einfo.metaInstance.getIsReplaceable
                        ? einfo.metaInstance.getIsReplaceable(einfo.variant, einfo.rotationVariant)
                        : false;
                    if (replaceable) {
                        // belt/wire：真粘贴会销毁旧带替换 —— 如实报告，不阻断
                        destroys.push({ uid: ent.uid, cell: [cx, cy], type: etype });
                    } else {
                        rejectedHere = { cell: [cx, cy], occupant: { uid: ent.uid, type: etype }, reason: "solid collision" };
                        break;
                    }
                }
                if (rejectedHere) blocked.push({ dx: it.dx, dy: it.dy, cell: [wx, wy], kind, duplicateInPlan: dup, ...rejectedHere });
                else if (dup) blocked.push({ dx: it.dx, dy: it.dy, cell: [wx, wy], kind, duplicateInPlan: true, reason: "same cell twice in plan" });
                else wouldApplyCells.push({ cell: [wx, wy], kind });
            }
            const wouldDeleteUids = new Set(destroys.map(d => d.uid));
            // 成本也如实预演（不抛 2002 —— 预检的职责是报告，不是拒绝）
            const free0 = root.gameMode.getHasFreeCopyPaste();
            const charging0 = charge === true || (charge === "auto" && !free0);
            let cost0 = 0, have0 = null;
            if (charging0) {
                cost0 = this.blueprintCost(count);
                have0 = root.hubGoals.getShapesStoredByKey(root.gameMode.getBlueprintShapeKey());
            }
            return {
                ok: true,
                op: "paste_blueprint",
                dry_run: true,
                would_apply: wouldApplyCells.length,
                would_delete: wouldDeleteUids.size,
                destroys,
                blocked,
                unknown_code: unknownCode,
                count,
                bbox: [bbox.x0, bbox.y0, bbox.x1, bbox.y1],
                charge_preview: charging0
                    ? { cost: cost0, have: have0, affordable: have0 >= cost0 }
                    : { cost: 0, have: null, affordable: true },
                tick: root.time.now(),
            };
        }

        // 扣费预检（协议 §6）：先查材料，不足直接拒绝（不放置），与游戏「canAfford → tryPlace」顺序一致
        let cost = 0;
        const free = root.gameMode.getHasFreeCopyPaste();
        const shouldCharge = charge === true || (charge === "auto" && !free);
        const costKey = shouldCharge ? root.gameMode.getBlueprintShapeKey() : null;
        if (shouldCharge) {
            cost = this.blueprintCost(count);
            const have = root.hubGoals.getShapesStoredByKey(costKey);
            if (have < cost) {
                throw this.rpcError(
                    2002,
                    "game_rejected",
                    "not enough blueprint shapes: need " + cost + ", have " + have,
                    "Charge more " + costKey + " first, or call with charge:false (sandbox)"
                );
            }
        }

        const failed = [];
        let applied = 0;
        // 双层包裹，与游戏原生粘贴（blueprint.js:159）对齐：
        //   performBulkOperation   —— 批量语义（一次 undo、统一扣费）
        //   performImmutableOperation —— 关键：屏蔽 belt 系统的 updateSurroundingBeltPlacement
        //     （systems/belt.js:63 把它挂在 entityAdded 上；每放一格都会把**周围一圈**的带子按
        //      邻居重算 rv 并覆写 —— 唯一豁免是 immutableOperationRunning，belt.js:169）。
        //     没有它，蓝图里显式携带的 rotationVariant 会被"邻居派生"结果覆盖，
        //     粘贴结果依赖放置顺序 —— 这正是对抗审查定位的根因（review/ADVERSARIAL-REVIEW.md F1）。
        const placeAll = () => {
            for (let i = 0; i < count; ++i) {
                const code = payload.e[i * 4];
                const dx = payload.e[i * 4 + 1];
                const dy = payload.e[i * 4 + 2];
                const rot = payload.e[i * 4 + 3];
                const info = table.byCode[code];
                if (!info) {
                    failed.push({ dx, dy, reason: "unknown_code", code });
                    continue;
                }
                const entity = this.placeOne(
                    root,
                    info.metaInstance,
                    a.x + dx,
                    a.y + dy,
                    rot,
                    info.variant,
                    info.rotationVariant !== undefined ? info.rotationVariant : null,
                    // v2 的 o[i]：该格的真实 originalRotation。缺省（v1 / null）→ 用 rot，
                    // 与历史行为一致（bridge 过去把同一个值同时当 rotation 与 originalRotation）。
                    payload.o && payload.o[i] !== null && payload.o[i] !== undefined ? payload.o[i] : rot
                );
                if (entity) applied++;
                else failed.push({ dx, dy, reason: "game_rejected", code });
            }
        };
        if (root.logic.performImmutableOperation) {
            root.logic.performBulkOperation(() => root.logic.performImmutableOperation(placeAll));
        } else {
            root.logic.performBulkOperation(placeAll);   // 兼容旧版签名（理论上 1002 已挡）
        }

        // 只在有建筑真正落地时才扣费（与游戏一致：tryPlace 成功后 takeShapeByKey）
        if (shouldCharge && applied > 0) {
            root.hubGoals.takeShapeByKey(costKey, cost);
        }
        if (applied === 0) {
            throw this.rpcError(
                2002,
                "game_rejected",
                "blueprint placed 0 of " + count + " buildings",
                failed[0] ? JSON.stringify(failed[0]) : "Region blocked"
            );
        }
        return {
            ok: true,
            op: "paste_blueprint",
            applied,
            failed,
            count,
            cost,
            charged: shouldCharge && applied > 0,
            tick: root.time.now(),
        };
    }

    /**
     * 游戏蓝图成本公式的精确复刻：findNiceIntegerValue(4 * n^1.1)
     * = ceil(findNiceValue(4 * n^1.1))，findNiceValue 会把数值向下对齐到"友好"步长
     * （来源：bundle.pretty.js findNiceValue；用于观测里预告成本，与实际扣费完全相同）。
     */
    blueprintCost(n) {
        return Math.ceil(this.findNiceValue(4 * Math.pow(n, 1.1)));
    }

    findNiceValue(e) {
        if (e > 1e8) return e;
        if (e < 1e-5) return 0;
        let t = 1;
        if (e > 5e4) t = 1e4;
        else if (e > 2e4) t = 5e3;
        else if (e > 5e3) t = 1e3;
        else if (e > 2e3) t = 500;
        else if (e > 1e3) t = 100;
        else if (e > 100) t = 20;
        else if (e > 20) t = 5;
        const r = Math.floor(e / t) * t;
        if (e >= 10) return Math.round(r);
        if (e >= 1) return Math.round(10 * r) / 10;
        return Math.round(100 * r) / 100;
    }

    async screenshot(p) {
        const root = this.requireRoot();
        const scale = p.scale === undefined ? 1 : p.scale;
        if (typeof scale !== "number" || !(scale > 0) || scale > 1) {
            throw this.rpcError(2001, "invalid_action", "scale must be a number in (0,1]");
        }
        const canvas = root.canvas;
        if (!canvas || typeof canvas.toDataURL !== "function") {
            throw this.rpcError(2003, "mod_error", "game canvas is not available");
        }
        let src = canvas;
        let w = canvas.width;
        let h = canvas.height;
        if (scale < 1) {
            try {
                const c2 = document.createElement("canvas");
                c2.width = Math.max(1, Math.round(canvas.width * scale));
                c2.height = Math.max(1, Math.round(canvas.height * scale));
                const ctx = c2.getContext("2d");
                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(canvas, 0, 0, c2.width, c2.height);
                src = c2;
                w = c2.width;
                h = c2.height;
            } catch (e) {
                // 缩放失败不致命：退回原尺寸
                src = canvas;
                w = canvas.width;
                h = canvas.height;
            }
        }
        let url;
        try {
            url = src.toDataURL("image/png");
        } catch (e) {
            throw this.rpcError(2003, "mod_error", "canvas.toDataURL failed: " + e);
        }
        const comma = url.indexOf(",");
        const b64 = comma >= 0 ? url.slice(comma + 1) : url;
        return { png_base64: b64, w, h, scale };
    }

    // ─────────────── 存档 ───────────────

    async saveNow() {
        this.requireRoot();
        const gs = this.root.gameState;
        if (!gs || typeof gs.doSave !== "function") {
            throw this.rpcError(2003, "mod_error", "savegame interface not ready");
        }
        try {
            await gs.doSave();
        } catch (e) {
            throw this.rpcError(2003, "mod_error", "save failed: " + e);
        }
        const sg = gs.savegame;
        const out = { ok: true, op: "save_now", level: this.root.hubGoals.level, last_update: Date.now() };
        if (sg) {
            if (sg.internalId !== undefined) out.internal_id = sg.internalId;
            else if (sg.currentData && sg.currentData.internalId !== undefined) out.internal_id = sg.currentData.internalId;
        }
        return out;
    }

    listSaves() {
        const mgr = this.app.savegameMgr;
        let meta = [];
        try {
            meta = mgr.getSavegamesMetaData() || [];
        } catch (e) {
            meta = [];
        }
        const saves = [];
        for (const m of meta) {
            saves.push({
                internal_id: m.internalId !== undefined ? m.internalId : m.internal_id,
                level: m.level !== undefined ? m.level : null,
                last_update: m.lastUpdate !== undefined ? m.lastUpdate : null,
                version: m.version !== undefined ? m.version : null,
            });
        }
        return { saves };
    }

    async loadSave(p) {
        const id = p.internal_id;
        if (typeof id !== "string" || id.length < 3) {
            throw this.rpcError(2001, "invalid_action", "internal_id (string) is required");
        }
        const mgr = this.app.savegameMgr;
        const sg = mgr.getSavegameById(id);
        if (!sg) {
            throw this.rpcError(2002, "game_rejected", "no savegame with internal_id " + id, "Use list_saves to see available ids");
        }
        try {
            await sg.readAsync();
        } catch (e) {
            throw this.rpcError(2003, "mod_error", "failed to read savegame: " + e);
        }
        // 状态机拒绝重入同名状态（moveToState("InGameState") 在游戏中会失败），
        // 所以若当前已在游戏中，先回主菜单再进入目标存档。
        const cur = this.app.stateMgr.currentState;
        const curKey = cur && cur.getKey ? cur.getKey() : null;
        if (curKey === "InGameState") {
            if (this.root && this.root.gameState && this.root.gameState.saveThenGoToState) {
                this.root.gameState.saveThenGoToState("MainMenuState");
            } else {
                this.app.stateMgr.moveToState("MainMenuState");
            }
            const ok = await this.waitFor(
                () => this.app.stateMgr.currentState && this.app.stateMgr.currentState.getKey() === "MainMenuState",
                8000
            );
            if (!ok) {
                throw this.rpcError(2003, "mod_error", "timed out waiting to return to main menu before loading");
            }
        }
        this.app.stateMgr.moveToState("InGameState", { savegame: sg });
        return { ok: true, op: "load_save", internal_id: id, loading: true };
    }

    async newGame(p) {
        const mode = p.game_mode === undefined ? "regularMode" : p.game_mode;
        if (mode !== "regularMode") {
            throw this.rpcError(2001, "invalid_action", 'game_mode must be "regularMode"');
        }
        // 先回主菜单（若在游戏中）
        const cur = this.app.stateMgr.currentState;
        const curKey = cur && cur.getKey ? cur.getKey() : null;
        if (curKey === "InGameState" && this.root && this.root.gameState && this.root.gameState.saveThenGoToState) {
            this.root.gameState.saveThenGoToState("MainMenuState");
        } else if (curKey !== "MainMenuState") {
            this.app.stateMgr.moveToState("MainMenuState");
        }
        if (curKey !== "MainMenuState") {
            const ok = await this.waitFor(
                () => this.app.stateMgr.currentState && this.app.stateMgr.currentState.getKey() === "MainMenuState",
                8000
            );
            if (!ok) {
                throw this.rpcError(2003, "mod_error", "timed out waiting to return to main menu");
            }
        }
        let sg;
        try {
            sg = this.app.savegameMgr.createNewSavegame();
        } catch (e) {
            throw this.rpcError(2002, "game_rejected", "could not create savegame (slot limit?): " + e);
        }
        this.app.stateMgr.moveToState("InGameState", { savegame: sg, gameModeId: mode });
        return { ok: true, op: "new_game", game_mode: mode, internal_id: sg && sg.internalId ? sg.internalId : null };
    }

    waitFor(predicate, timeoutMs) {
        return new Promise(resolve => {
            const t0 = Date.now();
            const timer = setInterval(() => {
                let ok = false;
                try {
                    ok = !!predicate();
                } catch (e) {
                    ok = false;
                }
                if (ok) {
                    clearInterval(timer);
                    resolve(true);
                } else if (Date.now() - t0 > timeoutMs) {
                    clearInterval(timer);
                    resolve(false);
                }
            }, 100);
        });
    }
}


// 注册（modloader 会先 eval 本文件，再调用 $shapez_registerMod）
// 注意：Mod 与 METADATA 必须是全局标识符（由 modloader 的包装代码检测）。
