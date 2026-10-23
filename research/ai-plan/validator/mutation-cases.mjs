/**
 * mutation-cases.mjs — P5 变异测试的**注入表**（research/ai-plan/validator/，P5 独占）。
 *
 * 两条来源，逐条对应：
 *   · facts/MILESTONE-M4-partial-and-pitfalls.md:59-67 的 7 条布局陷阱 → P1..P7
 *   · redteam-compiler-assumptions.md:141-150「可布性必要检查清单」8 条 → C1..C8
 *   · 另加 4 条补充（V2 毁带闸 / D1 旋转机器 / V10 只报告 / S1 形状重放）= **19 条注入**，
 *     正好覆盖 11 条 check id 每一条都有人守（test.mjs B22 断言这一点）。
 *
 * 每条 = 在 good fixture（fixtures/plan-l1.json、fixtures/report-layout.json +
 * contract/merge-belt-intent.json）上做**一处**最小改动；test.mjs 断言：
 *   ① 恰好报出 expect 的那一个 check id（fail 只有一条）
 *   ② failingNode/evidence.cell + nodeId 指对被注入的那一格/那一个节点
 *   ③ evidence 里命中 sub 点名的**子判据**（V4/V6 有多个子判据，必须说清是哪条接住的）
 *   ④ 其余 check 不出现 fail（可以是 not-applicable，但 note 必须写明被谁阻断）
 *
 * opts.checkEntityOrder=false：关掉 V3 的第二判据（施工分层顺序）。追加/删除实体会顺带
 *   破坏 机器→直线→拐角 的分层序，那**不是**被注入的那一条故障；隔离它才能让每条变异
 *   只染一个 id。只有 P6 本身保持开启（它注入的就是顺序）。
 *
 * ⚠️ V6 的三个子判据（一格两流 / 通道 lane 号重复 / 车道台账同一行）由 P4、P5、C4 分别命中，
 *    不是重复覆盖：它们是 redteam 清单第 4 条与陷阱 #4/#5 的三种不同表现。
 */

const clone = o => JSON.parse(JSON.stringify(o));

const ORDER = ["top", "right", "bottom", "left"];
const EXIT_LOCAL = { 0: "top", 1: "left", 2: "right" };
const rotDir = (d, rot) => ORDER[(ORDER.indexOf(d) + (rot / 90)) % 4];

/** 造一个带子 entity（inDir/outDir 由 (r,rv) 现推，与 P1 make-fixtures.beltEnt 同式）。 */
export function beltEnt(dx, dy, rot, rv, nodeId) {
    return {
        code: 1 + rv, dx, dy, rot, nodeId: nodeId || `belt@${dx},${dy}`, instanceIdx: 0, kind: "belt",
        rotationVariant: rv, inDir: rotDir("bottom", rot), outDir: rotDir(EXIT_LOCAL[rv], rot),
    };
}
export function machineEnt(nodeId, kind, code, dx, dy) {
    return { code, dx, dy, rot: 0, nodeId, instanceIdx: 0, kind, rotationVariant: 0, inDir: null, outDir: null };
}
const findBelt = (ents, nodeId) => ents.find(e => e.nodeId === nodeId);

/**
 * @param {{plan:object, layout:object, intent:object}} F 三份 good fixture（调用方读盘传入）
 * @returns {Array<{id:string, source:string, injected:string, expect:string,
 *                  expectCell:([number,number]|null), expectNode:string|null, sub?:string,
 *                  make:()=>{input:object, opts:object}}>}
 */
