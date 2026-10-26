// 第三轮验收：自己跑一遍全部要点
import * as G from "file:///D:/Projects/rea/Project%20work/shapez/src/agent/gates.mjs";
async function rpc(method, params) {
  const res = await fetch('http://127.0.0.1:7777/rpc', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: Math.random(), method, params }),
  });
  const b = await res.json();
  if (b.error) throw new Error(JSON.stringify(b.error));
  return b.result;
}
let pass = 0, fail = 0;
const ok = (c, l) => { c ? (pass++, console.log("✓ " + l)) : (fail++, console.log("✗ " + l)); };

console.log("=== 1. step 安全性 ===");
{
  const a = await rpc('debug_loop', {});
  const s = await rpc('act', { op: 'step', ticks: 1200 });
  const b = await rpc('debug_loop', {});
  const dt = b.tick - a.tick;
  ok(s.ticks_run === 1200, `step 1200 → ticks_run=1200`);
  ok(Math.abs(dt - 10) < 1, `tick 推进 ${dt.toFixed(2)} 秒（期望 10±1）`);
}

console.log("\n=== 2. 时间片在 step 期间轮转 ===");
{
  const p1 = await rpc('production', { slices: 4 });
  await rpc('act', { op: 'step', ticks: 3600 });
  const p2 = await rpc('production', { slices: 4 });
  ok(JSON.stringify(p1.delivered_slices) !== JSON.stringify(p2.delivered_slices), "片内容有变化");
}

console.log("\n=== 3. step 不放大速率 ===");
{
  const I = { goal: "RuRuRuRu", anchor:[0,0], entities:[] };
  const p1 = await rpc('production', { slices: 6 });
  const rLive = G.gateG6(I, p1, p1, 0.8).evidence.rate;   // 实时
  const pA = await rpc('production', { slices: 6 });
  await rpc('act', { op: 'step', ticks: 7200 });
  const pB = await rpc('production', { slices: 6 });
  const rStep = G.gateG6(I, pA, pB, 0.8).evidence.rate;
  const ratio = rLive > 0 ? rStep / rLive : 1;
  ok(Math.abs(ratio - 1) < 0.5, `实时 ${rLive} vs step 后 ${rStep}（比值 ${ratio.toFixed(2)}，修前 2.68）`);
}

console.log("\n=== 4. await 正常 ===");
{
  const t0 = (await rpc('debug_loop', {})).tick;
  const r = await rpc('act', { op: 'await', until: 'entities_changed', timeout_ticks: 1200 });
  const t1 = (await rpc('debug_loop', {})).tick;
  ok(r.ticks_run === 1200, `await ticks_run=1200`);
  ok(Math.abs((t1-t0) - 10) < 1.5, `await 推进 ${(t1-t0).toFixed(2)} 秒`);
}

console.log("\n=== 5. G6 基线逻辑 ===");
{
  const I = { goal:"RuRu----", anchor:[0,0], entities:[] };
  const S = (p,n=6) => ({ slice_seconds:10, delivered_slices:Array.from({length:n},()=>({"RuRu----":p})), produced_slices:[] });
  ok(G.gateG6(I, S(0), S(10), 0.4).ok, "贴前0 → 贴后1.0：绿");
  ok(!G.gateG6(I, S(10), S(10), 0.4).ok, "贴前1.0 → 贴后1.0：红");
  ok(G.gateG6(I, S(10), S(15), 0.4).ok, "贴前1.0 → 贴后1.5：绿");
  const E = { slice_seconds:10, delivered_slices:Array.from({length:6},()=>({})), produced_slices:[] };
  ok(G.gateG6(I, E, E, 0.4).undecidable === true, "全空片：undecidable");
}

console.log(`\n总计：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
