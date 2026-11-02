# P3 结果：`$ore` —— 矿机第一次真正落在铜矿上

> 2026-11-03。上一轮结尾的结论是「模型已经知道该接铜矿，但宏不支持放到资源格上」。
> 这一轮把那个缺口补完了，并且中途挖出两个 **prompt 在说谎**的地方。

---

## 一、模型自己说出了缺什么

上一轮加完「目标矿在哪」之后，模型三轮都诊断对了，而且**直接点名了缺失的能力**：

```
r1: "the only Cu miner sits on barren ground, so nothing is mined;
     **no ore handle is listed** ..."
r2: "miner M1 sits on no ore and **no ore-patch handle is exposed**"
r3: "no listed handle exposes the Cu patch"
```

它想放一台新矿机到铜矿上，但：

- 矿格不是实体，**没有句柄**
- `insert_machine.at` 只接受 `{cell:[x,y]}` / `[x,y]`
- 模型**不许写坐标**（V1 契约）

于是它只能猜（r1 猜了 `B7` 的格子）或写不合法形态（r2 用 `{at:{uid:M1}}`，
被 `LLM_ARGS: unknown_field` 拒）。

---

## 二、`$ore` 算子

`{"$ore":"Cu"}` → `{cell:[x,y]}`，取该矿种**离 hub 最近的一格**。

产出形态和 `$ref` 的 `asCell` 完全一致，所以 `insert_machine.at` 一行都不用改。

### 设计上的三个决定

| 决定 | 理由 |
|---|---|
| 只接受**两字母矿种前缀**（`Cu`），不接受 `CuCuCuCu` | 让模型写全串没有收益，反而容易写错 |
| 地图上没有该矿种 ⇒ `ORE_NOT_FOUND`，**绝不返回假坐标** | 返回假坐标会让矿机放在空地上 —— 正是这一轮要修的那个 bug 的复现 |
| 只接受 `at` 这类「一格地」的参数，**不扩成 region/cell[]** | 矿脉是不规则形状，一段矿的矩形会框进大量非矿格（和 `$bbox_of` 的老坑同型） |

### 溯源必须能重算

标签是 `ore:<色>@x,y`，但 `assertProvenance` **用当前 obs 重算**再比对 ——
和 `computed:bbox_of[…]` 同一条纪律：

```js
const now = nearestOreCell(obs, color);
if (!now) return { ok: false, why: `obs 里现在没有 ${color} 这种矿 —— 世界变了或矿已被挖空` };
if (now.cell[0] !== Number(tx) || now.cell[1] !== Number(ty)) {
    return { ok: false, why: `$ore 的重算结果不一致：标签说 ${tx},${ty}，重算是 …` };
}
```

世界变了（矿挖空、换存档）就会红，而不是拿一个过期的坐标去落盘。

---

## 三、两处 prompt 在说谎

### 谎言 1：`facing` 被渲染成可选

`params:` 行里写着 `facing:Face?`。那个 `?` 等于 `spec.required === false`。

但 `paramRules.facing` 说：「machine 有输出槽且可旋转 ⇒ 必填」。
结果模型三轮都不给 `facing`，全被拒：

```
ambiguous_site: miner 有 1 个输出槽且可旋转 ⇒ facing 必填
```

**prompt 把「条件必填」渲染成了「可选」，模型照着信了。**

修法：把 `paramRules` 里条件必填的那几条**原话**渲染成一行：

```
required when: facing is REQUIRED when machine 有输出槽且可旋转（ROTATABLE !== false） (else ambiguous_site)
```

没改 `?` 的渲染逻辑 —— `required:false` 对 `trash` 这类机器**确实**成立。
条件性必须条件着说。

### 谎言 2：矿机脚下有没有矿，一个字没说

4 台矿机里：

```
M1 @(4,-16)  →  脚下**没有矿**（7×7 邻域一格都没有）
M2 @(2,-6)   →  RuRuRuRu
M3 @(3,-6)   →  RuRuRuRu
M4 @(4,-6)   →  RuRuRuRu
```

而 `M1` 正是接在**铜切割机**上的那台 —— 它永久零产出，整条铜线因此从来没跑起来。
但 prompt 里它只是平平地写着：

```
M1 miner 输出=top:out(→C2) port=out
```

看起来完全正常。现在无矿的标：

```
M1 miner 输出=top:out(→C2) port=out  [⚠ NO ORE under this miner — it will never produce anything]
```

