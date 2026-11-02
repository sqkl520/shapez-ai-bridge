# P0 修复：真机复原卡死 —— 根因是 rAF，不是窗口

> 2026-11-03。这一轮修掉了 `PARTIAL-ON-FINAL.md` 里记的 P0 阻塞。
> **结论：卡死与窗口尺寸/遮挡无关，是 Chromium 在窗口不可见时掐停
> `requestAnimationFrame`，而 shapez 的整个加载链完全依赖它。**

---

## 一、根因（源码定死，不是推测）

真机现象（三次复现）：

```json
{
  "state_key": "InGameState",
  "ingame_stage": "",          ← 停在构造函数初值
  "root_present": false,
  "page_visible": false,
  "loading_overlay_attached": true
}
```

`load_save` 回 `ok:true`，但世界永远建不起来。恢复窗口（`ShowWindow(SW_RESTORE)`、
置顶、改尺寸、最大化）全都救不回来 —— **这是最反直觉的一点，也是此前所有的
恢复尝试都没用的原因**。

### 链条

1. `states/ingame.js:onEnter()` 最后一行：

   ```js
   this.asyncChannel
       .watch(waitNextFrame())
       .then(() => this.stage3CreateCore())
   ```

   **加载链的第一环就是等一帧。**

2. `core/utils.js:296-304` 的 `waitNextFrame()` 是**两层嵌套的
   `requestAnimationFrame`**：

   ```js
   export function waitNextFrame() {
       return new Promise(function (resolve) {
           window.requestAnimationFrame(function () {
               window.requestAnimationFrame(function () {
                   resolve();
               });
           });
       });
   }
   ```

3. `core/state_manager.js:119` 的 `moveToState()` 里也有一处 `waitNextFrame()`。

4. `this.stage` 的初值是 `""`（`states/ingame.js:64`）。`stage3CreateCore()`
   不被调用，它就永远停在 `""`。

### 为什么窗口恢复了也没用

Chromium 在窗口**最小化 / 判定不可见**时把 rAF 从 60Hz **掐到 0Hz**
（不是变慢，是根本不派发）。而 **rAF 不排队重放** —— 一旦某个回调在
不可见期间被跳过，把窗口恢复回来也**不会补发**。所以：

- 窗口操作能让窗口变回来 ✅
- 但那个已经挂死的 `waitNextFrame()` 永远不会兑现 ❌

这就是此前「窗口操作只能救一次」的真实原因。

### 排除的其他解释

| 假设 | 证伪 |
|---|---|
| 窗口被压成 136×39 导致 | 修到 1400×900 / 2560×1440 后仍然卡 |
| 窗口被遮挡 | 置顶、`BringWindowToTop`、`SetForegroundWindow` 全都无效 |
| `APP_ERROR_OCCURED` 崩了 | `debug_app_state` 显示 `app_error_occurred: false` |
| JS 主线程死了 | `game_analytics` 每 ~60s 打一行（web worker 心跳），且 RPC 能回包 |
| `pageVisible` 事件漏了 | `document.hidden === false`，`document.visibilityState === "visible"` |

**决定性证据**：最小化时 `native_delta=0 / fallback_delta=2`，
恢复后 `native_delta=2 / fallback_delta=0`。同一个探针，唯一变量是窗口可见性。

---

## 二、修法

在 mod 里给 `window.requestAnimationFrame` 装一层**降级垫片**
（`src/mod/shapez-ai-bridge.js` 的 `installRafWatchdog()`）：

- 照常向浏览器注册原生 rAF
- 同时挂一个 `setTimeout` 兜底：不可见时 120ms、可见时 400ms
- 谁先到用谁，`once` 闸门保证回调只执行一次
- 兜底触发时 `cancelAnimationFrame(原生 id)`，不让它白占队列

`setTimeout` **不受可见性节流**（实测最小化时仍以 ~1Hz 兑现），所以加载链
一定能推进。

### 为什么这样是安全的

- 正常可见时浏览器几乎总在宽限内回调，垫片从不触发
  （实测：已恢复窗口时 `fallback_delta = 0`）
- 不可见时游戏本来就不画（`core.js:313` 的 `shouldRender()` 会 return false），
  补帧**不会让它画**，只是让状态机前进
- 回调加了 `once` 闸门，即使原生帧迟到也不会重复执行
  （这是 R8 测试钉住的竞争）

### 新增诊断 RPC

`debug_frame_alive` —— 分别探测宏任务 / 微任务 / rAF，并用
`raf_stats_delta` 区分「浏览器正常派发」和「垫片补帧」：

```
native_delta > 0  ⇒ 浏览器在正常派发
fallback_delta > 0 ⇒ rAF 被掐停，垫片在补帧
```

