# Game records

Records of games played by humans against the AIs, kept to study how people
play and how the AIs react. A handful of games proves nothing on its own;
a record is a source of ideas, which all-AI simulations then test.

## Recording a game

Every single-player and hotseat game is recorded (the tutorial is not).

- At each round's Resolution, write down in **Your notes on this round** why
  you played as you did. Your reasons are the one thing a record cannot
  show otherwise.
- On the final Balance of Power, add **Your notes on this game**, then press
  **Download game record**. A record can also be downloaded mid-game from
  any Resolution, but it then shows the AIs' hidden moods.
- The last finished game's record stays downloadable from the setup screen
  (**Your last game**) until another game ends.

## Sending a record

Put the `.json` file in this folder (on GitHub: *Add file > Upload files*)
and commit it.

## What a record holds

- the setup: seed, map, seats, and each AI's personality and trained weights;
- every command the humans sent, in order, including refused ones;
- the notes, and where every dynasty stood at each Resolution;
- the full game state at the end: its history holds every appointment,
  revocation, estate, order, war and coup, with each AI's stated reasons and
  mood for its orders.

## Reading a record

```sh
npm run record:report -- records/<file>.json            # round-by-round chronicle
npm run record:report -- records/<file>.json --verify   # also replay it from its seed
npm run record:report -- records/<file>.json --json     # the record without the bulky state
```

`replayGameRecord(record, { stopBefore: seq })` in `game/record.js` rebuilds
the game just before any human command, to ask the AIs what they would have
done in the same spot. Replays are exact only on the code the game was played
with (`rulesVersion` and the AI roster in the record).
