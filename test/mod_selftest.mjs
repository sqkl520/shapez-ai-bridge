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
/*
 * 造一个"够真"的实体桩：真游戏里 entity.serialize() 走各组件 getSchema()，
 * 这里把 StaticMapEntity / Storage 两个组件的 schema 照抄成 serialize/deserialize，
 * 这样 serializeEntity → delete → restoreEntity 的往返才有判别力
 * （空桩会让"存储计数丢了"这类缺陷照样绿）。
 */
function makeStubComponent(id, fields, data) {
    return Object.assign({
        __id: id,
        serialize() {
            const out = {};
            for (const k of fields) out[k] = this[k];
            return out;
        },
        deserialize(raw) {
            if (raw === null || raw === undefined) return "Got null data";
            for (const k of fields) {
                if (!Object.prototype.hasOwnProperty.call(raw, k)) return "Missing key in schema: " + k;
                this[k] = raw[k];
            }
        },
    }, data);
}

function makeStubEntity({ root, origin, rotation, originalRotation, rotationVariant, variant, buildingId, code, layer, tileSize }) {
    const components = {};
    const size = tileSize || { x: 1, y: 1 };
    components.StaticMapEntity = makeStubComponent(
        "StaticMapEntity",
        ["origin", "rotation", "originalRotation", "code"],
        {
            origin: { x: origin.x, y: origin.y }, rotation, originalRotation, code,
            // 与 static_map_entity.js:129-146 getTileSpaceBounds 同公式（还原前的覆盖检查靠它）
            getTileSpaceBounds() {
                const rot = ((rotation % 360) + 360) % 360;
                switch (rot) {
                    case 90: return { x: origin.x - size.y + 1, y: origin.y, w: size.y, h: size.x };
                    case 180: return { x: origin.x - size.x + 1, y: origin.y - size.y + 1, w: size.x, h: size.y };
                    case 270: return { x: origin.x, y: origin.y - size.x + 1, w: size.y, h: size.x };
                    default: return { x: origin.x, y: origin.y, w: size.x, h: size.y };
                }
            },
        }
    );
    if (buildingId === "storage") {
        // 与 components/storage.js:17-22 的 schema 同形
        components.Storage = makeStubComponent("Storage", ["storedCount", "storedItem"], {
            storedCount: 0, storedItem: null, maximumStorage: 5000,
        });
        components.ItemEjector = makeStubComponent("ItemEjector", ["slots"], { slots: [] });
    }
    if (buildingId === "belt") {
        // assignedPath 故意是**非 schema** 字段（components/belt.js:54-58 注释 "not serialized"）
        components.Belt = makeStubComponent("Belt", ["direction"], {
            direction: "top", assignedPath: null,
        });
    }
    return {
        root,
        uid: 0,
        layer: layer || "regular",
        registered: false,
        destroyed: false,
        queuedForDestroy: false,
        components,
        serialize() {
            const out = {};
            for (const id in components) {
                // 镜像 types.keyValueMap(..., includeEmptyValues=false)：空对象会被丢掉
                const s = components[id].serialize();
                if (Object.keys(s).length > 0) out[id] = s;
            }
            return { uid: this.uid, components: out };
        },
    };
}

const STUB_BUILDING_META = {};
function stubMeta(id, w, h, code, layer, replaceable) {
    const meta = {
        getId: () => id,
        getLayer: () => layer,
        getDimensions: () => ({ x: w, y: h }),
        getIsReplaceable: () => !!replaceable,
        createEntity(params) {
            return makeStubEntity(Object.assign({ buildingId: id, code, layer, tileSize: { x: w, y: h } }, params));
        },
    };
    STUB_BUILDING_META[id] = meta;
    return meta;
}

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
        1: { metaInstance: stubMeta("belt", 1, 1, 1, "regular", true), variant: "default", rotationVariant: 0 },
        // 带子的另外两个 rv 档位（belt.js:25-43：internalId 1/2/3 ↔ rv 0/1/2）。
        // 注册表里的存在性 = rv 合法性，测试必须镜像真机，否则 rv=1/2 会被误判非法。
        2: { metaInstance: { getId: () => "belt", getDimensions: () => ({ x: 1, y: 1 }), getIsReplaceable: () => true }, variant: "default", rotationVariant: 1 },
        3: { metaInstance: { getId: () => "belt", getDimensions: () => ({ x: 1, y: 1 }), getIsReplaceable: () => true }, variant: "default", rotationVariant: 2 },
        7: { metaInstance: { getId: () => "miner", getDimensions: () => ({ x: 1, y: 1 }), getIsReplaceable: () => false }, variant: "default", rotationVariant: 0 },
        9: { metaInstance: { getId: () => "cutter", getDimensions: () => ({ x: 2, y: 1 }), getIsReplaceable: () => false }, variant: "default", rotationVariant: 0 },
        // 隧道：22=sender(rv0) / 23=receiver(rv1)，1×1、不可替换（buildings/underground_belt.js:45-48）
        22: { metaInstance: { getId: () => "underground_belt", getDimensions: () => ({ x: 1, y: 1 }), getIsReplaceable: () => false }, variant: "default", rotationVariant: 0 },
        23: { metaInstance: { getId: () => "underground_belt", getDimensions: () => ({ x: 1, y: 1 }), getIsReplaceable: () => false }, variant: "default", rotationVariant: 1 },
        // 仓库 21（buildings/storage.js:22-30，2×2）：序列化还原的实机自证目标 ——
        // storedCount/storedItem 是判断"还原的是实体还是空壳"的关键字段。
        21: { metaInstance: stubMeta("storage", 2, 2, 21, "regular", false), variant: "default", rotationVariant: 0 },
        26: { metaInstance: stubMeta("hub", 4, 4, 26, "regular", false), variant: "default", rotationVariant: 0 },
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

/**
 * 把任意一份 mod 源码装进一个**独立**的沙箱并返回它的 Mod 类。
 * 用途：变异测试 —— 在不改仓库文件的前提下，加载"被改坏的那一行"。
 */
function loadModClass(sourceText) {
    const sb = {
        console: { log() {}, warn() {}, error() {} },
        performance, setTimeout, clearTimeout, setInterval, clearInterval,
        JSON, Math, Number, String, Object, Array, Error,
        WebSocket: class {
            constructor() { this.readyState = 0; }
            send() {}
            close() {}
        },
        window: { shapez: stubShapez, APP_ERROR_OCCURED: false },
        shapez: stubShapez,
    };
    sb.globalThis = sb;
    vm.createContext(sb);
    let registered = null;
    sb.window.$shapez_registerMod = (modClass, meta) => { registered = { modClass, meta }; };
    const wrapper = sourceText +
        "\nif (typeof Mod !== 'undefined') { if (typeof METADATA !== 'object') { throw new Error('No METADATA'); } window.$shapez_registerMod(Mod, METADATA); }";
    vm.runInContext(wrapper, sb, { filename: "shapez-ai-bridge.mutant.js" });
    return registered.modClass;
}

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

// ── rotationVariant 覆盖（蓝图粘贴必须尊重 code 里的弯道变体）──
// 背景：带子的弯道（直/左转/右转）在游戏里由邻居派生。粘贴蓝图时若也走这条路径，
// 结果就依赖邻居是否已就位 —— 这正是布局落不了地的根因。
// 修复后：paste_blueprint 把 code 里带的 rotationVariant 直接传下去。

check("placeOne honours rotationVariant override (blueprint paste path)", () => {
    const m = newMod();
    let captured = null;
    const root = {
        logic: {
            tryPlaceBuilding: p => { captured = p; return { uid: 1 }; },
        },
    };
    const meta = {
        getLayer: () => "regular",
        // 自动定向会被调用 —— 若发生，说明 override 没生效
        computeOptimalDirectionAndRotationVariantAtTile: () => ({ rotation: 90, rotationVariant: 2 }),
    };
    m.placeOne(root, meta, 0, 0, 0, "default", 1);
    assert(captured && captured.rotationVariant === 1, "must use override (1), not auto (2); got " + (captured && captured.rotationVariant));
    assert(captured.rotation === 0, "rotation stays as given");
});

