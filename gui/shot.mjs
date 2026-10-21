#!/usr/bin/env node
/**
 * GUI screenshot probe — headless Chrome/Edge screenshot helper.
 *
 * Used by verification agents to capture the GUI at specific routes/viewports
 * without any npm dependency (Chrome/Edge headless mode only).
 *
 * Usage:
 *   node gui/shot.mjs <url> <out.png> [--w 1280] [--h 720] [--wait 1500] [--reduced-motion]
 *
 * Options:
 *   --w N              viewport width  (default 1280)
 *   --h N              viewport height (default 720)
 *   --wait N           extra delay in ms before capture (default 1200)
 *   --reduced-motion   emulate prefers-reduced-motion: reduce (still-frame gate)
 *   --full             capture full page height
 *
 * Why headless Chrome instead of a screenshot library: the project ships
 * zero npm dependencies. Chrome/Edge are present on every Windows box this
 * project targets, and both accept the same CLI flags.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const CHROME_CANDIDATES = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

function findBrowser() {
    for (const c of CHROME_CANDIDATES) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

function parseArgs(argv) {
    const out = { url: null, out: null, w: 1280, h: 720, wait: 1200, reducedMotion: false, full: false };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--w") out.w = parseInt(argv[++i], 10);
        else if (a === "--h") out.h = parseInt(argv[++i], 10);
        else if (a === "--wait") out.wait = parseInt(argv[++i], 10);
        else if (a === "--reduced-motion") out.reducedMotion = true;
        else if (a === "--full") out.full = true;
        else rest.push(a);
    }
    out.url = rest[0] || null;
    out.out = rest[1] || null;
    return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.url || !args.out) {
    console.error("usage: node gui/shot.mjs <url> <out.png> [--w N] [--h N] [--wait N] [--reduced-motion] [--full]");
    process.exit(1);
}

const browser = findBrowser();
if (!browser) {
    console.error("[shot] no Chrome/Edge found — install either, or capture manually");
    process.exit(1);
}

// Chrome headless=new writes the file itself; ensure the target dir exists and
// use an absolute path (Chrome resolves relative paths against its own cwd).
const outAbs = path.resolve(args.out);
fs.mkdirSync(path.dirname(outAbs), { recursive: true });

const flags = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--screenshot=${outAbs}`,
    `--window-size=${args.w},${args.h}`,
    "--virtual-time-budget=" + Math.max(500, args.wait),
];
if (args.reducedMotion) {
    // Chrome honors this via the media feature flag
    flags.push("--force-prefers-reduced-motion");
}
if (args.full) {
    // headless=new cannot do full-page via CLI reliably; note it and capture viewport
    console.error("[shot] note: --full is not supported by CLI headless; capturing viewport");
}

const child = spawn(browser, [...flags, args.url], { stdio: ["ignore", "pipe", "pipe"] });
let err = "";
child.stderr.on("data", d => (err += d.toString()));
child.on("close", code => {
    if (fs.existsSync(outAbs)) {
        const size = fs.statSync(outAbs).size;
        console.log(`[shot] OK ${outAbs} (${size} bytes, ${args.w}x${args.h}${args.reducedMotion ? ", reduced-motion" : ""})`);
        process.exit(0);
    }
    console.error(`[shot] FAILED (exit ${code}); stderr tail:`);
    console.error(err.split("\n").slice(-6).join("\n"));
    process.exit(1);
});
