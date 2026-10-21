# Windows 探测机制 — 实测证据

> 供执行 Agent 实现「环境检测」时直接照抄。每一项都在这台机器上实测过。

## 1. Steam 游戏目录探测（四级证据链）

普通用户不知道游戏装在哪 —— GUI 必须自动找到它。实测有效的探测顺序：

```
1. 读注册表: HKCU\Software\Valve\Steam → SteamPath   (实测: "d:/steam")
2. 读 <SteamPath>/steamapps/libraryfolders.vdf         (实测存在，含全部库路径)
3. 对每个库: 查 <lib>/steamapps/appmanifest_1318690.acf  (实测存在 = shapez 已安装)
4. 游戏目录 = <lib>/steamapps/common/shapez.io          (实测存在)
```

备用路径（任一失败时）：
- `C:\Program Files (x86)\Steam\steamapps\common\shapez.io`
- `D:\Steam\steamapps\common\shapez.io`（本机实测命中）
- 用户在配置里手动指定的 `game_dir`

验证标志（用于确认目录真的是 shapez）：目录内存在 `shapezio.exe` 与 `resources\app.asar`。

## 2. mods 目录

```
path.join(process.env.APPDATA, "shapez.io", "mods")
实测: C:\Users\Administrator\AppData\Roaming\shapez.io\mods  (存在)
```
- 游戏主进程会在启动时自动创建（源码 index-main.js 确认），GUI 也可代建。
- mod 文件：`shapez-ai-bridge.js`（单文件），实测已安装。

## 3. 端口探测（Node 零依赖）

```js
function probePort(port) {
  return new Promise(res => {
    const s = net.createServer();
    s.once('error', () => res(true));   // busy
    s.once('listening', () => s.close(() => res(false)));  // free
    s.listen(port, '127.0.0.1');
  });
}
```
实测：7777 占用时返回 true、17777 空闲时返回 false。

## 4. 浏览器（GUI 的呈现层）

实测存在的候选（按优先级）：
```
C:\Program Files\Google\Chrome\Application\chrome.exe          (实测存在)
C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe   (实测存在)
```
用法：`<browser> --app=http://127.0.0.1:<port>/ --window-size=1180,780`
- `--app=` 模式 = 无地址栏窗口，看起来像原生应用
- 用户已有浏览器会话/字体/渲染全部复用，零打包体积

## 5. 子进程管理（实测）

Node → PowerShell 调 install.ps1：
```js
spawnSync('powershell', ['-NoProfile','-ExecutionPolicy','Bypass','-File','install.ps1','-NoBackup'],
          { cwd: repoRoot, encoding: 'utf8', timeout: 30000 })
```
实测：exit 0、stdout 27 行、stderr 空。（`-NoBackup` 让重复安装不堆备份文件——注意 install.ps1 的开关叫 `-NoBackup` 不是 `-Backup`，见脚本头注释。）

桥接子进程：
```js
spawn(process.execPath, ['src/bridge/bridge.mjs', '--port', String(port), ...flags],
      { cwd: repoRoot, stdio: ['ignore','pipe','pipe'] })
```
- 就绪探测：轮询 `GET http://127.0.0.1:<port>/health`（500ms 间隔，最长 8s）
- 停止：先发 SIGTERM（Windows 上 Node 会走 SIGTERM 处理器），2s 未退则 `taskkill /pid <pid> /f`

## 6. 游戏进程探测（判断"游戏在不在跑"）

```powershell
Get-Process shapezio -ErrorAction SilentlyContinue
```
实测：游戏运行时返回 5 个 `shapezio.exe` 进程（Electron 多进程）。GUI 只判断"存在任一即视为运行中"，不要用进程数。

## 7. headless 截图（验证用，非 GUI 需要）

```bash
node gui/shot.mjs <url> <out.png> [--w N] [--h N] [--reduced-motion]
```
实测工作正常（Chrome `--headless=new --screenshot=`）。`--reduced-motion` 用于静帧闸门测试。
