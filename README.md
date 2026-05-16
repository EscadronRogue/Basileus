# Basileus

> A game of dynastic profiteering inside the Byzantine Empire.

Basileus is a 3-5 player strategy game where rival noble houses jockey for titles, gold, and the throne while invasions hammer the frontier. It runs in the browser, supports hot-seat play, includes built-in heuristic AI seats, and includes a pure Node WebSocket multiplayer server.

[![CI](https://github.com/EscadronRogue/Basileus/actions/workflows/ci.yml/badge.svg)](https://github.com/EscadronRogue/Basileus/actions/workflows/ci.yml)
[![Deploy](https://github.com/EscadronRogue/Basileus/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/EscadronRogue/Basileus/actions/workflows/deploy-pages.yml)

**Play it online:** https://escadronrogue.github.io/Basileus/

## Highlights

- **Pure browser game.** No bundler, no transpiler, no runtime npm dependencies.
- **Multiplayer.** Built-in WebSocket server (`multiplayer/server.js`) using only Node built-ins.
- **Heuristic AI.** AI seats use named strategic personalities and the same engine validators as human actions.
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
| `npm run ai:evaluate` | Evaluates a heuristic strategy or a single matchup. |
| `npm run ai:tournament` | Runs the heuristic league against self-play, pairwise, and random baselines. |
| `npm run test:economy` | Engine/economy rules tests. |
| `npm run test:ai` | Heuristic AI runtime, action, and simulation smoke tests. |
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
├── ai/                     # Heuristic opponents, legal action generation, simulations
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
- `ai/brain.js` - heuristic AI runtime integration
- `multiplayer/wsServer.js` - handcoded WebSocket framing

## Heuristic AI

AI seats are built-in named strategies. Each candidate action is generated through the same legal action layer as human play, then scored with rule-aware heuristics: official score deltas, category shares, title control, frontier coverage, coup pressure, treasury efficiency, reward choices, and target pressure against leaders.

Current personalities:

- `alexios` - balanced score growth, throne pressure, and empire survival.
- `irene` - defensive tax command and low-risk imperial continuity.
- `zoe` - court appointments, church income, revocations, and intrigue.
- `niketas` - estate purchases, gold reserves, and selective mercenary spending.
- `basil` - troops, frontier command, and aggressive capital claims.

Run the full league:

```bash
npm run ai:tournament -- --episodes 20 --seed-count 3
```

Run one matchup:

```bash
npm run ai:evaluate -- --tournament --matchup --strategy basil --opponent random
```

## License

All rights reserved. The source is published for transparency and personal/educational reading; no license to copy, modify, or redistribute is granted. Open an issue if you want to discuss broader use.
