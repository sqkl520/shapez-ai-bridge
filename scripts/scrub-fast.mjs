/**
 * 用 `fast-export` / `fast-import` 流式清洗历史。
 *
 * ## 为什么是这条路线（前六版都试过，全部记在这里）
 *
 * | # | 做法 | 为什么不行 |
 * |---|---|---|
 * | 1 | `filter-branch --tree-filter` | 每提交 checkout 全工作区，~2 分钟/提交 |
 * | 2 | `filter-branch --index-filter` + `ls-files` | Windows 上索引 1090 项 ~30 秒/次 |
 * | 3 | 手写解析 `cat-file --batch` 的 tree 二进制 | **静默失败**：解析错，报"完成"而密钥还在 |
 * | 4 | 每提交 `ls-tree -r` | 235ms × 275 次 + `commit-tree` 1.1s × 275，10+ 分钟还卡住 |
 * | 5 | 路径级重建 + 只处理脏树 | 逻辑对了，但仍要 O(提交数) 次 git 写操作 |
 *
 * **共同瓶颈**：这台机器上每写一次 git 对象就 ~1 秒（Windows + 杀软）。
 * 任何 O(提交数) 次的**独立** git 调用都不可接受。
 *
 * ## 这条路线为什么快
 *
 * `git fast-export` 把整个历史导出成**一个文本流**（55MB，秒级完成），
 * 我们在内存里过滤这个流，然后用 `git fast-import` **一次性**导入。
 * 全程只有 **2 次** git 进程调用，与提交数无关。
 *
 * ## 清洗两件事
 *
 * 1. **删掉**含密钥的那些临时文件（`.tmpverify/` 下的 runner、`live/` 下的脚本）——
 *    它们本来就该在 .gitignore 里。
 * 2. **替换**文档里出现的密钥字面量（`research/ai-plan/*.md` 里引用过）。
 *
 * 用法：
 *   SCRUB_KEY=sk-... node scripts/scrub-fast.mjs
 *
 * 先打备份 tag（调用方负责）。成功后旧 ref 会被移到 `refs/original/`。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const KEY = process.env.SCRUB_KEY;
if (!KEY) { console.error("需要 SCRUB_KEY 环境变量"); process.exit(2); }
const REPLACEMENT = "<REDACTED-API-KEY>";

const TMP = path.join(".scrub");
fs.mkdirSync(TMP, { recursive: true });

/* ── 1. fast-export ─────────────────────────────────────────────────────── */
/* `--signed-tags=strip`：重写后签名必然失效，直接去掉而不是报错。
   `--tag-of-filtered-object=drop`：指向已删对象的 tag 一并丢弃。
   `--reencode=no`：保持提交消息的原始编码（消息里有中文）。 */
const dumpFile = path.join(TMP, "dump.fi");
console.log("① fast-export …");
{
    const out = fs.openSync(dumpFile, "w");
    try {
        execFileSync("git", [
            "fast-export", "--all",
            "--signed-tags=strip",
            "--tag-of-filtered-object=drop",
            "--reencode=no",
        ], { stdio: ["ignore", out, "inherit"], maxBuffer: 1 << 30 });
    } finally {
        fs.closeSync(out);
    }
}
const stat = fs.statSync(dumpFile);
console.log(`   ${(stat.size / 1048576).toFixed(1)} MB`);

/* ── 2. 过滤 ────────────────────────────────────────────────────────────── */

/* fast-export 的流格式：每个对象以一行 `blob` / `commit <ref>` / `reset <ref>`
   开始，`mark :N`，`data <len>\n<bytes>`。要正确过滤必须按 data 长度切，
   不能按行切（二进制 blob 里可能有换行）。

   做法：把整个缓冲读进来，按"块"扫描。块头是 `^(\w+)`，块体里的 `data <n>`
   决定要跳过多少字节。 */

const ENTRIES = [
    /* 含密钥、且本来就不该进公开仓的临时文件 —— 从历史里整个删掉 */
    /^\.tmpverify\/(ab-hint|ab-real|live-loop|live-multiround)\//,
    /^research\/ai-plan\/live\/guard\.mjs$/,
    /^research\/ai-plan\/live\/loop-live\.mjs$/,
    /^research\/ai-plan\/live\/guard\.test\.mjs$/,
];

const buf = fs.readFileSync(dumpFile);
const outChunks = [];
let i = 0;
let blobs = 0, commits = 0, dropped = 0, redacted = 0;

