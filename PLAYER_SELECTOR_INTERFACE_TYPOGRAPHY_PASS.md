# Player Selector + Interface Typography Pass

## Intent
Make the player selector a real part of the interface, not a pinned strip, while keeping every player visible and readable. Remove wasted map-control chrome and improve the legibility of ordinary interface text.

## Changes
- Converted `#playerTabBar` from a sticky horizontal strip into a normal wrapping sidebar section placed before Dynasty View.
- Rebuilt player cartouches to show only the dynasty/family name plus compact economy information:
  - reserve gold
  - expected income
  - expected expenditure
- Kept all selector text white to preserve the dynasty cartouche grammar.
- Removed horizontal scrolling from the selector; cards now wrap into a compact grid so every player is visible.
- Increased the sidebar/interface width again on desktop and intermediate widths.
- Removed the map zoom-control buttons from the map area.
- Preserved mouse-wheel zoom and double-click reset.
- Increased baseline body text size and key interface text scale for better balance against the cartouche-heavy visual language.

## Changed files
- `assets/style.css`
- `ui/gameController.js`
- `ui/multiplayerController.js`
- `render/mapRenderer.js`

## Validation
- `node --check render/mapRenderer.js`
- `node --check ui/gameController.js`
- `node --check ui/multiplayerController.js`
- CSS brace-balance check
- `npm test`

## Browser note
Automated Chromium visual QA could not run in this container because local HTTP navigation is blocked by administrator policy. Manual QA should check 1440px desktop, 1180px tablet-width, 390px phone-width, and Firefox.
