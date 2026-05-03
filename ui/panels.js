// ui/panels.js — Interactive UI panels: Court, Orders, player dashboard
import { MAJOR_TITLES, MAJOR_TITLE_DISTRIBUTION } from '../data/titles.js';
import { runAdministration } from '../engine/cascade.js';
import { canGrantTaxExemption, canRecruitProfessional, suggestMajorTitleAssignments } from '../engine/actions.js';
import {
  getMercenaryOrderCost,
  getNormalOwnerIncome,
  getNormalTaxIncome,
  getTaxExemptOwnerIncome,
  getThemeLandPrice,
  getThemeOwnerIncome,
  isThemeThreatened,
} from '../engine/rules.js';
import { getFreeThemes, getPlayerThemes, getPlayer, formatPlayerLabel } from '../engine/state.js';
import {
  getPlayerStyleAttr,
  getProvinceStyleAttr,
  getRegionLabel,
  renderPlayerRoleName,
  renderPlayerRoleNameById,
  renderProvinceBadge,
  renderProvinceBadgeList,
  renderTitleBadge,
  renderThemeOfficeBadge,
} from './labels.js';


function renderThemeChoiceButtons(state, themes, selectedId) {
  return themes.map((theme) => `
    <button type="button" class="province-choice-btn ${theme.id === selectedId ? 'selected' : ''}" data-theme-choice="${theme.id}" style="${getProvinceStyleAttr(state, theme)}">
      ${renderProvinceBadge(state, theme, { showValues: true })}
    </button>
  `).join('');
}

function renderThemeChoiceControl(state, themes, inputId, selectedId, options = {}) {
  const fallbackId = themes[0]?.id || '';
  const normalizedSelectedId = themes.some((theme) => theme.id === selectedId) ? selectedId : fallbackId;
  const inputIdAttr = inputId ? ` id="${inputId}"` : '';
  const extraClass = options.className ? ` ${options.className}` : '';
  const hidden = options.hidden ? ' style="display:none"' : '';
  return `
    <div class="province-choice-grid${extraClass}" data-theme-choice-group${hidden}>
      ${renderThemeChoiceButtons(state, themes, normalizedSelectedId)}
      <input type="hidden"${inputIdAttr} class="appt-theme-select" value="${normalizedSelectedId}">
    </div>`;
}

// Court titles whose levies are locked to the capital.
const CAPITAL_LOCKED_OFFICE_KEYS = new Set(['EMPRESS', 'PATRIARCH', 'CHIEF_EUNUCHS']);

function isCapitalLockedOfficeKey(officeKey) {
  return CAPITAL_LOCKED_OFFICE_KEYS.has(officeKey);
}

// ─── Helpers used everywhere ───
//
// `label` is HTML — for major/minor offices it's a single title cartouche,
// and for theme commands it's a "<title-cartouche> of <land-cartouche>" pair.
// `plain` is a fallback string for non-HTML contexts (e.g. log copy).
function getPlayerOffices(state, playerId) {
  const offices = [];
  const titleBadge = (kind, opts) => renderTitleBadge(state, kind, { holderId: playerId, compact: true, ...opts });
  if (playerId === state.basileusId) {
    offices.push({ key: 'BASILEUS', label: titleBadge('BASILEUS'), plain: 'Basileus' });
  }
  const player = getPlayer(state, playerId);
  for (const t of player.majorTitles) {
    offices.push({ key: t, label: titleBadge(t), plain: MAJOR_TITLES[t]?.name || t, capitalLocked: t === 'PATRIARCH' });
  }
  if (state.empress === playerId) {
    offices.push({ key: 'EMPRESS', label: titleBadge('EMPRESS'), plain: 'Empress', capitalLocked: true });
  }
  if (state.chiefEunuchs === playerId) {
    offices.push({ key: 'CHIEF_EUNUCHS', label: titleBadge('CHIEF_EUNUCHS'), plain: 'Chief of Eunuchs', capitalLocked: true });
  }
  for (const theme of Object.values(state.themes)) {
    if (theme.strategos === playerId && !theme.occupied) {
      offices.push({
        key: `STRAT_${theme.id}`,
        label: renderThemeOfficeBadge(state, 'STRATEGOS', theme.id),
        plain: `Strategos of ${theme.name}`,
      });
    }
  }
  return offices;
}

function getTotalProfessionalArmy(player) {
  return Object.values(player.professionalArmies).reduce((s, n) => s + n, 0);
}

function panelIsOpen(uiState, key, fallback = true) {
  const value = uiState?.panels?.[key];
  return value == null ? fallback : Boolean(value);
}

function sectionIsOpen(uiState, key, fallback = true) {
  const value = uiState?.sections?.[key];
  return value == null ? fallback : Boolean(value);
}

