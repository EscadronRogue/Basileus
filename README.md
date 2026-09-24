# Basileus

> A game of dynastic profiteering inside the Byzantine Empire.

Basileus is a 3-5 player strategy game where rival noble houses jockey for titles, gold, and the throne while invasions hammer the frontier. It runs in the browser, supports hot-seat play, includes named strategic AI dynasties, and includes a pure Node WebSocket multiplayer server.

[![CI](https://github.com/EscadronRogue/Basileus/actions/workflows/ci.yml/badge.svg)](https://github.com/EscadronRogue/Basileus/actions/workflows/ci.yml)
[![Deploy](https://github.com/EscadronRogue/Basileus/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/EscadronRogue/Basileus/actions/workflows/deploy-pages.yml)

**Play it online:** https://escadronrogue.github.io/Basileus/

## Highlights

- **Pure browser game.** No bundler, no transpiler, no runtime npm dependencies.
- **Multiplayer.** Built-in WebSocket server (`multiplayer/server.js`) using only Node built-ins.
- **Strategic AI dynasties.** AI dynasties can be reserved and named. They use a phase-aware heuristic planner for titles, court powers, estate bids, deployment, and title redistribution while routing every move through the same legal command layer as humans.
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

- **Node.js >= 22.4** (see `engines` in `package.json`; CI runs Node 22 and 24).
- For the browser smoke tests only: `npm install` then `npx playwright install chromium`. The game itself has no npm dependencies.

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
| `npm run simulate:ai -- --games 200 --players 5 --deck 9` | Runs deterministic all-AI batches (in parallel) and reports balance: fall rate, falls by round and invader, win rate per seat, and more. |
| `npm run train:ai -- --generations 3 --population 10 --games 24` | Tunes strategy weights against a mixed AI policy league and saves the best tuned opponents. See [`docs/ai-training.md`](docs/ai-training.md). |
| `npm run build:rules-doc` | Regenerates `docs/rules.md` from `ui/rules.js`. |
| `npm run build:svg-fallback` | Regenerates `render/svgAssets.js` after editing `assets/*.svg`. |
| `npm test` | Runs the full unit suite (no browser needed). |
| `npm run test:data` | Game data integrity, layering rules, and generated-file sync. |
| `npm run test:economy` | Engine/economy rules tests. |
| `npm run test:ai` | Strategic AI, AI deals, seeded balance, and save/restore tests. |
| `npm run test:ui` | Browser controller and panel tests. |
| `npm run test:multiplayer` | Room, HTTP server, and multiplayer protocol tests. |
| `npm run test:browser` | Real-browser smoke tests in headless Chromium (Playwright). |

## Online Multiplayer Deployment

GitHub Pages can only host the static frontend. To make the hosted game create and join multiplayer rooms, deploy the Node multiplayer server separately.

1. Create a Render web service from [`render.yaml`](render.yaml).
2. Let Render run `npm ci --omit=dev` and start the service with `npm run serve:multiplayer`.
3. Copy the public Render URL for that service, such as `https://your-service.onrender.com`.
4. In GitHub, add a repository variable named `MULTIPLAYER_BACKEND_URL` with that URL.
5. Re-run the `Deploy to GitHub Pages` workflow, or push a new commit to `main`.

The Pages workflow injects `MULTIPLAYER_BACKEND_URL` into the deployed `index.html` at build time. The checked-in source stays blank so local development continues to use same-origin multiplayer automatically.

Render notes:

- The multiplayer server exposes `GET /healthz` for Render health checks.
- `render.yaml` defaults `ALLOWED_ORIGINS` to `https://escadronrogue.github.io`. Add more origins in Render if you later serve the frontend from a custom domain.
- The browser client sends a periodic WebSocket heartbeat and a lightweight `/healthz` HTTP keepalive so an active room still counts as inbound traffic on Render Free.
- Rooms live in memory. A room with no open connections is dropped after 12 hours idle (1 hour once finished), and the server hosts at most 500 rooms; override with `ROOM_IDLE_TTL_MINUTES`, `FINISHED_ROOM_TTL_MINUTES`, and `MAX_ROOMS`. Room creation and joining are rate-limited per client address. Hosts can download a save file from the room to restore a match after a restart.

## Project Structure

```text
.
├── index.html              # Live game entry point
├── main.js                 # Front-end bootstrap (setup dialog, resume, room/lobby flow)
├── data/                   # Static game data (provinces, titles, invasions)
├── engine/                 # Pure, deterministic rules engine; never imports ai/ or ui/
├── ai/                     # AI planner, deal judgement, simulation and training tools
├── game/                   # Runtime that drives engine + AI seats; save/restore helpers
├── render/                 # SVG map renderer (render/map/*)
├── ui/                     # Browser controllers, panels, rules text, autosave
├── multiplayer/            # Node HTTP + WebSocket server and rooms
├── assets/                 # SVG maps, fonts, and stylesheets (assets/css/*)
├── scripts/                # Generators and repository-wide tests
├── e2e/                    # Real-browser smoke tests
└── docs/                   # Rules, AI training guide, roadmap
```

## Game Overview

Players are rival noble houses inside the Byzantine Empire. Each round an invasion is drawn, the great offices appoint and revoke at Court, estates and offices pay out, dynasties bid for land, and everyone secretly deploys troops to the frontier or the capital. The coup is settled before the war: the throne can change hands while the empire burns. After the last turn, dynasties score for their share of gold, profit income, and office income, unless Constantinople falls and everyone loses.

The complete rules are in [`docs/rules.md`](docs/rules.md), generated from [`ui/rules.js`](ui/rules.js), which is also what the in-game "How to Play" card and per-phase guides render. Edit the rules there and run `npm run build:rules-doc`.

## Development

The repo intentionally has **zero runtime npm dependencies**. Please keep it that way unless there is a strong reason; one of the project's goals is "open the folder, run a server, play."

Useful entry points:

- `engine/state.js` - game state shape and reducers
- `engine/turnflow.js` - round/phase orchestration
- `game/runtime.js` - drives phases and AI seats for every game mode
- `ai/brain.js` - strategic AI runtime integration
- `ui/rules.js` - the rules text, in-game guides, and `docs/rules.md` source
- `multiplayer/wsServer.js` - handcoded WebSocket framing

`scripts/layering.test.js` enforces the layer boundaries: `engine/` imports only `data/`, `ai/` never imports the UI, and browser code never imports Node built-ins.

Single-player and hotseat games autosave to the browser's `localStorage` and can be resumed from the setup screen.

## AI Layer

AI dynasties use legal action generation plus a compact strategic evaluator. The evaluator projects income-share scoring, watches 10% scoring thresholds, values late throne control, weighs frontier danger against coup pressure, and chooses estate bids, court appointments/revocations, deployment orders, and title redistribution.

Simulation and training tools live beside the runtime AI. `ai/simulate.js` can run repeatable all-AI batches with policy mixes such as strategic, random, defender, usurper, profiteer, loyalist, greedy, and copycat. `ai/train.js` runs a lightweight evolutionary search over strategic weights, re-ranks a finalist pool, saves the top tuned champions to `ai/tunedOpponents.json`, and gives each one a Greek first name from `ai/greekNames.js`.

Training defaults to the `robust` opponent mix: roughly one third candidate self-play, a saved tuned champion pool when available, mostly strong built-in styles, and only a small random/copycat oddball share. Use `--opponent-mix beginner` to preserve the original easier mix: 25% self-play plus an even split across strategic, defender, usurper, profiteer, random, and copycat.

Training always creates a fresh random seed. By default it trains on 5-player, 9-turn games. Pass comma lists or ranges to train across varied setups in one run, such as `--players 3,4,5 --deck 6,9,12` or `--players 3-5`.

Training uses staged evaluation by default: broad candidate screening uses fewer games, then the strongest distinct finalists are re-tested with the full `--games` budget. The CLI trainer also uses worker threads by default; pass `--workers 1` for serial evaluation. The trainer prints progress while it runs: generation starts, candidate scores, finalist scores, generation winners, final champion leaderboard, and the saved opponents. Use `--quiet` to suppress the progress log, or `--json` for machine-readable output without progress lines.

When trained opponents are available, new single-player games assign AI dynasties from that trained champion pool by default. Built-in strategy styles remain available as a fallback when no tuned opponents have been saved yet.

The named opponent catalog is intentionally lightweight: names identify AI dynasties, while the shared strategic planner makes the decisions.

AI dynasties answer formal deal offers as soon as they receive them (`ai/deals.js`): each clause is valued from the AI's side, conditional clauses are discounted, and the offer must clear a bar that is lower for trusted partners and higher for a runaway leader. They do not propose or counter deals yet.

Every simulation and training flag is documented in [`docs/ai-training.md`](docs/ai-training.md).

## License

All rights reserved. The source is published for transparency and personal/educational reading; no license to copy, modify, or redistribute is granted. Open an issue if you want to discuss broader use.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for branch, commit-message,
and testing conventions.
