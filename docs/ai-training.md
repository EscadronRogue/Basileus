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

Trained for the current rules (the Basileus revokes estates only, two coup
choices, estates at 1, 2, 3..., offices raising their own troops, invasion
strength 1.7 per imperial province) with `--generations 8 --seed 20260926`:
about 45,000 games, 229 minutes on four workers.

### Which kinds of selfishness pay

600 games of 5 dynasties drawn from the twelve trained AIs (fair share 20%);
troops are per round, averaged over the game:

| AI | Win | vs fair share | Frontier | Constantinople | Dismissed | Empire falls in its games |
| --- | --- | --- | --- | --- | --- | --- |
| Opportunist (lets others defend) | 34% | 1.71x | 3.9 | 1.0 | 3.6 | 21% |
| Saboteur (lets rivals' provinces fall) | 25% | 1.27x | 8.7 | 0.6 | 2.1 | 12% |
| Regicide (loses wars to topple the Basileus) | 23% | 1.16x | 8.7 | 1.5 | 1.0 | 13% |
| Landlord | 19% | 0.96x | 7.3 | 1.0 | 1.6 | 22% |
| Patron | 19% | 0.93x | 4.6 | 1.9 | 3.3 | 15% |
| Kingmaker | 18% | 0.87x | 9.8 | 0.2 | 1.0 | 22% |
| Glory Hunter (best defender, then a coup) | 16% | 0.78x | 7.1 | 3.6 | 0.2 | 12% |
| Miser (dismisses troops for gold) | 15% | 0.74x | 8.9 | 0.5 | 2.0 | 13% |
| Hoarder (keeps offices, strips rivals) | 11% | 0.56x | 9.6 | 1.0 | 1.1 | 10% |
| Usurper | 10% | 0.49x | 1.6 | 8.2 | 0.3 | 20% |
| Strategist | 10% | 0.47x | 9.5 | 0.8 | 1.1 | 12% |
| Tyrant | 2% | 0.09x | 1.3 | 8.8 | 0.3 | 23% |

- The empire falls in 16% of these games; wars are won 49% of the time.
- Free-riding pays most: the Opportunist sends half as many troops to the
  frontier as the others, dismisses the rest for gold, and wins 1.7 times
  its share. Spite (Saboteur) and undermining the Basileus (Regicide) pay
  too.
- Pouring troops into Constantinople does not pay (Usurper, Tyrant), and
  neither does keeping every office (Hoarder).
- `--probe selfish` (the trained Strategist made selfish) wins 19% of its
  games, twice the Strategist's 10%; `--probe cautious` wins 1%.
- Gold per dynasty stays around 2 until round 6 and rises to 15 by the last
  round.
