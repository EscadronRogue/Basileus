// render/map/interaction.js - selection, hover, pan, pinch, zoom, and keyboard control.

import {
  LEGACY_MOUSE_POINTER_ID,
  LEGACY_TOUCH_POINTER_OFFSET,
  MAP_COARSE_DRAG_THRESHOLD_PX,
  MAP_DRAG_THRESHOLD_PX,
  MAP_HEIGHT,
  MAP_KEYBOARD_PAN_UNITS,
  MAP_WIDTH,
  MAP_ZOOM_STEP,
  MAX_MAP_ZOOM,
  MIN_MAP_ZOOM,
  MIN_PINCH_DISTANCE_PX,
  clampValue,
  mapRuntime,
} from './state.js';

export function installMapInteractions(svg) {
  if (typeof window !== 'undefined' && 'PointerEvent' in window) {
    svg.addEventListener('pointermove', (event) => handleMapPointerMove(svg, event));
    svg.addEventListener('pointerdown', (event) => beginMapGesture(svg, event));
    svg.addEventListener('pointerup', (event) => endMapGesture(svg, event));
    svg.addEventListener('pointercancel', (event) => endMapGesture(svg, event));
  } else {
    installLegacyMouseMapInteractions(svg);
    installLegacyTouchMapInteractions(svg);
  }

  svg.addEventListener('wheel', (event) => zoomMapAtPoint(svg, event), { passive: false });
  svg.addEventListener('keydown', (event) => handleMapKeyDown(svg, event));
  svg.addEventListener('dblclick', (event) => {
    event.preventDefault();
    resetMapView(svg);
  });

  svg.addEventListener('mouseleave', () => {
    updateHoveredProvince(null);
    updateMapCursor(svg, null);
  });

  svg.addEventListener('click', (event) => {
    if (mapRuntime.gestureState.suppressClick) {
      mapRuntime.gestureState.suppressClick = false;
      return;
    }

    mapRuntime.provinceSelectHandler?.(findProvinceAtEvent(svg, event));
  });
}

function handleMapPointerMove(svg, event) {
  if (mapRuntime.gestureState.pointers.has(event.pointerId)) {
    updateMapGesture(svg, event);
    return;
  }

  if (event.pointerType !== 'mouse') return;

  const provinceId = findProvinceAtClientPoint(svg, event.clientX, event.clientY);
  updateHoveredProvince(provinceId);
  updateMapCursor(svg, provinceId);
}

function installLegacyMouseMapInteractions(svg) {
  const ownerDocument = svg.ownerDocument || globalThis.document;
  const toPointer = (event) => ({
    button: event.button,
    clientX: event.clientX,
    clientY: event.clientY,
    pointerId: LEGACY_MOUSE_POINTER_ID,
    pointerType: 'mouse',
    preventDefault: () => event.preventDefault?.(),
  });

  const handleDocumentMove = (event) => {
    if (!mapRuntime.gestureState.pointers.has(LEGACY_MOUSE_POINTER_ID)) return;
    event.preventDefault?.();
    updateMapGesture(svg, toPointer(event));
  };

  const handleDocumentUp = (event) => {
    ownerDocument?.removeEventListener?.('mousemove', handleDocumentMove);
    endMapGesture(svg, toPointer(event));
  };

  svg.addEventListener('mousemove', (event) => {
    if (mapRuntime.gestureState.pointers.has(LEGACY_MOUSE_POINTER_ID)) {
      updateMapGesture(svg, toPointer(event));
      return;
    }

    const provinceId = findProvinceAtClientPoint(svg, event.clientX, event.clientY);
    updateHoveredProvince(provinceId);
    updateMapCursor(svg, provinceId);
  });

  svg.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    beginMapGesture(svg, toPointer(event));
    ownerDocument?.addEventListener?.('mousemove', handleDocumentMove);
    ownerDocument?.addEventListener?.('mouseup', handleDocumentUp, { once: true });
  });
}

