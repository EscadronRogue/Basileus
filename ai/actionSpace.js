export const AI_ACTION_KINDS = Object.freeze({
  APPOINTMENT: 'appointment',
  LAND_PURCHASE: 'land_purchase',
  CHURCH_GIFT: 'church_gift',
  RECRUIT: 'recruit',
  DISMISS: 'dismiss',
  MERCENARY_HIRE: 'mercenary_hire',
  REVOCATION: 'revocation',
  ORDERS: 'orders',
  DEAL: 'deal',
  DEFENDER_REWARD: 'defender_reward',
  TITLE_ASSIGNMENT: 'title_assignment',
});

export const AI_ACTION_PHASES = Object.freeze({
  COURT: 'court',
  ORDERS: 'orders',
  RESOLUTION: 'resolution',
});

const DEFAULT_DESCRIPTOR = {
  phase: AI_ACTION_PHASES.COURT,
  payload: {},
  costs: {},
  gains: {},
  commitments: {},
  affectedPlayers: [],
  beneficiaries: [],
  targets: [],
  tags: [],
  timing: 'immediate',
  reversibility: 'medium',
  baseScore: 0,
};

function cleanNumberRecord(record = {}) {
  return Object.fromEntries(
    Object.entries(record || {})
      .map(([key, value]) => [key, Number(value) || 0])
      .filter(([, value]) => value !== 0),
  );
}

function uniqueNumbers(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map(value => Number(value))
      .filter(Number.isInteger),
  )];
}

function normalizeList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values]).filter(value => value != null))];
}

export function createActionDescriptor(raw = {}) {
  const descriptor = {
    ...DEFAULT_DESCRIPTOR,
    ...raw,
    kind: String(raw.kind || '').trim(),
    phase: String(raw.phase || DEFAULT_DESCRIPTOR.phase).trim(),
    actorId: Number(raw.actorId),
    payload: raw.payload && typeof raw.payload === 'object' ? { ...raw.payload } : {},
    costs: cleanNumberRecord(raw.costs),
    gains: cleanNumberRecord(raw.gains),
    commitments: cleanNumberRecord(raw.commitments),
    affectedPlayers: uniqueNumbers(raw.affectedPlayers),
    beneficiaries: uniqueNumbers(raw.beneficiaries),
    targets: uniqueNumbers(raw.targets),
    tags: normalizeList(raw.tags),
    timing: String(raw.timing || DEFAULT_DESCRIPTOR.timing),
    reversibility: String(raw.reversibility || DEFAULT_DESCRIPTOR.reversibility),
    baseScore: Number(raw.baseScore) || 0,
  };

  if (!descriptor.kind) {
    throw new Error('AI action descriptor requires a kind.');
  }
  if (!Number.isInteger(descriptor.actorId)) {
    throw new Error('AI action descriptor requires an actorId.');
  }
  descriptor.family = getActionFamily(descriptor);
  return descriptor;
}

export function getActionFamily(descriptor) {
  const kind = String(descriptor?.kind || '');
  if (
    kind === AI_ACTION_KINDS.APPOINTMENT
    || kind === AI_ACTION_KINDS.REVOCATION
    || kind === AI_ACTION_KINDS.TITLE_ASSIGNMENT
  ) return 'political';
  if (
    kind === AI_ACTION_KINDS.RECRUIT
    || kind === AI_ACTION_KINDS.DISMISS
    || kind === AI_ACTION_KINDS.MERCENARY_HIRE
    || kind === AI_ACTION_KINDS.ORDERS
  ) return 'military';
  if (kind === AI_ACTION_KINDS.LAND_PURCHASE || kind === AI_ACTION_KINDS.CHURCH_GIFT) return 'economic';
  if (kind === AI_ACTION_KINDS.DEAL) return 'diplomatic';
  if (kind === AI_ACTION_KINDS.DEFENDER_REWARD) return 'recovery';
  return 'general';
}

export function actionDescriptorKey(descriptor) {
  const payload = descriptor?.payload || {};
  const suffix = [
    payload.themeId,
    payload.officeKey,
    payload.titleType,
    payload.targetPlayerId,
    payload.candidateId,
    payload.counterpartyId,
    payload.choice,
  ].filter(value => value != null).join(':');
  return `${descriptor?.phase || 'phase'}:${descriptor?.kind || 'kind'}:${descriptor?.actorId}:${suffix}`;
}

export function withActionDescriptor(action, descriptor) {
  return {
    ...action,
    descriptor,
  };
}

export function withActionEvaluation(action, evaluation) {
  return {
    ...action,
    consequence: evaluation,
    score: evaluation?.score ?? action.score,
  };
}