function formatSigned(value) {
  const rounded = Math.round(value * 100) / 100;
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

function getPrivateIncomeProjection(state, playerId) {
  return getPlayerThemes(state, playerId).reduce(
    (total, theme) => total + getThemeOwnerIncome(theme),
    0
  );
}

function getProjectedFinance(state, playerId) {
  const player = getPlayer(state, playerId);
  const administration = runAdministration(state);
  const projectedIncome = administration.income[playerId] || 0;
  const privateIncome = getPrivateIncomeProjection(state, playerId);
  const officeIncome = projectedIncome - privateIncome;
  const maintenance = getTotalProfessionalArmy(player);
  const nextTreasury = player.gold + projectedIncome - maintenance;
  const officeKeys = new Set(getPlayerOffices(state, playerId).map((office) => office.key));
  const levyProjection = Object.entries(administration.levies || {}).reduce((total, [officeKey, count]) => (
    officeKeys.has(officeKey) ? total + count : total
  ), 0);

  return {
    projectedIncome,
    privateIncome,
    officeIncome,
    maintenance,
    nextTreasury,
    levyProjection,
  };
}

function getPlayerTitleEntries(state, playerId) {
  const titles = [];
  const titleBadge = (kind, opts) => renderTitleBadge(state, kind, { holderId: playerId, compact: true, ...opts });
  if (playerId === state.basileusId) {
    titles.push({ scope: 'throne', label: titleBadge('BASILEUS'), detail: 'Imperial throne' });
  }

  const player = getPlayer(state, playerId);
  for (const titleKey of player.majorTitles) {
    titles.push({ scope: 'major', label: titleBadge(titleKey), detail: 'Major office' });
  }
  if (state.empress === playerId) {
    titles.push({ scope: 'minor', label: titleBadge('EMPRESS'), detail: 'Minor court title' });
  }
  if (state.chiefEunuchs === playerId) {
    titles.push({ scope: 'minor', label: titleBadge('CHIEF_EUNUCHS'), detail: 'Minor court title' });
  }
  for (const theme of Object.values(state.themes)) {
    if (theme.occupied) continue;
    if (theme.strategos === playerId) {
      titles.push({ scope: 'minor', label: renderThemeOfficeBadge(state, 'STRATEGOS', theme.id), detail: 'Theme command' });
    }
    if (theme.bishop === playerId) {
      titles.push({ scope: 'minor', label: renderThemeOfficeBadge(state, 'BISHOP', theme.id), detail: theme.bishopIsDonor ? 'Donor bishopric' : 'Bishopric' });
    }
  }
  return titles;
}

function getPlayerArmyEntries(state, playerId, includeEmpty = false) {
  const player = getPlayer(state, playerId);
  return getPlayerOffices(state, playerId)
    .map((office) => ({
      officeKey: office.key,
      label: office.label,
      count: player.professionalArmies[office.key] || 0,
    }))
    .filter((entry) => includeEmpty || entry.count > 0);
}

function getOpinionDescriptor(value) {
  if (value >= 2.5) return 'loyal';
  if (value >= 1) return 'warm';
  if (value > -1) return 'wary';
  if (value > -2.5) return 'cold';
  return 'hostile';
}

function getPlayerOpinionRows(state, aiMeta, playerId) {
  if (!aiMeta || aiMeta.humanPlayerIds.has(playerId)) return [];

  const perspective = aiMeta.players[playerId];
  const humanId = [...aiMeta.humanPlayerIds][0] ?? null;

  return state.players
    .filter((player) => player.id !== playerId)
    .map((player) => {
      const trust = perspective?.trust?.[player.id] || 0;
      const grievance = perspective?.grievance?.[player.id] || 0;
      const net = trust - grievance;
      const owesThem = perspective?.obligations?.[player.id] || 0;
      const theyOwe = aiMeta.players[player.id]?.obligations?.[playerId] || 0;
      return {
        playerId: player.id,
        name: renderPlayerRoleName(state, player),
        isHuman: player.id === humanId,
        net,
        trust,
        grievance,
        owesThem,
        theyOwe,
        descriptor: getOpinionDescriptor(net),
      };
    })
    .sort((left, right) => {
      if (left.isHuman && !right.isHuman) return -1;
      if (!left.isHuman && right.isHuman) return 1;
      return right.net - left.net;
    });
}

function renderFoldSection(sectionKey, title, bodyHtml, uiState, options = {}) {
  if (!bodyHtml) return '';
  const isOpen = sectionIsOpen(uiState, sectionKey, options.defaultOpen !== false);
  const badge = options.badge ? `<span class="fold-summary-badge">${options.badge}</span>` : '';
  const summary = options.summary ? `<span class="fold-summary-note">${options.summary}</span>` : '';
  const focusedClass = options.focused ? ' focused' : '';
  return `
    <details class="fold-section${focusedClass}" data-section-key="${sectionKey}" ${isOpen ? 'open' : ''}>
      <summary class="fold-summary">
        <span class="fold-summary-title">${title}</span>
        <span class="fold-summary-meta">${badge}${summary}</span>
      </summary>
      <div class="fold-body">
        ${bodyHtml}
      </div>
    </details>
  `;
}

function countMinorTitles(state, playerId) {
  let count = 0;
  if (state.empress === playerId) count++;
  if (state.chiefEunuchs === playerId) count++;
  for (const t of Object.values(state.themes)) {
    if (t.strategos === playerId) count++;
    if (t.bishop === playerId) count++;
  }
  return count;
}

function selfAppointmentOnCooldown(state, appointerId) {
  if (appointerId == null) return false;
  const appointer = getPlayer(state, appointerId);
  if (!appointer) return false;
  return appointer.appointmentCooldown?.__SELF_ANY === state.round - 1;
}

function getSelectablePlayers(state, selectedId, options = {}) {
  const excludeId = options.excludeId;
  const players = state.players.filter((player) => excludeId == null || player.id !== excludeId);
  const fallbackId = players[0]?.id ?? '';
  const normalizedSelectedId = players.some((player) => player.id === selectedId) ? selectedId : fallbackId;
  return { players, selectedId: normalizedSelectedId };
}

function renderPlayerChoiceControl(state, inputId, selectedId, options = {}) {
  const { players, selectedId: normalizedSelectedId } = getSelectablePlayers(state, selectedId, options);
  if (!players.length) return `<input type="hidden" id="${inputId || ''}" class="appt-player-select" value="">`;
  const inputIdAttr = inputId ? ` id="${inputId}"` : '';
  return `
    <div class="player-choice-grid" data-player-choice-group>
      ${players.map((player) => `
        <button type="button" class="player-choice-btn ${player.id === normalizedSelectedId ? 'selected' : ''}" data-player-choice="${player.id}" style="${getPlayerStyleAttr(state, player.id)}">
          ${renderPlayerRoleName(state, player)}${player.id === state.basileusId ? '<span class="current-basileus-tag">current</span>' : ''}
        </button>
      `).join('')}
      <input type="hidden"${inputIdAttr} class="appt-player-select" value="${normalizedSelectedId}">
    </div>`;
}

function selfAppointmentNotice(state, appointerId) {
  if (!selfAppointmentOnCooldown(state, appointerId)) return '';
  return `<div class="self-appoint-lockout" title="You appointed yourself last round.">
    <span class="self-appoint-lockout-icon">⊘</span>
    <span>You cannot appoint yourself this round (you self-appointed last round).</span>
  </div>`;
}

function getProvinceSummary(state, provinceId) {
  if (!provinceId) return null;
  const theme = state.themes[provinceId];
  if (!theme) return null;

  let ownerLabel = 'Free citizens';
  if (theme.occupied) ownerLabel = 'Occupied by invaders';
  else if (theme.owner === 'church') ownerLabel = 'Church estate';
  else if (theme.owner !== null) ownerLabel = `${renderPlayerRoleNameById(state, theme.owner, 'Unknown')} estate`;

  const strategos = theme.strategos !== null ? renderPlayerRoleNameById(state, theme.strategos, 'Unknown') : 'None';
  const bishop = theme.bishop !== null ? renderPlayerRoleNameById(state, theme.bishop, 'Unknown') : 'None';

  return {
    id: theme.id,
    name: theme.name,
    region: getRegionLabel(theme.region),
    ownerLabel,
    strategos,
    bishop,
    taxExempt: theme.taxExempt,
    occupied: theme.occupied,
    profit: theme.P,
    tax: theme.T,
    levies: theme.L,
    threatened: isThemeThreatened(state, theme.id),
    landPrice: getThemeLandPrice(theme),
    normalOwnerIncome: getNormalOwnerIncome(theme),
    normalTaxIncome: getNormalTaxIncome(theme),
    taxExemptIncome: getTaxExemptOwnerIncome(theme),
    strategosTaxIncome: theme.taxExempt || theme.owner === 'church' ? 0 : getNormalTaxIncome(theme),
    strategosLevyIncome: theme.owner === 'church' ? 0 : theme.L,
  };
}

function getSuggestedThemeId(themes, selectedProvinceId) {
  return themes.some(theme => theme.id === selectedProvinceId) ? selectedProvinceId : '';
}

function getOpenStrategosThemes(state, region = null) {
  return Object.values(state.themes).filter(theme =>
    !theme.occupied &&
    theme.id !== 'CPL' &&
    theme.owner !== 'church' &&
    theme.strategos === null &&
    (region == null || theme.region === region)
  );
}

function getOpenBishopThemes(state, region = null) {
  return Object.values(state.themes).filter(theme =>
    !theme.occupied &&
    theme.id !== 'CPL' &&
    !theme.bishopIsDonor &&
    theme.bishop === null &&
    (region == null || theme.region === region)
  );
}

function getOpenBasileusMinorTitleTypes(state) {
  const types = [];
  if (state.empress === null) types.push({ value: 'EMPRESS', label: 'Empress' });
  if (state.chiefEunuchs === null) types.push({ value: 'CHIEF_EUNUCHS', label: 'Chief of Eunuchs' });
  if (getOpenStrategosThemes(state).length > 0) types.push({ value: 'STRATEGOS', label: 'Strategos' });
  if (getOpenBishopThemes(state).length > 0) types.push({ value: 'BISHOP', label: 'Bishop' });
  return types;
}

function getTaxExemptionCandidates(state, playerId) {
  return getPlayerThemes(state, playerId).filter((theme) => canGrantTaxExemption(state, playerId, theme.id).ok);
}

function describeMajorTitleDistribution(state) {
  return [...MAJOR_TITLE_DISTRIBUTION[state.players.length]].sort((a, b) => b - a).join('-');
}

function getPhaseLabel(phase) {
  return {
    setup: 'Setup',
    invasion: 'Invasion',
    administration: 'Administration',
    court: 'Court',
    orders: 'Orders',
    resolution: 'Resolution',
    cleanup: 'Cleanup',
    scoring: 'Scoring',
  }[phase] || phase;
}

function isAiHistoryActor(aiMeta, actorId) {
  if (!aiMeta || actorId == null) return false;
  return !aiMeta.humanPlayerIds.has(actorId);
}

function renderDecisionFactors(decision) {
  if (!decision?.factors?.length) return '';

  return `
    <div class="history-decision">
      <div class="history-subhead">${decision.title || 'AI reasoning'}</div>
      <div class="history-factor-list">
        ${decision.factors.map((entry) => `
          <div class="history-factor ${entry.impact || 'neutral'}">
            <span class="history-factor-label">${entry.label}</span>
            ${entry.value != null ? `<span class="history-factor-value">${entry.value}</span>` : ''}
            <div class="history-factor-note">${entry.note}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderOfficeBreakdown(offices = []) {
  if (!offices.length) return '';
  return `
    <div class="history-subhead">Troop Assignments</div>
    <div class="history-breakdown-list">
      ${offices.map((office) => `
        <div class="history-breakdown-row">
          <span>${office.officeName}</span>
          <span>${office.totalTroops} to ${office.destination}</span>
        </div>
        <div class="history-breakdown-note">
          ${office.professionalTroops} pro, ${office.levyTroops} levy, ${office.mercenaryTroops} merc
        </div>
      `).join('')}
    </div>
  `;
}

function renderCoupContributionGroups(state, votes = [], contributions = []) {
  const candidateIds = [...new Set([
    ...votes.map(entry => entry.candidateId),
    ...contributions.map(entry => entry.candidateId),
  ])];

  if (!candidateIds.length) return '';

  const orderedCandidates = candidateIds
    .map(candidateId => ({
      candidateId,
      candidateName: renderPlayerRoleNameById(state, candidateId, `Player ${candidateId + 1}`),
      troops: votes.find(entry => entry.candidateId === candidateId)?.troops || 0,
    }))
    .sort((left, right) => right.troops - left.troops);

  return `
    <div class="history-breakdown-group">
      ${orderedCandidates.map((candidate) => {
        const supporters = contributions
          .filter(entry => entry.candidateId === candidate.candidateId)
          .sort((left, right) => right.troops - left.troops);

        return `
          <div class="history-breakdown-block">
            <div class="history-breakdown-head">
              <span>For ${candidate.candidateName}</span>
              <span>${candidate.troops} troops</span>
            </div>
            ${supporters.length ? supporters.map((supporter) => `
              <div class="history-breakdown-row">
                <span>${supporter.playerName}</span>
                <span>${supporter.troops}</span>
              </div>
            `).join('') : '<div class="history-breakdown-note">No player committed troops to this claimant.</div>'}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderWarContributionBreakdown(contributions = []) {
  if (!contributions.length) return '<div class="history-breakdown-note">No frontier troops were committed.</div>';
  return `
    <div class="history-breakdown-list">
      ${contributions
        .slice()
        .sort((left, right) => right.troops - left.troops)
        .map((entry) => `
          <div class="history-breakdown-row">
            <span>${entry.playerName}</span>
            <span>${entry.troops} frontier troops</span>
          </div>
        `).join('')}
    </div>
  `;
}

function renderTitleAssignments(assignments = {}) {
  const rows = Object.values(assignments);
  if (!rows.length) return '';
  return `
    <div class="history-breakdown-list">
      ${rows.map((entry) => `
        <div class="history-breakdown-row">
          <span>${entry.titleName}</span>
          <span>${entry.playerName}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderHistoryDetails(state, event) {
  if (!event.details) return '';

  if (event.type === 'administration') {
    return `
      <div class="history-subhead">Income</div>
      <div class="history-breakdown-list">
        ${event.details.income.map((entry) => `
          <div class="history-breakdown-row">
            <span>${entry.playerName}</span>
            <span>+${entry.amount}g</span>
          </div>
        `).join('')}
      </div>
      <div class="history-subhead">Levies</div>
      <div class="history-breakdown-list">
        ${event.details.levies.map((entry) => `
          <div class="history-breakdown-row">
            <span>${entry.officeName}</span>
            <span>${entry.amount}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  if (event.type === 'orders_revealed') {
    return `
      <div class="history-breakdown-list">
        <div class="history-breakdown-row">
          <span>Candidate</span>
          <span>${event.details.candidateName}</span>
        </div>
        <div class="history-breakdown-row">
          <span>Capital</span>
          <span>${event.details.capitalTroops} troops</span>
        </div>
        <div class="history-breakdown-row">
          <span>Frontier</span>
          <span>${event.details.frontierTroops} troops</span>
        </div>
      </div>
      ${renderOfficeBreakdown(event.details.offices)}
    `;
  }

  if (event.type === 'coup_result') {
    return renderCoupContributionGroups(state, event.details.votes, event.details.contributions);
  }

  if (event.type === 'war_result') {
    return `
      <div class="history-breakdown-list">
        <div class="history-breakdown-row">
          <span>Empire strength</span>
          <span>${event.details.frontierTroops}</span>
        </div>
        ${event.details.estimatedStrengthRange?.length === 2 ? `
          <div class="history-breakdown-row">
            <span>Estimated invader range</span>
            <span>${event.details.estimatedStrengthRange[0]}-${event.details.estimatedStrengthRange[1]}</span>
          </div>
        ` : ''}
        <div class="history-breakdown-row">
          <span>Invader strength</span>
          <span>${event.details.invaderStrength}</span>
        </div>
        ${event.details.themesLost?.length ? `
          <div class="history-breakdown-note province-note">Lost: ${renderProvinceBadgeList(state, event.details.themesLost)}</div>
        ` : ''}
        ${event.details.themesRecovered?.length ? `
          <div class="history-breakdown-note province-note">Recovered: ${renderProvinceBadgeList(state, event.details.themesRecovered)}</div>
        ` : ''}
      </div>
      ${renderWarContributionBreakdown(event.details.contributions)}
    `;
  }

  if (event.type === 'major_title_reassignment') {
    return renderTitleAssignments(event.details.assignments);
  }

  if (event.type === 'invasion_drawn') {
    return `<div class="history-breakdown-note province-note">Route: ${renderProvinceBadgeList(state, event.details.route)}</div>`;
  }

  return '';
}

function renderHistoryEntry(state, event, aiMeta) {
  const actorLabel = event.actorId != null ? renderPlayerRoleNameById(state, event.actorId, `Player ${event.actorId + 1}`) : 'Empire';
  const aiActor = event.actorAi === true || isAiHistoryActor(aiMeta, event.actorId);
  const extra = `${renderHistoryDetails(state, event)}${renderDecisionFactors(event.decision)}`;
  const badge = aiActor ? '<span class="history-entry-tag">AI</span>' : '';
  const meta = `
    <div class="history-entry-head">
      <span class="history-entry-round">R${event.round}</span>
      <span class="history-entry-phase">${getPhaseLabel(event.phase)}</span>
      <span class="history-entry-actor">${actorLabel}</span>
      ${badge}
    </div>
  `;

  if (!extra) {
    return `
      <div class="history-entry-card ${aiActor ? 'ai-entry' : ''}">
        ${meta}
        <div class="history-entry-summary">${event.summary}</div>
      </div>
    `;
  }

  return `
    <details class="history-entry-card history-entry-expandable ${aiActor ? 'ai-entry' : ''}">
      <summary>
        ${meta}
        <div class="history-entry-summary">${event.summary}</div>
      </summary>
      <div class="history-entry-detail">
        ${extra}
      </div>
    </details>
  `;
}

export function renderHistoryPanel(container, state, options = {}) {
  if (!container) return;

  const events = Array.isArray(state.history) ? [...state.history].reverse() : [];
  const isOpen = panelIsOpen(options.uiState, 'history', true);
  container.classList.toggle('panel-collapsed', !isOpen);
  container.innerHTML = `
    <div class="history-panel sidebar-panel${isOpen ? '' : ' is-collapsed'}">
      <button class="sidebar-panel-head history-panel-head" type="button" data-ui-panel-toggle="history" aria-expanded="${isOpen}">
        <span class="sidebar-panel-head-copy">
          <span class="sidebar-panel-kicker">Imperial Chronicle</span>
          <span class="sidebar-panel-title">History</span>
        </span>
        <span class="sidebar-panel-badge">${events.length} entries</span>
      </button>
      ${isOpen ? `
        <div class="sidebar-panel-body">
          ${events.length ? `
            <div class="history-panel-list">
              ${events.map((event) => renderHistoryEntry(state, event, options.aiMeta || null)).join('')}
            </div>
          ` : '<div class="history-panel-empty">The chronicle will fill as the game unfolds.</div>'}
        </div>
      ` : ''}
    </div>
  `;
}

// ─── Player Dashboard ───
export function renderPlayerDashboard(container, state, playerId, selectedProvinceId = null, options = {}) {
  const player = getPlayer(state, playerId);
  if (!player) return;

  const isBasileus = playerId === state.basileusId;
  const themes = getPlayerThemes(state, playerId);
  const selectedProvince = getProvinceSummary(state, selectedProvinceId);
  const titleEntries = getPlayerTitleEntries(state, playerId);
  const armyEntries = getPlayerArmyEntries(state, playerId);
  const finance = getProjectedFinance(state, playerId);
  const opinionRows = getPlayerOpinionRows(state, options.aiMeta || null, playerId);
  const isOpen = panelIsOpen(options.uiState, 'dashboard', true);
  const dashboardFocus = options.uiState?.dashboardFocus || null;

  container.classList.toggle('panel-collapsed', !isOpen);

  const financeSection = renderFoldSection(
    'dashboard:finance',
    'Finances',
    `
      <div class="finance-grid">
        <div class="finance-card">
          <span class="finance-label">Current gold</span>
          <strong>${player.gold}g</strong>
        </div>
        <div class="finance-card">
          <span class="finance-label">Next income</span>
          <strong>+${finance.projectedIncome}g</strong>
        </div>
        <div class="finance-card">
          <span class="finance-label">Army upkeep</span>
          <strong>-${finance.maintenance}g</strong>
        </div>
        <div class="finance-card">
          <span class="finance-label">Projected treasury</span>
          <strong>${finance.nextTreasury}g</strong>
        </div>
      </div>
      <div class="dashboard-list compact">
        <div class="dashboard-list-row">
          <span>Estate income</span>
          <span class="dashboard-list-value">+${finance.privateIncome}g</span>
        </div>
        <div class="dashboard-list-row">
          <span>Office and court income</span>
          <span class="dashboard-list-value">${finance.officeIncome >= 0 ? '+' : ''}${finance.officeIncome}g</span>
        </div>
        <div class="dashboard-list-row">
          <span>Projected levy pull next administration</span>
          <span class="dashboard-list-value">${finance.levyProjection}</span>
        </div>
      </div>
    `,
    options.uiState,
    {
      defaultOpen: true,
      badge: `${player.gold}g`,
      summary: 'Gold, upkeep, and next-round projections',
    }
  );

  const themeSection = renderFoldSection(
    'dashboard:themes',
    'Themes',
    themes.length ? `
      <div class="dashboard-list">
        ${themes.map((theme) => `
          <div class="dashboard-list-row">
            <div>
              <div class="dashboard-list-title">${renderProvinceBadge(state, theme, { showValues: true })}</div>
              <div class="dashboard-list-note">${theme.taxExempt ? 'tax-exempt | ' : ''}${isThemeThreatened(state, theme.id) ? 'threatened | ' : ''}profit ${getNormalOwnerIncome(theme)}g, tax ${getNormalTaxIncome(theme)}g, exempt ${getTaxExemptOwnerIncome(theme)}g</div>
            </div>
            <span class="dashboard-list-value">${getThemeLandPrice(theme)}g</span>
          </div>
        `).join('')}
      </div>
    ` : '<div class="dashboard-empty">No landed themes yet.</div>',
    options.uiState,
    {
      defaultOpen: dashboardFocus === 'themes',
      badge: `${themes.length}`,
      focused: dashboardFocus === 'themes',
      summary: 'Owned estates and their revenue',
    }
  );

  const armySection = renderFoldSection(
    'dashboard:army',
    'Army',
    armyEntries.length ? `
      <div class="dashboard-list">
        ${armyEntries.map((entry) => `
          <div class="dashboard-list-row">
            <div>
              <div class="dashboard-list-title">${entry.label}</div>
              <div class="dashboard-list-note">${entry.count} upkeep at cleanup</div>
            </div>
            <span class="dashboard-list-value">${entry.count}</span>
          </div>
        `).join('')}
      </div>
    ` : '<div class="dashboard-empty">No professional troops raised.</div>',
    options.uiState,
    {
      defaultOpen: dashboardFocus === 'army',
      badge: `${getTotalProfessionalArmy(player)}`,
      focused: dashboardFocus === 'army',
      summary: 'Professional troops by office',
    }
  );

  const titleSection = renderFoldSection(
    'dashboard:titles',
    'Titles',
    titleEntries.length ? `
      <div class="dashboard-list">
        ${titleEntries.map((entry) => `
          <div class="dashboard-list-row">
            <div>
              <div class="dashboard-list-title">${entry.label}</div>
              <div class="dashboard-list-note">${entry.detail}</div>
            </div>
            <span class="dashboard-tag">${entry.scope}</span>
          </div>
        `).join('')}
      </div>
    ` : '<div class="dashboard-empty">No offices or titles held.</div>',
    options.uiState,
    {
      defaultOpen: dashboardFocus === 'titles',
      badge: `${titleEntries.length}`,
      focused: dashboardFocus === 'titles',
      summary: 'Major offices, minor titles, and the throne',
    }
  );

  const provinceSection = selectedProvince ? renderFoldSection(
    'dashboard:province',
    'Selected Province',
    `
      <div class="dashboard-province">
        <div class="dashboard-province-head">
          ${renderProvinceBadge(state, selectedProvince.id, { showValues: true })}
        </div>
        <div class="dashboard-province-meta">price ${selectedProvince.landPrice}g${selectedProvince.taxExempt ? ' | tax-exempt' : ''}${selectedProvince.threatened ? ' | threatened' : ''}</div>
        <div class="dashboard-province-detail">Owner: ${selectedProvince.ownerLabel}</div>
        <div class="dashboard-province-detail">Normal split: owner profit ${selectedProvince.normalOwnerIncome}g, tax ${selectedProvince.normalTaxIncome}g</div>
        <div class="dashboard-province-detail">Tax-exempt income: ${selectedProvince.taxExemptIncome}g</div>
        <div class="dashboard-province-detail">Strategos: ${selectedProvince.strategos} (${selectedProvince.strategosTaxIncome}g tax + ${selectedProvince.strategosLevyIncome} ${selectedProvince.strategosLevyIncome === 1 ? 'levy' : 'levies'} from this theme only)</div>
        <div class="dashboard-province-detail">Bishop: ${selectedProvince.bishop}</div>
        <div class="dashboard-province-detail">Church gift: Church receives ${selectedProvince.tax}g tax; levy continues through the regional pool</div>
      </div>
    `,
    options.uiState,
    {
      defaultOpen: true,
      summary: selectedProvince.occupied ? 'Currently occupied by invaders' : 'Map selection details',
    }
  ) : '';

  const opinionsSection = opinionRows.length ? renderFoldSection(
    'dashboard:opinions',
    'AI Opinions',
    `
      <div class="dashboard-list">
        ${opinionRows.map((row) => `
          <div class="dashboard-opinion-row ${row.isHuman ? 'human-target' : ''}">
            <div>
              <div class="dashboard-list-title">${row.name}${row.isHuman ? ' (You)' : ''}</div>
              <div class="dashboard-list-note">Net ${formatSigned(row.net)} | trust ${row.trust} | grievance ${row.grievance}</div>
            </div>
            <div class="dashboard-opinion-meta">
              <span class="dashboard-tag ${row.descriptor}">${row.descriptor}</span>
              <span class="dashboard-opinion-debt">owes ${row.owesThem} / owed ${row.theyOwe}</span>
            </div>
          </div>
        `).join('')}
      </div>
    `,
    options.uiState,
    {
      defaultOpen: dashboardFocus === 'opinions',
      focused: dashboardFocus === 'opinions',
      summary: 'How this AI values each dynasty right now',
    }
  ) : '';

  container.innerHTML = `
    <div class="player-dashboard sidebar-panel${isOpen ? '' : ' is-collapsed'}" style="${getPlayerStyleAttr(state, player.id)}">
      <button class="sidebar-panel-head player-dashboard-head" type="button" data-ui-panel-toggle="dashboard" aria-expanded="${isOpen}">
        <span class="sidebar-panel-head-copy">
          <span class="sidebar-panel-kicker">Dynasty View</span>
          <span class="sidebar-panel-title">${renderPlayerRoleName(state, player)}</span>
          <span class="sidebar-panel-subtitle">${isBasileus ? 'Current Basileus' : (player.majorTitles.map((titleKey) => MAJOR_TITLES[titleKey]?.name || titleKey).join(', ') || 'Untitled dynasty')}</span>
        </span>
        <span class="sidebar-panel-badge">${player.gold}g | +${finance.projectedIncome} / -${finance.maintenance}</span>
      </button>
      ${isOpen ? `
        <div class="sidebar-panel-body">
          <!-- Dynasty crest, name, titles and gold are already shown by the
               panel head above; the body jumps straight into stats and
               drill-downs to avoid the chip-in-chip duplication. -->
          <div class="dashboard-stats">
            <button class="stat stat-button ${dashboardFocus === 'themes' ? 'active' : ''}" type="button" data-dashboard-focus="themes">
              <span class="stat-icon">LND</span>
              <span class="stat-label">Themes</span>
              <span class="stat-value">${themes.length}</span>
            </button>
            <button class="stat stat-button ${dashboardFocus === 'army' ? 'active' : ''}" type="button" data-dashboard-focus="army">
              <span class="stat-icon">ARM</span>
              <span class="stat-label">Army</span>
              <span class="stat-value">${getTotalProfessionalArmy(player)}</span>
            </button>
            <button class="stat stat-button ${dashboardFocus === 'titles' ? 'active' : ''}" type="button" data-dashboard-focus="titles">
              <span class="stat-icon">TTL</span>
              <span class="stat-label">Titles</span>
              <span class="stat-value">${titleEntries.length}</span>
            </button>
          </div>

          ${financeSection}
          ${themeSection}
          ${armySection}
          ${titleSection}
          ${provinceSection}
          ${opinionsSection}
        </div>
      ` : ''}
    </div>
  `;
  return;

}

// ─── Court Phase Panel ───
export function renderCourtPanel(container, state, activePlayerId, callbacks, options = {}) {
  const player = getPlayer(state, activePlayerId);
  const isBasileus = activePlayerId === state.basileusId;
  const selectedProvinceId = options.selectedProvinceId || null;
  const uiSectionState = options.uiState || null;

  const appointmentParts = [];
  if (isBasileus) {
    appointmentParts.push(renderBasileusAppointments(state, selectedProvinceId));
  }
  for (const titleKey of player.majorTitles) {
    if (titleKey === 'PATRIARCH') {
      appointmentParts.push(renderPatriarchAppointment(state, selectedProvinceId, activePlayerId));
    } else {
      appointmentParts.push(renderStrategosAppointment(state, titleKey, selectedProvinceId, activePlayerId));
    }
  }

  const availableThemes = getFreeThemes(state);
  const playerOwnedThemes = getPlayerThemes(state, activePlayerId);
  const taxExemptionThemes = getTaxExemptionCandidates(state, activePlayerId);
  const courtAlreadyConfirmed = state.courtActions?.playerConfirmed?.has(activePlayerId);

  let courtHtml = `<div class="court-panel">
    <div class="phase-header">
      <h3>Imperial Court</h3>
      <p class="phase-hint">Appointments, purchases, negotiations</p>
    </div>`;

  courtHtml += renderFoldSection(
    'court:appointments',
    'Appointments',
    appointmentParts.join('') || '<div class="dashboard-empty">This dynasty has no remaining appointments right now.</div>',
    uiSectionState,
    {
      defaultOpen: true,
      summary: 'Court and regional offices',
    }
  );

  if (availableThemes.length > 0) {
    courtHtml += renderFoldSection(
      'court:land',
      'Buy Land',
      `
        <div class="theme-market">
          ${availableThemes.map((theme) => {
            const cost = getThemeLandPrice(theme);
            const canAfford = player.gold >= cost;
            return `<button class="market-item ${canAfford ? '' : 'disabled'} ${selectedProvinceId === theme.id ? 'selected' : ''}"
              data-action="buy" data-theme="${theme.id}" ${canAfford ? '' : 'disabled'}>
              <span class="market-name">${renderProvinceBadge(state, theme, { showValues: true })}</span>
              <span class="market-cost">${cost}g</span>
            </button>`;
          }).join('')}
        </div>
      `,
      uiSectionState,
      {
        defaultOpen: false,
        summary: 'Acquire private estates',
      }
    );
  }

  if (taxExemptionThemes.length > 0) {
    courtHtml += renderFoldSection(
      'court:exemptions',
      'Buy Tax Exemption',
      `
        <div class="gift-options">
          ${taxExemptionThemes.map((theme) => {
            const check = canGrantTaxExemption(state, activePlayerId, theme.id);
            return `<button class="gift-item ${selectedProvinceId === theme.id ? 'selected' : ''}" data-action="exempt" data-theme="${theme.id}">
              ${renderProvinceBadge(state, theme, { showValues: true })} for ${check.cost}g -> ${getTaxExemptOwnerIncome(theme)}g income
            </button>`;
          }).join('')}
        </div>
      `,
      uiSectionState,
      {
        defaultOpen: false,
        summary: 'Pay 2 x T to keep provincial tax',
      }
    );
  }

  if (playerOwnedThemes.length > 0) {
    courtHtml += renderFoldSection(
      'court:church',
      'Gift To Church',
      `
        <div class="gift-options">
          ${playerOwnedThemes.map((theme) => `
            <button class="gift-item ${selectedProvinceId === theme.id ? 'selected' : ''}" data-action="gift" data-theme="${theme.id}">
              ${renderProvinceBadge(state, theme, { showValues: true })} to Church -> ${getNormalTaxIncome(theme)}g church tax
            </button>
          `).join('')}
        </div>
      `,
      uiSectionState,
      {
        defaultOpen: false,
        summary: 'Convert private land into church leverage',
      }
    );
  }

  if (isBasileus) {
    courtHtml += renderRevocationOptions(state);
  }

  courtHtml += renderFoldSection(
    'court:army',
    'Professional Army',
    renderArmyManagement(state, activePlayerId),
    uiSectionState,
    {
      defaultOpen: true,
      summary: 'Recruit +1 per office, dismiss any number',
    }
  );

  courtHtml += `<div class="court-actions">
    <button class="btn-confirm ${courtAlreadyConfirmed ? 'disabled' : ''}" data-action="confirm-court" ${courtAlreadyConfirmed ? 'disabled' : ''}>
      ${courtAlreadyConfirmed ? 'Confirmed' : 'Confirm Actions'}
    </button>
  </div>`;

  courtHtml += `</div>`;
  container.innerHTML = courtHtml;

  bindCourtEvents(container, state, activePlayerId, callbacks, selectedProvinceId);
  return;

}


function bindThemeChoiceControls(root) {
  root.querySelectorAll('[data-theme-choice]').forEach((button) => {
    if (button.dataset.bound === 'true') return;
    button.dataset.bound = 'true';
    button.addEventListener('click', () => {
      const group = button.closest('[data-theme-choice-group]');
      const input = group?.querySelector('.appt-theme-select');
      if (!input) return;
      group.querySelectorAll('[data-theme-choice]').forEach((other) => other.classList.remove('selected'));
      button.classList.add('selected');
      input.value = button.dataset.themeChoice;
    });
  });
}

function bindCourtEvents(container, state, activePlayerId, callbacks, selectedProvinceId) {
  container.querySelectorAll('[data-player-choice]').forEach((button) => {
    button.addEventListener('click', () => {
      const group = button.closest('[data-player-choice-group]');
      const input = group?.querySelector('.appt-player-select');
      if (!input) return;
      group.querySelectorAll('[data-player-choice]').forEach((other) => other.classList.remove('selected'));
      button.classList.add('selected');
      input.value = button.dataset.playerChoice;
    });
  });

  bindThemeChoiceControls(container);

  // Buy land
  container.querySelectorAll('[data-action="buy"]').forEach(btn => {
    btn.addEventListener('click', () => {
      callbacks.buy?.(btn.dataset.theme);
    });
  });

  // Gift to church
  container.querySelectorAll('[data-action="gift"]').forEach(btn => {
    btn.addEventListener('click', () => {
      callbacks.gift?.(btn.dataset.theme);
    });
  });

  container.querySelectorAll('[data-action="exempt"]').forEach(btn => {
    btn.addEventListener('click', () => {
      callbacks.exempt?.(btn.dataset.theme);
    });
  });

  // Confirm court
  container.querySelectorAll('[data-action="confirm-court"]').forEach(btn => {
    btn.addEventListener('click', () => {
      callbacks['confirm-court']?.();
    });
  });

  // Recruit professional troops
  container.querySelectorAll('[data-action="recruit"]').forEach(btn => {
    btn.addEventListener('click', () => {
      callbacks.recruit?.(null, btn.dataset);
    });
  });

  container.querySelectorAll('[data-action="dismiss"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const block = btn.closest('.army-row');
      const countInput = block?.querySelector('.army-dismiss-count');
      const count = countInput ? parseInt(countInput.value, 10) : 0;
      callbacks.dismiss?.(null, { office: btn.dataset.office, count });
    });
  });

  const basileusTypeSelect = container.querySelector('#basileusApptType');
  const basileusThemeChoiceGroup = container.querySelector('#basileusApptThemeChoices');
  const basileusThemeButtons = basileusThemeChoiceGroup?.querySelector('[data-role="theme-choice-buttons"]');
  const basileusThemeSelect = container.querySelector('#basileusApptTheme');
  if (basileusTypeSelect && basileusThemeChoiceGroup && basileusThemeButtons && basileusThemeSelect) {
    const refreshThemeOptions = () => {
      const appointmentType = basileusTypeSelect.value;
      const themes = appointmentType === 'STRATEGOS'
        ? getOpenStrategosThemes(state)
        : appointmentType === 'BISHOP'
          ? getOpenBishopThemes(state)
          : [];
      const suggestedThemeId = getSuggestedThemeId(themes, selectedProvinceId);

      basileusThemeButtons.innerHTML = renderThemeChoiceButtons(state, themes, suggestedThemeId);
      basileusThemeSelect.value = suggestedThemeId || '';
      basileusThemeChoiceGroup.style.display = (appointmentType === 'STRATEGOS' || appointmentType === 'BISHOP') ? '' : 'none';
      bindThemeChoiceControls(basileusThemeChoiceGroup);
    };

    basileusTypeSelect.addEventListener('change', refreshThemeOptions);
    refreshThemeOptions();
  }

  // Basileus appointment (1 minor title): commit button
  container.querySelectorAll('[data-action="commit-basileus-appt"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const typeSelect = container.querySelector('#basileusApptType');
      const playerSelect = container.querySelector('#basileusApptPlayer');
      const themeSelect = container.querySelector('#basileusApptTheme');
      if (!typeSelect) return;
      const apptType = typeSelect.value;
      const appointeeId = playerSelect ? parseInt(playerSelect.value) : activePlayerId;
      const themeId = themeSelect ? themeSelect.value : null;
      callbacks['basileus-appoint']?.(apptType, appointeeId, themeId);
    });
  });

  // Strategos appointment
  container.querySelectorAll('.strategos-commit').forEach(btn => {
    btn.addEventListener('click', () => {
      const block = btn.closest('.appointment-block');
      const themeSelect = block.querySelector('.appt-theme-select');
      const playerSelect = block.querySelector('.appt-player-select');
      const titleKey = btn.dataset.titlekey;
      if (themeSelect?.value && playerSelect?.value) {
        callbacks['appoint-strategos']?.(titleKey, themeSelect.value, parseInt(playerSelect.value));
      }
    });
  });

  // Bishop appointment
  container.querySelectorAll('.bishop-commit').forEach(btn => {
    btn.addEventListener('click', () => {
      const block = btn.closest('.appointment-block');
      const themeSelect = block.querySelector('.appt-theme-select');
      const playerSelect = block.querySelector('.appt-player-select');
      if (themeSelect?.value && playerSelect?.value) {
        callbacks['appoint-bishop']?.(themeSelect.value, parseInt(playerSelect.value));
      }
    });
  });

  // Revocation choice grid: clicking a cartouche stages the value on the
  // hidden input, and the commit button submits it.
  container.querySelectorAll('[data-revocation-group] .revocation-choice-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = btn.closest('[data-revocation-group]');
      if (!group) return;
      group.querySelectorAll('.revocation-choice-btn.selected').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      const hidden = group.querySelector('.revoke-select');
      if (hidden) hidden.value = btn.dataset.revokeValue || '';
    });
  });
  container.querySelectorAll('[data-action="commit-revoke"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const hidden = container.querySelector('.revoke-select');
      if (hidden?.value) {
        callbacks.revoke?.(hidden.value);
      }
    });
  });
}

