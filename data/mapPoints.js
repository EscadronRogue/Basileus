// data/mapPoints.js — Canonical map-space anchors on the 297×210 SVG viewBox.
//
// Province label anchors are baked from assets/hitzones.svg so cartouches do
// not depend on browser SVG geometry quirks. Most points are visual interior
// centers computed from the hitzone mask; a few awkward historical/geographic
// cases are hand-tuned in the same coordinate system.

export const MAP_VIEWBOX = Object.freeze({ width: 297, height: 210, padding: 3.5 });

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

// Approximate historical geography tied to the current stylized SVG. Province
// anchors are used as calibration landmarks, not as invasion origins. City and
// regional landmarks outside the theme list can calibrate visible coastlines
// where the hitzones do not contain a dedicated theme.
const MAP_CALIBRATION_POINTS = Object.freeze([
  calibration('constantinople', 28.9784, 41.0082, PROVINCE_LABEL_POINTS.CPL),
  calibration('sicily', 13.3614, 38.1157, PROVINCE_LABEL_POINTS.SIC),
  calibration('apulia', 16.8719, 41.1171, PROVINCE_LABEL_POINTS.ITA),
  calibration('zagreb_croatia', 15.9819, 45.8150, PROVINCE_LABEL_POINTS.CRO),
  calibration('dalmatia', 18.0944, 42.6507, PROVINCE_LABEL_POINTS.DAL),
  calibration('ras_serbia', 20.5167, 43.1367, PROVINCE_LABEL_POINTS.SRB),
  calibration('sirmium', 19.6100, 44.9670, PROVINCE_LABEL_POINTS.SIM),
  calibration('preslav_bulgaria', 26.9230, 43.1600, PROVINCE_LABEL_POINTS.BUL),
  calibration('paristrion', 27.9120, 43.2141, PROVINCE_LABEL_POINTS.PAR),
  calibration('thessaloniki', 22.9444, 40.6401, PROVINCE_LABEL_POINTS.THS),
  calibration('dyrrachium', 19.4458, 41.3186, PROVINCE_LABEL_POINTS.DYR),
  calibration('athens_hellas', 23.7275, 37.9838, PROVINCE_LABEL_POINTS.HEL),
  calibration('nicopolis', 20.7400, 39.0200, PROVINCE_LABEL_POINTS.NIK),
  calibration('cephalonia', 20.6244, 38.1754, PROVINCE_LABEL_POINTS.KEP),
  calibration('crete', 25.1442, 35.3387, PROVINCE_LABEL_POINTS.KRE),
  calibration('naxos_aegean', 25.3764, 37.1021, PROVINCE_LABEL_POINTS.AEG),
  calibration('samos', 26.9778, 37.7548, PROVINCE_LABEL_POINTS.SAM),
  calibration('attaleia', 30.7133, 36.8969, PROVINCE_LABEL_POINTS.KIB),
  calibration('seleucia', 33.9333, 36.3667, PROVINCE_LABEL_POINTS.SEL),
  calibration('tarsus_cilicia', 34.8951, 36.9177, PROVINCE_LABEL_POINTS.CIL),
  calibration('antioch', 36.2023, 36.2021, PROVINCE_LABEL_POINTS.ANT),
  calibration('cyprus', 33.3823, 35.1856, PROVINCE_LABEL_POINTS.KYP),
  calibration('edessa_mesopotamia', 39.0297, 37.1674, PROVINCE_LABEL_POINTS.MES),
  calibration('van_vaspurakan', 43.3770, 38.5012, PROVINCE_LABEL_POINTS.VAS),
  calibration('koloneia', 39.7522, 40.3000, PROVINCE_LABEL_POINTS.KOL),
  calibration('sebasteia', 37.0167, 39.7500, PROVINCE_LABEL_POINTS.SEB),
  calibration('charsianon', 35.0000, 39.8000, PROVINCE_LABEL_POINTS.CHA),
  calibration('cappadocia', 34.6857, 37.9667, PROVINCE_LABEL_POINTS.KAP),
  calibration('amasia_armeniakon', 35.8333, 40.6500, PROVINCE_LABEL_POINTS.ARM),
  calibration('ankara_boukellarion', 32.8597, 39.9334, PROVINCE_LABEL_POINTS.BOU),
  calibration('paphlagonia', 33.7753, 41.3764, PROVINCE_LABEL_POINTS.PAP),
  calibration('konya_anatolikon', 32.4846, 37.8746, PROVINCE_LABEL_POINTS.ANA),
  calibration('bursa_opsikion', 29.0600, 40.1950, PROVINCE_LABEL_POINTS.OPS),
  calibration('nicomedia_optimatoi', 29.9169, 40.7667, PROVINCE_LABEL_POINTS.OPT),
  calibration('smyrna_thrakesion', 27.1428, 38.4237, PROVINCE_LABEL_POINTS.THK),
  calibration('cherson', 33.5333, 44.6110, PROVINCE_LABEL_POINTS.CHE),
  calibration('venice_lagoon', 12.3155, 45.4408, { cx: 45.50, cy: 63.00 }),
]);

