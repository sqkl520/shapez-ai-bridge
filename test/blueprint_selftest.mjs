/**
 * blueprint.mjs 的测试：编解码往返、格式校验、成本公式。
 * 附加：与 mod 端放置/导出逻辑的语义对齐（用假的 code 值模拟）。
 */
import { decodeBlueprint, encodeBlueprint, summarizeBlueprint, blueprintCost, BLUEPRINT_PREFIX } from "../src/shared/blueprint.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const LZString = require("../src/shared/lz-string.cjs");

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
function assert(c, m) {
    if (!c) throw new Error(m || "assertion failed");
}

check("round trip basic", () => {
    const data = {
        gv: "1.5.6",
        w: [-10, 4],
        entities: [
            { code: 1, dx: 0, dy: 0, rot: 90 },
            { code: 7, dx: 2, dy: 0, rot: 0 },
            { code: 26, dx: 5, dy: 5, rot: 0 },
        ],
    };
    const text = encodeBlueprint(data);
    assert(text.startsWith(BLUEPRINT_PREFIX), "prefix");
    const back = decodeBlueprint(text);
    assert(back.gv === "1.5.6", "gv");
    assert(back.w[0] === -10 && back.w[1] === 4, "anchor");
    assert(back.entities.length === 3, "count");
    assert(back.entities[1].code === 7 && back.entities[1].dx === 2 && back.entities[1].rot === 0, "second entity");
});

check("empty blueprint round trips", () => {
    const text = encodeBlueprint({ gv: "1.5.6", w: [0, 0], entities: [] });
    const back = decodeBlueprint(text);
    assert(back.entities.length === 0, "empty");
});

check("prefix enforced", () => {
    let threw = null;
    try {
        decodeBlueprint("NOTBP.abc");
    } catch (e) {
        threw = e;
    }
    assert(threw && threw.code === "2001", "2001 for bad prefix");
});

check("corrupted body -> 2001", () => {
    let threw = null;
    try {
        decodeBlueprint("SZBP1.!!!not-valid-lz-string!!!");
    } catch (e) {
        threw = e;
    }
    assert(threw && threw.code === "2001", "2001 for corrupt body");
});

check("malformed payload -> 2001", () => {
    // 合法压缩但结构错：e 长度不是 4 的倍数 → 应报 2001
    const badJson = JSON.stringify({ v: 1, gv: "1.5.6", w: [0, 0], e: [1, 2, 3] });
    const text = BLUEPRINT_PREFIX + LZString.compressToEncodedURIComponent(badJson);
    let threw = null;
    try {
        decodeBlueprint(text);
    } catch (e) {
        threw = e;
    }
    assert(threw && threw.code === "2001", "2001 for stride mismatch");
});

check("cost formula matches game for common n", () => {
    // n=1: 4 -> findNiceValue(4)=4 (<=20 => t=1) -> 4
    assert(blueprintCost(1) === 4, "cost(1)=4 got " + blueprintCost(1));
    // n=10: 4*10^1.1 = 50.12 -> >20 => t=5 -> floor(50.12/5)*5=50 -> 50
    assert(blueprintCost(10) === 50, "cost(10)=50 got " + blueprintCost(10));
    // n=100: 4*100^1.1 = 4*158.5 = 634 -> >100 => t=20 -> floor(634/20)*20=620 -> 620
    assert(blueprintCost(100) === 620, "cost(100)=620 got " + blueprintCost(100));
    // n=1000: 4*1000^1.1 = 4*1995.26 = 7981 -> >5000 => t=1000 -> 7000
    assert(blueprintCost(1000) === 7000, "cost(1000)=7000 got " + blueprintCost(1000));
});

