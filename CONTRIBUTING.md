# Contributing to Basileus

Thanks for the interest. This document is a quick reference for how the project is laid out and what's expected from a change.

## Ground rules

- **Zero runtime npm dependencies.** The project is intentionally dependency-free at runtime — please do not add packages to `package.json` without discussing first. Dev tooling can be added if there is a clear win.
- **Determinism.** The engine and AI must remain deterministic given a seed. If you touch RNG plumbing, run `npm run smoke:simulation` and confirm logs are reproducible.
- **Vanilla web.** No bundler, no transpiler, no framework. Use ES modules and modern browser APIs.
- **Small PRs.** One concern per PR. Rules changes, UI changes, and AI changes should generally land separately.

## Local development

```bash
# Run the static + training server (default port 8123)
npm run serve

# Run the multiplayer server
npm run serve:multiplayer

# Open http://127.0.0.1:8123/ for the live game
# Open http://127.0.0.1:8123/simulator.html for the Simulation Lab
```

Node 20 or newer is required (CI runs on 20 and 22).

## Tests

Before opening a PR:

```bash
npm test
```

This runs:
- `smoke:simulation` — boots a worker, plays a sample game, and asserts the engine doesn't crash, deadlock, or violate basic invariants.
- `test:multiplayer` — boots the WebSocket server in-process and round-trips the lobby protocol.

If you change rules, also play a full game from the UI; the smoke test is fast but shallow.

## AI changes

Changing `ai/brain.js` or any rule that affects the action space invalidates trained personalities. Either:

1. Retrain by running `npm run train:node -- --parallelWorkers=auto` and committing a fresh `trained-personalities/latest/manifest.json`, or
2. Document in the PR that retraining is deferred and open a follow-up issue.

## Commit style

Plain, factual subject lines. No need for Conventional Commits but be specific:

```
engine: stop empty province from receiving ducal title
ui: render Strategos badge on hover
ai: penalise lone-Patriarch openings
```

## Pull request checklist

The template covers it, but the short version is: tests pass, no new dependencies, rules / UI changes have a screenshot or a seed for reproducibility.