check("placeOne falls back to auto-orientation when no override", () => {
    const m = newMod();
    let captured = null;
    const root = { logic: { tryPlaceBuilding: p => { captured = p; return { uid: 1 }; } } };
    const meta = {
        getLayer: () => "regular",
        computeOptimalDirectionAndRotationVariantAtTile: () => ({ rotation: 90, rotationVariant: 2 }),
    };
    m.placeOne(root, meta, 0, 0, 0, "default");   // 不传 override
    assert(captured && captured.rotationVariant === 2, "auto path must still be used (2); got " + (captured && captured.rotationVariant));
});

check("paste_blueprint passes code's rotationVariant through to placeOne", () => {
    const m = newMod();
    const rvs = [];
    const root = {
        time: { now: () => 0 },
        logic: {
            performBulkOperation: fn => fn(),
            tryPlaceBuilding: p => { rvs.push(p.rotationVariant); return { uid: 1 }; },
        },
        gameMode: { getHasFreeCopyPaste: () => true, getBlueprintShapeKey: () => "K" },
        hubGoals: { getShapesStoredByKey: () => 0, takeShapeByKey: () => {} },
    };
    // 用 stub 表里存在的 code（1 = belt/default）；验证 rv 被"从表里取"并传下去。
    const payload = JSON.stringify({ v: 1, gv: "1.5.6", w: [0, 0], e: [1, 0, 0, 0, 1, 2, 0, 0] });
    const text = "SZBP1." + sandbox.shapez.compressX64(payload);
    const res = m.opPasteBlueprint(root, { text, x: 10, y: 10, charge: false });
    assert(res.applied === 2, "both pasted; got " + res.applied);
    assert(rvs.length === 2, "two placements");
    assert(rvs[0] === 0 && rvs[1] === 0, "stub code 1 carries rv 0; got " + JSON.stringify(rvs));
});

// ── place 的 rotationVariant / originalRotation 显式指定（逐格微调用）──
// 背景：place 过去只给 rotation，带子的弯道变体（直/左弯/右弯）由游戏按当时邻居自动算，
// 于是 place 放不出可靠的转角（实测 r=0 与 r=90 都落成 code=1）。placeOne 早有 override 能力，
// 这里把它暴露给 place，并要求**读回实际 code 自证**——不能 applied=1 就当成功。

/** 造一个能跑 opPlace 的 root；makeResult 决定"游戏"最终返回的实体长什么样。 */
function placeStubRoot(makeResult) {
    const calls = [];
    const root = {
        time: { now: () => 99 },
        map: { getLayerContentXY: () => null },
        signals: { entityManuallyPlaced: { dispatch() {} } },
        logic: {
            tryPlaceBuilding: p => {
                calls.push(p);
                const r = makeResult ? makeResult(p) : { rotation: p.rotation, rotationVariant: p.rotationVariant, code: 1 };
                return {
                    uid: 900 + calls.length,
                    components: { StaticMapEntity: { rotation: r.rotation, code: r.code } },
                };
            },
        },
    };
    return { root, calls };
}

check("opPlace: 给 rv 时把它传进 placeOne（不被游戏自动定向覆盖）", () => {
    const m = newMod();
    // 自动定向若被调用会返回 rv=0；显式 rv=2 必须赢
    const meta = {
        getId: () => "belt",
        getLayer: () => "regular",
        computeOptimalDirectionAndRotationVariantAtTile: () => ({ rotation: 0, rotationVariant: 0 }),
    };
    m.resolveBuilding = () => meta;
    const { root, calls } = placeStubRoot(p => ({ rotation: p.rotation, rotationVariant: p.rotationVariant, code: 1 + p.rotationVariant }));
    const res = m.opPlace(root, { building: "belt", x: 10, y: -11, r: 0, rv: 2 });
    assert(calls.length === 1, "one placement");
    assert(calls[0].rotationVariant === 2, "override must reach tryPlaceBuilding, got " + calls[0].rotationVariant);
    assert(res.requested.rotationVariant === 2, "requested echoes rv");
    assert(res.actual.code === 3 && res.actual.rotationVariant === 2, "actual decoded from code 3, got " + JSON.stringify(res.actual));
    assert(res.mismatch === false, "matching rv -> no mismatch");
});

check("opPlace: 不给 rv 时行为不变（仍走游戏自动定向）—— 回归锁", () => {
    const m = newMod();
    let autoCalled = 0;
    const meta = {
        getId: () => "belt",
        getLayer: () => "regular",
        computeOptimalDirectionAndRotationVariantAtTile: () => {
            autoCalled++;
            return { rotation: 90, rotationVariant: 1 };
        },
    };
    m.resolveBuilding = () => meta;
    const { root, calls } = placeStubRoot(p => ({ rotation: p.rotation, rotationVariant: p.rotationVariant, code: 1 + p.rotationVariant }));
    const res = m.opPlace(root, { building: "belt", x: 0, y: 0 });
    assert(autoCalled === 1, "auto-orientation must still run when rv is absent, calls=" + autoCalled);
    assert(calls[0].rotation === 90 && calls[0].rotationVariant === 1, "auto result used, got " + JSON.stringify(calls[0]));
    assert(res.requested.rotationVariant === null, "no rv requested -> requested.rotationVariant null");
    assert(res.mismatch === false, "no rv requested -> rv is not comparable, mismatch must be false");
});

check("opPlace: rv 非法值报 2001（belt 越界 / 非整数 / 机器 rv≠0）", () => {
    const m = newMod();
    const bad = [
        { building: "belt", x: 0, y: 0, rv: 3 },          // belt 只有 0/1/2
        { building: "belt", x: 0, y: 0, rv: -1 },
        { building: "belt", x: 0, y: 0, rv: 1.5 },        // 非整数
        { building: "belt", x: 0, y: 0, rv: "1" },        // 字符串
        { building: "miner", x: 0, y: 0, rv: 1 },         // 注册表里 miner 只有 rv=0
    ];
    for (const a of bad) {
        const { root } = placeStubRoot();
        let threw = null;
        try {
            m.opPlace(root, a);
        } catch (e) {
            threw = e;
        }
        assert(threw && threw.__rpcError && threw.__rpcError.code === 2001,
            "must be 2001 for " + JSON.stringify(a) + ", got " + (threw && threw.__rpcError && threw.__rpcError.code));
    }
    // 合法值不抛
    const { root: okRoot } = placeStubRoot();
    m.opPlace(okRoot, { building: "belt", x: 0, y: 0, rv: 1 });
});

check("opPlace: rv 合法档位按建筑类型区分（belt 2 档 / 机器仅 0）", () => {
    const m = newMod();
    const beltMeta = { getId: () => "belt" };
    const minerMeta = { getId: () => "miner" };
    const beltInfo = m.allowedRotationVariants({}, beltMeta, "default");
    const minerInfo = m.allowedRotationVariants({}, minerMeta, "default");
    assert(beltInfo.allowed.join(",") === "0,1,2", "belt rv set, got " + beltInfo.allowed.join(","));
    assert(beltInfo.source === "registry", "belt rv set comes from the live registry, got " + beltInfo.source);
    assert(minerInfo.allowed.join(",") === "0", "miner only rv=0, got " + minerInfo.allowed.join(","));
    // 注册表里完全没有该建筑时兜底到文档表，而不是放行
    const tbl = m.ensureBuildingTables();
    const saved = tbl.rvByKey["belt/default"];
    delete tbl.rvByKey["belt/default"];
    try {
        const doc = m.allowedRotationVariants({}, beltMeta, "default");
        assert(doc.source === "documented" && doc.allowed.join(",") === "0,1,2", "fallback uses documented belt set, got " + JSON.stringify(doc));
        const cutterMeta = { getId: () => "cutter" };
        assert(m.allowedRotationVariants({}, cutterMeta, "default").allowed.join(",") === "0", "unknown machine falls back to [0]");
    } finally {
        tbl.rvByKey["belt/default"] = saved;
    }
});

