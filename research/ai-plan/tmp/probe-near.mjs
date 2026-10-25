import { resourcesInRegion } from '../../../src/ai/world.mjs';
for (const R of [64, 128, 200]) {
  const cells = resourcesInRegion(43391, { x0: -R, y0: -R, x1: R, y1: R });
  const c = {};
  for (const [, , s] of cells) c[s] = (c[s] || 0) + 1;
  console.log(`±${R}: red=${c.red||0} blue=${c.blue||0} green=${c.green||0} Cu=${c.CuCuCuCu||0} Su=${c.SuSuSuSu||0}`);
}
