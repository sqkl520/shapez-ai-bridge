# C 调研的四条修正：独立核实

日期：2026-10-28
来源：补完 C 报告的 agent 报告了四处修正，我逐条核实。

---

## 修正 1：`leftEdge` 早就实现了，不是缺口

`src/ai/compiler/lane.mjs:348`：

```js
export function leftEdge(intervals, opts = {}) {
    const maxTracks = opts.maxTracks == null ? 32 : assertInt(...);
```

区间图着色（VLSI 轨道分配）**已经在代码里**，而且有 27405 例穷举验证
（`place.mjs:565` 有引用）。

**含义**：C 报告原来说"V6-crossing 该用 Left-Edge"，但它已经用了。
问题不在轨道分配算法，在别处。

## 修正 2：`routeAll` 缺 rip-up

`route.mjs:389`：

```js
export function routeAll(report, opts = {}) {
    ...
    const lane = assignLanes(report, opts);
    const failures = [];
```

失败后只是记录到 `failures`，**没有重路由（rip-up and reroute）**。

C 报告修正后把「放宽走廊几何」提到第一优先，而不是加 pin assignment。

## 修正 3：只允许一个产出端，所以是 1×16 不是 N×16

`place.mjs:373`：

```js
const terminals = nodes.filter(n => n.consumers === 0 && n.op !== "trash");
if (terminals.length > 1 && opts.allowMultiTerminal !== true) {
    return makeFailure("out-of-scope:multilayer", ...,
        `产出端 ${terminals.length} 个：v1 只画一条产出线 ...`);
}
```

**多终端直接就是 `out-of-scope:multilayer`。**

所以 hub 入口分配是 **1×16**（一条产出线 × 16 个入口），不是 N×16。
**没有组合爆炸，加 pin assignment（匈牙利算法）是空转。**

修正后的判断："hub 入口分配"被误判为 terminal assignment，
实际是**走廊争用** —— 入口是症状，走廊是病。

## 修正 4（我独立测的）：16 个入口只有 3 个被占

实测 181 实体存档：

```
✗ (-2,-3) top 被占    ✓ (-2,2) bottom    ✓ (-3,-2) left    ✓ (2,-2) right
✗ (-1,-3) top 被占    ✓ (-1,2) bottom    ✓ (-3,-1) left    ✓ (2,-1) right
✓ (0,-3) top          ✓ (0,2) bottom     ✓ (-3,0) left     ✓ (2,0) right
✗ (1,-3) top 被占     ✓ (1,2) bottom     ✓ (-3,1) left     ✓ (2,1) right

被占: 3 / 16
```

**13 个入口是空的。**

## 由此暴露的一个诊断质量问题（新发现）

编译器报错说：

> `hub 的 16 个入口都接不上：竖直收集带被占或需隧道绕行（scope.tunnels:false）`

出自 `place.mjs:2492`，是**硬编码字符串**。

但实测 13/16 入口是空的。这句话把「某个终端节点的路径没路由成功」
说成了「hub 满了」。

**这是把局部失败说成全局资源不足。** 会让调用方得出错误结论（以为要扩建 hub）。

已同步给正在做编译器降级的 agent 一起修。

---

## 对方向判断的影响

C 报告修正后的结论，和我之前的综合有一处不同：

| 之前 | 修正后 |
|---|---|
| hub 入口分配是 pin assignment，用匈牙利算法 | **是走廊争用，pin assignment 用不上** |
| V6-crossing 该用 Left-Edge | **Left-Edge 已经在用了**，缺的是 rip-up |
| 建议加 ~80 行 pin assignment | **建议 0 行，明确不做** |

**真正的缺口是 `Grid.clone()`**（`grid.mjs:484`）—— 回滚基建早就建好，
但 `route.mjs` 里 0 次调用。rip-up 需要它，却从没接线。

这是一个"基建建好没接"的典型，比"缺算法"更便宜修。