export const INVASION_ORIGIN_PROFILES = Object.freeze({
  ifriqiya: originProfile({
    label: 'Ifriqiya',
    lon: 10.1010,
    lat: 35.6781,
    external: true,
    cartoucheDx: 14,
    cartoucheDy: -13,
  }),
  pontic_steppe: originProfile({
    label: 'Pontic Steppe',
    lon: 30.5234,
    lat: 50.4501,
    external: true,
    cartoucheDy: 2.5,
  }),
  norman_italy: originProfile({
    label: 'Norman Italy',
    lon: 14.7810,
    lat: 41.1000,
    cartoucheDy: -10,
  }),
  venice: originProfile({
    label: 'Venice',
    lon: 12.3155,
    lat: 45.4408,
    cartoucheDx: -2.5,
    cartoucheDy: -11,
  }),
  bulgaria: originProfile({
    label: 'Bulgaria',
    lon: 26.9230,
    lat: 43.1600,
  }),
  serbia: originProfile({
    label: 'Serbian Interior',
    lon: 20.5167,
    lat: 43.1367,
    cartoucheDy: -18,
  }),
  pannonia: originProfile({
    label: 'Pannonia',
    lon: 19.0402,
    lat: 47.4979,
    cartoucheDy: -5,
  }),
  persia: originProfile({
    label: 'Persia',
    lon: 51.3890,
    lat: 35.6892,
    external: true,
    cartoucheDx: -16,
    cartoucheDy: -10,
  }),
  levant: originProfile({
    label: 'Levant',
    lon: 36.2023,
    lat: 36.2021,
  }),
});

const LEGACY_ORIGIN_POINT_IDS = Object.freeze({
  west_libya: 'ifriqiya',
  steppe: 'pontic_steppe',
  norman_italy: 'norman_italy',
  venice: 'venice',
  bulgaria: 'bulgaria',
  serbia_interior: 'serbia',
  pannonia: 'pannonia',
  turkic_east: 'persia',
  levant: 'levant',
});

const geoProjection = createGeoProjection(MAP_CALIBRATION_POINTS);
const invasionOriginCache = new Map();

export const INVASION_ORIGIN_POINTS = Object.freeze(
  Object.fromEntries(Object.keys(INVASION_ORIGIN_PROFILES).map((profileId) => [profileId, getInvasionOriginPoint(profileId)])),
);

export function getProvinceLabelPoint(provinceId) {
  const point = PROVINCE_LABEL_POINTS[provinceId];
  return point ? { cx: point.cx, cy: point.cy } : null;
}

export function getInvasionOriginProfile(profileId) {
  return INVASION_ORIGIN_PROFILES[profileId] || null;
}

export function getInvasionOriginLabel(invasion) {
  const profile = getInvasionOriginProfile(getOriginProfileId(invasion));
  return profile?.label || invasion?.originLabel || null;
}

