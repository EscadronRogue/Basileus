// ui/html.js - small HTML string helpers shared by the browser UI.
import { getDynastyProfileForSeat } from '../data/invasions.js';

// Escapes text for element content and quoted attribute values.
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Inline CSS custom properties that paint a cartouche in a dynasty's colour.
// `seatId` is zero-based; `color` overrides the seat's default dynasty colour.
export function dynastySeatStyle(seatId, color = null) {
  const resolved = color || getDynastyProfileForSeat(Math.max(0, Number(seatId) || 0)).color || '#5a3810';
  return `--player-color: ${resolved}; --role-color: var(--empire-border); --role-outline-color: var(--empire-border);`;
}
