# Roadmap

Living document. Captures work that's been deferred or scoped out so it
isn't lost.

## AI brain

`ai/brain.js` is a placeholder. AI seats currently:

- Confirm in court without taking any action.
- Pick the first legal deployment plan, preferring the incumbent in coup
  scenarios.
- Auto-resolve defender rewards as `'empire'`.

Reinstating a real AI involves at minimum:

1. A planning component that scores legal moves rather than picking the
   first one (`ai/legalActions.js` already generates the move set).
2. A court-phase strategy that uses the action budget instead of skipping
   straight to confirm.
3. Test coverage that asserts the AI plays plausibly (wins against the
   placeholder by a healthy margin in seeded games), not just that it
   submits a legal move.

The old RL experiment was removed because it was too brittle to maintain
alongside rule changes. A heuristic agent is a safer next step.

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