export function getInvasionOriginPoint(profileId, entryThemeId = null) {
  const profile = getInvasionOriginProfile(profileId);
  if (!profile) return null;

  const cacheKey = `${profileId}:${entryThemeId || ''}`;
  if (!invasionOriginCache.has(cacheKey)) {
    invasionOriginCache.set(cacheKey, buildInvasionOriginPoint(profile, entryThemeId));
  }

  return clonePoint(invasionOriginCache.get(cacheKey));
}

export function resolveInvasionOriginPoint(invasion, fallbackPoints = PROVINCE_LABEL_POINTS) {
  const profileId = getOriginProfileId(invasion);
  const entryThemeId = invasion?.entryTheme || invasion?.route?.[0] || invasion?.origin || null;
  const profilePoint = getInvasionOriginPoint(profileId, entryThemeId);
  if (profilePoint) return profilePoint;

  const legacyPoint = invasion?.originPos;
  if (legacyPoint) {
    return {
      cx: legacyPoint.cx * (MAP_VIEWBOX.width / 1150),
      cy: legacyPoint.cy * (MAP_VIEWBOX.height / 560),
    };
  }

  const fallback = fallbackPoints?.[entryThemeId] || fallbackPoints?.[invasion?.origin] || null;
  return fallback ? clonePoint(fallback) : null;
}

export function getMapPoint(pointId) {
  const profileId = LEGACY_ORIGIN_POINT_IDS[pointId] || pointId;
  return getInvasionOriginPoint(profileId);
}

function calibration(id, lon, lat, point) {
  return Object.freeze({ id, lon, lat, cx: point.cx, cy: point.cy });
}

function originProfile({ label, lon, lat, external = false, cartoucheDx = 0, cartoucheDy = null }) {
  return Object.freeze({ label, lon, lat, external, cartoucheDx, cartoucheDy });
}

function getOriginProfileId(invasion) {
  return invasion?.originProfileId || LEGACY_ORIGIN_POINT_IDS[invasion?.originPointId] || null;
}

function buildInvasionOriginPoint(profile, entryThemeId) {
  const projected = geoProjection.project(profile.lon, profile.lat);
  const entryPoint = PROVINCE_LABEL_POINTS[entryThemeId];
  const routePoint = profile.external && entryPoint
    ? clampRayToMapFrame(projected, entryPoint)
    : clampPointToLooseMapFrame(projected);

  return {
    cx: roundMapUnit(routePoint.cx),
    cy: roundMapUnit(routePoint.cy),
    originLabel: profile.label,
    cartoucheDx: profile.cartoucheDx,
    ...(Number.isFinite(profile.cartoucheDy) ? { cartoucheDy: profile.cartoucheDy } : {}),
  };
}

function createGeoProjection(calibrationPoints) {
  const affine = solveAffineProjection(calibrationPoints);
  const residuals = calibrationPoints.map((point) => {
    const projected = projectAffine(affine, point.lon, point.lat);
    return {
      ...point,
      dx: point.cx - projected.cx,
      dy: point.cy - projected.cy,
    };
  });

  return {
    project(lon, lat) {
      const exact = residuals.find((point) => geoDistance(point, { lon, lat }) < 0.001);
      if (exact) return { cx: exact.cx, cy: exact.cy };

      const base = projectAffine(affine, lon, lat);
      const nearest = residuals
        .map((point) => ({ point, distance: geoDistance(point, { lon, lat }) }))
        .sort((left, right) => left.distance - right.distance)
        .slice(0, 6);

      const weightedResidual = nearest.reduce((acc, entry) => {
        const weight = 1 / ((entry.distance * entry.distance) + 0.08);
        acc.dx += entry.point.dx * weight;
        acc.dy += entry.point.dy * weight;
        acc.weight += weight;
        return acc;
      }, { dx: 0, dy: 0, weight: 0 });

      return {
        cx: base.cx + (weightedResidual.dx / weightedResidual.weight),
        cy: base.cy + (weightedResidual.dy / weightedResidual.weight),
      };
    },
  };
}

