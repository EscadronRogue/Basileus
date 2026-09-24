// ui/glossaryTooltips.js - bold key words that explain themselves.
//
// Key words from ui/glossary.js are wrapped in bold spans wherever the UI
// renders text. Hovering one opens its definition. Keep hovering and the
// tooltip locks (the bar along its bottom fills up): a locked tooltip stays
// open while the pointer moves into it, so the key words inside it can be
// hovered in turn, as deep as you like. Clicking a key word locks its
// tooltip at once; Escape or clicking elsewhere closes tooltips. On touch
// screens a tap opens a locked tooltip.
import { findGlossaryMatches, getGlossaryTerm } from './glossary.js';

export const GLOSSARY_SHOW_DELAY_MS = 120;
export const GLOSSARY_LOCK_DELAY_MS = 900;
const CLOSE_GRACE_MS = 220;

// Text inside these is never marked: controls, headings, graphics, and the
// key words themselves.
const SKIP_SELECTOR = [
  'button', 'input', 'textarea', 'select', 'option', 'script', 'style', 'code', 'a',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dt', 'svg', '[contenteditable]', '[data-no-glossary]',
  '.glossary-term', '.glossary-tooltip-head',
].join(',');
// Map redraws and the tooltips themselves are not scanned for key words.
const IGNORED_MUTATION_SELECTOR = 'svg, #mapContainer, .glossary-tooltip-layer';
const BLOCK_SELECTOR = 'p, li, td, th, dd, dt, div, section, article, aside, header, footer, details';

// Marks each term once per block, so a paragraph that says "Basileus" five
// times only bolds the first.
const markedInBlock = new WeakMap();

function shouldSkip(node) {
  const parent = node.parentElement;
  if (!parent || parent.closest(SKIP_SELECTOR)) return true;
  return !node.nodeValue || !node.nodeValue.trim();
}

function wrapTextNode(node, skipIds) {
  const text = node.nodeValue;
  const block = node.parentElement.closest(BLOCK_SELECTOR) || node.parentElement;
  let used = markedInBlock.get(block);
  const matches = findGlossaryMatches(text, { skipIds }).filter((match) => !used?.has(match.id));
  if (!matches.length) return;
  if (!used) {
    used = new Set();
    markedInBlock.set(block, used);
  }
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const match of matches) {
    if (used.has(match.id)) continue;
    used.add(match.id);
    if (match.start > cursor) fragment.append(text.slice(cursor, match.start));
    const term = document.createElement('span');
    term.className = 'glossary-term';
    term.dataset.glossaryId = match.id;
    term.textContent = match.text;
    fragment.append(term);
    cursor = match.end;
  }
  if (cursor < text.length) fragment.append(text.slice(cursor));
  node.replaceWith(fragment);
}

