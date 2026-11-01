/**
 * 重建 `savegames.bin` 索引 —— 让游戏重新「看见」磁盘上那些存档。
 *
 * ## 为什么需要
 *
 * 见 `research/ai-plan/SAVEGAME-INDEX-DEFECT.md`：索引被截断成空
 * （127 字节、`savegames: []`），而磁盘上 7 个 `savegame-*.bin` **完好**。
 * 游戏因此 `list_saves` 返回空、`load_save` 2002，真机闭环起不来。
 *
 * ## 格式（已实测解出）
 *
 * ```
 * <40 字符 checksum><json 压缩后的内容>
 * ```
 *
 * 空索引解压后是：
 * ```
 * crc32---------------------------0f474b14
 * {"keys":["version","savegames"],"values":[],"data":{"#":1002,"%":[]}}
 * ```
 *
 * `#` = version（1002），`%` = savegames 数组（现在空）。
 *
 * ## 关键：checksum 需要 salt
 *
 * `read_write_proxy.js:90`：`computeCrc(jsonString + salt)`，
 * 而 `salt = globalConfig.info.file`（**在游戏进程内**）。
 *
 * ⇒ **这个脚本不能在游戏外跑。** 它必须通过 bridge 的 RPC 在游戏内执行，
 *    或者由 mod 提供一个 `rebuild_saveindex` RPC。
 *
 * 所以本文件是**离线验证器**：它读 `snapshots/` 或 `saves/` 里的存档元数据，
 * 生成 `savegames` 数组的内容，并打印出来 —— 供 mod 端的重建逻辑使用。
 *
 * 用法：
 *   node .tmpverify/saveindex/build.mjs           # 打印重建所需的 JSON 片段
 *   node .tmpverify/saveindex/build.mjs --write   # 写一个候选文件（checksum 用旧值，
 *                                                 # 游戏会用 checksum-mismatch 拒它）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decodeSave } = require('../../recon/decode_full.cjs');

const SAVES = path.join(process.env.APPDATA || '', 'shapez.io', 'saves');

/* ─────────── 扫磁盘上的存档 ─────────── */
const files = fs.readdirSync(SAVES)
    .filter(f => /^savegame-[0-9a-f]{40}\.bin$/.test(f));

console.log(`扫描 ${SAVES}`);
console.log(`找到 ${files.length} 个存档文件\n`);

const entries = [];
for (const f of files) {
    const id = f.slice('savegame-'.length, -'.bin'.length);
    const full = path.join(SAVES, f);
    const st = fs.statSync(full);
    let level = null, version = null;
    try {
        const d = decodeSave(full);
        const dump = d.obj && d.obj.dump;
        level = dump && dump.hubGoals ? dump.hubGoals.level : null;
        version = d.version;
    } catch (e) {
        console.log(`  ⚠ ${id.slice(0, 8)} 解码失败：${e.message}`);
    }
    entries.push({
        internalId: id,
        level,
        version,
        lastUpdate: Math.round(st.mtimeMs),
        size: st.size,
    });
}

console.log('解出的条目：');
for (const e of entries) {
    const tag = e.level !== null ? `lv${e.level}` : '???';
    console.log(`  ${e.internalId.slice(0, 8)}  ${tag.padEnd(5)}  ${(e.size + 'B').padStart(7)}  ${new Date(e.lastUpdate).toISOString().slice(0, 19)}`);
}

/* ─────────── 生成 savegames 数组（游戏的压缩格式） ───────────
 *
 * `compressObject` 把对象压成 `{keys:[...], values:[...], data:{...}}`：
 *   · 字符串值 → 在 values 里的索引（encodeInt 需要 ALPHA 表）
 *   · 对象 key → 在 keys 里的索引
 *
 * 简化：**不压缩**（直接用明文 key 和明文值）也是合法 JSON ——
 * 游戏读的时候走 `decompressObject`，它只看 `parsed.data`。
 * 但 `decompressObject(parsed)` 期望 `{keys, values, data}` 三件套，
 * 所以必须按那个形状给。
 *
 * ⚠️ 数字和布尔不压缩（`decompressObjectInternal` 对非 string 原样返回）。
 */