check("opPlace: 实际 code 与期望 rv 不符 -> mismatch:true 且 actual 如实上报", () => {
    const m = newMod();
    m.resolveBuilding = () => ({ getId: () => "belt", getLayer: () => "regular" });
    // 游戏"拒绝"了 rv=2，仍旧落成直带（code=1）
    const { root } = placeStubRoot(() => ({ rotation: 0, rotationVariant: 0, code: 1 }));
    const res = m.opPlace(root, { building: "belt", x: 10, y: -11, rv: 2 });
    assert(res.ok === true && res.applied === 1, "placement itself succeeded");
    assert(res.requested.rotationVariant === 2, "requested rv=2");
    assert(res.actual.code === 1 && res.actual.rotationVariant === 0, "actual reports what landed, got " + JSON.stringify(res.actual));
    assert(res.mismatch === true, "mismatch must be true when the game substitutes its own rv");
});

check("opPlace: rotation 被拒绝也报 mismatch", () => {
    const m = newMod();
    m.resolveBuilding = () => ({ getId: () => "belt", getLayer: () => "regular" });
    const { root } = placeStubRoot(() => ({ rotation: 0, rotationVariant: 0, code: 1 }));
    const res = m.opPlace(root, { building: "belt", x: 0, y: 0, r: 90, rv: 0 });
    assert(res.requested.rotation === 90, "requested rotation 90");
    assert(res.actual.rotation === 0, "actual rotation 0");
    assert(res.mismatch === true, "rotation mismatch must be reported");
});

check("opPlace: originalRotation/orig 透传到 placeOne", () => {
    const m = newMod();
    m.resolveBuilding = () => ({ getId: () => "belt", getLayer: () => "regular" });
    const { root, calls } = placeStubRoot();
    m.opPlace(root, { building: "belt", x: 0, y: 0, r: 180, orig: 270 });
    assert(calls[0].originalRotation === 270, "originalRotation passed, got " + calls[0].originalRotation);
    assert(calls[0].rotation === 180, "rotation passed, got " + calls[0].rotation);
    // 别名冲突 -> 2001
    let threw = null;
    try {
        m.opPlace(placeStubRoot().root, { building: "belt", x: 0, y: 0, rotationVariant: 1, rv: 2 });
    } catch (e) {
        threw = e;
    }
    assert(threw && threw.__rpcError.code === 2001, "conflicting aliases must be 2001");
});

check("place accepts rotationVariant/rv/originalRotation/orig as known fields", () => {
    const m = newMod();
    m.validateAction({ op: "place", building: "belt", x: 0, y: 0, rotationVariant: 2 });
    m.validateAction({ op: "place", building: "belt", x: 0, y: 0, rv: 1, orig: 90 });
    m.validateAction({ op: "place", building: "belt", x: 0, y: 0, originalRotation: 0 });
});

// ── bulk_delete 的 dry_run（防误删真实工厂）──
// 背景：研究期间 4 次因区域边界算错而残留或误删，dry_run 让调用方先核对清单。

check("bulk_delete dry_run reports without deleting", () => {
    const m = newMod();
    const ents = [
        { uid: 1, components: { StaticMapEntity: { origin: { x: 5, y: 5 }, rotation: 0, code: 1 } } },
        { uid: 2, components: { StaticMapEntity: { origin: { x: 6, y: 5 }, rotation: 90, code: 1 } } },
        { uid: 3, components: { StaticMapEntity: { origin: { x: 99, y: 99 }, rotation: 0, code: 7 } } },   // 区域外
    ];
    let deleted = 0;
    const root = {
        entityMgr: { entities: ents },
        time: { now: () => 7 },
        logic: {
            performBulkOperation: fn => fn(),
            tryDeleteBuilding: () => { deleted++; return true; },
        },
    };
    const res = m.opBulkDelete(root, { region: [0, 0, 10, 10], dry_run: true });
    assert(res.dry_run === true, "must be flagged dry_run");
    assert(res.would_delete === 2, "must report 2 in-region entities; got " + res.would_delete);
    assert(deleted === 0, "must NOT delete anything; deleted=" + deleted);
    assert(Array.isArray(res.items) && res.items.length === 2, "must list items");
    assert(res.items.every(i => i.uid && i.type !== undefined && i.x !== undefined), "items carry uid/type/x");
    assert(res.by_type && res.by_type.belt === 2, "by_type summary; got " + JSON.stringify(res.by_type));
});

check("bulk_delete without dry_run still deletes", () => {
    const m = newMod();
    const ents = [
        { uid: 1, components: { StaticMapEntity: { origin: { x: 5, y: 5 }, rotation: 0, code: 1 } } },
    ];
    let deleted = 0;
    const root = {
        entityMgr: { entities: ents },
        time: { now: () => 7 },
        logic: {
            performBulkOperation: fn => fn(),
            tryDeleteBuilding: () => { deleted++; return true; },
        },
    };
    const res = m.opBulkDelete(root, { region: [0, 0, 10, 10] });
    assert(res.applied === 1, "applied=1");
    assert(deleted === 1, "did delete");
    assert(res.dry_run === undefined, "no dry_run flag on a real delete");
});

check("bulk_delete accepts dry_run as a known field", () => {
    const m = newMod();
    m.validateAction({ op: "bulk_delete", region: [0, 0, 1, 1], dry_run: true });   // 不应抛错
});

// ── paste dry_run：三态预检（F1 实机取证的缺陷：真粘贴静默毁带、零报告）──

function pasteStubRoot(beltAt, machineAt) {
    // 真实世界每条带子的 uid 不同 —— 用格序号造 uid，避免"去重按 uid"把两条带折成一条
    const cellOf = (x, y) => {
        const bi = beltAt.findIndex(c => c[0] === x && c[1] === y);
        if (bi >= 0) return { uid: 501 + bi, components: { StaticMapEntity: { origin: { x, y }, rotation: 0, code: 1 } } };
        const mi = machineAt.findIndex(c => c[0] === x && c[1] === y);
        if (mi >= 0) return { uid: 601 + mi, components: { StaticMapEntity: { origin: { x, y }, rotation: 0, code: 7 } } };
        return null;
    };
    return {
        entityMgr: { entities: [] },
        map: { getLayerContentXY: (x, y) => cellOf(x, y) },
        time: { now: () => 9 },
        logic: {
            performBulkOperation: fn => fn(),
            tryPlaceBuilding: () => ({ uid: 600 }),
        },
        gameMode: { getHasFreeCopyPaste: () => true, getBlueprintShapeKey: () => "K" },
        hubGoals: { getShapesStoredByKey: () => 0, takeShapeByKey: () => {} },
        signals: { entityManuallyPlaced: { dispatch() {} } },
    };
}
function beltLineText(count) {
    const e = [];
    for (let i = 0; i < count; i++) e.push(1, i, 0, 0);
    const payload = JSON.stringify({ v: 1, gv: "1.5.6", w: [0, 0], e });
    return "SZBP1." + sandbox.shapez.compressX64(payload);
}

/** 含隧道的蓝图：belt + sender(22) + receiver(23) + belt */
function tunnelLineText() {
    const e = [1, 0, 0, 0, 22, 1, 0, 180, 23, 3, 0, 180, 1, 4, 0, 0];
    const payload = JSON.stringify({ v: 1, gv: "1.5.6", w: [0, 0], e });
    return "SZBP1." + sandbox.shapez.compressX64(payload);
}

