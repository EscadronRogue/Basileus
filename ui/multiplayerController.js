// ui/multiplayerController.js - public entry point for the browser multiplayer client.
//   ui/multiplayer/connection.js  backend URLs, HTTP room API, saved sessions
//   ui/multiplayer/lobby.js       pre-game room lobby
//   ui/multiplayer/controller.js  live connection and in-game rendering

export { getStoredMultiplayerSession } from './multiplayer/connection.js';
export { launchMultiplayerClient, MultiplayerController } from './multiplayer/controller.js';