function installLegacyTouchMapInteractions(svg) {
  const toPointer = (touch, event) => ({
    button: 0,
    clientX: touch.clientX,
    clientY: touch.clientY,
    pointerId: LEGACY_TOUCH_POINTER_OFFSET + touch.identifier,
    pointerType: 'touch',
    preventDefault: () => event.preventDefault?.(),
  });

  const preventTouchScrollWhenNeeded = (event) => {
    if (!event.cancelable) return;
    if (mapRuntime.mapView.zoom > 1.001 || event.touches.length > 1) event.preventDefault();
  };

  svg.addEventListener('touchstart', (event) => {
    for (const touch of event.changedTouches || []) beginMapGesture(svg, toPointer(touch, event));
    preventTouchScrollWhenNeeded(event);
  }, { passive: false });

  svg.addEventListener('touchmove', (event) => {
    let handled = false;
    for (const touch of event.changedTouches || []) {
      const pointer = toPointer(touch, event);
      if (!mapRuntime.gestureState.pointers.has(pointer.pointerId)) continue;
      updateMapGesture(svg, pointer);
      handled = true;
    }
    if (handled) preventTouchScrollWhenNeeded(event);
  }, { passive: false });

  const finishTouch = (event) => {
    for (const touch of event.changedTouches || []) endMapGesture(svg, toPointer(touch, event));
  };
  svg.addEventListener('touchend', finishTouch, { passive: true });
  svg.addEventListener('touchcancel', finishTouch, { passive: true });
}

function handleMapKeyDown(svg, event) {
  const key = event.key;
  if (key === '+' || key === '=') {
    event.preventDefault();
    zoomMapAtCenter(svg, MAP_ZOOM_STEP);
    return;
  }

  if (key === '-' || key === '_') {
    event.preventDefault();
    zoomMapAtCenter(svg, 1 / MAP_ZOOM_STEP);
    return;
  }

  if (key === 'Escape' || key === '0') {
    event.preventDefault();
    resetMapView(svg);
    return;
  }

  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key) || mapRuntime.mapView.zoom <= 1.001) return;
  event.preventDefault();
  const step = MAP_KEYBOARD_PAN_UNITS / mapRuntime.mapView.zoom;
  if (key === 'ArrowLeft') mapRuntime.mapView.panX += step;
  if (key === 'ArrowRight') mapRuntime.mapView.panX -= step;
  if (key === 'ArrowUp') mapRuntime.mapView.panY += step;
  if (key === 'ArrowDown') mapRuntime.mapView.panY -= step;
  clampMapView();
  applyMapTransform();
  updateHoveredProvince(null);
  updateMapCursor(svg, null);
}

export function setSelectedProvince(provinceId) {
  mapRuntime.selectedProvinceId = provinceId || null;
  applyProvinceInteractionState();
}

export function setHoveredProvince(provinceId) {
  updateHoveredProvince(provinceId);
}

export function focusProvince(provinceId, options = {}) {
  if (!provinceId) return;

  const centroid = mapRuntime.provinceCentroids[provinceId];
  if (centroid && options.center !== false && mapRuntime.mapView.zoom > 1.001) {
    mapRuntime.mapView.panX = (MAP_WIDTH / 2) - (centroid.cx * mapRuntime.mapView.zoom);
    mapRuntime.mapView.panY = (MAP_HEIGHT / 2) - (centroid.cy * mapRuntime.mapView.zoom);
    clampMapView();
    applyMapTransform();
  }

  if (options.pulse !== false) pulseProvince(provinceId);
}

export function applyProvinceInteractionState() {
  clearProvinceInteractionClass('selected');
  clearProvinceInteractionClass('hovered');

  if (mapRuntime.selectedProvinceId) setProvinceInteractionClass(mapRuntime.selectedProvinceId, 'selected');
  if (mapRuntime.hoveredProvinceId) setProvinceInteractionClass(mapRuntime.hoveredProvinceId, 'hovered');
}

