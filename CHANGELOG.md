# Changelog

本项目：**shapez-ai-bridge** —— 把 [shapez.io](https://shapez.io) 变成一个可用程序驱动的工厂：单文件官方 mod + 零依赖本地桥 + MCP 服务器 + 一个会自我纠正的 agent 循环。

> **仓库**：<https://github.com/sqkl520/shapez-ai-bridge> ｜ **版本**：`0.1.0-SNAPSHOT`

格式参照 [Keep a Changelog](https://keepachangelog.com/)。项目尚未正式发版，各段以**工作阶段/里程碑**划分，并标注对应的 git commit 范围与记录文档。

> **★ 硬规则（项目约定）**：**任何代码/配置/文档的更改，都必须记入本 CHANGELOG**
> （在最上方的 `[Unreleased]` 段按 Added/Changed/Fixed/Removed/Notes 分类追加）。
> 版本号规则：当前为 `0.1.0-SNAPSHOT`；**待「能自动从零建成一条产线并交付进 hub」后才标 `1.0.0`**。
> **本文件只记「改了什么」**；经验 / 方法论 / 踩坑写进 `research/ai-plan/`，不要写在这里。

---

## [Unreleased]

（空。下一阶段从这里开始。）

---

## [0.1.0-SNAPSHOT] - 2026-11-09

首次公开发布。此前 272 个提交在本地累积，本版把它们整理成一份干净的历史。

### Added — 闭环 agent（`src/agent/loop/`）

这是本版的主体：一个会自我纠正的 agent 循环，而不是「调一次 LLM 然后祈祷」。

- **七个宏 + 句柄寻址**（`src/agent/macros/`）：`connect` / `insert_machine` /
  `replace_run` / `remove_run` / `remove_machine` / `trash_unused` / `extend_line`。
  模型用句柄（`B12` / `M3` / `C1`）指代对象，**人类坐标在解析层就被拒** ——
  计划里不可能出现模型自己编的位置。
- **整轮原子**：一轮里所有调用进同一个 `tx`。任何一条失败，整轮在写盘前被拒。
- **净效果分档**（`health.mjs`）：每轮结束后世界健康度的增量被机器判成
  `positive` / `constructive` / `cleanup` / `regressive` / `churn` / `inert` 六档。
  **这是代码算的，不是模型自评的。**
- **自动回滚**（`rollback.mjs` + mod 四个 checkpoint RPC）：连续两轮 `regressive`
  触发真回滚。还原后自校验 uid 集合与逐格几何。
- **跨 run 记忆**（`memory.mjs`）：尝试按 `(目标形状, 世界)` 双分组，下次 run
  作为 `## PRIOR ATTEMPTS` 喂回去。合并按硬度 —— `regressive` 不被 `inert` 覆盖。
- **关卡变更检测**（`obsolete.mjs`）：hub 升级时重读目标、识别作废的线，
  且「拆掉它们」只在升级那一轮被认可。
- **删除冗余度**（`redundancy.mjs`）：回答「这个世界有多少条带子删了不伤任何下游」。
- **V-health 判据**（`verify.mjs`）：判定层第一次能说「这一步把世界改坏了」，
  而不只是「计划落地了没有」。

### Added — 布局编译器（`src/ai/`）

- 给一个目标形状，离线规划出一条能交付的产线，输出 SZBP1 蓝图。
- 全链路无游戏依赖：配方求解 → 离线资源图（世界是 `map.seed` 的纯函数）→
  行布局 → 带回转的带子路由 → 十项校验 → 蓝图。
- `--hub` 必填。没钉住 hub 的编译报 `hub:unpinned` 失败，而不是给一个
  把货送到空地的「成功」。

### Changed — 仓库整理

- `.gitignore` 补上 `.tmpverify/`、`research/ai-plan/runs/`、`research/ai-plan/tmp/`、
  `nul`（写作时误产生的 Windows 设备名文件）。
- A/B 装置迁到 `research/ai-plan/ab/{when,consequence}/`，输出走各自目录下的
  `out/`，路径按文件位置算而不依赖 cwd。

### Security

- **移除了误提交进历史的 API 密钥。** 该密钥只在本地提交里出现过，从未推送到公开仓。
  清洗走 `scripts/scrub-fast.mjs`（fast-export/fast-import 流式过滤，13 秒），
  同时删掉了 5 个本就不该进仓的临时脚本。
- A/B 装置改为从 `ANTHROPIC_API_KEY` 环境变量读密钥，不再内置。

### Notes — 这一阶段最重要的三条结论

写在 CHANGELOG 里，是因为它们改变了我们对代码的判断。

**1. 「模型不愿删」从来不是缺陷 —— 前提就错了。**

连续三轮实验（P14 `$ore` 提示、P17 卡片 `when:`、P18 后果可见）都在优化
「怎么让模型多用 `remove_run`」，全部证伪。最后做了一件本该第一个做的事：
数一数每个世界里有多少带子是可以安全删的。

```
世界                    带子数   可安全单删    会断东西
L4 夹具                  161        0          161
L5 真机基线              158        0          158
L11 成熟世界             2107      265 (12.6%) 1842
```

**L4/L5 是零冗余世界：每一条带子都是某条链的必要环节。**
在那里删任何一条都是错的 —— 模型拒绝裸 `remove_run` **是对的**。
我把它读成了缺陷，拿一个不适用的指标做了三轮实验。

教训：**先测清楚「正确行为在数据里长什么样」，再去测「模型有没有做到」。**

**2. 一个值「被算出来」和「被送到决策者眼前」是两件事。**

`would-disconnect` 从 P4 就有、`rv-drift` 从 P5 就有，一次都没进过 prompt ——
只躺在 transcript 里。`grep warnings prompt.mjs` 之前是零结果。
同类问题还有：宏卡片 7 个里 6 个只有「别用它」没有「什么时候用」。

**3. 本机的 git 写操作约 1 秒/次，任何 O(提交数) 的重写都不可接受。**

历史清洗试了五版才成：filter-branch tree-filter（2 分钟/提交）、
index-filter（30 秒/提交）、手写解析 tree 二进制（**静默失败**，报"完成"而密钥还在）、
逐提交 ls-tree（10+ 分钟卡住）…… 最后 `fast-export`/`fast-import`
流式过滤 13 秒解决。前五版的失败原因写在 `scripts/scrub-fast.mjs` 文件头。

---

## 版本历史

| 版本 | 日期 | 内容 |
|---|---|---|
| `0.1.0-SNAPSHOT` | 2026-11-09 | 首次公开发布：闭环 agent、布局编译器、自动回滚、跨 run 记忆、健康度度量 |

## 尚未达成

- **自动从零建成一条产线并交付进 hub。** 目前 `Cu----Cu` 曾在真机上抵达 65%
  （[`research/ai-plan/P7-GOAL-ACHIEVED.md`](research/ai-plan/P7-GOAL-ACHIEVED.md)），
  阶段 2 的验收（[`PHASE2-ACCEPTANCE.md`](research/ai-plan/PHASE2-ACCEPTANCE.md)）
  尚未通过。这是 `1.0.0` 的门槛。
- **跨 run 记忆、关卡变更检测、`connect` 自动放宽**只在离线验证过，
  未在真机上端到端跑过（见 [`research/ai-plan/P16-LIVE-VERIFICATION.md`](research/ai-plan/P16-LIVE-VERIFICATION.md) §7）。
- **产能提升**（用户最初抱怨的「明明有可以快捷提高产能的方法却没有用」）
  尚未动。按 P18 的结论，这才是 level 4/5 该做的事。