// ─── Basileus appointment: can appoint ANY minor title to ANY player ───
function renderBasileusAppointments(state, selectedProvinceId) {
  const already = state.courtActions?.basileusAppointed;
  if (already) {
    return `<div class="appointment-block done">
      <span class="appt-label">✓ Basileus appointment made this round</span>
    </div>`;
  }

  const titleTypes = getOpenBasileusMinorTitleTypes(state);
  if (!titleTypes.length) {
    return `<div class="appointment-block done">
      <span class="appt-label">✓ No eligible Basileus appointments remain</span>
    </div>`;
  }

  const selectableThemes = [...getOpenStrategosThemes(state), ...getOpenBishopThemes(state)];
  const defaultThemeId = getSuggestedThemeId(selectableThemes, selectedProvinceId);
  const appointerId = state.basileusId;
  const onCooldown = selfAppointmentOnCooldown(state, appointerId);

  return `<div class="appointment-block${onCooldown ? ' has-self-lockout' : ''}">
    <span class="appt-label">Basileus appoints 1 minor title:</span>
    ${selfAppointmentNotice(state, appointerId)}
    <div class="appt-form">
      <select id="basileusApptType" class="appt-select">
        <option value="">Choose title type...</option>
        ${titleTypes.map((type) => `<option value="${type.value}">${type.label}</option>`).join('')}
      </select>
      ${renderPlayerChoiceControl(state, 'basileusApptPlayer', undefined, { excludeId: onCooldown ? appointerId : undefined })}
      <div id="basileusApptThemeChoices" class="province-choice-grid" data-theme-choice-group style="display:none">
        <div data-role="theme-choice-buttons"></div>
        <input type="hidden" id="basileusApptTheme" class="appt-theme-select" value="${defaultThemeId}">
      </div>
      <button class="appt-btn" data-action="commit-basileus-appt">Appoint</button>
    </div>
  </div>`;
}