function clearProvinceInteractionClass(className) {
  document.querySelectorAll(`.province-shape.${className}, .region-stroke.${className}, .map-cartouche.${className}`)
    .forEach((element) => element.classList.remove(className));
}

function setProvinceInteractionClass(provinceId, className) {
  document.querySelectorAll([
    `.province-shape[data-id="${provinceId}"]`,
    `.region-stroke[data-id="${provinceId}"]`,
    `.map-cartouche[data-id="${provinceId}"]`,
  ].join(', '))
    .forEach((element) => element.classList.add(className));
}

function pulseProvince(provinceId) {
  const targets = document.querySelectorAll([
    `.province-shape[data-id="${provinceId}"]`,
    `.region-stroke[data-id="${provinceId}"]`,
    `.map-cartouche[data-id="${provinceId}"]`,
  ].join(', '));

  targets.forEach((element) => {
    element.classList.remove('selection-pulse');
    void element.getBoundingClientRect?.();
    element.classList.add('selection-pulse');
    if (typeof window !== 'undefined') {
      window.setTimeout?.(() => element.classList.remove('selection-pulse'), 700);
    }
  });
}

function findProvinceAtEvent(svg, event) {
  const eventTargetHit = findProvinceElement(event.target)?.getAttribute?.('data-id');
  if (eventTargetHit) return eventTargetHit;

  return findProvinceAtClientPoint(svg, event.clientX, event.clientY);
}

function findProvinceAtClientPoint(svg, clientX, clientY) {
  const directHit = findProvinceFromHitStack(clientX, clientY);
  if (directHit) return directHit;

  const screenPoint = svg.createSVGPoint();
  screenPoint.x = clientX;
  screenPoint.y = clientY;

  for (const path of document.querySelectorAll('.province-hitbox, .province-shape')) {
    if (typeof path.isPointInFill !== 'function') continue;

    const screenMatrix = path.getScreenCTM();
    if (!screenMatrix) continue;

    let localPoint = null;
    try {
      localPoint = screenPoint.matrixTransform(screenMatrix.inverse());
    } catch {
      continue;
    }
    if (path.isPointInFill(localPoint)) {
      return path.getAttribute('data-id');
    }
  }

  return null;
}

function findProvinceFromHitStack(clientX, clientY) {
  if (typeof document.elementsFromPoint !== 'function') return null;

  for (const element of document.elementsFromPoint(clientX, clientY)) {
    const provinceElement = findProvinceElement(element);
    const provinceId = provinceElement?.getAttribute?.('data-id');
    if (provinceId) return provinceId;
  }

  return null;
}

function findProvinceElement(element) {
  let current = element;
  while (current && current !== document.documentElement) {
    if (current.matches?.('.province-hitbox, .province-shape, .region-stroke, .map-cartouche')) return current;
    current = current.parentElement || current.parentNode;
  }
  return null;
}

function updateHoveredProvince(provinceId) {
  const nextProvinceId = provinceId || null;
  if (mapRuntime.hoveredProvinceId === nextProvinceId) return;

  mapRuntime.hoveredProvinceId = nextProvinceId;
  applyProvinceInteractionState();
  mapRuntime.provinceHoverHandler?.(mapRuntime.hoveredProvinceId);
}

function beginMapGesture(svg, event) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;

  mapRuntime.gestureState.pointers.set(event.pointerId, getEventClientPoint(event));
  try {
    svg.setPointerCapture?.(event.pointerId);
  } catch {
    // Some SVG implementations expose Pointer Events without capture support.
  }

  if (mapRuntime.gestureState.pointers.size >= 2) {
    mapRuntime.gestureState.tapCandidateProvinceId = null;
    mapRuntime.gestureState.moved = true;
    updateHoveredProvince(null);
    beginMapPinch(svg);
  } else {
    const provinceId = findProvinceAtClientPoint(svg, event.clientX, event.clientY);
    mapRuntime.gestureState.tapCandidateProvinceId = provinceId;
    updateHoveredProvince(provinceId);
    beginSinglePointerPan(event);
  }

  updateMapCursor(svg, mapRuntime.hoveredProvinceId);
}

