/**
 * 精确 Fisher 精确检验（2×2，双侧）+ Wilson 区间。
 *
 * ⚠️ 这个文件存在的原因：我第一版手写的 fisher() 参数化错了
 * （`d2 = c - (a-i)`，而固定边缘下应是 `d = d - (a - i)` 的等价形式），
 * 于是 24/50 vs 15/50 报出 p=0.94 —— 明显荒谬。统计量算错比结论错更危险，
 * 因为它不会崩、只会安静地给出一个"没有差异"的假象。
 *
 * 现在按定义实现：固定行/列边缘，枚举 cell(1,1) 的所有可能值，
 * 用超几何分布求每个表的概率，双侧 = 概率 ≤ 观测表概率的所有表之和。
 */
import fs from "node:fs";

/** log(n!) —— 用 log 避免 50! 溢出 */
const LF = (() => {
    const t = [0];
    for (let i = 1; i <= 4000; i++) t[i] = t[i - 1] + Math.log(i);
    return t;
})();
const lfact = n => LF[n];

/** 超几何概率：固定边缘 r1,r2,c1,c2 下，cell(1,1)=i 的表出现的概率 */
function hyper(i, r1, c1, n) {
    return Math.exp(
        lfact(r1) + lfact(n - r1) + lfact(c1) + lfact(n - c1)
        - lfact(n) - lfact(i) - lfact(r1 - i) - lfact(c1 - i) - lfact(n - r1 - c1 + i)
    );
}

/** 双侧 Fisher：[[a,b],[c,d]]（a=ON 感兴趣数, b=ON 其余, c=OFF 感兴趣数, d=OFF 其余） */
export function fisher2x2(a, b, c, d) {
    const n = a + b + c + d;
    const r1 = a + b, c1 = a + c;
    const lo = Math.max(0, r1 + c1 - n);
    const hi = Math.min(r1, c1);
    const pObs = hyper(a, r1, c1, n);
    let p = 0;
    for (let i = lo; i <= hi; i++) {
        const pi = hyper(i, r1, c1, n);
        if (pi <= pObs * (1 + 1e-9)) p += pi;
    }
    return Math.min(1, p);
}

export function wilson(k, n, z = 1.96) {
    if (!n) return [0, 0];
    const p = k / n;
    const den = 1 + z * z / n;
    const ctr = p + z * z / (2 * n);
    const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [Math.max(0, (ctr - m) / den), Math.min(1, (ctr + m) / den)];
}

