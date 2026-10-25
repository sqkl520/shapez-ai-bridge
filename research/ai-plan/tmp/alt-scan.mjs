// 不用隧道，能否靠「换 lane 行」避开？
// 两条失败通道是 Z 形，各需一条车道行。若它们选不同的行，就不撞。
import { planChannel } from '../../../src/ai/compiler/place.mjs';
const DIRV = { top:[0,-1], right:[1,0], bottom:[0,1], left:[-1,0] };

// 通道 A: -b------(-219,54) → mix(-219,46)。直线，无需 lane。
//   但 first=(-219,53) last=(-219,45)，就是同列直下 ⇒ straight。
//   失败是因为 (-219,48) 被 ch1 占了 —— ch1 是 -g------(-265,54) → mix
// ch1: first=(-265,53)，last=(-219,45)? mix 的 slot1 在 (mix.x+1, mix.y) = (-218,46) 朝 bottom ⇒ last=(-218,45)
console.log('ch1: (-265,53) → (-218,45)  需要 Z，车道行在 46..52 之间');
for (let lane = 46; lane <= 52; lane++) {
  const r = planChannel([-265,53],'top',[-218,45],'bottom',{});
  if (r.ok) console.log('  默认 lane =', r.lane, r.kind);
  break;
}
// 关键：ch1 的 Z 车道行如果选 48，就会占 (-219,48)？
// Z 形：(-265,53) 竖直向上到 (-265,lane)，横走到 (-218,lane)，再竖直向下到 (-218,45)
// 若 lane=48：横走段是 y=48 从 -265 到 -218，**包含 (-219,48)** ← 这就是冲突源
console.log('\n如果 ch1 的车道行是 48，横走段 y=48 会经过 (-219,48)');
for (const lane of [46,47,49,50,51,52]) {
  console.log(`  lane=${lane}: 横走段 y=${lane}，是否经过 x=-219? 是（区间 -265..-218 含 -219）`);
}
console.log('\n=> 任何 lane 在 46..52，ch1 的横走段都必然经过 x=-219 的某一格');
console.log('   而通道 A 是纯竖直的 x=-219 直线 ⇒ 必然相交。这是几何必然，换 lane 无用。');