/* ★ 含隧道的蓝图必须临时挂起 enableTunnelSmartplace ★
   不开的话，receiver 落地时 `onEntityManuallyPlaced`（underground_belt.js:53）会把
   sender 与它之间同向的带子删掉，而 `applied` 仍报成功（实机 A/B 复现：开 → 2→0，关 → 2→2）。
   这条锁三件事：① 粘贴期间开关被设为 false；② 结束后恢复原值；③ 返回值如实报告。 */
check("含隧道的蓝图：粘贴期间挂起 smartplace，结束后恢复原值", () => {
    const m = newMod();
    const root = pasteStubRoot([], []);
    const seen = [];                       // 记录每次 placeOne 时开关的取值
    const settings = {
        enableTunnelSmartplace: true,
        _v: true,
        getAllSettings() { return { enableTunnelSmartplace: this._v }; },
        updateSetting(k, v) { assert(k === "enableTunnelSmartplace", "只动这一个设置, got " + k); this._v = v; },
    };
    m.app = { settings };              // mod 用的是 this.app（构造参数），不是 root.app
    root.logic.tryPlaceBuilding = () => {
        seen.push(settings._v);            // 每落一格看一眼
        return { uid: 600 + seen.length };
    };
    const res = m.opPasteBlueprint(root, { text: tunnelLineText(), x: 10, y: 10, charge: false });
    assert(res.applied === 4, "4 格全落地, got " + res.applied);
    assert(seen.every(v => v === false), "粘贴期间开关必须是 false（否则 receiver 会删带）, got " + JSON.stringify(seen));
    assert(settings._v === true, "结束后必须恢复成 true, got " + settings._v);
    assert(res.tunnels && res.tunnels.in_plan === 2, "返回值如实报告 2 个隧道格, got " + JSON.stringify(res.tunnels));
});

check("含隧道的蓝图 dry_run：报告 will_disable_smartplace，且**不改动**设置", () => {
    const m = newMod();
    const root = pasteStubRoot([], []);
    let touched = 0;
    m.app = { settings: {
        getAllSettings: () => ({ enableTunnelSmartplace: true }),
        updateSetting: () => { touched++; },
    } };
    const res = m.opPasteBlueprint(root, { text: tunnelLineText(), x: 10, y: 10, charge: false, dry_run: true });
    assert(res.tunnels && res.tunnels.will_disable_smartplace === true, "dry_run 要预告会关开关");
    assert(touched === 0, "dry_run 不许改任何设置（预检不该有副作用）, touched=" + touched);
});

check("不含隧道的蓝图：不碰 settings（回归锁）", () => {
    const m = newMod();
    const root = pasteStubRoot([], []);
    let touched = 0;
    root.app = { settings: {
        getAllSettings: () => ({ enableTunnelSmartplace: true }),
        updateSetting: () => { touched++; },
    } };
    root.logic.tryPlaceBuilding = () => ({ uid: 700 });
    const res = m.opPasteBlueprint(root, { text: beltLineText(3), x: 10, y: 10, charge: false });
    assert(res.applied === 3, "3 格落地");
    assert(touched === 0, "纯带蓝图不该动 settings, touched=" + touched);
    assert(res.tunnels === null, "无隧道时 tunnels 字段为 null, got " + JSON.stringify(res.tunnels));
});

check("paste dry_run 不落地：干净落点全量 would_apply、零销毁零阻断、bbox 正确", () => {
    const m = newMod();
    const root = pasteStubRoot([], []);
    let placed = 0;
    root.logic.tryPlaceBuilding = () => { placed++; return { uid: 600 + placed }; };
    const res = m.opPasteBlueprint(root, { text: beltLineText(5), x: 100, y: 200, charge: false, dry_run: true });
    assert(res.dry_run === true, "dry_run 标志");
    assert(res.would_apply === 5, "would_apply=5, got " + res.would_apply);
    assert(res.would_delete === 0 && res.destroys.length === 0, "零销毁");
    assert(res.blocked.length === 0, "零阻断");
    assert(res.bbox.join(",") === "100,200,104,200", "bbox 世界坐标, got " + res.bbox.join(","));
    assert(res.charge_preview && res.charge_preview.affordable === true, "成本预演在场");
    assert(placed === 0, "绝不落地（tryPlaceBuilding 调用数=" + placed + "）");
});

check("paste dry_run：压既有带子 → destroys 如实上报（真粘贴会静默销毁）", () => {
    const m = newMod();
    const root = pasteStubRoot([[102, 200], [103, 200]], []);
    const res = m.opPasteBlueprint(root, { text: beltLineText(5), x: 100, y: 200, charge: false, dry_run: true });
    assert(res.would_apply === 5, "带子可替换 → 5 格仍全会放，got " + res.would_apply);
    assert(res.would_delete === 2, "would_delete=2, got " + res.would_delete);
    assert(res.destroys.some(d => d.cell.join(",") === "102,200") &&
           res.destroys.some(d => d.cell.join(",") === "103,200") &&
           new Set(res.destroys.map(d => d.uid)).size === 2, "两条旧带都在清单且 uid 不同");
});

check("paste dry_run：压既有机器 → 该条目 blocked、其余照放；同格重复也报", () => {
    const m = newMod();
    const root = pasteStubRoot([], [[104, 200]]);
    const res = m.opPasteBlueprint(root, { text: beltLineText(5), x: 100, y: 200, charge: false, dry_run: true });
    assert(res.blocked.length === 1, "blocked=1, got " + res.blocked.length + " " + JSON.stringify(res.blocked));
    assert(res.blocked[0].cell.join(",") === "104,200", "blocked 指对格");
    assert(res.blocked[0].occupant.type === "miner" && res.blocked[0].occupant.uid === 601, "占用者信息");
    assert(res.would_apply === 4, "其余 4 格照放, got " + res.would_apply);
    const dupPayload = JSON.stringify({ v: 1, gv: "1.5.6", w: [0, 0], e: [1, 0, 0, 0, 1, 0, 0, 0] });
    const dupText = "SZBP1." + sandbox.shapez.compressX64(dupPayload);
    const res2 = m.opPasteBlueprint(pasteStubRoot([], []), { text: dupText, x: 0, y: 0, charge: false, dry_run: true });
    assert(res2.blocked.length === 1 && res2.blocked[0].duplicateInPlan === true,
        "同格两次 → blocked(duplicateInPlan), got " + JSON.stringify(res2.blocked));
});

check("paste dry_run 是已知字段；真粘贴路径不受影响", () => {
    const m = newMod();
    m.validateAction({ op: "paste_blueprint", text: "SZBP1.x", x: 0, y: 0, dry_run: true });
    const root = pasteStubRoot([], []);
    let placed = 0;
    root.logic.tryPlaceBuilding = () => { placed++; return { uid: 600 + placed }; };
    const real = m.opPasteBlueprint(root, { text: beltLineText(3), x: 100, y: 200, charge: false });
    assert(real.applied === 3 && placed === 3, "真粘贴 3 格落地, got applied=" + real.applied + " placed=" + placed);
    assert(real.dry_run === undefined, "真粘贴不带 dry_run 标志");
});

// ─────────────── RPC 写操作串行化 ───────────────
/*
 * 背景（实测现象）：连续快速发多个 place，部分请求回 ok:true 但实体没建出来。
 *
 * 源码判据：
 *   · 单个 place 是**同步**完成的（opPlace → placeOne → logic.tryPlaceBuilding），
 *     所以 place-vs-place 在 JS 单线程里不会交错，这不是根因。
 *   · 但 load_save / new_game 是 async（await readAsync / waitFor），
 *     它们一进 handleRpc 就 await 让出；此时后到的 place 若"立即执行"，
 *     就会落在**旧 root** 上。load_save 随后把世界换掉 → place 已回 ok，
 *     实体却随旧 root 一起消失。这才是"ok 但没建出来"的真实形态。
 *   · 修法：所有会改世界的 RPC 走同一条 Promise 链（worldChain），纯读不排队。
 *
 * 下面三条测试分别锁：① 分类表不漏写 op ② 写操作真的按到达顺序执行
 * ③ 状态切换占住链时，写操作不许插进去（并内嵌变异检查：去掉串行化必须变红）。
 */

