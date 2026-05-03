# Basileus Responsive / Firefox / Phone Compatibility Plan

## Diagnostic

The live game was structurally desktop-first. The main risk was not game logic; it was the layout shell and interaction layer.

### Primary issues found

1. **Rigid viewport shell**
   - `body` and `#app` used `100vh` / `100vw` with `overflow: hidden`.
   - `#app` used a permanent two-column grid: `1fr 360px`.
   - On phone widths, the sidebar could consume nearly the entire viewport, leaving the map unusable.

2. **Sidebar compression**
   - Dashboard, history, and action panels were stacked inside a fixed-width column.
   - Many rows assumed horizontal space: stats, market rows, finance cards, deployment rows, army controls, score rows.
   - Text was often forced into compact lines instead of being allowed to wrap.

3. **Map behavior was desktop-biased**
   - The SVG map used `preserveAspectRatio="xMidYMid slice"`, which fills aggressively and can crop on narrow screens.
   - Zoom was primarily mouse-wheel based. Phone users had no explicit map zoom control.
   - Hit testing relied mostly on SVG geometry APIs; adding an `elementsFromPoint` path improves practical browser resilience.

4. **Touch ergonomics**
   - Several buttons and form controls were below the usual mobile touch target size.
   - iOS-style input zoom risk existed because setup/simulator inputs were below 16px on narrow screens.
   - Safe-area insets were not considered for notched phones.

5. **Firefox/progressive-enhancement gaps**
   - The UI used modern CSS features such as `color-mix()` and `backdrop-filter()` without enough fallback behavior.
   - WebKit-only scrollbar styling existed, with Firefox alternatives only in some places.

6. **Information density**
   - Several high-information UI blocks were visually crammed: dashboard lists, province/title cartouches, market options, deployment controls, and history cards.
   - Many components used fixed spacing rather than adaptive spacing.

## Applied plan

### 1. Replace the rigid shell with responsive layout rules
- Keep two-column desktop layout.
- Use a clamped sidebar width instead of a hard-coded 360px column.
- Below 900px, switch to a map-first single-column layout:
  1. top bar
  2. map
  3. sidebar panels
- Allow the page to scroll on mobile instead of hiding overflow.
- Use `100dvh` where available, with `100vh` fallback.

### 2. Improve phone map usability
- Change SVG aspect behavior from `slice` to `meet` to prevent narrow-screen cropping.
- Add map zoom controls: zoom in, zoom out, reset.
- Preserve wheel zoom and drag-to-pan behavior.
- Add a browser-resilient province hit-test fallback using `document.elementsFromPoint()` before SVG geometry fallback.

### 3. Make the sidebar and panels fluid
- Replace fixed two-column areas with `auto-fit` grids where appropriate.
- Increase panel padding through responsive variables.
- Let panel headers, badges, rows, and controls wrap on narrow screens.
- Convert dense rows to stacked or grid layouts on phones.

### 4. Improve control ergonomics
- Add shared touch-target sizing.
- Increase mobile input font size to reduce unintended browser zoom.
- Use `touch-action: manipulation` on buttons, inputs, summaries, and controls.
- Expand deployment toggles, army controls, and action buttons on phone widths.

### 5. Add Firefox and fallback resilience
- Add fallback colors before `color-mix()` declarations.
- Add fallback backgrounds for overlays when `backdrop-filter` is unavailable.
- Add Firefox-friendly scrollbar behavior where relevant.

### 6. Make the setup and simulator pages phone-aware
- Add `viewport-fit=cover` to both entry pages.
- Respect safe-area insets.
- Improve simulator touch controls and narrow-width padding.
- Keep large simulator tables horizontally scrollable.

## Files changed

- `index.html`
- `simulator.html`
- `assets/style.css`
- `assets/simulator.css`
- `render/mapRenderer.js`

## Validation performed

- `npm test`
  - economy tests passed
  - simulation smoke test passed
  - multiplayer verifier passed
- JavaScript syntax checks passed for touched JS entry points.
- CSS brace balance checked for touched stylesheets.

## Remaining recommended manual QA

Because browser UI execution was blocked by the local container policy, final visual QA should be done manually in:

1. Firefox desktop, current release.
2. Firefox Android or responsive Firefox devtools at 390×844 and 430×932.
3. iOS Safari or Chrome devtools mobile emulation for safe-area and input zoom behavior.
4. A 5-player game state to check player tab overflow.
5. Orders phase and resolution phase, because they have the densest control layouts.
