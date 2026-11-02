/**
 * 封死之后，语义层能不能说出「目标形状正被倒进垃圾桶」？
 * 如果能，部分执行造成的伤害至少是可见的；如果不能，那就是隐形破坏。
 */
import fs from 'node:fs';
import { diagnose } from '../../src/agent/loop.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { trashUnused } from '../../src/agent/macros/remove.mjs';
import { recipeForCached } from '../../src/agent/loop/recipe.mjs';

const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const recipe = recipeForCached('RuRu----', { level: 4 });
console.log('recipe:', recipe && recipe.ok, JSON.stringify(recipe && recipe.steps || recipe && recipe.reason));

const tr = trashUnused({ outlet: { uid: 10008 } }, { entities: OBS.entities });
const OBS2 = JSON.parse(JSON.stringify(OBS));
OBS2.entities.push({ uid: 99999, type: "trash", x: tr.trashCell[0], y: tr.trashCell[1], r: 0, variant: "default", code: 20 });

for (const [label, o] of [["before", OBS], ["after (trash 封住 B129 出口)", OBS2]]) {
  const d = diagnose(o, null, null, null, 'RuRu----', buildHandles(o, null), { recipe });
  console.log(`\n${label}: ${d.length} 条`);
  for (const x of d) console.log(`  ${x.code}/${x.severity} ${x.subject.handle}: ${String(x.observed).slice(0, 110)}`);
}