export function mutationCases(F) {
    const P = () => clone(F.plan), L = () => clone(F.layout), I = () => clone(F.intent);
    const off = (extra = {}) => ({ checkEntityOrder: false, ...extra });
    const rows = [];
    const add = r => rows.push(r);

    /* ══════════════ 陷阱表 7 条（MILESTONE-M4-partial-and-pitfalls.md:59-67） ══════════════ */

    add({
        id: "P1-rv-derived", source: "陷阱表#1 rv 由邻居派生", expect: "V3-belt-fixed-point",
        injected: "把直线带 (0,1) 的 rv 从 0 改成 1（邻居拓扑没变 → 游戏按邻居把它算回 rv0）",
        expectCell: [0, 1], expectNode: "belt@0,1",
        make: () => { const p = P(); const b = findBelt(p.entities, "belt@0,1"); b.rotationVariant = 1; b.code = 2; return { input: p, opts: off() }; },
    });
    add({
        id: "P2-diagonal-gap", source: "陷阱表#2 对角缺口", expect: "V4-slot-alignment",
        injected: "删掉通道 n1→hub 中间的带格 (0,2) —— 竖直段与拐角行列对不齐造成路由缺口",
        expectCell: [0, 2], expectNode: "n1", sub: "路由缺口",
        make: () => { const p = P(); p.entities = p.entities.filter(e => e.nodeId !== "belt@0,2"); return { input: p, opts: off() }; },
    });
    add({
        id: "P3-degenerate-segment", source: "陷阱表#3 退化段 from==to", expect: "V5-degree",
        injected: "追加一条 from==to 的自环通道（n1 (0,4) → n1 (0,4)）；place_path 会报 2001 中断整条脚本",
        expectCell: [0, 4], expectNode: "n1", sub: "自环",
        make: () => {
            const p = P();
            p.layout.channels.push({ from: { nodeId: "n1", cell: [0, 4], slot: "top", outDir: "top" }, to: { nodeId: "n1", cell: [0, 4], slot: "bottom", inDir: "bottom" }, lane: null, payload: "CuCuCuCu", slotRole: "primary", ordinal: 9 });
            return { input: p, opts: off() };
        },
    });
    add({
        id: "P4-output-input-column-conflict", source: "陷阱表#4 输出/输入方向冲突", expect: "V6-crossing",
        injected: "第二股流挤进同一列：再开一条 n1 右格→d1 的通道，与既有 discard 通道共用 (1,3)（payload 不同）",
        expectCell: [1, 3], expectNode: null, sub: "同时承载",
        make: () => {
            const p = P();
            p.layout.channels.push({ from: { nodeId: "n1", cell: [1, 4], slot: "top", outDir: "top" }, to: { nodeId: "d1", cell: [1, 2], slot: "bottom", inDir: "bottom" }, lane: null, payload: "----CuCu", slotRole: "discard", ordinal: 8 });
            return { input: p, opts: off() };
        },
    });
    add({
        id: "P5-lanes-same-row", source: "陷阱表#5 两条车道必须不同行", expect: "V6-crossing",
        injected: "把两条不同 payload 的通道共用同一个 lane 号（= 同一行）",
        expectCell: null, expectNode: null, sub: "lane=0",
        make: () => {
            const p = P();
            p.layout.channels[0].lane = 0;
            p.layout.channels[1].lane = 0;
            return { input: p, opts: off() };
        },
    });
    add({
        id: "P6-place-order", source: "陷阱表#6 不能边想边放", expect: "V3-belt-fixed-point",
        injected: "把拐角带 belt@10,3 插到直线段中间（违反 机器→直线带→拐角带 的分层序）",
        expectCell: [0, 4], expectNode: "belt@10,3", sub: "陷阱表 #6",
        make: () => {
            const l = L(), i = I();
            const corner = i.entities.find(e => e.nodeId === "belt@10,3");
            i.entities = i.entities.filter(e => e.nodeId !== corner.nodeId);
            i.entities.splice(i.entities.findIndex(e => e.nodeId === "belt@0,5") + 1, 0, corner);
            return { input: l, opts: { entities: i.entities } };      // ← 顺序判据保持开启
        },
    });
    add({
        id: "P7-stranded-outlet", source: "陷阱表#7 废弃输出必须接走", expect: "V9-unused-outlet",
        injected: "删掉 cutter 右列 → trash 的那条通道、trash 本体与带格（另一半产物无去向）",
        expectCell: [1, 4], expectNode: "n1",
        make: () => {
            const p = P();
            p.layout.channels = p.layout.channels.filter(c => c.to.nodeId !== "d1");
            p.entities = p.entities.filter(e => e.nodeId !== "belt@1,3" && e.nodeId !== "d1");
            p.layout.placements = p.layout.placements.filter(x => x.nodeId !== "d1");
            return { input: p, opts: off() };
        },
    });

    /* ══════════════ 清单 8 条（redteam-compiler-assumptions.md:141-150） ══════════════ */

    add({
        id: "C1-rect-not-empty", source: "清单1 落点矩形全空", expect: "V1-occupancy",
        injected: "既有世界在 (0,3) 有一台 cutter（规划带子压上去 → 该格 paste 会 game_rejected、其余照常 = 半建线）",
        expectCell: [0, 3], expectNode: "belt@0,3",
        make: () => {
            const p = P();
            p.world = { entities: [{ uid: 900, type: "cutter", x: 0, y: 3, r: 0, variant: "default", rotationVariant: 0, code: 9, layer: "regular" }], replaceableBeltCells: [] };
            return { input: p, opts: off() };
        },
    });
    add({
        id: "C2-not-fixed-point", source: "清单2 computeBelt 不动点（含机器邻居）", expect: "V3-belt-fixed-point",
        injected: "把入站直带 (10,4) 的 rot 改成 270（rv 不动；游戏按邻居重算 rotation 与 rv）",
        expectCell: [10, 4], expectNode: "belt@10,4",
        make: () => {
            const l = L(), i = I();
            const b = findBelt(i.entities, "belt@10,4");
            b.rot = 270; b.inDir = rotDir("bottom", 270); b.outDir = rotDir(EXIT_LOCAL[0], 270);
            return { input: l, opts: off({ entities: i.entities }) };
        },
    });
    add({
        id: "C3-fanin-gt-slots", source: "清单3 入度 ≤ 槽位数", expect: "V5-degree",
        injected: "给 stacker 第 3 条输入通道（stacker 只有 2 个 bottom，必须先二叉化）",
        expectCell: [0, 1], expectNode: "st",
        make: () => {
            const l = L(), i = I();
            l.channels.push({ from: { nodeId: "mA", cell: [0, 9], slot: "top", outDir: "top" }, to: { nodeId: "st", cell: [0, 1], slot: "bottom", inDir: "bottom" }, lane: null, payload: "RuRuCuCu", slotRole: "upper", ordinal: 2 });
            return { input: l, opts: off({ entities: i.entities }) };
        },
    });
    add({
        id: "C4-crossing-needs-tunnel", source: "清单4 交叉检测 → 需隧道", expect: "V6-crossing",
        injected: "车道台账把两条不同 payload 的通道记在同一行（row 3 挂 chA+chB）→ 两股流同排 = 需隧道",
        expectCell: null, expectNode: null, sub: "台账行",
        make: () => {
            const l = L(), i = I();
            l.lanes = [{ row: 3, channelIds: ["chA", "chB"] }];
            return { input: l, opts: off({ entities: i.entities }) };
        },
    });
    add({
        id: "C5-flow-axis-heterogeneity", source: "清单5 +y 系与 painter(+x) 系异质", expect: "V4-slot-alignment",
        injected: "把 cutter（下进上出）换成 painter（左进右出）—— 竖直上行流接不上它的槽位",
        expectCell: [0, 4], expectNode: "n1", sub: "槽位方位不符",
        make: () => {
            const p = P();
            const pl = p.layout.placements.find(x => x.nodeId === "n1"); pl.op = "paint"; pl.kind = "painter";
            const e = p.entities.find(x => x.nodeId === "n1"); e.code = 16; e.kind = "painter";
            return { input: p, opts: off() };
        },
    });
    add({
        id: "C6-color-lane-missing", source: "清单6 颜料独立通道可达", expect: "V4-slot-alignment",
        injected: "整条上层分支（矿机 mB + 车道 + 拐角 + mB→st 通道）不存在 → stacker 上层输入槽没有任何供料",
        expectCell: [1, 1], expectNode: "st", sub: "没有任何上游供料",
        make: () => {
            const l = L(), i = I();
            l.channels = l.channels.filter(c => c.from.nodeId !== "mB");
            l.placements = l.placements.filter(p => p.nodeId !== "mB");
            const gone = new Set(["mB", "belt@10,8", "belt@10,7", "belt@10,6", "belt@10,5", "belt@10,4", "belt@10,3", "belt@9,3", "belt@8,3", "belt@7,3", "belt@6,3", "belt@5,3", "belt@4,3", "belt@3,3", "belt@2,3", "belt@1,3", "belt@1,2"]);
            i.entities = i.entities.filter(e => !gone.has(e.nodeId));
            l.lanes = [];
            l.rows = l.rows.map(r => ({ ...r, nodeIds: r.nodeIds.filter(n => n !== "mB") }));
            return { input: l, opts: off({ entities: i.entities }) };
        },
    });
    add({
        id: "C7-throughput", source: "清单7 吞吐可行性（stacker 0.25/s）", expect: "V7-throughput",
        injected: "需求 0.6/s，而 merge 布局只有 1 台 stacker（0.25/s）→ 需 3 行、只规划 1 行",
        expectCell: [0, 1], expectNode: "st",
        make: () => { const l = L(), i = I(); return { input: l, opts: off({ entities: i.entities, demandPerSec: 0.6 }) }; },
    });
    add({
        id: "C8-multilayer", source: "清单8 多层形状 v1 拒绝", expect: "V8-scope",
        injected: "goal 换成 level-11 的多层形状 CuCuSuSu:RuRuCuCu（多层布局完全未做）",
        expectCell: null, expectNode: null,
        make: () => { const p = P(); p.goal = "CuCuSuSu:RuRuCuCu"; return { input: p, opts: off() }; },
    });

    /* ══════════════ 4 条补充：毁带闸 / D1 旋转 / V10 报告口径 / S1 形状 ══════════════ */
    add({
        id: "X1-overwrite-existing-belt", source: "redteam:102-112 / C1 静默毁带", expect: "V2-no-overwrite-existing-belt",
        injected: "既有世界在 (0,2) 有一条可替换带（paste 会静默销毁它，applied/failed 不报告）",
        expectCell: [0, 2], expectNode: "belt@0,2",
        make: () => { const p = P(); p.world = { entities: [], replaceableBeltCells: ["0,2"] }; return { input: p, opts: off() }; },
    });
    add({
        id: "X2-rotated-machine", source: "决策 D1 / 清单1 旋转包围盒", expect: "V8-scope",
        injected: "把 cutter 的 placement rot 改成 90（v1 禁止旋转机器；rot≠0 的 origin 位移未实机验证）",
        expectCell: [0, 4], expectNode: null,
        make: () => { const p = P(); p.layout.placements.find(x => x.nodeId === "n1").rot = 90; return { input: p, opts: off() }; },
    });
    add({
        id: "X10-unlock-report", source: "redteam:190-216 / C7 god-mode", expect: "V10-unlock-report:report-only",
        injected: "currentLevel=1 但矿机用 chainable 变体（L11 才解锁）→ 只列清单、**不产生 error**（报告口径）",
        expectCell: [0, 5], expectNode: "n0",
        make: () => {
            const p = P();
            p.layout.placements.find(x => x.nodeId === "n0").op = "mineChainable";
            p.entities.find(x => x.nodeId === "n0").code = 8;
            return { input: p, opts: { checkEntityOrder: false, currentLevel: 1 } };
        },
    });
    add({
        id: "XS1-shape-mismatch", source: "DESIGN:93 Level-1", expect: "S1-shape-replay",
        injected: "把 hub 通道的 payload 改成 RuRu----（cutter 从 CuCuCuCu 切不出这个形状）",
        expectCell: [0, 4], expectNode: "n1",
        make: () => { const p = P(); p.layout.channels.find(c => c.to.nodeId === "hub").payload = "RuRu----"; return { input: p, opts: off() }; },
    });

    return rows;
}
