# 方向 B 调研：怎么给 LLM 设计工具接口

> 调研日期 2026-10-28。所有论断标注 **[搜到]**（有 URL）或 **[推断]**（基于搜到材料的推理）。
> 篇幅受限，取舍见文末「没查到的」。

---

## 0. 一句话结论

对我们这个项目，最有实证支撑的三条改动是：**(a) 把「算坐标」从 LLM 手里拿走**（PAL/CodeAct 路线），
**(b) 加宏动作层**（SkillsBench +16.6pp、Voyager 技能库、CodeAct +20%），
**(c) 验证器必须用游戏运行时当 oracle**（我们已经在 `gates.mjs` 里独立撞到了同一条教训）。

---

## 1. 接口设计原则（每条附实证）

### 1.1 工具是「确定性系统 ↔ 非确定性 agent」之间的契约，要按 agent 的用法设计

Anthropic《Writing effective tools for agents》：*"Tools are a new kind of software which reflects a
contract between deterministic systems and non-deterministic agents… instead of writing tools the way
we'd write functions for other developers, we need to design them for agents."*
[搜到] https://www.anthropic.com/engineering/writing-tools-for-agents

同文给出一条可操作的验收标准：**agent 的反馈可以骗你，但要读原始 transcript**——
*"what agents omit in their feedback can often be more important than what they include. LLMs don't
always say what they mean."* [搜到] 同上

### 1.2 描述比 schema 重要；复杂参数用 examples 兜

Anthropic API 文档：*"Provide extremely detailed descriptions. **This is by far the most important
factor in tool performance.**"* 要求写清「做什么 / 何时用 / 何时不该用 / 每个参数含义 / 已知限制」，
建议每个工具 3–4 句。 [搜到]
https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools

工程侧的最强证据：*"Claude Sonnet 3.5 achieved state-of-the-art performance on the SWE-bench
Verified evaluation after we made precise refinements to tool descriptions, dramatically reducing
error rates and improving task completion."* [搜到]
https://www.anthropic.com/engineering/writing-tools-for-agents

`input_examples` 的实测：**复杂参数处理准确率 72% → 90%**。 [搜到]
https://www.anthropic.com/engineering/advanced-tool-use

> 对我们的含义：`place(x,y,building,r,rotationVariant)` 现在只有一句「放一个建筑」+ 错误码指向
> `docs/PROTOCOL.md §5`。这违反了「描述自足」原则——模型看到的是 schema，不是那份 md。

### 1.3 错误必须可执行（recoverable vs unrecoverable）

Anthropic 文档原文：*"Write instructive error messages. Instead of generic errors such as `"failed"`,
include what went wrong and what Claude should try next (for example, `"Rate limit exceeded. Retry
after 60 seconds."`)"*，并给出行为学观察：*"If a tool request is invalid or missing parameters, Claude
will retry 2–3 times with corrections before apologizing."* [搜到]
https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls

《Writing effective tools》把这条落成机制：错误响应要 *"clearly communicate specific and actionable
improvements, rather than opaque error codes or tracebacks"*，并明说这能*steer agents towards more
token-efficient tool-use behaviors*。 [搜到] 同 1.1

**实测现状（我数了代码）**：`src/mod/shapez-ai-bridge.js` 里 `rpcError(...)` 调用 **121 处，带 hint
参数的只有 9 处**（约 7%）。绝大多数是 `2001 invalid_action` + 一句 detail。
桥接层 `bridge.mjs` 稍好，但同样是少数带 hint。

### 1.4 响应只回高信号；token 效率是硬约束

同一篇：返回 *"only high signal information"*，避免 `uuid`/`mime_type` 这类低层标识；
用 `response_format: concise|detailed` 枚举让 agent 自选粒度（示例中 concise 只用 ⅓ token）。
[搜到] 同 1.1

上下文侧的独立证据：Anthropic《Effective context engineering》提出 **context rot**——
*"as the number of tokens in the context window increases, the model's ability to accurately recall
information from that context decreases"*，并给出「attention budget」框架，结论是找
*"the smallest set of high-signal tokens"*。 [搜到]
https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

**实测数据（我量的）**：`live-L4-obs.json` 30,290 bytes ≈ **8.4K tokens**，181 实体，
**平均 117 bytes/实体**。每个实体带 `variant`/`rotation_variant`/`code`/`layer` 四个冗余字段
（`layer` 在顶层已有一份）。180 实体的存档，每次「看一眼」≈ 8K token；
10 次观测 = 一个 80K 的上下文就没了。**「每次都要全量拉」在我们这个规模上已经是真问题**，
不是理论问题。

