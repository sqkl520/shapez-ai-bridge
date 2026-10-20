# 设计决策与经验 — shapez.io AI 接口

> 这是阶段 7 的输出文档：三个关键架构决策的完整权衡、做得好的地方、可带走的经验。
> 配套阅读：`PHASE0-RECON.md`（逆向结论 Q1–Q6）、`docs/PROTOCOL.md`（协议契约）、
> `docs/LIVE-VERIFICATION.md`（实机验证结果）。

## 这是什么

shapez.io（Steam，1.5.6 @ ee2279d5）的 AI 可操作接口工具链，三层：

```
游戏内 Mod（单文件 .js，官方 mod API）      ← 把游戏世界变成可读写的 JSON 接口
    ↕ WebSocket（浏览器原生，mod 当客户端）
桥接进程（Node，零依赖）                     ← HTTP /rpc + WS /client + 快照管理
    ↕ HTTP / stdio
MCP server + 参考 Agent                     ← 任意 AI/脚本的接入点
```

## 它要解决的问题

让 AI 玩工厂游戏，瓶颈不在模型智力，而在**接口**：

1. **动作预算**：逐个放方块 = 每个工厂要几百次动作，token 和出错率都爆炸。
   把 200 次压成 1 次（蓝图/路径原语），可玩性放大 200 倍。
2. **时间语义**：工厂的反馈有延迟（传送带要跑几秒）。AI 不能靠 sleep 猜时间，
   需要可参数化的"推进 N tick"和"等到条件 X"（带超时）。
3. **观测裁剪**：世界一大（实测 1544 实体/181KB）就爆 token，必须能按区域/上限裁剪。
4. **约束可发现**：AI 的"非法动作"错误率是工具质量的镜子——如果 AI 老犯 2001，
   说明观测没把约束表达清楚，是工具的问题。

## 三个关键决策

### D1：桥接拓扑 —— 外部宿主起服务端，Mod 当 WebSocket 客户端

**约束（实测）**：渲染进程 `nodeIntegration:false` + `contextIsolation:true` + `sandbox:true`
（index-main.js:69-77），Mod **没有 Node 权限**，`require("http")` 不可能。但渲染进程是完整
Chromium、无 CSP，**原生 WebSocket 恒可用**。

- 没有它会怎样：只能在 Mod 里起服务器 → 需要 Node 权限 → 不可能，或必须做浏览器
  不支持的原生扩展。
- 为什么不用更简单的（文件/剪贴板信箱）：延迟高、易撕裂、不适合实时请求-响应。
- 代价：多一个进程要启动/守护；换来的是**游戏更新只影响 Mod 层，协议层不用动**。
  实机验证过：桥接被杀后重启，Mod 指数退避自动重连。

### D2：动作原语 —— 分层，但默认给高层

- `place`/`delete`（精细微调）之上，必需 **`place_path`**（路径铺满）、
  **`paste_blueprint`**（一次=一座工厂）、**`bulk_delete`**（区域）。
- **1.5.6 没有原生蓝图字符串格式**（全代码零调用，实测确认）——这是本项目唯一
  "发明格式"的地方。设计为 `SZBP1.` + LZString（**复用游戏自己的压缩算法**），
  且**压缩实现跨端互通有专门的测试锁定**（test/lzstring_interop.mjs 逐字节对拍）。
- 代价：蓝图只在同游戏版本内可交换（`gv` 字段硬校验，不匹配报 2006）。
  这是有意的：建筑 code 表按版本变化，跨版本静默出错比报错更糟。
- 蓝图放置按游戏规则**扣材料**（`4×n^1.1` 的精确复刻），`charge:false` 可免费（沙箱）。

### D3：确定性 —— `step(ticks)` 同步快进，而非 sleep

- **游戏自己就有先例**（puzzle 校验器：`time.performTicks` 同步跑 9000 ticks 无渲染），
  照抄即可，不需要发明。逻辑 tick 用固定 deltaSeconds → 喂多少 tick 推进多少逻辑时间。
- `await(condition, timeout)` 是必需的补充：把"等到 HUB 收货增加"变成一次调用，
  超时是结果字段（`met:false`）而不是错误。
- `step` 期间无渲染（同步阻塞），所以**文档明说会短暂冻结画面**，单次上限 20000 tick。
- 代价：破坏成就（本来装 mod 就禁成就，官方行为）/ 手感。README 明示。

## 我觉得做得好的 5 个地方

