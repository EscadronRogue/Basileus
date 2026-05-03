# Cartouche role colors and invasion visibility pass

## Purpose

This pass fixes visual inconsistencies from the previous layout work without changing game rules.

## Changes

- Professional-army office cartouches now keep white lettering inside the army-management rows.
- Hotseat player selector cartouches are rebuilt from current state during render, so their outline color follows the current Basileus / Patriarch / Admiral / Domestic role assignment after coups and revocations.
- Invasion path, origin marker, and invasion cartouche are less transparent and easier to read while preserving the lost-province color system.

## Validation

- `node --check ui/gameController.js`
- `node --check ui/multiplayerController.js`
- `node --check ui/panels.js`
- `node --check render/mapRenderer.js`
- CSS brace-balance check
- `npm test`
