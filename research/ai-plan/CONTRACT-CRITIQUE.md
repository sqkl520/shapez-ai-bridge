# 六宏 ABI 契约批判

> 评审对象：`src/agent/macros/contract.mjs`
> 视角：**这套接口对 LLM 来说真的好吗？**
> 方法：以契约为主，逐条核对实现是否兑现（实现仅用于取反例，不作为评判依据）。
> 说明：第 2 节的推演**只用契约**，第 1/3 节引实现处均已标注文件行号。

## 0. 裁决：方向对，接口没到位

这套 ABI 做到了「禁止裸坐标」，但没做到「让 LLM 一眼知道调哪个、传什么、成了没成」。三处硬伤：

1. **契约承诺的能力自己拒掉。** `replace_run` 的 `params` 写 `building: string|{kind,variant}|Array`（contract.mjs:843），`validateReplaceRunArgs` 却对一切非 `"belt"` 返回 `unsupported_building`（:601-606）。L4 的真实改造（带→cutter+trash）**用契约表达不出来**，只能靠 `remove.mjs` 头部的「扩展 1」绕过校验器。接口真值有两份，且互相打脸。
2. **`region: BBox` 是纯坐标算术**，靠 lint 的 `cellish` 白名单豁免（:1313）。契约第一原则（computed 一律不出现在公开 ABI）给自己开了后门。
3. **`warnings` 是开集、无级别。** `ok:true` + 非空 `warnings` 没给 LLM 任何「要不要管」的判据；实现里已经出现 `kept-belts` / `rv-drift` / `facing_ignored` / `rotation_not_live_verified` 等二十来个 code，和 `error` 的闭集形成鲜明对比。

## 1. 逐宏批判

**connect** — 5 个 opts，其中 `rebind` / `allow_replace` 是两个语义相近、都要谨慎的布尔，LLM 很容易一起开。preconditions 9 条同权并列，里面至少 3 条是实现的自我约束而非对调用方的约束：「mod 支持 tx 否则 tx_unavailable」（LLM 既预知不了也补救不了）、「路径首格 = from 出口格」、「v1 不支持隧道穿越」。把它们与「to 必须已存在」并列，等于没有优先级。`whenNotToUse` 第 5 条把 LLM 推去「用 insert_machine 后直接验证 boundAcceptor」——验证是 gate 的事，不是它的动作。`returns` 报 `cells_planned/placed`；对 connect 的调用方真正有用的信息是「两个端口现在都 bound 了吗」，不是铺了几格。

**insert_machine** — `at` 双形态是最大的认知负担：`[x,y]` 是 origin、`{cell,part:"any"}` 是任意占格，**两者不做同一个算术**（:343-346）。obs 里给的是 x/y，LLM 会天然填 `[x,y]`；而真实意图（「在这条带上插一台」）对应的是 `{cell}`——默认形态恰好是错的那个。`facing` 在 params 里 `required:false`（:744），description 却写「必填」，precondition 又说缺失时 `ambiguous_site`（:752）。schema、文档、运行期三处不一致。

**remove_run** — `uids`/`cells` 二选一，`cells` 是为「拿不到 uid」准备的；但 obs 永远给 uid，这个次选通道只多一个选错机会，还把坐标重新放进公开 ABI。建议删掉。

**extend_line** — `len` 被归为 choice（「4 就是 4」），但 precondition 要求 `len ≤ 与最近障碍的距离`（:821）——LLM 必须先数格子才知道填几，这就是算数。`whenNotToUse` 禁止两个弯，于是绕一格要 2 次调用，第二次的 `from` 是上次返回的坐标；宏的返回值在这里变成输入，契约对这条闭环只用一句「每次 from = 上次返回的 terminal」带过。

**replace_run** — 三种类型（string / `{kind,variant}` / Array）+ 两条 region 语义（belt 路径要求逐格全是带子，机器路径允许空格，测试里明确写着这是「**有意差异**」，remove.test.mjs:553）。同一个参数的合法值取决于兄弟参数的类型，LLM 无法从 schema 推出任何一条规则。

**trash_unused** — `outlet` 能接带子末端，这是 `remove.mjs` 的「扩展 2」，契约里没有。`confirm_waste` 把「这一路是不是废料」推回给 LLM，而契约自己承认「目标形状决定哪一侧是废料，宏查不出目标」（:883）——最需要机器判断的一件事（哪个输出是废料），被明确留给了 LLM。这不是 poka-yoke，是签字画押。

## 2. ABI 能否表达一次真实改造（只看契约的推演）

L4 目标：把 `(4,-13)(5,-13)(4,-14)` 三条带改成 cutter + trash。只读契约，我会这样调：

**路径 A（3 次）**
1. `remove_run({uids:[10209,10149,10143]})`
2. `insert_machine({at:[4,-13], facing:"top", machine:"cutter"})` → 等 uid
3. `trash_unused({outlet:{uid:<上一步>, port:"left"}, opts:{confirm_waste:true}})`

