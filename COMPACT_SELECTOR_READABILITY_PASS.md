# Compact selector and readability pass

## Purpose

This patch tightens the player selector without hiding information, removes redundant labels, and raises the size of regular interface text so the sidebar remains legible next to the stronger cartouche treatment.

## Changes

- Player selector economy text is reduced to one compact line: `reserve / +income / -expense`.
- Player selector no longer displays separate labels such as reserve, income, or expense.
- Player selector no longer shows a dynasty-initial crest, reducing symbol clutter.
- Basileus marker in the player selector is now `B` instead of `C`.
- Basileus labels no longer use the word `current`; the interface now says `Basileus` where a label is needed.
- Regular sidebar/interface text is scaled up for readability while cartouche-specific text remains compact.
- Invasion cartouche background opacity is reduced so it sits more lightly on the map.

## Validation

- `node --check ui/gameController.js`
- `node --check ui/multiplayerController.js`
- `node --check ui/panels.js`
- CSS brace-balance check
- `npm test`
