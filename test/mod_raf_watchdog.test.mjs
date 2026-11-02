/**
 * `installRafWatchdog()` —— 加载链卡死的根因修复。
 *
 * ## 为什么必须有这个测试
 *
 * 真机上 `load_save` 会永久卡在「状态切到 InGameState，root 永远为空」，
 * `ingame_stage` 停在 `""`。三次实测都只能重启游戏。根因查证结果：
 *
 *   `states/ingame.js:onEnter()` 的加载链第一环是
 *       `asyncChannel.watch(waitNextFrame()).then(() => this.stage3CreateCore())`
 *   `core/utils.js:296` 的 `waitNextFrame()` 是**两层 `requestAnimationFrame`**。
 *
 * Chromium 在窗口不可见时把 rAF 掐到 0Hz（不是变慢，是彻底不派发）。
 * 于是 stage 永远停在构造函数的 `""`，且**已经挂死的 rAF 回调不会被补发** ——
 * 这解释了为什么恢复窗口（已实测：窗口从 0x0 修到 1400x900 且可见）救不回来。
 *
 * 所以修复在 mod 侧：给 rAF 装垫片，超时未兑现就用 `setTimeout` 补帧。
 * 本测试用假时钟在 Node 里复现「rAF 停了」和「rAF 正常」两种环境，钉住行为。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.resolve(__dirname, "../src/mod/shapez-ai-bridge.js"), "utf8");

let pass = 0, fail = 0;
const tasks = [];
const check = (name, fn) => { tasks.push({ name, fn }); };
async function runAll() {
    for (const t of tasks) {
        try { await t.fn(); pass++; console.log("PASS", t.name); }
        catch (e) { fail++; console.log("FAIL", t.name, "->", e && e.message); }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
}
const assert = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };

/**
 * 只抽出 `installRafWatchdog` 方法体来跑，不加载整个 mod
 * （整个 mod 依赖 shapez 运行时，那是另一个测试的事）。
 */
function extractMethod(name) {
    // 用行首锚定，避免命中 JSDoc 里的 `installRafWatchdog()` 字样
    const re = new RegExp(`^    ${name}\\(\\) \\{$`, "m");
    const m = re.exec(src);
    assert(m, `method ${name} not found`);
    const start = m.index;
    // 从方法头往后找「缩进 4 空格的右花括号」当作方法结束
    const endMarker = "\n    }\n";
    const end = src.indexOf(endMarker, start);
    assert(end > start, `method ${name} end not found`);
    return src.slice(start, end + endMarker.length);
}

/**
 * 造一个受控环境：手动控制 rAF 是否兑现，手动推进 setTimeout。
 */
function makeEnv({ rafWorks, hidden }) {
    const timers = [];
    let timerSeq = 1;
    let rafSeq = 1;
    const pendingRaf = new Map();
    const errors = [];

    const sandbox = {
        console: {
            log: () => {},
            warn: () => {},
            error: e => errors.push(e),
        },
        performance: { now: () => 1000 },
        document: {
            get hidden() { return hidden; },
        },
        setTimeout: (fn, ms) => {
            const id = timerSeq++;
            timers.push({ id, fn, ms, at: ms });
            return id;
        },
        clearTimeout: id => {
            const i = timers.findIndex(t => t.id === id);
            if (i >= 0) timers.splice(i, 1);
        },
        requestAnimationFrame: fn => {
            const id = rafSeq++;
            if (rafWorks) pendingRaf.set(id, fn);
            // rafWorks=false 时**照收不回调** —— 精确模拟 Chromium 掐掉 rAF
            return id;
        },
        cancelAnimationFrame: id => { pendingRaf.delete(id); },
    };
    sandbox.window = sandbox;
    const ctx = vm.createContext(sandbox);

    // 把方法体包成一个可调用的函数，`this` 由调用方给。
    // 方法体形如 `installRafWatchdog() { ... }`，只能挂在对象字面量上才是合法 JS。
    const body = extractMethod("installRafWatchdog");
    const factory = vm.runInContext(
        `(function(){ return ({ ${body} }).installRafWatchdog; })();`,
        ctx
    );

    const self = {
        _rafStats: null,
        log: () => {},
        warn: () => {},
        error: (...a) => errors.push(a.join(" ")),
    };
    factory.call(self);

    return {
        self,
        sandbox,
        errors,
        /** 兑现所有排队的原生 rAF 回调 */
        flushRaf: () => {
            const cbs = [...pendingRaf.values()];
            pendingRaf.clear();
            for (const cb of cbs) cb(performance.now());
        },
        /** 跑所有到期的 setTimeout 回调 */
        flushTimers: () => {
            const due = timers.splice(0, timers.length);
            for (const t of due) t.fn();
        },
        pendingRafCount: () => pendingRaf.size,
        /**
         * 取走「已在派发中」的原生回调，但**不**把它们从浏览器那边取消掉。
         * 用来模拟 `cancelAnimationFrame` 来不及生效的真实竞争。
         */
        takeRafCallbacks: () => [...pendingRaf.values()],
    };
}

