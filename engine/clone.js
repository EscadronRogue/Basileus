// engine/clone.js - deep copy for game state.
//
// Game state is plain data: objects, arrays, Sets and Maps (no cycles, no
// class instances). Copying it field by field is several times faster than
// structuredClone, which matters to the AI: it copies state for every move it
// validates or scores. Functions such as the seeded RNG are kept by reference.
export function clonePlainData(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const copy = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) copy[index] = clonePlainData(value[index]);
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set();
    for (const entry of value) copy.add(clonePlainData(entry));
    return copy;
  }
  if (value instanceof Map) {
    const copy = new Map();
    for (const [key, entry] of value) copy.set(clonePlainData(key), clonePlainData(entry));
    return copy;
  }
  if (value instanceof Date) return new Date(value.getTime());
  const copy = {};
  for (const key of Object.keys(value)) copy[key] = clonePlainData(value[key]);
  return copy;
}
