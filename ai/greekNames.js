// Romanized Greek given names, curated from Wiktionary's Greek name appendices.
// Source: https://en.wiktionary.org/wiki/Appendix:Romanizations_of_Greek_given_names
export const GREEK_FIRST_NAMES = Object.freeze([
  'Achilleus',
  'Alexandros',
  'Alexios',
  'Anastasios',
  'Andreas',
  'Andronikos',
  'Antonios',
  'Aristides',
  'Athanasios',
  'Basileios',
  'Charalambos',
  'Christophoros',
  'Damianos',
  'Demetrios',
  'Dionysios',
  'Eireneios',
  'Emmanouel',
  'Eugenios',
  'Eustathios',
  'Fotios',
  'Georgios',
  'Gregorios',
  'Herakleios',
  'Ioannes',
  'Isaakios',
  'Konstantinos',
  'Kosmas',
  'Kyriakos',
  'Leon',
  'Leontios',
  'Manouel',
  'Markos',
  'Matthaios',
  'Michael',
  'Niketas',
  'Nikephoros',
  'Nikolaos',
  'Panagiotis',
  'Petros',
  'Philaretos',
  'Romanos',
  'Sergios',
  'Stephanos',
  'Theodoros',
  'Theophanes',
  'Vissarion',
  'Zacharias',
]);

function numericSeed(seed) {
  const number = Number(seed);
  if (Number.isFinite(number)) return number >>> 0;
  let value = 0;
  for (const char of String(seed || '')) {
    value = Math.imul(value ^ char.charCodeAt(0), 0x45d9f3b) >>> 0;
  }
  return value || ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0);
}

function seededUnit(seed) {
  let value = numericSeed(seed) || 1;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  return (((value ^ (value >>> 16)) >>> 0) / 0xffffffff);
}

export function pickGreekFirstName(seed = undefined) {
  const roll = seed == null ? Math.random() : seededUnit(seed);
  return GREEK_FIRST_NAMES[Math.floor(roll * GREEK_FIRST_NAMES.length)] || 'Konstantinos';
}

function normalizedFirstName(name) {
  return String(name || '').trim().toLowerCase();
}

export function pickUniqueGreekFirstName(seed = undefined, usedNames = []) {
  const used = new Set(
    (Array.isArray(usedNames) ? usedNames : [usedNames])
      .map(normalizedFirstName)
      .filter(Boolean),
  );
  const roll = seed == null ? Math.random() : seededUnit(seed);
  const start = Math.floor(roll * GREEK_FIRST_NAMES.length);
  for (let offset = 0; offset < GREEK_FIRST_NAMES.length; offset += 1) {
    const name = GREEK_FIRST_NAMES[(start + offset) % GREEK_FIRST_NAMES.length] || 'Konstantinos';
    if (!used.has(normalizedFirstName(name))) return name;
  }

  const baseName = GREEK_FIRST_NAMES[start] || 'Konstantinos';
  let suffix = 2;
  let candidate = `${baseName} ${suffix}`;
  while (used.has(normalizedFirstName(candidate))) {
    suffix += 1;
    candidate = `${baseName} ${suffix}`;
  }
  return candidate;
}

export function slugifyGreekFirstName(name) {
  return String(name || 'ai')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase() || 'ai';
}
