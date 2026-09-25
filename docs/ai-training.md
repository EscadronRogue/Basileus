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
- `--deck N` game length in rounds (default `9`)
- `--map classic|compact` the map to play on (default `classic`)
- `--seed N` first game seed; game *i* uses seed + *i* (default `1`)
- `--workers N` worker threads (default up to `4`); results are identical to `--workers 1`
- `--policies a,b,c` built-in policy per seat instead of the saved tuned roster
- `--samples N` sample games listed in the report (default `5`)
- `--no-history` skip history recording for speed
- `--json` machine-readable output
- `--set NAME=value` replace a value of `data/balance.js` for this run
  (repeatable; values are read as JSON, e.g. `--set COUP_CHOICE_WEIGHTS=[1,0.5]`).
  `--set compact.NAME=value` changes the Compact map's own value
  (`MAP_BALANCE` in `data/balance.js`) and leaves the Classic map alone
- `--sweep NAME=a,b,c` run once per value and print one line per value
- `--probe cautious|selfish|gambler` seat one probe per game (rotating
  seats) among the tuned roster. A probe plays like the trained Strategist
  except for the weights its preset in `ai/policies.js` changes: `cautious`
  gives everything to the common good, `selfish` gives as little as it can,
  `gambler` only takes throne risks.

The report covers completion, empire-fall rate, war and coup outcomes,
deployment habits, estates, scoring, win rate per seat and per AI (against
the fair share, 1 / players), the probe's win rate, the gold a dynasty holds
and the gold and troops it receives in each round, and when and to which
invader the empire falls.

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
its trait ranges (or, with `--from-roster`, from its saved champion). Tables
alternate between the Classic and the Compact map (`--maps`), so one roster
plays both. Every generation:

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
- `--maps classic,compact` maps the tables alternate between (default both)
- `--from-roster` start each personality from its saved champion instead of its preset
- `--fresh a,b` with `--from-roster`, start these personalities from their preset anyway
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
choices, estates at rising prices, war rewards rising 1, 2, 3... per
province, invasion strength 1.85 per imperial province on the Classic map)
on both maps, warm-started from the previous roster, with
`--from-roster --generations 5 --seed 20260925`: about 35,000 games, 109
minutes on three workers.

### Which kinds of selfishness pay

600 games of 5 dynasties on each map, drawn from the twelve trained AIs
(fair share 20%). Troops are per round, averaged over the game, as
Classic / Compact:

| AI | Win (Classic) | Win (Compact) | Frontier | Constantinople | Dismissed |
| --- | --- | --- | --- | --- | --- |
| Opportunist (lets others defend) | 38% | 32% | 2.8 / 2.2 | 1.5 / 0.4 | 3.5 / 2.2 |
| Saboteur (lets rivals' provinces fall) | 25% | 25% | 9.6 / 4.5 | 0.7 / 0.2 | 1.5 / 1.2 |
| Regicide (loses wars to topple the Basileus) | 22% | 20% | 9.2 / 4.6 | 1.0 / 0.2 | 1.2 / 1.1 |
| Kingmaker | 19% | 15% | 9.5 / 5.0 | 0.1 / 0.0 | 0.6 / 0.8 |
| Patron | 15% | 17% | 3.4 / 2.5 | 2.3 / 0.8 | 3.5 / 2.0 |
| Miser (dismisses troops for gold) | 15% | 14% | 8.9 / 4.5 | 0.5 / 0.5 | 1.7 / 1.4 |
| Strategist | 15% | 15% | 9.8 / 4.8 | 0.7 / 0.1 | 1.0 / 0.8 |
| Hoarder (keeps offices, strips rivals) | 15% | 12% | 10.4 / 5.5 | 0.5 / 0.1 | 0.3 / 0.3 |
| Landlord | 12% | 12% | 9.0 / 4.9 | 0.4 / 0.1 | 0.8 / 0.5 |
| Glory Hunter (best defender, then a coup) | 11% | 9% | 11.1 / 5.0 | 0.8 / 1.3 | 0.1 / 0.3 |
| Usurper | 5% | 6% | 1.6 / 1.2 | 7.8 / 3.6 | 0.3 / 0.3 |
| Tyrant | 5% | 3% | 2.1 / 1.2 | 7.2 / 3.5 | 0.2 / 0.1 |

- The empire falls in 18% of Classic games and 25% of Compact games (10%
  and 13% by round 3); wars are won about half the time on both maps.
- Rising war rewards made defending pay: the retrained AIs send 7.4 troops
  per order to the frontier on the Classic map, against 5.5 before, and
  the fall rate dropped from 45% to 18% with the same invasions.
- Free-riding still pays most: the Opportunist sends far fewer troops to
  the frontier than the others (2.8 per round against about 9.5 on the
  Classic map) and wins 1.9 times its share there, 1.6 on the Compact map. Spite (Saboteur) and undermining the
  Basileus (Regicide) pay too.
- Pouring troops into Constantinople does not pay (Usurper, Tyrant).
- `--probe selfish` (the trained Strategist made selfish) wins 18% of its
  Classic games and 15% of its Compact games; `--probe cautious` wins 3%
  and 4%.
- Classic: a dynasty receives 4 gold and 8 troops in the first round and 25
  gold and 10 troops in the last. Compact: 2 gold and 5 troops in the first
  round, 13 gold and 5 troops in the last, with half as many estates built
  (71 per game against 143).
