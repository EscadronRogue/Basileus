import {
  DEFAULT_BATCH_CONFIG,
  normalizeBatchConfig,
} from './engine.js';
import {
  DEFAULT_TRAINING_CONFIG,
  estimateTrainingMatches,
  FITNESS_PROFILES,
  FITNESS_TUNING_FIELDS,
  normalizeTrainingConfig,
} from './evolution.js';
import {
  DEFAULT_MIXED_DECK_SIZES,
  SUPPORTED_PLAYER_COUNTS,
} from './constants.js';
import {
  deleteSavedAiProfile,
  formatProfileSnapshot,
  listAvailableAiProfiles,
  listSavedAiProfiles,
  saveAiProfiles,
} from '../ai/profileStore.js';

const state = {
  worker: null,
  simulationResult: null,
  trainingResult: null,
  activeJob: null,
  lastDownload: null,
  localTrainer: {
    available: false,
    eventSource: null,
    jobId: null,
  },
  availableProfiles: [],
};

function byId(id) {
  return document.getElementById(id);
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value, digits = 1) {
  return Number(value || 0).toFixed(digits);
}

function formatInteger(value) {
  return `${Math.round(value || 0)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function titleCase(value) {
  return String(value)
    .split(/\s+/)
    .map(part => part ? `${part[0].toUpperCase()}${part.slice(1)}` : '')
    .join(' ');
}

function setStatus(message, variant = 'idle') {
  const statusEl = byId('statusText');
  statusEl.textContent = message;
  statusEl.dataset.variant = variant;
}

function setProgress(completed, total) {
  const progress = total ? (completed / total) * 100 : 0;
  byId('progressFill').style.width = `${progress}%`;
  byId('progressMeta').textContent = total ? `${completed} / ${total}` : 'Idle';
}

function populateCheckboxGroup(containerId, items, checkedIds, labelBuilder) {
  const container = byId(containerId);
  container.innerHTML = items.map(item => `
    <label class="chip-toggle">
      <input type="checkbox" value="${item.id}" ${checkedIds.includes(item.id) ? 'checked' : ''}>
      <span>${labelBuilder(item)}</span>
    </label>
  `).join('');
}

function describeProfileOrigin(profile) {
  if (profile.librarySource === 'saved+exported') return 'Saved + exported';
  if (profile.librarySource === 'saved') return 'Saved to browser';
  if (profile.librarySource === 'exported') return 'Exported file';
  return 'Trained AI';
}

function renderTrainingCriteriaControls() {
  const presetSelect = byId('trainingFitnessPreset');
  presetSelect.innerHTML = [
    ...Object.values(FITNESS_PROFILES).map(profile => `<option value="${profile.id}">${profile.name}</option>`),
    '<option value="custom">Custom Tuned</option>',
  ].join('');

  const groups = [...new Set(FITNESS_TUNING_FIELDS.map(field => field.group))];
  byId('trainingCriteriaFields').innerHTML = groups.map(group => `
    <section class="criteria-group">
      <div class="criteria-group-head">
        <h3>${escapeHtml(group)}</h3>
      </div>
      <div class="criteria-grid">
        ${FITNESS_TUNING_FIELDS
          .filter(field => field.group === group)
          .map(field => `
            <label class="field criteria-field">
              <span>${escapeHtml(field.label)}</span>
              <input
                id="fitness-${field.key}"
                data-fitness-key="${field.key}"
                type="number"
                min="${field.min}"
                max="${field.max}"
                step="${field.step}"
              >
              <small>${escapeHtml(field.hint)}</small>
            </label>
          `).join('')}
      </div>
    </section>
  `).join('');
}

function applyTrainingFitnessPreset(presetId) {
  const profile = FITNESS_PROFILES[presetId] || FITNESS_PROFILES[DEFAULT_TRAINING_CONFIG.fitnessPresetId];
  for (const field of FITNESS_TUNING_FIELDS) {
    const input = byId(`fitness-${field.key}`);
    if (input) input.value = profile.weights[field.key];
  }
  byId('trainingFitnessPreset').value = profile.id;
}

function readTrainingFitnessFromForm() {
  const weights = {};
  for (const field of FITNESS_TUNING_FIELDS) {
    weights[field.key] = Number(byId(`fitness-${field.key}`)?.value);
  }
  return weights;
}

function getFitnessPresetName(presetId) {
  if (presetId === 'custom') return 'Custom Tuned';
  return FITNESS_PROFILES[presetId]?.name || titleCase(presetId || 'balanced');
}

function populateControls() {
  renderTrainingCriteriaControls();

  populateCheckboxGroup(
    'mixedPlayerCounts',
    SUPPORTED_PLAYER_COUNTS.map(value => ({ id: String(value), value })),
    DEFAULT_BATCH_CONFIG.mixed.playerCounts.map(String),
    item => `${item.value} players`
  );

  populateCheckboxGroup(
    'mixedDeckSizes',
    DEFAULT_MIXED_DECK_SIZES.map(value => ({ id: String(value), value })),
    DEFAULT_BATCH_CONFIG.mixed.deckSizes.map(String),
    item => `${item.value} invasions`
  );

  populateCheckboxGroup(
    'trainingPlayerCounts',
    SUPPORTED_PLAYER_COUNTS.map(value => ({ id: String(value), value })),
    DEFAULT_TRAINING_CONFIG.playerCounts.map(String),
    item => `${item.value} players`
  );

  populateCheckboxGroup(
    'trainingDeckSizes',
    DEFAULT_MIXED_DECK_SIZES.map(value => ({ id: String(value), value })),
    DEFAULT_TRAINING_CONFIG.deckSizes.map(String),
    item => `${item.value} invasions`
  );

  populateCheckboxGroup(
    'personalityPool',
    state.availableProfiles,
    state.availableProfiles.map(profile => profile.id),
    item => item.name
  );

  const focusedPlayerCount = byId('focusedPlayerCount');
  focusedPlayerCount.innerHTML = SUPPORTED_PLAYER_COUNTS
    .map(count => `<option value="${count}" ${count === DEFAULT_BATCH_CONFIG.focused.playerCount ? 'selected' : ''}>${count} players</option>`)
    .join('');

  const trainingPlayerCount = byId('trainingPlayerCount');

  trainingPlayerCount.innerHTML = SUPPORTED_PLAYER_COUNTS
    .map(count => `<option value="${count}" ${count === DEFAULT_TRAINING_CONFIG.playerCount ? 'selected' : ''}>${count} players</option>`)
    .join('');

  byId('focusedDeckSize').value = DEFAULT_BATCH_CONFIG.focused.deckSize;
  byId('simulationsInput').value = DEFAULT_BATCH_CONFIG.simulations;
  byId('samplePercentInput').value = DEFAULT_BATCH_CONFIG.samplePercent;
  byId('seedInput').value = DEFAULT_BATCH_CONFIG.seed;

  byId('trainingPopulationSize').value = DEFAULT_TRAINING_CONFIG.populationSize;
  byId('trainingGenerations').value = DEFAULT_TRAINING_CONFIG.generations;
  byId('trainingMatchesPerCandidate').value = DEFAULT_TRAINING_CONFIG.matchesPerCandidate;
  byId('trainingValidationMatchesPerCandidate').value = DEFAULT_TRAINING_CONFIG.validationMatchesPerCandidate;
  byId('trainingHoldoutMatchesPerChampion').value = DEFAULT_TRAINING_CONFIG.holdoutMatchesPerChampion;
  byId('trainingParallelWorkers').value = DEFAULT_TRAINING_CONFIG.parallelWorkers;
  byId('trainingChampions').value = DEFAULT_TRAINING_CONFIG.champions;
  byId('trainingDeckSize').value = DEFAULT_TRAINING_CONFIG.deckSize;
  byId('trainingSeed').value = DEFAULT_TRAINING_CONFIG.seed;
  byId('trainingModeGeneralist').checked = DEFAULT_TRAINING_CONFIG.scenarioMode !== 'focused';
  byId('trainingModeFocused').checked = DEFAULT_TRAINING_CONFIG.scenarioMode === 'focused';
  applyTrainingFitnessPreset(DEFAULT_TRAINING_CONFIG.fitnessPresetId);
  updateTrainingModeVisibility();
}

function getCheckedValues(containerId) {
  return [...byId(containerId).querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value);
}

function updateModeVisibility() {
  const mixed = byId('modeMixed').checked;
  byId('mixedControls').hidden = !mixed;
  byId('focusedControls').hidden = mixed;
}

function updateTrainingModeVisibility() {
  const generalist = byId('trainingModeGeneralist').checked;
  byId('trainingGeneralistControls').hidden = !generalist;
  byId('trainingFocusedControls').hidden = generalist;
}

function readConfigFromForm() {
  const mode = byId('modeMixed').checked ? 'mixed' : 'focused';
  const selectedProfileIds = new Set(getCheckedValues('personalityPool'));
  const rawConfig = {
    mode,
    simulations: Number(byId('simulationsInput').value),
    samplePercent: Number(byId('samplePercentInput').value),
    seed: byId('seedInput').value.trim(),
    allowedProfiles: state.availableProfiles.filter(profile => selectedProfileIds.has(profile.id)),
    mixed: {
      playerCounts: getCheckedValues('mixedPlayerCounts').map(Number),
      deckSizes: getCheckedValues('mixedDeckSizes').map(Number),
    },
    focused: {
      playerCount: Number(byId('focusedPlayerCount').value),
      deckSize: Number(byId('focusedDeckSize').value),
    },
  };
  return normalizeBatchConfig(rawConfig);
}

function readTrainingConfigFromForm() {
  return normalizeTrainingConfig({
    seed: byId('trainingSeed').value.trim(),
    scenarioMode: byId('trainingModeFocused').checked ? 'focused' : 'generalist',
    playerCount: Number(byId('trainingPlayerCount').value),
    deckSize: Number(byId('trainingDeckSize').value),
    playerCounts: getCheckedValues('trainingPlayerCounts').map(Number),
    deckSizes: getCheckedValues('trainingDeckSizes').map(Number),
    fitnessPresetId: byId('trainingFitnessPreset').value,
    fitness: readTrainingFitnessFromForm(),
    populationSize: Number(byId('trainingPopulationSize').value),
    generations: Number(byId('trainingGenerations').value),
    matchesPerCandidate: Number(byId('trainingMatchesPerCandidate').value),
    validationMatchesPerCandidate: Number(byId('trainingValidationMatchesPerCandidate').value),
    holdoutMatchesPerChampion: Number(byId('trainingHoldoutMatchesPerChampion').value),
    parallelWorkers: Number(byId('trainingParallelWorkers').value),
    champions: Number(byId('trainingChampions').value),
  });
}

function renderMetricCards(report) {
  const cards = [
    { label: 'Games', value: formatInteger(report.overview.games) },
    { label: 'Empire Falls', value: formatPercent(report.overview.empireFallRate) },
    { label: 'Avg Rounds', value: formatNumber(report.overview.averageRounds, 2) },
    { label: 'Winner Wealth', value: formatNumber(report.overview.averageWinnerWealth, 1) },
    { label: 'Frontier Share', value: formatPercent(report.overview.frontierShare) },
    { label: 'Runtime', value: `${formatNumber(report.runtimeMs / 1000, 2)}s` },
  ];

  return `
    <section class="results-section">
      <div class="metric-grid">
        ${cards.map(card => `
          <article class="metric-card">
            <div class="metric-value">${card.value}</div>
            <div class="metric-label">${card.label}</div>
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

function renderHighlights(report) {
  return `
    <section class="results-section">
      <div class="section-head">
        <h2>Key Insights</h2>
      </div>
      <ul class="insight-list">
        ${report.highlights.map(line => `<li>${escapeHtml(line)}</li>`).join('')}
      </ul>
    </section>
  `;
}

function renderTable(title, columns, rows, emptyMessage = 'No data yet.') {
  if (!rows.length) {
    return `
      <section class="results-section">
        <div class="section-head"><h2>${escapeHtml(title)}</h2></div>
        <p class="empty-state">${escapeHtml(emptyMessage)}</p>
      </section>
    `;
  }

  return `
    <section class="results-section">
      <div class="section-head">
        <h2>${escapeHtml(title)}</h2>
      </div>
      <div class="table-shell">
        <table class="report-table">
          <thead>
            <tr>${columns.map(column => `<th>${escapeHtml(column.label)}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${rows.map(row => `
              <tr>${columns.map(column => `<td>${column.render(row)}</td>`).join('')}</tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderSampleGames(report) {
  if (!report.sampledGames.length) {
    return `
      <section class="results-section">
        <div class="section-head"><h2>Sampled Full Logs</h2></div>
        <p class="empty-state">This run did not retain any detailed game logs.</p>
      </section>
    `;
  }

  return `
    <section class="results-section">
      <div class="section-head">
        <h2>Sampled Full Logs</h2>
        <p>Detailed decision traces and raw engine logs for ${report.sampledGames.length} sampled games.</p>
      </div>
      <div class="sample-stack">
        ${report.sampledGames.map((sample, index) => `
          <details class="sample-game">
            <summary>
              <span>Game ${index + 1}: ${escapeHtml(sample.scenario.label)}</span>
              <span>${sample.empireFall ? 'Empire fell' : 'Reached scoring'} after ${sample.roundsPlayed} rounds</span>
            </summary>
            <div class="sample-meta">
              <div><strong>Seed:</strong> ${sample.seed}</div>
              <div><strong>Final Basileus:</strong> ${sample.personalities.find(player => player.playerId === sample.finalBasileusId)?.dynasty || 'Unknown'}</div>
            </div>
            <div class="sample-subsection">
              <h3>Dynasties And Personalities</h3>
              <div class="pill-row">
                ${sample.personalities.map(player => `<span class="pill">${escapeHtml(player.dynasty)} - ${escapeHtml(player.personalityName)}</span>`).join('')}
              </div>
            </div>
            <div class="sample-subsection">
              <h3>Decision Log</h3>
              <pre>${escapeHtml(sample.decisionLog.join('\n'))}</pre>
            </div>
            <div class="sample-subsection">
              <h3>Final Standings</h3>
              <pre>${escapeHtml(JSON.stringify(sample.finalScores, null, 2))}</pre>
            </div>
            <div class="sample-subsection">
              <h3>Engine Log</h3>
              <pre>${escapeHtml(JSON.stringify(sample.engineLog, null, 2))}</pre>
            </div>
          </details>
        `).join('')}
      </div>
    </section>
  `;
}

function renderSimulationReport(report) {
  const scenarioRows = report.byScenario.map(entry => ({
    label: entry.label,
    games: entry.games,
    fallRate: formatPercent(entry.empireFallRate),
    rounds: formatNumber(entry.averageRounds, 2),
    wealth: formatNumber(entry.averageWinnerWealth, 1),
    coups: formatNumber(entry.averageThroneChanges, 2),
    frontier: formatPercent(entry.frontierShare),
  }));

  const playerCountRows = report.byPlayerCount.map(entry => ({
    label: entry.label,
    games: entry.games,
    fallRate: formatPercent(entry.empireFallRate),
    rounds: formatNumber(entry.averageRounds, 2),
    wealth: formatNumber(entry.averageWinnerWealth, 1),
    frontier: formatPercent(entry.frontierShare),
  }));

  const deckRows = report.byDeckSize.map(entry => ({
    label: entry.label,
    games: entry.games,
    fallRate: formatPercent(entry.empireFallRate),
    rounds: formatNumber(entry.averageRounds, 2),
    wealth: formatNumber(entry.averageWinnerWealth, 1),
    frontier: formatPercent(entry.frontierShare),
  }));

  const personalityRows = report.byPersonality.map(entry => ({
    label: entry.name,
    seats: entry.seats,
    winShare: formatPercent(entry.winShare),
    wealth: formatNumber(entry.averageWealth, 1),
    frontier: formatPercent(entry.frontierShare),
    mercSpend: formatNumber(entry.averageMercSpend, 1),
    landBuys: formatNumber(entry.averageLandBuys, 2),
    recruitment: formatPercent(entry.recruitmentUtilization),
  }));

  const invasionRows = report.invasions.map(entry => ({
    label: entry.name,
    appearances: entry.appearances,
    defeat: formatPercent(entry.defeatRate),
    stalemate: formatPercent(entry.stalemateRate),
    cpl: formatPercent(entry.cplFallRate),
    lost: formatNumber(entry.averageThemesLost, 2),
    recovered: formatNumber(entry.averageThemesRecovered, 2),
  }));

  byId('resultsRoot').innerHTML = [
    renderMetricCards(report),
    renderHighlights(report),
    renderTable('Scenario Comparison', [
      { label: 'Scenario', render: row => row.label },
      { label: 'Games', render: row => row.games },
      { label: 'Empire Fall', render: row => row.fallRate },
      { label: 'Avg Rounds', render: row => row.rounds },
      { label: 'Winner Wealth', render: row => row.wealth },
      { label: 'Throne Changes', render: row => row.coups },
      { label: 'Frontier Share', render: row => row.frontier },
    ], scenarioRows),
    renderTable('By Player Count', [
      { label: 'Bracket', render: row => row.label },
      { label: 'Games', render: row => row.games },
      { label: 'Empire Fall', render: row => row.fallRate },
      { label: 'Avg Rounds', render: row => row.rounds },
      { label: 'Winner Wealth', render: row => row.wealth },
      { label: 'Frontier Share', render: row => row.frontier },
    ], playerCountRows),
    renderTable('By Deck Length', [
      { label: 'Length', render: row => row.label },
      { label: 'Games', render: row => row.games },
      { label: 'Empire Fall', render: row => row.fallRate },
      { label: 'Avg Rounds', render: row => row.rounds },
      { label: 'Winner Wealth', render: row => row.wealth },
      { label: 'Frontier Share', render: row => row.frontier },
    ], deckRows),
    renderTable('Trained AI Performance', [
      { label: 'Profile', render: row => row.label },
      { label: 'Seats', render: row => row.seats },
      { label: 'Win Share', render: row => row.winShare },
      { label: 'Avg Wealth', render: row => row.wealth },
      { label: 'Frontier Share', render: row => row.frontier },
      { label: 'Merc Spend', render: row => row.mercSpend },
      { label: 'Land Buys', render: row => row.landBuys },
      { label: 'Recruit Util.', render: row => row.recruitment },
    ], personalityRows),
    renderTable('Invasion Pressure', [
      { label: 'Invader', render: row => row.label },
      { label: 'Appearances', render: row => row.appearances },
      { label: 'Defeat Rate', render: row => row.defeat },
      { label: 'Stalemate Rate', render: row => row.stalemate },
      { label: 'CPL Fall Rate', render: row => row.cpl },
      { label: 'Themes Lost', render: row => row.lost },
      { label: 'Themes Recovered', render: row => row.recovered },
    ], invasionRows),
    renderSampleGames(report),
  ].join('');
}

function renderTrainingResult(result) {
  if (!result) {
    byId('trainingRoot').innerHTML = '';
    return;
  }

  const criteriaRows = [
    ['Preset', getFitnessPresetName(result.config.fitnessPresetId)],
    ['Fall penalty', formatNumber(result.config.fitness.collapsePenalty, 2)],
    ['Survival bonus', formatNumber(result.config.fitness.survivalBonus, 2)],
    ['Win reward', formatNumber(result.config.fitness.winReward, 2)],
    ['Placement reward', formatNumber(result.config.fitness.placementReward, 2)],
    ['Score advantage reward', formatNumber(result.config.fitness.scoreAdvantageReward ?? result.config.fitness.wealthReward, 2)],
    ['Validation matches', formatInteger(result.config.validationMatchesPerCandidate ?? 0)],
    ['Holdout matches', formatInteger(result.config.holdoutMatchesPerChampion ?? 0)],
    ['Training scope', result.config.scenarioMode === 'focused' ? 'Focused' : 'Generalist'],
    ['Selection', result.overview.selectionMethod || 'survival-gated-pareto'],
    ['Safety gate', result.overview.safetyMode || 'safe-only'],
  ];

  const overviewCards = [
    { label: 'Generations', value: formatInteger(result.overview.generations) },
    { label: 'Population', value: formatInteger(result.overview.populationSize) },
    { label: 'Matches', value: formatInteger(result.overview.totalMatches) },
    { label: 'Workers', value: formatInteger(result.overview.parallelWorkers || 1) },
    { label: 'Best Score', value: formatNumber(result.overview.bestFitness, 3) },
    { label: 'Best Holdout Win', value: formatPercent(result.overview.bestHoldoutWinShare || 0) },
    { label: 'Best Final Score', value: formatNumber(result.overview.bestFinalScore ?? result.overview.bestAverageWealth, 2) },
    { label: 'Best Score Edge', value: formatNumber(result.overview.bestFinalScoreAdvantage || 0, 2) },
    { label: 'Best Surviving Score', value: formatNumber(result.overview.bestSurvivingFinalScore || 0, 2) },
    { label: 'Best Fall Rate', value: formatPercent(result.overview.bestEmpireFallRate) },
    { label: 'Best Guard Rate', value: formatPercent(result.overview.bestGuardRate || 0) },
    { label: 'Best Unsafe Rate', value: formatPercent(result.overview.bestUnsafeRate || 0) },
  ];

  const championCards = result.champions.map((profile, index) => `
      <article class="training-champion-card">
        <div class="training-card-head">
          <h3>#${index + 1} ${escapeHtml(profile.name)}</h3>
          <span class="meta-chip">${escapeHtml(describeProfileOrigin(profile))}</span>
        </div>
        <p>${escapeHtml(profile.summary)}</p>
        <div class="training-meta">
          <span class="meta-chip">${escapeHtml(getFitnessPresetName(profile.training.fitnessPresetId))}</span>
          <span class="meta-chip">Score ${formatNumber(profile.training.championScore ?? profile.training.averageFitness, 3)}</span>
          <span class="meta-chip">Train ${formatPercent(profile.training.trainWinShare || 0)}</span>
          <span class="meta-chip">Validation ${formatPercent(profile.training.validationWinShare || 0)}</span>
          <span class="meta-chip">Holdout ${formatPercent(profile.training.holdoutWinShare || profile.training.winShare || 0)}</span>
          <span class="meta-chip">Final Score ${formatNumber(profile.training.finalScoreMean ?? profile.training.averageWealth, 2)}</span>
          <span class="meta-chip">Score Edge ${formatNumber(profile.training.finalScoreAdvantage || 0, 2)}</span>
          <span class="meta-chip">Fall ${formatPercent(profile.training.empireFallRate)}</span>
          <span class="meta-chip">Guard ${formatPercent(profile.training.guardRate || 0)}</span>
        </div>
        <div class="training-meta">
          <span class="meta-chip">Best ${escapeHtml(profile.training.bestMatchup || 'n/a')}</span>
          <span class="meta-chip">Worst ${escapeHtml(profile.training.worstMatchup || 'n/a')}</span>
          <span class="meta-chip">Seat Bias ${formatPercent(profile.training.seatBias || 0)}</span>
          <span class="meta-chip">Novelty ${formatPercent(profile.training.noveltyPercentile || 0)}</span>
          <span class="meta-chip">Unsafe ${formatPercent(profile.training.unsafeRate || 0)}</span>
        </div>
        <p>${escapeHtml(profile.training.mainBehavior || '')}</p>
      </article>
    `).join('');

  const generationLines = result.generationHistory.map(entry => `
    <li>Generation ${entry.generation}: ${escapeHtml(entry.leaderName || 'Leader')} in ${escapeHtml(entry.safetyMode || 'safe-only')} mode, validation win ${formatPercent(entry.validationWinShare || 0)}, validation fall ${formatPercent(entry.validationEmpireFallRate || 0)}, validation score ${formatNumber(entry.validationFinalScoreMean || 0, 2)}, novelty ${formatNumber(entry.leaderNovelty || 0, 3)}.</li>
  `).join('');

  const exportInfo = result.personalityExport
    ? `
    <section class="results-section">
      <div class="section-head">
        <h2>Exported Personality Files</h2>
        <p>Individual Greek-named champion JSON files were written automatically by the Node trainer. The local game server loads direct JSON files from the trained-personalities folder, so moving valid personality JSON files in or out changes the usable roster.</p>
      </div>
      <ul class="training-list">
        <li>Live roster folder: <code>${escapeHtml(result.personalityExport.exportRoot || '')}</code></li>
        <li>Archived run folder: <code>${escapeHtml(result.personalityExport.runDir || '')}</code></li>
      </ul>
    </section>
  `
    : '';

  byId('trainingRoot').innerHTML = `
    <section class="results-section">
      <div class="section-head">
        <h2>Evolution Training</h2>
        <p>${escapeHtml(result.champions.length)} champion${result.champions.length === 1 ? '' : 's'} ready to save into the live-game library.</p>
      </div>
      <div class="training-summary-grid">
        ${overviewCards.map(card => `
          <article class="metric-card">
            <div class="metric-value">${card.value}</div>
            <div class="metric-label">${escapeHtml(card.label)}</div>
          </article>
        `).join('')}
      </div>
    </section>
    ${exportInfo}
    <section class="results-section">
      <div class="section-head">
        <h2>Champion Profiles</h2>
        <p>These are the best self-play profiles from the final generation.</p>
      </div>
      <div class="training-champion-grid">
        ${championCards}
      </div>
    </section>
    <section class="results-section">
      <div class="section-head">
        <h2>Criteria Used</h2>
        <p>The trainer optimized against these outcome weights.</p>
      </div>
      <div class="training-summary-grid">
        ${criteriaRows.map(([label, value]) => `
          <article class="metric-card">
            <div class="metric-value">${escapeHtml(String(value))}</div>
            <div class="metric-label">${escapeHtml(label)}</div>
          </article>
        `).join('')}
      </div>
    </section>
    <section class="results-section">
      <div class="section-head">
        <h2>Training Arc</h2>
        <p>Leader quality over time, generation by generation.</p>
      </div>
      <ul class="training-list">
        ${generationLines}
      </ul>
    </section>
  `;
}

function renderSavedProfileLibrary() {
  const localProfileIds = new Set(listSavedAiProfiles().map(profile => profile.id));
  const profiles = state.availableProfiles;
  byId('savedProfilesRoot').innerHTML = profiles.length
    ? profiles.map(profile => {
      const isLocalProfile = localProfileIds.has(profile.id);
      return `
        <article class="saved-profile-card">
          <div class="saved-profile-head">
            <h3>${escapeHtml(profile.name)}</h3>
            ${isLocalProfile ? `<button class="inline-button" data-profile-delete="${escapeHtml(profile.id)}">Delete</button>` : ''}
          </div>
          <p>${escapeHtml(profile.summary)}</p>
          <div class="saved-profile-meta">
            <span class="meta-chip">${escapeHtml(describeProfileOrigin(profile))}</span>
            <span class="meta-chip">${escapeHtml(getFitnessPresetName(profile.training.fitnessPresetId))}</span>
            <span class="meta-chip">Score ${formatNumber(profile.training.championScore ?? profile.training.averageFitness, 3)}</span>
            <span class="meta-chip">Holdout ${formatPercent(profile.training.holdoutWinShare || profile.training.winShare || 0)}</span>
            <span class="meta-chip">${escapeHtml(profile.training.scenarioMode === 'focused' ? `Focused ${formatInteger(profile.training.playerCount)}p/${formatInteger(profile.training.deckSize)}d` : 'Generalist')}</span>
            <span class="meta-chip">${escapeHtml(formatProfileSnapshot(profile))}</span>
          </div>
        </article>
      `;
    }).join('')
    : '<p class="empty-state">No trained AIs detected yet. Run the evolution trainer and save champions, or load exported profile files into the project roster.</p>';
}

async function refreshAvailableProfilePool({ preserveSelection = true } = {}) {
  const previousSelection = preserveSelection ? new Set(getCheckedValues('personalityPool')) : new Set();
  state.availableProfiles = await listAvailableAiProfiles();

  const selectedIds = previousSelection.size
    ? state.availableProfiles
      .filter(profile => previousSelection.has(profile.id))
      .map(profile => profile.id)
    : state.availableProfiles.map(profile => profile.id);

  populateCheckboxGroup(
    'personalityPool',
    state.availableProfiles,
    selectedIds,
    item => item.name
  );
  renderSavedProfileLibrary();

  if (!state.activeJob) {
    byId('runButton').disabled = state.availableProfiles.length === 0;
  }
}

function resetJobButtons() {
  state.activeJob = null;
  byId('runButton').disabled = state.availableProfiles.length === 0;
  byId('trainButton').disabled = false;
  byId('cancelButton').disabled = true;
  byId('downloadButton').disabled = state.lastDownload == null;
  byId('saveTrainingButton').disabled = !state.trainingResult?.champions?.length;
}

function stopWorker() {
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
  resetJobButtons();
}

function closeLocalTrainerStream() {
  if (state.localTrainer.eventSource) {
    state.localTrainer.eventSource.close();
    state.localTrainer.eventSource = null;
  }
}

async function detectLocalTrainer({ silent = false } = {}) {
  try {
    const response = await fetch('/api/trainer/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('Local trainer API unavailable.');
    const status = await response.json();
    state.localTrainer.available = Boolean(status.localTrainer);
    if (state.localTrainer.available) {
      byId('trainButton').textContent = 'Run Training In Node';
      byId('trainingParallelWorkers').title = `${status.availableParallelism || 'Auto'} logical CPU workers available to the local trainer.`;
      setStatus('Ready. Local Node trainer detected; AI training will run outside the browser.', 'idle');
      return true;
    }
  } catch {
    // The local server may still be starting; startup retry logic below will check again.
  }
  state.localTrainer.available = false;
  byId('trainButton').textContent = 'Run Training In Browser';
  if (!silent) {
    setStatus('Ready. Local Node trainer not detected; training will use the browser fallback unless the local server starts.', 'idle');
  }
  return false;
}

function scheduleLocalTrainerDetectionRetries() {
  const retryDelays = [250, 750, 1500, 3000, 5000];
  for (const delay of retryDelays) {
    setTimeout(() => {
      if (!state.localTrainer.available && !state.activeJob) {
        detectLocalTrainer({ silent: true });
      }
    }, delay);
  }
}

async function cancelLocalTrainerJob() {
  const jobId = state.localTrainer.jobId;
  closeLocalTrainerStream();
  if (jobId) {
    try {
      await fetch(`/api/trainer/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
    } catch {
      // The browser fallback uses workers; if the local process already ended
      // there is nothing useful to do here.
    }
  }
  state.localTrainer.jobId = null;
  resetJobButtons();
}

function prepareJobUi(kind, config) {
  state.activeJob = kind;
  if (kind === 'train') {
    state.trainingResult = null;
    byId('trainingRoot').innerHTML = '';
    setProgress(0, estimateTrainingMatches(config));
    setStatus(`Training ${config.populationSize} profiles across ${config.generations} generations with ${getFitnessPresetName(config.fitnessPresetId)} criteria...`, 'running');
  } else {
    state.simulationResult = null;
    byId('resultsRoot').innerHTML = '';
    setProgress(0, config.simulations);
    setStatus(`Running ${config.simulations} simulations in ${config.mode === 'mixed' ? 'mixed sweep' : 'focused'} mode...`, 'running');
  }

  byId('runButton').disabled = true;
  byId('trainButton').disabled = true;
  byId('cancelButton').disabled = false;
  byId('downloadButton').disabled = true;
  byId('saveTrainingButton').disabled = true;
}

async function finishLocalTrainingJob(jobId) {
  const response = await fetch(`/api/trainer/jobs/${encodeURIComponent(jobId)}/result`, { cache: 'no-store' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'The Node trainer finished, but the result file could not be read.');
  }
  const result = await response.json();
  state.trainingResult = result;
  state.lastDownload = { filename: `basileus-training-${Date.now()}.json`, data: result };
  renderTrainingResult(result);
  setProgress(result.overview.totalMatches, result.overview.totalMatches);
  const exportText = result.personalityExport?.exportRoot ? ` Exported to ${result.personalityExport.exportRoot}.` : '';
  setStatus(`Node training completed in ${formatNumber(result.runtimeMs / 1000, 2)}s. ${result.champions.length} champion${result.champions.length === 1 ? '' : 's'} ready.${exportText}`, 'done');
  closeLocalTrainerStream();
  state.localTrainer.jobId = null;
  resetJobButtons();
}

function handleLocalTrainerEvent(message) {
  if (message.event === 'start') {
    setProgress(0, message.totalMatches || 0);
    setStatus(`Node trainer started with ${message.config?.parallelWorkers || 'auto'} worker setting. Estimated matches: ${formatInteger(message.totalMatches)}.`, 'running');
    return;
  }

  if (message.event === 'progress') {
    setProgress(message.completed, message.total);
    setStatus(
      `Node training ${message.percent}%. Generation ${message.generation}, ${message.stage}. Leader: ${message.leaderName || 'Evaluating'} (score ${formatNumber(message.leaderFitness, 3)}).`,
      'running'
    );
    return;
  }

  if (message.event === 'personalities-exported') {
    setStatus(`Node trainer exported ${message.files || 0} personality file${message.files === 1 ? '' : 's'} to ${message.exportRoot || 'trained-personalities'}.`, 'running');
    return;
  }

  if (message.event === 'stderr') {
    setStatus(`Node trainer reported: ${message.line}`, 'running');
    return;
  }

  if (message.event === 'error') {
    closeLocalTrainerStream();
    resetJobButtons();
    byId('trainingRoot').innerHTML = `
      <section class="results-section error-panel">
        <h2>Training Error</h2>
        <pre>${escapeHtml(message.stack || message.message || 'Unknown Node trainer error')}</pre>
      </section>
    `;
    setStatus(`Node training failed: ${message.message || 'Unknown error'}`, 'error');
    return;
  }

  if (message.event === 'cancelled') {
    closeLocalTrainerStream();
    resetJobButtons();
    setStatus('Node training cancelled.', 'idle');
    setProgress(0, 0);
    return;
  }

  if (message.event === 'result-ready') {
    finishLocalTrainingJob(message.jobId).catch(error => {
      closeLocalTrainerStream();
      resetJobButtons();
      setStatus(`Could not load Node training result: ${error.message}`, 'error');
    });
  }
}

async function startLocalTraining(config) {
  closeLocalTrainerStream();
  prepareJobUi('train', config);

  try {
    const response = await fetch('/api/trainer/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Could not start local Node trainer.');
    }

    const job = await response.json();
    state.localTrainer.jobId = job.id;
    const events = new EventSource(`/api/trainer/jobs/${encodeURIComponent(job.id)}/events`);
    state.localTrainer.eventSource = events;
    events.onmessage = (event) => {
      try {
        handleLocalTrainerEvent(JSON.parse(event.data));
      } catch (error) {
        setStatus(`Could not parse Node trainer event: ${error.message}`, 'error');
      }
    };
    events.onerror = () => {
      if (state.activeJob === 'train') {
        setStatus('Connection to the local Node trainer was interrupted.', 'error');
      }
    };
  } catch (error) {
    closeLocalTrainerStream();
    state.localTrainer.jobId = null;
    resetJobButtons();
    setStatus(`Could not start Node training: ${error.message}`, 'error');
  }
}

function startBrowserWorkerJob(kind, config) {
  state.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  state.worker.addEventListener('message', (event) => {
    const payload = event.data || {};

    if (payload.type === 'progress') {
      if (payload.mode === 'training') {
        setProgress(payload.progress.completed, payload.progress.total);
        setStatus(
          `Generation ${payload.progress.generation}/${payload.progress.generations}, evaluation ${payload.progress.currentMatch}/${payload.progress.matchesThisGeneration}. Current leader: ${payload.progress.leaderName} (score ${formatNumber(payload.progress.leaderFitness, 3)}).`,
          'running'
        );
      } else {
        setProgress(payload.progress.completed, payload.progress.total);
        setStatus(
          `Processed ${payload.progress.completed} simulations. Latest scenario: ${payload.progress.scenarioLabel}.`,
          'running'
        );
      }
      return;
    }

    if (payload.type === 'result') {
      if (kind === 'train') {
        state.trainingResult = payload.result;
        state.lastDownload = { filename: `basileus-training-${Date.now()}.json`, data: payload.result };
        renderTrainingResult(payload.result);
        setProgress(payload.result.overview.totalMatches, payload.result.overview.totalMatches);
        setStatus(`Training completed in ${formatNumber(payload.result.runtimeMs / 1000, 2)}s. ${payload.result.champions.length} champion${payload.result.champions.length === 1 ? '' : 's'} ready to save.`, 'done');
      } else {
        state.simulationResult = payload.result;
        state.lastDownload = { filename: `basileus-simulation-${Date.now()}.json`, data: payload.result };
        renderSimulationReport(payload.result);
        setProgress(payload.result.overview.games, payload.result.overview.games);
        setStatus(`Completed ${payload.result.overview.games} simulations in ${formatNumber(payload.result.runtimeMs / 1000, 2)}s.`, 'done');
      }
      stopWorker();
      return;
    }

    if (payload.type === 'error') {
      stopWorker();
      setStatus(`${kind === 'train' ? 'Training' : 'Simulation'} failed: ${payload.error.message}`, 'error');
      const target = kind === 'train' ? 'trainingRoot' : 'resultsRoot';
      byId(target).innerHTML = `
        <section class="results-section error-panel">
          <h2>${kind === 'train' ? 'Training' : 'Simulation'} Error</h2>
          <pre>${escapeHtml(payload.error.stack || payload.error.message)}</pre>
        </section>
      `;
    }
  });

  state.worker.postMessage({ type: kind, config });
}

function startJob(kind) {
  if (state.worker) stopWorker();
  if (state.localTrainer.eventSource) cancelLocalTrainerJob();

  const config = kind === 'train' ? readTrainingConfigFromForm() : readConfigFromForm();
  if (kind === 'run' && !config.allowedProfiles.length) {
    setStatus('Select at least one trained AI profile before running a simulation batch.', 'error');
    return;
  }
  if (kind === 'train' && state.localTrainer.available) {
    startLocalTraining(config);
    return;
  }

  prepareJobUi(kind, config);
  startBrowserWorkerJob(kind, config);
}

function downloadResult() {
  if (!state.lastDownload) return;
  const blob = new Blob([JSON.stringify(state.lastDownload.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = state.lastDownload.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function saveTrainingChampions() {
  if (!state.trainingResult?.champions?.length) return;
  const beforeCount = listSavedAiProfiles().length;
  const savedProfiles = saveAiProfiles(state.trainingResult.champions);
  const addedCount = Math.max(0, savedProfiles.length - beforeCount);
  void refreshAvailableProfilePool();
  if (addedCount === 0) {
    setStatus('Those trained AI champions were already present in the library, so nothing was overwritten.', 'done');
    return;
  }
  setStatus(`Saved ${addedCount} new trained AI champion${addedCount === 1 ? '' : 's'} to the library without overwriting older entries.`, 'done');
}

function resetDefaults() {
  populateControls();
  byId('modeMixed').checked = true;
  updateModeVisibility();
  updateTrainingModeVisibility();
  setStatus('Defaults restored. Ready for another sweep or training run.');
}

function bindEvents() {
  byId('modeMixed').addEventListener('change', updateModeVisibility);
  byId('modeFocused').addEventListener('change', updateModeVisibility);
  byId('trainingModeGeneralist').addEventListener('change', updateTrainingModeVisibility);
  byId('trainingModeFocused').addEventListener('change', updateTrainingModeVisibility);
  byId('runButton').addEventListener('click', () => startJob('run'));
  byId('trainButton').addEventListener('click', () => startJob('train'));
  byId('saveTrainingButton').addEventListener('click', saveTrainingChampions);
  byId('cancelButton').addEventListener('click', () => {
    if (state.localTrainer.jobId) {
      cancelLocalTrainerJob();
    } else {
      stopWorker();
    }
    setStatus('Current job cancelled.', 'idle');
    setProgress(0, 0);
  });
  byId('downloadButton').addEventListener('click', downloadResult);
  byId('resetButton').addEventListener('click', resetDefaults);
  byId('refreshLibraryButton').addEventListener('click', () => {
    void refreshAvailableProfilePool({ preserveSelection: true });
  });
  byId('savedProfilesRoot').addEventListener('click', (event) => {
    const button = event.target.closest('[data-profile-delete]');
    if (!button) return;
    deleteSavedAiProfile(button.dataset.profileDelete);
    void refreshAvailableProfilePool({ preserveSelection: true });
  });
  byId('trainingFitnessPreset').addEventListener('change', (event) => {
    const presetId = event.target.value;
    if (FITNESS_PROFILES[presetId]) {
      applyTrainingFitnessPreset(presetId);
    }
  });
  byId('trainingCriteriaFields').addEventListener('input', (event) => {
    const input = event.target.closest('[data-fitness-key]');
    if (!input) return;
    byId('trainingFitnessPreset').value = 'custom';
  });
}

async function init() {
  await refreshAvailableProfilePool({ preserveSelection: false });
  populateControls();
  bindEvents();
  updateModeVisibility();
  updateTrainingModeVisibility();
  renderSavedProfileLibrary();
  renderTrainingResult(null);
  setProgress(0, 0);
  byId('trainButton').textContent = 'Checking Local Trainer...';
  if (state.availableProfiles.length) {
    setStatus(`Loaded ${state.availableProfiles.length} trained AI profile${state.availableProfiles.length === 1 ? '' : 's'}. Checking whether the local Node trainer is available...`);
  } else {
    setStatus('No trained AI profiles detected yet. Checking whether the local Node trainer is available...');
  }
  detectLocalTrainer();
  scheduleLocalTrainerDetectionRetries();
}

init();
