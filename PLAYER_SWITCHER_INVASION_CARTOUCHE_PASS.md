# Player Switcher and Invasion Cartouche Pass

## Intent

This pass moves the player selection cartouches out of the map footer and into the top of the interface column. It also gives the interface more horizontal room and makes invasion information live on the map at the invasion origin instead of in the top bar.

## Changes

- Moved `#playerTabBar` from `#mapArea` into `#sidebar` above the dashboard.
- Converted the player selector from a bottom-pinned map footer into a sticky interface header.
- Restored complete cartouche outlines around player selector buttons.
- Removed the bottom map-space reservation that existed only to protect the old footer tabs.
- Widened the interface column again on desktop and medium screens.
- Removed top-bar invasion text to avoid redundant information.
- Replaced the old single-line SVG invasion label with a two-line cartouche at the invasion origin:
  - line 1: invasion name
  - line 2: strength estimate
- Standardized invasion route, markers, cartouche border, and cartouche text to the occupied/lost-province color system.

## Validation

- `node --check render/mapRenderer.js`
- `node --check ui/gameController.js`
- `node --check ui/multiplayerController.js`
- `npm test`
- CSS brace balance check

Browser screenshot validation could not run in this container because Chromium blocks local HTTP/file navigation by administrator policy.
