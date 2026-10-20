<#
.SYNOPSIS
    Install or uninstall the shapez-ai-bridge mod for shapez.io (Windows).

.DESCRIPTION
    Copies src/mod/shapez-ai-bridge.js from this repository into the game's
    mods folder. The game's main process reads mods from:
        %APPDATA%\shapez.io\mods
    (verified against the game's index-main.js; the folder is auto-created by
    the game, and by this script if missing).

    The script is idempotent: running it again just reinstalls the current
    version. By default, an existing shapez-ai-bridge.js is saved as
    shapez-ai-bridge.js.bak-<timestamp> before being overwritten; pass
    -NoBackup to skip that.

    Requires no admin rights. Does NOT modify any game files.

.PARAMETER ModsDir
    Override the mods directory (default: $env:APPDATA\shapez.io\mods).

.PARAMETER Uninstall
    Remove shapez-ai-bridge.js from the mods directory and exit.

.PARAMETER NoBackup
    Do not back up an existing shapez-ai-bridge.js before overwriting.
    (Backup is ON by default. A [bool] parameter cannot be set from the
    command line under `powershell -File` in Windows PowerShell 5.1, hence
    this switch.)

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
    powershell -ExecutionPolicy Bypass -File install.ps1 -ModsDir "D:\games\shapez-mods"
    powershell -ExecutionPolicy Bypass -File install.ps1 -NoBackup
#>

[CmdletBinding()]
param(
    [string]$ModsDir = "",
    [switch]$Uninstall,
    [switch]$NoBackup
)

$ErrorActionPreference = "Stop"

# Chinese output would be mojibake on legacy Windows consoles (default GBK
# code page); switch console output to UTF-8 (no admin rights needed; a
# failure here is not fatal).
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$Backup = -not $NoBackup

# --- Locate paths -------------------------------------------------------------

# $PSScriptRoot = directory of this script (the repo root). Never rely on cwd.
$scriptDir  = $PSScriptRoot
$sourceFile = Join-Path $scriptDir "src\mod\shapez-ai-bridge.js"
$modFileName = "shapez-ai-bridge.js"

if ([string]::IsNullOrWhiteSpace($ModsDir)) {
    # Game logic (index-main.js): roamingFolder\shapez.io\mods where roamingFolder
    # is %APPDATA% on Windows.
    if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
        Write-Host "[FAIL] APPDATA is not set. Use -ModsDir to specify the mods folder manually." -ForegroundColor Red
        Write-Host "[失败] 未检测到 APPDATA 环境变量。请用 -ModsDir 手动指定 mods 目录。" -ForegroundColor Red
        exit 1
    }
    $ModsDir = Join-Path $env:APPDATA "shapez.io\mods"
}

# --- Uninstall mode -----------------------------------------------------------

if ($Uninstall) {
    $target = Join-Path $ModsDir $modFileName
    Write-Host "Uninstalling shapez-ai-bridge..." -ForegroundColor Cyan
    Write-Host "正在卸载 shapez-ai-bridge..." -ForegroundColor Cyan

    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Force
        Write-Host "[OK] Removed: $target" -ForegroundColor Green
        Write-Host "[成功] 已删除: $target" -ForegroundColor Green
        Write-Host "Restart the game for the change to take effect." -ForegroundColor Yellow
        Write-Host "重启游戏后生效。" -ForegroundColor Yellow
    } else {
        Write-Host "[SKIP] Nothing to uninstall: $target does not exist." -ForegroundColor Yellow
        Write-Host "[跳过] 无需卸载: $target 不存在。" -ForegroundColor Yellow
    }
    exit 0
}

# --- Install mode -------------------------------------------------------------

Write-Host "shapez-ai-bridge installer (Windows)" -ForegroundColor Cyan
Write-Host "shapez-ai-bridge 安装程序（Windows）" -ForegroundColor Cyan
Write-Host ""

