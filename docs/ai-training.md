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
- `--set NAME=value` replace a value of `data/balance.js` for this run
  (repeatable; values are read as JSON, e.g. `--set COUP_CHOICE_WEIGHTS=[1,0.5]`)
- `--sweep NAME=a,b,c` run once per value and print one line per value
- `--probe cautious|selfish|gambler` seat one probe per game (rotating
  seats) among the tuned roster. A probe plays like the trained Strategist
  except for the weights its preset in `ai/policies.js` changes: `cautious`
  gives everything to the common good, `selfish` gives as little as it can,
  `gambler` only takes throne risks.

The report covers completion, empire-fall rate, war and coup outcomes,
deployment habits, estates, scoring, win rate per seat and per AI (against
the fair share, 1 / players), the probe's win rate, average gold per dynasty
by round, and when and to which invader the empire falls.

Sweep example:

```sh
npm run simulate:ai -- --games 120 --no-history --samples 0 --probe gambler --sweep THEODOSIAN_WALLS_SUPPORT=2,3,5
```

## Training

```sh
npm run train:ai -- --generations 8
```

Training produces one AI opponent per **personality** (`ai/personalities.js`):
Usurper, Opportunist, Landlord, Kingmaker, Tyrant, Patron, Strategist, and
five that are selfish in different ways: the Miser (dismisses troops for
gold), the Hoarder (keeps offices, strips rivals), the Saboteur (lets
provinces of disliked rivals fall), the Regicide (loses wars on purpose to
load Unrest on an unwanted Basileus) and the Glory Hunter (wins the
best-defender reward, then spends it on a coup).
Every AI uses the same planner (`ai/strategy.js`); a personality fixes the
ranges of the few strategy weights that make its temperament (an Usurper
always prizes the throne, an Opportunist always leans on others to hold the
frontier) and training tunes everything else.

### What training rewards

Only the result of the game. Each game is worth `1` for a win (shared on a
tie) plus `0.25 x` finishing position (`1` for first, `0` for last). A fallen
empire, or a game that does not finish, is worth `0` to every dynasty, as in
the rules. Nothing rewards defending, prudence or duty for its own sake: an AI
that lets others defend while it takes the throne is right to do so if that
wins, and an AI that over-defends is punished by the free-riders it meets.

### How it searches

Each personality keeps a champion, starting from its base preset clamped into
its trait ranges. Every generation:

1. The champion and `--offspring` mutants play the same `--screening-games`
   seeded tables (common random numbers, so luck mostly cancels out).
2. The best `--finalists` mutants and the champion replay `--confirm-games`
   fresh tables.
3. A mutant replaces the champion only if it did better on both sets. The
   mutation step grows after a replacement and shrinks otherwise.

Opponents come from a league: the current champion of every personality
(`--champion-share`, default 60% of seats) and built-in presets (`--league`),
which include free-riders and greedy players that exploit over-defending and
usurpers that punish an empty capital. The evaluated AI rotates through every
seat.

After the last generation, the champion and the best archived versions of
each personality replay `--final-games` fresh tables and the best is kept.
Each champion is then benchmarked against tables of the default planner and of
the roster saved before the run.

### Reading the report

For each personality the log prints its value, win rate, and how it plays:

- **fall** share of its games where the empire fell
- **holds back** orders sending under a quarter of its fieldable troops to the frontier
- **burns** orders that held back in a round the war was lost
- **throne bids** orders with 3+ troops in the capital
- **seizures** coups it won against a sitting Basileus, per game
- **reigns** share of rounds it ended as Basileus
- **estates**, **revokes** per game, and the share of its appointments given away

### Options

- `--generations N` generations (default `6`)
- `--offspring N` mutants per personality per generation (default `6`)
- `--finalists N` mutants per personality that replay the confirmation tables (default `2`)
- `--screening-games N`, `--confirm-games N`, `--final-games N` tables per stage (defaults `36`, `72`, `160`)
- `--benchmark-games N` tables per benchmark (default `60`; `0` skips it)
- `--personalities a,b` train only some personalities
- `--players 4,5,5` table sizes to draw from, weighted by repetition (default `4,5,5`)
- `--decks 9` game lengths to draw from (default `9`)
- `--mutation X` starting mutation step, as a share of each weight's range (default `0.2`)
- `--mutation-rate X` share of weights each mutation touches (default `0.35`)
- `--champion-share X` share of opponent seats taken by personality champions (default `0.6`)
- `--league a,b,c` built-in presets for the other seats
- `--seed N` fixed seed (default: random, printed in the log)
- `--workers N` worker threads (default up to `4`)
- `--output PATH` roster file (default `ai/tunedOpponents.json`)
- `--set NAME=value` train under other balance values (recorded in the roster)
- `--no-save`, `--quiet`, `--json`

A default run plays about 3,300 games per generation; on four cores a
generation takes around ten minutes.

A quick smoke run:

```sh
npm run train:ai -- --generations 1 --offspring 2 --screening-games 4 --confirm-games 4 --final-games 4 --benchmark-games 4 --no-save
```

The roster file replaces the previous one. Each entry keeps its personality,
trait-bounded weights, final metrics and training settings; the file also
records the benchmark.

### Current roster

Trained for the current rules (two coup choices, estates at 1, 2, 3...,
offices raising their own troops, invasion strength 1.7 per imperial
province) with `--generations 8 --seed 20260925`: about 26,000 games, 113
minutes on three workers. Final measurements on 160 fresh tables per
personality:

| Personality | Win | Holds back | Throne bids | Seizures/game | Empire falls |
| --- | --- | --- | --- | --- | --- |
| Usurper | 22% | 8% | 23% | 0.72 | 11% |
| Opportunist | 27% | 8% | 9% | 0.44 | 14% |
| Landlord | 30% | 5% | 9% | 0.46 | 9% |
| Kingmaker | 28% | 4% | 6% | 0.33 | 9% |
| Tyrant | 19% | 48% | 73% | 1.12 | 19% |
| Patron | 27% | 3% | 7% | 0.32 | 6% |
| Strategist | 32% | 4% | 6% | 0.39 | 6% |

Alone against four default planners the new AIs win 52-70% of their games.
Seated among the previous roster (trained for the old rules) they win 18-28%,
and those tables lose the empire in 33-53% of games: the old AIs no longer
defend enough.

### Balance check (roster only, 200 games, 5 players, 9 rounds)

- Empire falls in 13% of games; wars are won 70% of the time.
- Win rate per AI ranges from 9% (Tyrant) to 25% (Landlord) against a fair
  share of 20%.
- `--probe cautious` wins 0-1% of its games: over-defending is punished.
- `--probe gambler` wins 7-9%, although it holds the throne in 78% of rounds:
  it ends with a quarter less gold than the others, because the troops it
  keeps in Constantinople are not dismissed for gold. With the current
  rules the throne does not pay back what it costs to take and hold;
  lowering the Theodosian Walls from 5 to 2 does not change that (8%).
- Gold per dynasty grows slowly through the game (1-5 gold held until
  round 8) and jumps in the last round, when estates stop paying back.
