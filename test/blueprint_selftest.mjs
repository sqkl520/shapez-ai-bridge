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
process.exit(fail === 0 ? 0 : 1);
