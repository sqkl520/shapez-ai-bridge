/**
 * 把 shapez 的**所有**窗口强制提到最前 —— 修 World wedge 的可靠办法。
 *
 * ## 为什么需要这个
 *
 * `LIVE-LOG.md` 记录过：游戏窗口被遮挡 ⇒ `requestAnimationFrame` 停 ⇒
 * `gameStarted` 不派发 ⇒ `mod.root` 为空 ⇒ `in_game` 永远 false。
 *
 * 而 `MOD-GAPS.md` §6 也记了这一条（severity 4，operational）。
 *
 * ## 为什么之前的办法不可靠
 *
 * 之前只置顶 `MainWindowHandle` —— 但 shapez 是 Electron，有 **7 个窗口**，
 * 其中 3 个有标题（`shapez` + 两个内部窗口）。只置顶主窗口，
 * 另两个内部窗口仍可能盖住渲染区。
 *
 * 实测（2026-11-02）：只置顶主窗口时 `in_game` 还是 false；
 * **把 6 个可见窗口全部 `SetWindowPos(TOPMOST)` 之后立刻 true。**
 *
 * ## 用法
 *
 *   node .tmpverify/live-partial/foreground.mjs
 *
 * 输出里会打印每个窗口的 handle 和标题长度 —— 有标题的那几个是关键。
 */
import { execFileSync } from 'node:child_process';

const PS = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class SzFg {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc f, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public static List<string> Fix(uint targetPid) {
    var outLines = new List<string>();
    var hs = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == targetPid && IsWindowVisible(h)) hs.Add(h);
      return true;
    }, IntPtr.Zero);
    foreach (var h in hs) {
      int len = GetWindowTextLength(h);
      var sb = new StringBuilder(len + 1); GetWindowText(h, sb, len + 1);
      ShowWindow(h, 9);
      SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002);
      BringWindowToTop(h);
      SetForegroundWindow(h);
      outLines.Add(h.ToInt64() + "|" + len + "|" + sb.ToString());
    }
    return outLines;
  }
}
'@
$p = Get-Process shapezio -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { Write-Output "NO_PROCESS"; exit 1 }
Write-Output ("pid=" + $p.Id)
foreach ($line in [SzFg]::Fix($p.Id)) { Write-Output $line }
`;

const out = execFileSync('powershell', ['-NoProfile', '-Command', PS], { encoding: 'utf8' });
console.log(out.trim());

/* 等 CPU 真的开始涨（渲染循环恢复的证据） */
const pidLine = out.match(/pid=(\d+)/);
if (!pidLine) { console.error('找不到 pid'); process.exit(1); }
const pid = pidLine[1];

console.log('\n等渲染循环恢复（CPU 应开始涨）…');
let recovered = false;
for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const t = execFileSync('powershell', ['-NoProfile', '-Command',
        `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){$c1=$p.CPU; Start-Sleep -Milliseconds 1200; $p.Refresh(); Write-Output ([math]::Round($p.CPU-$c1,3))} else {Write-Output "-1"}`,
    ], { encoding: 'utf8' }).trim();
    const delta = Number(t);
    if (delta > 0.05) {
        console.log(`  CPU delta = ${delta}s/1.2s ⇒ ✓ 渲染循环在跑`);
        recovered = true;
        break;
    }
    if (i % 5 === 0) console.log(`  CPU delta = ${delta}s/1.2s（还在等）`);
}
if (!recovered) {
    console.log('  ✗ CPU 仍未涨 —— 窗口可能又被盖住了，需要再跑一次本脚本');
    process.exitCode = 2;
} else {
    console.log('\n现在可以 load_save / snapshot_load 了');
}
