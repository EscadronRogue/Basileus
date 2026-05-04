// data/mapPoints.js — Canonical map-space anchors on the 297×210 SVG viewBox.
// Keep hand-authored geopolitical points here instead of storing screen pixels
// or legacy 1200×700 gameplay coordinates in invasion definitions.

export const INVASION_ORIGIN_POINTS = Object.freeze({
  north_africa: { cx: 25.8, cy: 165.0 },
  steppe: { cx: 181.0, cy: 18.0 },
  southern_italy: { cx: 44.0, cy: 92.0 },
  venice: { cx: 61.5, cy: 72.0 },
  bulgaria: { cx: 94.5, cy: 67.5 },
  serbia: { cx: 67.0, cy: 52.5 },
  pannonia: { cx: 75.5, cy: 24.0 },
  turkic_east: { cx: 290.0, cy: 78.0 },
  levant: { cx: 248.0, cy: 164.0 },
});

export function getMapPoint(pointId) {
  const point = INVASION_ORIGIN_POINTS[pointId];
  return point ? { cx: point.cx, cy: point.cy } : null;
}