/* ── R1：正常可见时，原生 rAF 兑现 ⇒ 垫片不该抢跑 ── */
check("R1 原生 rAF 正常时不重复回调（once 闸门）", () => {
    const env = makeEnv({ rafWorks: true, hidden: false });
    let calls = 0;
    env.sandbox.requestAnimationFrame(() => { calls++; });
    env.flushRaf();                 // 原生兑现
    env.flushTimers();              // 再让兜底定时器到期
    assert(calls === 1, `期望回调 1 次，实际 ${calls} 次（垫片重复执行了）`);
    assert(env.self._rafStats.native === 1, `native 计数应为 1，实际 ${env.self._rafStats.native}`);
    assert(env.self._rafStats.fallback === 0, `fallback 不该触发，实际 ${env.self._rafStats.fallback}`);
});

/* ── R2：★ 核心 ★ rAF 停了（窗口不可见）⇒ 垫片必须补上 ── */
check("R2 rAF 被掐停时用定时器补帧（这正是加载链卡死的场景）", () => {
    const env = makeEnv({ rafWorks: false, hidden: true });
    let calls = 0;
    env.sandbox.requestAnimationFrame(() => { calls++; });
    assert(calls === 0, "前置条件：无补帧时不该有人调用");
    env.flushTimers();              // 兜底定时器到期
    assert(calls === 1, `期望垫片补 1 次，实际 ${calls} 次`);
    assert(env.self._rafStats.fallback === 1, `fallback 应为 1，实际 ${env.self._rafStats.fallback}`);
});

/* ── R3：双重 waitNextFrame（两层嵌套 rAF）在 rAF 停摆时能否走完 ── */
check("R3 两层嵌套 rAF 在 rAF 停摆时仍能推进到底", () => {
    const env = makeEnv({ rafWorks: false, hidden: true });
    // 复刻 core/utils.js:296 waitNextFrame() 的结构
    let reached = false;
    const waitNextFrame = () => new Promise(resolve => {
        env.sandbox.requestAnimationFrame(() => {
            env.sandbox.requestAnimationFrame(() => resolve());
        });
    });
    waitNextFrame().then(() => { reached = true; });
    // 跑三轮：外层补帧 → 内层注册 → 内层补帧 → resolve
    for (let i = 0; i < 3; i++) env.flushTimers();
    // Promise 决议是微任务，用同步排空
    return Promise.resolve().then(() => {
        assert(reached, "两层 rAF 没有走完 —— 这正是 onEnter 卡在 stage 空串的机制");
    });
});

/* ── R4：不可见时宽限更短（不可见 120ms vs 可见 400ms） ── */
check("R4 不可见时宽限期更短，尽快补帧", () => {
    const hiddenEnv = makeEnv({ rafWorks: false, hidden: true });
    hiddenEnv.sandbox.requestAnimationFrame(() => {});
    const hiddenMs = hiddenEnv.sandbox.__lastTimerMs;
    // 直接检查注册时的 ms：重新取一遍
    const e1 = makeEnv({ rafWorks: false, hidden: true });
    let captured1 = null;
    const origST1 = e1.sandbox.setTimeout;
    e1.sandbox.setTimeout = (fn, ms) => { captured1 = ms; return origST1(fn, ms); };
    e1.sandbox.requestAnimationFrame(() => {});

    const e2 = makeEnv({ rafWorks: false, hidden: false });
    let captured2 = null;
    const origST2 = e2.sandbox.setTimeout;
    e2.sandbox.setTimeout = (fn, ms) => { captured2 = ms; return origST2(fn, ms); };
    e2.sandbox.requestAnimationFrame(() => {});

    assert(captured1 === 120, `不可见时宽限应为 120ms，实际 ${captured1}`);
    assert(captured2 === 400, `可见时宽限应为 400ms，实际 ${captured2}`);
});

