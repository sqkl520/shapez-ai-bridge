import fs from "fs";

/**
 * 截图 + 元数据一起存 —— 之后才能反推「你指的那个像素是哪一格」。
 *
 * ## 为什么必须存 world_rect
 *
 * `obs.camera` 和截图是**两个时刻**读的，实测会差很多：
 *   截图自己报告 zoom=1.136，而之后拉 obs 时 camera.zoom=1.715。
 * 用 camera 反推会偏出去十几格。
 *
 * 而 `screenshot` 的返回值自带 `world_rect: {cells, px}` ——
 * 那是**这张图实际画的区域**，同一时刻算出来的。存下它就没有偏差。
 *
 * 用法：
 *   node snap.mjs [左,上,右,下]           # 默认拍 hub 周围
 *   → 写 research/ai-plan/shot.json（含 png + world_rect）
 *   → 写 research/ai-plan/shot.png（给人看）
 */
const args = process.argv.slice(2);
const region = args.length === 4 ? args.map(Number) : [-26, -26, 62, 62];
const body = {
    jsonrpc: "2.0", id: 1, method: "screenshot",
    params: { region, width: 1100, height: 1100 },
};
const res = await fetch("http://127.0.0.1:7777/rpc", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const j = await res.json();
if (j.error) { console.log("ERR " + JSON.stringify(j.error).slice(0, 300)); process.exit(1); }
const r = j.result;
/* 存 png 供人看，存 world_rect 供反推 */
fs.writeFileSync("research/ai-plan/shot.png", Buffer.from(r.png_base64, "base64"));
fs.writeFileSync("research/ai-plan/shot.json", JSON.stringify({
    css_w: r.css_w, css_h: r.css_h, dpi: r.dpi, zoom: r.zoom,
    world_rect: r.world_rect,
}, null, 1));
console.log("截图已存: research/ai-plan/shot.png  (" + r.css_w + "×" + r.css_h + ")");
console.log("覆盖格子: " + JSON.stringify(r.world_rect.cells));
console.log("你现在可以说「图里某个像素位置 (x,y)」，我用 what.mjs 反推是哪一格。");
