# 设计：L3 策略层 + LLM 修复循环

> 定位：`SYNTHESIS.md` 三层架构的**最上层**。与 `layout-compiler-DESIGN.md`（L2）配套——
> 本文补的是路线图 1.5（`docs/AGENT-PROMPT.md` + `play.mjs --llm` 骨架）与 3.5（LLM 修复循环）。
> 依据：`04-ai-planning-research.md`（LLM-Modulo / Code-as-Policies / Lost in the Middle / FLE 警告）、
> `facts/MILESTONE-M4-SUCCESS.md` + `MILESTONE-M4-partial-and-pitfalls.md`（布局陷阱表）、
> `facts/ROOT-CAUSE-rotationVariant-override.md`、`facts/ops-semantics-VERIFIED.md`。
>
> **核心论断（与 SYNTHESIS §0 一致）**：LLM 不做规划主体、不碰坐标、不逐动作驱动。
> 它只做两件事：**（a）在多个确定性候选间取舍；（b）在确定性层全部失败时，读结构化批评、修 DSL 程序。**

---

## 0. 一句话总览

```
目标形状 + 状态摘要 + ≤3 条库检索（输入）
        ↓  LLM（1 次调用，输出 ≤ 40 行 DSL）
   DSL 程序（目标 + 配方策略 + 选址倾向 + 并行度）
        ↓  L2 确定性编译（solver → layout → SZBP1）
   ≥1 个候选布局（每个都是合法蓝图 + 吞吐估算）
        ↓  L2 三级验证（形状 hash / 几何 / 实机 await）
   结果（PASS → 完成；FAIL → 结构化批评 JSON）
        ↓  （仅当 L2 全败或需取舍）回到 LLM，携带批评
```

**LLM 在整个"一次尝试"里被调用 0 或 1 次**（首轮策略选择 1 次；修复轮每轮 1 次，上限 3）。
确定性层（solver/layout/verify）永远是先跑的默认路径。

---

## 1. DSL 设计：LLM 到底输出什么

### 1.1 三条硬约束（来自 SYNTHESIS §1 与 04-research §5.2/§9.2）

1. **不含坐标** —— 选址由 L2 用离线资源图（`world.mjs`，3002/3002 已验证）+ 成本函数计算。
2. **不含旋转值** —— belt rotation 由路径方向派生、miner rotation 由喷射方向派生、
   拐角 rv 由 `belt.js:161` 算法离线复刻（`ops-semantics-VERIFIED.md §11`）或由蓝图显式携带（RV-FIX 已验证）。
3. **不含建筑 id / code** —— "cutHalf 之后要不要 rotate"这类**形状代数**决策由 solver 处理；
   LLM 说的是"用什么加工类目"，不是"放什么机器"。

**唯一不在这三条禁令里的表达自由度**：选择**配方策略**（等价解之间的取舍）、
**选址倾向**（哪类资源优先、是否贴近旧产线）、**并行度**（复制几条）。这正是 LLM 的用武之地：
它擅长"世界知识层面的名词选择"，不擅长空间数值。

### 1.2 语法（EBNF）

```
program        := "line" IDENT "{" option* "}"
option         := target | strategy | site | parallel | constraint | note

target         := "target:"     SHAPE_KEY          # 目标形状（含 ":" 分隔的多层，用引号包裹）
strategy       := "strategy:"   STRATEGY_NAME      # 见下表；solver 用它剪枝候选空间
site           := "site:"       SITE_SPEC
parallel       := "parallel:"   INT                # 1..8，默认 1；>1 = 平铺复制整条线
constraint     := "constraint:" CONSTRAINT_NAME
note           := "note:"       STRING             # 仅供日志；不参与编译

SHAPE_KEY      := '"' [RC SW]+ (":" [RC SW]*)* '"'   # 游戏 canonical short key（getHash 输出）
STRATEGY_NAME  := "shortest" | "fewest-stackers" | "fewest-painters" | "closest-resources" | "mirror-existing"
SITE_SPEC      := "nearest-to-hub" | "cluster" SHAPE_KEY | "coords" INT INT      # coords 仅用于 L2 调试，LLM 禁用
CONSTRAINT_NAME:= "no-teardown" | "keep-clear" [x y] | "max-width" INT
```