### 1.5 状态管理：全量 vs 增量 vs 摘要——有实测，且反直觉

**《The Complexity Trap》**（arXiv:2508.21433，SWE-bench Verified，5 种模型配置）：
简单的 **observation masking**（丢弃旧观测）**成本减半**，解出率**持平甚至略高**于 LLM 摘要；
混合方案再省 7%/11%。结论是质疑「纯 LLM 摘要」的趋势。 [搜到] https://arxiv.org/abs/2508.21433

> 对我们的含义：不需要上「让 LLM 总结工厂状态」这种复杂管线。**直接把 obs 做裁剪 + 分页 +
> 让模型按需查局部**，性价比更高。这与 code execution 那篇的「progressive disclosure」同向。

### 1.6 长任务：靠外部状态文件，不靠模型记忆

Anthropic《Effective harnesses for long-running agents》记录了两个失败模式：
*"the agent tended to try to do too much at once—essentially to attempt to one-shot"*，
以及 *"a later agent instance would look around, see that progress had been made, and declare the
job done"*。解法是 **JSON 特性清单（初始全标 failing）+ progress 文件 + git 历史**，并特别注明
*"we landed on using JSON for this, as the model is less likely to inappropriately change or
overwrite JSON files compared to Markdown files."* [搜到]
https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents

最相关的一条：*"Claude's tendency to mark a feature as complete without proper testing… would fail
to recognize that the feature didn't work end-to-end"*；给了浏览器工具做端到端验证后
*"dramatically improved performance"*。 [搜到] 同上

---

## 2. 「少而强 vs 多而细」的证据汇总

### 2.1 官方明确主张「合并」

Anthropic API 文档：*"**Consolidate related operations into fewer tools.** Rather than creating a
separate tool for every action (`create_pr`, `review_pr`, `merge_pr`), group them into a single tool
with an `action` parameter. Fewer, more capable tools reduce selection ambiguity and make your tool
surface easier for Claude to navigate."* [搜到]
https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools

《Writing effective tools》：*"More tools don't always lead to better outcomes."* 给出的反模式正是
**「照着现有 API 端点包一层」**。它建议把 `list_users`+`list_events`+`create_event` 合成
`schedule_event`；把 `get_customer_by_id`+`list_transactions`+`list_notes` 合成
`get_customer_context`。理由是「在工具内部完成的多步，省掉的是本来要经过上下文的中转输出」。
[搜到] 同 1.1

### 2.2 工具数量增长的代价是量化的

- Tool Search Tool：50+ 工具 upfront **~72K token** → 按需加载 **~8.7K**（−85%）；
  同时 Opus 4 在 MCP 评测上 **49% → 74%**，Opus 4.5 **79.5% → 88.1%**。 [搜到]
  https://www.anthropic.com/engineering/advanced-tool-use
- 什么时候该上这套：官方建议 **>20 个工具**再考虑 tool search。 [搜到]
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context
- 误差随调用链累积：MCP agent 的 distortion 呈**线性增长**，偏差上界 O(√T)（T = 顺序调用数）。
  [搜到] https://arxiv.org/abs/2602.13320

> 注意：我们只有 8 个 MCP 工具，**远没到需要 tool search 的量级**。这条对我们不是「该减工具」，
> 而是「别急着加」。

### 2.3 「让模型写代码调 API」确实更可靠

- **CodeAct**（17 个 LLM，API-Bank + 新 benchmark）：用可执行 Python 作为统一动作空间，
  比 JSON/text 工具调用**成功率高至多 20%**。 [搜到] https://arxiv.org/abs/2402.01030
- **PAL**：LLM 只负责把问题分解成程序，**求解交给解释器**；论文明确指出失败常常是
  *"LLMs often make logical and arithmetic mistakes in the solution part, **even when the problem is
  decomposed correctly**"*。 [搜到] https://arxiv.org/abs/2211.10435
- **Programmatic tool calling**（Anthropic 官方）：BrowseComp / DeepSearchQA 上
  **性能 +11%，输入 token −24%**；复杂研究任务 token 43,588 → 27,297（−37%）。
  [搜到] https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling
- **Code execution with MCP**：Drive→Salesforce 场景 **150,000 → 2,000 token（−98.7%）**。
  [搜到] https://www.anthropic.com/engineering/code-execution-with-mcp

### 2.4 结论（区分证据强度）