function beginSinglePointerPan(event) {
  mapRuntime.gestureState.mode = 'pan';
  mapRuntime.gestureState.primaryPointerId = event.pointerId;
  mapRuntime.gestureState.startClientX = event.clientX;
  mapRuntime.gestureState.startClientY = event.clientY;
  mapRuntime.gestureState.startPanX = mapRuntime.mapView.panX;
  mapRuntime.gestureState.startPanY = mapRuntime.mapView.panY;
  mapRuntime.gestureState.moved = false;
}

function beginMapPinch(svg) {
  const pointers = getPrimaryGesturePointers();
  if (pointers.length < 2) return;

  const center = getClientCenter(pointers[0], pointers[1]);
  const centerPoint = clientPointToSvg(svg, center.clientX, center.clientY);
  if (!centerPoint) return;

  const distance = getClientDistance(pointers[0], pointers[1]);
  mapRuntime.gestureState.mode = 'pinch';
  mapRuntime.gestureState.pinchStartDistance = Math.max(MIN_PINCH_DISTANCE_PX, distance);
  mapRuntime.gestureState.pinchStartZoom = mapRuntime.mapView.zoom;
  mapRuntime.gestureState.pinchContentX = (centerPoint.x - mapRuntime.mapView.panX) / mapRuntime.mapView.zoom;
  mapRuntime.gestureState.pinchContentY = (centerPoint.y - mapRuntime.mapView.panY) / mapRuntime.mapView.zoom;
}

function updateMapGesture(svg, event) {
  mapRuntime.gestureState.pointers.set(event.pointerId, getEventClientPoint(event));

  if (mapRuntime.gestureState.pointers.size >= 2) {
    updateMapPinch(svg);
    return;
  }

  updateMapPan(svg, event);
}

function updateMapPan(svg, event) {
  if (mapRuntime.gestureState.mode !== 'pan' || event.pointerId !== mapRuntime.gestureState.primaryPointerId) return;

  const dragDistance = Math.hypot(event.clientX - mapRuntime.gestureState.startClientX, event.clientY - mapRuntime.gestureState.startClientY);
  if (dragDistance > getMapDragThreshold(event)) {
    mapRuntime.gestureState.moved = true;
    updateHoveredProvince(null);
  }

  if (!mapRuntime.gestureState.moved) {
    const provinceId = findProvinceAtClientPoint(svg, event.clientX, event.clientY)
      || mapRuntime.gestureState.tapCandidateProvinceId;
    updateMapCursor(svg, provinceId);
    if (event.pointerType === 'mouse') updateHoveredProvince(provinceId);
    return;
  }

  if (mapRuntime.mapView.zoom <= 1.001) {
    updateMapCursor(svg, null);
    return;
  }

  const startPoint = clientPointToSvg(svg, mapRuntime.gestureState.startClientX, mapRuntime.gestureState.startClientY);
  const currentPoint = clientPointToSvg(svg, event.clientX, event.clientY);
  if (!startPoint || !currentPoint) return;

  mapRuntime.mapView.panX = mapRuntime.gestureState.startPanX + (currentPoint.x - startPoint.x);
  mapRuntime.mapView.panY = mapRuntime.gestureState.startPanY + (currentPoint.y - startPoint.y);
  clampMapView();
  applyMapTransform();
  updateMapCursor(svg, null);
}

