# P14 —— `$ore` 提示的 A/B：方向对，但不显著

日期：2026-11-04
前置：P13 发现「150 个真实样本里 `$ore` 出现 0 次」并修了预算降级顺序。这一轮验证那个修复有没有用。

---

## 1. 实验设计（严格单变量）

两臂用**同一份** obs / 诊断 / 候选 / 预算（16000），唯一差别是 prompt 里那行：

```
(`{"$ore":"Ru"}` anywhere a cell is expected = the nearest Ru ore tile — use it as insert_machine.at)
```

`## CANDIDATE MACROS` / `## DIAGNOSIS` / `## MACHINES` / `## BELTS` / CAPACITY 全部逐字节相同。
system 段是模块常量，天然相同。

自检（每次跑都先过）：

```
OK   两臂 system 逐字节相同
OK   两臂字符数只差那一行（12165 vs 12063，差 102）
OK   ON 臂含 $ore
OK   OFF 臂不含 $ore
OK   两臂其余内容相同（删掉提示后完全一致）
```

装置：`.tmpverify/ore-ab/ab.mjs`。两轮共 16 个样本（n=8 每组）。

---

## 2. 结果

| 指标 | ON（有提示） | OFF（无提示） |
|---|---|---|
| `used$ore`（args 里真出现 `"$ore"`） | **1/8** | 0/8 |
| `saysStuck`（说"不知道怎么指定位置"） | **1/8** | 3/8 |
| `remove_run` | 2/8 | 2/8 |
| `insert_machine` | 1/8 | 0/8 |
| `trash_unused` | 3/8 | 2/8 |
| `replace_run` | 4/8 | 6/8 |
| `connect` | 2/8 | 4/8 |

95% 置信区间（Wilson）：

```
ON   used$ore 1/8 [0.02, 0.47]   saysStuck 1/8 [0.02, 0.47]
OFF  used$ore 0/8 [0.00, 0.32]   saysStuck 3/8 [0.14, 0.69]
```

**区间全部重叠 ⇒ 不显著。** 要区分两臂需要每组 n≈20+。

---

## 3. 唯一一次真的用了

ON 臂第一次实验的第二次调用：

```json
{"macro":"insert_machine",
 "args":{"at":{"$ore":"Ru"},"facing":"top","machine":"miner"},
 "why":"M4 sits on no ore, so its 7 chains are dead; ..."}
```

这是**此前所有实验里从未出现过**的动作：模型精确地指名一块钌矿，然后在上面放矿机。
在此之前（150 个样本）`$ore` 出现 0 次，而 95/150 说「不知道怎么指定位置」。

**所以「提示缺失 → 模型不知道有这个算子」这条因果是成立的**（0/150 vs 有提示时 1/8 且 OFF 仍 0/8）。
但「给了提示 → 模型就会用它」这条**不成立** —— 8 次里只用 1 次。

---

## 4. 诚实的结论

### 成立
- `$ore` 提示被预算吃掉是**真缺陷**，P13 的修复有据（0/150 → 提示稳定出现）。
- 提示在时，模型**有能力**用它（1 次实证）。
- `saysStuck` 方向一致（1/8 vs 3/8）—— 有提示时更少说"卡住"。

### 不成立
- 「修完提示，`remove_run` 采用率就会上来」——**没有证据**。两臂都是 2/8。
- 「提示能显著改变行为」——n 太小，区间重叠。

### 我上一轮的判断哪里错了
P13 结尾我写「下一步要重跑那批实验，才能知道 `remove_run` 的采用率会不会自然上来」。
重跑了：**不会**。`remove_run` 两臂都是 2/8，提示与否无关。

也就是说：「模型不愿拆」这件事与 `$ore` 提示无关，是另一个独立的问题。
P13 里我把它归因到「不知道怎么指定位置」，那个归因**只解释了一部分**。

---

## 5. 那 `remove_run` 到底为什么少

看 ON 臂那 2 次用 `remove_run` 的 say：

```
"Clear the two dead-end belt exits, delete M4's ore-less dead chain, and feed B131 from L7's free output."
"The M4 miner sits on no ore, so its entire belt branch is permanently dead;
 removing that stale run clears the CHAIN_UNFED blocker."
```

它**只在「明确知道这段是死链」时才拆**，而且拆的时候要能说清后果。
OFF 臂那 2 次也是同样的模式。

而 6/8 的样本选了 `replace_run` —— 那个宏**同时**能做「改朝向」和「换机器」，
是一个更"安全"的选择：它不减少实体数，不触发 `would_disconnect`。
**模型在不确定后果时偏好不删。**

这是一个**风险偏好**问题，不是提示词问题，也不是能力问题。
要改它得动评分/激励（比如让 `remove_run` 的更便宜、或让 `replace_run` 报出它的代价），
那是另一件事，需要先有「模型因为怕破坏而不敢拆」的直接证据。

---

## 6. 下一步建议

1. **别再调 `$ore` 提示了** —— 它现在是有效的（0/150 → 稳定出现），再调收益低。
2. **要验证 `remove_run` 少的原因，得换一个实验**：给两臂「完全等价的两种修法」
   （一种用 `replace_run`、一种用 `remove_run`），看模型选哪个、why 说什么。
   那能直接测「风险偏好」这个假设。
3. 如果确实证明模型在规避风险，可以考虑让 `replace_run` 在 `would_disconnect` 时
   **也**报出代价 —— 现在只有 `remove_run` / `remove_machine` 报。
   那会让两种修法在信息上对等。

---

## 7. 数据位置

- `.tmpverify/ore-ab/ab.mjs` —— 实验装置（含自检）
- `.tmpverify/ore-ab/results.json` —— 第一轮 n=2
- `.tmpverify/ore-ab/results-6.json` —— 第二轮 n=6
- `.tmpverify/ore-ab/summary.mjs` —— 汇总 + Wilson 区间