**设计理由（有出处的三条）**：
- 形状 key 用**游戏自己的 canonical 格式**（`getHash()`，如 `CgScScCg`、`SrSrSrSr:CyCyCyCy`）——
  这就是 `obs.goal.requirement.shape` 的字面值，**零翻译损耗**（ToolSandbox 的 Canonicalization 教训，
  04-research §3.3；本仓库的 `facts/solver-cross-validation.md` 证明 48433/48433 形状与公开求解器一致）。
- DSL 是**平铺单层**的（一个 line 一条产线）。**明令禁止嵌套**（不做"line A 引用 line B"）：
  L2HP 实测分层规格的语法有效率仅 1% vs 平铺 20%（04-research §1.3）。多行组合由确定性层负责（`lines: [...]`）。
- `strategy` 是**枚举而非自由文本**——直接映射到 solver 的剪枝参数与 layout 的启发式变体，
  杜绝"LLM 发明不存在的策略"。

### 1.3 策略枚举 → L2 行为的精确映射（这是 DSL 的"语义"）

| strategy | solver 侧 | layout 侧 | 何时用 |
|---|---|---|---|
| `shortest` | 最少步数配方（默认） | 行式布局，一层一行 | 低等级、目标简单 |
| `fewest-stackers` | 优先选 stack 次数少的分解（stacker 0.25/s 是瓶颈） | 可用"无 stacker 的直通链" | 目标是单层但可用多切割近似 |
| `fewest-painters` | 把 paint 放在分支末端（减少颜料线长度） | 颜料支线最短 | 颜料矿远、颜料线贵 |
| `closest-resources` | 与最短相同 | 选址：以矿到 hub 总距离最小为目标 | 默认兜底 |
| `mirror-existing` | 复用旧产线输出为叶子（不拆旧厂，官方 tips 反复强调） | 新线接入旧收集带 | 扩张期（level 12+） |

**注意**：这 5 条是**L2 真实实现的参数**，不是给 LLM 看的宣传词。每条都必须在
`src/ai/solver.mjs` / `src/ai/layout.mjs` 里有一行 `if (opts.strategy === ...)` 的落点——
没有落点的策略不写进枚举（AlphaGeometry 的 DSL coverage 教训，04-research §7.4）。

### 1.4 三个真实例子（对应 level 2 / level 11 / 一个多层目标）

所有三条的目标形状与配方均已用 `proto/shape-ops.mjs` 实测验证（本轮重新跑过）：

**例子 1 — level 2（`----CuCu`，目标是"下排两个圆"）**

```
line cut_l2 {
    target: "----CuCu"
    strategy: shortest
    site: nearest-to-hub
    parallel: 1
}
```

L2 展开（已知确定性答案，来自 `proto/shape-ops.mjs` 实测）：
`cutHalf(CuCuCuCu)[0] = ----CuCu` → miner(Cu) → cutter → **取槽 0（左列）**送 hub，槽 1 接 trash。
solver 全败概率≈0——**这个例子演示"LLM 可能完全不被调用"**：确定性层直接给答案，
LLM 只在它被显式启用（`--llm`）且需要**选址取舍**时才回来。

**例子 2 — level 11（`CgScScCg`，真目标；7 步链已实测）**

```
line l11 {
    target: "CgScScCg"
    strategy: fewest-stackers
    site: cluster "SuSuSuSu"
    parallel: 1
    constraint: no-teardown
    note: "青必须 mixer 混绿+蓝（青不是矿）；绿矿与 Su 矿就近选取"
}
```

L2 展开（`facts/ops-semantics-VERIFIED.md §4` 的 7 步链）：
```
SuSuSuSu --paint cyan--> ScScScSc --cutHalf[1]--> ScSc---- --rotateCW-->  --ScSc--   (下层)
CuCuCuCu --paint green--> CgCgCgCg --cutHalf[1]--> CgCg---- --rotateCCW--> Cg----Cg   (上层)
stack(下排, 上排) ⇒ CgScScCg
```
原料：`CuCuCuCu`、`SuSuSuSu`、颜料 绿（矿）+ 蓝（矿）→ **mixer 混青**。
布局复用 M2a（颜料从 top 进 painter）+ M3/M4（stacker 两输入 + 分支汇合）模式。

**例子 3 — 多层目标（`SrSrSrSr:CyCyCyCy`，level 15 真目标；两层相同几何）**

