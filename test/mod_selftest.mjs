/**
 * Mod 文件语法与逻辑静态检查（不依赖游戏）。
 * 做法：在 Node vm 里用 stub shapez / WebSocket / window 加载 mod 源码，
 * 然后实例化 Mod、调用纯逻辑方法（validateAction / normalizeRotation / rpcError 等）。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.resolve(__dirname, "../src/mod/shapez-ai-bridge.js");
const src = readFileSync(modPath, "utf8");

let pass = 0;
let fail = 0;
function check(name, fn) {
    try {
        fn();
        pass++;
        console.log("PASS", name);
    } catch (e) {
        fail++;
        console.log("FAIL", name, "->", e && e.message);
    }
}
function assert(cond, msg) {
    if (!cond) throw new Error(msg || "assertion failed");
}

// ---- stub 环境 ----
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
        static getId() {
            return "paused";
        }
        getId() {
            return "paused";
        }
    },
    RegularGameSpeed: class {
        static getId() {
            return "regular";
        }
        getId() {
            return "regular";
        }
    },
    FastForwardGameSpeed: class {
        static getId() {
            return "fast-forward";
        }
        getId() {
            return "fast-forward";
        }
    },
    compressX64: s => "COMPRESSED:" + s,
    decompressX64: s => s.replace(/^COMPRESSED:/, ""),
    gMetaBuildingRegistry: {
        getEntries: () => [
            { getId: () => "belt" },
            { getId: () => "miner" },
        ],
    },
    gBuildingVariants: {
        1: { metaInstance: { getId: () => "belt" }, variant: "default", rotationVariant: 0 },
        7: { metaInstance: { getId: () => "miner" }, variant: "default", rotationVariant: 0 },
    },
};

const sandbox = {
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    Error,
    WebSocket: class StubWebSocket {
        constructor() {
            this.readyState = 0;
        }
        send() {}
        close() {}
    },
    window: {
        shapez: stubShapez,
        APP_ERROR_OCCURED: false,
    },
    shapez: stubShapez,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

check("mod source loads without syntax error", () => {
    // 复刻游戏 modloader 的加载方式：源码 + 尾部包装，同一函数作用域求值。
    const wrapper =
        src +
        "\nif (typeof Mod !== 'undefined') { if (typeof METADATA !== 'object') { throw new Error('No METADATA'); } window.$shapez_registerMod(Mod, METADATA); }";
    let registered = null;
    sandbox.window.$shapez_registerMod = (modClass, meta) => {
        registered = { modClass, meta };
    };
    vm.runInContext(wrapper, sandbox, { filename: "shapez-ai-bridge.js" });
    assert(registered, "registerMod must be called");
    assert(typeof registered.modClass === "function", "Mod class must be registered");
    sandbox.__ModClass = registered.modClass;
    sandbox.__METADATA = registered.meta;
});

check("METADATA has required fields", () => {
    const m = sandbox.__METADATA;
    assert(m.id && typeof m.id === "string", "metadata.id");
    assert(m.version && typeof m.version === "string", "metadata.version");
    assert(m.minimumGameVersion === "1.5.6", "minimumGameVersion pinned to 1.5.6");
});

const fakeLoader = {
    modInterface: {},
    signals: {
        gameStarted: { add() {} },
        stateEntered: { add() {} },
    },
};

function newMod() {
    return new sandbox.__ModClass({
        app: { stateMgr: { currentState: null }, savegameMgr: {} },
        modLoader: fakeLoader,
        meta: sandbox.__METADATA,
        settings: { ws_url: "ws://127.0.0.1:7777/mod", allow_step: true, allow_write: true, max_entities: 20000 },
        saveSettings: () => {},
    });
}

check("Mod can be instantiated", () => {
    const m = newMod();
    assert(m.settings.ws_url.includes("7777"), "settings captured");
});

check("normalizeRotation works", () => {
    const m = newMod();
    assert(m.normalizeRotation(0) === 0, "0");
    assert(m.normalizeRotation(90) === 90, "90");
    assert(m.normalizeRotation(450) === 90, "450 -> 90");
    assert(m.normalizeRotation(-90) === 270, "-90 -> 270");
    assert(m.normalizeRotation("junk") === 0, "junk -> 0");
    assert(m.normalizeRotation(44) === 0, "44 rounds to 0");
    assert(m.normalizeRotation(46) === 90, "46 -> 90");
});

check("validateAction rejects unknown op", () => {
    const m = newMod();
    let threw = null;
    try {
        m.validateAction({ op: "explode" });
    } catch (e) {
        threw = e;
    }
    assert(threw && threw.__rpcError && threw.__rpcError.code === 2001, "must be 2001");
    assert(String(threw.__rpcError.detail).includes("explode"), "detail must name the op");
});

check("validateAction rejects unknown field", () => {
    const m = newMod();
    let threw = null;
    try {
        m.validateAction({ op: "place", building: "belt", x: 1, y: 2, boom: true });
    } catch (e) {
        threw = e;
    }
    assert(threw && threw.__rpcError && threw.__rpcError.code === 2001, "unknown field must be 2001 (not silently ignored)");
    assert(String(threw.__rpcError.detail).includes("boom"), "detail names the bad field");
});

check("validateAction accepts valid ops", () => {
    const m = newMod();
    for (const a of [
        { op: "noop" },
        { op: "place", building: "belt", x: 1, y: 2 },
        { op: "place_path", building: "belt", from: [0, 0], to: [5, 0] },
        { op: "step", ticks: 60 },
        { op: "await", until: "hub_delivered_increased", timeout_ticks: 100 },
        { op: "paste_blueprint", text: "SZBP1.X", x: 0, y: 0 },
    ]) {
        m.validateAction(a);
    }
});

check("read_only gate blocks writes", () => {
    const m = newMod();
    m.settings.allow_write = false;
    let threw = null;
    try {
        m.assertWritable("place");
    } catch (e) {
        threw = e;
    }
    assert(threw && threw.__rpcError.code === 1004, "1004 expected");
    // 但只读方法不该被拦
    m.requireRoot = () => ({}); // stub
});

check("requireRoot gives 1003 when no root", () => {
    const m = newMod();
    let threw = null;
    try {
        m.requireRoot();
    } catch (e) {
        threw = e;
    }
    assert(threw && threw.__rpcError.code === 1003, "1003 expected");
});

check("observe request validation", () => {
    const m = newMod();
    // 未知字段
    let threw = null;
    try {
        m.validateObsRequest({ wat: 1 });
    } catch (e) {
        threw = e;
    }
    assert(threw && threw.__rpcError.code === 2001, "unknown obs field must fail");
    // 合法
    const r = m.validateObsRequest({ region: [0, 0, 10, 10], max_entities: 100 });
    assert(r.region[2] === 10 && r.max_entities === 100, "parsed");
    // 非法 region
    threw = null;
    try {
        m.validateObsRequest({ region: [0, 0, 0] });
    } catch (e) {
        threw = e;
    }
    assert(threw && threw.__rpcError.code === 2001, "bad region must fail");
});

check("resolveBuilding finds known + rejects unknown", () => {
    const m = newMod();
    const meta = m.resolveBuilding({}, "belt");
    assert(meta.getId() === "belt", "belt resolved");
    const meta2 = m.resolveBuilding({}, "Miner");
    assert(meta2.getId() === "miner", "case-insensitive miner resolved");
    let threw = null;
    try {
        m.resolveBuilding({}, "nonsense_building");
    } catch (e) {
        threw = e;
    }
    assert(threw && threw.__rpcError.code === 2001, "unknown building must be 2001");
    assert(String(threw.__rpcError.hint).includes("belt"), "hint lists available buildings");
});

check("stepTicks rejects out-of-range", () => {
    const m = newMod();
    const root = { hud: { shouldPauseGame: () => false }, dynamicTickrate: { deltaMs: 16 }, gameState: { core: {} }, time: {} };
    let threw = null;
    try {
        m.stepTicks(root, 0);
    } catch (e) {
        threw = e;
    }
    assert(threw && threw.__rpcError.code === 2001, "0 ticks -> 2001");
    threw = null;
    try {
        m.stepTicks(root, 999999);
    } catch (e) {
        threw = e;
    }
    assert(threw && threw.__rpcError.code === 2001, "too many ticks -> 2001");
});

check("blueprint export/import round trip shape", () => {
    const m = newMod();
    // stub root with two buildings
    const ents = [
        { uid: 1, components: { StaticMapEntity: { origin: { x: 5, y: 5 }, rotation: 90, code: 1 } } },
        { uid: 2, components: { StaticMapEntity: { origin: { x: 6, y: 5 }, rotation: 90, code: 1 } } },
    ];
    const placed = [];
    const root = {
        entityMgr: { entities: ents },
        time: { now: () => 42 },
        logic: {
            performBulkOperation: fn => fn(),
            tryPlaceBuilding: () => ({ uid: 99 }),
        },
        gameMode: { getHasFreeCopyPaste: () => true, getBlueprintShapeKey: () => "K" },
        hubGoals: { getShapesStoredByKey: () => 0, takeShapeByKey: () => {} },
    };
    const exp = m.opExportBlueprint(root, { region: [0, 0, 10, 10] });
    assert(exp.count === 2, "exported 2");
    assert(exp.text.startsWith("SZBP1."), "prefix");
    // paste it back
    const res = m.opPasteBlueprint(root, { text: exp.text, x: 100, y: 100 });
    assert(res.applied === 2, "pasted 2");
    assert(res.charged === false || res.charged === undefined || res.charged === false, "free mode");
});

check("blueprint version mismatch -> 2006", () => {
    const m = newMod();
    const payload = JSON.stringify({ v: 1, gv: "1.4.0", w: [0, 0], e: [] });
    const text = "SZBP1." + sandbox.shapez.compressX64(payload);
    const root = { time: { now: () => 0 }, logic: { performBulkOperation: fn => fn() } };
    let threw = null;
    try {
        m.opPasteBlueprint(root, { text, x: 0, y: 0 });
    } catch (e) {
        threw = e;
    }
    assert(threw && threw.__rpcError.code === 2006, "2006 expected");
});

check("place_path rejects diagonal", () => {
    const m = newMod();
    const root = { time: { now: () => 0 } };
    let threw = null;
    try {
        m.opPlacePath(root, { building: "belt", from: [0, 0], to: [5, 5] });
    } catch (e) {
        threw = e;
    }
    assert(threw && threw.__rpcError.code === 2001, "diagonal must fail with 2001");
});

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