/* 当前 commit 内，最近一个 `M <mode> <dataref> <path>` 的路径。
   如果这个路径要删，我们要跳过对应的 blob —— 但 fast-export 已经单独输出了 blob
   段落。所以必须记 `blob → mark`，然后在 commit 里判断该 mark 要不要引用。

   更简单稳妥的做法：**先扫一遍**找出"只被要删的路径引用"的 blob mark，
   过滤时把这些 blob 段落整体丢掉。但更简单的是：**保留所有 blob**（体积无关紧要，
   git gc 会回收），只删 commit 里的 `M ... <path>` 行。
   这样不会出现悬空 mark，且实现简单、不易出错。代价是仓库里多几个未引用的 blob，
   下次 gc 就清了 —— 而它们**不在任何 ref 的历史里**，所以拿不到。 */

/* 因为 data 段落可能有二进制，不能简单 split。改成分块扫描。 */
outChunks.length = 0;
i = 0;
const N = buf.length;
const push = (s) => outChunks.push(Buffer.isBuffer(s) ? s : Buffer.from(s, "latin1"));

while (i < N) {
    /* 找当前行的结尾。
       ⚠️ 仓库里有 CRLF 文件，所以行尾可能是 `\r\n`。
       第一版只找 `\n` 然后把行内容（含 `\r`）交给正则 —— `data (\d+)$` 因为
       尾部有 `\r` 而**匹配失败**，于是把所有 data 块当普通行逐行 push，
       二进制内容被 latin1 拆散 ⇒ fast-import 报 `unsupported command: 机验证报告…`。
       现在：先找 `\n`，再把紧邻的 `\r` 剥掉做匹配；push 时原样保留到 `\n`。
       而 `data <n>` 的体按**字节数**跳过（不受行尾影响）。 */
    let nl = buf.indexOf(10, i);
    if (nl < 0) nl = N;
    let contentEnd = nl;
    if (contentEnd > i && buf[contentEnd - 1] === 13) contentEnd -= 1;   // 剥 \r
    const line = buf.toString("latin1", i, contentEnd);

    /* `data <n>` 后面跟 n 字节原样内容 */
    const dm = /^data (\d+)$/.exec(line);
    if (dm) {
        const len = Number(dm[1]);
        const bodyStart = nl + 1;
        const bodyEnd = bodyStart + len;
        const body = buf.subarray(bodyStart, bodyEnd);

        /* ★ 必须在**这里**做替换，不能事后再全局替换 ★
         *
         * 这是我犯的第 7 个错误，也是最危险的一个：
         * 一开始我把"删文件"在流里做，"替换密钥"留到最后对整块 Buffer 做一次
         * `indexOf` 循环。那样字节数变了，而上面的 `data <n>` 还是旧值 ——
         * 整个流的结构从此错位，fast-import 读到的"内容"是别人的尾巴，
         * 报出 `unsupported command: 机验证报告…` 这种莫名其妙的错。
         *
         * 正确做法：在 data 块内部替换，同时**重写 `<n>`**。
         * 这样长度恒等于实际内容，流结构不会坏。 */
        const bodyStr = body.toString("latin1");
        const patched = bodyStr.includes(KEY) ? bodyStr.split(KEY).join(REPLACEMENT) : null;
        if (patched !== null) {
            redacted += bodyStr.split(KEY).length - 1;
            const nb = Buffer.from(patched, "latin1");
            push(Buffer.from(`data ${nb.length}`, "latin1"));
            push(buf.subarray(contentEnd, bodyStart));      // 行尾（\r\n 或 \n）
            push(nb);
        } else {
            push(buf.subarray(i, bodyStart));               // 头部原样（含行尾）
            push(body);
        }
        i = bodyEnd;
        /* fast-export 在 data 之后可能有一个换行（\r\n 或 \n） */
        if (buf[i] === 13) { push(buf.subarray(i, i + 1)); i += 1; }
        if (buf[i] === 10) { push(buf.subarray(i, i + 1)); i += 1; }
        continue;
    }

    if (line === "blob") { blobs++; push(buf.subarray(i, nl + 1)); i = nl + 1; continue; }
    if (line.startsWith("commit ")) { commits++; push(buf.subarray(i, nl + 1)); i = nl + 1; continue; }

    /* `M <mode> <dataref> <path>` —— 要删的路径整行去掉 */
    const mm = /^M (\d+) (\S+) (.+)$/.exec(line);
    if (mm) {
        const p = mm[3];
        if (ENTRIES.some(re => re.test(p))) {
            dropped++;
            i = nl + 1;
            continue;
        }
    }

    /* `D <path>` 同理（删除操作，保留无害，但一并清掉更干净） */
    const dm2 = /^D (.+)$/.exec(line);
    if (dm2 && ENTRIES.some(re => re.test(dm2[1]))) { i = nl + 1; continue; }

    push(buf.subarray(i, nl + 1));
    i = nl + 1;
}