```
line multi {
    target: "SrSrSrSr:CyCyCyCy"
    strategy: shortest
    site: nearest-to-hub
    parallel: 1
    note: "两层各自独立：下层红星、上层黄圆；只用一个 stacker 汇两层"
}
```
L2 展开（本轮 `proto/shape-ops.mjs` 实测：`stack(paint(Su,'red'), paint(Cu,'yellow')) === "SrSrSrSr:CyCyCyCy"`）：
```
分支1: SuSuSuSu --paint red----> SrSrSrSr ─┐（进 stacker 槽 0 = 下层）
分支2: CuCuCuCu --paint yellow-> CyCyCyCy ─┘（进 stacker 槽 1 = 上层）
```
【待验】多层布局**从未实机做过**（SYNTHESIS §5.2 最大未解项）：需要多级 stacker 串联，
几何复杂度显著上升。**本文的设计把它当作"L2 的失败面"来对待**——若 L2 返回
`UNSUPPORTED_MULTILAYER`，LLM 的修复选项只有"降级为分步：先建第一层产线，等交付后再扩第二层"，
而**不允许** LLM 自己发明立体布线。

---

## 2. `docs/AGENT-PROMPT.md` 的草案结构

### 2.1 骨架（渲染顺序 = 缓存稳定序：static → 半静态 → 动态）

```
┌─ SYSTEM PROMPT（~800 tok，字节稳定，可 prompt-cache）──────────────────┐
│ 1. 角色: "You select production strategy for shapez.io. Output DSL."   │
│ 2. DSL 语法参考卡（§1.2 的 EBNF 缩写 + 5 个 STRATEGY_NAME 语义表）      │
│ 3. 禁则（⚠️ 显眼）: 不得输出坐标/旋转/building id；不得输出嵌套；        │
│    不得输出"动作序列"；形状 key 必须逐字符复制自输入                    │
│ 4. 输出协议: 只输出 DSL 文本（无 markdown 围栏、无解释）              │
│ 5. 失败修复协议说明（§3 的 JSON schema 摘要 + 允许的修复动作）          │
└────────────────────────────────────────────────────────────────────┘
┌─ USER TURN（每轮重写；按 Lost-in-the-Middle 排序：目标在前、行动在后）─┐
│ [A] goal 块（最先，~80 tok）                                          │
│ [B] state 块（~600 tok，见 §2.2）                                      │
│ [C] few-shot（仅首轮；2 个 = 例子1 + 例子2，~450 tok）                │
│ [D] library 检索（≤3 条 checker-filtered 蓝图摘要，~250 tok）          │
│ [E] 修复块（仅修复轮；§3 的 failure JSON，~400 tok）                   │
│ [F] 任务指令（最后，~60 tok）: "Output the DSL program for line <id>." │
└────────────────────────────────────────────────────────────────────┘
```

### 2.2 状态注入格式（确定性代码生成，LLM 不参与）

`state 块`由 `src/ai/prompt.mjs` 从 `obs` 派生的**摘要视图**生成——**绝不**直接倾倒 `obs`：

```
## STATE
level: 11 | goal: "CgScScCg" required 3500 delivered 402 (11.5%)
hub: (0,0) size 4x4 | free sides: N E S W
upgrades: belt 3 miner 3 processors 2 painting 1
inventory: CuCuCuCu x25267, RuRuRuRu x610, ----CuCu x88, ...
resources (offline, near hub): CuCuCuCu x295 (nearest 34 tiles), SuSuSuSu x111 (nearest 52), green x466, blue x493
existing lines (mine): cut_l2[Cu] live, l11-partial[Su] idle
traffic (last save decode): 3 belt paths stalled (>80% full), 0 starving
```

**恒等式（可测试）**：state 块 ≤ 700 token（用 `count_tokens` 校准一次，之后用字符数近似：
中文/代码混合取 ≈3.5 字符/token，即 ≤ 2450 字符）。**超限即截断资源列表**（保留最近的 k 个簇），
**绝不**截断 goal/hub/库存。

### 2.3 量化 token 预算（每次 LLM 调用）

