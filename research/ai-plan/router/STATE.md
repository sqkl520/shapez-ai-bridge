# P4 router — STATE.md

## 最终状态：完成
命令：
- L0 主测试：`node research/ai-plan/router/test.mjs` → **184 断言全绿**
- 变异测试：`node research/ai-plan/router/mutate.mjs` → **19/19 全被抓，0 存活**
- 逐条说明与发现的 bug：`NOTES.md`（同目录）

## 接管时现场
`route.mjs`(525)+`lane.mjs`(642) 语法完整、`test.mjs` **128 断言全绿**（草稿），
缺「⑬ 报告更新契约」。前任死在最后一公里。

## 我做的事（绿测试当草稿重挣）
1. **亲自复跑 128 绿**（不是抄前任口头成绩）
2. **补齐 ⑬**（lanes 填上 / resolvedBy 保留 / channels↔lane 互逆 + 透传字段 + 判死不谎称解决）
3. **建 19 组变异测试**（mutate.mjs：影子副本 + 源码定点破坏 + 跑主测试断言必红）
4. **揪出并修 3 个真 bug**（各配变异锁，M-18/M-14/M-16 证明非空断言）：
   - R-1 `routeAll` ok:false 时 reason 可为 null（counter 分支不参与 reason 推导）—— 可达输入=P3 ordinal 撞号
   - R-2 `assignLanes` 未落车道的通道保留 P3 陈旧 lane 数字 → ⑬ 互逆破裂
   - R-3 `leftEdge` 扫描序平局用 localeCompare → ICU/locale 相关，跨机器 lanes[] 不同（违验收7确定性）
5. **识别 1 个等价变异陷阱**（M-11 第一版假变异，NOTES R-4：判永绿前先判可达）
6. **语义声明改成可证伪锁**（M-19：原 say(true) 是永绿空断言，换成「route/lane 不得出现 computeBelt/belt-sim」）

## 验收映射（plan §1.4 + 执行书 9 条）
- ① 链闭合双侧判据 → test ① + 外部重算 + M-1
- ② 12 组恒等（自洽非语义）→ test ② + 语义边界锁 M-19
- ③ 端点对齐 + M4 金样例逐字 → test ③ + M-5
- ④ 退化段一格 / 180° 无解 → test ④ + M-3/M-4
- ⑤ 陷阱回归锁 → test ⑤（含同 id 双通道可达性）+ M-8/M-10/M-18
- ⑥ 报告更新契约（⑬）→ test ⑬ + M-14/M-15
- ⑦ 确定性 → test ⑫ + M-16
- ⑧ 变异逐断言非永绿 → mutate.mjs 19/19
- ⑨ grep lint 无 proto import → test ⑥ + P1 权威 lint（route/lane 各 zero violations）

## 铁律遵守
零依赖 / 未 git commit / 未碰桥接 / 未碰 place.mjs（P3 在改）/ 未 import proto 或 P3/P5/P6/P8
别人 bug 只写 NOTES R-5 点名（place.mjs 的 ordinal 撞号、types.mjs 缺 ⑬ 互逆硬闸）
