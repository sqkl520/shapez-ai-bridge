/* trash 落盘后可不可逆？逐个宏试一次。 */
import fs from 'node:fs';
import { removeRun, replaceRun, trashUnused } from '../../src/agent/macros/remove.mjs';
import { insertMachine, extendLine } from '../../src/agent/macros/place.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const ents = OBS.entities;
const trash = ents.find(e => e.type === "trash");
console.log('世界里的 trash:', JSON.stringify(trash));
if (!trash) { console.log('没有 trash，跳过'); process.exit(0); }
const T = trash.uid, cell = [trash.x, trash.y];

const show = (name, r) => console.log(`  ${name.padEnd(16)} ${r.ok ? "OK → " + JSON.stringify(r.cells_placed ?? r.cells?.length ?? "") : `${r.error.code}: ${r.error.message}`.slice(0, 120)}`);

show('remove_run(uid)', removeRun({ uids: [T] }, { entities: ents }));
show('remove_run(cell)', removeRun({ cells: [cell] }, { entities: ents }));
show('replace_run(1cell)', replaceRun({ region: [cell[0], cell[1], cell[0], cell[1]], building: 'belt' }, { entities: ents }));
show('extend_line', (() => { try { return extendLine({ from: { uid: T }, to: { uid: T } }, { entities: ents }); } catch (e) { return { ok: false, error: { code: 'throw', message: String(e.message) } }; } })());
show('connect(from trash)', connect({ from: { uid: T }, to: { uid: ents.find(e => e.uid !== T)?.uid } }, { entities: ents }));
show('insert_machine(trash)', insertMachine({ machine: { kind: 'trash' }, at: { uid: T } }, { entities: ents }));
