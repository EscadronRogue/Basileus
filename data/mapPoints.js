// data/mapPoints.js — Canonical map-space anchors on the 297×210 SVG viewBox.
//
// Province label anchors are baked from assets/hitzones.svg so cartouches do
// not depend on browser SVG geometry quirks. Most points are visual interior
// centers computed from the hitzone mask; a few awkward historical/geographic
// cases are hand-tuned in the same coordinate system.

export const PROVINCE_LABEL_POINTS = Object.freeze({
  OPS: { cx: 162.75, cy: 97.62 },
  OPT: { cx: 170.50, cy: 88.12 },
  ANA: { cx: 180.88, cy: 114.50 },
  PAP: { cx: 203.00, cy: 79.00 },
  BOU: { cx: 195.00, cy: 89.62 },
  ARM: { cx: 217.38, cy: 84.75 },
  CHD: { cx: 250.10, cy: 88.60 }, // hand-tuned semantic center
  CHA: { cx: 216.38, cy: 103.00 },
  KOL: { cx: 254.25, cy: 99.38 },
  SEB: { cx: 236.88, cy: 105.38 },
  KAP: { cx: 204.12, cy: 115.75 },
  THK: { cx: 157.25, cy: 112.25 },
  SEL: { cx: 199.62, cy: 135.38 },
  CIL: { cx: 227.88, cy: 128.62 },
  ANT: { cx: 225.10, cy: 146.00 }, // hand-tuned semantic center
  MES: { cx: 242.12, cy: 122.62 },
  VAS: { cx: 275.12, cy: 114.25 },
  NIK: { cx: 83.88, cy: 102.50 },
  HEL: { cx: 96.12, cy: 103.00 },
  THS: { cx: 106.38, cy: 91.00 },
  STR: { cx: 112.75, cy: 84.75 },
  MAK: { cx: 134.62, cy: 83.38 },
  THR: { cx: 145.75, cy: 80.88 },
  CRO: { cx: 42.88, cy: 35.75 },
  DAL: { cx: 60.60, cy: 63.10 }, // hand-tuned semantic center
  SRB: { cx: 61.25, cy: 49.12 },
  SIM: { cx: 72.12, cy: 37.12 },
  BUL: { cx: 94.38, cy: 71.62 },
  PAR: { cx: 123.75, cy: 66.62 },
  AEG: { cx: 124.80, cy: 108.80 }, // hand-tuned semantic center
  SAM: { cx: 146.00, cy: 117.50 },
  KIB: { cx: 165.25, cy: 134.12 },
  KEP: { cx: 81.88, cy: 118.38 },
  KRE: { cx: 121.75, cy: 152.62 },
  KYP: { cx: 196.38, cy: 153.88 },
  CHE: { cx: 203.38, cy: 38.12 },
  PEL: { cx: 96.00, cy: 124.12 },
  DYR: { cx: 74.25, cy: 80.62 },
  SIC: { cx: 26.62, cy: 126.00 },
  ITA: { cx: 44.88, cy: 88.62 },
  CPL: { cx: 156.25, cy: 85.00 },
});

// Geopolitical invasion origin ids. At render time these are resolved from
// reference circles drawn on assets/hitzones.svg, in the same 297×210 viewBox
// as the visible map. The fallback values below preserve behavior if an SVG
// without reference circles is loaded.
export const INVASION_ORIGIN_POINT_IDS = Object.freeze([
  'west_libya',
  'steppe',
  'norman_italy',
  'venice',
  'bulgaria',
  'serbia_interior',
  'pannonia',
  'turkic_east',
  'levant',
]);

export const INVASION_ORIGIN_POINT_FALLBACKS = Object.freeze({
  west_libya: { cx: 68.0, cy: 194.0 },
  steppe: { cx: 181.0, cy: 18.0 },
  norman_italy: { cx: 39.0, cy: 69.0 },
  venice: { cx: 45.5, cy: 63.0 },
  bulgaria: { cx: 94.5, cy: 67.5 },
  serbia_interior: { cx: 66.5, cy: 58.0 },
  pannonia: { cx: 75.5, cy: 24.0 },
  turkic_east: { cx: 290.0, cy: 92.0 },
  levant: { cx: 248.0, cy: 164.0 },
});

export function getProvinceLabelPoint(provinceId) {
  const point = PROVINCE_LABEL_POINTS[provinceId];
  return point ? { cx: point.cx, cy: point.cy } : null;
}

export function getInvasionOriginFallbackPoint(pointId) {
  const point = INVASION_ORIGIN_POINT_FALLBACKS[pointId];
  return point ? { ...point } : null;
}

export function getMapPoint(pointId) {
  return getInvasionOriginFallbackPoint(pointId);
}