| 块 | 预算 | 说明 |
|---|---|---|
| system prompt | 800 | 字节稳定 → 命中 prompt cache（prefix 不变） |
| goal 块 | 80 | 直接来自 `obs.goal`，逐字符 |
| state 块 | 600–700 | 上限硬编码，见 §2.2 |
| few-shot（首轮） | 450 | 2 例（level 2 + level 11），**修复轮不重放** |
| library 检索 | ≤ 250 | 3 条 × ~80 tok（只放"模块名 + 输入/输出形状 + 吞吐"三字段） |
| 修复块（修复轮） | ≤ 400 | §3 的 JSON，`truncate(items, 20)` |
| 任务指令 | 60 | 最后一行 |
| **输入合计** | **≈ 2.2k（首轮）/ 2.6k（修复轮，无 few-shot）** | |
| **输出（DSL）** | **≤ 300**（≈40 行） | 超长 = 模型跑偏，编译器直接判 `DSL_TOO_LONG` |

成本（用 claude-api 技能的现行价目，`claude-opus-5`：$5/MTok in、$25/MTok out）：
一次调用 ≈ 2.6k×5/1e6 + 0.3k×25/1e6 ≈ **$0.0205**；加 cache 命中（system 800 tok 按 0.1×）
单次 ≈ **$0.019**。**一次完整尝试（1 首轮 + ≤3 修复）= ≤4 次调用 ≈ $0.08**。
对照：`step`/`await` 快进 20000 tick 在本机是**亚秒级、零成本**——
**"确定性多试一次"永远比"问 LLM 一次"便宜 100 倍以上**，这是预算分配的根本依据。

### 2.4 few-shot 的位置与内容纪律

- **只放首轮**（修复轮重放会稀释批评块——Lost in the Middle）。
- **只放 2 条**：一条最短（level 2）、一条含颜料/mixer（level 11）。
  都必须是**编译器真正接受过的 DSL**（来自 `test/fixtures/dsl/*.dsl`，由 CI 保证可编译）。
- **不放**"教科书式完整性格"的示例（如多层）——DSL coverage 未达成的示例是陷阱。

---

## 3. 失败反馈协议：L2 失败时返回什么给 LLM

### 3.1 具体 JSON schema（`src/ai/critique.mjs` 产出；喂给 LLM 前 `JSON.stringify(critique, null, 1)`）

```jsonc
{
  "type": "layout_critique",          // 固定
  "attempt": 2,                       // 第几次尝试（1-based；>3 时 LLM 不再被调用）
  "line_id": "l11",
  "stage": "verification_tier3",      // 失败发生在哪一级：
                                      //   dsl_parse | solver | layout | verification_tier1
                                      //   | verification_tier2 | verification_tier3 | execution
  "error_code": "TIER3_TIMEOUT",      // 见 §3.3 错误码表
  "failing_node": {                   // 配方 DAG 里的节点（可空）
    "id": "stack-1",
    "op": "stack",
    "produced_shape": "CgScScCg",     // 该节点实际产出（形状代数算出）
    "expected_shape": "CgScScCg"
  },
  "first_diff": {                     // 形状差：**首个不同**的层/象限（像 git diff）
    "kind": "quadrant_color",         // quadrant_color | quadrant_sub | layer_count | missing_layer
    "layer": 1, "quadrant": "TL",     // TR|BR|BL|TL（注意顺序真值见 ops-semantics §1）
    "expected": "Cg", "got": "Cu"
  },
  "failed_tiles": [                   // 布局/实机失败的确切格点（截断 ≤ 20）
    { "x": -23, "y": -180, "reason": "occupied", "occupant": { "type": "belt", "uid": 13207, "r": 90, "rv": 2 } }
  ],
  "suggested_strategies": ["fewest-stackers", "mirror-existing"],   // L2 认为**未被尝试**的策略
  "blockers": [
    { "type": "channel_conflict",     // 见 §3.2
      "detail": "branch B's vertical channel (x=147) collides with branch A's lane at y=93",
      "tiles": [[147,93]] }
  ],
  "attempts_so_far": [                // 历史（≤3），供 LLM 避免重复
    { "strategy": "shortest", "stage": "verification_tier3", "error_code": "TIER3_TIMEOUT" }
  ],
  "allowed_repairs": ["change_strategy", "change_site", "change_parallel", "add_no_teardown"]
}
```

**字段设计原则（每条都有出处）**：
- `first_diff` 是**结构化的、因果的**批评，不是布尔（Newclid 教训，04-research §3.4；
  Tier-1 检查器设计 §3.5）。