// ─── Strategos appointment: Domestic/Admiral picks theme + player ───
function renderStrategosAppointment(state, titleKey, selectedProvinceId, appointerId) {
  const title = MAJOR_TITLES[titleKey];
  if (!title) return '';
  const region = title.region;
  const themes = getOpenStrategosThemes(state, region);
  const defaultThemeId = getSuggestedThemeId(themes, selectedProvinceId);

  const already = state.courtActions?.[`${titleKey}_appointed`];
  if (already) {
    return `<div class="appointment-block done">
      <span class="appt-label">✓ ${title.name} — Strategos appointed</span>
    </div>`;
  }

  if (!themes.length) {
    return `<div class="appointment-block done">
      <span class="appt-label">No unappointed Strategos slots remain for ${title.name}</span>
    </div>`;
  }

  const onCooldown = selfAppointmentOnCooldown(state, appointerId);

  return `<div class="appointment-block${onCooldown ? ' has-self-lockout' : ''}">
    <span class="appt-label">${title.name} → appoint Strategos:</span>
    ${selfAppointmentNotice(state, appointerId)}
    <div class="appt-form">
      ${renderThemeChoiceControl(state, themes, null, defaultThemeId)}
      ${renderPlayerChoiceControl(state, null, undefined, { excludeId: onCooldown ? appointerId : undefined })}
      <button class="appt-btn strategos-commit" data-titlekey="${titleKey}">Appoint</button>
    </div>
  </div>`;
}