function updateMapPinch(svg) {
  const pointers = getPrimaryGesturePointers();
  if (pointers.length < 2 || mapRuntime.gestureState.mode !== 'pinch') return;

  const distance = getClientDistance(pointers[0], pointers[1]);
  const center = getClientCenter(pointers[0], pointers[1]);
  const centerPoint = clientPointToSvg(svg, center.clientX, center.clientY);
  if (!centerPoint || distance < MIN_PINCH_DISTANCE_PX) return;

  const nextZoom = clampValue(
    mapRuntime.gestureState.pinchStartZoom * (distance / mapRuntime.gestureState.pinchStartDistance),
    MIN_MAP_ZOOM,
    MAX_MAP_ZOOM,
  );

  mapRuntime.mapView.zoom = nextZoom;
  mapRuntime.mapView.panX = centerPoint.x - mapRuntime.gestureState.pinchContentX * mapRuntime.mapView.zoom;
  mapRuntime.mapView.panY = centerPoint.y - mapRuntime.gestureState.pinchContentY * mapRuntime.mapView.zoom;
  clampMapView();
  applyMapTransform();

  mapRuntime.gestureState.moved = true;
  updateHoveredProvince(null);
  updateMapCursor(svg, null);
}

function endMapGesture(svg, event) {
  if (!mapRuntime.gestureState.pointers.has(event.pointerId)) return;
  const wasPrimaryPanPointer = mapRuntime.gestureState.mode === 'pan'
    && event.pointerId === mapRuntime.gestureState.primaryPointerId;

  try {
    svg.releasePointerCapture?.(event.pointerId);
  } catch {
    // Capture may have been lost during browser-managed scroll or gesture cancel.
  }
  mapRuntime.gestureState.pointers.delete(event.pointerId);

  if (mapRuntime.gestureState.mode === 'pinch' && mapRuntime.gestureState.pointers.size === 1) {
    const [remainingPointer] = mapRuntime.gestureState.pointers.entries();
    mapRuntime.gestureState.primaryPointerId = remainingPointer[0];
    mapRuntime.gestureState.startClientX = remainingPointer[1].clientX;
    mapRuntime.gestureState.startClientY = remainingPointer[1].clientY;
    mapRuntime.gestureState.startPanX = mapRuntime.mapView.panX;
    mapRuntime.gestureState.startPanY = mapRuntime.mapView.panY;
    mapRuntime.gestureState.mode = 'pan';
    updateMapCursor(svg, null);
    return;
  }

  if (mapRuntime.gestureState.mode === 'pinch' && mapRuntime.gestureState.pointers.size >= 2) {
    beginMapPinch(svg);
    updateMapCursor(svg, null);
    return;
  }

  if (mapRuntime.gestureState.pointers.size > 0) return;

  if (wasPrimaryPanPointer && !mapRuntime.gestureState.moved) {
    const provinceId = findProvinceAtClientPoint(svg, event.clientX, event.clientY)
      || mapRuntime.gestureState.tapCandidateProvinceId;
    if (provinceId) {
      mapRuntime.provinceSelectHandler?.(provinceId);
      mapRuntime.gestureState.suppressClick = true;
      if (event.pointerType !== 'mouse') updateHoveredProvince(null);
    }
  } else if (mapRuntime.gestureState.moved) {
    mapRuntime.gestureState.suppressClick = true;
  }

  mapRuntime.gestureState.mode = 'idle';
  mapRuntime.gestureState.primaryPointerId = null;
  mapRuntime.gestureState.tapCandidateProvinceId = null;
  mapRuntime.gestureState.moved = false;
  updateMapCursor(svg, mapRuntime.hoveredProvinceId);
}

function getEventClientPoint(event) {
  return { clientX: event.clientX, clientY: event.clientY };
}

function getMapDragThreshold(event) {
  return event.pointerType === 'mouse' ? MAP_DRAG_THRESHOLD_PX : MAP_COARSE_DRAG_THRESHOLD_PX;
}

function getPrimaryGesturePointers() {
  return [...mapRuntime.gestureState.pointers.values()].slice(0, 2);
}

function getClientCenter(first, second) {
  return {
    clientX: (first.clientX + second.clientX) / 2,
    clientY: (first.clientY + second.clientY) / 2,
  };
}

