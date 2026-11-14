/**
 * 第二步补丁：把无头驱动接进 init() 和 RPC 分派。
 */
import fs from "node:fs";
import path from "node:path";

const MOD = path.join(process.env.APPDATA, "shapez.io", "mods", "shapez-ai-bridge.js");
let src = fs.readFileSync(MOD, "utf8");

let changed = 0;

/* ① init() 里自动装（在 raf 看门狗之后）*/
const INIT_ANCHOR = `        this.installRafWatchdog();
        this.installLogCapture();`;
if (src.includes(INIT_ANCHOR) && !src.includes("this.installHeadlessDriver();")) {
    src = src.replace(INIT_ANCHOR, `        this.installRafWatchdog();
        /* ★ 无头驱动紧跟在看门狗后面装 ★
         *
         * 看门狗解决「加载链等不到帧」，无头驱动解决「运行中 rAF 被节流」。
         * 两者是互补的：看门狗只补初始化那几帧，运行期间的死锁要靠这个。
         * 真机实测（2026-11-14）就是运行中死锁：status 能回、obs/act 全卡、
         * 10 秒 tick 前进 0。 */
        this.installHeadlessDriver();
        this.installLogCapture();`);
    changed++;
}

/* ② RPC 分派：加 headless 两个 op */
const RPC_ANCHOR = `                case "debug_frame_alive":
                    result = await this.debugFrameAlive(params || {});
                    break;`;
if (src.includes(RPC_ANCHOR) && !src.includes(`case "headless_status":`)) {
    src = src.replace(RPC_ANCHOR, `                case "debug_frame_alive":
                    result = await this.debugFrameAlive(params || {});
                    break;
                /* 无头驱动：查询状态 / 强制接管。
                   force:true 用于无头批处理 —— 不管窗口可不可见都接管。 */
                case "headless_status":
                    result = this.headlessStats();
                    break;
                case "headless_enable":
                    result = this.installHeadlessDriver({
                        force: params && params.force === true,
                        staleMs: params && Number.isInteger(params.staleMs) ? params.staleMs : undefined,
                    });
                    break;`);
    changed++;
}

fs.writeFileSync(MOD, src);
console.log(`已改 ${changed} 处`);
