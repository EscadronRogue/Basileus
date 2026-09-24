// ui/panels.js - public entry point for the sidebar phase panels.
// Each panel lives in ui/panels/<panel>.js; shared helpers in ui/panels/shared.js
// and the court/title link widget in ui/panels/wires.js.

export { renderTitleRedistributionPanel } from './panels/titles.js';
export { renderHistoryPanel } from './panels/history.js';
export { renderPlayerDashboard } from './panels/dashboard.js';
export { renderCourtPanel } from './panels/court.js';
export { renderEstatesPanel } from './panels/estates.js';
export { renderOrdersPanel } from './panels/orders.js';
export { renderResolutionPanel, renderResolutionPanelDetailed } from './panels/resolution.js';
