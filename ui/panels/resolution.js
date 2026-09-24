// ui/panels/resolution.js - Resolution panel: revealed orders, the war and the coup.

import { getPlayer } from '../../engine/state.js';
import { formatGoldHtml, formatMercenariesHtml, formatSupportHtml, formatTroopsHtml } from '../icons.js';
import { escapeHtml } from '../html.js';
import { renderPlayerChip, renderPlayerRoleName, renderProvinceBadge } from '../labels.js';
import { renderArmyOfficeBadge, renderPickerStep } from './shared.js';

export function renderResolutionPanel(container, state, options = {}) {
  return renderResolutionPanelDetailed(container, state, options);
}

function getCurrentOrderRevealEvents(state) {
  return (state.history || [])
    .filter((event) => event?.type === 'orders_revealed')
    .filter((event) => Number(event.round ?? state.round) === Number(state.round))
    .sort((a, b) => Number(a.actorId) - Number(b.actorId));
}

function destinationLabel(value) {
  return value === 'capital' ? 'Constantinople' : 'Frontier';
}

function renderPlayerRef(state, playerId) {
  return renderPlayerChip(state, getPlayer(state, Number(playerId)), `Player ${Number(playerId) + 1}`, { variant: 'light' });
}

function renderCoupChoiceList(state, coupChoices = []) {
  if (!coupChoices.length) return 'backs nobody';
  return coupChoices
    .map((candidateId, index) => `${index === 0 ? '1st' : '2nd'} ${renderPlayerRef(state, candidateId)}`)
    .join(', ');
}

// One line of a claimant's coup support: who gave it and why.
function describeCoupContribution(state, entry) {
  const value = Number(entry.votes ?? entry.troops) || 0;
  const choice = Number(entry.choice) === 1 ? '1st' : Number(entry.choice) === 2 ? '2nd, half' : '';
  const choiceTag = choice ? ` <span class="vote-choice">(${choice})</span>` : '';
  if (entry.source === 'patriarch') {
    return `${escapeHtml(entry.supportLabel || "Patriarch's influence")} of ${renderPlayerRef(state, entry.playerId)}${choiceTag} ${formatSupportHtml(value)}`;
  }
  if (entry.passive) {
    return `${escapeHtml(entry.supportLabel || 'Support')} ${formatSupportHtml(value, { signed: true })}`;
  }
  return `${renderPlayerRef(state, entry.playerId)}'s troops${choiceTag} ${formatSupportHtml(value)}`;
}