check("rpcTouchesWorld：所有写 op / method 都被判定为改世界，纯读不被拖进链", () => {
    const m = newMod();
    // 1) actionSpecs 里除了这几个纯只读 op，其余都必须被判为"改世界"
    const READ_ONLY_OPS = new Set(["noop", "camera", "export_blueprint"]);
    const specs = m.actionSpecs();
    for (const op of Object.keys(specs)) {
        const want = !READ_ONLY_OPS.has(op);
        const got = m.rpcTouchesWorld("act", { op });
        assert(got === want, `op '${op}' 应 ${want ? "进链" : "不进链"}，实得 ${got}`);
    }
    // 2) 写 method 逐个检查
    for (const method of ["save_now", "load_save", "new_game", "delete_save", "repair_save", "upgrade", "game_setting"]) {
        assert(m.rpcTouchesWorld(method, {}) === true, method + " 必须进链");
    }
    // 3) 纯读 method 一个都不许进链（进链会让观测被无关的粘贴拖住）
    for (const method of ["status", "obs", "screenshot", "list_saves", "debug_items", "debug_loop",
                          "debug_log", "debug_app_state", "resources", "production", "world_info",
                          "debug_canvas_api", "debug_speed_registry"]) {
        assert(m.rpcTouchesWorld(method, {}) === false, method + " 不该进链");
    }
    // 4) batch：只要含一个写 op 就要进链；全读不进链
    assert(m.rpcTouchesWorld("batch", { actions: [{ op: "noop" }, { op: "place", building: "belt", x: 0, y: 0 }] }) === true,
        "含 place 的 batch 必须进链");
    assert(m.rpcTouchesWorld("batch", { actions: [{ op: "noop" }, { op: "export_blueprint" }] }) === false,
        "全只读 batch 不进链");
});

/** 造一个能记录 tryPlaceBuilding 调用顺序的假 root；bulk 操作直接同步执行。 */
function serialRoot(tag, log, opts = {}) {
    return {
        tag,
        time: { now: () => 1, getIsPaused: () => false, getSpeed: () => ({ getId: () => "regular" }), setSpeed() {} },
        hubGoals: {
            level: 5, storedShapes: {}, upgradeLevels: {},
            currentGoal: { definition: { getHash: () => "Cu" }, required: 10 },
            getCurrentGoalDelivered: () => 0,
        },
        entityMgr: { entities: [] },
        map: { getLayerContentXY: () => null },
        logic: {
            performBulkOperation: fn => fn(),
            tryPlaceBuilding: p => { log.push(tag + ":" + p.origin.x + "," + p.origin.y); return { uid: log.length }; },
            tryDeleteBuilding: () => true,
        },
        signals: { entityManuallyPlaced: { dispatch() {} }, prePlacementCheck: { dispatch: () => {} } },
        camera: { center: { x: 0, y: 0 }, zoomLevel: 1 },
        gameMode: { getHasFreeCopyPaste: () => true, getBlueprintShapeKey: () => "Cu", getIsEditor: () => false, getUpgrades: () => ({}) },
        canvas: {},
        gameState: opts.gameState || {},
    };
}

/** 把 mod 接到假 ws 上，返回 { m, ws }；ws.responses 收所有回包。 */
function wiredMod() {
    const m = newMod();
    const responses = [];
    m.ws = { readyState: 1, send: raw => responses.push(JSON.parse(raw)) };
    return { m, responses };
}

const tickAsync = (ms = 0) => new Promise(r => setTimeout(r, ms));

/** 异步版 check：错误也要计入 pass/fail，而不是把整个进程抛崩（那样后面的用例就不跑了）。 */
async function checkAsync(name, fn) {
    try {
        await fn();
        pass++;
        console.log("PASS", name);
    } catch (e) {
        fail++;
        console.log("FAIL", name, "->", (e && e.message) || e);
    }
}

/**
 * 复刻「修复前」的入口分发：写操作不排队，handleRpc 被直接调用。
 * 用它跑同一组断言，就能证明这条测试是**因为串行化**才绿的。
 */
function useUnserializedDispatch(m) {
    m.handleBridgeMessage = function (msg) {
        if (msg && msg.id !== undefined && msg.method !== undefined) {
            this.handleRpc(msg).catch(() => {});
        }
    };
}

/** 搭一台「load_save 卡在 readAsync 里」的假游戏，返回控制句柄。 */
function stalledLoadMod(tag) {
    const { m, responses } = wiredMod();
    const log = [];
    const mainMenu = { getKey: () => "MainMenuState" };
    const newRoot = serialRoot("B", log);
    let resolveRead = null;
    const stateMgr = {
        currentState: { getKey: () => "InGameState" },
        moveToState(key) {
            log.push("moveToState:" + key);
            if (key === "InGameState") m.root = newRoot;
            // 模拟状态机的异步 fade：稍后才真正切过去
            if (key === "MainMenuState") setTimeout(() => { stateMgr.currentState = mainMenu; }, 5);
        },
    };
    m.app.stateMgr = stateMgr;
    m.app.savegameMgr = {
        getSavegameById: id => ({ internalId: id, readAsync: () => new Promise(r => { resolveRead = r; }) }),
    };
    m.root = serialRoot("A", log);
    return {
        m, responses, log,
        startLoad: () => m.handleBridgeMessage({ jsonrpc: "2.0", id: 10, method: "load_save", params: { internal_id: "save-1" } }),
        startPlace: () => m.handleBridgeMessage({ jsonrpc: "2.0", id: 11, method: "act", params: { op: "place", building: "belt", x: 7, y: 7 } }),
        releaseRead: () => resolveRead && resolveRead(),
    };
}

// ② 两个写操作同时进来：必须按到达顺序执行
await checkAsync("写操作串行：两个 place 同时到达 → 按到达顺序执行", async () => {
    const { m, responses } = wiredMod();
    const log = [];
    m.root = serialRoot("A", log);
    m.handleBridgeMessage({ jsonrpc: "2.0", id: 1, method: "act", params: { op: "place", building: "belt", x: 1, y: 1 } });
    m.handleBridgeMessage({ jsonrpc: "2.0", id: 2, method: "act", params: { op: "place", building: "belt", x: 2, y: 2 } });
    await tickAsync();
    assert(JSON.stringify(log) === JSON.stringify(["A:1,1", "A:2,2"]),
        "两个 place 必须按到达顺序执行, got " + JSON.stringify(log));
    const ids = responses.map(r => r.id).sort((a, b) => a - b);
    assert(JSON.stringify(ids) === "[1,2]", "两个请求都要回包, got " + JSON.stringify(ids));
});

// ③ 状态切换在飞时，写操作必须等它落地（这是 ok:true 却丢实体的根因）
async function assertNoCutIn(h, expectSerialized) {
    h.startLoad();
    // 后到的 place：此时 load_save 卡在 readAsync 里
    h.startPlace();
    await tickAsync(0);
    if (expectSerialized) {
        assert(!h.log.includes("A:7,7"),
            "load_save 未落地时 place 不许插队到旧 root 上, got " + JSON.stringify(h.log));
    }
    h.releaseRead();
    // loadSave 内部用 waitFor(100ms 轮询) 等主菜单 → 再 moveToState；给足时间
    await tickAsync(600);
    assert(h.log.indexOf("A:7,7") === -1, "旧 root 上不该有任何 place, got " + JSON.stringify(h.log));
    assert(h.log.indexOf("B:7,7") > h.log.indexOf("moveToState:InGameState"),
        "place 必须落在 load_save 之后的新 root 上, got " + JSON.stringify(h.log));
    const r11 = h.responses.find(r => r.id === 11);
    assert(r11 && r11.result && r11.result.ok === true, "place 回 ok");
    const r10 = h.responses.find(r => r.id === 10);
    assert(r10 && r10.result && r10.result.ok === true, "load_save 回 ok");
}