check("summarize gives counts and bounds", () => {
    const text = encodeBlueprint({
        gv: "1.5.6",
        w: [0, 0],
        entities: [
            { code: 1, dx: 0, dy: 0, rot: 90 },
            { code: 1, dx: 1, dy: 0, rot: 90 },
            { code: 1, dx: 2, dy: 0, rot: 90 },
            { code: 7, dx: 0, dy: 3, rot: 0 },
        ],
    });
    const s = summarizeBlueprint(text);
    assert(s.count === 4, "count");
    assert(s.by_code[1] === 3 && s.by_code[7] === 1, "by_code");
    assert(s.bounds[0] === 3 && s.bounds[1] === 4, "bounds got " + JSON.stringify(s.bounds));
    assert(s.exported_from === "1.5.6", "gv surfaced");
});

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
// ── v2 平行数组 o（originalRotation）—— P6 NOTES §1 的实测风险要变成断言 ──

check("v2: orig 往返（带 o 的蓝图读回 orig）", () => {
    const text = encodeBlueprint({
        gv: "1.5.6", w: [0, 0],
        entities: [
            { code: 1, dx: 0, dy: 0, rot: 0, orig: 270 },
            { code: 3, dx: 1, dy: 0, rot: 270, orig: 0 },
        ],
    });
    const bp = decodeBlueprint(text);
    assert(bp.v === 2, "version 应为 2, got " + bp.v);
    assert(bp.entities[0].orig === 270, "第 0 格 orig=270, got " + bp.entities[0].orig);
    assert(bp.entities[0].rot === 0, "第 0 格 rot 不受影响");
    assert(bp.entities[1].orig === 0, "第 1 格 orig=0, got " + bp.entities[1].orig);
});

check("v1 兼容：不带 orig 仍是 v1 载荷，逐字节等价于历史行为", () => {
    const text = encodeBlueprint({ gv: "1.5.6", w: [0, 0], entities: [{ code: 1, dx: 0, dy: 0, rot: 90 }] });
    const bp = decodeBlueprint(text);
    assert(bp.v === 1, "无 orig 时应保持 v1, got " + bp.v);
    assert(bp.entities[0].orig === 90, "缺 o 时 orig 回落到 rot");
});

check("v2 向后兼容：v1 解码器读 v2 文本不会静默错位（e 仍 4 列）", () => {
    // 8 格 = P6 实测的「n%4==0 静默中招」规模之一（n=4/8/12/16）
    const ents = Array.from({ length: 8 }, (_, i) => ({ code: 1, dx: i, dy: 0, rot: 0, orig: 90 }));
    const text = encodeBlueprint({ gv: "1.5.6", w: [0, 0], entities: ents });
    const bp = decodeBlueprint(text);
    assert(bp.entities.length === 8, "必须读回 8 个实体（不是 10 个）, got " + bp.entities.length);
    assert(bp.entities.every((e, i) => e.dx === i && e.code === 1), "逐格不错位");
});

check("v2 防御：o 长度不符必须 2001 拒绝（不许静默截断）", () => {
    const payload = { v: 2, gv: "1.5.6", w: [0, 0], e: [1, 0, 0, 0, 1, 1, 0, 0], o: [90] };   // 2 格却只给 1 个 orig
    const text = BLUEPRINT_PREFIX + LZString.compressToEncodedURIComponent(JSON.stringify(payload));
    let threw = null;
    try { decodeBlueprint(text); } catch (e) { threw = e; }
    assert(threw && threw.code === "2001", "必须 2001, got " + (threw && threw.code));
    assert(/o\.length/.test(threw.message), "错误信息点名 o.length");
});

check("v2 防御：未知版本号（v:3）应拒", () => {
    const payload = { v: 3, gv: "1.5.6", w: [0, 0], e: [1, 0, 0, 0] };
    const text = BLUEPRINT_PREFIX + LZString.compressToEncodedURIComponent(JSON.stringify(payload));
    let threw = null;
    try { decodeBlueprint(text); } catch (e) { threw = e; }
    assert(threw && threw.code === "2001", "v:3 应 2001");
});

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
