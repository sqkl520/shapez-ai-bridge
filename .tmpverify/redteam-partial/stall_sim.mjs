/**
 * Q3：按 loop.mjs:1587-1635 的**真实键构造**（fp + actionSetHash(lastMacros)）模拟 3 轮计数，
 * 比较「现状（世界不变）」与「部分执行（世界变 ⇒ fp 变）」下 mustChange / NO_PROGRESS_3X 什么时候触发。
 */
const ROUNDS_MAX = 3;
function sim(worldChangesEachRound) {
  const seen = new Map();
  let lastMacros = [];
  const log = [];
  for (let r = 1; r <= ROUNDS_MAX; r++) {
    const fp = worldChangesEachRound ? `F${r - 1}` : "F0";
    const act = ["A", "B", "C"].map((x, i) => (i < lastMacros.length ? lastMacros[i] : "")).join("") || "∅";
    const key = `${fp}#${act}`;
    const rec = seen.get(key) || { count: 0 };
    rec.count++;
    seen.set(key, rec);
    let halt = null, mustChange = false;
    if (rec.count >= 3) halt = "NO_PROGRESS_3X";
    else if (rec.count === 2) mustChange = true;
    log.push(`r${r}: key=${key} count=${rec.count} mustChange=${mustChange} halt=${halt || "-"}`);
    /* 模型每轮换一个动作（最坏情况下它重复同一套） */
    lastMacros = r % 2 ? ["connect"] : ["connect"];
  }
  return log;
}
console.log('=== 现状：世界不变（全有或全无 ⇒ 一条都没落盘）===');
for (const l of sim(false)) console.log('  ' + l);
console.log('\n=== 部分执行：世界每轮都变 ⇒ fp 每轮都换 ===');
for (const l of sim(true)) console.log('  ' + l);
console.log('\n结论：世界每轮都变时，键每轮都是新的 ⇒ count 恒为 1');
console.log('      ⇒ mustChange 从不触发（所以第 2/3 轮不再被要求换动作）');
console.log('      ⇒ NO_PROGRESS_3X 也从不触发（它需要同一键出现 3 次）');
console.log('      ⇒ 唯一的止损是 ROUNDS_MAX=3（硬上限，与指纹无关）');