await checkAsync("写操作串行：load_save 在飞时 place 不插队，落在新 root 上", async () => {
    await assertNoCutIn(stalledLoadMod(), true);
});

/*
 * 变异自检：同一条断言在「不排队」的分发下必须失败。
 * 这条用程序证明「去掉串行化 → 测试变红」，而不是靠人相信。
 * 若哪天有人把 worldChain 删掉，上面的用例会红；若有人把这条变异用例改成永远通过，
 * 它自己会红（因为它要求变异体确实出现 A:7,7 这个插队痕迹）。
 */
await checkAsync("变异自检：不排队时分发器会把 place 插到旧 root 上（断言确实有判别力）", async () => {
    const h = stalledLoadMod();
    useUnserializedDispatch(h.m);
    let threw = null;
    try {
        await assertNoCutIn(h, false);
    } catch (e) {
        threw = e;
    }
    assert(threw, "变异体必须让断言失败，但它通过了 —— 这条测试没有判别力");
    assert(/旧 root 上不该有任何 place|不许插队/.test(String(threw.message)),
        "变异体的失败原因应是 place 插队, got: " + threw.message);
});

// ─────────────── 实体序列化还原原语（事务层前置） ───────────────
/*
 * 为什么要这组测试：
 *   clone() 只调 copyAdditionalStateTo（entity.js:88-106），全仓仅 4 个组件实现它，
 *   所以 clone 出来的 storage 是空壳。真正的还原原语是存档反序列化路径
 *   （serializer_internal.js:44-68）。这里锁住它的三条**不可退让**的性质：
 *     ① 载荷必须含 code / layer / components（少了就还原不出）。
 *     ② 还原必须用**原 uid** 注册（否则所有引用旧 uid 的东西全指错）。
 *     ③ 载荷缺 StaticMapEntity 必须抛错，不能静默返回。
 * 另外用一条**变异测试**证明测试有判别力（删掉 `entity.uid = payload.uid` 必须变红）。
 */

/** 造一个能跑 serialize/restore/delete 的假 root；world 是"格子 → 实体"的简单映射。 */
function roundtripRoot() {
    const world = new Map();
    const entities = [];
    const registeredUids = [];
    const preRegisterUids = [];   // 实体**进入** registerEntity 时身上已有的 uid
    const placed = [];
    const destroyed = [];
    let nextUid = 10000;
    const key = (x, y, layer) => x + "," + y + "@" + (layer || "regular");
    const root = {
        bulkOperationRunning: false,
        immutableOperationRunning: false,
        entityMgr: {
            entities,
            findByUid(uid, err = true) {
                for (const e of entities) if (e.uid === uid) return e;
                return null;
            },
            registerEntity(entity, uid) {
                // 与 entity_manager.js:94-118 同形：先记下"进来时的 uid"，再按 uid ? uid : generateUid() 赋值
                preRegisterUids.push(entity.uid);
                registeredUids.push(uid === undefined ? null : uid);
                entity.uid = uid ? uid : nextUid++;
                entity.registered = true;
                entities.push(entity);
            },
            destroyEntity(entity) { entity.queuedForDestroy = true; destroyed.push(entity.uid); },
            processDestroyList() {
                for (const e of entities.slice()) {
                    if (e.queuedForDestroy) {
                        e.destroyed = true;
                        entities.splice(entities.indexOf(e), 1);
                    }
                }
            },
        },
        map: {
            getLayerContentXY(x, y, layer) { return world.get(key(x, y, layer)) || null; },
            placeStaticEntity(entity) {
                const s = entity.components.StaticMapEntity;
                placed.push([s.origin.x, s.origin.y, entity.layer]);
                world.set(key(s.origin.x, s.origin.y, entity.layer), entity);
            },
            removeStaticEntity(entity) {
                const s = entity.components.StaticMapEntity;
                world.delete(key(s.origin.x, s.origin.y, entity.layer));
            },
        },
        logic: {
            performBulkOperation(fn) {
                assert(!root.bulkOperationRunning, "nested bulk");
                root.bulkOperationRunning = true;
                try { return fn(); } finally { root.bulkOperationRunning = false; }
            },
            performImmutableOperation(fn) {
                assert(!root.immutableOperationRunning, "nested immutable");
                root.immutableOperationRunning = true;
                try { return fn(); } finally { root.immutableOperationRunning = false; }
            },
            tryDeleteBuilding(entity) {
                const meta = { getIsRemovable: () => entity.uid !== 99 };
                if (entity.uid === 99) return false;   // 模拟 hub：不可删
                root.map.removeStaticEntity(entity);
                root.entityMgr.destroyEntity(entity);
                root.entityMgr.processDestroyList();
                return true;
            },
        },
        time: { now: () => 0 },
    };
    function spawn(code, x, y, layer) {
        const info = stubShapez.gBuildingVariants[code];
        const entity = info.metaInstance.createEntity({
            root, origin: new sandbox.shapez.Vector(x, y), rotation: 0, originalRotation: 0,
            rotationVariant: info.rotationVariant, variant: info.variant,
        });
        root.entityMgr.registerEntity(entity);
        root.map.placeStaticEntity(entity);
        return entity;
    }
    return { root, spawn, world, entities, registeredUids, preRegisterUids, placed, destroyed };
}

check("serializeEntity: 载荷含 code / layer / components（uid 与 origin 原样）", () => {
    const m = newMod();
    const { root, spawn } = roundtripRoot();
    const e = spawn(21, 60, -50);
    e.components.Storage.storedCount = 37;
    e.components.Storage.storedItem = "CuCuCuCu";
    const payload = m.serializeEntity(e);
    assert(payload.uid === e.uid, "uid carried; got " + payload.uid);
    assert(payload.code === 21, "code carried; got " + payload.code);
    assert(payload.layer === "regular", "layer carried; got " + payload.layer);
    assert(payload.components && payload.components.StaticMapEntity, "components.StaticMapEntity present");
    assert(payload.components.StaticMapEntity.origin.x === 60 && payload.components.StaticMapEntity.origin.y === -50,
        "origin in payload; got " + JSON.stringify(payload.components.StaticMapEntity.origin));
    assert(payload.components.Storage.storedCount === 37, "storedCount in payload; got " + payload.components.Storage.storedCount);
    assert(payload.rotationVariant === 0, "rotationVariant decoded from code table");
    assert(payload.buildingId === "storage", "buildingId decoded; got " + payload.buildingId);
    assert(payload.component_keys.includes("Storage"), "component_keys lists Storage");
});

check("serializeEntity: 非 schema 状态（Belt.assignedPath）不在载荷里", () => {
    const m = newMod();
    const { root, spawn } = roundtripRoot();
    const e = spawn(1, 5, 5);
    e.components.Belt.assignedPath = { entityPath: [e] };
    const payload = m.serializeEntity(e);
    assert(payload.components.Belt, "Belt component present (has schema field direction)");
    assert(!Object.prototype.hasOwnProperty.call(payload.components.Belt, "assignedPath"),
        "assignedPath must NOT be serialized (belt.js:54-58 says so)");
    // 这就是"快照必须额外带 beltPaths"的机器证据
});

