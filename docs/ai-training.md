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
Usurper, Opportunist, Landlord, Tyrant, Patron, Strategist; four that are
selfish in different ways: the Miser (dismisses troops for gold), the
Hoarder (keeps offices, strips rivals), the Saboteur (lets provinces of
disliked rivals fall) and the Glory Hunter (wins the best-defender reward,
then spends it on a coup); three more styles: the Turncoat (no loyalty in
the coup), the Loyalist (backs the sitting Basileus) and the Prelate (as
Patriarch, fills bishoprics and keeps Bishops rather than revoking them);
and an **explorer**, the Maverick.

Every AI may also tune `bishopAppointBonus` and `bishopKeepWeight` (0 by
default), so training finds out whether a full Church pays; the Prelate is
held to high values of both.

The explorer has no temperament at all: it starts from its own random point
of the whole weight space (`explore.seed` in `ai/personalities.js`) and
mutates with bolder steps, so training can find ways of winning the preset
styles do not try. Its description says what it ended up doing.
Every AI uses the same planner (`ai/strategy.js`); a personality fixes the
ranges of the few strategy weights that make its temperament (an Usurper
always prizes the throne, an Opportunist always leans on others to hold the
frontier) and training tunes everything else.

On top of the trained weights, every AI with a personality has a mood
(`ai/mood.js`), its own and never shown to the players: Duty or Greed, and
Loyalty or Ambition, pushed by what happens at the table (threats to its
land or to Constantinople, revocations and favours, rivals under- or
over-defending, the score) and by its memory, which fades. At play time, the distance from its resting
mood tilts the frontier, reserve, throne and coup weights; at rest it plays
its trained weights, so training tunes them for the resting mood.
`temperament` in `ai/personalities.js` sets that rest point, the volatility
and the whim (a seeded softmax among the best moves). The sitting Basileus
keeps its trained throne weights: its loyalty is to its own throne.

On 150 games of 5 dynasties and 9 rounds (seed 77, the roster before the
current one), moods
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

The best AI would keep the empire alive and still end on top: richer, with
more offices and estates than anyone, having got the others to do the
defending. Caring for the empire and for oneself at once is hard to reward
directly, so the reward stays the result alone, and the empire-fall rate the
simulator reports is a check on the AIs, not a target for the rules: a
rate near zero flags AIs that over-defend, a very high one AIs that gamble
the empire away. The rules are set for the game; the AIs adapt to them.

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
- `--until TIME` start no generation after this time (e.g. `2026-09-26T06:00Z`); the one under way finishes, then the finals run. With it, `--generations` is only a cap
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
- `--no-rate` skip rating the saved roster; `--rating-games N` tables for it (default `480`)

A default run plays about 8,900 games per generation; on four workers a
generation takes around sixteen minutes.

A quick smoke run:

```sh
npm run train:ai -- --generations 1 --offspring 2 --screening-games 4 --confirm-games 4 --final-games 4 --benchmark-games 4 --no-save
```

The roster file replaces the previous one. Each entry keeps its personality,
trait-bounded weights, final metrics and training settings; the file also
records the benchmark.

### Rating: which AIs players meet

After saving, training rates the new roster (`ai/rate.js`, also
`npm run rate:ai`): every AI plays an equal share of seats against the rest
of the roster on both maps, at 4 and 5 dynasties and 6, 9 or 12 rounds. Its
**strength** is its wins over the fair share it would get by chance, divided
by the roster's average, so 1 is an average AI; a fallen empire is a loss
for everyone. From 1.15 an AI is *strong*, from 0.8 *average*, and below it
*weak*. Weak AIs stay in training, where they tell a better AI from a worse
one, but players are not offered them: not in the setup screen, the random
seats or multiplayer rooms (unless fewer than four would be left). Each
roster entry keeps its `rating` and `offered`.

### Current roster

Retrained for invasions that add 3 strength for every imperial province on
their route (what taking it costs), the Bishop weights and the Prelate, with
the chronicle on, on tables of 3 to 5 dynasties and 6, 9 or 12 rounds on
both maps: 29 generations in three runs from the previous roster
(6 generations at mutation 0.3, seed 20260926; 12 at 0.2, seed 20260928;
11 at 0.15, seed 20260929, stopped by `--until`), about 190,000 games in
eight and a half hours on three workers. The Prelate started from the Strategist.

