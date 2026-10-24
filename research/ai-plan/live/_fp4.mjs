import { computeBelt } from "../../../src/ai/compiler/belt-sim.mjs";
// 对给定的段（entryWorld → exitWorld 与邻居集），求一个 orig 使 computeBelt 落在目标 (rot,rv)。
// 这是编译器该做的：不是 orig=rot，而是解不动点。
export function solveOrigForFixedPoint({ wantRotation, wantVariant, neighbors }) {
    for (const orig of [0, 90, 180, 270]) {
        const r = computeBelt({ rotation: orig, neighbors });
        if (r.rotation === wantRotation && r.rotationVariant === wantVariant) return orig;
    }
    return null;
}
// 测：P7-F2 场景（左邻朝右喷）+ 目标 (r0,rv2)
const nsPull = [{ toDirection: 'right' }];
console.log('PULL 场景 → 目标(r0,rv2) 的 orig:', solveOrigForFixedPoint({ wantRotation: 0, wantVariant: 2, neighbors: nsPull }));
// 真实工厂那 23 个格：目标 (r90,rv2) / (r180,rv1) 等
for (const [wr, wv, label] of [[90,2,'真实例 15,12'],[180,2,'上部拐角'],[90,1,'左弯']]) {
  console.log(label, '→', solveOrigForFixedPoint({ wantRotation: wr, wantVariant: wv, neighbors: nsPull }));
}