- `failed_tiles[].occupant` 直接来自 `obs` 的实体（uid/type/r/rv 都有）——
  对应 `play.mjs` 已有的"2002 → re-observe occupants"模式（Code-as-Policies +46.2% 的
  interactive validation 一半，04-research §1.5）。
- `suggested_strategies` **只列 L2 真实未尝试的枚举值**——LLM 不能发明策略。

### 3.2 「布局失败最大类」在协议里的表达（这是关键——本次研究挣来的）

`facts/MILESTONE-M4-partial-and-pitfalls.md` 的 7 条陷阱表 + `facts/GEOMETRY-TABLE.md 表3`
把布局失败收敛到**三大类**。协议必须能精确表达它们：

| 失败大类 | 来源 | 在 JSON 里的表达 |
|---|---|---|
| **拐角 rv 不可控** | 陷阱 #1；根因 `ROOT-CAUSE-rotationVariant-override.md`（`placeOne` 重算 rv）。**已修复**（RV-FIX），但布局若走 `place`/`place_path` 路径仍可能踩 | `blockers[].type="corner_rv"` + `failed_tiles` 给出拐角格与实测 rv；`allowed_repairs` 追加 `"paste_via_blueprint"`（提示 L2 改用蓝图路径落地） |
| **同列通道冲突** | 陷阱 #5（两条车道必须不同行）+ M4 教训"两矿同列 → 竖直通道重叠" | `blockers[].type="channel_conflict"` + `tiles` 给冲突点；`suggested_strategies` 可含 `closest-resources`（换选址） |
| **退化段** | 陷阱 #3（`from==to` 报 2001，本次踩 4 次） | 这是**工具层**问题（见 `tool-gaps-DESIGN.md §5`），布局编译器应在生成阶段过滤；若漏到执行层 → `stage="execution"`, `error_code="DEGENERATE_SEGMENT"`, `blockers[].type="degenerate_segment"` + `tiles` |

其余四类陷阱的映射（完整覆盖）：
- #2 对角缺口 / #4 输入输出方向冲突 → `error_code="GEOMETRY_MISMATCH"` + `failed_tiles`；
- #6 顺序敏感 → `stage="execution"` + `error_code="STALE_RV"`（L2 应改用"拐角最后放"或蓝图）；
- #7 废弃输出未接走 → `error_code="OUTPUT_BLOCKED"` + `failing_node` 指向那个输出槽。

### 3.3 错误码表（`critique.error_code`，闭集）

```
DSL_PARSE_ERROR          LLM 的错，重试同一次调用即可（不消耗 attempt 的"策略轮"）
DSL_UNKNOWN_STRATEGY     DSL 里出现枚举外策略
SOLVER_UNREACHABLE       目标形状不可构造（对公开表的 NONE 情形）
SOLVER_UNSUPPORTED_MULTILAYER  多层目标超出当前 solver+layout 能力（SYNTHESIS §5.2）
LAYOUT_NO_SITE           选址约束下找不到合法建址（资源太挤/全被占）
LAYOUT_CHANNEL_CONFLICT  同列/同行通道无法消解
VERIFY1_SHAPE_MISMATCH   形状代数预测 ≠ 目标（编译器 bug 或 DSL 语义错）
VERIFY2_GEOMETRY_INVALID 重叠/悬空/斜率不符（Tier-2）
TIER3_TIMEOUT            实机快进超时：交付未增加（物流不通/堵塞/未接产出）
TIER3_WRONG_SHAPE        实机有交付但 shape 不是目标（Canonicalization 陷阱）
EXECUTION_REJECTED       动作被拒（2002 类）且重试超过 2 次
INTERNAL                 编译器 bug（不喂 LLM；直接上报）
```

### 3.4 「失败 → 修复」完整走查（一次真实场景的逐步推演）

**场景**：level 11，首轮 LLM 给 `strategy: shortest`。L2 编译成功、Tier-1/2 通过、
Tier-3 超时（链条不断，但物品没到 hub——正是 M4-partial 的失败形态：拐角 rv 反向）。

