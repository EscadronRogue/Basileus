# Roadmap

Living document. Captures work that's been deferred or scoped out so it
isn't lost.

## AI brain follow-ups

`ai/strategy.js` now provides a phase-aware heuristic planner. It scores
legal moves by projected scoring shares, threshold pressure, late throne
control, estate value, frontier risk, coup pressure, and reward choices.

Worth improving next:

1. Add seeded head-to-head balance tests that measure win rates and average
   point margins across full games.
2. Teach AI seats to negotiate formal deals once the deal UI and AI timing
   expectations are both stable enough.
3. Tune deployment assumptions against observed human play, especially how
   much capital support opponents reserve during high-threat invasions.

## File splits

Several modules have crossed the threshold where single edits routinely
break unrelated functionality:

- `engine/deals.js` — 1.5k lines, covers clause normalisation, validation,
  thread state, and reservation. Likely splits: `deals/clauses.js`,
  `deals/threads.js`, `deals/reservations.js`.
- `render/mapRenderer.js` — 1.6k lines. Splits along map layers (provinces,
  troops, overlays, animations) would localise changes.
- `ui/panels.js` — 1k lines. One file per panel (`panels/court.js`,
  `panels/estates.js`, `panels/orders.js`, …) plus a small index.
- `ui/multiplayerController.js` — 1k lines. Could split lobby vs. live game
  controllers.
- `assets/style.css` — 4.6k lines. Worth splitting by area (map, panels,
  setup, balance, history) with `@import` from the top file.

These splits are deferred because the test surface is shallow and
regressions are easy to hide.