没有这个 delta，`raf.fired === true` 会被误读成「rAF 正常」——
而实际上探针自己也走被包过的 rAF，垫片补的帧同样会让它 fired。

---

## 三、验证

### 单元测试（9 条，全过）

`test/mod_raf_watchdog.test.mjs`，用假时钟复现两种环境：

| 用例 | 钉住什么 |
|---|---|
| R1 | 原生 rAF 正常时不重复回调 |
| R2 | **rAF 停了 ⇒ 垫片必须补上**（核心） |
| R3 | 两层嵌套 rAF 在停摆时仍能走完（复刻 `waitNextFrame`） |
| R4 | 不可见时宽限 120ms、可见时 400ms |
| R5 | 重复 install 不套娃 |
| R6 | 回调抛错被捕获，不影响后续帧 |
| R8 | **兜底先到、原生帧迟到 ⇒ 不得重复回调** |
| R9 | 兜底触发时取消原生注册 |
| R7 | 已执行的帧不会被补帧重复触发 |

**做了 5 个变异测试，全部能被抓到**：

| 变异 | 变红的用例 |
|---|---|
| M1 去掉 `once` 闸门 | R8 |
| M2 不补帧 | R2/R3/R4/R6/R8/R9 |
| M3 去掉幂等闸门 | R5 |
| M4 宽限不区分可见性 | R4 |
| M5 兜底不取消原生 | R9 |

⚠️ R8 的第一版**抓不到 M1**：正常路径下 `fire("fallback")` 会先 cancel 掉
原生注册，浏览器就不会再回调它，所以即使没有 `once` 闸门也看不出问题。
必须用 `takeRafCallbacks()` 模拟「已经在派发中、cancel 来不及生效」的真实竞争
才能命中。这是变异测试救回来的一条。

### 真机验证

**✅ 窗口最小化时 load_save 成功**：

```
最小化 → load_save → stage="s10_gameRunning" root=true（63 实体，level 5）
```

对照数据（同一探针，唯一变量是窗口可见性）：

| 窗口状态 | native_delta | fallback_delta | 世界 |
|---|---|---|---|
| 最小化 | 0 | 2 | ✅ 正常加载 |
| 已恢复 | 2 | 0 | ✅ 正常加载 |

累计 `fallback: 112` 次 —— 修复路径确实被走到，不是空转。

---

## 四、附带发现：强杀进程会破坏存档文件

**这一轮我自己踩了一个坑，必须记下来。**

为了加载新 mod 我用了 `Stop-Process -Force` 两次。第二次正好撞上游戏
**自动存档写到一半**，结果是：

```
savegame-7c93b3dd….bin                      ← 主文件消失
savegame-7c93b3dd….bin.backup-1793640887219.7   ← 旧内容被改名到这
savegame-7c93b3dd….bin.tmp-1793640887219.7      ← 半写的新内容
```

游戏用的是「写 tmp → 改名 backup → 改名正式」的三步法。在中间态被杀，
主文件名就消失了，而 `savegames.bin` 索引仍指向它 ⇒ `load_save` 成功
但加载出一个空世界（level 1 / 1 实体）。

**恢复方法**：离线解码确认内容正确后再拷回去。

```bash
node .tmpverify/unwedge/decode-save.mjs <file> [...]
# 输出：level=5 ents=63 seed=60908
```

解码是三层（都在 `decode-save.mjs` 里照抄 upstream）：

1. `\x01` 前缀 + lz-string 的 **compressToEncodedURIComponent** 变体
   （`core/lzstring.js:83`，不是 `compressToBase64`！）
2. `JSON.stringify(compressObject(payload))` —— 键值字典压缩
3. `decompressObject` 还原（`savegame/savegame_compressor.js:135`）

⚠️ 字段路径坑：`entities` / `beltPaths` 在 `dump` **顶层**，
不在 `dump.entityMgr` 下（后者只放 `nextUid`）。

### 教训

1. **不要 `Stop-Process -Force` 一个正在跑的游戏**，尤其不确定它是否在写盘。
   正确做法：先 `save_now` 等它落盘，再退到主菜单，再关。
2. **恢复文件后要立刻 `load_save`** —— 游戏内存里的世界会周期性写盘，
   晚一步就被空世界覆盖。实测：手工恢复后不 load，`save_now` 立刻把
   空世界写回去了。
3. `list_saves` 的 `level` 来自索引，**文件丢了也照样显示正确等级** ——
   不能只看它，要解码文件本身。

---

## 五、仍未做的

- **P1**：让 `partial` 真正触发（需要「有失败 + 剩可撤销」的场景）
- **P2**：查 RECIPE 段在**真机** prompt 上的渲染（此前只离线测过）
- 真机 CONNECT 命中率仍是最大瓶颈（`calls≤3` 8/66 vs `calls≥4` 0/82）
