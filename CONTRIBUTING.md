[English](CONTRIBUTING-EN.md) | 简体中文

# 参与贡献

谢谢你看这个项目。流程很短，因为这里写的是**实际在用的流程**，不是模板。

## 开始之前

- **Node.js ≥ 20**（`node --version`）。
- 如果你的改动会碰到与游戏交互的部分，需要一个 **shapez.io 1.5.6 桌面版（Steam）**。
  代码库的很大一部分 —— bridge 协议、MCP server、agent 的规划层 ——
  无需运行游戏即可开发和测试。
- 没有其它依赖。本项目刻意保持**零运行时依赖**，引入依赖的 PR 需要在描述里给出充分理由。

## 跑起来

大部分代码只需要 Node，不需要游戏、不需要 bridge：

```bash
git clone https://github.com/sqkl520/shapez-ai-bridge.git
cd shapez-ai-bridge
npm test                       # 单元测试，不需要游戏
node src/bridge/selftest.mjs   # bridge 层，不需要游戏
node src/mcp/selftest.mjs      # MCP 层，不需要游戏
```

提 PR 之前跑这三个。

**冒烟测试**不一样：它是真正的端到端，需要真东西。先启动 bridge、装好 mod 打开 shapez.io、载入一个存档：

```bash
node src/bridge/bridge.mjs      # 终端 1
node scripts/smoke_test.mjs     # 终端 2，等游戏进入世界后
```

如果打印 `SMOKE TEST PASSED (5/5)`，说明五层都通了。退出码会告诉你是哪一层缺：
`1` bridge 没在跑，`2` bridge 在跑但没有游戏连上、或游戏还停在菜单，`3` 其它检查失败。
它会在 hub 附近放一条带子再删掉，以证明写入可用，跑完世界保持原样。

这个测试没法造假 —— 它的全部意义就是真跑一遍游戏。
需要不依赖游戏的测试，用上面的 `npm test`。

## 运行测试

```bash
# src/agent 下的全部（最大的测试面）
node --test src/agent/

# 迭代时只跑一个文件
node --test src/agent/loop/handles.test.mjs

# bridge 和 MCP server 各有自测
node src/bridge/selftest.mjs
node src/mcp/selftest.mjs
```

有些测试需要真机连接，bridge 上没有 mod 时会跳过。**跳过的测试不等于通过的测试** ——
不要为了让套件变绿而删掉 skip。

## 做一次改动

1. **开分支。** 即使你是唯一维护者，也在分支上工作并开 PR。
   `type/short-description`，例如 `fix/belt-handoff-direction`。
2. **保持 diff 聚焦。** 一个 PR 一件事。发现无关的问题就开 issue，不要顺手改掉。
3. **测试跟着改动走，不是之后补。** 修缺陷就补一条**没有这次修复就会红**的回归测试。
   如果某条测试是建立在错误假设上的，改写它，并在注释里写清旧的假设是什么 —— 而不是删掉。
4. **commit message** 用 `type(scope): summary`，说清**为什么**要这么改。
   使用中的 type：`feat`、`fix`、`docs`、`test`、`refactor`、`perf`、`chore`。
5. **同一次提交里更新文档** —— 改了行为、配置或公开接口就要同步。见下面的清单。

## 评审会看什么

- 这次改动说清了「为什么需要」吗，还是只说了「做了什么」？
- 行为变了的话，有测试能在它退化时抓住吗？
- 如果改动来自一次真实的失败观察，注释里记录了可观察到的症状吗
  （日志说了什么、世界长什么样），好让下一个人不必重新发现一遍？
- **新算出来的输出，真的送到模型眼前了吗？** 一个值算完在渲染前被丢掉，
  是这个仓库里最高频的缺陷类型。

## 隐私与仓库卫生

这是公开仓库。提交之前：

- **不要提交密钥、token。** 用环境变量。`.gitignore` 已经拦了 `.env` 一类文件，不要 `-f` 强推。
- **不要提交真实用户数据。** 示例存档、路径、主机名一律编造
  （`example.com`、`*.test`、`<repo>`、`<user-home>`）。
- **不要出现你本机的绝对路径**，代码、测试、文档都一样。
- **不要提交运行产物。** 日志、`.pid`、run transcript、构建输出都已被忽略，别把它们加进索引。

## 代码布局

| 路径 | 里面是什么 |
| --- | --- |
| `src/mod/` | 单文件游戏 mod（运行在 shapez.io 的渲染进程里） |
| `src/bridge/` | 本机 Node bridge：WebSocket + HTTP + RPC |
| `src/mcp/` | 把 bridge 暴露成工具的 MCP server |
| `src/agent/` | 参考 agent：规划循环、宏、验证 |
| `gui/` | 本机安装向导与面板 |
| `docs/` | 设计笔记与 GUI 走查 |
| `research/` | 调研笔记；不属于发布的工具本体 |

`src/agent/` 是最大也最精细的一块。`loop/` 目录下是规划循环、诊断层和验证器；
`macros/` 下是改世界的原语。动那里之前先读 `src/agent/loop.mjs` 的文件头注释 ——
它记录了若干个「为什么不那么做」的决定。

## 报告缺陷

用 bug report 模板。真正有帮助的信息：

- shapez.io 版本与操作系统，
- Node 版本，
- 你实际跑的命令，
- 期望发生什么、实际发生了什么，
- 如果涉及 agent：run 目录里的 `transcript.jsonl`，请先抹掉个人信息路径。

## 安全问题

不要开公开 issue。见 [SECURITY.md](SECURITY.md)。