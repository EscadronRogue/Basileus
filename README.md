# Basileus

> A game of dynastic profiteering inside the Byzantine Empire.

Basileus is a 3-5 player strategy game where rival noble houses jockey for titles, gold, and the throne while invasions hammer the frontier. It runs in the browser, supports hot-seat play, includes local neural self-play AI seats, and includes a pure Node WebSocket multiplayer server.

[![CI](https://github.com/EscadronRogue/Basileus/actions/workflows/ci.yml/badge.svg)](https://github.com/EscadronRogue/Basileus/actions/workflows/ci.yml)
[![Deploy](https://github.com/EscadronRogue/Basileus/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/EscadronRogue/Basileus/actions/workflows/deploy-pages.yml)

**Play it online:** https://escadronrogue.github.io/Basileus/

## Highlights

- **Pure browser game.** No bundler, no transpiler, no runtime npm dependencies.
- **Multiplayer.** Built-in WebSocket server (`multiplayer/server.js`) using only Node built-ins.
- **Local neural AI.** AI seats use a pure Node self-play trainer and the same engine validators as human actions.
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
| `npm run ai:train` | Runs local neural self-play and writes `ai/models/latest.json`. |
| `npm run ai:evaluate` | Evaluates the current local neural model. |
| `npm run ai:tournament` | Runs the richer model-vs-baseline evaluation harness. |
| `npm run test:economy` | Engine/economy rules tests. |
| `npm run test:ai` | Neural AI runtime, action, and trainer smoke tests. |
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
├── ai/                     # Local neural self-play trainer and runtime
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
- `ai/brain.js` - neural runtime integration
- `multiplayer/wsServer.js` - handcoded WebSocket framing

## Local Neural AI

Train a model locally:

```bash
npm run ai:train -- --episodes 1000
```

Train only from legal random midgame snapshots and short round rollouts:

```bash
npm run ai:train -- --training-mode round --episodes 1000 --rollout-rounds 1
```

Train from a hybrid of full games and short round rollouts:

```bash
npm run ai:train -- --training-mode hybrid --round-mode-rate 0.5 --episodes 1000 --rollout-rounds 1
```

By default, training samples a fresh mix of 3-5 player games and 6-12 round invasion decks, gives every episode its own random seed, and chooses a worker count from the machine's available CPU parallelism. It also trains for multiple epochs per collected batch, mixes learner seats against random/checkpoint/self-play opponents, and temporarily disables deal actions for AI training and runtime AI play while the core survival policy learns. The model reward is outcome-driven: winning a survived game is `+1`, surviving without winning is `0`, and a fall of Constantinople assigns blame only to players who under-contributed to the defense relative to their legal frontier troop capacity. At each completed round, the learner also receives potential-based shaping from the official scoring rules: `(round / maxRounds) * (projected score points / maximum possible score)`, where the maximum possible score is derived from the four scoring categories and their three point thresholds. That round reward is attached once to the player's latest neural decision in the round, then cumulative returns propagate it backward through earlier decisions. Pass `--terminal-reward-mode score` only when you explicitly want the old score-shaped terminal reward. Pass `--heuristic-opponent-rate 0.25` only when you explicitly want scripted defensive opponents in the training mix. Pass `--players 4`, `--rounds 9`, `--seed 1`, or `--workers 4` when you want to pin any of those for a controlled run. You can also tune ranges with `--player-min`, `--player-max`, `--round-min`, and `--round-max`.

Pass `--training-mode round` when you want the trainer to use only the short-rollout method. Each training episode starts by simulating a random legal game up to a sampled snapshot round, then trains the learner only on the next `--rollout-rounds` completed rounds. This keeps the sampled positions legal without hand-authoring impossible province/title states. In this mode, completing the planned rollout without Constantinople falling counts as survival for both training reward and feedback metrics, and the current official score leader at that round boundary counts as the winner. Snapshot failures before the learner actually plays the rollout do not count as rollout outcomes. Use `--snapshot-round 4` to pin the starting round, or `--snapshot-round-min 2 --snapshot-round-max 8` to sample a midgame range.

Pass `--training-mode hybrid` to mix classic full games with legal round snapshots in the same run. `--round-mode-rate 0.5` means roughly half the episodes are short round rollouts and half are full games; lower it when you want more end-to-end victory pressure, raise it when you want more dense tactical feedback.


The trainer prints live progress with rolling feedback-window metrics: recent episode count, speed, generated training decisions, total/policy/value loss, average learner return, positive-return rate, survival/fall/stall rates, average rounds, frontier troop share, learner/opponent role mix, and win/survival rates by both seat and controller role. Each progress line describes only the episodes generated since the previous feedback line, while the final summary and stdout JSON describe the whole run concisely. It writes checkpoints to `ai/checkpoints/`, evaluates them with a small tournament, and promotes the best checkpoint to `ai/models/latest.json` instead of blindly saving the last update. When you pass `--resume`, checkpoint numbering continues from the loaded model or latest matching checkpoint, and the resumed model is kept as the promotion baseline so a worse continuation cannot replace it. Use `--checkpoint-interval 100`, `--checkpoint-eval-episodes 8`, `--training-epochs 4`, `--log-interval 25`, or `--quiet true` to tune the run.

Human play can be folded back into training as a human-opponent source. Single-player and multiplayer runtime actions are recorded as legal-action snapshots when an `aiMeta` runtime is active. In a local single-player browser session, run `window.__basileus.downloadHumanFeedback()` to export the current trace, then drop the exported JSON file into `ai/human-games/`. The folder is ignored by git so you can keep private local games there:

```bash
mkdir ai/human-games
npm run ai:train -- --episodes 1000
```

Training automatically scans `ai/human-games/` recursively for JSON exports. You can use `--human-games path/to/folder` or the older `--human-feedback path/to/file.json` when you want a specific dataset. The trainer distills those games into a human-style opponent, mixes that opponent into self-play with `--human-opponent-rate 0.25`, and reports model-vs-human tournament results when checkpoints are evaluated. AI deal actions are temporarily disabled, so deal demonstrations are ignored until that switch is restored. Direct imitation is off by default; set `--human-feedback-weight 0.05` or higher only when you want the learner to borrow demonstrated human actions in addition to learning how to beat them. `--human-feedback-return 0.75` controls the target value used for that optional imitation stream.

The default runtime model, `ai/models/latest.json`, is committed so the browser, GitHub Pages build, and multiplayer server all have an AI opponent out of the box. Other local model experiments and checkpoints stay ignored. Training promotes the best checkpoint to `ai/models/latest.json`; commit that file when you want the shipped default AI to change. Evaluation defaults to player 1 using the neural model against random legal opponents and reports survival, fall, truncation, reward, scoring, win-rate, policy-mix, and action metrics. Pass `--opponent path/to/model.json` to compare against another checkpoint, `--self-play` to put the same model in every seat, or run `npm run ai:tournament -- --episodes 20` for model-vs-random, model-vs-defensive, self-play, and random-baseline matchups.

## License

All rights reserved. The source is published for transparency and personal/educational reading; no license to copy, modify, or redistribute is granted. Open an issue if you want to discuss broader use.