check("restoreEntity: 用正确 uid 调 registerEntity，并把实体放回原格", () => {
    const m = newMod();
    const { root, spawn, registeredUids, preRegisterUids, placed } = roundtripRoot();
    m.root = root;
    const e = spawn(21, 60, -50);
    e.components.Storage.storedCount = 12;
    e.components.Storage.storedItem = "RuRuRuRu";
    const payload = m.serializeEntity(e);
    m.deleteEntityByUid(e.uid);
    const before = preRegisterUids.length;

    const back = m.restoreEntity(payload);
    assert(back && back.uid === e.uid, "uid preserved; got " + (back && back.uid) + " want " + e.uid);
    assert(registeredUids[registeredUids.length - 1] === e.uid,
        "registerEntity called with the original uid; got " + registeredUids[registeredUids.length - 1]);
    // ★ 关键契约：实体**进入** registerEntity 之前就必须带着载荷里的 uid。
    // 上游 entity_manager.js:112 是 `entity.uid = uid ? uid : generateUid()`，只要传了 uid
    // 就看不出"restoreEntity 里有没有写 entity.uid" —— 所以断言点必须放在更早的一步。
    assert(preRegisterUids[before] === e.uid,
        "entity.uid 必须在 registerEntity 之前就设成载荷 uid；进入时是 " + preRegisterUids[before]);
    assert(placed.some(p => p[0] === 60 && p[1] === -50), "placed at original cell; got " + JSON.stringify(placed));
    assert(back.components.Storage.storedCount === 12, "storedCount restored; got " + back.components.Storage.storedCount);
    assert(back.components.Storage.storedItem === "RuRuRuRu", "storedItem restored; got " + back.components.Storage.storedItem);
    assert(root.map.getLayerContentXY(60, -50, "regular") === back, "map now points at the restored entity");
});

check("restoreEntity: 载荷缺 StaticMapEntity → 抛 2001，不静默返回", () => {
    const m = newMod();
    const { root } = roundtripRoot();
    m.root = root;
    let threw = null;
    try {
        m.restoreEntity({ uid: 1234, code: 21, layer: "regular", components: { Storage: { storedCount: 1 } } });
    } catch (e) {
        threw = e;
    }
    assert(threw && threw.__rpcError && threw.__rpcError.code === 2001, "must be 2001, got " + (threw && threw.__rpcError && threw.__rpcError.code));
    assert(/StaticMapEntity/.test(String(threw.__rpcError.detail)), "detail names StaticMapEntity; got " + threw.__rpcError.detail);
});

check("restoreEntity: 载荷缺 uid / origin / code 各自报 2001", () => {
    const m = newMod();
    const { root } = roundtripRoot();
    m.root = root;
    const base = {
        uid: 5, code: 21, layer: "regular",
        components: { StaticMapEntity: { origin: { x: 0, y: 0 }, rotation: 0, originalRotation: 0, code: 21 } },
    };
    const variants = [
        ["uid 缺失", Object.assign({}, base, { uid: undefined })],
        ["origin 非数", JSON.parse(JSON.stringify(base))],
        ["code 缺失", JSON.parse(JSON.stringify(base))],
    ];
    variants[1][1].components.StaticMapEntity.origin = { x: "a", y: 0 };
    delete variants[2][1].components.StaticMapEntity.code;
    for (const [label, payload] of variants) {
        let threw = null;
        try { m.restoreEntity(payload); } catch (e) { threw = e; }
        assert(threw && threw.__rpcError && threw.__rpcError.code === 2001, label + " 必须 2001");
    }
});

check("restoreEntity: layer 与建筑不一致 → 2003（拒绝静默落到错误图层）", () => {
    const m = newMod();
    const { root } = roundtripRoot();
    m.root = root;
    const payload = {
        uid: 5, code: 21, layer: "wires",   // storage 在 regular
        components: { StaticMapEntity: { origin: { x: 0, y: 0 }, rotation: 0, originalRotation: 0, code: 21 } },
    };
    let threw = null;
    try { m.restoreEntity(payload); } catch (e) { threw = e; }
    assert(threw && threw.__rpcError && threw.__rpcError.code === 2003, "2003 expected; got " + (threw && threw.__rpcError && threw.__rpcError.code));
});

check("restoreEntity: 载荷里实体不存在的组件被记进 report.missing（不静默吞）", () => {
    const m = newMod();
    const { root } = roundtripRoot();
    m.root = root;
    const payload = {
        uid: 6, code: 21, layer: "regular",
        components: {
            StaticMapEntity: { origin: { x: 1, y: 1 }, rotation: 0, originalRotation: 0, code: 21 },
            GhostComponent: { x: 1 },   // 实体上没有
        },
    };
    const e = m.restoreEntity(payload);
    assert(e && e.__bridgeRestoreReport, "report attached to the entity");
    assert(e.__bridgeRestoreReport.missing.includes("GhostComponent"),
        "payload 里有、实体上没有的组件必须被记进 missing，got " + JSON.stringify(e.__bridgeRestoreReport));
    assert(e.__bridgeRestoreReport.restored.includes("StaticMapEntity"), "StaticMapEntity restored");
    // 报告不可枚举 ⇒ 不会污染 serialize()（否则存档/载荷会多出一个假组件）
    assert(!Object.keys(e).includes("__bridgeRestoreReport"), "report must be non-enumerable");
    assert(!Object.keys(e.serialize().components).includes("__bridgeRestoreReport"), "report not in payload");
    void m.volatileSnapshot(e);
});

check("deleteEntityByUid: 走 tryDeleteBuilding，返回删除前的格子", () => {
    const m = newMod();
    const { root, spawn, destroyed } = roundtripRoot();
    m.root = root;
    const e = spawn(21, 60, -50);
    const res = m.deleteEntityByUid(e.uid);
    assert(res.ok === true, "ok");
    assert(JSON.stringify(res.cell) === "[60,-50]", "cell reported; got " + JSON.stringify(res.cell));
    assert(res.layer === "regular", "layer reported");
    assert(destroyed.includes(e.uid), "destroyEntity called");
    assert(root.map.getLayerContentXY(60, -50, "regular") === null, "tile cleared");
});

check("deleteEntityByUid: 未找到 → ok:false reason:not_found（不抛）", () => {
    const m = newMod();
    const { root } = roundtripRoot();
    m.root = root;
    const res = m.deleteEntityByUid(999999);
    assert(res.ok === false && res.reason === "not_found", "got " + JSON.stringify(res));
});

check("deleteEntityByUid: 不可删（hub 形态）→ ok:false reason:not_removable", () => {
    const m = newMod();
    const { root, spawn } = roundtripRoot();
    m.root = root;
    const hub = spawn(26, 0, 0);
    hub.uid = 99;   // 桩里 99 = 不可删
    const res = m.deleteEntityByUid(99);
    assert(res.ok === false && res.reason === "not_removable", "got " + JSON.stringify(res));
});

check("debug_entity_roundtrip: 完整往返，diffs 为空、uid 保留、格子回填", () => {
    const m = newMod();
    const { root, spawn } = roundtripRoot();
    m.root = root;
    const e = spawn(21, 60, -50);
    e.components.Storage.storedCount = 8;
    e.components.Storage.storedItem = "CuCuCuCu";
    const res = m.debugEntityRoundtrip({ x: 60, y: -50 });
    assert(res.ok === true, "ok; diffs=" + JSON.stringify(res.diffs));
    assert(res.uid_preserved === true, "uid preserved");
    assert(res.tile_landed === true, "tile landed");
    assert(Array.isArray(res.diffs) && res.diffs.length === 0, "no schema diffs; got " + JSON.stringify(res.diffs));
    assert(res.restored.uid === res.uid, "restored uid matches");
    assert(res.restored.code === 21, "restored code");
    assert(res.original.rotationVariant === 0 && res.restored.rotationVariant === 0, "rv round-trips");
    assert(res.component_keys.includes("Storage"), "component_keys present");
    assert(res.lost_state && res.lost_state.Storage, "lost_state exposes Storage runtime fields");
});