**路径 B（2 次，赌默认值）**
1. `insert_machine({at:[4,-13], facing:"top", machine:"cutter"})` —— 赌 `replace_belts` 默认 true 会替它删掉 footprint 内 2 条带。
2. `trash_unused({outlet:{uid, port:"left"}, opts:{confirm_waste:true, replace_belt:true}})` —— 赌 `replace_belt` 默认 false 靠第一次失败学到。

**歧义清单**
- 路径 B 的第一次调用是否"合法地"删了带子？`insert_machine.sideEffects` 写了「替换 footprint 内的带子」，`remove_run.whenNotToUse` 又说「insert_machine 自己会处理」——两条都对，但没有任何一条告诉 LLM 哪种顺序是**推荐**的。同一件事两条合法路径，等于没有规范。
- `trash_unused` 要等 cutter 的 uid，而 `insert_machine.returns` 只承诺 `MacroResult + {origin, cells, ...}`，**没有一个稳定字段叫 `uid`**；`changed.added_uids` 是数组且顺序未定义。更糟的是实现里它**恒为空数组**（place.mjs:726 注释「计划态没有真实 uid（由 tx 分配）」）。于是「放机器 → 给它的左槽接垃圾桶」这两步在契约层面**无法串起来**：第二步的 `outlet` 只能靠重新 obs 才写得出来。契约里没有任何一句说明这一点。
- 契约里 `wasteRoles` 说 cutter 的 `right` 是废料；L4 要的恰恰是丢 `left`。照表填的 LLM 会**销毁产品**，而且 `confirm_waste` 是布尔，无法表达「我要保的是右边」。
- 三次调用的中间态是「cutter 已放、左槽悬空」。`insert_machine` 只在 `warnings` 里报 `output_not_connected`（place.mjs:611），**不阻断**；而 `replace_run` 扩展路径把同一个条件当成 `precondition_failed` 硬拒（remove.test.mjs:487）。同一物理状态，两个宏一个放过一个拒绝，契约里没有任何一句解释为什么。

**结论**：能表达，但要用 2–4 次、依赖未承诺的返回字段、且中间态不安全。而 `remove.mjs` 记录的实测是 **1 次** `replace_run({region, building:["cutter",{kind:"trash",port:"left",confirm_waste:true}]})` —— 这个写法**在契约里是非法的**（:601 只认 `"belt"`）。也就是说：唯一能一次做完的调用，契约不承认。

## 3. 设计矛盾

1. **空地上没有合法的第一步。** `connect.whenNotToUse` 说「宿不存在就先把宿放好」；`insert_machine.whenNotToUse` 说「周围没有带子/机器可接时不要用：孤立机器只是占格」。两条合起来把「新建产线」的首步封死，只剩 `build_line`——而它不在 `MACRO_SPECS` 里（`MACRO_NAMES.length === 6` 是硬断言）。契约把能力推给一个自己没定义的宏。
2. **`replace_run` 是缝合怪，且缝合处漏了。** `params` 宣告 `string|{kind,variant}|Array`（:843），validator 拒绝一切非 belt（:601），`summary` 却已经写成「building 为机器/机器数组时展开 footprint」（:840）。同一文件里三处说法不同。LLM 读 schema 会用它，运行时必被拒。
3. **`confirm_waste` 把最该机器算的事推给 LLM。** 契约自己写「目标形状决定哪一侧是废料，宏查不出目标」（:883），于是要求 LLM 为一个它无法验证的判断签字。同时 `wasteRoles` 的默认值（cutter→right）在半切场景下是**反的**——这不是防误用，是制造误用。
4. **`region: BBox` 违反第一原则却拿了豁免。** `lintNoBareCoords` 把 `region` 放进 `cellish` 白名单（:1313）。而它的前置条件「带子数 === region 面积」要求 LLM 数格子，正是 computed 类的工作。契约对 computed 的定义（「合法值取决于世界」）完全命中 `region`。
5. **`warnings` 是开集且无级别。** `error` 有 22 个闭集 code，`warnings` 只写 `Array<{code,...}>`。实现里 `kept-belts`（信息）、`rv-drift`（要查）、`rotation_not_live_verified`（根本不确定能不能用）混在同一个数组。`ok:true` + 非空 warnings 对 LLM 是**不可判定**的。
6. **宏之间靠 uid 串联，但返回值里没有 uid。** 六个宏里只有 `remove_run` 能拿到真 uid（删的是既有实体）；新增实体的 uid 一律为空（place.mjs:726、remove.mjs:1359）。这让「先放机器、再给它接垃圾桶」这种两步改造必须插一次 `obs`，而契约的 `whenNotToUse` 却默认 LLM 能拿到「上一宏返回值」当端点（contract.mjs:34）。**契约假设了一条它自己没有兑现的数据流。**

## 4. 业界对比

