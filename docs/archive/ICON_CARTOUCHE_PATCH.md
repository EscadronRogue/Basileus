# Basileus — Icon, Cartouche & Picker Patch

A consistent visual vocabulary for the three resources, the player
cartouche grammar, and a complete rebuild of the appointing / bidding /
deployment interfaces — every choice now reads as a selectable
cartouche instead of a bare `<select>`.

## What changed

### Phase 1 — Icons + value atom

| Path | Status | Why |
|---|---|---|
| `ui/icons.js` | **new** | The three glyphs (sword · nomisma · basilica), the `[icon] [number]` value pill, the SVG `<symbol>` installer for the map renderer. |
| `ui/labels.js` | modified | `formatProvinceValuesText` kept as plain text (tests still expect it). New `renderProvinceValuesHtml` returns the icon-based markup. `renderProvinceBadge` switches to the HTML version for live displays. |
| `engine/presentation.js` | modified | Adds `formatGoldHtml`, `formatTroopsHtml`, `formatChurchHtml`, `formatMercenariesHtml`, `formatProvinceYieldHtml`. The plain-text formatters stay; `engine/actions.js` and `engine/turnflow.js` need flat strings for the history log. |
| `render/mapRenderer.js` | modified | Installs the three `<symbol>` icons in SVG defs. The values line on every map cartouche is now a `<g>` of icon+number pairs, not the `"P3 T2 C1"` text. Zero values collapse so church-only land shows only the church glyph. |

### Phase 2 — Interface rebuild

| Path | Status | Why |
|---|---|---|
| `ui/panels.js` | modified | All interaction surfaces now use selectable cartouche pickers instead of HTML `<select>` dropdowns. Court appointments, revocations, gifts, title redistribution, estate bidding, deployment candidate selection — all rebuilt. Each picker has numbered "PICK THE…" steps + live preview line + disabled-until-ready confirm button. |
| `ui/sharedView.js` | modified | Player tab finance run gets a leading gold-coin icon. |
| `ui/balancePanel.js` | modified | Each balance pie title gets its category icon. |
| `assets/style.css` | modified | Three big additions: (1) `.icon` and `.value` atoms; (2) `.choice-grid` + `.player-choice-btn` + `.title-choice-btn` + `.revocation-choice-btn` cartouche-picker styles with gold-ring selected state; (3) base `.btn-primary` / `.btn-danger` / `.btn-secondary` styling that the panels were assuming but never had, plus `.segmented-control`, the deployment army-card layout (`.army-card-slider`, `.army-slider-readout`, `.army-slider-cost`), the estate card grid (`.estate-card-stats`, `.estate-card-bid`, `.estates-reserve`), and the deployment candidate rows (`.candidate-row`, `.candidate-crest`, `.candidate-tag`). |

## The shared picker grammar

Every action panel now has the same structure:

```
SECTION TITLE                       ← small Cinzel kicker
(①) PICK THE OFFICE                 ← numbered step kicker
[cartouche] [cartouche] [cartouche] ← selectable cartouche row
(②) PICK THE APPOINTEE
[player chip] [player chip] …
Komnenos → Strategos of Armeniakon  ← live preview line
[Appoint Strategos]                 ← disabled until both picks made
```

The **selected** state on every picker:
- Player chips: gold inner ring + gold outer ring tinted by the player's role color
- Province/title tokens: gold double-ring on the cartouche outline
- Candidate rows in deployment: gold outer ring with the role color repeated

All three rings are CSS `box-shadow` stacks, no images.

## How the system reads

**Icons.** Three filled SVGs that inherit `currentColor`. Default tints
(umber / gold / church-blue) on parchment; parchment-white inside any
colored cartouche so they read against the dynasty fill.

**Value atom.** `renderValue('gold', 42, { label: true })` →
`<span class="value gold"><span class="value-noun">Gold</span>[coin]42</span>`.
Use `label: true` for roomy spots (finance cards, scoring), omit it for
tight ones (player tabs, province tokens, map cartouches).

**Province values.** `provinceValueEntries(theme)` produces a single
`[{kind, value}]` list used by both the HTML province token and the SVG
map cartouche, so the two surfaces always show the same data in the
same order: gold → sword → church.

**Cartouche grammar.** Already in CSS on `.player-tab`,
`.player-dashboard`, `.candidate-btn`, `.title-token`, `.player-role-name`.
New `.candidate-row` and `.player-choice-btn` carry the same grammar at
two new scales (full row, picker chip).

## How to roll back

Everything is additive on the JS side. The plain-text formatters
(`formatGold`, `formatTroops`, etc.) and `formatProvinceValuesText` still
exist with their original signatures, so `engine/actions.js` and
`engine/turnflow.js` (which use them for history strings) keep working.

Reverting `ui/panels.js` to its previous version restores the dropdown
UIs. The `ui/icons.js` module plus the new CSS blocks can stay installed
without affecting anything that doesn't import them.
