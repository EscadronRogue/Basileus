# Basileus

> A game of dynastic profiteering inside the Byzantine Empire.

Basileus is a 3-5 player strategy game where rival noble houses jockey for titles, gold, and the throne while invasions hammer the frontier. It runs in the browser, supports hot-seat play, includes local evolving-policy AI seats, and includes a pure Node WebSocket multiplayer server.

[![CI](https://github.com/EscadronRogue/Basileus/actions/workflows/ci.yml/badge.svg)](https://github.com/EscadronRogue/Basileus/actions/workflows/ci.yml)
[![Deploy](https://github.com/EscadronRogue/Basileus/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/EscadronRogue/Basileus/actions/workflows/deploy-pages.yml)

**Play it online:** https://escadronrogue.github.io/Basileus/

## Highlights

- **Pure browser game.** No bundler, no transpiler, no runtime npm dependencies.
- **Multiplayer.** Built-in WebSocket server (`multiplayer/server.js`) using only Node built-ins.
- **Local evolving AI.** AI seats use transparent learned heuristics and the same engine validators as human actions.
- **Deterministic core.** Seeded RNG throughout the engine so games are reproducible.

## Tech Stack

| Layer | Tech |
| --- | --- |
| Frontend | Vanilla JS (ES modules), CSS, SVG map |
| Backend | Node.js built-ins |
| Multiplayer | RFC 6455 WebSocket implementation in pure Node (`multiplayer/wsServer.js`) |
| Game rules | Deterministic engine modules under `engine/` |
| CI / Deploy | GitHub Actions, GitHub Pages |

## Getting Started

### Requirements

- **Node.js >= 22.4**. The multiplayer verifier uses the global `WebSocket`, which is stable from Node 22.4 onward.

### Run Locally - Windows

Double-click `start-local.bat`, or from PowerShell:

```powershell
./start-local.ps1
```

### Run Locally - macOS / Linux

```bash
npm run serve
```

Then open the URL printed by the server.

### Multiplayer Server

```bash
npm run serve:multiplayer
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run serve` | Static + multiplayer HTTP server. |
| `npm run serve:multiplayer` | Same server entry point, useful for deployment. |
| `npm run ai:train` | Runs local policy evolution and writes a named opponent under `ai/opponents/`. |
| `npm run ai:evolve` | Alias for `npm run ai:train`. |
| `npm run ai:evaluate` | Evaluates the current local policy. |
| `npm run ai:tournament` | Runs the richer policy-vs-baseline evaluation harness. |
| `npm run test:economy` | Engine/economy rules tests. |
| `npm run test:ai` | Evolving AI runtime, action, and learning smoke tests. |
| `npm run test:ui` | Browser controller and panel tests. |
| `npm run test:multiplayer` | End-to-end multiplayer protocol verifier. |
| `npm test` | Runs the full local test suite. |

## Online Multiplayer Deployment

GitHub Pages can only host the static frontend. To make the hosted game create and join multiplayer rooms, deploy the Node multiplayer server separately.

1. Create a Render web service from [`render.yaml`](render.yaml).
2. Let Render run `npm install` and start the service with `npm run serve:multiplayer`.
3. Copy the public Render URL for that service, such as `https://your-service.onrender.com`.
4. In GitHub, add a repository variable named `MULTIPLAYER_BACKEND_URL` with that URL.
5. Re-run the `Deploy to GitHub Pages` workflow, or push a new commit to `main`.

The Pages workflow injects `MULTIPLAYER_BACKEND_URL` into the deployed `index.html` at build time. The checked-in source stays blank so local development continues to use same-origin multiplayer automatically.

Render notes:

- The multiplayer server exposes `GET /healthz` for Render health checks.
- `render.yaml` defaults `ALLOWED_ORIGINS` to `https://escadronrogue.github.io`. Add more origins in Render if you later serve the frontend from a custom domain.
- The browser client sends a periodic WebSocket heartbeat and a lightweight `/healthz` HTTP keepalive so an active room still counts as inbound traffic on Render Free.

## Project Structure

```text
.
├── index.html              # Live game entry point
├── main.js                 # Front-end bootstrap (setup dialog, room/lobby flow)
├── ai/                     # Local evolving-policy learner and runtime
├── assets/                 # SVG map, hitzones, stylesheets
├── data/                   # Static game data (provinces, titles, invasion decks)
├── engine/                 # Pure rules engine (state, actions, combat, history)
├── multiplayer/            # Node WebSocket server + protocol verifier
├── render/                 # SVG map renderer
└── ui/                     # Browser-side controllers and panels
```

## Game Overview

Players are rival noble houses inside the Byzantine Empire. Each round, gold flows in from provinces, titles are auctioned and reshuffled, invasions strike the frontier, and players plot intrigue against each other. The Basileus seat rotates based on cascading title rules. Win by earning points for each 25% share of church income, estate income, tax income, and gold reserves while surviving the political fallout.

The full rule set lives in the engine. Read `engine/turnflow.js` and `engine/cascade.js` for the canonical source.

## Development

The repo intentionally has **zero runtime npm dependencies**. Please keep it that way unless there is a strong reason; one of the project's goals is "open the folder, run a server, play."

Useful entry points:

- `engine/state.js` - game state shape and reducers
- `engine/turnflow.js` - round/phase orchestration
- `ai/brain.js` - evolving policy runtime integration
- `multiplayer/wsServer.js` - handcoded WebSocket framing

## Local Evolving AI

Evolve a policy locally:

```bash
npm run ai:train -- --episodes 1000
```

Evolve only from legal random midgame snapshots and short round rollouts:

```bash
npm run ai:train -- --training-mode round --episodes 1000 --rollout-rounds 1
```

Evolve from a hybrid of full games and short round rollouts:

```bash
npm run ai:train -- --training-mode hybrid --round-mode-rate 0.5 --episodes 1000 --rollout-rounds 1
```

The AI no longer uses layered black-box approximators or anonymous tensors. Every candidate action is described by named, rule-derived features: official score-share deltas, category-point deltas, title shifts, treasury changes, frontier troop coverage, reward choices, and target relations. Self-play learns transparent weights for those features.

The reward is outcome-driven: winning a survived game is `+1`, surviving without winning is `0`, and a fall of Constantinople assigns blame only to players who under-contributed to the defense relative to their legal frontier troop capacity. At each completed round, the learner also receives potential-based shaping from the official scoring rules: `(round / maxRounds) * (projected score points / maximum possible score)`, where the maximum possible score is derived from the four scoring categories and their three point thresholds.

Each trained AI is one named opponent file. New policies receive a random romanized Greek first name, and the setup menu lists exactly the JSON files present in `ai/opponents/`; no manifest is used. Drop a policy into that folder to make it playable, or remove it from the folder to remove it from the menu.

The learner writes checkpoints to `ai/policy-checkpoints/`, evaluates them with a small tournament, and promotes the best checkpoint to the named opponent output file. A starter opponent is committed under `ai/opponents/` so the local server has an AI opponent out of the box.

Human play can be folded back into learning as a human-opponent source. Single-player and multiplayer runtime actions are recorded as legal-action snapshots when an `aiMeta` runtime is active. In a local single-player browser session, run `window.__basileus.downloadHumanFeedback()` to export the current trace, then drop the exported JSON file into `ai/human-games/`:

```bash
mkdir ai/human-games
npm run ai:train -- --episodes 1000
```

Learning automatically scans `ai/human-games/` recursively for JSON exports. You can use `--human-games path/to/folder` or `--human-feedback path/to/file.json` when you want a specific dataset. The learner distills those games into a human-style policy opponent, mixes that opponent into self-play, and reports policy-vs-human tournament results when checkpoints are evaluated.

## License

All rights reserved. The source is published for transparency and personal/educational reading; no license to copy, modify, or redistribute is granted. Open an issue if you want to discuss broader use.
