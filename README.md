# Basileus

> A game of dynastic profiteering inside the Byzantine Empire.

Basileus is a 3-5 player strategy game where rival noble houses jockey for titles, gold, and the throne while invasions hammer the frontier. It runs in the browser, supports hot-seat play, includes named strategic AI dynasties, and includes a pure Node WebSocket multiplayer server.

[![CI](https://github.com/EscadronRogue/Basileus/actions/workflows/ci.yml/badge.svg)](https://github.com/EscadronRogue/Basileus/actions/workflows/ci.yml)
[![Deploy](https://github.com/EscadronRogue/Basileus/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/EscadronRogue/Basileus/actions/workflows/deploy-pages.yml)

**Play it online:** https://escadronrogue.github.io/Basileus/

## Highlights

- **Pure browser game.** No bundler, no transpiler, no runtime npm dependencies.
- **Multiplayer.** Built-in WebSocket server (`multiplayer/server.js`) using only Node built-ins.
- **Interactive tutorial.** "Play the tutorial" on the setup screen walks you through a full round, pointing at each control, then lets you finish a short game.
- **Hover glossary.** Key words are bold wherever they appear; hover one for its definition, and keep hovering to lock the tooltip and explore the words inside it.
- **Two maps.** Classic, with 40 provinces, or Compact, with 21 larger provinces fused from them, for smaller armies and less gold.
- **AI rivals with personalities.** Nineteen temperaments, each selfish in its own way (Usurper, Opportunist, Landlord, Kingmaker, Tyrant, Patron, Miser, Hoarder, Saboteur, Regicide, Glory Hunter, Domain Lord, Condottiere, Turncoat, Loyalist and Strategist), plus three explorers (Maverick, Wildcard, Outsider) that started from random weights and found their own way to win. All are trained by self-play on both maps, with 3 to 5 dynasties and 6 to 12 rounds, to win rather than to play safe. Every AI move goes through the same legal command layer as a human's.
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
| `npm run simulate:ai -- --map compact` | The same on the Compact map. |
| `npm run train:ai -- --generations 3 --from-roster` | Tunes strategy weights against a mixed AI policy league on both maps and saves the best tuned opponents. See [`docs/ai-training.md`](docs/ai-training.md). |
| `npm run build:rules-doc` | Regenerates `docs/rules.md` from `ui/rules.js`. |
| `npm run build:svg-fallback` | Regenerates `render/svgAssets.js` after editing `assets/*.svg`. |
| `npm run build:compact-map` | Rebuilds `assets/hitzones-compact.svg` (the Compact map's fused provinces) from `assets/hitzones.svg`, then the fallback. Needs `npm install`. |
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

Players are rival noble houses inside the Byzantine Empire. Each round an invasion is drawn; the major offices appoint and revoke Strategoi and Bishops, and the Basileus may revoke estates; offices and estates pay out; dynasties secretly plan new estates, which pay more when gathered into domains; and everyone secretly sends troops to the frontier or to Constantinople. Estates and mercenaries cost the same whatever the quantity, and so does every province in the war. Every invasion's strength is known when it is drawn: the farther the invader comes from, the stronger it is, and the threat grows every round. The coup is settled before the war: the throne can change hands while the empire burns. After the last round, dynasties score for their share of the empire's wealth, unless Constantinople falls and everyone loses.

The game is played on one of two maps. Classic has 40 provinces. Compact fuses them into 21 larger ones, each raising 1 troop, so armies and income stay small; a few values are tuned for it (`MAP_BALANCE` in `data/balance.js`).

The complete rules are in [`docs/rules.md`](docs/rules.md), generated from [`ui/rules.js`](ui/rules.js) and the glossary in [`ui/glossary.js`](ui/glossary.js), which are also what the in-game "How to Play" card and hover tooltips show. Edit them there and run `npm run build:rules-doc`.

## Development

The repo intentionally has **zero runtime npm dependencies**. Please keep it that way unless there is a strong reason; one of the project's goals is "open the folder, run a server, play."

Useful entry points:

- `engine/state.js` - game state shape and reducers
- `engine/turnflow.js` - round/phase orchestration
- `game/runtime.js` - drives phases and AI seats for every game mode
- `ai/brain.js` - strategic AI runtime integration
- `data/maps/` - the two maps: provinces, invasion routes, and the Compact map's fusions
- `data/balance.js` - every tuning value, with per-map overrides
- `ui/rules.js`, `ui/glossary.js` - the rules text, key-word definitions, and `docs/rules.md` source
- `ui/tutorial/` - the tutorial game's script (`steps.js`) and guide overlay (`tutorial.js`)
- `multiplayer/wsServer.js` - handcoded WebSocket framing

`scripts/layering.test.js` enforces the layer boundaries: `engine/` imports only `data/`, `ai/` never imports the UI, and browser code never imports Node built-ins.

Single-player and hotseat games autosave to the browser's `localStorage` and can be resumed from the setup screen.

## AI Layer

AI dynasties use legal action generation plus a compact strategic evaluator. The evaluator projects share-based scoring, watches scoring thresholds, values late throne control, weighs frontier danger against coup pressure, and chooses estate plans, appointments and revocations, deployment orders, and office handouts.

Each AI opponent has a **personality** (`ai/personalities.js`), one of nineteen: Usurper, Opportunist, Landlord, Kingmaker, Tyrant, Patron, Miser, Hoarder, Saboteur, Regicide, Glory Hunter, Domain Lord, Condottiere, Turncoat, Loyalist, Strategist, and the explorers Maverick, Wildcard and Outsider. A personality fixes the weights that make its temperament; `ai/train.js` tunes the rest by playing thousands of games, and it rewards only winning. A fallen empire counts as a loss for everyone, and nothing rewards prudence for its own sake, so a trained AI will let others defend, or strip the capital to seize the throne, whenever that wins more games. The trained roster lives in `ai/tunedOpponents.json`, one Greek-named AI per personality; the setup screen shows each one's temperament, and in game its name carries it (e.g. "Leon Doukas (Usurper AI)").

`ai/simulate.js` runs repeatable all-AI batches on either map and reports empire falls, war and coup outcomes, deployment habits, income per round, and win rate per seat and per AI.

AI dynasties answer formal deal offers as soon as they receive them (`ai/deals.js`): each clause is valued from the AI's side, conditional clauses are discounted, and the offer must clear a bar that is lower for trusted partners and higher for a runaway leader. They do not propose or counter deals yet.

Every simulation and training flag is documented in [`docs/ai-training.md`](docs/ai-training.md).

## License

All rights reserved. The source is published for transparency and personal/educational reading; no license to copy, modify, or redistribute is granted. Open an issue if you want to discuss broader use.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for branch, commit-message,
and testing conventions.