**只标异常的那一侧。** 第一版对有矿的也写 `[mining RuRuRuRu]`，代价立刻显形：
L4 冷启动夹具（8 台矿机）从 4400 涨到 **5098**，把 CAPACITY 段整个挤掉。
而 CAPACITY 是实测 p≈5e-7 的信息源（`AB-PROMPT-RESULT.md`），
「这台矿机在采什么」不是。信息价值也不对等：

- 「在采 Ru」= 正常状态，不需要提醒
- 「没矿」= 故障状态，而且会让下游整条线永远零产出

---

## 四、预算优先级

加 `$ore` 用法提示（~120 字符）后 L4 又开始顶掉 CAPACITY。现在的顺序是
**按价值从低到高撤**：

1. 先撤 `$ore` 用法提示 —— 它是**教学**（撤掉后算子仍可用，模型自己想到照样能用）
2. 还不够才撤整条资源行 —— 它是**事实**

「加一段新信息永远不许让已有信息变少」这条纪律，在预算路径上同样适用。

---

## 五、真机验证：矿机落在铜矿上了

```
实体: 63 → 64 (+1 / -0)
round 1: partial=false ops=1 calls=[insert_machine]
```

落地后查世界：

```
uid=10505 @(2,-6)   矿: RuRuRuRu
uid=10506 @(3,-6)   矿: RuRuRuRu
uid=10507 @(4,-6)   矿: RuRuRuRu
uid=10553 @(4,-16)  矿: **无矿**
uid=10615 @(-9,3)   矿: CuCuCuCu    ← 新增的，正在铜矿上挖
```

**模型用 `{"$ore":"Cu"}` 把矿机放到了铜矿上，全程没写过一个坐标。**

---

## 六、踩过的坑（已写进代码注释）

### `normalizeHandles` 的产物没有 x/y

第一版给矿机加标注时写了 `e.x` / `e.y`，结果**每一台矿机都被标成「没矿」** ——
包括脚下明明有钌的那三台。

原因：`normalizeHandles` 只保留 `handle/type/variant/uid/desc` 五个字段，
**位置不属于身份**（这是「prompt 不含坐标」的第一层保证）。

正确做法是按 `uid` 从 `obs.entities` 回查坐标。

这种"全错"比不标更糟：它会让模型去拆掉本来正常的矿机。

### `assertProvenance` 的签名是 `(resolved, txPlan, obs, opts)`

我第一次写成了 `assertProvenance(calls, {obs, knownTokens})` —— `obs` 传进了
`txPlan` 的位置，于是 `checkTag` 拿到的 `obs` 是 undefined，
`nearestOreCell` 恒返回 null，报「现在没有 Cu 这种矿」。

---

## 七、测试

| 文件 | 用例 | 说明 |
|---|---|---|
| `coords_ore.test.mjs` | 10 | `$ore` 全链路 |
| `prompt_resource.test.mjs` | 12 | 目标矿段 + 矿机标注 |
| `tohub_machine.test.mjs` | +2 | CAPACITY 优先于资源行 |

全量 **426/426 通过**。

变异测试：M1（用 `e.x/e.y` 的 bug）、M2（永远说 NO ORE）、M3（永远说 mining）、
M4（资源行永远紧凑）全部能被抓到。

⚠️ **诚实说明**：`tohub_machine.test.mjs` 的 G 用例（「预算紧张时资源行让位」）
在**当前夹具上抓不到**「去掉让位逻辑」那个变异 —— 因为 `budget:{}` 配置下
L4 的 room 本来就够，让位分支根本不触发（实测：变异体里 CAPACITY 仍然存在）。
那两条守的是「CAPACITY 不许因为加了资源行而消失」这个**结果**，
不是让位这段实现本身。要真钉住它得造一个「刚好差几个字符」的夹具，
这里选择不造 —— 让位是防御性代码，它的失败模式已经从结果侧守住了。

---

## 八、下一轮

1. **矿机放上去了，但产线还没接通**。这一轮只验证了「矿机落在铜矿上」，
   没验证「它产的铜能流到 cutter → rotater → hub」。
   下一步要在真机上跑 tick，看 `CuCuCuCu` 有没有真的开始产。
2. **`$ore` 只给「最近的一格」**。如果那一格被占（别的机器压着），
   模型没有第二个选择。可能需要 `{"$ore":"Cu","part":"any"}` 那种反解 origin 的形态，
   或者允许它接受一个「排除列表」。
3. `partial` 仍然没触发过 —— 这一轮的真机 run 里出现过 `partial=false` 的执行轮次，
   但「有失败 + 剩可撤销」那个夹在中间的场景还是没出现过。