1. **实机验证抓出了所有真 bug**（8 个，见 LIVE-VERIFICATION 第四节）。
   静态审查全绿后，真机一跑就暴露 `getTileContentXY` 不存在、切割机输出堵塞等
   只有运行时才现形的问题。**"运行一次"的价值 > 读一百遍代码。**
2. **B3 的根因诊断链**：交付停在 2 → 用 `obs` + `step` 量化 → 截图直视布局 →
   对照上游源码定位"输出槽向上喷、首格带子必须朝上流"。三层证据（数据/视觉/源码）
   交汇才定死根因。截屏工具本身就是这个项目交付的观测能力之一——**用自己的工具
   调试自己**。
3. **跨实现契约的测试锁定**：mod（游戏内置 compressX64）与工具端（vendored lz-string）
   的兼容性不是"应该没问题"，而是有逐字节对拍的测试。分发场景里这种契约最容易
   悄悄腐烂。
4. **错误语义三分类贯穿到底**：2001（AI 的错，可纠正）/2002（游戏拒绝，需重规划）/
   2003（工具 bug）。HUB 拒收、位置被占都带 `hint` 指引。B3 全程 0 失败动作，
   部分归功于观测把约束表达清楚了（资源形状 vs 目标形状匹配检查）。
5. **诚实标注**：level 3+ 组合形状、非 Windows 平台、切割布局的鲁棒性边界——
   在文档里明确写"未充分覆盖"，而不是假装全部通过。

## 如果我要做类似的东西（可带走的经验）

1. **先确认"运行时能给什么"再设计协议**。这个项目 80% 的设计正确性来自阶段 0 的
   一个发现：渲染进程没有 Node 权限。如果晚发现，D1 选错会让全部代码返工。
   → 侦察阶段先跑一个"能不能拿到 X"的实验，比读十份文档有用。
2. **游戏自带的工具链是最好的老师**。切割机的槽位语义、快进的循环写法、
   传送带的拐角变体逻辑——全部是从游戏自己的源码/行为里抄的，不是发明的。
   → 找"游戏自己怎么做这件事"（puzzle 校验器 / 蓝图放置 / 批量删除），照抄它的调用形态。
3. **错误的分类决定工具的上限**。"非法动作"和"游戏拒绝"必须分开编码——前者是
   调用方的 bug（可自动纠正），后者是世界的状态（需要重新规划）。混在一起，
   AI 就学不会任何东西。
4. **格式的所有跨端行为都要有对拍测试**。蓝图字符串、存档解析、压缩算法——
   只要有两个实现，就写互通测试，否则分发出去必烂。
5. **动作原语的粒度就是可玩性的倍率器**。先问"AI 完成一个典型任务最少需要几个动作"，
   再倒推需要什么原语。蓝图粘贴把"建一座工厂"从几百动作压到 1 个。
6. **观测体积是隐藏的一等公民**。181KB 的观测对 LLM 就是 5 万 token。区域裁剪 +
   硬上限 + 明确的 `truncated` 字段，是"能玩"与"能玩得久"的分界。
7. **验证脚本要能重复跑**。"我手动验证过了"不能进 CI；`smoke_test` + 三个 bench
   脚本化后，任何一次改动都能 30 秒内确认没有回退。

## 复现指南

```bash
# 环境：Node ≥ 20；shapez.io 桌面版 1.5.6（Steam）
# 1. 安装 mod（幂等，可 -Uninstall）
powershell -ExecutionPolicy Bypass -File install.ps1    # Windows
bash install.sh                                         # macOS/Linux

# 2. 启动桥接（前台运行，零依赖）
node src/bridge/bridge.mjs

# 3. 启动游戏 → 加载任意存档

# 4. 验证（世界自动恢复原状）
node scripts/smoke_test.mjs                             # 期望 5/5 PASS

# 5. 跑基准（B3 会新建存档）
node scripts/bench_b1.mjs --new-game
node scripts/bench_b2.mjs
node scripts/bench_b3.mjs

# 6. 全部自测（98 项断言，不需要游戏）
node test/mod_selftest.mjs && node test/mod_rpc_selftest.mjs && node test/blueprint_selftest.mjs \
  && node test/lzstring_interop.mjs && node src/bridge/selftest.mjs && node src/mcp/selftest.mjs
```

工具清单：`npx @electron/asar`（解包，仅侦察）、`node`（全部运行时）、
`js-beautify`（美化 bundle，仅侦察）。侦察全部产物在 `recon/`（gitignore 排除，
版权归 tobspr Games，仅本地研究）。