```
轮 1: LLM → DSL(shortest, cluster Su) → L2 编译 → 粘贴 → await(3000 tick) → met:false
      critique = {
        stage: "verification_tier3", error_code: "TIER3_TIMEOUT",
        blockers: [{ type: "corner_rv", detail: "corner at (138,93) has rv=1 (left turn) but flow requires rv=2 (right turn)", tiles: [[138,93]] }],
        suggested_strategies: ["fewest-painters"],   // shortest 已试
        allowed_repairs: ["change_strategy", "paste_via_blueprint"]
      }
轮 2: LLM 读 critique →
      修复动作 1（首选）: 保持策略，但请求经蓝图路径落地 → L2 用 RV-FIX 的 rv 覆盖重建蓝图
      ——实际上 L2 对 `corner_rv` 有**确定性自愈**（blocks 表→改用 paste_blueprint），
      所以这一轮 LLM 甚至不需要被调用：L2 先自查"是否可无 LLM 自愈"，是则直接重试。
      只有自愈失败（再超时）才进 LLM：
轮 2'(真 LLM 轮): 输出
      line l11 { target:"CgScScCg" strategy:fewest-painters site:cluster "SuSuSuSu" parallel:1 }
轮 3: L2 重编译（颜料线短化 → 布局几何变化 → 拐角位置变化）→ Tier3 通过 → 交付 +N
```

**关键设计**：`allowed_repairs` 与**确定性自愈表**（`src/ai/repair.mjs`）并列存在——
**能在代码里修的就绝不打给 LLM**（参见 §4 判据）。

---

## 4. 「何时才调 LLM」的判据（写死成规则，可测试）

实现位置：`src/ai/policy.mjs`，导出 `shouldCallLLM(attempt: AttemptLog): boolean`。
**这些规则是纯函数**，输入是确定性层产出的 attempt 记录，无任何模型参与。

```js
// 规则 R1–R4 为"调用"；R5 为"绝不"
R1: l2.allStrategiesExhausted        // L2 枚举的全部策略都试过且全败 → 调（修复轮）
R2: l2.candidates.length > 1 && !l2.hasDeterministicTieBreak
                                     // 成功但多候选（如两条同吞吐的选址）→ 调（取舍轮）
R3: solver.reports === "UNREACHABLE_BY_SOLVER" && dslCoverageMiss(goal)
                                     // 目标超出 solver/DSL 能力（多层是当前唯一实例）→ 调
R4: l2.candidates.length === 0 && critique.stage === "layout" && critique.blockers
       .every(b => b.type === "channel_conflict")   // 布局局部失败、且失败类可被"换策略"消解 → 调
R5: NEVER（以下一律由确定性代码处理，写测试断言它们不进 LLM）：
    · 逐动作决策（每个 place/place_path 一次调用）
    · 坐标/旋转/几何数值计算
    · 验证（Tier-1/2/3 全确定性）
    · 自评（"我的布局看起来对吗"——Huang et al. 明确否决）
    · 已可自愈的失败（repair.mjs 表命中的）
```

**可测试性**：`test/policy_selftest.mjs` 用构造的 `AttemptLog` 夹具逐条断言 R1–R5
（含"逐动作不调"的负例）。**回归红线**：任何 PR 让 `shouldCallLLM` 在
"L2 全绿"的情形返回 true，直接拒绝。

**量化护栏**：每次 `build <target>` 会话的 LLM 调用 **≤ 4**（1 首轮 + 3 修复，与 SYNTHESIS 3.5 的
"≤3 次尝试内修复"对齐）；超限时整个 build 以 `LLM_BUDGET_EXHAUSTED` 结束并**保留现场**（不清理），
把 critique 落盘到 `runs/<ts>/critique.json` 供人查。

---

## 5. 可离线测试的接口（关键交付）

### 5.1 `LLMClient` 接口（`src/ai/llm.mjs`）