Rating (600 tables, `npm run rate:ai`): strong are the Landlord (1.52),
Patron (1.40), Saboteur (1.39), Prelate (1.28) and Turncoat (1.20); average
the Tyrant, Loyalist, Opportunist and Glory Hunter; weak, so kept for
training but not offered to players, the Hoarder, Strategist, Miser,
Usurper and Maverick (0.64 to 0.73).

### Bishops

Training kept Bishops: besides the Prelate (4.6 to fill a bishopric, 3.7 to
keep a Bishop), the Turncoat (4.9 to fill), Saboteur (1.7 / 3.4), Patron
(2.2 / 2.7) and Opportunist (0.6 / 2.3) chose to value them, and only the
Tyrant, Glory Hunter and Miser left filling at 0. On 40 games of 5 dynasties
and 9 rounds per map, 10.3 of the 14 Classic bishoprics have a Bishop at the
end (7.4 with the previous roster) and 5.4 of the 7 Compact ones (4.2), and
the Patriarchs revoke Bishops 159 times instead of 217 on the Classic map.

### Which kinds of selfishness pay

200 games of 5 dynasties and 9 rounds, 100 on each map, drawn from the
fourteen trained AIs, every AI at 100 tables per map. A fallen empire is a
loss for everyone, so an average AI wins under the fair share of 20%. The
troop columns are the share of the troops a dynasty could field that went
to the frontier, to Constantinople or were dismissed, Classic / Compact;
Bishops are those it appointed per game.

| AI | Win (Classic) | Win (Compact) | Frontier | Constantinople | Dismissed | Bishops |
| --- | --- | --- | --- | --- | --- | --- |
| Landlord | 27% | 31% | 35% / 33% | 29% / 24% | 26% / 28% | 3.4 / 2.9 |
| Patron | 31% | 23% | 12% / 12% | 25% / 23% | 51% / 52% | 3.5 / 2.5 |
| Prelate | 22% | 30% | 56% / 48% | 10% / 13% | 25% / 23% | 3.2 / 3.1 |
| Saboteur | 23% | 24% | 58% / 53% | 3% / 3% | 28% / 27% | 3.1 / 2.6 |
| Turncoat | 20% | 26% | 15% / 25% | 44% / 36% | 33% / 24% | 2.7 / 2.4 |
| Hoarder | 15% | 26% | 67% / 72% | 10% / 3% | 11% / 9% | 2.9 / 2.3 |
| Loyalist | 17% | 18% | 75% / 77% | 4% / 1% | 9% / 7% | 3.0 / 2.5 |
| Strategist | 16% | 18% | 63% / 60% | 6% / 8% | 21% / 17% | 3.2 / 2.8 |
| Tyrant | 17% | 15% | 61% / 57% | 18% / 17% | 10% / 14% | 2.9 / 2.1 |
| Maverick | 14% | 15% | 25% / 36% | 34% / 32% | 27% / 23% | 3.5 / 1.9 |
| Opportunist | 10% | 17% | 25% / 24% | 32% / 31% | 30% / 30% | 2.8 / 2.2 |
| Miser | 11% | 9% | 48% / 50% | 3% / 0% | 39% / 36% | 2.9 / 2.5 |
| Usurper | 11% | 8% | 70% / 67% | 12% / 22% | 7% / 3% | 2.4 / 1.3 |
| Glory Hunter | 3% | 2% | 41% / 18% | 41% / 67% | 9% / 4% | 2.6 / 1.7 |

- The empire falls in 15% of these Classic games and 7% of Compact ones:
  with invasions as strong as the land they cross, the trained AIs defend
  more than the previous roster did under the new invasions (27% and 5%
  before retraining).
- The winners mix: the Landlord splits its troops three ways, the Patron
  and Turncoat hold back from the frontier and bid for the capital, the
  Saboteur and Prelate carry the frontier. Pure frontier-holders (Loyalist,
  Usurper) and pure throne-seekers (Glory Hunter) rarely win.
- The Glory Hunter, rated average over mixed tables, wins almost nothing at
  5 dynasties and 9 rounds: it does better in short and small games.
- Training brought some AIs together again: the Hoarder plays much like the
  Loyalist, and the Prelate like the Strategist it started from (behaviour
  distance 0.38 and 0.39, where two AIs are typically 1.3 apart). The
  Hoarder and Strategist are rated weak, so players do not meet them.
