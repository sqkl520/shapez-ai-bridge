import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runLoop } from '../../src/agent/loop.mjs';
import FakeGame from '../../src/agent/fake_game.mjs';

// 模拟「模型靠不停换动作刷轮次」：每轮都发一条不同的、注定失败的 connect
const VARIANTS = ['M1','M2','M3','M4','M5','M6','M7','M8'];
const g = FakeGame.fromFiles(
  path.join('test/fixtures/saves','L4-obs.json'),
  path.join('test/fixtures/saves','L5-items.json'),
  { goal: 'RuRu----' });
let round = 0;
const client = { async propose() {
  const m = VARIANTS[Math.min(round, VARIANTS.length - 1)];
  round++;
  return { text: JSON.stringify({ say: 'try '+m, calls: [
    { macro: 'connect', args: { from: { $ref: m }, to: { $ref: 'H1' } }, why: 'grind' }] }), usage: null, raw: null };
} };
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'grind-'));
const res = await runLoop({ reader: g.reader(), goal:'RuRu----', llmClient: client, mode:'mock', runDir: dir, game: g,
  budget:{ ROUNDS_MAX: 8, LLM_CALLS_MAX: 20 } });
console.log(`刷轮次测试：ROUNDS_MAX=8，每轮换一个 miner`);
console.log(`  outcome=${res.outcome} reason=${res.reason} rounds=${res.rounds} llm_calls=${res.llm_calls}`);
console.log(`  → 轮次是否被 ROUNDS_MAX 拦住？`, res.rounds <= 8 ? 'YES' : 'NO');
fs.rmSync(dir,{recursive:true,force:true});
