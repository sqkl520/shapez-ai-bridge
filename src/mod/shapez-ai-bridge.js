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
 * 会改世界的 op / method —— 它们必须在同一条串行链上（见 rpcTouchesWorld）。
 *
 * 这份清单是"谁需要排队"的**唯一**来源，新增写 op 时必须同步加进来；
 * test/mod_selftest.mjs 有一条测试把 actionSpecs() 与它对照，漏加会红。
 */
const RPC_WRITE_OPS = new Set([
    "place",
    "place_path",
    "delete",
    "bulk_delete",
    "paste_blueprint",
    "step",
    "await",
    "set_speed",
    "save",
    "load",
    "new_game",
]);
const RPC_WRITE_METHODS = new Set([
    "save_now",
    "load_save",
    "new_game",
    "delete_save",
    "repair_save",
    "upgrade",
    "game_setting",
    // debug_entity_roundtrip 会真的删一次再放回来 —— 它是写操作，必须与其它写操作串行，
    // 否则和 place/paste 交错时会拿到"删了一半"的世界。
    "debug_entity_roundtrip",
]);

/**
 * 还原报告挂在实体上的键（不可枚举 ⇒ 不进 JSON、不进 Object.keys，不污染存档/观测）。
 * 事务层用来知道"这个实体有哪些组件没被还原（payload 里有、实体上已不存在）"。
 *
 * ⚠️ 为什么不用 Symbol：Symbol 键在测试与外部诊断里拿不到，而这份报告正是
 * "哪些状态还原不了"的机器证据，必须可读。
 */
const RESTORE_REPORT_KEY = "__bridgeRestoreReport";

/**
 * 各建筑的 rotationVariant 合法档位 —— **仅在运行期注册表（gBuildingVariants）不可用时兜底**。
 * 与 src/ai/op-templates.mjs 的 RV_ALLOWED 同源（那里有源码+实机凭据）：
 *   · belt：rv 0/1/2 = 直/左弯/右弯（belt.js:25-43 的 internalId 1/2/3）；
 *   · underground_belt：rv 0/1 = sender/receiver（underground_belt.js:45-48）；
 *   · 其它机器（miner/cutter/rotater/stacker/mixer/painter/trash/hub）：注册表里只有 rv=0 的 code。
 * ⚠️ 这张表只回答"该建筑有哪些 rv 档位"，**不回答档位对应哪个 code** ——
 *    code 一律从运行中的注册表反查（见 ensureBuildingTables 的 rvByKey）。
 */
