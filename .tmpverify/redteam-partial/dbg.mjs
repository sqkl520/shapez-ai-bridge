import fs from 'node:fs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { planToTxOps } from '../../src/agent/loop/planToTxOps.mjs';
import { trashUnused } from '../../src/agent/macros/remove.mjs';
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const r = trashUnused({ outlet: { uid: 10008 } }, { entities: OBS.entities });
const tp = planToTxOps([{ macro: 'trash_unused', args: { outlet: { uid: 10008 } }, result: r }], { obs: OBS, items: null });
console.log('ops:', JSON.stringify(tp.ops));
console.log('placements:', JSON.stringify(tp.placements));