```js
/**
 * L3 的唯一入口。真实实现调 Anthropic API；mock 实现读固定文件。
 * 整个 build 流程只依赖这一个方法来"问 LLM"。
 */
export class LLMClient {
  /**
   * @param {object} dslContext  - { system, goalBlock, stateBlock, fewShots, library, critique }
   *                               （由 src/ai/prompt.mjs 组装好的**字符串块**，不含坐标）
   * @returns {Promise<{ dsl: string, usage?: {in:number,out:number}, raw?: object }>}
   *          dsl = §1.2 的 DSL 文本；解析失败由调用方（compiler）报 DSL_PARSE_ERROR
   */
  async propose(dslContext) { throw new Error("abstract"); }
}

/** 真实实现（Node 18+ 原生 fetch，零依赖——与仓库铁律一致） */
export class AnthropicClient extends LLMClient {
  constructor({ apiKey = process.env.ANTHROPIC_API_KEY, model = "claude-opus-5", maxTokens = 1024 } = {}) {}
  async propose(dslContext) { /* POST https://api.anthropic.com/v1/messages */ }
}

/** mock：从目录读 DSL 文本（按 attempt 序号命名）——无需 API key */
export class MockLLMClient extends LLMClient {
  constructor({ dir }) {}   // dir 内: attempt-1.dsl, attempt-2.dsl, ...
  async propose(dslContext) { /* 依 propose 调用次数读第 N 个文件；耗尽后抛 MockExhausted */ }
}
```

**为什么零依赖手写 fetch**：仓库是"零依赖铁律"（SYNTHESIS §3 明确否决引入 npm 依赖）；
Anthropic Messages API 是一次 POST——`fetch` 足够。**选用 `claude-opus-5`**（当前首选模型；
若用户要更省可换 `claude-sonnet-5`，接口不变）。**注意**：Anthropic API 无 assistant prefill
（本模型族拒绝 prefill）——**不要**用"预填 `line l11 {`"技巧；用 system 指令约束输出即可。

**接入点**：`play.mjs --llm`。CLI 设计：

```
node src/agent/play.mjs build "CgScScCg" --llm                    # 真实 API（需 ANTHROPIC_API_KEY 或 ant auth login）
node src/agent/play.mjs build "CgScScCg" --llm-mock test/fixtures/llm  # mock，离线
```

### 5.2 mock 实现方案（不花钱跑通整条链路）

**目标**：`node src/agent/play.mjs build "----CuCu" --llm-mock test/fixtures/llm` 在**没装 key、
没开游戏**的情况下，让"DSL → 编译 → 候选 → 验证"整条链路跑到 `verification_tier3` 前的全部步骤；
再配 `--dry-run`（不真正写世界、不真正 await）即可在 CI 里全绿。

**mock 目录布局**（随仓库提交）：

```
test/fixtures/llm/
  attempt-1.dsl          #   line cut_l2 { target:"----CuCu" strategy:shortest site:nearest-to-hub }
  attempt-2.dsl          #   与 attempt-1 相同形状、换 strategy（用于测"修复轮"）
  attempt-3.dsl          #   故意非法（测 DSL_PARSE_ERROR 不进 LLM 重试逻辑）
  expected/
    attempt-1.blueprint.txt   # 编译器**应当**产出的蓝图（或摘要：实体数、bbox、code 直方图）
    attempt-1.critique.json   # 若 mock 的目标是"制造一次失败"，给出预置的 critique
```

**mock 的两种模式**：
1. **诚实模式**（默认）：`MockLLMClient` 只读 DSL 文件；**其余全是真的**（真 solver、真 layout、
   真 Tier-1/2 验证）。这样测的是"接口契约 + 编译链"，不含网络。
2. **场景模式**（`--llm-mock scenario:name`）：mock 还接管"实机反馈"——
   `play.mjs` 在 `--dry-run` 下用一个**假 root**（stub，对齐 `test/mod_selftest.mjs` 的
   stub shapez 手法），让 `paste_blueprint`/`await` 走桩，返回预置的 `obs`。
   用于测**修复循环本身**：预置"attempt-1 → TIER3_TIMEOUT(拐角 rv)"的反馈，
   断言 `shouldCallLLM` 为 true、第 2 次 propose 被调用、且被喂的 critique JSON 含 `corner_rv`。
3. **录制模式**：`--llm-record runs/<ts>/llm.jsonl` 用真实 API 跑一次会话、
   把 (dslContext → dsl) 全部落盘；之后 `--llm-replay` 回放。这是把"线上失败"变成
   "离线测试用例"的通道（PLLM 的"高保真执行筛选"思路，04-research §6.2）。

**验收标准（可直接写成 CI）**：
- `test/llm_mock_selftest.mjs`：mock 客户端 + 真编译器，`----CuCu` 的 DSL 必须编译出
  `expected/attempt-1.blueprint.txt` 的实体直方图；