const ALPHA = "!#%&'()*+,-./:;<=>?@[]^_`{|}~\xa5\xa6\xa7\xa8\xa9\xaa\xab\xac\xad\xae\xaf\xb0\xb1\xb2\xb3\xb4\xb5\xb6\xb7\xb8\xb9\xba\xbb\xbc\xbd\xbe\xbf\xc0\xc1\xc2\xc3\xc4\xc5\xc6\xc7\xc8\xc9\xca\xcb\xcc\xcd\xce\xcf\xd0\xd1\xd2\xd3\xd4\xd5\xd6\xd7\xd8\xd9\xda\xdb\xdc\xdd\xde\xdf\xe0\xe1\xe2\xe3\xe4\xe5\xe6\xe7\xe8\xe9\xea\xeb\xec\xed\xee\xef\xf0\xe1\xf2\xf3\xf4\xf5\xf6\xf7\xf8\xf9\xfa\xfb\xfc\xfd\xfe\xffABCDEFGHIJKLMNOPQRSTUVWXYZ";

function encodeInt(n) {
    let s = '';
    let v = n + 1;
    while (v > 0) {
        s = ALPHA[v % ALPHA.length] + s;
        v = Math.floor(v / ALPHA.length);
    }
    return s || ALPHA[0];
}

/** 把任意对象压成 {keys, values, data} 形状（与游戏的 compressObject 同构）。 */
function compressObject(obj) {
    const keys = [];
    const values = [];
    const keyIdx = new Map();
    const valIdx = new Map();
    const walk = (v) => {
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') {
            const out = {};
            for (const k of Object.keys(v)) {
                if (!keyIdx.has(k)) { keyIdx.set(k, keys.length); keys.push(k); }
                out[encodeInt(keyIdx.get(k))] = walk(v[k]);
            }
            return out;
        }
        if (typeof v === 'string') {
            if (!valIdx.has(v)) { valIdx.set(v, values.length); values.push(v); }
            return encodeInt(valIdx.get(v));
        }
        return v;   // 数字原样
    };
    const data = walk(obj);
    return { keys, values, data };
}

const payload = {
    version: 1002,
    savegames: entries.map(e => ({
        internalId: e.internalId,
        level: e.level,
        version: e.version,
        lastUpdate: e.lastUpdate,
    })),
};

const compressed = compressObject(payload);

console.log('\n── 重建所需的 payload ──');
console.log(JSON.stringify(payload, null, 1).slice(0, 800));
console.log(`\n（${entries.length} 条，压缩后 ${JSON.stringify(compressed).length} 字符）`);

/* ─────────── 自检：往返一致 ─────────── */
{
    const ALPHA_LEN = ALPHA.length;
    const decodeInt = (s) => {
        let t = 0;
        for (let i = s.length - 1; i >= 0; i--) t = t * ALPHA_LEN + ALPHA.indexOf(s[i]);
        return t - 1;
    };
    const decompress = (e, keys = [], values = []) => {
        if (Array.isArray(e)) return e.map(x => decompress(x, keys, values));
        if (e && typeof e === 'object') {
            const o = {};
            for (const k in e) o[keys[decodeInt(k)]] = decompress(e[k], keys, values);
            return o;
        }
        return typeof e === 'string' ? values[decodeInt(e)] : e;
    };
    const back = decompress(compressed.data, compressed.keys, compressed.values);
    const ok = JSON.stringify(back) === JSON.stringify(payload);
    console.log(`\n自检：往返${ok ? "一致 ✓" : "不一致 ✗"}`);
    if (!ok) {
        console.log('  原:', JSON.stringify(payload).slice(0, 200));
        console.log('  回:', JSON.stringify(back).slice(0, 200));
        process.exitCode = 1;
    }
}

/* ─────────── 关键结论 ─────────── */
console.log(`
── 下一步（必须在游戏进程内做）──

这个脚本**不能**自己写出 savegames.bin，因为 checksum 需要
\`globalConfig.info.file\`（只在游戏里）。两条路：

  A. 通过 bridge 的 RPC 在游戏内执行重建（需要 mod 加一个 \`rebuild_saveindex\`）
  B. 临时改 mod，让它启动时检查「索引为空但磁盘有存档」并自动重建

A 更干净。B 更快（mod 已经能拿到 salt —— 见 \`savegameSalt()\`）。

两者都改代码，所以本脚本到此为止：它只证明「能算出正确的 payload」。
`);