check("debug_entity_roundtrip: 空格 → 2002", () => {
    const m = newMod();
    const { root } = roundtripRoot();
    m.root = root;
    let threw = null;
    try { m.debugEntityRoundtrip({ x: 999, y: 999 }); } catch (e) { threw = e; }
    assert(threw && threw.__rpcError && threw.__rpcError.code === 2002, "2002 expected");
});

check("debug_entity_roundtrip 是写操作（进串行链）", () => {
    const m = newMod();
    assert(m.rpcTouchesWorld("debug_entity_roundtrip", {}) === true, "must be serialized");
});

/*
 * ★ 变异验证：**真的**把 `entity.uid = payload.uid` 从源码里删掉，加载这份变异源码，
 * 跑同一条断言，必须变红。这是唯一能证明"测试锁住了那一行"的方式
 * （只改运行时行为会漏 —— registerEntity(entity, uid) 自己也会赋 uid，把证据抹掉；
 *   所以断言点必须前移到"实体进入 registerEntity 时身上的 uid"）。
 */
await checkAsync("变异自检：源码删掉 entity.uid = payload.uid → uid 保真断言必须变红", async () => {
    const line = "        entity.uid = payload.uid;";
    assert(src.includes(line), "变异的靶子行不存在了 —— 源码结构变了，请复核这条测试");
    const mutantSrc = src.replace(line, "        // MUTANT: entity.uid = payload.uid;  (deleted)");
    const MutantMod = loadModClass(mutantSrc);

    const m = new MutantMod({
        app: { stateMgr: { currentState: null }, savegameMgr: {} },
        modLoader: fakeLoader,
        meta: sandbox.__METADATA,
        settings: { ws_url: "ws://127.0.0.1:7777/mod", allow_step: true, allow_write: true, max_entities: 20000 },
        saveSettings: () => {},
    });
    const { root, spawn, preRegisterUids } = roundtripRoot();
    m.root = root;
    const e = spawn(21, 62, -50);
    const payload = m.serializeEntity(e);
    m.deleteEntityByUid(e.uid);
    const n = preRegisterUids.length;
    m.restoreEntity(payload);
    // 变异体：实体进注册时身上还是 createEntity 给的 0
    assert(preRegisterUids[n] === 0,
        "变异体本应让实体带着 uid=0 进注册，实际是 " + preRegisterUids[n] + " —— 变异没生效");
});

/*
 * 同一条断言在**未变异**源码上必须为真（真阳性对照）。
 * 两条一起才说明：断言既能分辨变异体，也不会永远为真。
 */
check("对照：未变异源码下实体进入注册时已带载荷 uid", () => {
    const m = newMod();
    const { root, spawn, preRegisterUids } = roundtripRoot();
    m.root = root;
    const e = spawn(21, 63, -50);
    const payload = m.serializeEntity(e);
    m.deleteEntityByUid(e.uid);
    const n = preRegisterUids.length;
    m.restoreEntity(payload);
    assert(preRegisterUids[n] === payload.uid,
        "未变异时应带原 uid 进注册，实际 " + preRegisterUids[n] + " want " + payload.uid);
    assert(payload.uid !== 0, "uid 非 0（否则变异体与正常路径不可区分）");
});

check("restoreEntity: uid 已被活实体占用 → 2002（正式版不会 assert 重复 uid）", () => {
    const m = newMod();
    const { root, spawn } = roundtripRoot();
    m.root = root;
    const live = spawn(21, 60, -50);
    const payload = m.serializeEntity(live);
    // 不删，直接还原 —— 必须被拒
    let threw = null;
    try { m.restoreEntity(payload); } catch (e) { threw = e; }
    assert(threw && threw.__rpcError && threw.__rpcError.code === 2002,
        "2002 expected; got " + (threw && threw.__rpcError && threw.__rpcError.code));
    assert(String(threw.__rpcError.hint).includes("deleteEntityByUid"),
        "hint 必须说清回滚顺序（先删后还原）");
});

check("restoreEntity: 目标格被别人占 → 2002（拒绝静默覆盖）", () => {
    const m = newMod();
    const { root, spawn } = roundtripRoot();
    m.root = root;
    const a = spawn(21, 60, -50);
    const payloadA = m.serializeEntity(a);
    m.deleteEntityByUid(a.uid);
    const b = spawn(21, 60, -50);   // 别人占住了同一格（不同 uid）
    void b;
    let threw = null;
    try { m.restoreEntity(payloadA); } catch (e) { threw = e; }
    assert(threw && threw.__rpcError && threw.__rpcError.code === 2002,
        "2002 expected; got " + (threw && threw.__rpcError && threw.__rpcError.code));
});

check("debug_entity_roundtrip: 成功往返后 uid 槽位不再被占（不会留两个同 uid）", () => {
    const m = newMod();
    const { root, spawn, entities } = roundtripRoot();
    m.root = root;
    spawn(21, 60, -50);
    m.debugEntityRoundtrip({ x: 60, y: -50 });
    const same = entities.filter(e => e.uid === 10000 || e.uid === 10001);
    const uid = entities.length ? entities[0].uid : null;
    assert(entities.filter(e => e.uid === uid).length === 1,
        "同一 uid 只能有一个实体，got " + entities.filter(e => e.uid === uid).length);
    void same;
});

check("restoreEntity: 目标 footprint 的**右下角**被占 → 2002（2×2 不只查 origin）", () => {
    const m = newMod();
    const { root, spawn } = roundtripRoot();
    m.root = root;
    const a = spawn(21, 60, -50);            // storage，2×2 → 覆盖 (60,-50)..(61,-49)
    const payloadA = m.serializeEntity(a);
    m.deleteEntityByUid(a.uid);
    // 在 footprint 的右下角另放一个 1×1 带子
    const b = spawn(1, 61, -49);
    assert(b.uid !== a.uid, "不同 uid");
    let threw = null;
    try { m.restoreEntity(payloadA); } catch (e) { threw = e; }
    assert(threw && threw.__rpcError && threw.__rpcError.code === 2002,
        "2002 expected (footprint 覆盖检查); got " + (threw && threw.__rpcError && threw.__rpcError.code));
    assert(/\(61,-49\)/.test(String(threw.__rpcError.detail)),
        "detail 必须指出被占的那一格; got " + threw.__rpcError.detail);
});

/*
 * 变异验证：把 footprint 检查退化成"只查 origin 格"，右下角被占的用例必须变红。
 * 这证明"2×2 覆盖检查"不是装饰 —— 它是唯一能拦住"还原时压掉邻居"的闸。
 */
await checkAsync("变异自检：footprint 退化成只查 origin → 右下角占用断言必须变红", async () => {
    const target = "                if (occ && occ.uid !== payload.uid) {";
    assert(src.includes(target), "变异的靶子行不存在了 —— 源码结构变了");
    // 变异：只查 origin（第一个格）之后立即 break —— 等价于"没有 footprint 检查"
    const mutantSrc = src.replace(target, "                if (occ && occ.uid !== payload.uid) { break; } if (false) {");
    const MutantMod = loadModClass(mutantSrc);
    const m = new MutantMod({
        app: { stateMgr: { currentState: null }, savegameMgr: {} },
        modLoader: fakeLoader,
        meta: sandbox.__METADATA,
        settings: { ws_url: "ws://127.0.0.1:7777/mod", allow_step: true, allow_write: true, max_entities: 20000 },
        saveSettings: () => {},
    });
    const { root, spawn } = roundtripRoot();
    m.root = root;
    const a = spawn(21, 60, -50);
    const payloadA = m.serializeEntity(a);
    m.deleteEntityByUid(a.uid);
    spawn(1, 61, -49);   // 右下角
    let threw = null;
    try { m.restoreEntity(payloadA); } catch (e) { threw = e; }
    assert(!threw, "变异体本应放行（只查 origin 看不到右下角），却抛了: " + (threw && threw.message));
});

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
