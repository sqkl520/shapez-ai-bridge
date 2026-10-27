# 截图重做：从「截窗口」到「按区域离屏渲染」

日期：2026-10-27
改动：`src/mod/shapez-ai-bridge.js` 的 `screenshot` 全部重写

---

## 旧实现的三个硬缺陷（都实测踩到过）

### 1. HUD 和世界画在同一张 canvas 上

`recon/upstream-full/src/js/game/core.js:490`：

```js
root.hud.draw(params);   // ← 世界内容画完之后，最后一步
```

所以 `root.canvas.toDataURL()` 必然把工具栏、任务面板一起截进去。

### 2. 截的是「窗口现在什么样」，不是「我要看哪块」

- 相机是**平滑插值**（`camera.js:983`），每步只走 0.8%
- 窗口不可见时 `shouldRender()` 直接返回 false（`core.js:303-313`），
  canvas 停在上一帧
- `clampToBounds()` 会把相机中心夹到地图边界

实测：设完 camera 等 3 秒截到的还是旧位置；窗口不可见时 12 秒相机纹丝不动。

### 3. 没有区域捕获

想截「某个 bbox 里有什么」只能先把相机挪过去，结果受窗口尺寸与 DPI 影响，
不可复现。

---

## 新实现：自己建离屏 canvas，调游戏自己的绘制函数

不碰 `root.canvas`，而是：

```js
const cv = document.createElement("canvas");
const ctx = cv.getContext("2d");
ctx.scale(dpi, dpi);
ctx.fillStyle = THEME.map.background;  ctx.fillRect(...);

// 自建 DrawParameters（与 core.draw 同形）
const params = new DrawParameters({ context: ctx, visibleRect, desiredAtlasScale, zoomLevel, root });

// 变换到世界空间（等价于 camera.transform，但用我们算的 zoom/left/top）
ctx.transform(zoom, 0, 0, zoom, -zoom*left, -zoom*top);

// 按 core.draw 的顺序画，但**不调 root.hud.draw**
root.map.drawBackground(params);
systems.belt.drawBeltItems(params);
root.map.drawForeground(params);
systems.hub.draw(params);        // 可用 hideHubPanel 跳过
```

### 得到的好处

| | 旧 | 新 |
|---|---|---|
| HUD | 一定带上 | **默认不带** |
| 取景 | 窗口现在的样子 | **`region` 指定 bbox，可复现** |
| 相机 | 插值，要等 | **瞬移，不需要等** |
| 窗口不可见 | 截到过期画面 | **不受影响** |
| 输出尺寸 | 跟随窗口 | **任意指定，长边上限保护** |
| 能否复现 | 否 | **是**（返回实际 `view_px`） |

---

## 用法

```js
// 按区域截图（推荐）—— 世界格坐标，自动算 zoom 让整块刚好放下
{ "region": [-11,-16,7,6], "width": 1500, "height": 850 }

// 隐藏 hub 面板（它会盖住周围一大片世界内容）
{ "region": [...], "hideHubPanel": true }

// 需要 HUD 才给 hud
{ "hud": true }
```

### 返回字段（用于断言与复现）

```json
{
  "png_base64": "...",
  "w": 1500, "h": 850,          // 实际像素
  "css_w": 1500, "css_h": 850,  // 逻辑尺寸
  "dpi": 1,
  "zoom": 1.125,
  "hud": false,
  "hub_panel_hidden": true,
  "world_rect": { "cells": [...], "px": [...], "view": [...] },
  "view_px": [left, top, visW, visH],
  "drew": ["mapBackground","beltItems","mapForeground"],
  "skipped": [{"step":"hub","reason":"..."}]
}
```

`drew` / `skipped` 很重要：**画了几层是可见的**，不会静默漏画。

---

## hub 面板不是 HUD

这是这轮排查里最关键的一个发现。

`systems/hub.js:51` 的 `redrawHubBaseTexture` 把「交付 / 0 / 170 / 解锁 隧道」
这些**烘焙进 hub 实体的贴图**，不是 HUD 的一部分。所以：

- 跳过 `root.hud.draw` **拿不掉**它
- 只能跳过 `systems.hub.draw`

`hideHubPanel: true` 时不画 hub sprite，改用红色半透明块标出 hub 的 4×4 位置。

### 效果对比

| 文件 | hub 面板 | 能看到什么 |
|---|---|---|
| `shot-withhub.png` | 有 | hub 周围被挡住 |
| `shot-hidehub.png` | **无，只有红框** | hub 上方的进料带、左边的汇流、右边的钌线全露出来 |

---

## 排查过程中用的探测 RPC

新增 `debug_canvas_api`，把离屏绘制需要的构造器/字段在**真实运行时**报出来：

```
shapez_global_present: true
drawParameters_ctor_test: { ok: true, keys: [...] }
hub_component_names: [{ uid: 10000, comps: ["StaticMapEntity","Hub","ItemProcessor","WiredPins","ItemAcceptor"] }]
tileSize: 32   dpi: 1
```

这两条都是**猜错过**才加的探针：

- `window.shapez` 的 `Object.keys()` 返回 0（都是非 enumerable），
  但 `shapez.DrawParameters` 实际可用 —— 只能靠试着构造来确认
- hub 的组件名叫 **`Hub`**，不是我猜的 `HubComponent` ——
  没有这个探针，红色标记会静默不显示

---

## 仍然做不到的

1. **不能真的"隐身"**：`hideHubPanel` 只是不画 hub sprite，
   hub 的 4×4 占地仍然被色块盖着（虽然半透明）。要看 hub 内部细节还是不行。
2. **依赖游戏内部 API**：`DrawParameters` / `root.map.drawBackground` 这些是游戏私有方法，
   换版本可能改名。所以每次失败都要靠 `drew` / `skipped` 看是哪一层断了。
3. **不是像素级确定性**：纹理图集精度按 zoom 选（`0.25` / `0.5` / `1.0`），
   不同 zoom 下贴图细节不同。
