# Third-party notices

This project is MIT-licensed (see [LICENSE](LICENSE)). It bundles or
interoperates with the following third-party components, which carry their own
terms.

## Bundled

### lz-string 1.4.5

`src/shared/lz-string.cjs` — LZ-based compression algorithm used for savegame
and blueprint strings.

Copyright (c) 2013 Pieroxy <pieroxy@pieroxy.net>

Dual-licensed: you may use this component under the terms of either the MIT
License or the WTFPL v2. The vendored copy keeps its original header; the full
MIT text shipped with it is in
[`src/shared/lz-string.LICENSE.txt`](src/shared/lz-string.LICENSE.txt).

WTFPL v2 text: <http://www.wtfpl.net/>

### `test/fixtures/game_lzstring_*`

These two files exist so the interop test can check our vendored copy against
the implementation the game actually uses. They are **Pieroxy's lz-string, not
shapez.io's own code** — the game vendors it unmodified, and we take it from the
same upstream source. Same copyright and same dual MIT/WTFPL licence as above.
See [`test/fixtures/README.md`](test/fixtures/README.md) for provenance.

## Not bundled — interoperated with

### shapez.io

shapez.io is © tobspr Games (<https://shapez.io>).

**This repository contains no shapez.io game code.** All integration happens
through the game's official mod API and the runtime introspection documented in
[PHASE0-RECON.md](PHASE0-RECON.md). Nothing here patches, redistributes or
re-implements the game.

Two consequences of the game's own behaviour, not limitations added by this
project:

- Installing any mod disables Steam achievements, because shapez.io only enables
  its Steam layer when zero mods are loaded.
- Loading a mod marks the savegame as modified, which disables the puzzle DLC
  for that save.

This project is unofficial and is not affiliated with, endorsed by, or
supported by tobspr Games.