// ─── Patriarch appointment: picks theme + player for Bishop ───
function renderPatriarchAppointment(state, selectedProvinceId, appointerId) {
  const themes = getOpenBishopThemes(state);
  const defaultThemeId = getSuggestedThemeId(themes, selectedProvinceId);

  const already = state.courtActions?.patriarchAppointed;
  if (already) {
    return `<div class="appointment-block done">
      <span class="appt-label">✓ Patriarch — Bishop appointed</span>
    </div>`;
  }

  if (!themes.length) {
    return `<div class="appointment-block done">
      <span class="appt-label">No unappointed Bishop slots remain for the Patriarch</span>
    </div>`;
  }

  const onCooldown = selfAppointmentOnCooldown(state, appointerId);

  return `<div class="appointment-block${onCooldown ? ' has-self-lockout' : ''}">
    <span class="appt-label">Patriarch → appoint Bishop:</span>
    ${selfAppointmentNotice(state, appointerId)}
    <div class="appt-form">
      ${renderThemeChoiceControl(state, themes, null, defaultThemeId)}
      ${renderPlayerChoiceControl(state, null, undefined, { excludeId: onCooldown ? appointerId : undefined })}
      <button class="appt-btn bishop-commit">Appoint</button>
    </div>
  </div>`;
}

