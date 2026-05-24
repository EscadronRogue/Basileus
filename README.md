# Basileus

> A game of dynastic profiteering inside the Byzantine Empire.

Basileus is a 3-5 player strategy game where rival noble houses jockey for titles, gold, and the throne while invasions hammer the frontier. It runs in the browser, supports hot-seat play, includes named strategic AI seats, and includes a pure Node WebSocket multiplayer server.

[![CI](https://github.com/EscadronRogue/Basileus/actions/workflows/ci.yml/badge.svg)](https://github.com/EscadronRogue/Basileus/actions/workflows/ci.yml)
[![Deploy](https://github.com/EscadronRogue/Basileus/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/EscadronRogue/Basileus/actions/workflows/deploy-pages.yml)

**Play it online:** https://escadronrogue.github.io/Basileus/

## Highlights

- **Pure browser game.** No bundler, no transpiler, no runtime npm dependencies.
- **Multiplayer.** Built-in WebSocket server (`multiplayer/server.js`) using only Node built-ins.
- **Strategic AI seats.** AI slots can be reserved and named. They use a phase-aware heuristic planner for titles, court powers, estate bids, deployment, and title redistribution while routing every move through the same legal command layer as humans.
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
| `npm run simulate:ai -- --games 200 --players 5 --deck 9` | Runs deterministic all-AI simulation batches and reports aggregate behavior. |
| `npm run train:ai -- --generations 3 --population 10 --games 24` | Tunes strategy weights against a mixed AI policy league and saves the best tuned opponent. |
| `npm run test:economy` | Engine/economy rules tests. |
| `npm run test:ai` | Strategic AI and legal-action smoke tests. |
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
├── ai/                     # Strategic AI planner, Greek names, and legal action generation
├── assets/                 # SVG map, hitzones, stylesheets
├── data/                   # Static game data (provinces, titles, invasions)
├── engine/                 # Pure rules engine (state, actions, combat, history)
├── multiplayer/            # Node WebSocket server + protocol verifier
├── render/                 # SVG map renderer
└── ui/                     # Browser-side controllers and panels
```

## Game Overview

Players are rival noble houses inside the Byzantine Empire. Each round attempts to draw an invasion, opens Court where major offices may make up to two appointments or revocations in any mix while the Basileus may make up to four revocations of strategoi or private estates, pays estate and church income, resolves sealed bids for free estates, and resolves simultaneous Deployment. Private estates bought in the previous turn cannot be revoked yet; when an older private estate is revoked, its owner receives 1 gold. Major titles are redistributed before Court only when a coup has installed a new Basileus. During Deployment, all Strategos troops controlled by one player deploy together as one Strategoi army. Some invasions march on Constantinople, while limited invasions only threaten their configured target route and do not launch if no target province remains under imperial control; skipped invasions can be drawn again later if their route becomes relevant. After the last played turn, Court resolves and a final income phase runs. Win by earning points for each 10% share of gold reserves, profit income, and combined office income (church plus troop income) from that last income phase while surviving the political fallout. If Constantinople falls, everyone loses; the final standings only record who held the strongest position when the empire collapsed.

The full rule set lives in the engine. Read `engine/turnflow.js` and `engine/cascade.js` for the canonical source.

## Development

The repo intentionally has **zero runtime npm dependencies**. Please keep it that way unless there is a strong reason; one of the project's goals is "open the folder, run a server, play."

Useful entry points:

- `engine/state.js` - game state shape and reducers
- `engine/turnflow.js` - round/phase orchestration
- `ai/brain.js` - strategic AI runtime integration
- `multiplayer/wsServer.js` - handcoded WebSocket framing

## AI Layer

AI seats use legal action generation plus a compact strategic evaluator. The evaluator projects income-share scoring, watches 10% scoring thresholds, values late throne control, weighs frontier danger against coup pressure, and chooses estate bids, court appointments/revocations, deployment orders, and title redistribution.

Simulation and training tools live beside the runtime AI. `ai/simulate.js` can run repeatable all-AI batches with policy mixes such as strategic, random, defender, usurper, profiteer, loyalist, greedy, and copycat. `ai/train.js` runs a lightweight evolutionary search over strategic weights, re-ranks a finalist pool, saves the top tuned champions to `ai/tunedOpponents.json`, and gives each one a Greek first name from `ai/greekNames.js`.

Training defaults to the `robust` opponent mix: roughly one third candidate self-play, a saved tuned champion pool when available, mostly strong built-in styles, and only a small random/copycat oddball share. Use `--opponent-mix beginner` to preserve the original easier mix: 25% self-play plus an even split across strategic, defender, usurper, profiteer, random, and copycat.

Training always creates a fresh random seed. By default it trains on 5-player, 9-turn games. Pass comma lists or ranges to train across varied setups in one run, such as `--players 3,4,5 --deck 6,9,12` or `--players 3-5`.

Training uses staged evaluation by default: broad candidate screening uses fewer games, then the strongest distinct finalists are re-tested with the full `--games` budget. The CLI trainer also uses worker threads by default; pass `--workers 1` for serial evaluation. The trainer prints progress while it runs: generation starts, candidate scores, finalist scores, generation winners, final champion leaderboard, and the saved opponents. Use `--quiet` to suppress the progress log, or `--json` for machine-readable output without progress lines.

When trained opponents are available, new single-player games assign AI seats from that trained champion pool by default. Built-in strategy styles remain available as a fallback when no tuned opponents have been saved yet.

The named opponent catalog is intentionally lightweight: names identify seats, while the shared strategic planner makes the decisions.

## License

All rights reserved. The source is published for transparency and personal/educational reading; no license to copy, modify, or redistribute is granted. Open an issue if you want to discuss broader use.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for branch, commit-message,
and testing conventions.