/* ── 自检：拿已知答案验一遍（不通过就别信下面的数） ── */
const KNOWN = [
    /* [a,b,c,d] , 期望 p（双侧 Fisher 的教科书值） */
    [[3, 1, 1, 3], 0.4857],
    [[1, 9, 11, 3], 0.0028],
    /* 33% vs 43%，本来就没差异 ⇒ p 该大。第一版我把这条的期望写成 0.0012，
       那是**期望值写错**（把"数字看着大"当成"差异大"），不是实现错。
       留着这条并写清理由：自检自己也会骗人。 */
    [[10, 20, 30, 40], "large"],
    /* 真极端：40% vs 80%，n=50 ⇒ p 应很小 */
    [[20, 5, 5, 20], 0.0003],
    [[24, 26, 15, 35], 0.1],      // 本轮的真实表：p 应落在 0.05~0.15 附近
];
if (process.argv[1] && process.argv[1].endsWith("stats.mjs")) {
    console.log("Fisher 自检：");
    for (const [t, want] of KNOWN) {
        const got = fisher2x2(...t);
        const ok = typeof want === "string" ? got > 0.2
            : want === 0.1 ? (got > 0.03 && got < 0.25)
                : Math.abs(got - want) < 0.002;
        const note = typeof want === "string" ? " (期望 >0.2)"
            : want === 0.1 ? " (期望 0.03~0.25)" : ` (期望 ${want})`;
        console.log(`  ${ok ? "OK  " : "FAIL"} [[${t}]] → ${got.toFixed(4)}${note}`);
    }
    /* 对称性自检：交换两行不应改变 p（双侧性质） */
    const p1 = fisher2x2(24, 26, 15, 35), p2 = fisher2x2(15, 35, 24, 26);
    console.log(`  ${Math.abs(p1 - p2) < 1e-9 ? "OK  " : "FAIL"} 行交换对称 ${p1.toFixed(6)} vs ${p2.toFixed(6)}`);

    /* ── 正式报告 ── */
    const r = JSON.parse(fs.readFileSync(".tmpverify/when-ab/results.json", "utf8")).filter(x => x.parse_ok);
    const A = r.filter(x => x.arm === "ON"), B = r.filter(x => x.arm === "OFF");
    console.log(`\n数据：${r.length} 条（ON ${A.length} / OFF ${B.length}）\n`);

    const MACROS = ["connect", "insert_machine", "replace_run", "remove_run", "trash_unused", "remove_machine", "extend_line"];
    console.log("=== 计划级（该轮计划里出现过该宏）===");
    console.log("宏".padEnd(15) + "  ON".padEnd(22) + "  OFF".padEnd(22) + "  Fisher p");
    for (const m of MACROS) {
        const ka = A.filter(x => x.macros.includes(m)).length;
        const kb = B.filter(x => x.macros.includes(m)).length;
        const p = fisher2x2(ka, A.length - ka, kb, B.length - kb);
        const mark = p < 0.05 ? " ★显著" : "";
        console.log(
            m.padEnd(15)
            + `  ${String(ka).padStart(2)}/${A.length} [${wilson(ka, A.length).map(v => v.toFixed(2)).join(",")}]`.padEnd(22)
            + `  ${String(kb).padStart(2)}/${B.length} [${wilson(kb, B.length).map(v => v.toFixed(2)).join(",")}]`.padEnd(22)
            + `  ${p.toFixed(4)}${mark}`
        );
    }

    /* 预注册主指标 H1（remove_run 占比）单独报，附"我们能测出多大差异" */
    const ka = A.filter(x => x.hasRemoveRun).length, kb = B.filter(x => x.hasRemoveRun).length;
    console.log(`\n=== 预注册主指标 H1: remove_run 占比 ===`);
    console.log(`  ON ${ka}/${A.length} = ${(100 * ka / A.length).toFixed(1)}%   OFF ${kb}/${B.length} = ${(100 * kb / B.length).toFixed(1)}%`);
    console.log(`  差 ${(100 * (ka / A.length - kb / B.length)).toFixed(1)} 个百分点   Fisher p = ${fisher2x2(ka, A.length - ka, kb, B.length - kb).toFixed(4)}`);

    /* 事后探索指标（必须标注为事后） */
    console.log(`\n=== 事后探索：措辞框架 ===`);
    for (const [nm, re] of [
        ["dead-end / 死路 / 悬空", /dead.?end|死路|悬空/i],
        ["backpressure / 回堵 / 堵死", /backpressure|back.pressure|jam|回堵|堵死|堆死/i],
        ["conservative / 保守", /conservat|保守|最安全|least invasive/i],
    ]) {
        const xa = A.filter(x => re.test(x.text || "")).length;
        const xb = B.filter(x => re.test(x.text || "")).length;
        let ha = 0, ca = 0, hb = 0, cb = 0;
        for (const x of A) { const t = x.text || ""; ca += t.length; ha += (t.match(new RegExp(re.source, "gi")) || []).length; }
        for (const x of B) { const t = x.text || ""; cb += t.length; hb += (t.match(new RegExp(re.source, "gi")) || []).length; }
        console.log(
            `  ${nm.padEnd(26)} ON ${String(xa).padStart(2)}/${A.length}  OFF ${String(xb).padStart(2)}/${B.length}`
            + `  p=${fisher2x2(xa, A.length - xa, xb, B.length - xb).toFixed(4)}`
            + `  归一化 ${(1000 * ha / ca).toFixed(2)} vs ${(1000 * hb / cb).toFixed(2)} /千字符`
        );
    }

    console.log(`\n=== 事后探索：计划规模 ===`);
    const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
    const sdv = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
    const xa = A.map(x => x.macros.length), xb = B.map(x => x.macros.length);
    const se = Math.sqrt(sdv(xa) ** 2 / xa.length + sdv(xb) ** 2 / xb.length);
    const d = mean(xa) - mean(xb);
    console.log(`  每次计划 call 数 ON ${mean(xa).toFixed(3)} (sd ${sdv(xa).toFixed(3)})  OFF ${mean(xb).toFixed(3)} (sd ${sdv(xb).toFixed(3)})`);
    console.log(`  差 ${d.toFixed(3)}  95%CI [${(d - 1.96 * se).toFixed(3)}, ${(d + 1.96 * se).toFixed(3)}]  Welch t=${(d / se).toFixed(2)}`);

    /* 可检测效应量：若真实差异为 10 个百分点（remove_run），n=50 能否测出？ */
    const base = kb / B.length;
    const p10 = base + 0.10;
    const ncp = Math.abs(p10 - base) * Math.sqrt(A.length) / Math.sqrt(base * (1 - base) + p10 * (1 - p10));
    console.log(`\n=== 灵敏度 ===`);
    console.log(`  以 OFF 臂基率 ${(100 * base).toFixed(1)}% 计，n=${A.length}/臂 只能测出 ≥${(100 * (p10 - base)).toFixed(0)} 个百分点的绝对差（约）`);
}