// ─── Revocation: cartouche grid (same grammar as appointment) ───
function renderRevocationOptions(state) {
  const groups = collectRevocationGroups(state);

  const used = state.courtActions?.basileusRevocationsUsed || 0;
  const nextCost = used + 1;
  const available = getBasileusAvailableTroopCount(state);
  const canAfford = available >= nextCost;
  const costLine = used === 0
    ? `Each revocation costs troops: 1 for the first, 2 for the second, 3 for the third, and so on. Levies are spent before professional troops; professional troops return next round.`
    : `${used} revocation${used === 1 ? '' : 's'} used so far this round.`;
  const costStatus = canAfford
    ? `Next revocation costs <strong>${nextCost}</strong> troop${nextCost === 1 ? '' : 's'} (Basileus has ${available}).`
    : `Next revocation would cost ${nextCost} troop${nextCost === 1 ? '' : 's'}, but the Basileus only has ${available}. <em>Cannot revoke further this round.</em>`;

  const totalItems = groups.reduce((sum, g) => sum + g.items.length, 0);
  const body = totalItems
    ? groups.filter((g) => g.items.length).map((group) => `
        <div class="revocation-group">
          <div class="revocation-group-label">${group.label}</div>
          <div class="revocation-choice-grid">
            ${group.items.map((item) => `
              <button type="button" class="revocation-choice-btn" data-revoke-value="${item.value}" ${canAfford ? '' : 'disabled'}>
                ${item.body}
              </button>
            `).join('')}
          </div>
        </div>
      `).join('')
    : '<p class="section-hint">Nothing currently revocable.</p>';

  return `<div class="court-section revocation">
    <h4>Imperial Revocation</h4>
    <p class="section-hint">${costLine}</p>
    <p class="section-hint revocation-cost">${costStatus}</p>
    <div class="revocation-shell" data-revocation-group>
      ${body}
      <input type="hidden" class="revoke-select" value="">
    </div>
    <button class="appt-btn" data-action="commit-revoke" style="margin-top:6px" ${canAfford && totalItems ? '' : 'disabled'}>Revoke (${nextCost} troop${nextCost === 1 ? '' : 's'})</button>
  </div>`;
}

