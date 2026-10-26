export const BASE = process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777";
let id = 1;
export async function rpc(method, params = {}, timeoutMs = 180000) {
  const res = await fetch(`${BASE}/rpc`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const b = await res.json();
  if (b.error) { const e = new Error(`${method}: ${b.error.message}`); e.rpc = b.error; throw e; }
  return b.result;
}
export function rateOf(prod, shape) {
  const sl = prod.delivered_slices || [];
  const done = sl.slice(0, sl.length - 1); // exclude accumulating
  const total = done.reduce((a, s) => a + ((s || {})[shape] || 0), 0);
  return { rate: +(total / (done.length * prod.slice_seconds)).toFixed(3), total, n: done.length, counts: done.map(s => (s||{})[shape] || 0) };
}