| 论断 | 强度 |
|---|---|
| 「合并相关操作为少量强工具」 | **强**：两家官方文档明确写，且有 tool-search 的数字旁证 |
| 「让模型写代码而不是逐个调工具」 | **强**：CodeAct +20%、PTC +11%/−24% token、MCP code exec −98.7% |
| 「工具越多越差」的具体阈值 | **弱**：官方说 >20 才需要 tool search；没有干净的 #tools→accuracy 曲线 |

---

## 3. 宏动作在游戏 AI 里的先例

### 3.1 Voyager（Minecraft）——最直接的先例

技能库存的是**可执行代码**而非低层动作，*"temporally extended, interpretable, and compositional"*；
配合「环境反馈 + 执行错误 + 自验证」的迭代提示。相对 SOTA：**独特物品 3.3×、探索距离 2.3×、
解锁关键技术树快 15.3×**。 [搜到] https://arxiv.org/abs/2305.16291

### 3.2 SkillsBench——宏/技能层的定量收益

87 任务 / 8 领域 / 18 种模型-框架配置，配对评测：
**通过率 33.9% → 50.5%（+16.6pp，归一化 +25.5%）**。
且 *"**Focused Skills with at most three modules outperform larger or exhaustive bundles**"*，
以及「小模型 + Skills 可以追平大模型不加 Skills」。 [搜到] https://arxiv.org/abs/2602.12670

> 这条对我们极重要：**宏要小而聚焦，不要搞一个大而全的「建产线」宏**。

### 3.3 程序性知识 / HTN

手写 HTN 可让 20B/70B 模型**超过 120B 基线**；LLM 自造 HTN 也有提升但更小。
[搜到] https://arxiv.org/abs/2511.07568
SoK 把「skill」定义为 *"callable modules that package procedural knowledge with explicit
applicability conditions, execution policies, termination criteria, and reusable interfaces"*，
明确区别于 *"one-off plans or atomic tool calls"*。 [搜到] https://arxiv.org/abs/2602.20867

### 3.4 分层：规划与执行分开

Plan-and-Act：*"separating high-level planning from low-level execution"* 是长任务成功的关键。
[搜到] https://arxiv.org/abs/2503.09572
Cradle（GCC）：高层规划后**输出可执行代码**做低层键鼠控制。 [搜到] https://arxiv.org/abs/2403.03186

### 3.5 反向证据：坐标/空间推理确实不可靠

- 《Stuck in the Matrix》：网格任务随规模增大，**平均掉 42.7%，最高 84%**；
  *"every test that began with over 50% accuracy showed a loss of at least 48%"*。
  [搜到] https://arxiv.org/abs/2510.20198
- PPNL：LLM 在二值可行性问题上尚可，**长时程空间规划明显退化**。 [搜到] https://arxiv.org/abs/2310.03249
- GPT-4 路径规划：**把 prompt 写成 Python 代码、并分解长轨迹，能提升**；但仍拿不到最优解。
  [搜到] https://arxiv.org/abs/2406.12000
- WorldSense：**仅 3 个物体就开始出错**，且有很重的回答偏置。 [搜到] https://arxiv.org/abs/2311.15930

---

## 4. 验证：业界怎么让 agent 自己判断做对了

### 4.1 核心结论：自验证基本无效，外部验证才有效

- 《On the Self-Verification Limitations of LLMs》：*"**significant performance collapse with
  self-critique and significant performance gains with sound external verification**"*；
  且「仅用可靠验证器重新提示」就能拿到大部分收益。 [搜到] https://arxiv.org/abs/2402.08115
- 《LLMs Cannot Self-Correct Reasoning Yet》：无外部反馈的 intrinsic self-correction
  **不提升、有时反而变差**。 [搜到] https://arxiv.org/abs/2310.01798
- 《LLMs cannot find reasoning errors, but can correct them given the error location》：
  瓶颈在**发现错误**，不在修复。 [搜到] https://arxiv.org/abs/2311.08516
- 生成器-验证器 gap（RankAlign）：模型「生成」和「验证同一答案」不一致，是结构性缺陷。
  [搜到] https://arxiv.org/abs/2504.11381

### 4.2 「验证器不能拿生成器的输出当期望值」——我们自己的实例

`src/agent/gates.mjs` 头注释：

> 「判据必须来自游戏运行时，不能来自编译器自己……用那个模拟器去验编译器的产物，等于让同一套
> 假设自我确认：'方向反了'在编译器的表示里是**不动点**，模拟器会说'一切正常'。
> 实测就是这么发生的 —— 108/108、0 销毁、drift=[]，而线是死的。」

以及 G2'/G7/G8 的设计说明：*"只有 G8 能在『intent 与 blueprint 都自洽但都错』时变红"*。

