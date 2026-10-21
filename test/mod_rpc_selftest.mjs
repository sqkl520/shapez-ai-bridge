/**
 * Mod RPC 协议层动态测试：用假 WebSocket 驱动完整的
 * connect → hello → RPC 请求 → 响应 → 错误映射 → 断线重连 流程。
 *
 * 与 mod_selftest.mjs 的分工：
 * - mod_selftest.mjs 测纯逻辑（参数校验、蓝图、成本公式）
 * - 本文件测协议交互（hello 内容、方法分发、错误 envelope、重连调度）
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.resolve(__dirname, "../src/mod/shapez-ai-bridge.js"), "utf8");

let pass = 0;
let fail = 0;
function check(name, fn) {
    try {
        fn();
        pass++;
        console.log("PASS", name);
    } catch (e) {
        fail++;
        console.log("FAIL", name, "->", (e && e.message) || e);
    }
}
function assert(c, m) {
    if (!c) throw new Error(m || "assertion failed");
}

// ── 假 WebSocket：记录所有发送，暴露 inject() 模拟桥接下行 ──
class FakeWebSocket {
    static instances = [];
    constructor(url) {
        this.url = url;
        this.readyState = 0; // CONNECTING
        this.sent = [];
        FakeWebSocket.instances.push(this);
    }
    send(data) {
        this.sent.push(JSON.parse(data));
    }
    close() {
        this.readyState = 3;
        this.onclose && this.onclose({ code: 1000 });
    }
    // 测试控制
    simulateOpen() {
        this.readyState = 1;
        this.onopen && this.onopen();
    }
    inject(obj) {
        this.onmessage && this.onmessage({ data: JSON.stringify(obj) });
    }
    simulateDrop() {
        this.readyState = 3;
        this.onclose && this.onclose({ code: 1006 });
    }
}

// ── stub shapez 环境 ──
const stubShapez = {
    Mod: class BaseMod {
        constructor(args) {
            this._baseArgs = args;
        }
    },
    Vector: class Vector {
        constructor(x, y) {
            this.x = x || 0;
            this.y = y || 0;
        }
    },
    PausedGameSpeed: class {
        getId() {
            return "paused";
        }
    },
    RegularGameSpeed: class {
        getId() {
            return "regular";
        }
    },
    FastForwardGameSpeed: class {
        getId() {
            return "fast-forward";
        }
    },
    compressX64: s => "C:" + s,
    decompressX64: s => String(s).replace(/^C:/, ""),
    gMetaBuildingRegistry: { getEntries: () => [] },
    gBuildingVariants: {},
    // The game exposes its real build metadata; the mod must read version from
    // here rather than trusting a hard-coded constant (red-team finding).
    BUILD_OPTIONS: { BUILD_VERSION: "1.5.6", BUILD_COMMIT_HASH: "ee2279d5" },
};

const timers = [];
const sandbox = {
    console: { log() {}, warn() {}, error() {} }, // 静音
    performance,
    setTimeout: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
    },
    clearTimeout: t => {
        if (t) t.cleared = true;
    },
    setInterval: () => ({}),
    clearInterval: () => {},
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    Error,
    WebSocket: FakeWebSocket,
    window: { shapez: stubShapez },
    shapez: stubShapez,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const wrapper =
    src +
    "\nif (typeof Mod !== 'undefined') { if (typeof METADATA !== 'object') { throw new Error('No METADATA'); } window.$shapez_registerMod(Mod, METADATA); }";
let registered = null;
sandbox.window.$shapez_registerMod = (modClass, meta) => {
    registered = { modClass, meta };
};
vm.runInContext(wrapper, sandbox, { filename: "shapez-ai-bridge.js" });

const signalHandlers = { gameStarted: [], stateEntered: [] };
const fakeLoader = {
    modInterface: {},
    signals: {
        gameStarted: { add: fn => signalHandlers.gameStarted.push(fn) },
        stateEntered: { add: fn => signalHandlers.stateEntered.push(fn) },
    },
};

function newMod() {
    FakeWebSocket.instances = [];
    timers.length = 0;
    return new registered.modClass({
        app: { stateMgr: { currentState: null, moveToState() {} }, savegameMgr: {} },
        modLoader: fakeLoader,
        meta: registered.meta,
        settings: { ws_url: "ws://127.0.0.1:7777/mod", allow_step: true, allow_write: true, max_entities: 20000 },
        saveSettings: () => {},
    });
}

function tick(n = 1) {
    // 把 onmessage 触发的异步 handleRpc 推完（依赖 microtask）
    return new Promise(r => setTimeoutNative(r, n));
}
const setTimeoutNative = globalThis.setTimeout;

// ── 测试 ──

await (async () => {
    // 1. init → connect → hello
    {
        const m = newMod();
        m.init();
        assert(FakeWebSocket.instances.length === 1, "one ws created");
        const ws = FakeWebSocket.instances[0];
        assert(ws.url === "ws://127.0.0.1:7777/mod", "url from settings");
        ws.simulateOpen();
        await tick();
        const hello = ws.sent.find(x => x.method === "hello");
        assert(hello, "hello sent on open");
        assert(hello.params.protocol === 1, "protocol 1");
        assert(hello.params.game_version === "1.5.6", "game version");
        assert(Array.isArray(hello.params.features) && hello.params.features.includes("step"), "features list");
        assert(hello.params.features.includes("blueprint"), "blueprint feature advertised");
    }
    check("hello handshake", () => {}); // 已在上块内断言过（保持计数器简单）

    // 1b. version is read from the game's own build metadata, not a constant
    {
        const m = newMod();
        assert(m.gameVersion() === "1.5.6", "reads BUILD_OPTIONS.BUILD_VERSION");
        assert(m.buildHash() === "ee2279d5", "reads BUILD_OPTIONS.BUILD_COMMIT_HASH");
        // And when the game reports a different version, the mod reports that.
        const orig = sandbox.shapez.BUILD_OPTIONS.BUILD_VERSION;
        sandbox.shapez.BUILD_OPTIONS.BUILD_VERSION = "9.9.9";
        const m2 = newMod();
        assert(m2.gameVersion() === "9.9.9", "follows the game when it changes (got " + m2.gameVersion() + ")");
        sandbox.shapez.BUILD_OPTIONS.BUILD_VERSION = orig;
        check("game version detected from BUILD_OPTIONS", () => {});
    }

    // 2. status RPC（无游戏世界）
    {
        const m = newMod();
        m.init();
        const ws = FakeWebSocket.instances[0];
        ws.simulateOpen();
        await tick();
        ws.inject({ jsonrpc: "2.0", id: 42, method: "status", params: {} });
        await tick();
        const res = ws.sent.find(x => x.id === 42);
        assert(res && res.result, "status responded");
        assert(res.result.in_game === false, "in_game false in menu");
        assert(res.result.mod_version, "mod_version present");
        check("status rpc in menu", () => {});
    }

    // 3. 未知方法 → -32601
    {
        const m = newMod();
        m.init();
        const ws = FakeWebSocket.instances[0];
        ws.simulateOpen();
        await tick();
        ws.inject({ jsonrpc: "2.0", id: 7, method: "nonsense", params: {} });
        await tick();
        const res = ws.sent.find(x => x.id === 7);
        assert(res && res.error, "error responded");
        assert(res.error.code === -32601, "code -32601 got " + res.error.code);
        check("unknown method -> -32601", () => {});
    }

    // 4. obs 无世界 → 1003
    {
        const m = newMod();
        m.init();
        const ws = FakeWebSocket.instances[0];
        ws.simulateOpen();
        await tick();
        ws.inject({ jsonrpc: "2.0", id: 8, method: "obs", params: {} });
        await tick();
        const res = ws.sent.find(x => x.id === 8);
        assert(res && res.error && res.error.code === 1003, "1003 for obs in menu");
        assert(res.error.data && res.error.data.code_name === "not_in_game", "code_name");
        check("obs without world -> 1003", () => {});
    }

    // 5. act 未知 op → 2001（即使没世界也要先校验动作）——注意顺序：会先撞 1003？
    {
        const m = newMod();
        m.init();
        const ws = FakeWebSocket.instances[0];
        ws.simulateOpen();
        await tick();
        ws.inject({ jsonrpc: "2.0", id: 9, method: "act", params: { op: "noop" } });
        await tick();
        const res = ws.sent.find(x => x.id === 9);
        // noop 不需要世界
        assert(res && res.result && res.result.ok === true, "noop works without world");
        check("noop works in menu", () => {});
    }

    // 6. 断线 → 重连调度（3s）
    {
        const m = newMod();
        m.init();
        const ws = FakeWebSocket.instances[0];
        ws.simulateOpen();
        await tick();
        assert(m.connected === true, "connected flag");
        ws.simulateDrop();
        assert(m.connected === false, "disconnected flag");
        const pending = timers.find(t => !t.cleared && t.ms === 3000);
        assert(pending, "reconnect scheduled at 3000ms");
        // 触发重连
        pending.fn();
        assert(FakeWebSocket.instances.length === 2, "second ws created after reconnect");
        check("reconnect after drop", () => {});
    }

    // 7. 重连退避翻倍
    {
        const m = newMod();
        m.init();
        const ws1 = FakeWebSocket.instances[0];
        ws1.simulateDrop();
        const t1 = timers.find(t => !t.cleared && t.ms === 3000);
        assert(t1, "first 3000");
        t1.fn(); // 触发第二次连接
        const ws2 = FakeWebSocket.instances[1];
        ws2.simulateDrop();
        const t2 = timers.filter(t => !t.cleared && t.ms > 3000);
        assert(t2.length >= 1, "second delay > 3000 (backoff)");
        check("reconnect backoff", () => {});
    }

    // 8. gameStarted 信号捕获 root
    {
        const m = newMod();
        m.init();
        const ws = FakeWebSocket.instances[0];
        ws.simulateOpen();
        await tick();
        const fakeRoot = {
            time: { now: () => 100, getIsPaused: () => false, getSpeed: () => ({ getId: () => "regular" }) },
            currentLayer: "regular",
            camera: { center: { x: 0, y: 0 }, zoomLevel: 1 },
            hubGoals: {
                level: 5,
                storedShapes: {},
                upgradeLevels: {},
                currentGoal: { definition: { getHash: () => "CuCuCuCu" }, required: 100, throughputOnly: false },
                getCurrentGoalDelivered: () => 10,
            },
            gameMode: { getHasFreeCopyPaste: () => false, getBlueprintShapeKey: () => "CuCuCuCu" },
            entityMgr: { entities: [] },
            map: {},
            logic: {},
            signals: { entityManuallyPlaced: { dispatch() {} } },
            canvas: {},
        };
        for (const fn of signalHandlers.gameStarted) fn(fakeRoot);
        ws.inject({ jsonrpc: "2.0", id: 11, method: "obs", params: { max_entities: 10 } });
        await tick();
        const res = ws.sent.find(x => x.id === 11);
        assert(res && res.result && res.result.in_game === true, "in_game true after gameStarted");
        assert(res.result.goal && res.result.goal.level === 5, "goal level from root");
        assert(res.result.goal.requirement.progress === 0.1, "progress computed");
        check("obs after gameStarted", () => {});
        // 退出游戏 → stateEntered 非 InGameState 应丢弃 root
        for (const fn of signalHandlers.stateEntered) fn({ getKey: () => "MainMenuState" });
        ws.inject({ jsonrpc: "2.0", id: 12, method: "obs", params: {} });
        await tick();
        const res2 = ws.sent.find(x => x.id === 12);
        assert(res2 && res2.error && res2.error.code === 1003, "root dropped after leaving game");
        check("root dropped on state exit", () => {});
    }

    // 9. batch 部分失败混合
    {
        const m = newMod();
        m.init();
        const ws = FakeWebSocket.instances[0];
        ws.simulateOpen();
        await tick();
        ws.inject({
            jsonrpc: "2.0",
            id: 13,
            method: "batch",
            params: { actions: [{ op: "noop" }, { op: "explode" }, { op: "noop" }] },
        });
        await tick();
        const res = ws.sent.find(x => x.id === 13);
        assert(res && res.result && Array.isArray(res.result.results), "batch results array");
        assert(res.result.results.length === 3, "3 results");
        assert(res.result.results[0].ok === true, "first ok");
        assert(res.result.results[1].ok === false && res.result.results[1].error.code === 2001, "second 2001");
        assert(res.result.results[2].ok === true, "third ok (batch continues after 2001)");
        check("batch mixed results", () => {});
    }

    // 10. batch 遇 1003 中断
    {
        const m = newMod();
        m.init();
        const ws = FakeWebSocket.instances[0];
        ws.simulateOpen();
        await tick();
        ws.inject({
            jsonrpc: "2.0",
            id: 14,
            method: "batch",
            params: { actions: [{ op: "noop" }, { op: "place", building: "belt", x: 0, y: 0 }, { op: "noop" }] },
        });
        await tick();
        const res = ws.sent.find(x => x.id === 14);
        assert(res.result.results.length === 2, "batch aborts hard errors (1003): got " + res.result.results.length + " results");
        assert(res.result.results[1].error.code === 1003, "second is 1003");
        check("batch aborts on 1003", () => {});
    }
})();

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