// Build the cartouche rows for each revocable category. The button body
// is the visual signature ("what gets revoked"); the value is the same
// colon-encoded token the existing event handler already understands.
function collectRevocationGroups(state) {
  const major = [];
  for (const player of state.players) {
    if (player.id === state.basileusId) continue;
    for (const titleKey of player.majorTitles) {
      major.push({
        value: `major:${player.id}:${titleKey}`,
        body: renderTitleBadge(state, titleKey, { holderId: player.id, compact: true }),
      });
    }
  }

  const minor = [];
  for (const t of Object.values(state.themes)) {
    if (t.occupied) continue;
    if (t.strategos !== null) {
      minor.push({
        value: `minor:${t.id}:strategos`,
        body: renderThemeOfficeBadge(state, 'STRATEGOS', t.id),
      });
    }
    if (t.bishop !== null) {
      minor.push({
        value: `minor:${t.id}:bishop`,
        body: renderThemeOfficeBadge(state, 'BISHOP', t.id),
      });
    }
  }
  if (state.empress !== null) {
    minor.push({
      value: 'court:EMPRESS',
      body: renderTitleBadge(state, 'EMPRESS', { holderId: state.empress, compact: true }),
    });
  }
  if (state.chiefEunuchs !== null) {
    minor.push({
      value: 'court:CHIEF_EUNUCHS',
      body: renderTitleBadge(state, 'CHIEF_EUNUCHS', { holderId: state.chiefEunuchs, compact: true }),
    });
  }

  const exempt = Object.values(state.themes)
    .filter((t) => t.taxExempt)
    .map((t) => ({
      value: `exempt:${t.id}`,
      body: renderProvinceBadge(state, t, { compact: true }),
    }));

  const estates = Object.values(state.themes)
    .filter((t) => t.owner !== null && t.owner !== 'church' && !t.occupied)
    .map((t) => ({
      value: `theme:${t.id}`,
      body: renderProvinceBadge(state, t, { compact: true }),
    }));

  return [
    { label: 'Major Titles', items: major },
    { label: 'Minor Titles', items: minor },
    { label: 'Tax Exemptions', items: exempt },
    { label: 'Estates', items: estates },
  ];
}

function getBasileusAvailableTroopCount(state) {
  const basileusId = state.basileusId;
  const basileus = state.players?.find(p => p.id === basileusId);
  if (!basileus) return 0;
  const officeKeys = new Set(['BASILEUS']);
  if (state.empress === basileusId) officeKeys.add('EMPRESS');
  if (state.chiefEunuchs === basileusId) officeKeys.add('CHIEF_EUNUCHS');
  for (const titleKey of basileus.majorTitles || []) officeKeys.add(titleKey);
  let total = 0;
  for (const key of officeKeys) {
    total += state.currentLevies?.[key] || 0;
    total += basileus.professionalArmies?.[key] || 0;
  }
  return total;
}

