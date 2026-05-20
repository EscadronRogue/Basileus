// ui/icons.js — Single source of truth for the three resource glyphs.
//
// Three icons, one grammar:
//   • TROOP  → sword       (replaces the letter "T" / "troops" in UI)
//   • GOLD   → nomisma     (replaces the letter "g" / "gold" in UI)
//   • CHURCH → basilica    (replaces the letter "C" / "church" in UI)
//
// All glyphs are stroke-driven with small filled accents, matching the
// ruleset specimen. Color comes from currentColor, so each icon takes the
// surrounding text color in HTML and in SVG <use> references.
//
// Two interfaces:
//   renderIcon(kind)              — HTML <span> with inline <svg>
//   renderValue(kind, n, opts)    — HTML "[label] [icon] [number]" pill
//   ensureSvgIconSymbols(svgRoot) — install <symbol>s for the map renderer
//   svgUseIcon(kind, attrs)       — build an SVGUseElement referencing them

const SVG_VIEWBOX = '0 0 24 24';

// Each entry's `paths` is the inner SVG markup with currentColor strokes.
const ICON_PATHS = {
  troop: `
    <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="3.2" r="1.05" fill="currentColor" stroke="none"/>
      <path d="M12 4.25 L12 6.5"/>
      <path d="M8 6.5 L16 6.5"/>
      <path d="M8 6.5 L8.9 7.4"/>
      <path d="M16 6.5 L15.1 7.4"/>
      <path d="M12 7 L12 19.4"/>
      <path d="M10.2 7.6 L12 20.4 L13.8 7.6 Z" fill="currentColor" fill-opacity=".18"/>
      <path d="M12 8.4 L12 17.8" stroke-opacity=".45" stroke-width=".9"/>
    </g>
  `,
  gold: `
    <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="8.4" fill="currentColor" fill-opacity=".10"/>
      <circle cx="12" cy="12" r="8.4"/>
      <circle cx="12" cy="12" r="6.4" stroke-opacity=".55" stroke-width=".7"/>
      <path d="M12 7.6 L12 16.4"/>
      <path d="M9 12 L15 12"/>
      <path d="M12 7.6 Q13.4 8.2 13.4 9.4 Q13.4 10.6 12 11"/>
    </g>
  `,
  church: `
    <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3.2 20 L20.8 20"/>
      <path d="M5.2 20 L5.2 12.6 L18.8 12.6 L18.8 20"/>
      <path d="M7.5 12.6 Q12 6.2 16.5 12.6" fill="currentColor" fill-opacity=".12"/>
      <path d="M12 4.1 L12 6.6"/>
      <path d="M10.9 5.2 L13.1 5.2"/>
      <path d="M5.2 12.6 Q3.7 10 5.2 8.8 Q6.7 10 5.2 12.6 Z" fill="currentColor" fill-opacity=".10"/>
      <path d="M18.8 12.6 Q20.3 10 18.8 8.8 Q17.3 10 18.8 12.6 Z" fill="currentColor" fill-opacity=".10"/>
      <path d="M8.6 20 L8.6 16.4 Q10 14.6 11.4 16.4 L11.4 20"/>
      <path d="M12.6 20 L12.6 16.4 Q14 14.6 15.4 16.4 L15.4 20"/>
    </g>
  `,
};

const LABEL_FORMS = {
  troop:  { singular: 'Troop',  plural: 'Troops' },
  gold:   { singular: 'Gold',   plural: 'Gold'   },
  church: { singular: 'Church', plural: 'Church' },
};

// ── HTML helpers ─────────────────────────────────────────────────────

function inlineSvg(kind) {
  const paths = ICON_PATHS[kind];
  if (!paths) return '';
  return `<svg viewBox="${SVG_VIEWBOX}" fill="currentColor" aria-hidden="true">${paths}</svg>`;
}

// Render the icon as a span you can drop inline anywhere.
// Inside `.value`, `.player-tab`, `.cartouche` etc., the icon picks up
// the surrounding color via currentColor.
export function renderIcon(kind, extraClass = '') {
  if (!ICON_PATHS[kind]) return '';
  const cls = `icon icon-${kind}${extraClass ? ` ${extraClass}` : ''}`;
  return `<span class="${cls}">${inlineSvg(kind)}</span>`;
}

// Resolve the label text for a "Troop / Troops" style label option.
// opts.label can be:
//   true        → auto pluralise based on |value|
//   'Troops'    → literal label
//   false/null  → no label
function resolveLabelText(kind, value, label) {
  if (!label) return '';
  if (label === true) {
    const forms = LABEL_FORMS[kind];
    if (!forms) return '';
    return Math.abs(Number(value) || 0) === 1 ? forms.singular : forms.plural;
  }
  return String(label);
}

// Build a "[label] [icon] [number]" pill. The label is optional and only
// included when the host has space (caller passes label: true).
export function renderValue(kind, value, opts = {}) {
  if (!ICON_PATHS[kind]) return '';
  const num = Number(value) || 0;
  const isFractional = !Number.isInteger(num);
  const formatted = opts.displayValue ?? (isFractional ? Math.round(num * 100) / 100 : num);
  const prefix = opts.signed && num > 0 ? '+' : (num < 0 ? '' : '');
  // Number(-3) → "-3" naturally, so only prepend "+" for positives when signed.
  const labelText = resolveLabelText(kind, value, opts.label);
  const labelHtml = labelText ? `<span class="value-noun">${labelText}</span>` : '';
  const toneClass = opts.tone ? ` ${opts.tone}` : '';
  const extraClass = opts.className ? ` ${opts.className}` : '';
  const numHtml = `<span class="value-num">${prefix}${formatted}</span>`;
  return `<span class="value ${kind}${toneClass}${extraClass}">${labelHtml}${renderIcon(kind)}${numHtml}</span>`;
}