这与学术结论**独立吻合**，是本项目最健康的资产。M3 红队还自己发现「8 道闸共享编译器 oracle
会集体假绿」并砍到 5 道——这正是 4.1 那条教训的工程化。

### 4.3 什么时候「生成器+验证器」是自欺欺人

判据可以写成一句话：**验证器的判据集合与生成器的假设集合有交集，交集内的错误永远抓不到。**
[推断，但被 4.1 的三篇 + 我们的 G4 事故共同支撑]

有效的形态是：验证器只能读**环境真实输出**（游戏 uid、游戏产量统计、游戏 path 邻接），
不能读编译器的中间表示。

---

## 5. 对我们工具面的具体批判

当前面（实际代码 `src/mcp/server.mjs`，8 个工具）：
`shapez_status / shapez_observe / shapez_action / shapez_batch / shapez_screenshot /
shapez_blueprint / shapez_save / shapez_load`
其中 `shapez_action` 是 **14 个 op 挤在一个 enum 里**。

### 5.1 反模式（逐条）

**A. `place{x,y,r,rotationVariant}` 是给编译器的 ABI，不是给 LLM 的 API。**
这是最严重的一条。证据不在外部，在我们自己的
`research/ai-plan/REDTEAM-E-DIRECTION.md`：

> 「**让 LLM 算坐标**的直接成本」：L4 的 43 实体方案被独立审查抓出两处致命几何错误
> （13 个实体朝向全反 + 入口格错一格）。
> 「第一批工具是 `connect(from,to)`、`insert_cutter(at,half)`、`extend_line(...)`、
> `replace_belt_run(...)`——内部算坐标。LLM 只选动作和参数。现在的
> `place{x,y,r,rotationVariant}` 是给编译器用的 ABI，不该是给 LLM 的 API。」

外部佐证：PAL/CodeAct（2.3）+ 空间推理掉 42.7%（3.5）。**结论：不是「LLM 需要更好的提示」，
是「这个动作粒度不该暴露给 LLM」。**

**B. `shapez_action` 的 op 枚举违反「参数名要自解释」。**
`{op:"place", r: 90, variant:"default", rotationVariant: 1}` 里 `r` 和 `rotationVariant`
语义重叠且就我们项目自己踩过坑（`r=90` 仍得到 code=1 直带 —— AI-CONTROL-STATUS.md §2）。
Anthropic 的 poka-yoke 原则：*"Change the arguments so that it is harder to make mistakes."*
以及 SWE-bench 实例——把相对路径改成必须绝对路径后 *"the model used this method flawlessly"*。
[搜到] https://www.anthropic.com/engineering/building-effective-agents

**C. 读接口是全量快照，且没有「按需下钻」的入口。**
`observe()` 的代码注释自己写着 `chunk 增量留给后续优化；先保证正确性`。
MCP 层只暴露了 `shapez_observe`——`production` / `debug_items` / `world_info`
这些**已经在 mod 里实现**的方法，MCP 客户端根本调不到（我核对了 `server.mjs` 的 8 个
`case "shapez_*"`，没有一个转发它们）。`resources` 是半个例外：`include_resources:true` 能拿到
**扁平且被 `maxResources` 截断**的 `[[x,y,shape],...]`，而 mod 里那个**已聚合的 `count/bbox/runs`
版本（`observeResources`）调不到**——恰恰是「一行有几格可并排」这种规划要用的形态拿不到。

结果是：模型只能用 8.4K token 的全量快照去回答「这条线通不通」，而正确答案在 `debug_items`
的 `boundAcceptor` 字段里。

**D. 错误 hint 覆盖率 7%（9/121）。**
违反 1.3。且失败模式不对称：**「静默成功」比「报错」更危险**——
`docs/PROTOCOL.md` 自己记录了 `paste_blueprint` 落在既有 belt 上是**静默销毁替换**
（`live/results/belt-silent-overwrite.json`）。这条已经有 `dry_run`，但 `dry_run` 是
「调用方必须记得用」，属于把成本转嫁给 LLM——正是 REDTEAM-E 批评的那句
「README 只说 paste 前要 dry_run，等于把这一步的代价转嫁给调用方」。

**E. `shapez_batch` 的失败语义对 LLM 不友好。**
我核对了 `performBatch`：普通失败（2001/2002）**继续执行后续动作**，只有 1003/1004 才 `break`；
而 `break` 之后，**未执行的动作用户根本看不到**——`results` 里只是少了尾巴，没有
`not_executed` 标记。模型看到 `results.length < actions.length` 却不知道该推断什么。
Anthropic 的 browser/computer-use 文档给的规范相反：**batch 遇错即停，后续每个调用都回
`is_error: true` + 固定文本 "Not executed: an earlier action in this turn failed."** [搜到]
https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
我们现在既不 halt（对 2001/2002），也不显式标记未执行项。

