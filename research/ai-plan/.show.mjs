import fs from "fs";
const dir = process.argv[2];
const lines = fs.readFileSync(dir + "/transcript.jsonl", "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
for (const e of lines) {
    if (e.kind === "propose" && e.data.plan) {
        const p = e.data.plan;
        console.log("r" + e.round + ": " + p.calls.map(c => {
            const f = c.args.from || (c.args.at ? JSON.stringify(c.args.at) : "?");
            const t = c.args.to ? JSON.stringify(c.args.to) : "";
            return c.macro + " " + JSON.stringify(f) + (t ? " -> " + t : "");
        }).join(" | "));
    } else if (e.kind === "apply") {
        console.log("   APPLY +" + e.data.diff.added + " -" + e.data.diff.removed);
    } else if (e.kind === "plan") {
        console.log("   plan: " + (e.data.ok ? "OK" : "REJ " + e.data.rejected.code + " | " + String(e.data.rejected.observed).slice(0, 90)));
    }
}
