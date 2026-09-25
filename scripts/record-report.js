// scripts/record-report.js - reads a game record downloaded from the game
// (game/record.js) and prints it as a round-by-round chronicle: what each
// dynasty did and why the AIs say they did it, the human's commands and
// notes, and where everyone stood at each Resolution.
//
//   npm run record:report -- records/basileus-record-....json [--verify] [--json]
//
// --verify replays the game from its seed and checks it ends the same; that
// only holds on the code the game was played with.
import { readFileSync } from 'node:fs';

import { isGameRecord, replayGameRecord } from '../game/record.js';
import { serializeGameState } from '../game/save.js';

function parseArgs(argv) {
  const options = { files: [], verify: false, json: false };
  for (const arg of argv) {
    if (arg === '--verify') options.verify = true;
    else if (arg === '--json') options.json = true;
    else options.files.push(arg);
  }
  return options;
}

function seatName(record, playerId) {
  const seat = record.seats?.find((entry) => entry.playerId === Number(playerId));
  if (!seat) return `P${playerId}`;
  if (seat.human) return `P${playerId} (human)`;
  return `P${playerId} ${seat.name || ''} [${seat.personality || seat.opponentId || 'AI'}]`.replace(/\s+/g, ' ');
}

function describeCommand(record, entry) {
  const who = entry.playerId == null ? '' : `${seatName(record, entry.playerId)} `;
  const args = entry.args || {};
  let what = entry.call;
  if (entry.call === 'courtAction') what = `court ${JSON.stringify(args.payload)}`;
  else if (entry.call === 'estateAction') what = `estates ${JSON.stringify(args.payload?.plan ?? args.payload)}`;
  else if (entry.call === 'orders') what = `orders ${JSON.stringify(args.orders)}`;
  else if (entry.call === 'titleRedistribution') what = `hands out offices ${JSON.stringify(args.assignments)}`;
  const refused = entry.ok ? '' : ` -> refused${entry.reason ? `: ${entry.reason}` : ''}`;
  return `#${entry.seq} ${who}${what}${refused}`;
}

function describeDecision(decision) {
  const factors = (decision?.factors || [])
    .map((factor) => `${factor.label}=${typeof factor.value === 'object' ? JSON.stringify(factor.value) : factor.value}${factor.note ? ` (${factor.note})` : ''}`);
  return factors.length ? `      why: ${factors.join('; ')}` : '';
}

function describeSnapshot(record, snapshot) {
  const head = `  standing: basileus ${seatName(record, snapshot.basileusId)}`
    + `${snapshot.newBasileusId != null && snapshot.newBasileusId !== snapshot.basileusId ? `, coup won by ${seatName(record, snapshot.newBasileusId)}` : ''}`
    + `, war ${snapshot.war || '-'}, ${snapshot.lostProvinces} provinces lost${snapshot.fallen ? ', EMPIRE FALLEN' : ''}`;
  const rows = snapshot.players.map((player) => (
    `    ${seatName(record, player.id)}: ${player.points} pts, ${player.gold} gold, `
    + `${player.estates} estates, ${player.strategoi} strategoi, ${player.bishops} bishops`
    + `${player.majorTitles.length ? `, ${player.majorTitles.join('/')}` : ''}`
  ));
  return [head, ...rows].join('\n');
}

function printReport(record, path, options) {
  const config = record.config || {};
  const lines = [];
  lines.push(`=== ${path}`);
  lines.push(`${config.mode} game, ${config.playerCount} dynasties, ${config.turnCount || config.deckSize} rounds, ${config.mapId} map, seed ${config.seed}`);
  lines.push(`started ${record.startedAt}, exported ${record.exportedAt || '-'}, rules v${record.rulesVersion}, ${record.finished ? 'finished' : `stopped in round ${record.round} (${record.phase})`}${record.fallen ? ', the empire fell' : ''}${record.resumes ? `, resumed ${record.resumes} time(s)` : ''}`);
  lines.push('seats:');
  for (const seat of record.seats || []) lines.push(`  ${seatName(record, seat.playerId)}${seat.dynasty ? ` - ${seat.dynasty}` : ''}`);

  const history = record.gameState?.history || [];
  const rounds = [...new Set([
    ...history.map((event) => Number(event.round) || 0),
    ...record.commands.map((entry) => Number(entry.round) || 0),
  ])].sort((left, right) => left - right);

  for (const round of rounds) {
    lines.push('', `--- Round ${round}`);
    for (const event of history.filter((entry) => Number(entry.round) === round)) {
      if (!event.summary) continue;
      lines.push(`  [${event.phase}] ${event.summary}`);
      const why = event.decision ? describeDecision(event.decision) : '';
      if (why) lines.push(why);
    }
    const commands = record.commands.filter((entry) => Number(entry.round) === round && entry.call !== 'continueAfterResolution');
    if (commands.length) {
      lines.push('  human commands:');
      for (const entry of commands) lines.push(`    ${describeCommand(record, entry)}`);
    }
    const note = record.notes?.[`round-${round}`];
    if (note) lines.push(`  NOTE: ${note}`);
    const snapshot = record.rounds?.find((entry) => entry.round === round);
    if (snapshot) lines.push(describeSnapshot(record, snapshot));
  }

  if (record.finalScores) {
    lines.push('', '--- Final scores');
    for (const score of record.finalScores) {
      const winner = record.winnerIds?.includes(score.playerId) ? ' WINNER' : '';
      lines.push(`  ${seatName(record, score.playerId)}: ${score.points} pts, ${score.gold} gold${winner}`);
    }
  }
  if (record.notes?.game) lines.push('', `GAME NOTE: ${record.notes.game}`);

  if (options.verify) {
    const replay = replayGameRecord(record);
    const same = JSON.stringify(serializeGameState(replay.state)) === JSON.stringify(record.gameState);
    lines.push('', `replay: ${replay.applied} commands, ${replay.mismatches.length} mismatches, ${same ? 'same final state' : 'DIFFERENT final state (other code version?)'}`);
  }
  console.log(lines.join('\n'));
}

const options = parseArgs(process.argv.slice(2));
if (!options.files.length) {
  console.error('Usage: npm run record:report -- <record.json> [...] [--verify] [--json]');
  process.exit(1);
}
for (const path of options.files) {
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (!isGameRecord(record)) {
    console.error(`${path}: not a Basileus game record`);
    process.exitCode = 1;
    continue;
  }
  if (options.json) {
    const { gameState, aiMeta, ...rest } = record;
    void aiMeta;
    console.log(JSON.stringify({ ...rest, history: gameState?.history || [] }, null, 2));
  } else {
    printReport(record, path, options);
  }
}