### 5.2 改造建议（可落地，按性价比排序）

**P0 — 加一层宏动作 MCP 工具，`place` 降级为内部原语。**
建议先做 4 个（遵循 SkillsBench 的「≤3 个模块、小而聚焦」）：

```
shapez_connect(from:[x,y], to:[x,y], building="belt")
    → 内部：轴对齐展开 + 转角判定 + rv 计算 + 逐格 place + 落地自证
    → 返回：{ok, cells_planned, cells_placed, first_mismatch:{x,y,requested,actual}|null}
shapez_build_machine(at:[x,y], machine:"cutter"|"painter"|"stacker"|"mixer",
                     facing:"N"|"E"|"S"|"W", variant?)
    → 内部：查 op-templates 的槽位表，算出输入/输出格并 place
shapez_build_line(goal:{shape, rate}, site:[x,y])
    → 内部：直接调 research/ai-plan/harness 的 compilePlan()，返回 blueprint + validator
shapez_replace_run(region, building)
```

`place` 保留，但在描述里写明 **"Low-level primitive. Prefer shapez_connect /
shapez_build_machine unless you have a verified reason."**——这就是 1.2 的「何时不该用」。

**P0 — 把已有的读接口接到 MCP。**
`production`、`debug_items`、`world_info`、`observeResources`（聚合版）四个已经在 mod 里实现且实测过，
接出去的成本是改 `server.mjs` 的 switch。收益：模型不必用 8.4K 的全量 obs 回答
「产量够不够」「这条带堵没堵」。这直接对应 1.4 / 1.5。

**P1 — obs 加 `response_format: concise|detailed`，concise 去掉冗余字段。**
实测每实体 117 bytes，其中 `variant`/`rotation_variant`/`code`/`layer` 对「看清工厂布局」
几乎无用。concise 模式只留 `{uid,type,x,y,r}` ≈ 60 bytes。**预计 −45%**，量级与官方
concise 示例（⅓ token）同向。 [推断，基于我量的字段冗余度]

**P1 — 错误 hint 从 7% 提到接近 100%，且 hint 必须是「下一步动作」。**
不是 `"Allowed: a, b, c"` 这种枚举，而是
`"位置 (3,4) 已被 belt(uid=10042) 占用。若要覆盖请用 shapez_replace_run；若只是想连过去，用 shapez_connect(from=[2,4], to=[5,4])"`。

**P1 — `shapez_batch` 改成 fail-fast + 整体意图回报。**
返回 `{ok, applied, failed_at, results, not_executed:[...]}`。

**P2 — 验证走 `gates.mjs`，且强制用游戏 oracle。**
把 `src/agent/gates.mjs` 的 G4/G6/G7 包成 `shapez_verify(plan_id)`，由**服务端**在
`build_line` 之后自动跑，而不是让 LLM 自己判断。依据：4.1 的三篇 + 4.2 我们自己的事故。

### 5.3 明确不建议做的

- **不要上 tool search / 动态工具发现**：8 个工具，官方阈值是 >20。
- **不要让 LLM 直接算 `place` 的 x/y**：见 5.1A。
- **不要做「一个大而全的 build_factory 宏」**：SkillsBench 明确说 focused（≤3 模块）
  优于 exhaustive bundles。
- **不要用 LLM 摘要做状态压缩**：2508.21433 说 masking 更便宜且不差。

---

## 6. 没查到的 / 证据薄弱处（诚实标注）

1. **没有一个干净的「#tools → 准确率」受控曲线**。BFCL 测的是参数正确性，不是工具数量效应。
   我引用的 49%→74% 是「有/无 tool search」的对比，不是连续曲线。
2. **游戏 AI 里「宏动作 vs 原语」的直接 A/B**：Voyager 是技能库 vs 无技能库的端到端对比，
   但没有「同一个任务，40 次 place vs 1 次 build_line」的对照实验。这块只有间接证据。
3. **「错误里带修复建议」的实证**：官方文档是**规范性建议 + 行为学观察**（模型会重试 2–3 次），
   我没有找到量化「带 hint 的错误 vs 不带」的对照研究。
4. **CodeAct +20% 是否可迁移到「有副作用的写操作」**：CodeAct 主要在 API-Bank（读多写少）。
   游戏里的写操作不可回滚，迁移性存疑。 [推断]
