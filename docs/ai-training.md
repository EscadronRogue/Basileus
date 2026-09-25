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
npm run simulate:ai -- --games 120 --no-history --samples 0 --probe gambler --sweep THEODOSIAN_WALLS=2,3,5
```

## Training

```sh
npm run train:ai -- --generations 8
```

Training produces one AI opponent per **personality** (`ai/personalities.js`):
Usurper, Opportunist, Landlord, Kingmaker, Tyrant, Patron, Strategist; five
that are selfish in different ways: the Miser (dismisses troops for gold),
the Hoarder (keeps offices, strips rivals), the Saboteur (lets provinces of
disliked rivals fall), the Regicide (loses wars on purpose to load Unrest on
an unwanted Basileus) and the Glory Hunter (wins the best-defender reward,
then spends it on a coup); four more styles: the Domain Lord (gathers its
estates into domains), the Condottiere (hires mercenaries to be the best
defender), the Turncoat (no loyalty in the coup) and the Loyalist (backs
the sitting Basileus); and three **explorers**, the Maverick, the Wildcard
and the Outsider.

An explorer has no temperament at all: it starts from its own random point
of the whole weight space (`explore.seed` in `ai/personalities.js`) and
mutates with bolder steps, so training can find ways of winning the preset
styles do not try. Its description says what it ended up doing.
Every AI uses the same planner (`ai/strategy.js`); a personality fixes the
ranges of the few strategy weights that make its temperament (an Usurper
always prizes the throne, an Opportunist always leans on others to hold the
frontier) and training tunes everything else.

On top of the trained weights, every AI with a personality has a mood
(`ai/mood.js`): Duty or Greed, and Loyalty or Ambition, pushed by what
happens at the table (threats to its land or to Constantinople,
revocations and favours, rivals under- or over-defending, the score) and
by its memory, which fades. At play time, the distance from its resting
mood tilts the frontier, reserve, throne and coup weights; at rest it plays
its trained weights, so training tunes them for the resting mood.
`temperament` in `ai/personalities.js` sets that rest point, the volatility
and the whim (a seeded softmax among the best moves). The sitting Basileus
keeps its trained throne weights: its loyalty is to its own throne.

On 150 games of 5 dynasties and 9 rounds (seed 77, current roster), moods
raise the frontier's wins from 31% to 37% on Classic and from 27% to 38% on
Compact, with the throne changing hands as often as without them (65% and
55% of coups).

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
- `--players 3,4,5,5` table sizes to draw from, weighted by repetition (default `3,4,5,5`)
- `--decks 6,9,12` game lengths to draw from (default `6,9,12`)
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

A default run plays about 8,900 games per generation; on four workers a
generation takes around sixteen minutes.

A quick smoke run:

```sh
npm run train:ai -- --generations 1 --offspring 2 --screening-games 4 --confirm-games 4 --final-games 4 --benchmark-games 4 --no-save
```

The roster file replaces the previous one. Each entry keeps its personality,
trait-bounded weights, final metrics and training settings; the file also
records the benchmark.

### Current roster

Not yet retrained for flat prices, known invasion strength and moods. Trained for
the rules before them (one rising price 2, 2, 2, 3, 3, 3..., estate
domains, estates revocable from the next round, the Theodosian Walls
defending Constantinople in war, invasions at 1.1 strength per imperial
province) with `--from-roster --generations 6 --mutation 0.25 --seed
20260927`, on tables of 3 to 5 dynasties and 6, 9 or 12 rounds on both
maps: about 60,000 games, 119 minutes on four workers.

### Which kinds of selfishness pay

600 games of 5 dynasties and 9 rounds on each map, drawn from the nineteen
trained AIs (fair share 20%). Troops are per round, averaged over the game,
as Classic / Compact:

| AI | Win (Classic) | Win (Compact) | Frontier | Constantinople | Dismissed |
| --- | --- | --- | --- | --- | --- |
| Condottiere | 25% | 29% | 6.8 / 4.1 | 1.0 / 0.7 | 1.5 / 0.8 |
| Glory Hunter | 24% | 23% | 1.5 / 0.3 | 5.8 / 3.9 | 0.7 / 0.3 |
| Kingmaker | 21% | 26% | 5.2 / 3.6 | 0.4 / 0.4 | 2.9 / 1.7 |
| Loyalist | 23% | 22% | 8.4 / 4.9 | 0.1 / 0.1 | 1.7 / 1.3 |
| Opportunist | 15% | 28% | 1.3 / 1.4 | 0.4 / 0.3 | 4.6 / 2.8 |
| Turncoat | 23% | 15% | 0.3 / 0.1 | 7.0 / 4.1 | 0.7 / 0.4 |
| Landlord | 13% | 22% | 3.9 / 3.2 | 1.2 / 0.9 | 2.7 / 1.6 |
| Tyrant | 18% | 16% | 0.4 / 0.1 | 7.1 / 4.4 | 0.1 / 0.1 |
| Wildcard | 17% | 16% | 1.7 / 1.5 | 2.2 / 1.5 | 3.1 / 1.7 |
| Usurper | 21% | 11% | 0.1 / 0.0 | 6.3 / 3.9 | 0.6 / 0.3 |
| Saboteur | 17% | 13% | 3.9 / 2.9 | 1.4 / 1.0 | 3.3 / 2.0 |
| Strategist | 11% | 17% | 5.0 / 3.4 | 1.5 / 0.9 | 2.2 / 1.1 |
| Miser | 13% | 14% | 4.8 / 3.4 | 1.1 / 0.9 | 3.3 / 2.2 |
| Hoarder | 14% | 10% | 6.0 / 3.7 | 1.1 / 0.8 | 2.0 / 1.2 |
| Outsider | 8% | 14% | 2.1 / 0.7 | 4.2 / 3.2 | 2.2 / 0.8 |
| Regicide | 4% | 16% | 1.7 / 1.5 | 1.2 / 0.7 | 4.3 / 2.5 |
| Domain Lord | 7% | 11% | 1.5 / 0.8 | 1.0 / 1.1 | 5.3 / 2.7 |
| Maverick | 7% | 4% | 1.7 / 0.2 | 6.3 / 3.8 | 0.2 / 0.4 |
| Patron | 5% | 7% | 0.8 / 0.7 | 2.4 / 1.8 | 5.2 / 2.9 |

- Invasions call for about 45% of the troops the empire raises (48%
  Classic, 45% Compact), and the AIs use the room: they send 3.1 troops
  per order to the frontier on the Classic map, against 7.4 under the
  stronger invasions. The throne became worth fighting for: 2.7 troops per
  order go to Constantinople.
- No temperament runs away with the game: the best win about 1.2 to 1.5
  times their share. The Condottiere, a new style that hires mercenaries to
  be the best defender, wins most on both maps; holding the frontier as a
  Loyalist pays as well as the throne-seekers (Glory Hunter, Turncoat,
  Usurper). Free-riding pays on the Compact map (Opportunist 28%) but no
  longer on the Classic map (15%).
- Of the explorers, the Wildcard found a playable style (spread estates,
  strip rivals of offices, back a challenger without claiming the throne);
  the Maverick and the Outsider ended up as weaker throne-seekers.
- The empire falls in 25% of Classic games and 18% of Compact games, most
  of them early: 9% and 8% in round 1, mainly to the Bulgars, whose route
  is short, when too many dynasties send their first troops to
  Constantinople. Wars are won 32% of the time on the Classic map and 41% on
  the Compact map; one dynasty wins a war alone in 2% and 12% of them.
- A best defender takes the throne at the next coup about 10% of the time.
- Estates: 161 built per Classic game and 130 per Compact game; at the end,
  28% and 48% of estates are in domains. A dynasty receives 4 gold and 8
  troops in the first round and 27 gold and 8 troops in the last on the
  Classic map; 2 gold and 5 troops, then 24 gold and 5 troops, on the
  Compact map.
- Game length matters: in 6-round games the empire falls in 18% of games
  and dynasties end on 13 gold of income; in 12-round games it falls in 33%
  and they end on 48 gold.
