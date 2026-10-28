import * as SHAPE_OPS from "file:///D:/Projects/rea/Project%20work/shapez/research/ai-player/proto/shape-ops.mjs";
const h = SHAPE_OPS.cutHalf(SHAPE_OPS.parse("RuRuRuRu"));
const a = SHAPE_OPS.stringify ? SHAPE_OPS.stringify(h[0]) : h[0];
const b = SHAPE_OPS.stringify ? SHAPE_OPS.stringify(h[1]) : h[1];
console.log("h[0] (slot0 / 'left'  → 输出格 (x, y-1))  :", a);
console.log("h[1] (slot1 / 'right' → 输出格 (x+1, y-1)):", b);
console.log("目标 RuRu---- =", a==="RuRu----" ? "h[0] → left 槽" : (b==="RuRu----" ? "h[1] → right 槽" : "两者都不是"));