console.log(`   blob ${blobs} / commit ${commits} / 删掉的文件引用 ${dropped}`);

/* ── 3. 收尾 ───────────────────────────────────────────────────────────── */
/* 密钥替换已经在 ② 的 data 块里做掉了（那里能同步改 `<n>`）。
   这里只做拼接 —— **绝不**再对整块 Buffer 做一次全局替换，
   因为那会改变字节数而让所有 `data <n>` 失效（第 7 个错误）。 */
const finalBuf = Buffer.concat(outChunks);
console.log(`   替换密钥字面量 ${redacted} 处`);

const cleanFile = path.join(TMP, "clean.fi");
fs.writeFileSync(cleanFile, finalBuf);

/* ── 4. fast-import 到**临时命名空间** ────────────────────────────────── */
/* ⚠️ 不直接覆盖 main：`fast-import --force` 会无条件改写 ref，
   万一过滤逻辑有 bug，`main` 就废了。
   这里先把流里的 `refs/heads/X` / `refs/tags/X` 重命名到 `refs/scrub/...`，
   导入后可以**慢慢验证**，确认无误再由调用方 `git update-ref` 切换。
   验证失败就 `git update-ref -d refs/scrub/...` 扔掉，原样无损。 */
console.log("② 重命名 ref 到临时命名空间 …");
{
    /* ⚠️ 必须用 **latin1** 逐字节编解码，不能碰 utf8。
       第一版我 `finalBuf.toString("latin1")` 改完再 `Buffer.from(text,"latin1")`
       —— 理论上无损，但 `split("\n")` 之后逐行拼接时，中文的 UTF-8 多字节序列
       被切在行边界上就会损坏（实测报 `unsupported command: 机验证报告…`）。
       这里改成：先在 latin1 视图上做**正则替换**（不 split、不重组行），
       每条规则只改 ASCII 部分，多字节序列原样保留。 */
    const text = finalBuf.toString("latin1")
        .replace(/(^|\n)commit refs\/heads\//g, "$1commit refs/scrub/heads/")
        .replace(/(^|\n)commit refs\/tags\//g, "$1commit refs/scrub/tags/")
        .replace(/(^|\n)reset refs\/heads\//g, "$1reset refs/scrub/heads/")
        .replace(/(^|\n)reset refs\/tags\//g, "$1reset refs/scrub/tags/")
        .replace(/(^|\n)tag refs\/tags\//g, "$1tag refs/scrub/tags/")
        .replace(/(^|\n)from refs\/heads\//g, "$1from refs/scrub/heads/")
        .replace(/(^|\n)merge refs\/heads\//g, "$1merge refs/scrub/heads/");
    fs.writeFileSync(cleanFile, Buffer.from(text, "latin1"));
}

console.log("③ fast-import …");
{
    const input = fs.openSync(cleanFile, "r");
    try {
        execFileSync("git", [
            "fast-import", "--force", "--quiet",
            "--export-marks=" + path.join(TMP, "marks.txt"),
        ], { stdio: [input, "inherit", "inherit"] });
    } finally {
        fs.closeSync(input);
    }
}

console.log("\n④ 结果（refs/scrub/*）：");
execFileSync("git", ["for-each-ref",
    "--format=%(refname) %(objectname:short) %(subject)", "refs/scrub/"], { stdio: "inherit" });

console.log("\n接下来由调用方验证：");
console.log("  git grep -c '<KEY>' refs/scrub/heads/main   # 应为空");
console.log("  git rev-list --count refs/scrub/heads/main  # 应等于原提交数");
console.log("确认后：");
console.log("  git update-ref refs/heads/main $(git rev-parse refs/scrub/heads/main)");
console.log("  然后 git update-ref -d 掉 refs/scrub/*");
