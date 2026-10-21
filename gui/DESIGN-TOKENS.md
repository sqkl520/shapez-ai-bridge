# GUI Design Tokens — measured from the game itself

> Source: `recon/game_main.css` (extracted from the game's `app.asar`) +
> `recon/bundle.pretty.js`. Every value below is **measured from shapez.io's own UI**,
> not invented. The GUI inherits shapez's identity so it reads as "part of the game's
> ecosystem" — and so it can never trip the AI-slop gate (`recon/motion-web-refs/design-slop.md` A4:
> the violet/indigo gradient is the #1 tell; we use the game's own blue instead).

## Color — the game's real palette

| Role | Hex | Provenance (game source) |
|---|---|---|
| **Primary / action** | `#4a97df` | `.styledButton` background, link color (`a{color:#4a97df}`) |
| Primary hover | `#3f87cc` | derived (darken 8%) — game uses opacity, GUI needs a discrete state |
| **Ink / chrome** | `#393747` | `.styledButton` base background, `a{color:#393747}` |
| Chrome deep | `#2d2c39` | game dark surfaces |
| Chrome deeper | `#171a23` | game darkest surface |
| Surface (dark) | `#3c404a` | game panel fill |
| Surface raised | `#484c58` | game raised panel |
| Border / hairline | `#535866` | game separators |
| Muted text | `#7d808a` | game secondary text (15 occurrences) |
| **Success** | `#66bb6a` | game green (15 occurrences) |
| **Warning** | `#ffac0f` | game orange |
| **Danger** | `#ef5072` | game red/pink (12 occurrences) |

Ground: the game window itself is `#222428` (from `index.html` `backgroundColor`) — that is the
GUI's ground for dark mode. There is exactly **one** accent (`#4a97df`) used for actions and focus;
semantic colors (success/warn/danger) appear only as state, never as decoration.

### Anti-slop check (design-slop.md §A)
- **A4 (violet gradient)**: avoided by construction — palette comes from the game. ✅
- Palette size: ground + 2 chroma-ish (blue, plus neutrals) + 3 semantic states. Committed, small. ✅
- No gradients as background treatment. ✅

## Type

| Role | Family | Size | Notes |
|---|---|---|---|
| UI body | `"Segoe UI", system-ui, sans-serif` | 14px | GameFont is bitmap-ish and unavailable outside the game — use the OS UI font; the game itself uses 14px labels on buttons |
| Display (step numbers, big status) | `"Segoe UI", system-ui` | 44–64px, weight 600, `letter-spacing: -0.02em` | **The 8× jump is the design** (page-design.md §2: award winners run ≈8× display÷body). Our ratio: 56/14 = **4×** minimum, hero number can hit 6–8×. |
| Mono (logs, JSON, paths) | `"Cascadia Mono", "Consolas", monospace` | 12.5px | Windows-native mono, no webfont |

Base grid: **4px** (4/8/12/16/24/32). Radius: **one value** — `6px` (between game's 4.8px and product-dialect 8px; creative-dialect median is 1 radius value). Shadows: **zero or one** (game uses none; keep a single subtle one for the floating log panel only).

## Motion tokens (from motion-tokens.md — tiered, never one `0.3s ease`)

| Token | Value | Where the GUI uses it |
|---|---|---|
| `instant` 90ms | `cubic-bezier(0.16,1,0.3,1)` | button press feedback, checkbox |
| `fast` 160ms | `cubic-bezier(0.16,1,0.3,1)` | hover states, tab switch |
| `standard` 300ms | `cubic-bezier(0.16,1,0.3,1)` | panel slide, step transition |
| `medium` 450ms | `cubic-bezier(0.16,1,0.3,1)` | wizard step content reveal |
| `slow` 700ms | `cubic-bezier(0.16,1,0.3,1)` | first-run hero entrance (once) |
| spring-snappy 350/28 | JS | success checkmark (only place a spring is justified) |
| stagger `tight-grid` 40ms | — | log lines entering, checklist items |

Posture (design-slop.md §B): motion is **earned per event**, not applied to everything.
- **No** universal fade-up on every block (B2) — the wizard step change gets one `medium` reveal; the rest of the page is already there.
- **No** uniform hover lift (B1) — hover states are color/underline only, except the two primary actions which get a 1px press.
- Reduced-motion: all of the above collapse to instant state changes; the still frame is fully usable (baseline-ui §1).