// Wraps every key word under `root` (an element or text node).
export function markGlossaryTerms(root, { skipIds = null } = {}) {
  if (!root || typeof document === 'undefined') return;
  if (root.nodeType === Node.TEXT_NODE) {
    if (!shouldSkip(root)) wrapTextNode(root, skipIds);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE || root.closest(SKIP_SELECTOR)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (shouldSkip(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) wrapTextNode(node, skipIds);
}

// ---------------------------------------------------------------------------
// Tooltips

function createTooltipManager(host) {
  // One entry per open tooltip, parent first: { anchor, element, locked, timers }.
  const stack = [];
  let nextId = 1;

  function levelOf(element) {
    const tooltip = element?.closest?.('.glossary-tooltip');
    if (!tooltip) return -1;
    return stack.findIndex((entry) => entry.element === tooltip);
  }

  function clearTimers(entry) {
    clearTimeout(entry.showTimer);
    clearTimeout(entry.lockTimer);
    clearTimeout(entry.closeTimer);
  }

  function closeFrom(level) {
    while (stack.length > Math.max(0, level)) {
      const entry = stack.pop();
      clearTimers(entry);
      entry.anchor.classList.remove('is-open');
      entry.anchor.removeAttribute('aria-describedby');
      entry.element.remove();
    }
  }

  // A word on the page gets its tooltip below it (above if there is no
  // room). A word inside a tooltip gets its tooltip beside that tooltip, so
  // the chain of definitions reads left to right without covering itself.
  function position(entry, parent) {
    const margin = 12;
    const rect = entry.anchor.getBoundingClientRect();
    const box = entry.element.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const clampLeft = (value) => Math.min(Math.max(margin, value), Math.max(margin, viewportWidth - box.width - margin));
    const clampTop = (value) => Math.min(Math.max(margin, value), Math.max(margin, viewportHeight - box.height - margin));
    let top;
    let left;
    if (parent) {
      const parentBox = parent.element.getBoundingClientRect();
      top = clampTop(rect.top - 10);
      left = parentBox.right + 8 + box.width <= viewportWidth - margin
        ? parentBox.right + 8
        : parentBox.left - 8 - box.width;
      if (left < margin) {
        left = clampLeft(rect.left);
        top = clampTop(parentBox.bottom + 8);
      }
    } else {
      top = rect.bottom + 8;
      if (top + box.height > viewportHeight - margin && rect.top - 8 - box.height >= margin) {
        top = rect.top - 8 - box.height;
      }
      top = Math.max(margin, top);
      left = clampLeft(rect.left);
    }
    entry.element.style.top = `${top}px`;
    entry.element.style.left = `${left}px`;
  }

  function lock(entry) {
    if (entry.locked) return;
    entry.locked = true;
    clearTimeout(entry.lockTimer);
    entry.element.classList.add('is-locked');
  }

  function buildTooltip(term, level) {
    const element = document.createElement('div');
    element.className = 'glossary-tooltip';
    element.id = `glossary-tooltip-${nextId++}`;
    element.setAttribute('role', 'tooltip');
    element.dataset.level = String(level);
    element.style.setProperty('--glossary-lock-ms', `${GLOSSARY_LOCK_DELAY_MS}ms`);
    const head = document.createElement('div');
    head.className = 'glossary-tooltip-head';
    const category = document.createElement('span');
    category.className = 'glossary-tooltip-category';
    category.textContent = term.category;
    const title = document.createElement('strong');
    title.className = 'glossary-tooltip-title';
    title.textContent = term.term;
    head.append(category, title);
    const body = document.createElement('p');
    body.className = 'glossary-tooltip-body';
    body.textContent = term.definition;
    const lockBar = document.createElement('div');
    lockBar.className = 'glossary-tooltip-lock';
    lockBar.setAttribute('aria-hidden', 'true');
    element.append(head, body, lockBar);
    markGlossaryTerms(body, { skipIds: new Set([term.id]) });
    return element;
  }

  function open(anchor, { locked = false } = {}) {
    const term = getGlossaryTerm(anchor.dataset.glossaryId);
    if (!term) return;
    const level = levelOf(anchor) + 1;
    const existing = stack[level];
    if (existing?.anchor === anchor) {
      clearTimeout(existing.closeTimer);
      if (locked) lock(existing);
      return;
    }
    closeFrom(level);
    const entry = { anchor, element: buildTooltip(term, level), locked: false };
    stack.push(entry);
    anchor.classList.add('is-open');
    anchor.setAttribute('aria-describedby', entry.element.id);
    const parent = level > 0 ? stack[level - 1] : null;
    const show = () => {
      host.append(entry.element);
      position(entry, parent);
      entry.element.classList.add('is-visible');
      if (locked) lock(entry);
      else entry.lockTimer = setTimeout(() => lock(entry), GLOSSARY_LOCK_DELAY_MS);
    };
    if (locked) show();
    else entry.showTimer = setTimeout(show, GLOSSARY_SHOW_DELAY_MS);
  }

  // The pointer is somewhere in `target`; keep the tooltips it needs, close
  // the rest once the grace period runs out.
  function keepFor(target) {
    const anchorTerm = target?.closest?.('.glossary-term');
    let keep = levelOf(target);
    if (anchorTerm) {
      const index = stack.findIndex((entry) => entry.anchor === anchorTerm);
      if (index >= 0) keep = Math.max(keep, index);
    }
    stack.forEach((entry, index) => {
      if (index <= keep) {
        clearTimeout(entry.closeTimer);
        entry.closeTimer = null;
      } else if (!entry.closeTimer) {
        const delay = entry.locked ? CLOSE_GRACE_MS : 0;
        entry.closeTimer = setTimeout(() => {
          const current = stack.indexOf(entry);
          if (current >= 0) closeFrom(current);
        }, delay);
      }
    });
  }

  function onPointerOver(event) {
    if (event.pointerType === 'touch') return;
    const anchor = event.target.closest?.('.glossary-term');
    keepFor(event.target);
    if (anchor) open(anchor);
  }

  function onClick(event) {
    const anchor = event.target.closest?.('.glossary-term');
    if (anchor) {
      event.preventDefault();
      const index = stack.findIndex((entry) => entry.anchor === anchor);
      if (index >= 0 && stack[index].locked && event.pointerType !== 'touch') closeFrom(index);
      else open(anchor, { locked: true });
      return;
    }
    if (!event.target.closest?.('.glossary-tooltip')) closeFrom(0);
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && stack.length) closeFrom(stack.length - 1);
  }

  function onViewportChange() {
    closeFrom(0);
  }

  document.addEventListener('pointerover', onPointerOver);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onViewportChange);
  document.addEventListener('scroll', (event) => {
    if (!event.target?.closest?.('.glossary-tooltip')) onViewportChange();
  }, true);

  // Panels re-render; a tooltip whose word was replaced has nothing to
  // explain any more unless the player locked it.
  function pruneDetached() {
    const index = stack.findIndex((entry) => !entry.anchor.isConnected && !entry.locked);
    if (index >= 0) closeFrom(index);
  }

  return {
    pruneDetached,
    closeAll: () => closeFrom(0),
    get openCount() {
      return stack.length;
    },
  };
}

let installed = null;

// Marks key words in everything rendered under `root`, now and later, and
// enables the tooltips. Safe to call more than once.
export function installGlossary(root = document.body) {
  if (installed || typeof document === 'undefined' || !root) return installed;
  const host = document.createElement('div');
  host.className = 'glossary-tooltip-layer';
  document.body.append(host);
  const tooltips = createTooltipManager(host);

  const pending = new Set();
  let scheduled = false;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target.closest?.(IGNORED_MUTATION_SELECTOR)) continue;
      for (const node of record.addedNodes) pending.add(node);
      if (record.removedNodes.length) tooltips.pruneDetached();
    }
    if (!pending.size || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const nodes = [...pending];
      pending.clear();
      for (const node of nodes) if (node.isConnected) markGlossaryTerms(node);
      // Our own wrapping shows up as mutations too; drop them.
      observer.takeRecords();
    });
  });
  markGlossaryTerms(root);
  observer.observe(root, { childList: true, subtree: true });
  installed = { tooltips, observer };
  return installed;
}