function renderDeploymentOfficeRevealRows(state, playerId, offices) {
  if (!offices.length) return '';
  return `
    <div class="deployment-reveal-office-list">
      ${offices.map((office) => {
        const totalTroops = Math.max(0, Number(office.totalTroops) || 0);
        const fundedTroops = Math.max(0, Number(office.fundedTroops) || 0);
        const unfundedTroops = Math.max(0, Number(office.unfundedTroops) || 0);
        const capitalTroops = Math.max(0, Number(office.capitalTroops) || 0);
        const frontierTroops = Math.max(0, Number(office.frontierTroops) || 0);
        return `
          <div class="deployment-reveal-office-row">
            <span class="deployment-reveal-office-name">${renderArmyOfficeBadge(state, office.officeKey, playerId)}</span>
            <span>${formatTroopsHtml(fundedTroops)} fielded of ${formatTroopsHtml(totalTroops)}</span>
            <span>${formatTroopsHtml(unfundedTroops)} dismissed</span>
            <span>${destinationLabel(office.destination)}: ${formatTroopsHtml(office.destination === 'capital' ? capitalTroops : frontierTroops)}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderDeploymentRevealSection(state) {
  const events = getCurrentOrderRevealEvents(state);
  if (!events.length) return '';
  return `
    <details class="deployment-reveal-details">
      <summary class="deployment-reveal-summary">
        <span>Deployment Details</span>
        <span>troops, mercenaries, destinations and coup choices</span>
      </summary>
      <article class="result-card deployment-reveal-card">
      <header class="result-card-head">
        <span class="result-card-kicker">Deployment</span>
        <span class="result-card-against">what each dynasty did</span>
      </header>
      <div class="deployment-reveal-list">
        ${events.map((event) => {
          const details = event.details || {};
          const playerId = Number(event.actorId);
          const player = getPlayer(state, playerId);
          const offices = Array.isArray(details.offices) ? details.offices : [];
          const fundedTroops = offices.reduce((total, office) => total + Math.max(0, Number(office.fundedTroops) || 0), 0);
          const unfundedTroops = offices.reduce((total, office) => total + Math.max(0, Number(office.unfundedTroops) || 0), 0);
          const capitalTroops = Math.max(0, Number(details.capitalTroops) || 0);
          const frontierTroops = Math.max(0, Number(details.frontierTroops) || 0);
          const coupChoices = Array.isArray(details.coupChoices) ? details.coupChoices.map(Number) : [];
          const mercenaries = details.mercenaries || {};
          const mercenaryCount = Math.max(0, Number(mercenaries.count) || 0);
          const mercenaryDestination = mercenaryCount > 0 ? destinationLabel(mercenaries.destination) : 'None';
          return `
            <section class="deployment-reveal-player">
              <header class="deployment-reveal-player-head">
                ${player ? renderPlayerRoleName(state, player) : escapeHtml(event.actorName || `Player ${playerId + 1}`)}
                <span>${formatTroopsHtml(frontierTroops)} Frontier · ${formatTroopsHtml(capitalTroops)} Constantinople</span>
              </header>
              <div class="deployment-reveal-pills">
                <span>Fielded ${formatTroopsHtml(fundedTroops)}</span>
                <span>Dismissed ${formatTroopsHtml(unfundedTroops)}</span>
                <span>Mercenaries ${formatMercenariesHtml(mercenaryCount)} ${mercenaryCount ? `to ${mercenaryDestination}` : ''}</span>
                <span>Coup ${renderCoupChoiceList(state, coupChoices)}</span>
              </div>
              ${renderDeploymentOfficeRevealRows(state, playerId, offices)}
            </section>
          `;
        }).join('')}
      </div>
      </article>
    </details>
  `;
}

export function renderResolutionPanelDetailed(container, state, options = {}) {
  if (!container || !state) return;
  const war = state.lastWarResult;
  const coup = state.lastCoupResult;
  const empireFell = Boolean(war?.reachedCPL) || state.gameOver?.type === 'fall';
  const invasionName = state.currentInvasion?.name || 'the invader';

  const deploymentRevealSection = renderDeploymentRevealSection(state);
  const warSection = war ? renderWarResultCard(state, war, invasionName, empireFell) : '';
  const coupSection = coup ? renderCoupResultCard(state, coup) : '';
  const empireFallenBanner = empireFell
    ? `<div class="empire-fall-banner">
        <span class="empire-fall-kicker">Empire Fallen</span>
        <span class="empire-fall-body">${escapeHtml(invasionName)} reached Constantinople. The empire is no more.</span>
      </div>`
    : '';

  container.innerHTML = `
    <section class="phase-card resolution-panel">
      <h3>Resolution</h3>
      ${empireFallenBanner}
      ${warSection}
      ${coupSection}
      ${deploymentRevealSection}
      <div class="panel-actions action-priority">
        <button type="button" class="btn-primary btn-commit" data-action="continue">Continue</button>
      </div>
    </section>
  `;
}

function renderWarResultCard(state, war, invasionName, empireFell) {
  const outcome = war.outcome || (war.frontierTroops > war.invaderStrength ? 'victory' : war.frontierTroops < war.invaderStrength ? 'defeat' : 'stalemate');
  const outcomeLabel = empireFell ? 'Empire falls' : outcome.toUpperCase();
  const empireTroops = Math.max(0, Number(war.frontierTroops) || 0);
  const invaderStrength = Math.max(0, Number(war.invaderStrength) || 0);
  const themesLost = Array.isArray(war.themesLost) ? war.themesLost : [];
  const themesRecovered = Array.isArray(war.themesRecovered) ? war.themesRecovered : [];
  const frontierBreakdown = renderFrontierContributionBreakdown(state, war.contributions);
  const reconquestReward = war.reconquestReward || null;

  return `
    <article class="result-card war-result war-${outcome}${empireFell ? ' empire-fell' : ''}">
      <header class="result-card-head">
        <span class="result-card-kicker">War</span>
        <span class="result-card-against">vs <strong>${escapeHtml(invasionName)}</strong></span>
        <span class="war-outcome-badge">${escapeHtml(outcomeLabel)}</span>
      </header>
      <div class="war-tug">
        <div class="war-tug-side empire">
          <span class="war-tug-label">Empire</span>
          <span class="war-tug-value">${formatTroopsHtml(empireTroops)}</span>
        </div>
        <span class="war-tug-vs">vs</span>
        <div class="war-tug-side invader">
          <span class="war-tug-label">Invader</span>
          <span class="war-tug-value">${formatTroopsHtml(invaderStrength)}</span>
        </div>
      </div>
      ${frontierBreakdown}
      ${themesLost.length ? `
        <div class="war-result-row lost">
          <span class="war-result-row-label">Lost to the invader</span>
          <div class="war-result-tokens">${themesLost.map((id) => renderProvinceBadge(state, state.themes[id] || { id, name: id }, { compact: true })).join(' ')}</div>
        </div>
      ` : ''}
      ${themesRecovered.length ? `
        <div class="war-result-row recovered">
          <span class="war-result-row-label">Reclaimed for the empire</span>
          <div class="war-result-tokens">${themesRecovered.map((id) => renderProvinceBadge(state, state.themes[id] || { id, name: id }, { compact: true })).join(' ')}</div>
        </div>
      ` : ''}
      ${reconquestReward ? renderReconquestRewardRow(state, reconquestReward) : ''}
    </article>
  `;
}

function getReconquestRewardRecipients(reward) {
  if (Array.isArray(reward?.defenders) && reward.defenders.length) return reward.defenders;
  if (!reward) return [];
  return [{
    defenderId: reward.defenderId,
    defenderName: reward.defenderName,
    gold: reward.gold,
    capitalSupport: reward.capitalSupport,
  }];
}

function renderReconquestRewardRow(state, reward) {
  const recipients = getReconquestRewardRecipients(reward);
  if (!recipients.length) return '';
  const split = recipients.length > 1;
  const recoveredCount = Array.isArray(reward.themeIds) ? reward.themeIds.length : 0;
  const rewardProvinceCount = Math.max(
    recoveredCount,
    Number(reward.rewardProvinceCount ?? reward.totalGold ?? reward.totalCapitalSupport) || 0,
  );
  const repulseNote = rewardProvinceCount > recoveredCount
    ? `<span class="muted">Repulse value: ${rewardProvinceCount} province win${rewardProvinceCount === 1 ? '' : 's'}.</span>`
    : '';
  return `
    <div class="war-result-row recovered reconquest-reward-row">
      <span class="war-result-row-label">${split ? 'Triumph split' : 'Triumph'}</span>
      <div class="reward-card-body">
        ${recipients.map((recipient) => {
          const defender = getPlayer(state, Number(recipient.defenderId));
          return `
            <div class="reward-recipient">
              ${defender ? renderPlayerRoleName(state, defender) : escapeHtml(recipient.defenderName || 'Top defender')}
              <span class="muted">gains ${formatGoldHtml(recipient.gold || 0)} now and ${formatSupportHtml(recipient.capitalSupport || 0, { signed: true })} support in next round's coup.</span>
            </div>
          `;
        }).join('')}
        ${repulseNote}
      </div>
    </div>
  `;
}

function renderFrontierContributionBreakdown(state, contributions = []) {
  const rows = (Array.isArray(contributions) ? contributions : [])
    .map((entry) => ({
      playerId: Number(entry.playerId),
      playerName: entry.playerName,
      troops: Math.max(0, Number(entry.troops) || 0),
    }))
    .filter((entry) => entry.troops > 0)
    .sort((a, b) => (b.troops - a.troops) || (a.playerId - b.playerId));

  return `
    <div class="vote-breakdown frontier-breakdown">
      <div class="frontier-breakdown-title">Frontier contributions</div>
      ${rows.length ? rows.map((row) => {
        const player = getPlayer(state, row.playerId);
        return `
          <div class="vote-row frontier-row">
            <span class="vote-candidate">
              ${renderPlayerRoleName(state, player, row.playerName || `Player ${row.playerId + 1}`)}
            </span>
            <span class="vote-troops frontier-troops">${formatTroopsHtml(row.troops)}</span>
          </div>
        `;
      }).join('') : '<p class="muted frontier-empty">No frontier troops were committed.</p>'}
    </div>
  `;
}

function renderCoupTieBreakNote(state, coup) {
  const tieBreak = coup?.tieBreak || null;
  const tiedIds = Array.isArray(tieBreak?.tiedCandidateIds) ? tieBreak.tiedCandidateIds : [];
  if (!tieBreak?.method || tiedIds.length < 2) return '';
  const winner = getPlayer(state, Number(coup.winner));
  const winnerName = winner ? renderPlayerRoleName(state, winner) : escapeHtml(`Player ${Number(coup.winner) + 1}`);
  const support = Number(tieBreak.patriarchSupport?.[Number(coup.winner)]) || 0;
  const text = tieBreak.method === 'patriarch'
    ? `${winnerName} wins the tie with ${formatSupportHtml(support)} from the Patriarch's influence.`
    : tieBreak.method === 'incumbent'
      ? "The Patriarch's influence does not break the tie, so the Basileus keeps the throne."
      : "The Patriarch's influence does not break the tie, so it goes to the first dynasty in seating order.";
  return `<div class="coup-tie-break">${text}</div>`;
}

function renderCoupResultCard(state, coup) {
  const winnerId = coup.winner;
  const winner = getPlayer(state, winnerId);
  const heldThrone = winnerId === state.basileusId;
  const votes = coup.votes || {};
  const contributions = Array.isArray(coup.contributions) ? coup.contributions : [];
  const ballots = Array.isArray(coup.ballots) ? coup.ballots : contributions;
  const voteRows = Object.entries(votes)
    .map(([candidateId, troops]) => ({ candidateId: Number(candidateId), troops: Number(troops) || 0 }))
    .filter((row) => row.troops !== 0)
    .sort((a, b) => (b.troops - a.troops) || (a.candidateId - b.candidateId));
  const zeroBallots = ballots
    .filter((ballot) => Math.max(0, Number(ballot.troops) || 0) <= 0)
    .sort((a, b) => Number(a.playerId) - Number(b.playerId));
  const zeroBallotSummary = zeroBallots.length
    ? `No troops in Constantinople from ${zeroBallots.map((ballot) => {
      const voter = getPlayer(state, Number(ballot.playerId));
      return renderPlayerChip(state, voter, `Player ${Number(ballot.playerId) + 1}`, { variant: 'light' });
    }).join(' ')}.`
    : '';

  return `
    <article class="result-card coup-result">
      <header class="result-card-head">
        <span class="result-card-kicker">Coup</span>
        <span class="coup-outcome-badge ${heldThrone ? 'held' : 'changed'}">${heldThrone ? 'Throne held' : 'New Basileus'}</span>
      </header>
      <div class="coup-winner-line">
        ${winner ? renderPlayerRoleName(state, winner) : 'Vacant'}
        <span class="muted">${heldThrone ? 'holds the throne' : 'claims the throne'}</span>
      </div>
      ${renderCoupTieBreakNote(state, coup)}
      ${voteRows.length ? `
        <div class="vote-breakdown">
          ${voteRows.map((row) => {
            const supporters = contributions
              .filter((entry) => Number(entry.candidateId) === row.candidateId && (Number(entry.votes ?? entry.troops) || 0) !== 0)
              .sort((a, b) => (Number(b.votes ?? b.troops) - Number(a.votes ?? a.troops)) || (Number(a.playerId) - Number(b.playerId)));
            return `
              <div class="vote-row">
                <span class="vote-candidate">
                  ${renderPlayerRoleName(state, getPlayer(state, row.candidateId), `Player ${row.candidateId + 1}`)}
                  ${supporters.length ? `
                    <span class="vote-supporters">
                      ${supporters.map((entry) => `<span class="vote-source">${describeCoupContribution(state, entry)}</span>`).join('')}
                    </span>
                  ` : ''}
                </span>
                <span class="vote-troops">${formatSupportHtml(row.troops)}</span>
              </div>
            `;
          }).join('')}
          ${zeroBallotSummary ? `
            <div class="vote-zero-list">
              ${zeroBallotSummary}
            </div>
          ` : ''}
        </div>
      ` : `<p class="muted">Nobody had support in the coup, so the Basileus keeps the throne.${zeroBallotSummary ? ` ${zeroBallotSummary}` : ''}</p>`}
    </article>
  `;
}