# 1. Verify the source mod file exists in the repo.
if (-not (Test-Path -LiteralPath $sourceFile)) {
    Write-Host "[FAIL] Source mod file not found: $sourceFile" -ForegroundColor Red
    Write-Host "[失败] 未找到源 mod 文件: $sourceFile" -ForegroundColor Red
    Write-Host "Run this script from a full checkout of the repository (src\mod must exist next to it)." -ForegroundColor Yellow
    Write-Host "请确认仓库完整检出（脚本旁边应有 src\\mod 目录）。" -ForegroundColor Yellow
    exit 1
}

# 2. Ensure the mods directory exists (same behavior as the game itself).
if (-not (Test-Path -LiteralPath $ModsDir)) {
    Write-Host "[INFO] Mods directory does not exist, creating: $ModsDir" -ForegroundColor Yellow
    Write-Host "[提示] mods 目录不存在，正在创建: $ModsDir" -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $ModsDir -Force | Out-Null
} else {
    Write-Host "[INFO] Mods directory: $ModsDir" -ForegroundColor Gray
    Write-Host "[提示] mods 目录: $ModsDir" -ForegroundColor Gray
}

$target = Join-Path $ModsDir $modFileName

# 3. Back up an existing mod before overwriting (idempotent reinstall).
if (Test-Path -LiteralPath $target) {
    if ($Backup) {
        # Note: PowerShell variables are case-insensitive; do NOT name this
        # variable $backup — it would collide with the $Backup value above.
        $stamp      = Get-Date -Format "yyyyMMdd-HHmmss"
        $backupPath = "$target.bak-$stamp"
        Copy-Item -LiteralPath $target -Destination $backupPath -Force
        Write-Host "[OK] Backed up existing mod to: $backupPath" -ForegroundColor Green
        Write-Host "[成功] 已备份现有 mod 到: $backupPath" -ForegroundColor Green
    } else {
        Write-Host "[INFO] Existing mod found; -NoBackup so it will be overwritten in place." -ForegroundColor Yellow
        Write-Host "[提示] 已有同名 mod；-NoBackup，将直接覆盖。" -ForegroundColor Yellow
    }
} else {
    Write-Host "[INFO] Fresh install (no existing mod)." -ForegroundColor Gray
    Write-Host "[提示] 全新安装（无同名 mod）。" -ForegroundColor Gray
}

# 4. Copy the mod.
Copy-Item -LiteralPath $sourceFile -Destination $target -Force
$srcHash = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash
$dstHash = (Get-FileHash -LiteralPath $target     -Algorithm SHA256).Hash
if ($srcHash -ne $dstHash) {
    Write-Host "[FAIL] Copy verification failed (hash mismatch)." -ForegroundColor Red
    Write-Host "[失败] 复制校验失败（哈希不一致）。" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Installed mod: $target" -ForegroundColor Green
Write-Host "[成功] 已安装 mod: $target" -ForegroundColor Green

# 5. Friendly reminder about achievements (official game behavior).
Write-Host ""
Write-Host "[NOTE] Installing ANY mod disables Steam achievements and the puzzle DLC." -ForegroundColor Yellow
Write-Host "       This is official shapez.io behavior, not a bug of this project." -ForegroundColor Yellow
Write-Host "[注意] 安装任何 mod 都会禁用 Steam 成就与拼图 DLC，这是官方行为，不是本项目的 bug。" -ForegroundColor Yellow

# 6. Next steps.
Write-Host ""
Write-Host "Next steps / 下一步:" -ForegroundColor Cyan
Write-Host "  1. Start shapez.io (the mod loads automatically at boot)." -ForegroundColor White
Write-Host "     启动 shapez.io（mod 会在游戏启动时自动加载）。" -ForegroundColor White
Write-Host "  2. In a terminal, start the bridge:" -ForegroundColor White
Write-Host "     在终端启动桥接服务器:" -ForegroundColor White
Write-Host "       node src/bridge/bridge.mjs" -ForegroundColor Gray
Write-Host "  3. Load a savegame in-game, then run the smoke test:" -ForegroundColor White
Write-Host "     进入一个有存档的世界，然后跑冒烟测试:" -ForegroundColor White
Write-Host "       node scripts/smoke_test.mjs" -ForegroundColor Gray
Write-Host ""
Write-Host "Uninstall later with / 以后可用以下命令卸载:" -ForegroundColor Cyan
Write-Host "  powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall" -ForegroundColor Gray