const RV_DOCUMENTED = Object.freeze({
    belt: [0, 1, 2],
    underground_belt: [0, 1],
});
const RV_DEFAULT_ALLOWED = Object.freeze([0]);

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
        this.installLogCapture();
        this.hookGameLifecycle();
        this.connect();
    }

    /**
     * 把游戏的 console 输出抄一份到环形缓冲里。
     *
     * 为什么需要它：游戏把几乎所有失败都写进 console —— 反序列化失败、资源加载失败、
     * 系统崩溃 —— 但渲染进程的 console 对 Mod 来说是只写不读的。于是"存档损坏"这类
     * 问题只能靠外部观察（截图、逐个解码存档）反推，代价极高。
     * 这里包一层 console.log/warn/error，只记录、不改行为、不改返回值，
     * 并限制条数与单条长度，避免长期运行把内存撑爆。
     */
    installLogCapture() {
        if (this._logCaptureInstalled) return;
        this._logCaptureInstalled = true;
        this._logRing = [];
        const MAX = 300;
        const wrapper = (level, original) => {
            const self = this;
            return function (...args) {
                try {
                    if (self._logRing) {
                        const line = args
                            .map(a => {
                                if (typeof a === "string") return a;
                                if (a instanceof Error) return a.message + "\n" + (a.stack || "");
                                try {
                                    return JSON.stringify(a);
                                } catch (e) {
                                    return String(a);
                                }
                            })
                            .join(" ");
                        self._logRing.push({ level, at: Math.round(performance.now()), line: line.slice(0, 2000) });
                        if (self._logRing.length > MAX) self._logRing.splice(0, self._logRing.length - MAX);
                    }
                } catch (e) {
                    /* 采集本身绝不能影响游戏 */
                }
                return original.apply(this, args);
            };
        };
        try {
            console.log = wrapper("log", console.log);
            console.warn = wrapper("warn", console.warn);
            console.error = wrapper("error", console.error);
        } catch (e) {
            this.warn("failed to install log capture:", e);
        }
    }

    /**
     * 诊断用：读回被截获的游戏日志。
     * params: { level?: "error"|"warn"|"all", lines?: number, grep?: string }
     */
    debugLog(params) {
        const p = params || {};
        const level = p.level || "all";
        const limit = Math.max(1, Math.min(300, Number.isInteger(p.lines) ? p.lines : 100));
        const grep = typeof p.grep === "string" && p.grep ? p.grep : null;
        let list = (this._logRing || []).slice();
        if (level !== "all") list = list.filter(e => e.level === level);
        if (grep) list = list.filter(e => e.line.toLowerCase().includes(grep.toLowerCase()));
        return {
            total_captured: (this._logRing || []).length,
            installed: !!this._logCaptureInstalled,
            returned: Math.min(list.length, limit),
            entries: list.slice(-limit),
        };
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
                    // 实体序列化还原原语（事务层前置）：serializeEntity / restoreEntity /
                    // deleteEntityByUid + debug_entity_roundtrip。声明出来，桥接侧才能
                    // 在功能不可用时 fail fast 而不是 2003。
                    "entity_snapshot",
                ],
            },
        });
    }

    /**
     * 一条 RPC 是否**会改世界**（因而必须与其它写操作、与状态切换互斥）。
     *
     * 为什么不能只按 method 名判断：`place` 走的是 method="act"，同一个 method
     * 里既有 `noop`/`camera`（几乎瞬时，挡它没意义）也有 `place`（改世界）。
     * 必须下钻到 op 级别。
     *
     * 分类依据是"这个调用一旦 await 让出，另一个调用插进来会不会读到不一致的世界"：
     *   · place / place_path / delete / bulk_delete / paste_blueprint —— 直接改地图
     *   · step / await —— 推进逻辑时钟，地图会被系统改写（带子重算、机器产量）
     *   · save —— 在 await 点会把**当时**的世界序列化（game doSave 内 updateData）
     *   · upgrade —— 扣库存、改写 hubGoals
     *   · set_speed —— 改时间倍率，影响别人的 step 语义
     *   · game_setting —— 改 app 级设置（隧道磁贴开关会改变粘贴/删除的语义）
     *   · load_save / new_game / delete_save / repair_save —— 换世界或动存档文件
     *   · batch —— 逐条看里面的 action
     * 其余（status/obs/screenshot/list_saves/...）是纯读，不排队。
     */
    rpcTouchesWorld(method, params) {
        if (method === "act") {
            const op = params && params.op;
            return RPC_WRITE_OPS.has(op);
        }
        if (method === "batch") {
            const actions = (params && params.actions) || [];
            return actions.some(a => a && RPC_WRITE_OPS.has(a.op));
        }
        return RPC_WRITE_METHODS.has(method);
    }

    /**
     * 把一次 RPC 排进串行链；链上任何一环抛错都不影响下一环。
     * 返回的 Promise 永远 resolve（错误由 handleRpc 内部转成 JSON-RPC error 回出去）。
     */
    enqueueOnChain(chainName, msg) {
        const prev = this[chainName] || Promise.resolve();
        const next = prev.then(
            () => this.handleRpc(msg),
            () => this.handleRpc(msg)
        );
        this[chainName] = next;
        return next;
    }

    handleBridgeMessage(msg) {
        // 桥接只发请求（带 id）或通知（无 id）。本 Mod 对未知 method 回 -32601。
        if (msg && msg.id !== undefined && msg.method !== undefined) {
            /* 所有**会改世界**的 RPC 走同一条链（worldChain），状态切换类也在这条链上。
               为什么状态切换也要进来：载荷顺序是 load_save 先到、place 后到。
               load_save 一进 handleRpc 就会 await（readAsync / waitFor），此时排在
               后面的 place 若走"立即执行"的路径，就会落到**旧世界**上 —— 而 load_save
               随后把那个世界换掉，place 已经回了 ok:true、实体却随着旧 root 一起消失。
               这正是"返回 ok 但实体没建出来"的形态。
               纯读 RPC 不进链：obs/status/screenshot 动辄几十毫秒，把读也堵在写后面
               会让 AI 的观测被无关的粘贴拖住（而且读本身不会破坏顺序）。
               链本身不排队"执行"，只排队"开始"：一个 place 是同步完成的（见
               opPlace → placeOne → logic.tryPlaceBuilding，全同步），它进链后立刻跑完，
               不会给后面的 RPC 增加延迟；只有真的需要 await 的写操作才占住链。*/
            if (this.rpcTouchesWorld(msg.method, msg.params)) {
                this.enqueueOnChain("worldChain", msg).catch(err => {
                    this.sendError(msg.id, 2003, "mod_error", String(err && err.stack ? err.stack : err));
                });
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
                case "debug_items":
                    result = this.debugItems(params || {});
                    break;
                case "debug_loop":
                    result = this.debugLoop();
                    break;
                case "debug_log":
                    result = this.debugLog(params || {});
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
                case "game_setting":
                    result = this.gameSetting(params || {});
                    break;
                case "upgrade":
                    result = this.upgrades(params || {});
                    break;
                case "delete_save":
                    result = await this.deleteSave(params || {});
                    break;
                case "repair_save":
                    result = await this.repairSave(params || {});
                    break;
                case "debug_speed_registry":
                    result = this.debugSpeedRegistry();
                    break;
                case "resources":
                    result = this.observeResources(params || {});
                    break;
                case "production":
                    result = this.observeProduction(params || {});
                    break;
                case "world_info":
                    result = this.worldInfo();
                    break;
                case "debug_canvas_api":
                    result = this.debugCanvasApi();
                    break;
                case "debug_app_state":
                    result = this.debugAppState();
                    break;
                case "debug_entity_roundtrip":
                    this.assertWritable("debug_entity_roundtrip");
                    result = this.debugEntityRoundtrip(params || {});
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

    /**
     * 读写游戏设置项（**白名单**，只放行与「安全粘贴」相关的几个）。
     *
     * 为什么需要它：`enableTunnelSmartplace` 开着时，落一个隧道 receiver 会**删掉**它与 sender
     * 之间的带子（`systems/underground_belt.js:53-66`，不检查 immutable）。我们的 paste 每格都
     * dispatch `entityManuallyPlaced`，于是含隧道的蓝图会在粘贴**过程中**被拆坏，而 `applied`
     * 仍显示成功。关掉这个开关后该回调第一行就 return，隧道可安全粘贴（源码确认）。
     *
     * 白名单而不是任意键：调用方是 AI/工具，不该能顺手改掉玩家的画面/音量/语言等设置。
     * 每次读写都回**当前实际值**（从 `app.settings.getAllSettings()` 重新取），
     * 不缓存 —— 玩家在 GUI 里手动改过之后，我们看到的必须是最新状态。
     *
     * params: { key?: string, value?: boolean|string|number }
     *   - 只给 key        → 读
     *   - 同时给 key/value → 写（写后回读，确认真的生效）
     *   - 都不给          → 列出白名单里所有项的当前值
     */
    /**
     * 读出**产线真实吞吐**（不是估算，不是净增量）。
     *
     * 为什么需要它：`obs` 只报实体、`hub.stored_shapes` 只报累计库存。
     * 于是"这条线到底跑不跑得动、慢在哪一段"只能靠整体净增量反推 ——
     * 而整体增量把多条线的产出混在一起，某个形状涨了也说不清是哪条线贡献的。
     * 这一整轮我因此在冻结的时钟上做了几小时错误判断。
     *
     * 数据源是游戏自带的 productionAnalytics.history：三路时间片
     * （produced / stored / delivered），每片 analyticsSliceDurationSeconds 秒
     * （正式版 10 秒），共 statisticsGraphSlices=100 片。
     * 它由游戏自己维护，不需要我们采样，也不会因为 step 快进而失真。
     *
     * params: { slices?: number }  取最近多少片（默认 6 = 最近 60 秒）
     */
    observeProduction(params) {
        const root = this.requireRoot();
        const p = params || {};
        const wantSlices = Number.isInteger(p.slices) && p.slices > 0 ? Math.min(p.slices, 100) : 6;
        const pa = root.productionAnalytics;
        if (!pa || !pa.history) {
            throw this.rpcError(2003, "mod_error", "productionAnalytics is not available");
        }
        const sliceSecs = 10; // config.analyticsSliceDurationSeconds（正式版；dev 为 1）
        const grab = key => (pa.history[key] || []).slice(-wantSlices);
        const produced = grab("produced");
        const delivered = grab("delivered");
        const stored = grab("stored");

        // 按形状汇总最近 N 片，换成每秒速率
        const sum = slices => {
            const acc = {};
            for (const slice of slices) {
                for (const k in slice) acc[k] = (acc[k] || 0) + slice[k];
            }
            return acc;
        };
        const producedSum = sum(produced);
        const deliveredSum = sum(delivered);
        const windowSecs = wantSlices * sliceSecs;

        const toRates = totals => {
            const out = {};
            for (const k in totals) out[k] = Math.round((totals[k] / windowSecs) * 1000) / 1000;
            return out;
        };

        // 库存是快照而不是增量 —— 取首尾差
        const storedFirst = stored.length ? stored[0] : {};
        const storedLast = stored.length ? stored[stored.length - 1] : {};
        const storedDelta = {};
        for (const k of new Set([...Object.keys(storedFirst), ...Object.keys(storedLast)])) {
            storedDelta[k] = (storedLast[k] || 0) - (storedFirst[k] || 0);
        }

        return {
            window_seconds: windowSecs,
            slice_seconds: sliceSecs,
            slices_returned: produced.length,
            produced_total: producedSum,
            produced_per_sec: toRates(producedSum),
            delivered_total: deliveredSum,
            delivered_per_sec: toRates(deliveredSum),
            stored_delta: storedDelta,
            // 每片原始数据，便于看趋势（某片突然归零 = 那一刻断了）
            produced_slices: produced,
            delivered_slices: delivered,
        };
    }

    /**
     * 读出这张地图的**身份**：种子、尺寸、hub 精确格位。
     *
     * 为什么需要它：离线编译器（`src/ai/compiler/`）复现矿图靠的是
     * `world.mjs` 里按 seed 重算 chunk。默认 seed 是 43391（level-11 存档的值），
     * 一旦在别的存档上用，矿机就落在一块空地上了 —— 而且编译照样 `ok:true`。
     * 实测过：当前 level-4 存档的 22 格钌矿里，seed 43391 只认 8 格。
     *
     * 所以"编译器能看懂当前局面"的第一步，是把真实的 seed 交出去。
     */
    worldInfo() {
        const root = this.requireRoot();
        let seed = null;
        try { seed = root.map && root.map.seed; } catch (e) { seed = null; }
        if (typeof seed !== "number") seed = null;
        const out = { seed, game_version: null, hub: null };
        try {
            out.game_version = (root.app && root.app.version && root.app.version.current) || null;
        } catch (e) { /* 忽略 */ }
        // hub 的 origin 就在 (0,0)（core.js 里 hub 固定建在原点），但不去猜 —— 扫一遍实体
        try {
            const table = this.ensureBuildingTables();
            const entities = (root.entityMgr && root.entityMgr.entities) || [];
            for (const ent of entities) {
                const obs = this.entityToObs(ent, table);
                if (obs && obs.type === "hub") {
                    // 实体的 x/y 是**左上角**（origin），hub 是 4×4，所以右下角是 +3
                    out.hub = { x: obs.x, y: obs.y, w: 4, h: 4, rotation: obs.r, uid: obs.uid };
                    break;
                }
            }
        } catch (e) {
            out.hub_error = String(e && e.message ? e.message : e);
        }
        return out;
    }

    /**
     * 读出地图上的**自然资源分布**（矿点）。
     *
     * 为什么需要它：`obs` 只报实体（建筑），矿石不是实体 —— 它在地图的下层
     * （map lower layer）。结果就是 AI 完全看不见地图上有什么可挖的，
     * 只能按"已知固定坐标"去猜，猜错了就整条线建在空气上。
     * 真实的规划必须建立在"哪里有矿、有几格"之上，而不是我脑子里的常量表。
     *
     * params: { region: [x0,y0,x1,y1] }  省略则用当前相机附近
     * 返回：按资源键聚合的矿点列表 + 每个资源的总格数
     */
    observeResources(params) {
        const root = this.requireRoot();
        const p = params || {};
        let region = p.region;
        if (!Array.isArray(region) || region.length !== 4) {
            // 默认：以 hub 为中心 80×80 的方块
            region = [-40, -40, 40, 40];
        }
        const [x0, y0, x1, y1] = region;
        const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
        const ay = Math.min(y0, y1), by = Math.max(y0, y1);
        // 上限保护：一次扫太多会卡住主线程
        const MAX_TILES = 40000;
        if ((bx - ax + 1) * (by - ay + 1) > MAX_TILES) {
            throw this.rpcError(2001, "invalid_action",
                "region too large (" + ((bx - ax + 1) * (by - ay + 1)) + " tiles, max " + MAX_TILES + ")");
        }
        const byResource = {};
        let total = 0;
        for (let y = ay; y <= by; ++y) {
            for (let x = ax; x <= bx; ++x) {
                let item = null;
                try {
                    item = root.map.getLowerLayerContentXY(x, y);
                } catch (e) {
                    item = null;
                }
                if (!item) continue;
                let key;
                try {
                    key = item.getAsCopyableKey ? item.getAsCopyableKey() : String(item);
                } catch (e) {
                    key = "unknown";
                }
                if (!byResource[key]) byResource[key] = { key, count: 0, cells: [] };
                byResource[key].count++;
                byResource[key].cells.push([x, y]);
                total++;
            }
        }
        // 每格都列会很大，给每个资源一个紧凑的矩形框 + 每行连续段
        const out = [];
        for (const key of Object.keys(byResource)) {
            const r = byResource[key];
            let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
            for (const [x, y] of r.cells) {
                if (x < mnx) mnx = x; if (x > mxx) mxx = x;
                if (y < mny) mny = y; if (y > mxy) mxy = y;
            }
            // 每行连续段，便于看出"一行有几格可并排"
            const rows = {};
            for (const [x, y] of r.cells) (rows[y] = rows[y] || []).push(x);
            const runs = [];
            for (const yStr of Object.keys(rows)) {
                const xs = rows[yStr].sort((a, b) => a - b);
                let start = xs[0], prev = xs[0];
                for (let i = 1; i <= xs.length; ++i) {
                    if (i === xs.length || xs[i] !== prev + 1) {
                        runs.push({ y: Number(yStr), from: start, to: prev, len: prev - start + 1 });
                        start = xs[i]; prev = xs[i];
                    } else {
                        prev = xs[i];
                    }
                }
            }
            runs.sort((a, b) => b.y - a.y || a.from - b.from);
            out.push({ key, count: r.count, bbox: [mnx, mny, mxx, mxy], runs });
        }
        out.sort((a, b) => b.count - a.count);
        return {
            region: [ax, ay, bx, by],
            total_resource_tiles: total,
            resources: out,
        };
    }

    /**
     * 诊断用：读出**游戏速度**在序列化工厂里的注册情况。
     *
     * 为什么需要它：1.5.6 的发布包里 `initGameSpeedRegistry()` 只有一行 ——
     * `gGameSpeedRegistry.register(RegularGameSpeed)`，paused 与 fast-forward
     * 都「disabled for now」。后果是：一旦这两个 id 被写进存档（例如通过
     * set_speed），`SavegameSerializer.deserialize` 会报
     * `Invalid class id: fast-forward (factory is gamespeed)`，
     * 游戏随即判定「存档损坏、无法恢复」。这不是数据坏了，是**类型没注册**。
     *
     * 这里把注册表的状态如实读出来，让调用方在写 speed 之前就能知道风险。
     * 只读。
     */
    debugSpeedRegistry() {
        const shapez = /** @type {any} */ (window).shapez;
        const reg = shapez && shapez.gGameSpeedRegistry;
        const out = { registry_available: !!reg };
        if (!reg) return out;
        try {
            out.registered_ids = Array.isArray(reg.entryIds) ? reg.entryIds.slice() : null;
        } catch (e) {
            out.registered_ids = null;
        }
        out.has_regular = typeof reg.hasId === "function" ? reg.hasId("regular") : null;
        out.has_paused = typeof reg.hasId === "function" ? reg.hasId("paused") : null;
        out.has_fast_forward = typeof reg.hasId === "function" ? reg.hasId("fast-forward") : null;
        const time = this.root ? this.root.time : null;
        if (time) {
            try {
                out.current_speed = this.speedIdToName(time.getSpeed().getId());
                out.current_multiplier = time.getSpeed().getTimeMultiplier();
                out.budget_finite = Number.isFinite(time.logicTimeBudget);
            } catch (e) {
                out.time_error = String(e && e.message ? e.message : e);
            }
        }
        return out;
    }

    /**
     * 诊断用：读出游戏主循环的实时状态。
     *
     * 为什么需要它：整条产线"看着在跑其实不动"时，`obs.tick` 停在同一个值上，
     * `act.step` 返回 `ticks_run: 0`，而 `place`/`delete` 依旧成功。
     * 这三种现象组合起来至少有四个候选原因（窗口失焦、页面不可见、
     * `updateLogic` 返回 false、tickrate 被调成 0），从外部无法区分。
     * 这里把每个门控条件单独读出来，一次定位。
     *
     * 只读：不改任何状态。
     */
    debugLoop() {
        const root = this.requireRoot();
        const app = this.app;
        const dt = root.dynamicTickrate;
        const hud = root.hud;
        const out = {};
        try {
            out.tick = root.time.now();
            out.realtime = root.time.realtimeNow();
            out.speed = this.speedIdToName(root.time.getSpeed().getId());
            out.time_multiplier = root.time.getSpeed().getTimeMultiplier();
            out.logic_budget_ms = root.time.logicTimeBudget;
        } catch (e) {
            out.time_error = String(e && e.message ? e.message : e);
        }
        try {
            out.tick_rate = dt.currentTickRate;
            out.delta_ms = dt.deltaMs;
            out.average_fps = dt.averageFps;
            out.captured_ticks = (dt.capturedTicks || []).length;
        } catch (e) {
            out.tickrate_error = String(e && e.message ? e.message : e);
        }
        try {
            out.app_visible = app ? !!app.pageVisible : null;
            out.app_renderable = app && typeof app.isRenderable === "function" ? app.isRenderable() : null;
            out.app_focused = app ? !!app.focused : null;
            out.doc_hidden = typeof document !== "undefined" ? !!document.hidden : null;
        } catch (e) {
            out.app_error = String(e && e.message ? e.message : e);
        }
        try {
            out.hud_should_pause_game = hud.shouldPauseGame();
            out.hud_should_pause_render = hud.shouldPauseRendering();
            out.modal_open = hud.getIsAnyDialogOpen ? hud.getIsAnyDialogOpen() : null;
        } catch (e) {
            out.hud_error = String(e && e.message ? e.message : e);
        }
        try {
            const core = root.gameState && root.gameState.core;
            out.core_exists = !!core;
            out.core_has_bound_tick = !!(core && core.boundInternalTick);
            out.core_during_logic_update = core ? !!core.duringLogicUpdate : null;
        } catch (e) {
            out.core_error = String(e && e.message ? e.message : e);
        }
        // 直接跑一次 updateLogic，看返回值和 tick 增量 —— 这条能区分
        // "循环停了" 和 "循环在跑但时间不累加"。
        try {
            const core = root.gameState && root.gameState.core;
            if (core && typeof core.boundInternalTick === "function") {
                const t0 = root.time.now();
                const r = core.boundInternalTick();
                out.manual_tick_returned = r;
                out.manual_tick_advanced = root.time.now() - t0;
            }
        } catch (e) {
            out.manual_tick_error = String(e && e.message ? e.stack : e);
        }
        return out;
    }

    /**
     * 诊断用：读出某个区域里**带子上的物品**与**机器 ejector 槽里的物品**。
     *
     * 为什么需要它：`obs` 只报实体，看不到物品。于是"矿机在产吗"、"货堵在哪一格"
     * 这类问题只能靠猜 —— 我这一轮就因此把时间基准搞错、把没产出的线当成产出来分析。
     * 物品不走实体表：带子上的物品存在 `beltPaths` 的 `item` 字段里，
     * 机器的是 `ItemEjector.slots[].item`。这里两处都读。
     *
     * params: { region: [x0,y0,x1,y1] }
     */
    debugItems(params) {
        const root = this.requireRoot();
        const region = params.region;
        if (!Array.isArray(region) || region.length !== 4) {
            throw this.rpcError(2001, "invalid_action", "region must be [x0,y0,x1,y1]");
        }
        const inR = (x, y) => x >= region[0] && x <= region[2] && y >= region[1] && y <= region[3];
        const key = it => {
            try { return it && typeof it.getAsCopyableKey === "function" ? it.getAsCopyableKey() : null; }
            catch (e) { return null; }
        };

        const out = { belts: [], ejectors: [], underground: [], pending: [] };

        // 机器 ejector 槽
        for (const e of root.entityMgr.entities) {
            if (!e || e.queuedForDestroy || e.destroyed) continue;
            const sme = e.components && e.components.StaticMapEntity;
            if (!sme) continue;
            const ox = sme.origin.x, oy = sme.origin.y;
            if (!inR(ox, oy)) continue;

            const ej = e.components.ItemEjector;
            if (ej && ej.slots) {
                for (let i = 0; i < ej.slots.length; i++) {
                    const s = ej.slots[i];
                    if (!s || !s.item) continue;
                    out.ejectors.push({ cell: [ox, oy], slot: i, item: key(s.item), progress: s.progress });
                }
            }
            const ub = e.components.UndergroundBelt;
            if (ub && ub.pendingItems && ub.pendingItems.length) {
                out.pending.push({ cell: [ox, oy], mode: ub.mode, n: ub.pendingItems.length });
            }
        }

        // 带子上的物品（beltPaths 挂在 systems.belt 上，不是 root —— 见 systems/belt.js:67）
        try {
            const beltSystem = root.systemMgr && root.systemMgr.systems && root.systemMgr.systems.belt;
            const paths = (beltSystem && beltSystem.beltPaths) || [];
            for (let pi = 0; pi < paths.length; pi++) {
                const p = paths[pi];
                if (!p) continue;
                // BeltPath 的格子数组叫 `entityPath`（belt_path.js:64-69），不是 comps/components
                const items = p.items || [];
                const entPath = p.entityPath || [];
                // 物品**不是一格一个**。BeltPath 把它们按"距接受端的距离"排布，
                // 间距是 itemSpacingOnBelts = 0.63 格，所以 7 格直带能塞 11~12 个物品。
                // 之前按 items[i] ↔ entityPath[i] 硬对，超出格数的物品全部映射成 null，
                // 于是"带子塞满"看起来像"带子是空的"。要按累计距离反算格子。
                const items2 = items;
                let cursor = typeof p.spacingToFirstItem === "number" ? p.spacingToFirstItem : 0;
                // 每格的有效长度（直带 1.0，转弯 0.78 —— components/belt.js:6,70-72）
                const cellLens = entPath.map(ent => {
                    const c = ent && ent.components && ent.components.Belt;
                    try {
                        return c && typeof c.getEffectiveLengthTiles === "function" ? c.getEffectiveLengthTiles() : 1;
                    } catch (e) {
                        return 1;
                    }
                });
                const cellAt = dist => {
                    let acc = 0;
                    for (let ci = 0; ci < cellLens.length; ci++) {
                        if (dist < acc + cellLens[ci]) return ci;
                        acc += cellLens[ci];
                    }
                    return cellLens.length - 1;
                };
                for (let i = 0; i < items2.length; i++) {
                    const pair = items2[i];
                    if (!pair) continue;
                    const gap = Array.isArray(pair) ? pair[0] : null;
                    const it = Array.isArray(pair) ? pair[1] : pair;
                    if (!it) continue;
                    const ci = cellAt(cursor);
                    const ent = entPath[ci];
                    const sme = ent && ent.components && ent.components.StaticMapEntity;
                    const cell = sme ? [sme.origin.x, sme.origin.y] : null;
                    if (cell && !inR(cell[0], cell[1])) {
                        cursor += typeof gap === "number" ? gap : 0;
                        continue;
                    }
                    out.belts.push({
                        cell,
                        path: pi,
                        idx: i,
                        pos: Math.round(cursor * 1000) / 1000,
                        spacing_to_next: typeof gap === "number" ? Math.round(gap * 1000) / 1000 : gap,
                        item: key(it),
                    });
                    cursor += typeof gap === "number" ? gap : 0;
                }
            }
            out.pathCount = paths.length;
            /* `paths.slice(0, 40)` 会截断。调用方需要知道"我看到的是不是全部"，
               所以除了 actualPathCount 还给出 truncated 标记 —— 但这里只报数，
               由调用方决定怎么用（P7 的 G6b 靠 pathCount 判断能否下结论）。 */
            out.truncatedPaths = paths.length > 40;
            out.paths = paths.slice(0, 40).map(p => ({
                cells: (p.entityPath || []).map(ent => {
                    const sme = ent && ent.components && ent.components.StaticMapEntity;
                    return sme ? [sme.origin.x, sme.origin.y] : null;
                }).filter(Boolean),
                /* ★ items 的每个元素**已经是一个 [距离, 物品] 二元组** ★
                   BeltPath 的 schema 是 types.array(types.pair(ufloat, item))，
                   所以 `items.length` 就是物品个数。
                   这里曾经写成 `Math.floor(length / 2)` —— 那会把物品数腰斩：
                   实测 16 条路径里 12 条不一致，path 0 有 12 个物品报 6，
                   带 1 个物品的路径报 0（"塞满显示成空"的同族症状）。
                   G6b 刻意不看这个值，但 evidence 会照抄，读它的人会得到错数据。 */
                itemsOnPath: (p.items || []).length,
                spacingToFirstItem: typeof p.spacingToFirstItem === "number"
                    ? Math.round(p.spacingToFirstItem * 1000) / 1000 : null,
                boundAcceptor: p.boundAcceptor ? (p.boundAcceptor.entity && p.boundAcceptor.entity.components
                    && p.boundAcceptor.entity.components.StaticMapEntity
                    ? [p.boundAcceptor.entity.components.StaticMapEntity.origin.x,
                       p.boundAcceptor.entity.components.StaticMapEntity.origin.y]
                    : "yes") : null,
            }));
        } catch (e) {
            out.beltError = String(e && e.message ? e.message : e);
        }

        out.counts = { belts: out.belts.length, ejectors: out.ejectors.length, pending: out.pending.length };
        return out;
    }

    /**
     * 读写**升级模块**（游戏里 hub 右上角的 shop）。
     *
     * 为什么需要它：升级是 shapez 的核心成长机制，不是可选装饰 —— 二级带子跑两倍、
     * 二级矿机挖两倍。手工点十几次既慢又不可复现；AI 应当能把"买哪个、花多少、
     * 买完变多少"当成结构化决策来做。
     *
     * 语义与游戏 `hubGoals.tryUnlockUpgrade(id)` 完全一致（含扣料、广播、存档字段），
     * 本方法只做校验与报告，不自己改数字。
     *
     * params: { id?: string, dry_run?: boolean }
     *   - 不给 id          → 列出四条升级链的当前档位、下一档要什么、够不够
     *   - 给 id            → 买下一档（dry_run:true 只报告会扣什么，不真买）
     *
     * 返回值永远包含 `before` / `after` 与 `spent`，让调用方能对账，
     * 不必再发一次 obs 猜"到底买成功没有"。
     */
    upgrades(params) {
        const root = this.requireRoot();
        const hubGoals = root.hubGoals;
        const known = Object.keys(root.gameMode.getUpgrades());

        const snapshot = () => {
            const out = {};
            for (const id of known) {
                const tiers = root.gameMode.getUpgrades()[id] || [];
                const lvl = hubGoals.getUpgradeLevel(id);
                const next = tiers[lvl] || null;
                out[id] = {
                    level: lvl,
                    maxed: lvl >= tiers.length,
                    multiplier: hubGoals.upgradeImprovements ? hubGoals.upgradeImprovements[id] : null,
                    next: next ? { required: next.required || [] } : null,
                    can_buy: lvl < tiers.length ? !!hubGoals.canUnlockUpgrade(id) : false,
                };
            }
            return out;
        };

        if (params.id === undefined) {
            return { ok: true, op: "upgrade", upgrades: snapshot(), stored: { ...(hubGoals.storedShapes || {}) }, level: hubGoals.level };
        }

        const id = params.id;
        if (typeof id !== "string" || !known.includes(id)) {
            throw this.rpcError(2001, "invalid_action", "unknown upgrade id: " + id, "Known: " + known.join(", "));
        }
        const before = snapshot();
        if (before[id].maxed) {
            return { ok: true, op: "upgrade", id, bought: false, reason: "already-maxed", before: before[id], after: before[id] };
        }
        if (!before[id].can_buy) {
            throw this.rpcError(
                2002, "game_rejected",
                `cannot afford upgrade '${id}' tier ${before[id].level + 1}`,
                "Required: " + JSON.stringify(before[id].next ? before[id].next.required : [])
            );
        }
        const required = before[id].next ? (before[id].next.required || []) : [];

        if (params.dry_run === true) {
            return { ok: true, op: "upgrade", id, dry_run: true, would_buy: true, would_spend: required, before: before[id] };
        }

        const bought = hubGoals.tryUnlockUpgrade(id);
        if (!bought) {
            throw this.rpcError(2002, "game_rejected", "game refused the upgrade (state changed?)");
        }
        const after = snapshot();
        return {
            ok: true, op: "upgrade", id, bought: true, spent: required,
            before: before[id], after: after[id],
            stored: { ...(hubGoals.storedShapes || {}) },
        };
    }

    gameSetting(params) {
        const SETTING_WHITELIST = {
            enableTunnelSmartplace: "bool",   // 隧道磁贴自带删除中间带（C4 的根因）
            alwaysMultiplace: "bool",         // 连放模式：影响逐格放置的手感，不影响正确性
            disableCutDeleteWarnings: "bool", // 只影响 UI 警告
        };
        if (!this.app || !this.app.settings) {
            throw this.rpcError(1003, "not_in_game", "app.settings 不可用（未进入世界）",
                "游戏设置需要 app.settings，请在 InGameState 下调用");
        }
        const readAll = () => {
            const all = this.app.settings.getAllSettings();
            const out = {};
            for (const k in SETTING_WHITELIST) out[k] = all[k];
            return out;
        };
        const key = params.key;
        if (key === undefined) return { settings: readAll(), whitelist: Object.keys(SETTING_WHITELIST) };
        if (!Object.prototype.hasOwnProperty.call(SETTING_WHITELIST, key)) {
            throw this.rpcError(2001, "invalid_action", "setting not in whitelist: " + String(key),
                "Allowed: " + Object.keys(SETTING_WHITELIST).join(", "));
        }
        if (params.value === undefined) {
            return { key, value: this.app.settings.getAllSettings()[key] };
        }
        const want = params.value;
        const type = SETTING_WHITELIST[key];
        if (type === "bool" && typeof want !== "boolean") {
            throw this.rpcError(2001, "invalid_action", key + " 只接受 boolean，实得 " + JSON.stringify(want));
        }
        const before = this.app.settings.getAllSettings()[key];
        /* 游戏的真实写入口是 `updateSetting(id, value)`（不是 setSetting —— 那是别的引擎的习惯名）。
           它做三件事：按 SettingHandle 的 validate 校验、写进 currentData.settings、触发 changeCb、
           再 writeAsync 持久化。用错名字会静默地什么都改不到，所以这里写死并回读验证。 */
        this.app.settings.updateSetting(key, want);
        const after = this.app.settings.getAllSettings()[key];
        if (after !== want) {
            throw this.rpcError(2003, "mod_error",
                key + " 写入未生效（期望 " + JSON.stringify(want) + "，回读 " + JSON.stringify(after) + "）",
                "设置可能被只读层覆盖；不要假设设置已改，需按返回值判定");
        }
        this.log("setting", key, ":", before, "->", after);
        return { key, before, value: after, changed: before !== after };
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
            features: ["observe", "act", "batch", "step", "await", "blueprint", "screenshot", "save", "new_game", "entity_snapshot"],
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
        const table = { byId: {}, byCode: {}, variantsByCode: {}, rvByKey: {} };
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
                // rv 合法档位的**运行期权威**：注册表按 `id/variant/rv` 注册（building_codes.js:41-56），
                // 所以"这个 (building, variant, rv) 有没有 code"就是"rv 合不合法"。
                // 这比写死的表更可靠：非 belt 机器在注册表里根本没有 rv≠0 的条目（H2 的源码依据）。
                if (id) {
                    const key = id + "/" + v.variant;
                    if (!table.rvByKey[key]) table.rvByKey[key] = [];
                    table.rvByKey[key].push({ rv: v.rotationVariant || 0, code: isNaN(+code) ? code : +code });
                }
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

    // ─────────────── 实体序列化还原原语（事务层用） ───────────────
    /*
     * 为什么不能用 `entity.clone()`
     * ------------------------------------------------------------------
     * recon/upstream-full/src/js/game/entity.js:88-106 的 clone() 只调每个组件的
     * `copyAdditionalStateTo()`，而全仓只有 4 个组件实现它：
     *   constant_signal.js:21 / goal_acceptor.js:64 / lever.js:19 / static_map_entity.js:86
     * Belt / Storage / Filter / UndergroundBelt / ItemEjector / ItemProcessor / Wire 全是
     * Component 基类的空实现（component.js:29-32）⇒ clone 出来的 storage 是空的、
     * filter 队列是空的、隧道在途货丢了。**clone 不是还原原语。**
     *
     * 正确的原语是存档反序列化路径本身
     * ------------------------------------------------------------------
     * serializer_internal.js:44-68 deserializeEntity + :80-100 deserializeComponents
     * 都是实例方法（`new SerializerInternal()` 无参），不需要 import 任何东西；
     * 但为了不依赖 window.shapez 上是否恰好暴露了 SerializerInternal，
     * 这里按其**逐行等价**的方式重写一遍（同样的调用顺序、同样的 uid/register/place 顺序）。
     * 之所以顺序重要：registerEntity 会 dispatch entityAdded，belt/wire/miner 系统都在这个
     * 信号上重算缓存，先 placeStaticEntity 再 register 会导致 findFollowUpEntity 看不到自己。
     *
     * ⚠️ 还原的**边界**（重要，事务层必须知道）
     * ------------------------------------------------------------------
     * `entity.serialize()` 只覆盖各组件 `getSchema()` 里声明的字段（entity.js:71-78）。
     * 下面这些**运行期状态不在 schema 里**，delete+restore 之后一定丢：
     *
     *   Belt.assignedPath                       components/belt.js:54-58 注释 "not serialized"
     *   BeltPath.items / spacingToFirstItem     不在 entity 的 payload 里（存档单独存 beltPaths）
     *   Wire.linkedNetwork                       components/wire.js:33-38 无 getSchema
     *   WiredPins.slots[].linkedNetwork          components/wired_pins.js:32-40 只存 value
     *   WireTunnel.linkedNetworks               components/wire_tunnel.js 无 getSchema
     *   ItemEjector.slots[].cachedTargetEntity  components/item_ejector.js:28 注释明写不序列化
     *                 .cachedDestSlot / .cachedBeltPath
     *   ItemProcessor.inputSlots/inputCount/ongoingCharges/queuedEjects/bonusTime
     *                                           components/item_processor.js:46-50 只存 nextOutputSlot
     *   Miner.cachedMinedItem / cachedChainedMiner
     *                                           components/miner.js:14-15 注释 "not serialized"
     *   UndergroundBelt.cachedLinkedEntity / consumptionAnimations
     *                                           components/underground_belt.js:26-30 只存 pendingItems
     *   Storage.maximumStorage                  构造参数，由建筑 setupEntityComponents 给定（5000）
     *   GoalAcceptor.currentDeliveredItems / lastDelivery
     *   BeltReader.lastItemTimes / lastThroughput / lastThroughputComputation
     *   BeltUnderlays.underlays[].cachedType
     *
     * 其中**可以靠重算补回**的：
     *   Belt.assignedPath   → 注册时 BeltSystem.onEntityAdded(systems/belt.js:312-325) 会重建/并入 path；
     *                         但**原有 path 上的 items 位置会被 deleteEntityFromPath 改写/丢失**
     *                         （belt_path.js:633-793 会丢掉落点格上的货、并重算其它货的间距），
     *                         所以精确还原需要连 beltPaths 一起快照（存档的 beltPaths 字段即为此）。
     *   Wire.linkedNetwork / WiredPins.slots[].linkedNetwork
     *                       → WireSystem 在 entityAdded 上置 needsRecompute（systems/wire.js:115-120），
     *                         下一 tick 的 update() → recomputeWiresNetwork()（:517-522）整体重建。
     *   UndergroundBelt.cachedLinkedEntity → StaleAreaDetector（:43-46）在下一 tick 重算。
     *   ItemEjector 的 cached*              → postLoadHook 才会全量重算（systems/item_ejector.js:32）；
     *                         单独加一个实体只会走 staleAreaDetector 的 1 格外扩（:33-36），
     *                         因此**远处**的下游 ejector 缓存不会自动刷新 —— 需要显式 invalidate。
     *   Miner.cachedMinedItem               → systems/miner.js:49-56 在 update 里自愈。
     *
     * 完全**补不回来**（delete 即丢）：
     *   ItemProcessor 的 inputSlots/inputCount/ongoingCharges/queuedEjects、GoalAcceptor 计数器、
     *   BeltReader 的吞吐历史 —— 它们不在 schema、也没有任何重算路径，只能由调用方自行快照。
     */

    /**
     * code → 建筑数据（{metaInstance, variant, rotationVariant}）。
     *
     * 优先用游戏自己的 `getBuildingDataFromCode`（building_codes.js:66-69，存档反序列化走的就是它），
     * 拿不到时退回 ensureBuildingTables() 的 byCode 表（同一份 gBuildingVariants 的投影）。
     */
    buildingDataFromCode(code) {
        const shapez = /** @type {any} */ (window).shapez;
        if (shapez && typeof shapez.getBuildingDataFromCode === "function") {
            return shapez.getBuildingDataFromCode(code);
        }
        const table = this.ensureBuildingTables();
        const info = table.byCode[code];
        if (!info) {
            throw this.rpcError(2001, "invalid_action", "unknown building code: " + code,
                "代码表来自运行中的 gBuildingVariants；该 code 在当前版本不存在");
        }
        return info;
    }

    /** 向量构造：优先游戏自己的 Vector.fromSerializedObject（vector.js:664-668）。 */
    vectorFrom(obj) {
        const shapez = /** @type {any} */ (window).shapez;
        const V = this.VectorCtor();
        if (V && typeof V.fromSerializedObject === "function") return V.fromSerializedObject(obj);
        return new V((obj && obj.x) || 0, (obj && obj.y) || 0);
    }

    /**
     * 把实体序列化成可 JSON 化的载荷。
     *
     * 返回 { uid, code, layer, rotation, rotationVariant, buildingId, variant,
     *        components, component_keys, non_serialized }
     *
     * components 直接来自 entity.serialize()（entity.js:71-78），与存档里的 entities[i] 同形，
     * 所以这个载荷可以原样喂给 restoreEntity，也可以写进存档做离线比对。
     *
     * ⚠️ Entity 的 schema 里**没有 layer**（entity.js:73-77 只有 uid + components），
     * 而 layer 决定 placeStaticEntity 写哪张图（map.js:234-245）。所以这里显式带出 layer，
     * restoreEntity 会拿它做交叉校验。
     */
    serializeEntity(entity) {
        if (!entity || !entity.components || !entity.components.StaticMapEntity) {
            throw this.rpcError(2001, "invalid_action", "serializeEntity: entity has no StaticMapEntity");
        }
        const sme = entity.components.StaticMapEntity;
        const table = this.ensureBuildingTables();
        const info = table.byCode[sme.code];
        const serialized = entity.serialize();
        return {
            uid: serialized.uid,
            code: sme.code,
            layer: entity.layer || "regular",
            rotation: sme.rotation,
            rotationVariant: info ? info.rotationVariant : null,
            buildingId: info ? info.buildingId : null,
            variant: info ? info.variant : null,
            components: serialized.components,
            // 诊断用：payload 里实际出现了哪些组件。空 schema 的组件会被
            // types.keyValueMap(..., includeEmptyValues=false) 丢掉（serialization_data_types.js:1030-1049），
            // 这不影响还原（组件由建筑自己建出来），但对比时要知道"缺"不是丢。
            component_keys: Object.keys(serialized.components || {}),
            // 实体上实际有的组件（含空 schema 的）
            live_component_keys: Object.keys(entity.components).filter(k => entity.components[k]),
        };
    }

    /**
     * 还原一个实体：与 serializer_internal.js:44-68 的 deserializeEntity 逐行等价。
     *
     * 顺序（不可换）：
     *   1. metaInstance.createEntity(...)   —— 由 code 反查出 meta/variant/rotationVariant，
     *      组件由建筑自己的 setupEntityComponents 建好（ItemEjector/ItemAcceptor/... 的槽位几何都在这里）
     *   2. entity.uid = payload.uid          —— 必须在 registerEntity 之前；
     *      registerEntity 里的 `entity.uid = uid ? uid : generateUid()` 遇到 0 会自己生成
     *   3. deserializeComponents(...)        —— 逐组件 deserialize(schema)，item 单例靠 root 解析
     *   4. entityMgr.registerEntity(entity, uid)  —— dispatch entityAdded（belt/wire/miner 系统在此重算）
     *   5. map.placeStaticEntity(entity)     —— 写 chunk 格子
     *      ⚠️ 注意 4/5 与 serializer_internal 一致（register 在 place 之前）。
     */
    restoreEntity(payload, opts) {
        const root = this.requireRoot();
        const o = opts || {};
        if (!payload || typeof payload !== "object") {
            throw this.rpcError(2001, "invalid_action", "restoreEntity: payload must be an object");
        }
        const staticData = payload.components && payload.components.StaticMapEntity;
        // 缺 StaticMapEntity ⇒ 没有 code/origin，无从建实体。**必须报错，不能静默返回 null**：
        // 静默会让事务层以为"还原成功但实体是空的"，等到下游发现时已经丢了写入。
        if (!staticData) {
            throw this.rpcError(2001, "invalid_action",
                "restoreEntity: payload.components.StaticMapEntity is missing",
                "载荷必须来自 serializeEntity()（含 components.StaticMapEntity.code/origin/rotation）");
        }
        if (staticData.code === undefined || staticData.code === null) {
            throw this.rpcError(2001, "invalid_action", "restoreEntity: StaticMapEntity.code is missing");
        }
        if (!staticData.origin || !Number.isFinite(staticData.origin.x) || !Number.isFinite(staticData.origin.y)) {
            throw this.rpcError(2001, "invalid_action", "restoreEntity: StaticMapEntity.origin must be {x,y}");
        }
        if (typeof payload.uid !== "number" || !Number.isInteger(payload.uid) || payload.uid < 0) {
            throw this.rpcError(2001, "invalid_action", "restoreEntity: payload.uid must be a non-negative integer");
        }

        const data = this.buildingDataFromCode(staticData.code);
        const metaBuilding = data.metaInstance;
        if (!metaBuilding || typeof metaBuilding.createEntity !== "function") {
            throw this.rpcError(2003, "mod_error",
                "restoreEntity: building code " + staticData.code + " has no metaInstance.createEntity()");
        }

        /*
         * uid 冲突预检。
         *
         * 上游 registerEntity 只在 **dev** 构建里 assert uid 不重复（entity_manager.js:96-99
         * 被 G_IS_DEV && !disableSlowAsserts 包着）；正式版会直接 push 两个同 uid 的实体，
         * 于是 map 上一格新、一格里还是旧实体，findByUid 永远返回先找到的那个 ——
         * 这种损坏不会立刻报错，只会在很久以后表现为"删不掉 / 指向错的东西"。
         * 事务层回滚时若忘了先删就还原，正好会踩这个，所以在这里硬拒。
         */
        const occupant = (() => {
            try { return root.entityMgr.findByUid(payload.uid, false); } catch (e) { return null; }
        })();
        if (occupant && occupant !== null && !occupant.destroyed && !occupant.queuedForDestroy) {
            const occStatic = occupant.components && occupant.components.StaticMapEntity;
            throw this.rpcError(2002, "game_rejected",
                "restoreEntity: uid " + payload.uid + " is already taken by a live entity"
                    + (occStatic ? " at (" + occStatic.origin.x + "," + occStatic.origin.y + ")" : ""),
                "回滚顺序必须是：先 deleteEntityByUid(uid)，再 restoreEntity(payload)；否则会出现两个同 uid 实体");
        }

        // 目标格占用预检：placeStaticEntity 内部 assert 会抛（map_chunk.js:465
        // "Tile already used"），但那个 assert 在正式版里也可能被裁掉，
        // 而"覆盖了别的建筑"是不可逆的。这里先明确拒绝。
        // ⚠️ 必须查**整个 footprint**，不是 origin 一格：仓库是 2×2、hub 是 4×4，
        // 只查 origin 会让"右下角压着别人的机器"漏过去。
        const layerForCheck = payload.layer || "regular";
        const footprint = this.entityTileBounds(metaBuilding, data, staticData);
        for (let dx = 0; dx < footprint.w; ++dx) {
            for (let dy = 0; dy < footprint.h; ++dy) {
                const gx = footprint.x + dx;
                const gy = footprint.y + dy;
                let occ = null;
                try { occ = root.map.getLayerContentXY(gx, gy, layerForCheck); } catch (e) { occ = null; }
                if (occ && occ.uid !== payload.uid) {
                    throw this.rpcError(2002, "game_rejected",
                        "restoreEntity: tile (" + gx + "," + gy + ") on layer " + layerForCheck
                            + " is occupied by uid " + occ.uid,
                        "先清空该格再还原；静默覆盖会丢掉别人的建筑");
                }
            }
        }

        const Vector = this.VectorCtor();
        const entity = metaBuilding.createEntity({
            root,
            origin: this.vectorFrom(staticData.origin),
            rotation: staticData.rotation,
            originalRotation: staticData.originalRotation === undefined ? staticData.rotation : staticData.originalRotation,
            rotationVariant: data.rotationVariant,
            variant: data.variant,
        });

        // ⚠️ 这一行是"uid 保真"的唯一来源。删掉它，registerEntity 会给实体发一个**新** uid
        // （generateUid() 从 10000 起）—— 于是所有引用旧 uid 的东西（事务日志、蓝图、
        // 上层 AI 的心智模型）全部指错。test/mod_selftest.mjs 有一条变异用例专锁这一行。
        entity.uid = payload.uid;

        // layer 交叉校验：createEntity 用 meta.getLayer() 定 layer，与 payload 不一致说明
        // code 表与存档不同源（例如 mod 版本差异）—— 还原出来的东西会落在错误的图层上。
        const wantLayer = payload.layer || null;
        if (wantLayer && entity.layer !== wantLayer) {
            throw this.rpcError(2003, "mod_error",
                "restoreEntity: layer mismatch — payload says " + wantLayer + ", building code "
                + staticData.code + " is on " + entity.layer,
                "同一 code 在不同游戏版本可能改变图层；拒绝静默还原到错误图层");
        }

        const restoreReport = this.deserializeComponentsInto(root, entity, payload.components);

        const register = () => {
            root.entityMgr.registerEntity(entity, payload.uid);
            root.map.placeStaticEntity(entity);
        };
        // 与 paste_blueprint 同样的理由：registerEntity 会 dispatch entityAdded，
        // BeltSystem.updateSurroundingBeltPlacement 会把**周围一圈**带子的 rv 按邻居重算并覆写 code
        // （systems/belt.js:120-210，唯一豁免是 immutableOperationRunning，:169）。
        // 还原一个带子不该悄悄改掉它邻居的拓扑。
        this.runGuarded(root, register);

        // 供事务层读取：payload 里有、但实体上已不存在（被重算/丢弃）的组件。
        // 定义成不可枚举属性 —— 不会被 entity.serialize()/JSON.stringify 带出去。
        try {
            Object.defineProperty(entity, RESTORE_REPORT_KEY, {
                value: restoreReport, enumerable: false, writable: true, configurable: true,
            });
        } catch (e) {
            entity[RESTORE_REPORT_KEY] = restoreReport;
        }
        return entity;
    }

    /**
     * 等价于 serializer_internal.js:80-100 deserializeComponents：
     * 逐组件调用 `component.deserialize(data, root)`，返回错误码即失败。
     * 与上游的唯一差别：上游对"实体没有该组件"只 warn 并 continue（:86-95），
     * 这里把它记进报告（missing），因为对事务层来说"载荷里有、实体上没了"是**信息丢失**，
     * 必须可观测，而不是静默吞掉。
     */
    deserializeComponentsInto(root, entity, components) {
        const report = { missing: [], failed: [], restored: [] };
        for (const componentId in components) {
            const comp = entity.components[componentId];
            if (!comp) {
                report.missing.push(componentId);
                continue;
            }
            if (typeof comp.deserialize !== "function") {
                report.failed.push({ component: componentId, error: "component has no deserialize()" });
                continue;
            }
            const errorStatus = comp.deserialize(components[componentId], root);
            if (errorStatus) {
                // 与上游一致：组件反序列化失败必须中断，不能带着半截状态继续（存档加载同理）。
                throw this.rpcError(2003, "mod_error",
                    "restoreEntity: component " + componentId + " failed to deserialize: " + errorStatus);
            }
            report.restored.push(componentId);
        }
        return report;
    }

    /**
     * 在 bulk + immutable 语义下执行 fn，但**不嵌套**：如果调用方已经包了这两层
     * （例如事务层自己做 performBulkOperation），就直接执行 —— 上游 logic.js:170-203
     * 对重入是 assert 失败，不是无害的。
     */
    runGuarded(root, fn) {
        const logic = root.logic;
        if (!logic) return fn();
        const needBulk = !root.bulkOperationRunning && typeof logic.performBulkOperation === "function";
        const needImmutable = !root.immutableOperationRunning && typeof logic.performImmutableOperation === "function";
        if (!needBulk && !needImmutable) return fn();
        const wrapped = () => (needImmutable ? logic.performImmutableOperation(fn) : fn());
        return needBulk ? logic.performBulkOperation(wrapped) : wrapped();
    }

    /**
     * 算出该建筑会占哪几格（世界格坐标 + 尺寸）。两种来源，按可靠性排序：
     *   ① 让建筑自己 createEntity 一次，读 StaticMapEntity.getTileSpaceBounds() —— 权威
     *      （static_map_entity.js:129-146 已处理 90/180/270 的 origin 语义），
     *      但会多造一个一次性实体；
     *   ② 用 code 表里的 tileSize + 自己的旋转公式 —— 便宜，但 code 表若缺 tileSize
     *      会退化成 1×1，把 2×2/4×4 的覆盖检查做漏。
     * 这里优先 ①，失败再退 ②。**绝不静默用 1×1**（那等于没检查）。
     */
    entityTileBounds(metaBuilding, data, staticData) {
        const rot = ((Number(staticData.rotation) % 360) + 360) % 360;
        const ox = staticData.origin.x, oy = staticData.origin.y;
        const wrap = (w, h) => {
            switch (rot) {
                case 0: return { x: ox, y: oy, w, h };
                case 90: return { x: ox - h + 1, y: oy, w: h, h: w };
                case 180: return { x: ox - w + 1, y: oy - h + 1, w, h };
                case 270: return { x: ox, y: oy - w + 1, w: h, h: w };
                default: return { x: ox, y: oy, w, h };
            }
        };
        try {
            const probe = metaBuilding.createEntity({
                root: this.root,
                origin: this.vectorFrom(staticData.origin),
                rotation: staticData.rotation,
                originalRotation: staticData.rotation,
                rotationVariant: data.rotationVariant,
                variant: data.variant,
            });
            const sme = probe && probe.components && probe.components.StaticMapEntity;
            if (sme && typeof sme.getTileSpaceBounds === "function") {
                const r = sme.getTileSpaceBounds();
                if (r && Number.isFinite(r.w) && Number.isFinite(r.h)) {
                    return { x: r.x, y: r.y, w: r.w, h: r.h };
                }
            }
            if (sme && sme.getTileSize) {
                const s = sme.getTileSize();
                if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) return wrap(s.x, s.y);
            }
        } catch (e) {
            /* 退到 ② */
        }
        const ts = data && data.tileSize;
        if (ts && Number.isFinite(ts.x) && Number.isFinite(ts.y)) return wrap(ts.x, ts.y);
        throw this.rpcError(2003, "mod_error",
            "restoreEntity: cannot determine tile footprint for code " + staticData.code,
            "既拿不到 getTileSpaceBounds()，也拿不到 tileSize —— 无法安全地做覆盖检查，拒绝还原");
    }

    /**
     * 按 uid 删除实体，走游戏自己的删除路径（logic.js:218-226 tryDeleteBuilding）：
     *   map.removeStaticEntity → entityMgr.destroyEntity → processDestroyList
     * 这条路径会 dispatch entityDestroyed，belt 系统据此把该格从 path 里摘掉
     * （systems/belt.js:223-241 / belt_path.js:633-793），wire/miner 各自标脏。
     *
     * 返回 { ok, cell, uid, reason? }。**不可删的建筑（hub、非编辑器里的 goal acceptor）
     * 返回 ok:false + reason:"not_removable"**，而不是抛错 —— 事务层需要区分
     * "删不掉"（回滚时是真实失败）与"根本没找到"（可能已经被别人删了）。
     */
    deleteEntityByUid(uid) {
        const root = this.requireRoot();
        if (typeof uid !== "number" || !Number.isInteger(uid)) {
            throw this.rpcError(2001, "invalid_action", "deleteEntityByUid: uid must be an integer");
        }
        let entity = null;
        try {
            entity = root.entityMgr.findByUid(uid, false);
        } catch (e) {
            entity = null;
        }
        if (!entity) {
            // 兜底：findByUid 会跳过 queuedForDestroy/destroyed（entity_manager.js:151-158），
            // 但我们不认为"排队中"算找到 —— 那就是即将消失的东西。
            const list = (root.entityMgr && root.entityMgr.entities) || [];
            for (let i = 0; i < list.length; ++i) {
                const e = list[i];
                if (e && e.uid === uid && !e.queuedForDestroy && !e.destroyed) { entity = e; break; }
            }
        }
        if (!entity) {
            return { ok: false, uid, cell: null, reason: "not_found" };
        }
        const sme = entity.components.StaticMapEntity;
        const cell = sme ? [sme.origin.x, sme.origin.y] : null;
        const layer = entity.layer || "regular";
        let deleted = false;
        if (root.logic && typeof root.logic.tryDeleteBuilding === "function") {
            deleted = !!root.logic.tryDeleteBuilding(entity);
        } else {
            // 兜底：没有 logic（测试桩 / 极端情况）时按 tryDeleteBuilding 的三步手工走
            if (root.map && root.map.removeStaticEntity) root.map.removeStaticEntity(entity);
            root.entityMgr.destroyEntity(entity);
            root.entityMgr.processDestroyList();
            deleted = true;
        }
        if (!deleted) {
            return { ok: false, uid, cell, layer, reason: "not_removable" };
        }
        return { ok: true, uid, cell, layer };
    }

    /**
     * 读取实体的**非序列化**运行期状态（诊断用）。
     *
     * 这是"哪些状态还原不了"的实测出口：它把不参与 schema、delete+restore 后会变/会丢的字段
     * 全部摊平成 JSON，供 debug_entity_roundtrip 做前后比对。
     */
    volatileSnapshot(entity) {
        const c = entity.components || {};
        const out = {};
        const pathSummary = path => {
            if (!path) return null;
            try {
                return {
                    entities: (path.entityPath || []).map(e => e.uid),
                    items: (path.items || []).map(([d, item]) => [d, this.itemToShortKey(item)]),
                    spacingToFirstItem: path.spacingToFirstItem,
                    totalLength: path.totalLength,
                };
            } catch (e) {
                return { error: String(e && e.message ? e.message : e) };
            }
        };
        if (c.Belt) {
            out.Belt = {
                direction: c.Belt.direction,
                assignedPath: pathSummary(c.Belt.assignedPath),
            };
        }
        if (c.Storage) {
            out.Storage = {
                storedCount: c.Storage.storedCount,
                storedItem: c.Storage.storedItem ? this.itemToShortKey(c.Storage.storedItem) : null,
                maximumStorage: c.Storage.maximumStorage,
            };
        }
        if (c.Filter) {
            out.Filter = {
                leaveThrough: (c.Filter.pendingItemsToLeaveThrough || []).map(i => [this.itemToShortKey(i.item), i.progress]),
                reject: (c.Filter.pendingItemsToReject || []).map(i => [this.itemToShortKey(i.item), i.progress]),
            };
        }
        if (c.UndergroundBelt) {
            out.UndergroundBelt = {
                mode: c.UndergroundBelt.mode,
                tier: c.UndergroundBelt.tier,
                pendingItems: (c.UndergroundBelt.pendingItems || []).map(([item, t]) => [this.itemToShortKey(item), t]),
                cachedLinkedEntity: c.UndergroundBelt.cachedLinkedEntity
                    ? (c.UndergroundBelt.cachedLinkedEntity.entity ? c.UndergroundBelt.cachedLinkedEntity.entity.uid : null)
                    : null,
                consumptionAnimations: (c.UndergroundBelt.consumptionAnimations || []).length,
            };
        }
        if (c.ItemEjector) {
            out.ItemEjector = {
                slots: (c.ItemEjector.slots || []).map(s => ({
                    item: s.item ? this.itemToShortKey(s.item) : null,
                    progress: s.progress,
                    cachedTargetEntity: s.cachedTargetEntity ? s.cachedTargetEntity.uid : null,
                    cachedDestSlot: s.cachedDestSlot ? s.cachedDestSlot.index : null,
                    cachedBeltPath: !!s.cachedBeltPath,
                })),
            };
        }
        if (c.ItemProcessor) {
            const p = c.ItemProcessor;
            out.ItemProcessor = {
                type: p.type,
                nextOutputSlot: p.nextOutputSlot,
                inputCount: p.inputCount,
                inputSlots: p.inputSlots ? Array.from(p.inputSlots.keys()).sort((a, b) => a - b) : null,
                ongoingCharges: (p.ongoingCharges || []).length,
                queuedEjects: (p.queuedEjects || []).length,
                bonusTime: p.bonusTime,
            };
        }
        if (c.Miner) {
            out.Miner = {
                lastMiningTime: c.Miner.lastMiningTime,
                cachedMinedItem: c.Miner.cachedMinedItem ? this.itemToShortKey(c.Miner.cachedMinedItem) : null,
                cachedChainedMiner: c.Miner.cachedChainedMiner && c.Miner.cachedChainedMiner !== false
                    ? c.Miner.cachedChainedMiner.uid : c.Miner.cachedChainedMiner,
                itemChainBuffer: (c.Miner.itemChainBuffer || []).map(i => this.itemToShortKey(i)),
            };
        }
        if (c.Wire) {
            out.Wire = {
                type: c.Wire.type,
                variant: c.Wire.variant,
                linkedNetwork: c.Wire.linkedNetwork ? (c.Wire.linkedNetwork.id === undefined ? true : c.Wire.linkedNetwork.id) : null,
            };
        }
        if (c.WireTunnel) {
            out.WireTunnel = { linkedNetworks: (c.WireTunnel.linkedNetworks || []).length };
        }
        if (c.WiredPins) {
            out.WiredPins = {
                slots: (c.WiredPins.slots || []).map(s => ({
                    value: s.value ? this.itemToShortKey(s.value) : null,
                    linkedNetwork: s.linkedNetwork ? true : null,
                })),
            };
        }
        if (c.GoalAcceptor) {
            out.GoalAcceptor = {
                currentDeliveredItems: c.GoalAcceptor.currentDeliveredItems,
                lastDelivery: c.GoalAcceptor.lastDelivery ? true : null,
            };
        }
        if (c.BeltReader) {
            out.BeltReader = {
                lastItem: c.BeltReader.lastItem ? this.itemToShortKey(c.BeltReader.lastItem) : null,
                lastItemTimes: (c.BeltReader.lastItemTimes || []).length,
                lastThroughput: c.BeltReader.lastThroughput,
            };
        }
        if (c.BeltUnderlays) {
            out.BeltUnderlays = {
                cachedTypes: (c.BeltUnderlays.underlays || []).map(u => u.cachedType === undefined ? null : u.cachedType),
            };
        }
        return out;
    }

    /** 深比较两棵 JSON 树，把差异摊平到 out（path 形如 components.Belt.direction）。 */
    diffJson(a, b, prefix, out) {
        const isObj = v => v !== null && typeof v === "object";
        if (isObj(a) && isObj(b)) {
            const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
            for (const k of keys) {
                this.diffJson(a[k], b[k], prefix ? prefix + "." + k : k, out);
            }
            return out;
        }
        if (JSON.stringify(a) !== JSON.stringify(b)) {
            out.push({ field: prefix, before: a === undefined ? null : a, after: b === undefined ? null : b });
        }
        return out;
    }

    /**
     * 诊断 RPC：把一个实体 serialize → delete → restore → 读回，逐字段比对。
     *
     * params: { x, y, layer? }
     * 返回：{ ok, uid, original: {...}, restored: {...}, diffs: [...], component_keys: [...],
     *         lost_state: {...}, volatile_diffs: [...] }
     *
     * ⚠️ 这是**写操作**（会真的删一次再放回来），已登记进 RPC_WRITE_METHODS 走同一条串行链。
     * 调用方必须自己保证那格是它自己的测试区（hub/玩家产线不可用这个做实验）。
     */
    debugEntityRoundtrip(params) {
        const root = this.requireRoot();
        const p = params || {};
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
            throw this.rpcError(2001, "invalid_action", "debug_entity_roundtrip requires numeric x, y");
        }
        const layer = p.layer || "regular";
        const entity = root.map.getLayerContentXY(p.x, p.y, layer);
        if (!entity) {
            throw this.rpcError(2002, "game_rejected",
                "no entity at (" + p.x + "," + p.y + ") on layer " + layer,
                "先用 obs region 确认目标格里有东西");
        }
        const uid = entity.uid;
        const smeBefore = entity.components.StaticMapEntity;

        const beforeSerialized = this.serializeEntity(entity);
        const beforeVolatile = this.volatileSnapshot(entity);
        const beforeComponentKeys = Object.keys(entity.components).filter(k => entity.components[k]).sort();

        // ── delete ──
        const del = this.deleteEntityByUid(uid);
        if (!del.ok) {
            throw this.rpcError(2002, "game_rejected",
                "could not delete uid " + uid + " for roundtrip: " + del.reason,
                "该建筑不可删（hub / 非编辑器里的 goal acceptor），换个目标");
        }
        const stillThere = root.map.getLayerContentXY(p.x, p.y, layer);
        if (stillThere) {
            throw this.rpcError(2003, "mod_error",
                "delete reported ok but the tile is still occupied (uid " + stillThere.uid + ")");
        }

        // ── restore ──
        /*
         * 失败语义：delete 已经发生，如果 restore 抛错，这格就**空了** —— 不能把异常
         * 直接抛给调用方然后让他以为"什么都没发生"。这里把原始载荷一并带出去，
         * 并明确告知 rollback 需要什么。
         */
        let restoredEntity;
        try {
            restoredEntity = this.restoreEntity(beforeSerialized, { roundtrip: true });
        } catch (e) {
            const detail = e && e.__rpcError ? e.__rpcError.detail : String(e && e.message ? e.message : e);
            throw this.rpcError(2003, "mod_error",
                "roundtrip: delete succeeded but restore FAILED — tile (" + p.x + "," + p.y + ") is now empty. "
                    + detail,
                "原载荷: " + JSON.stringify(beforeSerialized));
        }
        const back = root.map.getLayerContentXY(p.x, p.y, layer);
        const landed = back && back.uid === restoredEntity.uid;

        const afterSerialized = this.serializeEntity(restoredEntity);
        const afterVolatile = this.volatileSnapshot(restoredEntity);
        const afterComponentKeys = Object.keys(restoredEntity.components).filter(k => restoredEntity.components[k]).sort();

        // ── diff ──
        const diffs = [];
        this.diffJson(
            { uid: beforeSerialized.uid, code: beforeSerialized.code, layer: beforeSerialized.layer,
              components: beforeSerialized.components },
            { uid: afterSerialized.uid, code: afterSerialized.code, layer: afterSerialized.layer,
              components: afterSerialized.components },
            "", diffs
        );
        const volatileDiffs = [];
        this.diffJson(beforeVolatile, afterVolatile, "", volatileDiffs);

        const report = restoredEntity[RESTORE_REPORT_KEY] || null;

        return {
            ok: del.ok && !!landed && diffs.length === 0,
            x: p.x,
            y: p.y,
            layer,
            uid,
            restored_uid: restoredEntity.uid,
            uid_preserved: restoredEntity.uid === uid,
            tile_landed: !!landed,
            original: {
                uid, code: smeBefore.code, rotation: smeBefore.rotation,
                rotationVariant: beforeSerialized.rotationVariant,
                layer: beforeSerialized.layer,
            },
            restored: {
                uid: restoredEntity.uid,
                code: restoredEntity.components.StaticMapEntity.code,
                rotation: restoredEntity.components.StaticMapEntity.rotation,
                rotationVariant: afterSerialized.rotationVariant,
                layer: restoredEntity.layer,
            },
            diffs,                              // schema 内的差异（应为空）
            volatile_diffs: volatileDiffs,      // 非 schema 状态差异（**正常情况不空**，见 lost_state）
            component_keys: beforeSerialized.component_keys,
            live_component_keys_before: beforeComponentKeys,
            live_component_keys_after: afterComponentKeys,
            restore_report: report,             // { restored[], missing[], failed[] }
            lost_state: afterVolatile,          // 还原后这些运行期字段是什么（供事务层决定快照要含什么）
        };
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
     * 该 (building, variant) 允许的 rotationVariant 档位。
     * 顺序：运行期注册表（权威，gBuildingVariants 登记了哪些 rv 就有哪些）→ 文档表兜底。
     * 返回 { allowed: number[], source: "registry"|"documented", codeByRv: Map<rv,code>|null }
     */
    allowedRotationVariants(root, meta, variant) {
        const table = this.ensureBuildingTables();
        const id = meta.getId();
        const entry = table.rvByKey && table.rvByKey[id + "/" + variant];
        if (Array.isArray(entry) && entry.length > 0) {
            const codeByRv = new Map();
            entry.forEach(e => codeByRv.set(e.rv, e.code));
            return { allowed: [...codeByRv.keys()].sort((x, y) => x - y), source: "registry", codeByRv };
        }
        // 注册表不可用（未进世界 / stub 环境 / 该变体未注册）→ 退回文档表。
        // 注意：这只决定"档位合不合法"，实际 code 仍以放置后读回的实体为准（见 opPlace 自证）。
        const documented = RV_DOCUMENTED[id] || RV_DEFAULT_ALLOWED;
        return { allowed: documented.slice(), source: "documented", codeByRv: null };
    }

    /**
     * 解析并校验 place 的 rotationVariant / rv 字段。
     * 语义：不给（undefined/null）→ 返回 null，走"游戏自动定向"（既有行为，零改动）。
     *       给了 → 必须是整数，且落在该 (building, variant) 的合法档位内，否则 2001。
     * ⚠️ 不做"非 belt 一律拒绝"的一刀切：合法性以该建筑的注册档位为准
     *    （belt 是 0/1/2，隧道 0/1，机器只有 0），见 allowedRotationVariants。
     */
    resolveRotationVariant(root, meta, variant, raw) {
        if (raw === undefined || raw === null) return null;
        if (typeof raw !== "number" || !Number.isInteger(raw)) {
            throw this.rpcError(
                2001,
                "invalid_action",
                "rotationVariant must be an integer, got " + JSON.stringify(raw),
                "Use 0/1/2 for belts (0=straight, 1=left, 2=right). Omit the field to let the game auto-orient."
            );
        }
        const info = this.allowedRotationVariants(root, meta, variant);
        if (!info.allowed.includes(raw)) {
            const id = meta.getId();
            const isBeltFamily = id === "belt";
            throw this.rpcError(
                2001,
                "invalid_action",
                `rotationVariant ${raw} is not valid for ${id}|${variant} (allowed: ${info.allowed.join("/")})`,
                isBeltFamily
                    ? "Belts accept rv 0 (straight), 1 (left curve), 2 (right curve)."
                    : `${id} has no rv≠0 building code registered — its curved/alternate forms are derived by the game, not selectable. Omit rotationVariant.`
            );
        }
        return raw;
    }

    /**
     * 放一个建筑。返回放置后的 entity 或 null。
     *
     * place 的可选字段（逐格精确指定拓扑用）：
     *   rotationVariant / rv —— 显式指定弯道变体。省略 = 游戏按邻居自动定向（既有语义，一字不改）。
     *   originalRotation / orig —— 透传给 placeOne 的 originalRotation。
     *
     * ⚠️ rv 与 r 是**一对**：给了 rv 时 placeOne 不再调用 computeOptimalDirectionAndRotationVariantAtTile，
     *    也就不会为了弯道而改 rotation（自动路径在 belt.js:207/226 会把 rotation ±90）。
     *    所以复刻蓝图里的转角必须同时给 (r, rv)，只给 rv 会得到"朝向 r 的弯带"。
     * ⚠️ 邻居重算（本文件外，游戏侧）：BeltSystem.updateSurroundingBeltPlacement 挂在 entityAdded 上，
     *    每放一格都会把**周围一圈**的带子按邻居重算 rv 并覆写 code（systems/belt.js:120-210），
     *    唯一豁免是 immutableOperationRunning（belt.js:169）。也就是说：先 place 出转角、再 place 它的邻居，
     *    前一格的 rv 会被游戏改掉。本 op 的 mismatch 只比对**放置那一刻**的读回值；
     *    需要整块拓扑稳定时仍应走 paste_blueprint（它包了 performImmutableOperation）。
     *
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
            place: { fields: new Set(["building", "x", "y", "r", "variant", "rotationVariant", "rv", "originalRotation", "orig"]) },
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

        // 别名合并：rotationVariant/rv 与 originalRotation/orig 各自允许两种写法，
        // 同时给且不一致 → 2001（不猜调用方想要哪个）。
        const rvRaw = this.pickAlias(a, "rotationVariant", "rv");
        const origRaw = this.pickAlias(a, "originalRotation", "orig");
        const rv = this.resolveRotationVariant(root, meta, variant, rvRaw);
        let orig = null;
        if (origRaw !== undefined && origRaw !== null) {
            if (typeof origRaw !== "number" || !Number.isFinite(origRaw)) {
                throw this.rpcError(2001, "invalid_action", "originalRotation must be a number (degrees), got " + JSON.stringify(origRaw));
            }
            orig = this.normalizeRotation(origRaw);
        }

        const entity = this.placeOne(root, meta, a.x, a.y, rot, variant, rv, orig);
        if (!entity) {
            const hint = this.describeTileOccupant(root, a.x, a.y);
            throw this.rpcError(2002, "game_rejected", "cannot place " + a.building + " at (" + a.x + "," + a.y + ")", hint);
        }

        /* ★ 自证：读回真正落地的 code / rotation / rv ★
           游戏可能拒绝我们给的 rv（或 belt 系统在 entityAdded 里重算邻居），
           此时 applied=1 只说明"放下去了"，不说明"放对了"。调用方必须能自己判断。 */
        const sme = entity.components && entity.components.StaticMapEntity;
        const actualCode = sme ? sme.code : null;
        const table = this.ensureBuildingTables();
        const codeInfo = actualCode !== null ? table.byCode[actualCode] : null;
        let actualRv = codeInfo && typeof codeInfo.rotationVariant === "number" ? codeInfo.rotationVariant : null;
        if (actualRv === null && sme && typeof sme.getRotationVariant === "function") {
            try {
                actualRv = sme.getRotationVariant();
            } catch (e) {
                actualRv = null;
            }
        }
        const actualRotation = sme && typeof sme.rotation === "number" ? sme.rotation : null;

        // 未请求 rv 时 rotationVariant 不可比（游戏自动定向是既有语义，不算 mismatch）；
        // 未请求 r 时 rotation 同理 —— 老调用方只给 building+x+y，不能因为游戏自动转了方向就报 mismatch。
        const rvRequested = rv !== null;
        const rotRequested = a.r !== undefined && a.r !== null;
        const mismatch = (rvRequested && actualRv !== rv) || (rotRequested && actualRotation !== null && actualRotation !== rot);

        return {
            ok: true,
            op: "place",
            entity_uid: entity.uid,
            type: meta.getId(),
            applied: 1,
            failed: [],
            tick: root.time.now(),
            requested: { rotation: rotRequested ? rot : null, rotationVariant: rv },
            actual: { rotation: actualRotation, rotationVariant: actualRv, code: actualCode },
            mismatch,
        };
    }

    /** 取别名对（primary 优先），两者都给且值不同 → 2001。都缺 → undefined。 */
    pickAlias(a, primary, alias) {
        const hasP = a[primary] !== undefined && a[primary] !== null;
        const hasA = a[alias] !== undefined && a[alias] !== null;
        if (hasP && hasA && a[primary] !== a[alias]) {
            throw this.rpcError(
                2001,
                "invalid_action",
                `${primary} and ${alias} disagree (${JSON.stringify(a[primary])} vs ${JSON.stringify(a[alias])})`,
                "They are aliases — pass only one of them."
            );
        }
        return hasP ? a[primary] : hasA ? a[alias] : undefined;
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

        const target = want === "fast_forward" ? "fast-forward" : want;

        // 1.5.6 的发布包只把 RegularGameSpeed 注册进序列化工厂
        // （game_speed_registry.js: "Others are disabled for now"）。
        // paused / fast-forward 因此**不可序列化**：一旦成为当前速度又存档，
        // 读档时 SavegameSerializer 报 `Invalid class id: <id> (factory is gamespeed)`，
        // 整个存档被判「损坏、无法恢复」。这条路不能靠"事后修存档"补救，
        // 只能不让世界进入该状态。
        const registry = shapez.gGameSpeedRegistry;
        if (registry && typeof registry.hasId === "function" && !registry.hasId(target)) {
            throw this.rpcError(
                2002,
                "game_rejected",
                "speed '" + want + "' is not registered in this build and would make the savegame unreadable",
                target + " is absent from gGameSpeedRegistry (only 'regular' is registered in 1.5.6). " +
                    "Saving while in this speed corrupts the save. Use step/await for fast-forwarding."
            );
        }

        // 1.5.6 的发布包里 `globalConfig.fastForwardSpeed` 从未被定义（只在
        // FastForwardGameSpeed 里被读取），于是 getTimeMultiplier() 返回 undefined。
        // game_time.internalAddDeltaToBudget 做 `budget += deltaMs * multiplier`，
        // undefined 会把预算污染成 NaN，之后 `while (budget >= deltaMs)` 永远为假 ——
        // 整个游戏的逻辑时钟就此停摆，切回 regular 也救不回来（NaN + 任何数 = NaN）。
        // 这个 Mod 曾经踩过：一次 set_speed fast_forward 之后所有产线"看着在跑其实不动"。
        // 所以在应用之前先把乘数验一遍，不合法就拒绝，而不是把世界弄坏再报错。
        const probe = new Ctor(root);
        const mult = probe.getTimeMultiplier();
        if (!Number.isFinite(mult) || mult <= 0) {
            throw this.rpcError(
                2002,
                "game_rejected",
                "speed '" + want + "' has an invalid time multiplier (" + String(mult) + ")",
                want === "fast_forward"
                    ? "This build has no globalConfig.fastForwardSpeed, so fast_forward would freeze the game clock. Use step/await instead."
                    : "Pick regular."
            );
        }

        const current = root.time.getSpeed().getId();
        if (current !== target) {
            root.time.setSpeed(probe);
        }
        // 预算若已是非有限值（被更早的一次坏速度污染过），乘数校验救不了它 ——
        // 显式归零一次，让下一次 internalAddDeltaToBudget 从干净的数字重新累加。
        const budget = root.time.logicTimeBudget;
        const repaired = !Number.isFinite(budget);
        if (repaired) root.time.logicTimeBudget = 0;
        return {
            ok: true,
            op: "set_speed",
            speed: want,
            time_multiplier: mult,
            budget_repaired: repaired,
            tick: root.time.now(),
        };
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
        // 载入一个以 fast-forward 存盘的存档时，预算在第一次 internalAddDeltaToBudget
        // 里就被 NaN 污染，而根因（空的 fastForwardSpeed）在存档之外。这里在推进前
        // 先把它归零 —— 否则 step 会一直"成功"地推进 0 tick，调用方无从判断。
        if (!Number.isFinite(root.time.logicTimeBudget)) {
            root.time.logicTimeBudget = 0;
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
        /* ★ 必须同时推进 productionAnalytics ★
           游戏主循环里（core.js:286-296）每帧做两件事：
             root.time.performTicks(deltaMs, boundInternalTick)
             root.productionAnalytics.update()
           而 productionAnalytics.update() 是唯一会让**时间片轮转**的地方
           （production_analytics.js:128-133，超过 analyticsSliceDurationSeconds 就 startNewSlice）。

           这里原来只调 performTicks —— 于是整个 step 期间时间片**根本不轮转**，
           40~60 秒的产量全部压进当前最后一片。
           后果：production 的 delivered_per_sec 按 `总量 / (片数×10秒)` 折算，
           而那个片实际代表了几十秒 → 速率被放大数倍。
           实测：真实 0.5/s 的线在 step 7200+4800 后报 1.34/s（放大 2.68×），
           一条只有理论值 42% 的产线会被判成达标。

           这不是档位问题，是"step 语义与真实时间不一致"。必须补上。 */
        try {
            for (let i = 0; i < ticks; ++i) {
                root.time.performTicks(deltaMs, core.boundInternalTick);
                if (root.productionAnalytics && typeof root.productionAnalytics.update === "function") {
                    root.productionAnalytics.update();
                }
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
        // 推进了 0 个 tick 却返回 ok，是把"世界坏了"伪装成"命令成功"。
        // 当初就是这样：产线其实早就死了，而 step 一路报 ok，我据此认定工厂在跑。
        if (actualTicks <= 0) {
            const speedId = root.time.getSpeed().getId();
            throw this.rpcError(
                2002,
                "game_rejected",
                "step advanced 0 ticks (speed=" + speedId + ", budget=" + root.time.logicTimeBudget + ")",
                "The game clock is not advancing. Check debug_loop for the budget/speed state."
            );
        }
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

        /* ★ 蓝图里有没有隧道？★
           code 22=sender / 23=receiver（`buildings/underground_belt.js:45-48` + 存档实机 107 对）。
           有隧道就必须在粘贴期间关掉 `enableTunnelSmartplace`，否则：
             sender 先落 → receiver 后落 → `onEntityManuallyPlaced`（underground_belt.js:53）
             把两者之间同向的带子全删掉，而 `applied` 仍然显示成功。
           实机 A/B 复现：开 → 之间带子 2→0；关 → 2→2。见 research/ai-plan/tmp/TUNNEL-VERIFIED.md。 */
        const hasTunnel = items.some(it => it.code === 22 || it.code === 23);

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
                        const r = ((Number(it.rot) || 0) % 360 + 360) % 360;
                        const w = r === 90 || r === 270 ? dim.y : dim.x;
                        const h = r === 90 || r === 270 ? dim.x : dim.y;
                        /* ★ 180/270 要朝**负方向**长 ★
                           游戏的 getTileSpaceBounds（static_map_entity.js:127-141）里
                           origin 是锚点：rot=0 向右下长，rot=180 向左上长。
                           这里原来无条件 `wx + cx` —— 于是 rot=180/270 的机器
                           左半/上半格完全不参与占用检查，dry_run 给假绿。
                           实测：rot=180 的 cutter 左半格压着既有带子时，
                           dry_run 报 would_delete=0 / destroys=0，真贴后旧 uid 消失。

                           ⚠️ 跳过 origin 的判据必须在**平移之后**算：
                           第一版写成 `if (cx===0 && cy===0) continue`（平移前），
                           而 ox=-1 时该跳的是 (cx=1,cy=0)，不是 (cx=0,cy=0) ——
                           结果只查了 origin，左半格仍然漏检。现在直接算世界坐标再比。 */
                        const ox = (r === 180 || r === 270) ? -(w - 1) : 0;
                        const oy = (r === 180 || r === 270) ? -(h - 1) : 0;
                        for (let cx = 0; cx < w; cx++) for (let cy = 0; cy < h; cy++) {
                            const px = wx + ox + cx, py = wy + oy + cy;
                            if (px === wx && py === wy) continue;   // origin 已在 cells 里
                            cells.push([px, py]);
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
                /* 隧道预检：告诉调用方"真粘贴会临时改一个游戏设置"。
                   这是**唯一**会在 paste 期间被改动的全局状态，必须显式报告，
                   否则调用方无法解释"为什么我贴完之后设置变了"（本包会恢复，但如
                   粘贴中途崩溃则不会）。 */
                tunnels: hasTunnel
                    ? { in_plan: items.filter(it => it.code === 22 || it.code === 23).length,
                        will_disable_smartplace: true,
                        note: "粘贴期间会临时关闭 enableTunnelSmartplace，结束后恢复原值" }
                    : null,
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
        /* ★ 含隧道时临时关闭 smartplace ★
           必须在 performBulkOperation **之外**切换，且用 try/finally：
             · 外面切：smartplace 的删除发生在 `entityManuallyPlaced` 回调里，
               而该信号在 placeOne 内部就 dispatch 了 —— 包在 bulk 里太晚；
             · finally 恢复：即使粘贴抛错也要还原玩家的设置，绝不留下副作用。
           只在**原本是开**的时候才关（若玩家本来就关着，不要多此一举地"开回来"）。
           两个分支都要走这段 —— 挂起逻辑与"有没有 immutable 包装"无关。 */
        const settings = this.app && this.app.settings;
        const wasSmart = hasTunnel && settings
            && settings.getAllSettings().enableTunnelSmartplace === true;
        if (wasSmart) settings.updateSetting("enableTunnelSmartplace", false);
        try {
            if (root.logic.performImmutableOperation) {
                root.logic.performBulkOperation(() => root.logic.performImmutableOperation(placeAll));
            } else {
                root.logic.performBulkOperation(placeAll);   // 兼容旧版签名（理论上 1002 已挡）
            }
        } finally {
            if (wasSmart) settings.updateSetting("enableTunnelSmartplace", true);
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
            // 含隧道时如实报告"粘贴期间关过 smartplace 并已恢复"
            tunnels: hasTunnel ? { in_plan: items.filter(it => it.code === 22 || it.code === 23).length, smartplace_suspended: true } : null,
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

    /**
     * 诊断：把离屏绘制需要的构造器/字段在真实运行时的位置报出来。
     *
     * 这些名字在不同打包版本里可能不同（`DrawParameters` vs `gDrawParameters`），
     * 猜错会让 screenshot 静默画不出东西 —— 与其猜，不如让游戏自己说。
     */
    debugCanvasApi() {
        const root = this.requireRoot();
        const shapez = (window).shapez || {};
        const names = Object.keys(shapez).sort();
        const pick = k => {
            try { return typeof shapez[k]; } catch (e) { return "throw"; }
        };
        const interesting = {};
        for (const k of names) {
            if (/draw|param|rect|theme|global|config|atlas|sprite/i.test(k)) interesting[k] = pick(k);
        }
        // 从 root 侧找可用的 DrawParameters 实例
        let sampleFromCore = null;
        try {
            const core = root.core || (root.app && root.app.gameCore) || null;
            if (core) {
                sampleFromCore = {
                    core_keys: Object.keys(core).filter(k => /draw|param/i.test(k)),
                    has_lastDrawParameters: !!core.lastDrawParameters,
                };
            }
        } catch (e) { sampleFromCore = { error: String(e && e.message ? e.message : e) }; }
        // 试着真的构造一次 DrawParameters 看会不会炸
        let ctorTest = null;
        try {
            const C = shapez.DrawParameters || shapez.gDrawParameters;
            if (typeof C === "function") {
                const r = new C({ context: null, visibleRect: { x: 0, y: 0 }, desiredAtlasScale: "1.0", zoomLevel: 1, root });
                ctorTest = { ok: true, keys: Object.keys(r) };
            } else {
                ctorTest = { ok: false, reason: "window.shapez 上没有 DrawParameters" };
            }
        } catch (e) { ctorTest = { ok: false, error: String(e && e.message ? e.message : e) }; }
        return {
            shapez_global_present: !!(window).shapez,
            shapez_key_count: names.length,
            interesting_shapez_keys: interesting,
            drawParameters_ctor_test: ctorTest,
            core_probe: sampleFromCore,
            hub_component_names: (() => {
                try {
                    const out = [];
                    for (const e of (root.entityMgr && root.entityMgr.entities) || []) {
                        const sme = e.components && e.components.StaticMapEntity;
                        if (sme && sme.code === 26) {
                            out.push({ uid: e.uid, origin: sme.origin, comps: Object.keys(e.components) });
                        }
                    }
                    return out.slice(0, 3);
                } catch (e) { return [{ error: String(e && e.message ? e.message : e) }]; }
            })(),
            canvas: root.canvas ? { w: root.canvas.width, h: root.canvas.height } : null,
            gameWidth: root.gameWidth,
            gameHeight: root.gameHeight,
            camera: { x: root.camera.center.x, y: root.camera.center.y, zoom: root.camera.zoomLevel },
            tileSize: this.tileSize(),
            dpi: this.deviceDPI(),
        };
    }

    /**
     * 诊断：应用/状态机的内部健康度。
     *
     * 为什么需要它：`new_game` / `load_save` 偶尔会把游戏搞成「状态切到了 InGameState，
     * 但 world 没建起来」的死局，而且 RPC 还回 `ok:true`。只能重启进程才能恢复。
     * 外部看到的现象是 `status.in_game === false`，看不出为什么。
     *
     * 这里把判断"为什么进不去"需要的几个内部量一次报全：
     *   · `APP_ERROR_OCCURED` —— 游戏自己的崩溃标志。`state_manager.js:58` 一旦它
     *     为真，**所有** `moveToState` 都会被静默跳过（只打一行 console.warn），
     *     这就是"切状态成功但什么都没发生"的直接原因。
     *   · `InGameState.stage` —— 加载分 s1..s10 十步，卡在哪一步能区分
     *     "还没开始加载" 和 "加载到一半崩了"。
     *   · `root` 是否存在 —— 状态对了但没有 root 就是半死。
     */
    debugAppState() {
        const out = {
            state_key: null,
            app_error_occurred: null,
            state_manager_keys: null,
            root_present: !!this.root,
            mod_version: "0.1.0",
        };
        try {
            const st = this.app && this.app.stateMgr && this.app.stateMgr.currentState;
            out.state_key = st && st.getKey ? st.getKey() : null;
            // 加载阶段：s1..s10。只在 InGameState 上有意义
            if (st && typeof st.stage === "string") out.ingame_stage = st.stage;
            if (st && st.stage !== undefined && typeof st.stage !== "string") out.ingame_stage = String(st.stage);
            if (st && st.savegame) {
                out.savegame = {
                    internal_id: st.savegame.internalId || null,
                    is_saveable: typeof st.savegame.isSaveable === "function" ? !!st.savegame.isSaveable() : null,
                };
            }
            // 状态机里注册了哪些 state（能看出 InGameState 在不在）
            const mgr = this.app && this.app.stateMgr;
            if (mgr && mgr.stateClasses) out.state_manager_keys = Object.keys(mgr.stateClasses);
        } catch (e) {
            out.state_error = String(e && e.message ? e.message : e);
        }
        try {
            out.app_error_occurred = !!(window).APP_ERROR_OCCURED;
        } catch (e) {
            out.app_error_error = String(e && e.message ? e.message : e);
        }
        try {
            out.page_visible = !!(this.app && this.app.pageVisible);
            out.focused = !!(this.app && this.app.focused);
        } catch (e) { /* 忽略 */ }
        // 加载覆盖层：卡住时它通常是显示的
        try {
            const st = this.app && this.app.stateMgr && this.app.stateMgr.currentState;
            if (st && st.loadingOverlay) {
                out.loading_overlay_attached = typeof st.loadingOverlay.isAttached === "function"
                    ? !!st.loadingOverlay.isAttached() : null;
            }
        } catch (e) { /* 忽略 */ }
        return out;
    }

    /**
     * 截取世界画面。
     *
     * 旧实现是 `root.canvas.toDataURL()` —— 它有三个硬缺陷，都是实测踩到的：
     *
     *  1. **HUD 画在同一张 canvas 上**。`core.draw()` 的最后一步是 `root.hud.draw(params)`
     *     （recon/upstream-full/src/js/game/core.js:490），所以工具栏、任务面板、
     *     正在看的 hub 弹窗全都会被截进去，把世界内容挡住。
     *     实测：钌切割机 `(4,-13)` 被 hub 面板完全遮住，截图里根本看不见。
     *
     *  2. **画面是"窗口现在什么样"，不是"我要看的那块"**。相机改位置是平滑插值
     *     （`camera.js:983`，每步只走 0.8%），且 `shouldRender()` 在窗口不可见时
     *     直接返回 false（`core.js:303-313`）—— 此时 canvas 停在上一帧，
     *     截出来是过期画面。实测：设完 camera 等 3 秒截到的还是旧位置。
     *
     *  3. **没有区域捕获**。想截「某个 bbox 里有什么」只能先把相机挪过去，
     *     而挪动本身受窗口尺寸与 DPI 影响，结果不可复现。
     *
     * 新实现不碰 `root.canvas`，而是**自己建一张离屏 canvas**，直接调用游戏自己的
     * 绘制函数（`root.map.drawBackground` / `systems.belt.drawBeltItems` /
     * `root.map.drawForeground` / `systems.hub.draw`），用**自建的临时相机**决定
     * 看哪里。好处：
     *
     *  · 不带 HUD（因为压根不调 `root.hud.draw`）
     *  · 不受窗口可见性影响（不依赖 `shouldRender()`）
     *  · 相机是瞬移的（不需要插值，也不受 `clampToBounds` 干扰）
     *  · 可以由 `region` 直接指定 bbox，结果可复现
     *
     * params:
     *   region  [x0,y0,x1,y1]  世界格坐标；给了就按它取景（优先于 center/zoom）
     *   center  [x,y]          世界格坐标，取景中心（region 未给时生效，默认相机当前中心）
     *   zoom    number         缩放倍率（region 未给时生效，默认相机当前 zoom）
     *   width/height           输出逻辑尺寸（默认取游戏窗口尺寸）
     *   scale   0..1           输出缩放（在逻辑尺寸之基础上再缩放）
     *   hud     bool           是否画 HUD（默认 false；只有排查 UI 问题才需要 true）
     *   hideHubPanel bool      hub 面板不在 HUD 里，而是**烘焙进 hub 实体贴图**
     *                          （systems/hub.js:51），所以默认截图仍然挡着一大片。
     *                          true 时不画 hub sprite，改用红色色块标出 hub 的 4×4
     *                          位置 —— 这样它周围原本被盖住的产线能看见。
     *   margin  number         世界格的留白（默认 1）
     *   maxSide number         输出长边上限像素（默认 4096，防 OOM）
     *
     * 返回：png_base64 + w/h + 实际取景（worldRect / zoom），便于复现与断言。
     */
    async screenshot(p) {
        const root = this.requireRoot();
        const params = p || {};

        // ── 1. 决定输出画布尺寸（逻辑尺寸，不含 DPI）──
        let outW = Number.isFinite(params.width) ? params.width : root.gameWidth;
        let outH = Number.isFinite(params.height) ? params.height : root.gameHeight;
        if (!(outW > 0) || !(outH > 0)) {
            throw this.rpcError(2001, "invalid_action", "width/height 必须是正数");
        }

        // ── 2. 决定取景：region 优先，其次 center+zoom，最后沿用当前相机 ──
        const cam = root.camera;
        let camX, camY, zoom;
        const region = params.region;
        const wantHud = params.hud === true;
        const margin = Number.isFinite(params.margin) ? params.margin : 1;
        let worldRect = null;

        if (Array.isArray(region)) {
            if (region.length !== 4 || !region.every(Number.isFinite)) {
                throw this.rpcError(2001, "invalid_action", "region 必须是 [x0,y0,x1,y1] 四个有限数");
            }
            const [ax, ay, bx, by] = region;
            // region 是**格子**坐标。格子 (x,y) 覆盖世界像素 [x*ts, (x+1)*ts)。
            // 取景到格子边界外扩 margin 格，这样最外圈格子完整可见、不切边。
            const ts = this.tileSize();
            const x0 = Math.min(ax, bx) - margin;
            const y0 = Math.min(ay, by) - margin;
            const x1 = Math.max(ax, bx) + 1 + margin;
            const y1 = Math.max(ay, by) + 1 + margin;
            const worldW = (x1 - x0) * ts;
            const worldH = (y1 - y0) * ts;
            // 世界像素 → 屏幕像素：zoom 就是这个倍率（camera.transform 用 zoom 缩放）
            zoom = Math.min(outW / worldW, outH / worldH);
            // 让这块矩形居中
            const visW = outW / zoom;
            const visH = outH / zoom;
            camX = (x0 * ts + x1 * ts) / 2;
            camY = (y0 * ts + y1 * ts) / 2;
            worldRect = { cells: [x0, y0, x1 - 1, y1 - 1], px: [x0 * ts, y0 * ts, worldW, worldH], view: [camX - visW / 2, camY - visH / 2, visW, visH] };
        } else {
            if (Array.isArray(params.center)) {
                if (params.center.length !== 2 || !params.center.every(Number.isFinite)) {
                    throw this.rpcError(2001, "invalid_action", "center 必须是 [x,y]");
                }
                camX = params.center[0] * this.tileSize();
                camY = params.center[1] * this.tileSize();
            } else {
                camX = cam.center.x;
                camY = cam.center.y;
            }
            zoom = Number.isFinite(params.zoom) ? params.zoom : cam.zoomLevel;
        }
        if (!(zoom > 0) || !Number.isFinite(zoom)) {
            throw this.rpcError(2001, "invalid_action", "zoom 必须是正数");
        }
        zoom = Math.max(0.01, Math.min(40, zoom));

        // ── 3. 输出缩放 + 长边上限 ──
        const scale = params.scale === undefined ? 1 : params.scale;
        if (typeof scale !== "number" || !(scale > 0) || scale > 1) {
            throw this.rpcError(2001, "invalid_action", "scale must be a number in (0,1]");
        }
        const maxSide = Number.isFinite(params.maxSide) ? params.maxSide : 4096;
        let cssW = Math.max(1, Math.round(outW * scale));
        let cssH = Math.max(1, Math.round(outH * scale));
        const longSide = Math.max(cssW, cssH);
        if (longSide > maxSide) {
            const k = maxSide / longSide;
            cssW = Math.max(1, Math.round(cssW * k));
            cssH = Math.max(1, Math.round(cssH * k));
        }

        // ── 4. 建离屏 canvas，按设备像素密度放大（与游戏主 canvas 同口径）──
        const dpi = this.deviceDPI();
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(cssW * dpi));
        cv.height = Math.max(1, Math.round(cssH * dpi));
        const ctx = cv.getContext("2d");
        if (!ctx) throw this.rpcError(2003, "mod_error", "无法创建离屏 2D 上下文");
        // 与游戏一致：先把上下文按 dpi 缩放，之后所有绘制都用逻辑像素
        ctx.scale(dpi, dpi);
        ctx.imageSmoothingEnabled = true;
        try {
            ctx.imageSmoothingQuality = "high";
        } catch (e) { /* 老浏览器忽略 */ }

        // 背景：用游戏自己的地图底色，避免透明 PNG 在不同查看器里变成黑/白
        try {
            const bg = (window).THEME && (window).THEME.map && (window).THEME.map.background;
            ctx.fillStyle = bg || "#30343d";
        } catch (e) {
            ctx.fillStyle = "#30343d";
        }
        ctx.fillRect(0, 0, cssW, cssH);

        // ── 5. 组装 DrawParameters（与 core.draw() 同形）──
        const DrawParameters = this.drawParametersCtor();
        if (!DrawParameters) {
            throw this.rpcError(2003, "mod_error",
                "找不到 DrawParameters 构造器 —— 无法离屏绘制。这通常意味着游戏版本与 mod 不匹配。",
                "回退方案：传 { fallback: true } 走旧的 canvas 截图（会带 HUD）。");
        }

        // 视野矩形（世界像素）
        const visW = cssW / zoom;
        const visH = cssH / zoom;
        const left = camX - visW / 2;
        const top = camY - visH / 2;
        const visibleRect = this.rectCtor(left, top, visW, visH);

        // 纹理图集精度：与 core.draw 同一套阈值（core.js:400-406）
        let desiredAtlasScale = "0.25";
        const eff = (zoom / this.assetsDpi()) * dpi * this.assetsSharpness();
        const lowQuality = !!(root.app && root.app.settings && root.app.settings.getAllSettings
            && root.app.settings.getAllSettings().lowQualityTextures);
        if (eff > 0.5 && !lowQuality) desiredAtlasScale = this.originalSpriteScale();
        else if (eff > 0.35 && !lowQuality) desiredAtlasScale = "0.5";

        const dparams = new DrawParameters({
            context: ctx,
            visibleRect,
            desiredAtlasScale,
            zoomLevel: zoom,
            root,
        });

        // ── 6. 变换到世界空间（等价于 camera.transform，但用我们的 zoom/left/top）──
        ctx.save();
        ctx.transform(zoom, 0, 0, zoom, -zoom * left, -zoom * top);

        const systems = root.systemMgr.systems;
        const drew = [];
        const skip = [];
        // 世界内容。顺序照抄 core.draw()（core.js:452-490）——
        // 少画一层就会缺元素（比如漏 drawBeltItems 就看不见带上的物品）。
        // hub 的面板是**烘焙进实体贴图**的（systems/hub.js:51 redrawHubBaseTexture），
        // 不是 HUD —— 所以跳过 `root.hud.draw` 拿不掉它。它会盖住 hub 周围 4×4 以上
        // 一大片世界内容（实测遮住了钌切割机）。
        // `hideHubPanel:true` 时不调 hub 系统的 draw，改用色块标出 hub 的位置：
        // 既看得见"hub 在这"，又能看见它周围原本被盖住的产线。
        const hideHubPanel = params.hideHubPanel === true;
        const steps = [
            ["mapBackground", () => root.map.drawBackground(dparams)],
            ["beltItems", () => systems.belt && systems.belt.drawBeltItems(dparams)],
            ["mapForeground", () => root.map.drawForeground(dparams)],
            ...(hideHubPanel ? [] : [["hub", () => systems.hub && systems.hub.draw(dparams)]]),
        ];
        for (const [name, fn] of steps) {
            try { fn(); drew.push(name); }
            catch (e) { skip.push({ step: name, error: String(e && e.message ? e.message : e) }); }
        }

        // hub 位置标记：必须在世界内容**之后**画，否则被背景盖掉。
        if (hideHubPanel) {
            try {
                const hubEnts = (root.entityMgr && root.entityMgr.entities || [])
                    // 组件名是 "Hub"（实测 debug_canvas_api 读出），不是 "HubComponent"
                    .filter(e => e.components && (e.components.Hub || e.components.HubComponent));
                const ts = this.tileSize();
                for (const e of hubEnts) {
                    const sme = e.components.StaticMapEntity;
                    if (!sme) continue;
                    const o = sme.origin;
                    ctx.save();
                    ctx.globalAlpha = 0.3;
                    ctx.fillStyle = "#e8455f";
                    ctx.fillRect(o.x * ts, o.y * ts, 4 * ts, 4 * ts);
                    ctx.globalAlpha = 1;
                    ctx.strokeStyle = "#e8455f";
                    ctx.lineWidth = Math.max(1, 3 / zoom);
                    ctx.strokeRect(o.x * ts, o.y * ts, 4 * ts, 4 * ts);
                    ctx.restore();
                }
                skip.push({ step: "hub", reason: "hideHubPanel：不画面板，只画位置色块" });
            } catch (e) {
                skip.push({ step: "hub-mark", error: String(e && e.message ? e.message : e) });
            }
        }
        ctx.restore();

        // ── 7. 可选：HUD（默认关）──
        if (wantHud) {
            try {
                // HUD 需要屏幕空间参数：zoomLevel=1、可见矩形=整个逻辑画布
                dparams.zoomLevel = 1;
                dparams.visibleRect = this.rectCtor(0, 0, cssW, cssH);
                ctx.save();
                root.hud.draw(dparams);
                ctx.restore();
                drew.push("hud");
            } catch (e) {
                skip.push({ step: "hud", error: String(e && e.message ? e.message : e) });
            }
        } else {
            skip.push({ step: "hud", reason: "按需关闭（默认不画，避免遮挡世界）" });
        }

        // ── 8. 导出 ──
        let url;
        try {
            url = cv.toDataURL("image/png");
        } catch (e) {
            throw this.rpcError(2003, "mod_error", "canvas.toDataURL failed: " + e);
        }
        const comma = url.indexOf(",");
        const b64 = comma >= 0 ? url.slice(comma + 1) : url;

        if (!drew.length) {
            throw this.rpcError(2003, "mod_error",
                "一层都没画出来（所有绘制步骤都抛错）",
                JSON.stringify(skip));
        }

        return {
            png_base64: b64,
            w: cv.width,
            h: cv.height,
            css_w: cssW,
            css_h: cssH,
            dpi,
            zoom,
            hud: wantHud,
            hub_panel_hidden: params.hideHubPanel === true,
            world_rect: worldRect,
            view_px: [left, top, visW, visH],
            drew,
            skipped: skip,
        };
    }

    /** 一格的世界像素数（globalConfig.tileSize，游戏里恒为 32）。 */
    tileSize() {
        try {
            const g = (window).shapez && (window).shapez.globalConfig;
            if (g && Number.isFinite(g.tileSize)) return g.tileSize;
        } catch (e) { /* 下面兜底 */ }
        return 32;
    }

    /** 设备像素比，与游戏 core.resize 用的是同一个来源。 */
    deviceDPI() {
        try {
            const d = (window).devicePixelRatio;
            if (Number.isFinite(d) && d > 0) return Math.min(3, d);
        } catch (e) { /* 兜底 */ }
        return 1;
    }

    assetsDpi() {
        try {
            const g = (window).shapez && (window).shapez.globalConfig;
            if (g && Number.isFinite(g.assetsDpi)) return g.assetsDpi;
        } catch (e) { /* 兜底 */ }
        return 1;
    }

    assetsSharpness() {
        try {
            const g = (window).shapez && (window).shapez.globalConfig;
            if (g && Number.isFinite(g.assetsSharpness)) return g.assetsSharpness;
        } catch (e) { /* 兜底 */ }
        return 1;
    }

    originalSpriteScale() {
        return "1.0";
    }

    /** 找到一个可用的 DrawParameters 构造器（优先用游戏自带的，保证字段语义一致）。 */
    drawParametersCtor() {
        if (this._DrawParameters !== undefined) return this._DrawParameters;
        const shapez = (window).shapez || {};
        const cands = [
            shapez.DrawParameters,
            shapez.gDrawParameters,
            shapez.DrawParametersCtor,
        ];
        for (const c of cands) if (typeof c === "function") { this._DrawParameters = c; return c; }
        // 从已有对象反推：core 上可能挂着一份示例参数
        try {
            const root = this.root;
            const p = root && root.core && root.core.lastDrawParameters;
            if (p && p.constructor) { this._DrawParameters = p.constructor; return p.constructor; }
        } catch (e) { /* 忽略 */ }
        this._DrawParameters = null;
        return null;
    }

    /** 找到一个可用的 Rectangle 构造器。 */
    rectCtor(x, y, w, h) {
        const shapez = (window).shapez || {};
        const C = shapez.Rectangle || shapez.gRectangle;
        if (typeof C === "function") return new C(x, y, w, h);
        // 最小鸭子类型兜底：DrawParameters 只用到 visibleRect 的几个方法
        return {
            x, y, w, h,
            getLeft() { return x; }, getTop() { return y; },
            getRight() { return x + w; }, getBottom() { return y + h; },
            getWidth() { return w; }, getHeight() { return h; },
            containsPoint(px, py) { return px >= x && px < x + w && py >= y && py < y + h; },
            expandedInAllDirections(d) { return this.constructor ? new this.constructor(x - d, y - d, w + 2 * d, h + 2 * d) : { x: x - d, y: y - d, w: w + 2 * d, h: h + 2 * d }; },
        };
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

    /**
     * 删除存档（**走游戏自己的 deleteSavegame**，不是删磁盘文件）。
     *
     * 为什么必须走游戏 API：直接 `fs.unlink` 只能删掉文件，游戏内存里的索引还在，
     * 于是 `list_saves` 会继续列出已经不存在的存档 —— 点进去才报 `no savegame`。
     * `app.savegameMgr.deleteSavegame(meta)` 会做两件事：`deleteAsync()` 删文件、
     * 再从 `currentData.savegames` 里摘掉那条索引并持久化（bundle 的 `_deleteSavegame`）。
     *
     * 安全约束（**这是玩家的数据，删错了找不回来**）：
     *   - 必须显式给 `internal_id`，不接受"删全部"之类的形式；
     *   - 拒绝删除当前正在玩的存档（`getCurrentSavegameId` 之类）；
     *   - `dry_run:true` 只报告将要删什么，不动手。
     *
     * params: { internal_id: string, dry_run?: boolean }
     */
    async deleteSave(p) {
        this.assertWritable("delete_save");
        const id = p.internal_id;
        if (typeof id !== "string" || id.length < 3) {
            throw this.rpcError(2001, "invalid_action", "internal_id (string) is required",
                "单条删除，不接受批量或通配；先用 list_saves 取 id");
        }
        const mgr = this.app.savegameMgr;
        const meta = (mgr.getSavegamesMetaData() || [])
            .find(m => (m.internalId !== undefined ? m.internalId : m.internal_id) === id);
        if (!meta) {
            throw this.rpcError(2002, "game_rejected", "no savegame with internal_id " + id,
                "Use list_saves to see available ids");
        }
        // 拒绝删当前世界：那会把玩家正在玩的东西从脚下抽走
        const cur = mgr.currentSavegameId !== undefined ? mgr.currentSavegameId
            : (mgr.currentSavegame ? mgr.currentSavegame.internalId : null);
        if (cur && cur === id) {
            throw this.rpcError(2003, "mod_error", "refusing to delete the savegame currently loaded",
                "先 load 到别的存档或回主菜单，再删这一个");
        }
        const info = { internal_id: id, level: meta.level === undefined ? null : meta.level,
            last_update: meta.lastUpdate === undefined ? null : meta.lastUpdate };
        if (p.dry_run === true) return { dry_run: true, would_delete: info };
        await mgr.deleteSavegame(meta);
        this.log("savegame deleted", id);
        return { ok: true, op: "delete_save", deleted: info };
    }

    /**
     * 修复因**未注册的游戏速度**而无法读档的存档。
     *
     * 症状：载入时报 `Invalid class id: fast-forward (factory is gamespeed)`，
     * 游戏界面上只说"存档损坏"。
     * 根因：1.5.6 只注册了 regular 速度，写出 fast-forward 的存档天然读不回来。
     * 数据本身没坏 —— 只是 dump.time.speed 指着一个工厂里不存在的类型。
     *
     * 做法：把该字段改写成 `{"$":"regular","data":{}}`，重新走游戏自己的
     * 序列化（compressObject + CRC + LZString），并**先备份原文件**。
     * 绝不能凭空造校验和：这里调用游戏的 compressX64 / computeCrc，
     * 保证写出的内容与游戏自己写的完全同构。
     *
     * params: { internal_id: string, dry_run?: boolean }
     */
    async repairSave(p) {
        this.assertWritable("repair_save");
        const id = p.internal_id;
        if (typeof id !== "string" || id.length < 3) {
            throw this.rpcError(2001, "invalid_action", "internal_id (string) is required");
        }
        const mgr = this.app.savegameMgr;
        const meta = (mgr.getSavegamesMetaData() || []).find(
            m => (m.internalId !== undefined ? m.internalId : m.internal_id) === id
        );
        if (!meta) {
            throw this.rpcError(2002, "game_rejected", "no savegame with internal_id " + id, "Use list_saves to see available ids");
        }
        await mgr.loadSavegameMetaData?.(meta) // no-op if absent
        const shapez = /** @type {any} */ (window).shapez;
        // 文件名规则来自 savegame.js: `super(app, "savegame-" + internalId + ".bin")`。
        // 不依赖 mgr 上是否存在 getSavegameFilename —— 那个方法在 1.5.6 里没有。
        const filename = "savegame-" + id + ".bin";
        let raw;
        try {
            raw = await this.app.storage.readFileAsync(filename);
        } catch (e) {
            throw this.rpcError(2003, "mod_error", "failed to read savegame file: " + e);
        }
        const text = typeof raw === "string" ? raw : String(raw);
        const prefixLen = 1; // compressionPrefix 是单个字符（\x01）
        const decompressed = shapez.decompressX64(text.substr(prefixLen));
        if (!decompressed) throw this.rpcError(2003, "mod_error", "savegame decompression failed");
        const checksum = decompressed.substring(0, 40);
        const jsonString = decompressed.substr(40);
        let parsed;
        try {
            parsed = JSON.parse(jsonString);
        } catch (e) {
            throw this.rpcError(2003, "mod_error", "savegame JSON is not parseable: " + e);
        }
        const decoded = shapez.decompressObject(parsed);
        const speed = decoded && decoded.dump && decoded.dump.time ? decoded.dump.time.speed : null;
        const speedId = speed && typeof speed === "object" ? speed.$ : null;
        const needsFix = speedId && speedId !== "regular" && speedId !== "paused";
        const report = {
            internal_id: id,
            current_speed_id: speedId,
            needs_fix: !!needsFix,
        };
        if (!needsFix) {
            return { ok: true, op: "repair_save", ...report, changed: false };
        }
        decoded.dump.time.speed = { $: "regular", data: {} };
        // 复用游戏自己的写入路径：compressObject → JSON → CRC → LZString
        const recompressed = shapez.compressObject(decoded);
        const newJson = JSON.stringify(recompressed);
        const newChecksum = shapez.computeCrc(newJson + this.savegameSalt());
        const out = shapez.compressionPrefix + shapez.compressX64(newChecksum + newJson);
        report.old_checksum = checksum;
        report.new_checksum = newChecksum;
        report.bytes_before = text.length;
        report.bytes_after = out.length;
        if (p.dry_run === true) {
            return { ok: true, op: "repair_save", ...report, dry_run: true, changed: false };
        }
        // 备份：绝不覆盖唯一副本
        const backupName = filename + ".pre-speed-repair-" + new Date().toISOString().replace(/[:.]/g, "-");
        try {
            await this.app.storage.writeFileAsync(backupName, text);
        } catch (e) {
            throw this.rpcError(2003, "mod_error", "failed to write backup before repair: " + e);
        }
        try {
            await this.app.storage.writeFileAsync(filename, out);
        } catch (e) {
            throw this.rpcError(2003, "mod_error", "failed to write repaired savegame: " + e);
        }
        this.log("savegame repaired:", id, backupName);
        return { ok: true, op: "repair_save", ...report, changed: true, backup: backupName };
    }

    /** 存档校验用的 salt（config.info.file，与 read_write_proxy 同源）。 */
    savegameSalt() {
        if (this._savegameSalt !== undefined) return this._savegameSalt;
        try {
            const shapez = /** @type {any} */ (window).shapez;
            // read_write_proxy 用的是 accessNestedPropertyReverse(globalConfig, ["file","info"])，
            // 这个 helper 从数组尾部往回走 —— 所以路径是 globalConfig.info.file，
            // 不是 globalConfig.file.info.file（写错一个层级就会得到一个永不对的校验和）。
            this._savegameSalt = shapez.globalConfig.info.file;
        } catch (e) {
            this._savegameSalt = null;
        }
        return this._savegameSalt;
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
        return this.awaitWorldReady("load_save");
    }

    /**
     * 等世界真的建起来，再回 ok。
     *
     * 为什么不能只看状态名：`moveToState("InGameState")` 只是换了状态对象，
     * 真正的 world 是 InGameState 加载完 s1..s10 之后才 `gameStarted.dispatch(root)`。
     * 中间任何一步崩了，状态名仍然是 InGameState 而 root 永远是 null ——
     * 实测就是这个形态：RPC 回 ok:true，`status.in_game` 却是 false，只能重启进程。
     *
     * 所以判据必须是 **`this.root` 非空**（它只由 `gameStarted` 信号注入），
     * 而不是 `currentState.getKey() === "InGameState"`。
     */
    async awaitWorldReady(opLabel, timeoutMs = 60000) {
        const ok = await this.waitFor(() => !!this.root, timeoutMs);
        if (ok) {
            return { ok: true, op: opLabel, loading: true };
        }
        const diag = this.debugAppState();
        // 分清两种失败，对症下药：
        //   ① APP_ERROR_OCCURED=true  ⇒ 游戏已经崩过，**任何** moveToState 都会被
        //      state_manager.js:58 静默跳过。只能重启进程，重试没用。
        //   ② 没崩但 root 迟迟不来  ⇒ 加载中途卡住，可以重试。
        const crashed = diag.app_error_occurred === true;
        throw this.rpcError(2003, "mod_error",
            opLabel + ": 状态切到了 " + (diag.state_key || "?")
                + "，但 world 没有建起来（root 仍为空）"
                + (crashed ? "；且 APP_ERROR_OCCURED=true" : ""),
            JSON.stringify({
                diagnosis: crashed
                    ? "游戏已处于崩溃状态：state_manager.js:58 会让后续所有 moveToState 静默跳过。必须重启游戏进程，重试无效。"
                    : "加载卡住：可能停在中途某个 stage。可以重试，反复卡住则需重启。",
                retry_worthwhile: !crashed,
                detail: diag,
            }));
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
        const ready = await this.awaitWorldReady("new_game");
        return {
            ...ready,
            game_mode: mode,
            internal_id: sg && sg.internalId ? sg.internalId : null,
        };
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