- Anthropic《Writing effective tools for agents》：工具是「确定性系统与非确定性 agent 之间的契约」，并主张**合并相关操作**（`list_users`+`list_events`+`create_event` → `schedule_event`），因为宏内部完成的多步省掉了经过上下文的中转。**这支持本项目的方向**，也说明 `replace_run` 合成一次调用本身没错——错在合成后没有单一语义。https://www.anthropic.com/engineering/writing-tools-for-agents
- Anthropic API 文档：*"Consolidate related operations into fewer tools… Fewer, more capable tools reduce selection ambiguity."* 同一段也强调 description 要写清「何时用/何时不该用/每个参数」。本契约的 `whenNotToUse` 方向正确，但**它是文档，不是 schema**——LLM 拿到的是 params 类型，`whenNotToUse` 不参与校验。https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
- Poka-yoke 的原始判据是「改参数使错误不可能」，不是「加一句劝告」。SWE-bench 的对照例：把相对路径改成必须绝对路径后模型「flawlessly」使用。本契约的 `facing` 用方位词替代角度是正面案例；`confirm_waste` 是反面案例（用布尔给后果签字）。https://www.anthropic.com/engineering/building-effective-agents
- Voyager 的技能是**可执行代码**、`temporally extended and compositional`；SkillsBench 实测「至多 3 个模块的聚焦技能」优于大而全的技能包。本契约 6 个宏数量合适，但 `replace_run` 一个宏干了三件事，正好违反「小而聚焦」。https://arxiv.org/abs/2305.16291 ｜ https://arxiv.org/abs/2602.12670
- 参数歧义已有专门研究：把工具参数建模成 POMDP、按 EVPI 决定是否追问（SAGE-Agent）。本契约「歧义就报 `ambiguous_*` 并列候选」等价于强制追问一次，做法正确，应推广到 `confirm_waste` 这类语义歧义上。https://arxiv.org/abs/2511.08798

（本机无法直连上述站点，引文取自 `RESEARCH-B-TOOL-USE.md` 已抓取的原文摘录。）

## 5. 改造建议

1. **把 `replace_run` 拆成两个单一职责宏**：`repair_belt_rv(region)`（只做 belt→belt 的 rv 修复）与 `swap_region(region, plan[])`（机器按 footprint 展开、trash 必须带 port）。并把 `contract.mjs` 与 `remove.mjs` 的「扩展 1/2」合并成唯一真值——两份规格互相打脸，任何 LLM 都会踩。
2. **`insert_machine.at` 只保留一种形状**：`at:{cell:[x,y]}` = 「机器要占的其中一格」。origin 也是 footprint 的一格，宏反解无损；多解时 `ambiguous_site` + 候选。删掉裸 `[x,y]` 分支后，「两个形状走两套算术」的认知负担归零，`part:"any"` 也可以删。
3. **`trash_unused` 的 `confirm_waste:boolean` 换成 `keeps:"left"|"right"|"quad0..3"`**（我要保留哪一路）。这是正向意图，宏可以拿它和 `wasteRoles` 对账：一致直接做，不一致要求二次确认。LLM 不需要知道哪边是废料，只需要知道**要什么**——这才是「LLM 是改稿人」。
4. **返回信封三态化**：`status:"done"|"done_with_warnings"|"refused"` 取代裸 `ok`；`warnings` 每项加 `severity:"info"|"needs_attention"` 且 code 收成闭集（像 `ERROR_CODES` 一样）。`cells_planned/cells_placed` 只在动了带子的宏里保留，`trash_unused` 这种 1 格的宏不必强行凑四个字段。
5. **给空地上的第一步一个宏**：把 `build_line` 纳入 `MACRO_SPECS`（它已存在，只是不在 6 个里），或加 `place_isolated(machine, at)`。否则 `connect`/`insert_machine` 的 `whenNotToUse` 互相指向对方，形成死循环。

## 6. 我认为最该改的一条

**返回值：把「计划」和「结果」混在同一个信封里 —— 改成 `status` 三态 + 闭集分级 warnings + 只在执行后才有意义的字段显式标为 `pending`。**

理由：当前信封的四要素 `ok/cells_planned/cells_placed/first_mismatch` 是按「宏已经写进世界」设计的（contract.mjs:1024-1029），但六个宏**全是零写入的计划器**（`remove.mjs` 头注释：「dry_run 恒为 true；真正的 delete/place 由调用方 tx 执行」）。于是：`cells_placed` 恒等于 `cells_planned`（自证的是自己的计划），`added_uids` 恒为空数组，`ok:true` 的语义漂成「计划算出来了」，而调用方读到的是一串看起来像已完成的数字。这不是文档瑕疵，是信封在说谎。

连带后果就是第 3 节的第 5、6 条：`ok:true` 可以携带「旋转机器槽位没实机验证过」这种致命不确定，而「放机器→接垃圾桶」的两步在返回值里根本接不上。

改法：
- `status: "planned" | "applied" | "refused"` —— 计划器只可能返回前两个之一，`applied` 由 tx 层回填。
- `planned.added` / `planned.removed` / `applied.added_uids` / `applied.removed_uids` 分开；计划态下 `applied.*` 明确为 `null`，不是空数组（空数组会被读成「真的没加东西」）。
- `warnings[].severity: "info" | "needs_attention"`，code 进闭集（像 `ERROR_CODES` 一样冻结）。

改完之后，第 3 节里 5 条矛盾中的三条（trash 签字、`ok` 不可判定、宏间 uid 断链）自动消失，剩下两条（`replace_run` 缝合、`region` 豁免）也就有了明确的机械判据。
