import { rpc, act } from "../live/kit.mjs";

const get = async () => (await rpc("obs", { max_entities: 1, include_hub: true }, 60000));
const before = await get();
const s0 = before.hub.stored_shapes["----CuCu"] || 0;
console.log("belt level:", before.goal.upgrade_levels.belt, "miner level:", before.goal.upgrade_levels.miner);

// 现有产线是 ----CuCu（矿机 1 台 + 切割机），跑 6000 tick 看产量
const T = 6000;
const t0 = Date.now();
const r = await act({ op: "step", ticks: T });
const wall = (Date.now() - t0) / 1000;
const after = await get();
const s1 = after.hub.stored_shapes["----CuCu"] || 0;
const gained = s1 - s0;
const gameSec = (r.ticks_run || T) / 60;
console.log(`ticks=${r.ticks_run} game ${gameSec.toFixed(1)}s wall ${wall.toFixed(1)}s`);
console.log(`----CuCu: ${s0} -> ${s1} (+${gained})  => ${(gained / gameSec).toFixed(3)}/s`);
console.log(`expected: miner upgrade gives 0.4*1.5 = 0.6/s`);
