import { readTroopEntry } from './cascade.js';
import { getOfficeDisplayName, getOfficeHolder } from './state.js';

export const STRATEGOS_DEPLOYMENT_ARMY_KEY = 'STRAT_ALL';

export function getDefaultDeploymentFunding(totalTroops) {
  const max = Math.max(0, Number(totalTroops) || 0);
  return Math.ceil(max / 2);
}

export function isStrategosOfficeKey(officeKey) {
  const key = String(officeKey || '');
  return key.startsWith('STRAT_') && key !== STRATEGOS_DEPLOYMENT_ARMY_KEY;
}

export function isStrategosDeploymentArmyKey(armyKey) {
  return armyKey === STRATEGOS_DEPLOYMENT_ARMY_KEY;
}

export function getPlayerStrategosOfficeKeys(state, playerId) {
  return Object.keys(state?.currentTroops || {})
    .filter((officeKey) => isStrategosOfficeKey(officeKey))
    .filter((officeKey) => getOfficeHolder(state, officeKey) === playerId)
    .sort((left, right) => left.localeCompare(right));
}

export function getPlayerDeploymentArmyKeys(state, playerId) {
  const keys = [];
  let hasStrategosArmy = false;

  for (const officeKey of Object.keys(state?.currentTroops || {})) {
    if (getOfficeHolder(state, officeKey) !== playerId) continue;
    if (isStrategosOfficeKey(officeKey)) {
      hasStrategosArmy = true;
      continue;
    }
    keys.push(officeKey);
  }

  if (hasStrategosArmy) keys.push(STRATEGOS_DEPLOYMENT_ARMY_KEY);
  return keys.sort((left, right) => left.localeCompare(right));
}

export function getDeploymentArmySourceKeys(state, playerId, armyKey) {
  if (isStrategosDeploymentArmyKey(armyKey)) return getPlayerStrategosOfficeKeys(state, playerId);
  return [armyKey];
}

export function getDeploymentArmyTroopEntry(state, playerId, armyKey) {
  return getDeploymentArmySourceKeys(state, playerId, armyKey).reduce((total, sourceKey) => {
    const entry = readTroopEntry(state?.currentTroops?.[sourceKey]);
    total.normal += entry.normal;
    total.capitalLocked += entry.capitalLocked;
    return total;
  }, { normal: 0, capitalLocked: 0 });
}

export function getDeploymentArmyTroopTotal(state, playerId, armyKey) {
  const entry = getDeploymentArmyTroopEntry(state, playerId, armyKey);
  return entry.normal + entry.capitalLocked;
}

export function getDeploymentArmyDisplayName(state, playerId, armyKey) {
  if (isStrategosDeploymentArmyKey(armyKey)) {
    const count = getPlayerStrategosOfficeKeys(state, playerId).length;
    return count === 1 ? 'Strategos' : 'Strategoi';
  }
  return getOfficeDisplayName(state, armyKey);
}
