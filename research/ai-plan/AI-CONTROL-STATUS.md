# AI 操控能力：当前状态（2026-10-27）

方向转变：**不专注通关，专注让 AI 更好地操控 shapez。**

---

## 这一轮修好的（都有实测证据）

### 1. 加载假成功 —— 反复「只能重启进程」的根因

**根因查实**：`core/state_manager.js:58`

```js
moveToState(key, payload = {}) {
    if (window.APP_ERROR_OCCURED) {
        console.warn("Skipping state transition because of application crash");
        return;        // ← 静默返回
    }
```

游戏崩过一次后这个标志被置真，**之后所有状态切换都被静默跳过**。
`states/ingame.js:431` 的 `onRender` 也直接 return，所以 world 永远建不起来。

**修法**：判据从「状态名是 InGameState」改成「`this.root` 非空」——
root 只由 `gameStarted` 信号注入，是 world 真的建好的唯一权威判据。

**新增** `debug_app_state` RPC，超时时报出根因并区分：
- `APP_ERROR_OCCURED=true` ⇒ 重试无用，必须重启进程
- 没崩但 root 不来 ⇒ 加载卡住，可以重试

实测：`state=InGameState stage=s10_gameRunning root=true crashed=false`

### 2. `place` 支持显式 rotationVariant

之前 `place` 放不出指定转角（实测 `r=90` 仍然得到 code=1 直带），
因为 rv 由游戏按邻居自动算且只在放置那一刻算一次。

现在 `place` 接受 `rotationVariant`/`rv`，按建筑校验合法档位，返回自证：

```json
{ "requested": {"rotation":90,"rotationVariant":1},
  "actual":    {"rotation":90,"rotationVariant":1,"code":2},
  "mismatch":  false }
```

非法值报 2001 并列出允许值。

### 3. 并发写操作不再丢

之前只有 `load_save`/`new_game` 串行化，其余写操作各自独立执行。
并发发多个会丢 —— 返回 `ok:true` 但实体没建出来。

现在所有会改世界的 RPC 走同一条 `worldChain`。

实测：并发 12 个 `place` → 成功 12、失败 0、读回 12/12。

### 4. 截图从「截窗口」变成「按区域离屏渲染」

自建 canvas + 自建 DrawParameters，不调 `root.hud.draw`，
`region` 直接指定 bbox，相机瞬移不需要等，窗口不可见也不影响。
`hideHubPanel` 可跳过烘焙进 hub 贴图的面板。

---

## 还没解决的

| # | 短板 | 影响 |
|---|---|---|
| 1 | **没有事务/撤销** | AI 不敢做实验 —— 现在只能撤销「新增」，删/改撤不回来 |
| 2 | **28 种建筑只覆盖 12 种** | storage/filter/logic_gate/wire 全没有几何真值，AI 造不出高级工厂 |
| 3 | 观测是拉取式 | 每步全量拉 180 实体，没有「只告诉我变了什么」 |
| 4 | 错误信息不带可执行下一步 | 「这格被谁占、能不能删」要调用方自己再查 |

### 关于 #1 事务/撤销

游戏**没有 undo 系统**（搜遍源码无 `undo`）。现在的回滚是
「记 before 快照 → 按 uid 删回去」，局限：
- 只能撤销新增
- 跨多个 RPC 没原子性
- 回滚本身可能失败

这是**决定 AI 敢不敢做实验**的关键。没有它，AI 每次大改都要先人工备份存档。

### 关于 #2 建筑覆盖

```
覆盖：balancer belt cutter hub miner mixer painter rotater stacker trash underground_belt
缺：  storage filter transistor logic_gate comparator constant_producer constant_signal
       display lever reader analyzer virtual_processor wire wire_tunnel block
```

按对 AI 的价值排：

| 建筑 | 价值 | 为什么 |
|---|---|---|
| storage | 高 | 缓冲/吞吐整形，「等货」逻辑必需 |
| filter | 高 | 按形状分流，多目标工厂的基础 |
| transistor/logic_gate/comparator | 中高 | 逻辑网络，自适应工厂 |
| wire/constant_producer/lever | 中 | 信号网络，动态控制 |
| display/reader/analyzer | 中 | 读状态、做反馈 |

缺几何真值意味着布局编译器和 gates 都不知道它们存在。

---

## 一个被纠正的概念错误

我一直以为切割机两个输出槽各出一半。**错。**

`systems/item_processor.js:367-389` 的 `process_CUTTER` 是「输入一件、输出两件」，
**每个槽的速率等于输入速率**。实测印证：`RuRu---- 0.367/s` 与 `----RuRu 0.367/s` 相同。

所以产能估算要改：一台 0.4/s 矿机喂切割机，两个槽各出 0.4/s，
70 个目标约 175 秒而不是 350 秒。

这类错误的共同点：**用直觉上的守恒代替读源码**。

---

## 测试状态

```
mod 自测        40 通过（原 28）
rpc 自测        12 通过
gates 自测     193 通过
```