// ─── Army Management with recruitment limit ───
function renderArmyManagement(state, playerId) {
  const player = getPlayer(state, playerId);
  const offices = getPlayerOffices(state, playerId);
  return `
    <p class="section-hint">Recruit +1 per office per round. Troops stay raised between rounds; dismiss any number now to reduce upkeep.</p>
    <div class="army-grid">
      ${offices.map((office) => {
        const count = player.professionalArmies[office.key] || 0;
        const recruitCheck = canRecruitProfessional(state, playerId, office.key);
        const canRecruit = recruitCheck.ok;
        const recruitLabel = canRecruit ? '+1 recruit' : (recruitCheck.reason?.includes('cannot hold') ? 'No professionals' : 'recruited');
        return `<div class="army-row">
          <div class="army-office">
            <span>${office.label}</span>
            <span class="army-count">${count} troops</span>
          </div>
          <div class="army-controls">
            <button class="btn-recruit ${canRecruit ? '' : 'disabled'}" data-action="recruit" data-office="${office.key}" ${canRecruit ? '' : 'disabled'}>
              ${recruitLabel}
            </button>
            <div class="army-dismiss">
              <input class="army-dismiss-count" type="number" min="1" max="${Math.max(1, count)}" value="${count > 0 ? 1 : 0}" ${count > 0 ? '' : 'disabled'}>
              <button class="btn-dismiss ${count > 0 ? '' : 'disabled'}" data-action="dismiss" data-office="${office.key}" ${count > 0 ? '' : 'disabled'}>
                Dismiss
              </button>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>
  `;
}

// ─── Orders Phase Panel (Secret, per-player) ───
export function renderOrdersPanel(container, state, playerId, callbacks) {
  const player = getPlayer(state, playerId);
  const offices = getPlayerOffices(state, playerId);

  // Check if this player already locked orders
  const alreadyLocked = state.allOrders?.[playerId] != null;

  let html = `<div class="orders-panel">
    <div class="phase-header">
      <h3>Secret Orders</h3>
      <p class="phase-hint">${alreadyLocked ? 'Orders locked. Waiting for other players...' : 'Deploy troops, hire mercenaries, name your candidate'}</p>
    </div>`;

  if (alreadyLocked) {
    html += `<div class="orders-section"><p class="section-hint">✓ Your orders are sealed.</p></div></div>`;
    container.innerHTML = html;
    return;
  }

  // ── Troop Deployment ──
  html += `<div class="orders-section">
    <h4>Deploy Troops</h4>
    <p class="section-hint">Each office sends ALL its troops to Capital or Frontier</p>
    <div class="deploy-grid">`;

  for (const office of offices) {
    const proCount = player.professionalArmies[office.key] || 0;
    const levyCount = state.currentLevies?.[office.key] || 0;
    const total = proCount + levyCount;
    const capitalLocked = office.capitalLocked || isCapitalLockedOfficeKey(office.key);

    if (capitalLocked) {
      html += `
        <div class="deploy-row deploy-row-locked">
          <span class="office-name">${office.label}</span>
          <span class="troop-count">${total} troops</span>
          <div class="deploy-toggle deploy-toggle-locked" data-office="${office.key}" data-locked="capital">
            <button class="toggle-btn active" data-dest="capital" disabled>👑 Capital (locked)</button>
          </div>
        </div>`;
    } else {
      html += `
        <div class="deploy-row">
          <span class="office-name">${office.label}</span>
          <span class="troop-count">${total} troops</span>
          <div class="deploy-toggle" data-office="${office.key}">
            <button class="toggle-btn active" data-dest="frontier">⚔ Frontier</button>
            <button class="toggle-btn" data-dest="capital">👑 Capital</button>
          </div>
        </div>`;
    }
  }

  html += `</div></div>`;

  // ── Hire Mercenaries ──
  const mercOffices = offices.filter(o => !(o.capitalLocked || isCapitalLockedOfficeKey(o.key)));
  html += `<div class="orders-section">
    <h4>Hire Mercenaries</h4>
    <p class="section-hint">Costs reset every round: 1g for the first mercenary, 2g for the second, 3g for the third, and so on.</p>
    <div class="merc-hiring">
      ${mercOffices.map(o => `
        <div class="merc-row">
          <span>${o.label}</span>
          <div class="merc-controls">
            <button class="merc-btn" data-action="merc-dec" data-office="${o.key}">−</button>
            <span class="merc-count" data-office="${o.key}">0</span>
            <button class="merc-btn" data-action="merc-inc" data-office="${o.key}">+</button>
          </div>
        </div>
      `).join('')}
      <div class="merc-total">Total cost: <span id="mercTotalCost">0</span>⬡ (you have ${player.gold}⬡)</div>
    </div>
  </div>`;

  // ── Coup Vote ──
  html += `<div class="orders-section">
    <h4>Name Your Candidate</h4>
    <p class="section-hint">Who should be the next Basileus?</p>
    <div class="candidate-grid">
      ${state.players.map(p => `
        <button class="candidate-btn ${p.id === state.basileusId ? 'current-bas' : ''}" data-candidate="${p.id}" style="${getPlayerStyleAttr(state, p.id)}">
          <span class="candidate-crest" style="background: ${p.color}">${p.dynasty.charAt(0)}</span>
          <span>${renderPlayerRoleName(state, p)}</span>
          ${p.id === state.basileusId ? '<span class="current-basileus-tag">current</span>' : ''}
        </button>
      `).join('')}
    </div>
  </div>`;

  // ── Lock Orders ──
  html += `<div class="orders-actions">
    <button class="btn-lock-orders" data-action="lock-orders">🔒 Lock Orders</button>
  </div>`;

  html += `</div>`;
  container.innerHTML = html;

  // ── Bind events ──
  // Deploy toggles
  container.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.deploy-toggle');
      row.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Candidate buttons
  container.querySelectorAll('.candidate-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.candidate-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  // Merc buttons
  container.querySelectorAll('.merc-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const office = btn.dataset.office;
      const countEl = container.querySelector(`.merc-count[data-office="${office}"]`);
      let val = parseInt(countEl.textContent) || 0;
      if (btn.dataset.action === 'merc-inc') val++;
      if (btn.dataset.action === 'merc-dec' && val > 0) val--;
      countEl.textContent = val;
      updateMercTotal(container, player.gold);
    });
  });

  updateMercTotal(container, player.gold);

  // Lock orders
  container.querySelector('[data-action="lock-orders"]')?.addEventListener('click', () => {
    const orders = collectOrders(container, offices, playerId);
    callbacks.lockOrders?.(orders);
  });
}

function collectOrders(container, offices, playerId) {
  const deployments = {};
  container.querySelectorAll('.deploy-toggle').forEach(row => {
    const officeKey = row.dataset.office;
    const active = row.querySelector('.toggle-btn.active');
    deployments[officeKey] = active?.dataset.dest || 'frontier';
  });

  const mercenaries = [];
  container.querySelectorAll('.merc-count').forEach(el => {
    const count = parseInt(el.textContent) || 0;
    if (count > 0) {
      mercenaries.push({ officeKey: el.dataset.office, count });
    }
  });

  const candidateBtn = container.querySelector('.candidate-btn.selected');
  // Default to self if no candidate selected
  const candidate = candidateBtn ? parseInt(candidateBtn.dataset.candidate) : playerId;

  return { deployments, mercenaries, candidate };
}

function updateMercTotal(container, gold) {
  const mercenaries = [];
  container.querySelectorAll('.merc-count').forEach(el => {
    const count = parseInt(el.textContent) || 0;
    if (count > 0) mercenaries.push({ count });
  });
  const total = getMercenaryOrderCost(mercenaries);
  const costEl = container.querySelector('#mercTotalCost');
  if (costEl) {
    costEl.textContent = total;
    costEl.classList.toggle('over-budget', total > gold);
  }

  const lockButton = container.querySelector('[data-action="lock-orders"]');
  if (lockButton) {
    lockButton.disabled = total > gold;
  }
}

function renderMajorTitleReassignmentSection(state) {
  const newBasileusId = state.nextBasileusId;
  const newBasileus = getPlayer(state, newBasileusId);
  const assignments = suggestMajorTitleAssignments(state, newBasileusId);
  const eligiblePlayers = state.players.filter(player => player.id !== newBasileusId);

  return `<div class="resolution-section title-reassignment">
    <h4>Redistribute Major Titles</h4>
    <p class="section-hint">${newBasileus ? renderPlayerRoleName(state, newBasileus) : 'The new Basileus'} must reassign all four major offices before the next round. The non-Basileus title distribution must be ${describeMajorTitleDistribution(state)}.</p>
    <div class="title-reassignment-grid">
      ${Object.entries(MAJOR_TITLES).map(([titleKey, title]) => `
        <label class="title-reassignment-row">
          <span>${title.name}</span>
          <select class="appt-select major-title-select" data-title-assignment="${titleKey}">
            ${eligiblePlayers.map(player => `
              <option value="${player.id}" ${assignments[titleKey] === player.id ? 'selected' : ''} style="background-color: ${player.color}; color: #fff;">${formatPlayerLabel(player)}</option>
            `).join('')}
          </select>
        </label>
      `).join('')}
    </div>
    <div class="resolution-error" data-role="title-reassignment-error"></div>
  </div>`;
}

// ─── Resolution Summary Panel ───
export function renderResolutionPanel(container, state, options = {}) {
  const coup = state.lastCoupResult;
  const war = state.lastWarResult;

  let html = `<div class="resolution-panel">
    <div class="phase-header">
      <h3>Resolution</h3>
    </div>`;

  // Coup result
  if (coup) {
    const winner = getPlayer(state, coup.winner);
    html += `<div class="resolution-section">
      <h4>Coup</h4>
      <div class="coup-result">
        <span class="coup-winner">
          ${renderPlayerRoleName(state, winner)} ${coup.winner !== state.basileusId ? 'seizes the throne!' : 'remains Basileus.'}
        </span>
        <div class="vote-breakdown">
          ${renderCoupContributionGroups(
            state,
            Object.entries(coup.votes).map(([candidateId, troops]) => ({
              candidateId: Number(candidateId),
              candidateName: renderPlayerRoleNameById(state, Number(candidateId), `Player ${Number(candidateId) + 1}`),
              troops,
            })),
            (coup.contributions || []).map((entry) => ({
              ...entry,
              playerName: renderPlayerRoleNameById(state, entry.playerId, `Player ${entry.playerId + 1}`),
              candidateName: renderPlayerRoleNameById(state, entry.candidateId, `Player ${entry.candidateId + 1}`),
            }))
          )}
        </div>
      </div>
    </div>`;
  }

  // War result
  if (war) {
    const inv = state.currentInvasion;
    html += `<div class="resolution-section">
      <h4>⚔ ${inv?.name || 'Invasion'}</h4>
      <div class="war-result ${war.outcome}">
        <div class="war-numbers">
          <span class="empire-force">Empire: ${war.frontierTroops}</span>
          <span class="vs">vs</span>
          <span class="invader-force">Invader: ${war.invaderStrength}</span>
        </div>
        ${inv?.strength?.length === 2 ? `<div class="war-estimate">Estimate: ${inv.strength[0]}-${inv.strength[1]}</div>` : ''}
        <div class="war-outcome">${
          war.outcome === 'victory' ? 'Victory. Reconquered: ' + renderProvinceBadgeList(state, war.themesRecovered) :
          war.outcome === 'defeat' ? 'Defeat. Lost: ' + renderProvinceBadgeList(state, war.themesLost) :
          '⚖ Stalemate'
        }</div>
        ${war.reachedCPL ? '<div class="empire-falls">☠ CONSTANTINOPLE HAS FALLEN</div>' : ''}
      </div>
    </div>`;
  }

  if (options.allowManualTitleReassignment !== false && state.nextBasileusId !== null && state.nextBasileusId !== state.basileusId) {
    html += renderMajorTitleReassignmentSection(state);
  }

  html += `<div class="resolution-actions">
    <button class="btn-continue" data-action="continue">Continue</button>
  </div></div>`;

  container.innerHTML = html;
}

export function renderResolutionPanelDetailed(container, state, options = {}) {
  const coup = state.lastCoupResult;
  const war = state.lastWarResult;

  let html = `<div class="resolution-panel">
    <div class="phase-header">
      <h3>Resolution</h3>
    </div>`;

  if (coup) {
    const winner = getPlayer(state, coup.winner);
    const voteRows = Object.entries(coup.votes).map(([candidateId, troops]) => ({
      candidateId: Number(candidateId),
      candidateName: renderPlayerRoleNameById(state, Number(candidateId), `Player ${Number(candidateId) + 1}`),
      troops,
    }));
    const contributionRows = (coup.contributions || []).map((entry) => ({
      ...entry,
      playerName: renderPlayerRoleNameById(state, entry.playerId, `Player ${entry.playerId + 1}`),
      candidateName: renderPlayerRoleNameById(state, entry.candidateId, `Player ${entry.candidateId + 1}`),
    }));

    html += `<div class="resolution-section">
      <h4>Coup</h4>
      <div class="coup-result">
        <span class="coup-winner">
          ${renderPlayerRoleName(state, winner)} ${coup.winner !== state.basileusId ? 'seizes the throne!' : 'remains Basileus.'}
        </span>
        <div class="vote-breakdown">
          ${renderCoupContributionGroups(state, voteRows, contributionRows)}
        </div>
      </div>
    </div>`;
  }

  if (war) {
    const invasionName = state.currentInvasion?.name || 'Invasion';
    const outcomeText = war.outcome === 'victory'
      ? `Victory. Reconquered: ${renderProvinceBadgeList(state, war.themesRecovered)}`
      : war.outcome === 'defeat'
        ? `Defeat. Lost: ${renderProvinceBadgeList(state, war.themesLost)}`
        : 'Stalemate';

    html += `<div class="resolution-section">
      <h4>${invasionName}</h4>
      <div class="war-result ${war.outcome}">
        <div class="war-numbers">
          <span class="empire-force">Empire: ${war.frontierTroops}</span>
          <span class="vs">vs</span>
          <span class="invader-force">Invader: ${war.invaderStrength}</span>
        </div>
        ${state.currentInvasion?.strength?.length === 2 ? `<div class="war-estimate">Estimate: ${state.currentInvasion.strength[0]}-${state.currentInvasion.strength[1]}</div>` : ''}
        <div class="war-outcome">${outcomeText}</div>
        <div class="vote-breakdown">
          ${renderWarContributionBreakdown(war.contributions || [])}
        </div>
        ${war.reachedCPL ? '<div class="empire-falls">CONSTANTINOPLE HAS FALLEN</div>' : ''}
      </div>
    </div>`;
  }

  if (options.allowManualTitleReassignment !== false && state.nextBasileusId !== null && state.nextBasileusId !== state.basileusId) {
    html += renderMajorTitleReassignmentSection(state);
  }

  html += `<div class="resolution-actions">
    <button class="btn-continue" data-action="continue">Continue</button>
  </div></div>`;

  container.innerHTML = html;
}
