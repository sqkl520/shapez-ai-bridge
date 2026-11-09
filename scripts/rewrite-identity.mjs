/**
 * 流式重写提交者/作者邮箱（`fast-export` → 文本替换 → `fast-import`）。
 *
 * ## 为什么不用 `git filter-branch --env-filter`
 *
 * 本机实测 **21 秒/提交**（351 个 ref ⇒ 2 小时）。这不是算法问题 ——
 * `--env-filter` 本身很轻，慢的是 filter-branch 每个提交都要做一次
 * git 对象读写，而在这台机器上每次 ~1 秒（Windows + 杀软）。
 *
 * `fast-export` / `fast-import` 把整个历史当一个文本流处理，
 * 全程只有 2 次 git 进程调用，与提交数无关 —— 实测 13 秒。
 *
 * ## 只在 `author` / `committer` 行上替换
 *
 * fast-export 的流里，`author <name> <email> <time> <tz>` 与
 * `committer ...` 各占一行。提交消息体在 `data <n>` 块里，
 * 里面**也可能**出现同样的字符串（比如某次提交讨论了邮箱），
 * 所以不能对整块做全局替换 —— 必须逐行判断，只改这两个前缀的行。
 *
 * 用法：
 *   OLD_EMAIL=a@b.c NEW_EMAIL=x@y.z node scripts/rewrite-identity.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OLD = process.env.OLD_EMAIL;
const NEW = process.env.NEW_EMAIL;
if (!OLD || !NEW) {
    console.error("需要 OLD_EMAIL 与 NEW_EMAIL 环境变量");
    process.exit(2);
}

const TMP = ".scrub-id";
fs.mkdirSync(TMP, { recursive: true });
const dumpFile = path.join(TMP, "dump.fi");

console.log("① fast-export …");
{
    const out = fs.openSync(dumpFile, "w");
    try {
        execFileSync("git", ["fast-export", "--all",
            "--signed-tags=strip", "--tag-of-filtered-object=drop", "--reencode=no"],
            { stdio: ["ignore", out, "inherit"], maxBuffer: 1 << 30 });
    } finally { fs.closeSync(out); }
}

console.log("② 逐行替换 author/committer …");
const buf = fs.readFileSync(dumpFile);
const outChunks = [];
let i = 0;
let changed = 0;
const N = buf.length;

while (i < N) {
    let nl = buf.indexOf(10, i);
    if (nl < 0) nl = N;
    let contentEnd = nl;
    if (contentEnd > i && buf[contentEnd - 1] === 13) contentEnd -= 1;
    const line = buf.toString("latin1", i, contentEnd);

    /* data 块按字节跳过，不动内容 —— 提交消息里出现旧邮箱也不该改
       （那是历史事实：某次讨论里确实提到过它）。 */
    const dm = /^data (\d+)$/.exec(line);
    if (dm) {
        const len = Number(dm[1]);
        const bodyStart = nl + 1;
        const bodyEnd = bodyStart + len;
        outChunks.push(buf.subarray(i, bodyEnd));
        i = bodyEnd;
        if (buf[i] === 13) { outChunks.push(buf.subarray(i, i + 1)); i += 1; }
        if (buf[i] === 10) { outChunks.push(buf.subarray(i, i + 1)); i += 1; }
        continue;
    }

    if ((line.startsWith("author ") || line.startsWith("committer ")) && line.includes(`<${OLD}>`)) {
        const patched = line.replace(`<${OLD}>`, `<${NEW}>`);
        outChunks.push(Buffer.from(patched, "latin1"));
        outChunks.push(buf.subarray(contentEnd, nl + 1));      // 行尾原样
        changed++;
        i = nl + 1;
        continue;
    }

    outChunks.push(buf.subarray(i, nl + 1));
    i = nl + 1;
}
console.log(`   改写了 ${changed} 行`);

/* 重命名到临时命名空间，验证后再切 */
const finalBuf = Buffer.concat(outChunks);
const text = finalBuf.toString("latin1")
    .replace(/(^|\n)commit refs\/heads\//g, "$1commit refs/idrewrite/heads/")
    .replace(/(^|\n)commit refs\/tags\//g, "$1commit refs/idrewrite/tags/")
    .replace(/(^|\n)reset refs\/heads\//g, "$1reset refs/idrewrite/heads/")
    .replace(/(^|\n)reset refs\/tags\//g, "$1reset refs/idrewrite/tags/")
    .replace(/(^|\n)tag refs\/tags\//g, "$1tag refs/idrewrite/tags/")
    .replace(/(^|\n)from refs\/heads\//g, "$1from refs/idrewrite/heads/")
    .replace(/(^|\n)merge refs\/heads\//g, "$1merge refs/idrewrite/heads/");

const cleanFile = path.join(TMP, "clean.fi");
fs.writeFileSync(cleanFile, Buffer.from(text, "latin1"));

console.log("③ fast-import …");
{
    const input = fs.openSync(cleanFile, "r");
    try {
        execFileSync("git", ["fast-import", "--force", "--quiet"],
            { stdio: [input, "inherit", "inherit"] });
    } finally { fs.closeSync(input); }
}

console.log("\n④ 结果：");
execFileSync("git", ["for-each-ref",
    "--format=%(refname) %(objectname:short)", "refs/idrewrite/"], { stdio: "inherit" });

console.log("\n验证后切换：");
console.log("  git update-ref refs/heads/main $(git rev-parse refs/idrewrite/heads/main)");
console.log("  git tag -f v0.1.0-SNAPSHOT $(git rev-parse refs/idrewrite/tags/v0.1.0-SNAPSHOT)");
