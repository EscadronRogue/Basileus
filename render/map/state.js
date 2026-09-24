// render/map/state.js - map constants, filter ids, and the mutable renderer state shared by the map modules.

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const MAP_WIDTH = 297;
export const MAP_HEIGHT = 210;
export const MAP_ASPECT = MAP_WIDTH / MAP_HEIGHT;
export const DEFAULT_MAP_MAX_WIDTH_PX = 2400;
export const MAP_MAX_WIDTH_CSS_VAR = '--map-max-width';
export const LEGACY_ORIGIN_WIDTH = 1150;
export const LEGACY_ORIGIN_HEIGHT = 560;

// Resolved relative to render/map/svgImport.js, which fetches them.
export const SVG_ASSET_PATHS = Object.freeze({
  background: '../../assets/map.svg',
  hitzones: '../../assets/hitzones.svg',
  origin: '../../assets/origin.svg',
});

export const INVASION_ORIGIN_IDS = Object.freeze({
  emirate: 'AGH',
  aghlabids: 'AGH',
  kievan_rus: 'RUS',
  normans: 'NOR',
  venetians: 'VEN',
  bulgars: 'BBUULL',
  serbs: 'SSRRBB',
  hungarians: 'HON',
  turks: 'TUR',
  caliphate: 'CAL',
});
export const PROVINCE_LABEL_SUFFIX = 'LAB';
export const THREAT_HATCH_SPACING = 3.6;
export const THREAT_HATCH_PRIMARY_STROKE = 1.4;
export const MIN_THREAT_HATCH_SCALE = 0.001;
export const MIN_MAP_ZOOM = 1;
export const MAX_MAP_ZOOM = 4;
export const MAP_ZOOM_STEP = 1.2;
export const MAP_KEYBOARD_PAN_UNITS = 14;
export const MAP_DRAG_THRESHOLD_PX = 8;
export const MAP_COARSE_DRAG_THRESHOLD_PX = 12;
export const MIN_PINCH_DISTANCE_PX = 8;
export const LEGACY_MOUSE_POINTER_ID = -1;
export const LEGACY_TOUCH_POINTER_OFFSET = 1000;
export const SVG_PATH_TOKEN_PATTERN = /[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
export const PATH_PARAM_COUNTS = Object.freeze({
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
});
export const CURVE_EPSILON = 1e-9;

export const MAP_FILTERS = Object.freeze({
  REGIONS: 'regions',
  ESTATES: 'estates',
  STRATEGOI: 'strategoi',
  BISHOPS: 'bishops',
  INVASION: 'invasion',
});

export const MAP_FILTER_LABELS = Object.freeze({
  [MAP_FILTERS.REGIONS]: 'Regions',
  [MAP_FILTERS.ESTATES]: 'Estates',
  [MAP_FILTERS.STRATEGOI]: 'Strategoi',
  [MAP_FILTERS.BISHOPS]: 'Bishops',
  [MAP_FILTERS.INVASION]: 'Invasion',
});

export const MAP_FILTER_TO_MARKER_KIND = Object.freeze({
  [MAP_FILTERS.ESTATES]: 'estate',
  [MAP_FILTERS.STRATEGOI]: 'strategos',
  [MAP_FILTERS.BISHOPS]: 'bishop',
});

export const FILTER_VISUAL_PROPS = [
  '--province-filter-fill-color',
  '--province-filter-outline-color',
  '--province-filter-cartouche-fill-color',
  '--province-filter-cartouche-border-color',
  '--province-filter-cartouche-ink-color',
];

// Region outlines are rendered in their own layer and clipped to each
// province interior. The stroke itself is drawn at double the visible width,
// so clipping it to the province makes the outline behave like an inset inner
// stroke whose outer edge sits exactly on the true border. That way adjacent
// provinces both remain visible at shared edges with no gap between them.

// Mutable renderer state shared by the map modules; createMapSVG() resets it.
export const mapRuntime = {
  provinceCentroids: {},
  invasionOrigins: {},
  provinceSelectHandler: null,
  provinceHoverHandler: null,
  selectedProvinceId: null,
  hoveredProvinceId: null,
  viewportLayer: null,
  latestMapState: null,
  activeMapFilter: MAP_FILTERS.REGIONS,
  mapFilterChangeHandler: null,
  mapView: { zoom: 1, panX: 0, panY: 0 },
  gestureState: createGestureState(),
  mapShellResizeObserver: null,
  mapShellResizeHandler: null,
  shellWidthPx: 0,
};

export function createGestureState() {
  return {
    mode: 'idle',
    pointers: new Map(),
    primaryPointerId: null,
    startClientX: 0,
    startClientY: 0,
    startPanX: 0,
    startPanY: 0,
    pinchStartDistance: 0,
    pinchStartZoom: 1,
    pinchContentX: 0,
    pinchContentY: 0,
    moved: false,
    suppressClick: false,
    tapCandidateProvinceId: null,
  };
}

export function clampValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
