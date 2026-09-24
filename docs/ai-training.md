# AI Simulation & Training

Two offline tools live beside the runtime AI: `ai/simulate.js` measures how
all-AI games play out, and `ai/train.js` evolves the strategy weights of the
named AI opponents saved in `ai/tunedOpponents.json`. Both run whole games
through the same runtime as real play.

On Windows PowerShell, use `npm.cmd` in place of `npm`.

## Simulation

```sh
npm run simulate:ai -- --games 200 --players 5 --deck 9
```

- `--games N` number of games (default `100`)
- `--players N` dynasties per game, `3`-`5` (default `5`)
- `--deck N` game length in turns (default `9`)
- `--seed N` first game seed; game *i* uses seed + *i* (default `1`)
- `--workers N` worker threads (default up to `4`); results are identical to `--workers 1`
- `--policies a,b,c` built-in policy per seat instead of the saved tuned roster
- `--samples N` sample games listed in the report (default `5`)
- `--no-history` skip history recording for speed
- `--json` machine-readable output

The report covers completion, empire-fall rate against the 40-50% ideal band,
war and coup outcomes, deployment habits, estates, scoring, win rate per seat,
and when and to which invader the empire falls.

## Training

```sh
npm run train:ai -- --generations 3 --population 10 --elite 3 --games 24
```

### Core training

- `--generations N`  
  Number of evolutionary rounds. More generations means more refinement.
  Default: `3`

- `--population N`  
  Number of candidate AI personalities tested per generation.
  Default: `10`

- `--elite N`  
  Number of best candidates preserved into the next generation.
  Default: `3`

- `--games N`  
  Number of games used for finalist re-evaluation. Every candidate is
  screened on fewer games first, then the best finalists are re-tested on this
  many games.
  Default: `24`

Total rough workload:

```text
generations x population x screening-games + finalists x finalist-games
```

So the defaults run `3 x 10 x 8 + 5 x 24 = 360` simulated games.

- `--screening-games N`
  Number of quick games used for every candidate in every generation.
  Default: about one third of `--games`, minimum `4` for larger runs.

- `--finalist-games N`
  Number of games used to re-rank the finalist pool.
  Default: same as `--games`

- `--finalists N`
  Number of top distinct candidates to re-evaluate at the end.
  Default: `5`

- `--workers N`
  Parallel worker threads used by the CLI trainer.
  Default: up to `4`, based on available CPU cores.

### Game setup

- `--players N`  
  Players per simulated game, `3`-`5`. Accepts lists or ranges such as `3,4,5` or `3-5`.
  Default: `5`

- `--deck N`  
  Game length in turns. Accepts lists such as `6,9,12`.
  Default: `9`

Every training run uses a fresh random seed, printed in the report.

### Learning behaviour

- `--mutation X`  
  How aggressively new candidates vary from elite parents. Higher means more exploration, lower means more refinement.
  Default: `0.35`

- `--fall-penalty X`  
  Objective pressure around empire collapse. The trainer strongly prefers a fall rate near
  50%. Below 50%, it sanctions prudent patterns such as safe war margins, heavy frontier
  funding, and low coup pressure; above 50%, it sanctions fearless patterns such as thin
  war margins, frequent defeats, and excessive capital/coup pressure. The farther the
  fall rate drifts from 50%, the more those behavior signals matter, with extra guardrail
  penalties below 25% or above 75%.
  Default: `220`

- `--opponent-mix robust|beginner`  
  Opponent schedule used during training.
  Default: `robust`

  `robust` is the serious default: about 33% candidate self-play, a large saved-champion pool when available, a broad built-in curriculum, and low-frequency oddballs (`random`/`copycat`).

  `beginner` keeps 25% candidate self-play, then trains against the built-in curriculum without saved champions.

- `--self-play-every N`  
  Every Nth evaluation game uses the candidate policy for all AI dynasties. This overrides the selected opponent mix's cadence.
  Default: `3` with `robust`, `4` with `beginner`

- `--champions N`  
  Number of saved tuned opponents loaded from the output roster for the robust champion pool.
  Default: `6`

- `--save-champions N`
  Number of newly trained champions exported to the output roster.
  Default: `5`

### Opponent league

- `--league a,b,c`  
  Custom non-champion opponent pool used during training. In `beginner` mode it is the full non-self-play league. In `robust` mode it replaces the built-in non-champion bucket while saved champions still participate.
  Current useful values include:
  `strategic`, `defender`, `usurper`, `profiteer`, `patron`, `tyrant`, `kingmaker`, `freeRider`, `overDefender`, `estateShark`, `antiLeader`, `greedy`, `loyalist`, `random`, `copycat`.

Example:

```sh
npm run train:ai -- --league strategic,defender,random,copycat
```

### Saving and output

- `--no-save`  
  Runs training but does not save the trained champions.

- `--output PATH`  
  Saves trained opponents somewhere other than `ai/tunedOpponents.json`.

- `--quiet`  
  Suppresses progress logs, keeps only final report.

- `--json`  
  Outputs machine-readable JSON and disables progress lines.

A serious run:

```sh
npm run train:ai -- --generations 8 --population 16 --elite 4 --games 40 --fall-penalty 220
```

A beginner-friendly run without saved champion opponents:

```sh
npm run train:ai -- --opponent-mix beginner
```

A quick smoke run:

```sh
npm run train:ai -- --generations 1 --population 4 --games 6 --no-save
```
