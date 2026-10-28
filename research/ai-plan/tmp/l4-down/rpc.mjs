const BASE = process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777";
let rid = 1;
export async function rpc(method, params = {}, timeout = 180000) {
    const res = await fetch(`${BASE}/rpc`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method, params }),
        signal: AbortSignal.timeout(timeout),
    });
    const b = await res.json();
    if (b.error) { const e = new Error(`${method}: ${b.error.message}`); e.code = b.error.code; throw e; }
    return b.result;
}
export const D = { top:[0,-1], right:[1,0], bottom:[0,1], left:[-1,0] };