/* ── R5：幂等 —— 重复 install 不套娃 ── */
check("R5 重复 install 不会套多层垫片", () => {
    const env = makeEnv({ rafWorks: false, hidden: true });
    const wrapped = env.sandbox.requestAnimationFrame;
    // 第二次 install 应直接返回
    const body = extractMethod("installRafWatchdog");
    const factory = vm.runInContext(
        `(function(){ return ({ ${body} }).installRafWatchdog; })();`,
        vm.createContext(env.sandbox));

    factory.call(env.self);
    assert(env.sandbox.requestAnimationFrame === wrapped, "重复 install 又包了一层");
});

/* ── R6：回调抛错不能打断垫片，且要记到 console.error ── */
check("R6 回调抛错被捕获，不影响后续帧", () => {
    const env = makeEnv({ rafWorks: false, hidden: true });
    let second = 0;
    env.sandbox.requestAnimationFrame(() => { throw new Error("boom"); });
    env.flushTimers();
    assert(env.errors.length >= 1, "回调抛错应被 console.error 记录");
    // 后续帧仍正常
    env.sandbox.requestAnimationFrame(() => { second++; });
    env.flushTimers();
    assert(second === 1, "前一帧抛错后，后续帧应仍能执行");
});

/* ── R8：★ 关键竞争 ★ 兜底先到、原生帧后到 —— once 闸门必须挡住第二次 ──
 *
 * 这是真实会发生的顺序：rAF 被节流但没完全停（比如从 60Hz 掉到 1Hz），
 * 兜底定时器先到期补了帧；随后那个**迟到的原生帧**仍然会回调。
 * 没有 once 闸门的话，同一个 waitNextFrame() 的 callback 会执行两次 ——
 * 加载链会被推进两步，状态机直接乱掉（这是比卡死更难查的错）。
 *
 * ⚠️ 必须用 `flushRafIgnoringCancel()` 而不是 `flushRaf()`：
 * 正常路径下 `fire("fallback")` 会先 `cancelAnimationFrame`，浏览器就不会再
 * 回调那个原生帧 —— 那种情况下即使没有 once 闸门也看不出问题（这就是
 * 第一版 R8 抓不到 M1 变异的原因）。真实世界的危险场景是 **cancel 来不及
 * 生效**：浏览器已经在派发这一帧了，`cancelAnimationFrame` 对它无效。
 * 所以这里要绕过 cancel 记录，直接调用那些已经"在途"的回调。
 */
check("R8 兜底先触发后，迟到的原生帧不得重复回调", () => {
    const env = makeEnv({ rafWorks: true, hidden: true });
    let calls = 0;
    env.sandbox.requestAnimationFrame(() => { calls++; });
    const inFlight = env.takeRafCallbacks();   // 抓住"已经在派发中"的回调
    env.flushTimers();                          // 兜底先到
    assert(calls === 1, `兜底应补 1 次，实际 ${calls}`);
    // 迟到的原生帧：cancel 已经来不及了，浏览器照常调用它
    for (const cb of inFlight) cb(performance.now());
    assert(calls === 1, `once 闸门失效：迟到原生帧让回调执行了 ${calls} 次（应为 1）`);
    assert(env.self._rafStats.fallback === 1, `fallback 应为 1，实际 ${env.self._rafStats.fallback}`);
    assert(env.self._rafStats.native === 0, `迟到帧不该被计为 native 执行，实际 ${env.self._rafStats.native}`);
});

/* ── R9：兜底触发后要主动 cancel 掉原生注册，别让它白占队列 ── */
check("R9 兜底触发时取消原生注册", () => {
    const env = makeEnv({ rafWorks: true, hidden: true });
    env.sandbox.requestAnimationFrame(() => {});
    assert(env.pendingRafCount() === 1, "前置条件：应有一个待兑现的原生帧");
    env.flushTimers();
    assert(env.pendingRafCount() === 0, `兜底后原生注册应被取消，实际仍有 ${env.pendingRafCount()} 个`);
});

check("R7 已执行过的帧不会被补帧重复触发", () => {
    const env = makeEnv({ rafWorks: true, hidden: false });
    let calls = 0;
    env.sandbox.requestAnimationFrame(() => { calls++; });
    env.flushRaf();
    // 再手动把兜底定时器也跑掉 —— once 闸门必须挡住
    env.flushTimers();
    assert(calls === 1, `once 闸门失效，回调执行了 ${calls} 次`);
});

runAll();

