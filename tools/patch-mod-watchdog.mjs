/**
 * 第三步补丁：增强 rAF 看门狗。
 *
 * 现在的看门狗只按 document.hidden 决定宽限（可见 400ms / 不可见 120ms）。
 * 问题是真正的死锁场景是「可见但 rAF 被节流」—— 那时 document.hidden 是 false，
 * 走 400ms 分支，等于把游戏压到 2.5fps，看起来像卡死。
 *
 * 增强点：加一个「主动判活」的探针 —— 独立跑一个 rAF 哨兵，
 * 记录它最近一次兑现的时间；graceMs() 改成按「哨兵多久没动」自适应。
 */
import fs from "node:fs";
import path from "node:path";

const MOD = path.join(process.env.APPDATA, "shapez.io", "mods", "shapez-ai-bridge.js");
let src = fs.readFileSync(MOD, "utf8");

if (src.includes("_rafProbeAt")) {
    console.log("已经打过增强补丁，跳过。");
    process.exit(0);
}

const OLD = `        /** 拿到「浏览器多久没给帧」的判据：不可见时用更短的宽限，尽快补帧。 */
        const graceMs = () => {
            try {
                return document.hidden ? 120 : 400;
            } catch (e) {
                return 400;
            }
        };`;

const NEW = `        /** ★ 增强：主动判活，不只看 document.hidden ★
         *
         * 原判据是 \`document.hidden ? 120 : 400\`。问题：真正的死锁场景是
         * **可见但 rAF 被节流**（失焦 / 被遮挡 / GPU 降频）—— 那时
         * \`document.hidden === false\`，走 400ms 分支，等于把游戏压到 2.5fps，
         * 看起来和卡死没区别。
         *
         * 真机实测（2026-11-14）：\`status\` 能回、\`obs\`/\`act\`/\`screenshot\`
         * 全无响应，10 秒内 tick 前进 **0**。
         *
         * 增强做法：装一个独立的 rAF 哨兵，每次兑现就更新 \`_rafProbeAt\`。
         * \`graceMs\` 改成按「哨兵多久没动」自适应：
         *   · 哨兵 500ms 内动过 ⇒ 原生 rAF 健康，用长宽限（800ms，几乎不干预）
         *   · 哨兵 500ms~2s 没动 ⇒ 疑似节流，用短宽限（100ms，积极补帧）
         *   · 哨兵 2s 以上没动     ⇒ 确认死锁，用最短宽限（50ms，全力补帧）
         *
         * 这样正常运行时垫片**几乎从不触发**（800ms 的定时器在 60fps 下永远先被原生帧清掉），
         * 而在节流/死锁时能第一时间接管。 */
        this._rafProbeAt = Date.now();
        this._rafProbeInstalled = true;
        const self0 = this;
        (function probe() {
            try {
                nativeRaf(() => {
                    self0._rafProbeAt = Date.now();
                    if (self0._rafProbeInstalled) probe();
                });
            } catch (e) {
                // 原生 rAF 自己抛错 —— 那说明它彻底坏了，交给定时器兜底
            }
        })();

        /** 按「哨兵多久没动」自适应宽限。 */
        const graceMs = () => {
            const since = Date.now() - (self._rafProbeAt || Date.now());
            if (since > 2000) return 50;      // 确认死锁：全力补帧
            if (since > 500) return 100;      // 疑似节流：积极补帧
            return 800;                        // 健康：几乎不干预
        };`;

if (!src.includes(OLD)) {
    console.error("锚点没找到（graceMs 定义）");
    process.exit(1);
}
src = src.replace(OLD, NEW);
fs.writeFileSync(MOD, src);
console.log("已增强 rAF 看门狗（自适应 graceMs + 主动探活）");
