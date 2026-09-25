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

Trained for flat prices, known invasion strength and moods, with the
chronicle on (so AI memory and moods work as in real games), with
`--from-roster --generations 6 --mutation 0.3 --seed 20260925`, on tables
of 3 to 5 dynasties and 6, 9 or 12 rounds on both maps: about 64,000
games, 177 minutes on four workers. Against the roster before it, every
new champion but four (Usurper, Patron, Glory Hunter, Maverick) wins at
least its share.

Invasions changed since: their strength grows by 2 for every imperial
province on the route instead of 1 for every province, and lost land no
longer costs the invader anything to cross. The roster was not retrained
for it. On 300 games of 5 dynasties and 9 rounds, invasions now call for
46% of the troops the empire raises on the Classic map (47% Compact); the
frontier wins 47% of wars (48%), and the empire falls in 29% of Classic
games and 12% of Compact games, never before round 4. More than half of
the Classic falls are to the Bulgars, whose route is short. The figures
below were measured before this change.

### Which kinds of selfishness pay

600 games of 5 dynasties and 9 rounds on each map, drawn from the nineteen
trained AIs (fair share 20%). Troops are per round, averaged over the game,
as Classic / Compact:

| AI | Win (Classic) | Win (Compact) | Frontier | Constantinople | Dismissed |
| --- | --- | --- | --- | --- | --- |
| Saboteur | 39% | 44% | 4.6 / 3.1 | 0.8 / 0.4 | 3.9 / 2.0 |
| Landlord | 35% | 44% | 2.7 / 1.8 | 3.4 / 1.8 | 3.3 / 1.8 |
| Strategist | 34% | 42% | 4.0 / 2.7 | 1.4 / 0.8 | 3.7 / 2.1 |
| Turncoat | 36% | 36% | 3.0 / 1.8 | 3.4 / 1.7 | 4.0 / 2.3 |
| Loyalist | 29% | 33% | 7.5 / 4.3 | 0.6 / 0.3 | 2.1 / 1.3 |
| Condottiere | 26% | 26% | 5.3 / 3.3 | 2.1 / 1.4 | 2.1 / 1.3 |
| Kingmaker | 25% | 26% | 4.2 / 3.1 | 3.0 / 1.3 | 2.4 / 1.4 |
| Opportunist | 24% | 20% | 1.2 / 0.8 | 4.3 / 2.3 | 4.1 / 2.5 |
| Domain Lord | 15% | 20% | 4.3 / 2.8 | 3.4 / 1.5 | 3.8 / 2.4 |
| Hoarder | 18% | 15% | 5.5 / 2.9 | 2.6 / 1.5 | 2.4 / 1.3 |
| Miser | 18% | 14% | 4.1 / 2.5 | 2.9 / 1.5 | 3.6 / 2.0 |
| Regicide | 11% | 15% | 2.2 / 1.6 | 2.1 / 1.1 | 5.6 / 3.1 |
| Tyrant | 16% | 9% | 4.5 / 1.7 | 4.7 / 3.1 | 1.4 / 0.9 |
| Outsider | 14% | 10% | 3.5 / 2.2 | 1.2 / 0.9 | 4.6 / 2.6 |
| Wildcard | 8% | 12% | 2.8 / 1.9 | 4.1 / 2.4 | 3.4 / 1.9 |
| Usurper | 7% | 3% | 5.5 / 2.4 | 3.4 / 2.5 | 1.0 / 0.4 |
| Patron | 5% | 3% | 1.6 / 0.8 | 5.4 / 3.0 | 3.0 / 2.1 |
| Glory Hunter | 1% | 3% | 1.4 / 0.3 | 6.6 / 4.2 | 0.9 / 0.4 |
| Maverick | 2% | 1% | 5.0 / 2.6 | 4.6 / 3.4 | 1.5 / 0.6 |

- Invasions call for about 38% of the troops the empire raises (39%
  Classic, 38% Compact), and the frontier holds: wars are won 46% of the
  time on the Classic map and 49% on the Compact map (37% and 38% for the
  roster before, which trained without memory). One dynasty wins a war
  alone in 3% and 4% of them.
- The empire falls in 5% of Classic games and 2% of Compact games, none
  before round 5: below the 10-20% the simulator aims for, which is why
  invasions were made stronger (see above).
- The throne changes hands at 61% of Classic coups and 57% of Compact
  ones, and a best defender takes it at the next coup about half the time.
- The dynasties that win mix the frontier, the capital and their estates:
  the Saboteur, Landlord, Strategist and Turncoat win 1.7 to 2.2 times
  their share. Pure throne-seekers (Usurper, Glory Hunter, Maverick,
  Patron) keep their troops in Constantinople and rarely win: with
  Walls 3 the throne changes hands too often to be worth holding alone.
- Estates: 206 built per Classic game and 135 per Compact game; at the
  end, 9% and 20% of estates are in domains. A dynasty receives 4 gold and
  8 troops in the first round and 29 gold and 10 troops in the last on the
  Classic map; 3 gold and 5 troops, then 20 gold and 6 troops, on the
  Compact map.
- Game length matters: in 6-round Classic games the empire falls in under
  1% of games, in 12-round games in 8%, when dynasties end on 62 gold of
  income.