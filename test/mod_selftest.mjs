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
        1: { metaInstance: { getId: () => "belt", getDimensions: () => ({ x: 1, y: 1 }), getIsReplaceable: () => true }, variant: "default", rotationVariant: 0 },
        7: { metaInstance: { getId: () => "miner", getDimensions: () => ({ x: 1, y: 1 }), getIsReplaceable: () => false }, variant: "default", rotationVariant: 0 },
        9: { metaInstance: { getId: () => "cutter", getDimensions: () => ({ x: 2, y: 1 }), getIsReplaceable: () => false }, variant: "default", rotationVariant: 0 },
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

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