function getClientDistance(first, second) {
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

function zoomMapAtPoint(svg, event) {
  event.preventDefault();
  zoomMapAtClientPoint(svg, event.clientX, event.clientY, event.deltaY < 0 ? MAP_ZOOM_STEP : 1 / MAP_ZOOM_STEP);
}

export function zoomMapAtCenter(svg, factor) {
  const rect = svg.getBoundingClientRect();
  zoomMapAtClientPoint(svg, rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
}

function zoomMapAtClientPoint(svg, clientX, clientY, factor) {
  const point = clientPointToSvg(svg, clientX, clientY);
  if (!point) return;

  const nextZoom = clampValue(mapRuntime.mapView.zoom * factor, MIN_MAP_ZOOM, MAX_MAP_ZOOM);
  if (Math.abs(nextZoom - mapRuntime.mapView.zoom) < 0.001) return;

  const contentX = (point.x - mapRuntime.mapView.panX) / mapRuntime.mapView.zoom;
  const contentY = (point.y - mapRuntime.mapView.panY) / mapRuntime.mapView.zoom;

  mapRuntime.mapView.zoom = nextZoom;
  mapRuntime.mapView.panX = point.x - contentX * mapRuntime.mapView.zoom;
  mapRuntime.mapView.panY = point.y - contentY * mapRuntime.mapView.zoom;
  clampMapView();
  applyMapTransform();
  updateHoveredProvince(null);
  updateMapCursor(svg, null);
}

export function resetMapView(svg) {
  mapRuntime.mapView.zoom = 1;
  mapRuntime.mapView.panX = 0;
  mapRuntime.mapView.panY = 0;
  mapRuntime.gestureState.suppressClick = true;
  applyMapTransform();
  updateHoveredProvince(null);
  updateMapCursor(svg, null);
}

export function applyMapTransform() {
  if (!mapRuntime.viewportLayer) return;
  mapRuntime.viewportLayer.setAttribute(
    'transform',
    `translate(${mapRuntime.mapView.panX.toFixed(3)} ${mapRuntime.mapView.panY.toFixed(3)}) scale(${mapRuntime.mapView.zoom.toFixed(3)})`,
  );
  mapRuntime.viewportLayer.ownerSVGElement?.classList.toggle('is-map-zoomed', mapRuntime.mapView.zoom > 1.001);
}

function clampMapView() {
  if (mapRuntime.mapView.zoom <= MIN_MAP_ZOOM + 0.001) {
    mapRuntime.mapView.zoom = 1;
    mapRuntime.mapView.panX = 0;
    mapRuntime.mapView.panY = 0;
    return;
  }

  mapRuntime.mapView.zoom = clampValue(mapRuntime.mapView.zoom, MIN_MAP_ZOOM, MAX_MAP_ZOOM);

  const minPanX = MAP_WIDTH * (1 - mapRuntime.mapView.zoom);
  const minPanY = MAP_HEIGHT * (1 - mapRuntime.mapView.zoom);
  mapRuntime.mapView.panX = clampValue(mapRuntime.mapView.panX, minPanX, 0);
  mapRuntime.mapView.panY = clampValue(mapRuntime.mapView.panY, minPanY, 0);
}

function clientPointToSvg(svg, clientX, clientY) {
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;

  try {
    const matrix = svg.getScreenCTM();
    return matrix ? point.matrixTransform(matrix.inverse()) : null;
  } catch {
    return null;
  }
}

function updateMapCursor(svg, provinceId) {
  if ((mapRuntime.gestureState.mode === 'pinch' || mapRuntime.gestureState.mode === 'pan') && mapRuntime.mapView.zoom > 1.001) {
    svg.style.cursor = 'grabbing';
    return;
  }

  if (provinceId) {
    svg.style.cursor = 'pointer';
    return;
  }

  svg.style.cursor = mapRuntime.mapView.zoom > 1.001 ? 'grab' : '';
}
