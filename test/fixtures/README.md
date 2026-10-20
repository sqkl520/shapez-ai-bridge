# test/fixtures — 第三方测试夹具

## game_lzstring_upstream.js / game_lzstring_cjs.cjs

- **来源**：`tobspr-games/shapez.io@ee2279d5` 的 `src/js/core/lzstring.js`
  （https://cdn.jsdelivr.net/gh/tobspr-games/shapez.io@ee2279d5f0c9998a142ea0d65190e58beb14fedd/src/js/core/lzstring.js）
- **原始版权**：Copyright (c) 2013 Pieroxy — **WTFPL v2**（文件头自带声明），
  即 pieroxy 的 LZString 库（https://github.com/pieroxy/lz-string），游戏只是原样 vendor。
- **用途**：`test/lzstring_interop.mjs` 用它作为"游戏端实现"，与仓库 vendored 的
  `src/shared/lz-string.cjs`（同源库的 npm 1.5.0 版本，MIT 许可）做双向对拍，
  证明蓝图/存档压缩格式跨实现互通。
- **许可状态**：WTFPL/MIT 双自由许可，可安全分发。
- `game_lzstring_cjs.cjs` 是 `game_lzstring_upstream.js` 的 CJS 转换版（`export function` → `function` + module.exports），内容等价，仅加载方式不同。

> 注意：本目录下的文件**不是** tobspr Games 的原创代码；游戏原创代码（bundle 提取物等）
> 保留在 `recon/`，已被 `.gitignore` 排除，不随仓库分发。
