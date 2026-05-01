# Basileus

> A game of dynastic profiteering inside the Byzantine Empire.

Basileus is a 3–5 player strategy game where rival noble houses jockey for titles, gold, and the throne while invasions hammer the frontier. It runs entirely in the browser, supports hot-seat / single-player vs trained AI, and includes a WebSocket multiplayer server and a Simulation Lab that batch-trains AI personalities through self-play.

[![CI](https://github.com/EscadronRogue/Basileus/actions/workflows/ci.yml/badge.svg)](https://github.com/EscadronRogue/Basileus/actions/workflows/ci.yml)
[![Deploy](https://github.com/EscadronRogue/Basileus/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/EscadronRogue/Basileus/actions/workflows/deploy-pages.yml)

**Play it online:** https://escadronrogue.github.io/Basileus/

## Highlights

- **Pure browser game.** No bundler, no transpiler, no npm dependencies — just HTML, CSS, and ES modules.
- **Trained AI opponents.** Ten curated personalities (`trained-personalities/definitive/`) produced by an evolutionary self-play loop in the Simulation Lab.
- **Multiplayer.** Built-in WebSocket server (`multiplayer/server.js`) — no external libraries; runs anywhere Node 20+ runs.
- **Simulation Lab.** A separate page (`simulator.html`) for stress-testing the live ruleset and breeding new AI rosters.
- **Deterministic core.** Seeded RNG throughout the engine so games and simulations are reproducible.

## Tech stack

| Layer | Tech |
| --- | --- |
| Frontend | Vanilla JS (ES modules), CSS, SVG map |
| Backend | Node.js (built-ins only — `node:http`, `node:worker_threads`, `node:crypto`) |
| Multiplayer | RFC 6455 WebSocket implementation in pure Node (`multiplayer/wsServer.js`) |
| Simulation | Worker-thread fan-out, evolutionary search over personality genomes |
| CI / Deploy | GitHub Actions, GitHub Pages |

## Getting started

### Requirements
- **Node.js ≥ 20** (CI runs on 22). Check with `node --version`.

### Run locally — Windows
Double-click `start-local.bat`, or from PowerShell:
```powershell
./start-local.ps1
```

### Run locally — macOS / Linux
```bash
npm run serve
# then open http://127.0.0.1:8123/
```

### Multiplayer server
```bash
npm run serve:multiplayer
```

### Simulation Lab
After starting the local server, open http://127.0.0.1:8123/simulator.html.

### Headless training
```bash
npm run train:node -- --parallelWorkers=auto
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run serve` | Static + training HTTP server on port 8123. |
| `npm run serve:multiplayer` | WebSocket multiplayer server. |
| `npm run train:node` | Headless evolutionary training run. |
| `npm run smoke:simulation` | Fast worker-based smoke test of the engine. |
| `npm run test:multiplayer` | End-to-end test of the multiplayer protocol. |
| `npm test` | Runs both the smoke test and the multiplayer verifier. |

## Project structure

```
.
├── index.html              # Live game entry point
├── simulator.html          # Simulation Lab entry point
├── main.js                 # Front-end bootstrap (setup dialog, room/lobby flow)
├── ai/                     # AI personality model + profile store
├── assets/                 # SVG map, hitzones, stylesheets
├── data/                   # Static game data (provinces, titles, invasion decks)
├── engine/                 # Pure rules engine (state, actions, combat, history)
├── multiplayer/            # Node WebSocket server + protocol verifier
├── render/                 # SVG map renderer
├── simulation/             # Trainer, workers, batch evaluation
├── trained-personalities/  # Curated and historical AI rosters
└── ui/                     # Browser-side controllers and panels
```

## Game overview

Players are rival noble houses inside the Byzantine Empire. Each round, gold flows in from provinces, titles are auctioned and reshuffled, invasions strike the frontier, and players plot intrigue against each other. The Basileus (emperor) seat rotates based on cascading title rules. Win by accumulating wealth, holding the right offices at the right moment, and surviving the political fallout.

The full rule set lives in the engine — read `engine/turnflow.js` and `engine/cascade.js` if you want the canonical source.

## Development

The repo intentionally has **zero runtime npm dependencies**. Please keep it that way unless there is a strong reason; one of the project's goals is "open the folder, run a server, play."

Useful entry points when contributing:
- `engine/state.js` — game state shape and reducers
- `engine/turnflow.js` — round/phase orchestration
- `ai/brain.js` — AI decision policy
- `simulation/evolution.js` — evolutionary trainer
- `multiplayer/wsServer.js` — handcoded WebSocket framing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

All rights reserved. The source is published for transparency and personal/educational reading; no license to copy, modify, or redistribute is granted. Open an issue if you want to discuss broader use.
