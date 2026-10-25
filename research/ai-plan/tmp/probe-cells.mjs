import { resourcesInRegion } from '../../../src/ai/world.mjs';
const cells = resourcesInRegion(43391, { x0: -400, y0: -400, x1: 400, y1: 400 });
const at = new Map(cells.map(([x,y,s]) => [`${x},${y}`, s]));
console.log('y=-12:', [-120,-93,-76].map(x => `${x}:${at.get(`${x},-12`)}`).join(' '));
console.log('y=22 :', [-155,-61,-31].map(x => `${x}:${at.get(`${x},22`)}`).join(' '));
// CgScScCg best order green green Su blue Cu at y=54
console.log('y=54 :', [-268,-267,-126,-92,-44].map(x => `${x}:${at.get(`${x},54`)}`).join(' '));