function solveAffineProjection(points) {
  const normal = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const rhsX = [0, 0, 0];
  const rhsY = [0, 0, 0];

  for (const point of points) {
    const row = [1, point.lon, point.lat];
    for (let i = 0; i < 3; i += 1) {
      rhsX[i] += row[i] * point.cx;
      rhsY[i] += row[i] * point.cy;
      for (let j = 0; j < 3; j += 1) normal[i][j] += row[i] * row[j];
    }
  }

  return {
    x: solveThreeByThree(normal, rhsX),
    y: solveThreeByThree(normal, rhsY),
  };
}

function solveThreeByThree(matrix, rhs) {
  const a = matrix.map((row, index) => [...row, rhs[index]]);

  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-9) throw new Error('Map calibration projection is singular.');
    if (pivot !== col) [a[col], a[pivot]] = [a[pivot], a[col]];

    const divisor = a[col][col];
    for (let cell = col; cell < 4; cell += 1) a[col][cell] /= divisor;

    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let cell = col; cell < 4; cell += 1) a[row][cell] -= factor * a[col][cell];
    }
  }

  return [a[0][3], a[1][3], a[2][3]];
}

function projectAffine(affine, lon, lat) {
  return {
    cx: affine.x[0] + (affine.x[1] * lon) + (affine.x[2] * lat),
    cy: affine.y[0] + (affine.y[1] * lon) + (affine.y[2] * lat),
  };
}

function geoDistance(left, right) {
  const meanLat = ((left.lat + right.lat) / 2) * Math.PI / 180;
  const x = (left.lon - right.lon) * Math.cos(meanLat);
  const y = left.lat - right.lat;
  return Math.hypot(x, y);
}

function clampRayToMapFrame(target, entryPoint) {
  const bounds = getPaddedBounds();
  if (pointInsideBounds(target, bounds)) return target;

  const dx = target.cx - entryPoint.cx;
  const dy = target.cy - entryPoint.cy;
  const candidates = [];

  if (dx !== 0) {
    addRayCandidate(candidates, entryPoint, dx, dy, (bounds.minX - entryPoint.cx) / dx, bounds);
    addRayCandidate(candidates, entryPoint, dx, dy, (bounds.maxX - entryPoint.cx) / dx, bounds);
  }
  if (dy !== 0) {
    addRayCandidate(candidates, entryPoint, dx, dy, (bounds.minY - entryPoint.cy) / dy, bounds);
    addRayCandidate(candidates, entryPoint, dx, dy, (bounds.maxY - entryPoint.cy) / dy, bounds);
  }

  candidates.sort((left, right) => left.t - right.t);
  return candidates[0] || clampPointToLooseMapFrame(target);
}

function addRayCandidate(candidates, entryPoint, dx, dy, t, bounds) {
  if (t <= 0) return;
  const point = { cx: entryPoint.cx + (dx * t), cy: entryPoint.cy + (dy * t), t };
  if (pointInsideBounds(point, bounds)) candidates.push(point);
}

function clampPointToLooseMapFrame(point) {
  const bounds = getPaddedBounds();
  return {
    cx: clampValue(point.cx, bounds.minX, bounds.maxX),
    cy: clampValue(point.cy, bounds.minY, bounds.maxY),
  };
}

function getPaddedBounds() {
  return {
    minX: MAP_VIEWBOX.padding,
    minY: MAP_VIEWBOX.padding,
    maxX: MAP_VIEWBOX.width - MAP_VIEWBOX.padding,
    maxY: MAP_VIEWBOX.height - MAP_VIEWBOX.padding,
  };
}

function pointInsideBounds(point, bounds) {
  return point.cx >= bounds.minX && point.cx <= bounds.maxX
    && point.cy >= bounds.minY && point.cy <= bounds.maxY;
}

function clampValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundMapUnit(value) {
  return Math.round(value * 100) / 100;
}

function clonePoint(point) {
  return point ? { ...point } : null;
}
