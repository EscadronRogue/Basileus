# Roadmap

Living document. Captures work that's been deferred or scoped out so it
isn't lost.

## Done

- **File splits.** `engine/deals.js`, `render/mapRenderer.js`,
  `ui/panels.js`, `ui/multiplayerController.js`, and `assets/style.css` now
  re-export or `@import` smaller modules under `engine/deals/`, `render/map/`,
  `ui/panels/`, `ui/multiplayer/`, and `assets/css/`.
- **Balance tests.** `ai/balance.test.js` runs a seeded batch of full games;
  `npm run simulate:ai` reports win rate per seat and empire falls by round
  and by invader, in parallel across worker threads.
- **AI deals, first step.** AI dynasties accept or refuse offers sent to them
  (`ai/deals.js`).
- **Tutorial and glossary.** A separate tutorial game guides one full round;
  key words explain themselves on hover in every game.
- **AI personalities.** Seven temperaments trained on game outcomes only
  (`ai/personalities.js`, `ai/train.js`, `docs/ai-training.md`).

## Game design decisions

These need a designer's call rather than code:

1. **Round-1 falls.** Invasions in the first two rounds are capped at easy
   strength (`EARLY_INVASION_GRACE_ROUNDS` in `data/invasions.js`). That cut
   round-2 falls from about 8% to 3% of games, but round-1 falls stay near 8%
   in simulation. Nearly all come from the Bulgars (draw weight 20), whose
   route starts in provinces that begin occupied (PAR, BUL), leaving only four
   imperial provinces before the capital. Options: the capital cannot fall
   during grace rounds; a lower Bulgar weight; start PAR or BUL imperial.

## AI brain follow-ups

`ai/strategy.js` provides a phase-aware heuristic planner. It scores legal
moves by projected scoring shares, threshold pressure, late throne control,
estate value, frontier risk, coup pressure, and reward choices.

Worth improving next:

1. **AI-initiated deals and counter-offers.** AI seats only answer offers;
   they never propose one or counter. Personalities would make this richer:
   a Kingmaker offering coup support for offices, a Landlord buying estates.
2. Tune deployment assumptions against observed human play, especially how
   much capital support opponents reserve during high-threat invasions.
3. Train against recorded human games once there are some, so the league
   includes real human habits rather than only presets.

## Known limitations

- A dynasty that holds no office is auto-confirmed when Court opens, so it
  cannot negotiate deals that round.
