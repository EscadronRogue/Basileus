# Layout Breathing Pass

## Diagnostic

The previous responsive pass made the game usable on narrow screens, but the main layout still had three pressure points:

1. **Map canvas pressure**
   - The map SVG was allowed to fill all available horizontal and vertical space.
   - The decorative frame around the map area was larger than the rendered map, which made the canvas feel oversized even when the actual map content was smaller.
   - The bottom tab rail had too little reserved vertical space, so the player rectangles felt pinned to the bottom edge.

2. **Interface column pressure**
   - The sidebar was still too narrow on desktop and medium screens.
   - Panels were stacked edge-to-edge with little separation, so dashboard, history, and action controls visually merged.
   - Several rows used dense flex layouts where labels, values, buttons, and badges competed for the same line.

3. **Rigid component sizing**
   - Repeated card grids used small minimum column widths.
   - Appointment, market, finance, candidate, deployment, mercenary, and revocation controls did not have enough spacing to wrap cleanly.
   - Mobile map height consumed too much of the viewport relative to the interface below it.

## Applied plan

1. **Constrain the map instead of letting it dominate**
   - Preserve the map SVG aspect ratio.
   - Remove the oversized decorative frame around the map area.
   - Give the SVG itself the visible border/shadow so the visible canvas is the map canvas.
   - Increase the bottom reservation for player tabs.
   - Slightly reduce mobile map rows to leave more room for interface content.

2. **Give the interface column more width and internal rhythm**
   - Increase desktop sidebar width dynamically with `clamp()`.
   - Raise the single-column breakpoint from 900px to 980px so medium screens stop compressing both map and sidebar.
   - Add sidebar padding and gaps between dashboard/history/action panels.
   - Increase shared panel padding.

3. **Relax cramped controls and information rows**
   - Increase min widths for dashboard stats, finance cards, market/gift items, and appointment columns.
   - Add more spacing in list rows, fold sections, history cards, theme chips, choice grids, and revocation controls.
   - Let candidate rows, mercenary rows, deployment rows, and mobile value badges wrap more naturally.
   - Convert deployment rows to a responsive grid where appropriate.

4. **Keep the pass code-light**
   - No game logic changes.
   - No rendering algorithm changes.
   - Main changes are CSS layout constraints and spacing tokens.

## QA performed

- CSS brace balance checked.
- Full project tests passed with `npm test`.
- No game-state or multiplayer logic was touched.

## Manual visual QA targets

Check these viewport classes after deployment:

- Desktop wide: 1440×900 and 1920×1080.
- Medium desktop/tablet landscape: 1024×768 and 1180×820.
- Phone portrait: 390×844 and 430×932.
- Firefox desktop and Firefox Android, focusing on map sizing, wrapping controls, and panel spacing.