- 修复循环单测：预置 `corner_rv` 批评 → 断言第 2 轮 propose 的 `dslContext.critique.type === "layout_critique"`
  且 `blockers[0].type === "corner_rv"`；
- 预算断言：4 次 propose 后 `LLM_BUDGET_EXHAUSTED`，未发起第 5 次。

---

## 6. 成本模型

### 6.1 每次尝试的调用数与 token（确定性层优先）

| 阶段 | 谁做 | 成本 |
|---|---|---|
| 候选枚举（≤5 策略 × ≤3 选址） | L2 确定性 | 0（纯离线计算，`solver.mjs`/`layout.mjs`） |
| 候选排序 | L2 确定性（吞吐 × 距离 × 重叠罚分） | 0 |
| 每个候选的 Tier-1/2 | L2 确定性 | 0 |
| 实机验证（仅对**最优 1 个**候选） | L1 `paste_blueprint` + `await` | 2 次 RPC、亚秒级 |
| LLM（仅当 §4 判据命中） | L3 | 1 次调用 ≈ $0.02（§2.3） |

**结论**：设计目标不是"少花 LLM 钱"，而是"**在 LLM 出手前，确定性层已经消耗过一次
免费的全空间搜索**"——LLM 的每次调用背后都有 ≤15 个候选的确定性评估作上下文。

### 6.2 失败重试上限

- **修复轮 ≤ 3**（`attempt` ≤ 4，含首轮）。依据：SYNTHESIS 3.5 的验收标准 + 04-research §5.3
  "Bound the loop（例如 4）"；且本研究的失败模式是**可达性的**（换策略/换址一次就中），
  第 2–3 轮的边际收益极低。
- 达上限：停手、保留现场、落盘 critique，**绝不做"再想想"式无限循环**。
- **LLM 调用总预算（一次 build 会话）≤ 4**，硬断言在 `play.mjs` 里（§5.1 验收第 3 条）。

### 6.3 预算分配原则（一句话可引用）

> **确定性层零成本可试错 → 优先穷举；实机验证 2 次 RPC → 次优先；
> LLM $0.02/次 → 只在"穷举完仍不确定"时兜底。**

对应到 PPO/Goodhart 文献的教训（04-research §4.2）：**不要**给 LLM 加"多想想"的
test-time scaling（04-research §9.8 明确否决）；要加的是**更多确定性候选**。

---

## 7. 未决项（诚实清单）

| 项 | 状态 | 怎么验 |
|---|---|---|
| mock 之外的真实 API 调用 | 【待验】未落过真实 API | 实现后跑一次 `--llm` 对 level-2；成本按 §2.3 核算 |
| `fewest-stackers` 等策略的 L2 实现 | 【待验】策略表是**设计契约**，solver/layout 侧落点未写 | 每条策略必须有单测（策略 → 可观察的候选差异） |
| 修复循环在真实失败上的成功率 | 【推断】文献 +46.2%/+80% 仅作参考 | 构造 5 例人为失败（通道冲突/超时/退化段）跑修复矩阵 |
| 多层 DSL 语义 | 【待验】例子 3 的 solver 侧已验证，布局全未做 | 等 L2 多层立项后再启用该 DSL 分支 |
| token 预算 | 【推断】§2.3 是结构推断，未实测 | 实现后 `count_tokens` 校准一次并写进测试 |
| prompt cache 命中率 | 【推断】system 稳定 ⇒ 期望命中 | 实现后读 `usage.cache_read_input_tokens` 验证（应为 0 或 800） |

---

## 8. 给实现者的接入清单（按顺序）

1. `src/ai/llm.mjs`（LLMClient / AnthropicClient / MockLLMClient）——半天
2. `src/ai/prompt.mjs`（state 块生成 + token 预算截断）——半天
3. `src/ai/policy.mjs`（R1–R5 + 单测）——半天
4. `src/ai/critique.mjs`（schema 产出 + 错误码表）——1 天（与 L2 的失败路径一起写）
5. `docs/AGENT-PROMPT.md`（§2 骨架落成文）——半天
6. `play.mjs build <target> --llm|--llm-mock` 骨架——1 天
7. `test/fixtures/llm/` + `test/llm_mock_selftest.mjs`——1 天

**依赖**：1.1–1.4（shape-ops / world / solver / verify）+ 2.1（layout）先到位；
本文的任何一部分都不阻塞布局编译器本身。