// Convenience wrappers — the names match the existing engine/presentation.js
// API so callsites read naturally.
export const renderGoldValue   = (value, opts) => renderValue('gold',   value, opts);
export const renderTroopValue  = (value, opts) => renderValue('troop',  value, opts);
export const renderChurchValue = (value, opts) => renderValue('church', value, opts);

// ── SVG helpers (for the map renderer) ──────────────────────────────
//
// The map renderer needs the icons inside an SVG document. We install one
// <symbol> per icon under the root <defs>, then build <use> references in
// the cartouche values group. Defs install is idempotent.

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_SYMBOL_PREFIX = 'basileus-icon-';

export function ensureSvgIconSymbols(svgRoot) {
  if (!svgRoot) return;
  let defs = svgRoot.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS(SVG_NS, 'defs');
    svgRoot.insertBefore(defs, svgRoot.firstChild);
  }
  for (const [kind, paths] of Object.entries(ICON_PATHS)) {
    const id = `${SVG_SYMBOL_PREFIX}${kind}`;
    if (defs.querySelector(`#${id}`)) continue;
    const symbol = document.createElementNS(SVG_NS, 'symbol');
    symbol.setAttribute('id', id);
    symbol.setAttribute('viewBox', SVG_VIEWBOX);
    symbol.innerHTML = paths;
    defs.appendChild(symbol);
  }
}

// Build a <use> element referring to one of the installed symbols.
// `attrs` accepts {x, y, width, height} in the parent SVG user units.
export function svgUseIcon(kind, attrs = {}) {
  if (!ICON_PATHS[kind]) return null;
  const use = document.createElementNS(SVG_NS, 'use');
  // SVG 2 dropped the xlink prefix requirement; modern browsers (and our
  // target set) accept href directly.
  use.setAttribute('href', `#${SVG_SYMBOL_PREFIX}${kind}`);
  if (attrs.x != null) use.setAttribute('x', String(attrs.x));
  if (attrs.y != null) use.setAttribute('y', String(attrs.y));
  if (attrs.width != null) use.setAttribute('width', String(attrs.width));
  if (attrs.height != null) use.setAttribute('height', String(attrs.height));
  if (attrs.className) use.setAttribute('class', attrs.className);
  return use;
}

// Layout helper for the map cartouche values line. Returns an SVGGElement
// containing the icon+number pairs, horizontally centered around x=0.
// Caller positions the group with its own translate transform.
//
// The pairs are: for each {kind, value} (only non-zero values), draw the
// icon at icon-size, then a <text> for the number to the right.
export function buildSvgValueGroup(entries, options = {}) {
  const iconSize = options.iconSize ?? 1.7;     // SVG user units
  const iconGap = options.iconGap ?? 0.25;       // icon → number gap
  const pairGap = options.pairGap ?? 1.05;       // between successive pairs
  const digitWidth = options.digitWidth ?? 0.78; // approximate per-digit
  const baselineY = options.baselineY ?? 0;      // text baseline within the group
  const iconY = options.iconY ?? -iconSize * 0.78;
  const className = options.className ?? 'map-cart-values';

  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', className);

  // Pre-measure pair widths so we can center the row.
  const pairs = entries
    .filter((entry) => entry && entry.value > 0 && ICON_PATHS[entry.kind])
    .map((entry) => {
      const digits = Math.max(1, String(entry.value).length);
      return {
        kind: entry.kind,
        value: entry.value,
        width: iconSize + iconGap + digits * digitWidth,
      };
    });

  if (!pairs.length) return group;

  const totalWidth = pairs.reduce((sum, p) => sum + p.width, 0)
    + (pairs.length - 1) * pairGap;
  let cursor = -totalWidth / 2;

  for (const pair of pairs) {
    const useEl = svgUseIcon(pair.kind, {
      x: cursor,
      y: iconY,
      width: iconSize,
      height: iconSize,
      className: `map-cart-glyph map-cart-glyph-${pair.kind}`,
    });
    if (useEl) group.appendChild(useEl);

    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', `map-cart-glyph-num map-cart-glyph-num-${pair.kind}`);
    text.setAttribute('x', String(cursor + iconSize + iconGap));
    text.setAttribute('y', String(baselineY));
    text.textContent = String(pair.value);
    group.appendChild(text);

    cursor += pair.width + pairGap;
  }

  return group;
}

// Pretty-print a single icon in markup that survives a re-render diff.
// Returned width is in SVG user units, used by the cartouche sizing pass.
export function measureSvgValueGroupWidth(entries, options = {}) {
  const iconSize = options.iconSize ?? 1.7;
  const iconGap = options.iconGap ?? 0.25;
  const pairGap = options.pairGap ?? 1.05;
  const digitWidth = options.digitWidth ?? 0.78;

  const pairs = entries.filter((entry) => entry && entry.value > 0 && ICON_PATHS[entry.kind]);
  if (!pairs.length) return 0;
  const w = pairs.reduce((sum, entry) => {
    const digits = Math.max(1, String(entry.value).length);
    return sum + iconSize + iconGap + digits * digitWidth;
  }, 0);
  return w + (pairs.length - 1) * pairGap;
}

// Compute the list of {kind, value} entries for a province theme. Used by
// both the map renderer and the inline province-token in HTML so the two
// surfaces always show the same set of values, in the same order.
export function provinceValueEntries(theme) {
  if (!theme || theme.id === 'CPL') return [];
  return [
    { kind: 'gold',   value: Math.max(0, Number(theme.P) || 0) },
    { kind: 'troop',  value: Math.max(0, Number(theme.T) || 0) },
    { kind: 'church', value: Math.max(0, Number(theme.C) || 0) },
  ];
}
