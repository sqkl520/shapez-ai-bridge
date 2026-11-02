/**
 * `src/shared/save_codec.mjs` —— 离线存档解码器。
 *
 * ## 为什么要测它
 *
 * 这个解码器是「存档文件到底还是不是我要的那份」的**唯一独立判据**。
 * 2026-11-03 强杀进程导致主存档消失时，`list_saves` 仍报 `level: 5`、
 * `load_save` 仍回 `ok: true`，只有离线解码能看出实际是 level 1 / 1 实体
 * 的空世界。判据本身错了，就会拷错文件回去。
 *
 * ## 写这个解码器时踩过的三个坑（每个都让结果看起来"差不多对"）
 *
 * 1. **base64 变体**：`core/lzstring.js:83` 用的是 URI-safe
 *    （`compressToEncodedURIComponent`），不是 `compressToBase64`。
 *    用错能解出片段但 JSON 解析失败。
 * 2. **压缩前缀**：`\x01`（`core/async_compression.js:9`），不是 `"V1;"` 之类。
 * 3. **字段路径**：`entities` / `beltPaths` 在 `dump` **顶层**，
 *    不在 `dump.entityMgr` 下 —— 写错会得到 `ents=0` 却 `level=5`。
 */
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { decodeSaveFile, decompressInt, decompressObject, CHARMAP } from "../src/shared/save_codec.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const LZ = req("../src/shared/lz-string.cjs");
const FIXTURE = path.resolve(__dirname, "fixtures/saves/lv5-63ents.bin");

let pass = 0, fail = 0;
const check = (name, fn) => {
    try { fn(); pass++; console.log("PASS", name); }
    catch (e) { fail++; console.log("FAIL", name, "->", e && e.message); }
};
const assert = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };

/* ── D1：真存档 fixture 能被解出已知的等级与实体数 ──
 * 这两个数字来自 2026-11-03 那次事故的独立核对：
 * 主文件/`.backup-<ts>`/`.tmp-<ts>` 三份解出来都是 level 5 / 63 实体 / seed 60908。
 */
check("D1 解真存档：level=5, 63 实体, seed=60908", () => {
    assert(existsSync(FIXTURE), `fixture 缺失: ${FIXTURE}`);
    const d = decodeSaveFile(FIXTURE);
    assert(d.level === 5, `level 应为 5，实际 ${d.level}`);
    assert(d.entities === 63, `实体数应为 63，实际 ${d.entities}`);
    assert(d.seed === 60908, `seed 应为 60908，实际 ${d.seed}`);
    assert(d.bytes === 3601, `文件大小应为 3601，实际 ${d.bytes}`);
});

/* ── D2：entityMgr 里没有 entities（钉住字段路径这个坑） ──
 * 如果哪天有人"顺手"改成读 dump.entityMgr.entities，D1 仍会过（因为
 * decodeSaveFile 读的是顶层），但这个测试会立刻指出结构变了。
 */
check("D2 entities 挂在 dump 顶层，entityMgr 只有 nextUid", () => {
    const d = decodeSaveFile(FIXTURE);
    const dump = d.raw.dump;
    assert(Array.isArray(dump.entities), "dump.entities 应是数组");
    assert(dump.entities.length === 63, `dump.entities 长度应为 63，实际 ${dump.entities.length}`);
    const em = dump.entityMgr || {};
    assert(!Array.isArray(em.entities), "dump.entityMgr.entities 不该是数组（字段路径坑）");
});

/* ── D3：beltPaths 也在顶层 ── */
check("D3 beltPaths 在 dump 顶层且非空", () => {
    const d = decodeSaveFile(FIXTURE);
    assert(Array.isArray(d.raw.dump.beltPaths) || typeof d.raw.dump.beltPaths === "object",
        "dump.beltPaths 应存在");
    assert(d.beltPaths > 0, `beltPaths 应非空，实际 ${d.beltPaths}`);
});

/* ── D4：坏前缀要明确报错，不能静默返回空结果 ── */
check("D4 前缀不对时报错（而不是返回 entities:0）", () => {
    const os = { tmpdir };
    const fs = { writeFileSync, unlinkSync };
    const tmp = path.join(os.tmpdir(), `bad-save-${Date.now()}.bin`);
    fs.writeFileSync(tmp, "V1;notreallyasave");
    try {
        let threw = null;
        try { decodeSaveFile(tmp); } catch (e) { threw = e; }
        assert(threw, "坏前缀应抛错");
        assert(/prefix/i.test(threw.message), `报错应提到 prefix，实际: ${threw.message}`);
    } finally {
        fs.unlinkSync(tmp);
    }
});

/* ── D5：decompressInt 单字符区间与 CHARMAP 一致 ──
 *
 * 用**生产模块导出的** CHARMAP，不手抄 —— 手抄过一次就抄错了（丢了 `_`），
 * 这正说明这个测试本身有价值。
 *
 * ⚠️ 只测单字符是**故意**的：`decompressInt` 末尾有 `result -= 1`
 * （`savegame_compressor.js:47`，用来修零值），所以单字符 `CHARMAP[k]`
 * 解出 `k-1`；多字符编码的往返**不**成立。那是 upstream 自己的行为。
 * 实测真存档解出的键全是单字符，所以这个区间就是实际用到的全部。
 */
check("D5 decompressInt 单字符区间与 CHARMAP 一致", () => {
    assert(CHARMAP.length === 146, `CHARMAP 长度应为 146，实际 ${CHARMAP.length}`);
    for (let k = 1; k < CHARMAP.length; k++) {
        const enc = CHARMAP.charAt(k);
        const dec = decompressInt(enc);
        assert(dec === k - 1, `CHARMAP[${k}] 应解出 ${k - 1}，实际 ${dec}`);
    }
});

/* ── D6：decompressObject 对非压缩对象应原样返回 ── */
check("D6 decompressObject 对普通对象原样返回", () => {
    const plain = { hello: "world", n: 1 };
    const out = decompressObject(plain);
    assert(out.hello === "world" && out.n === 1, "普通对象不该被改动");
});

/* ── D7：level 缺失时给 null 而不是 undefined（调用方好判断） ── */
check("D7 缺 hubGoals 时 level 为 null", () => {
    const os = { tmpdir };
    const fs = { writeFileSync, unlinkSync };
    
    const charmap = CHARMAP;
    // 索引 0 编码成 charmap[1]（decompressInt 最后会 -1）
    const idx0 = charmap.charAt(1);
    const payload = { keys: ["dump"], values: [{}], data: { [idx0]: {} } };
    const body = "0000" + JSON.stringify(payload); // 假 checksum
    const encoded = String.fromCodePoint(1) + LZ.compressToEncodedURIComponent(body);
    const tmp = path.join(os.tmpdir(), `empty-dump-${Date.now()}.bin`);
    fs.writeFileSync(tmp, encoded);
    try {
        const d = decodeSaveFile(tmp);
        assert(d.level === null, `level 应为 null，实际 ${JSON.stringify(d.level)}`);
        assert(d.goal === null, `goal 应为 null，实际 ${JSON.stringify(d.goal)}`);
        assert(d.entities === 0, `entities 应为 0，实际 ${d.entities}`);
    } finally {
        fs.unlinkSync(tmp);
    }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
