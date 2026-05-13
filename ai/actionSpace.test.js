import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_ACTION_KINDS,
  AI_ACTION_PHASES,
  actionDescriptorKey,
  createActionDescriptor,
  getActionFamily,
} from './actionSpace.js';

test('action descriptors normalize every strategic action family', () => {
  for (const kind of Object.values(AI_ACTION_KINDS)) {
    const descriptor = createActionDescriptor({
      kind,
      phase: kind === AI_ACTION_KINDS.ORDERS ? AI_ACTION_PHASES.ORDERS : AI_ACTION_PHASES.COURT,
      actorId: 0,
      payload: { themeId: 'THR', counterpartyId: 1, candidateId: 0 },
      costs: { gold: '2' },
      gains: { troops: 1 },
      targets: [1, '1'],
      beneficiaries: [0],
    });

    assert.equal(descriptor.kind, kind);
    assert.equal(descriptor.actorId, 0);
    assert.equal(descriptor.costs.gold, 2);
    assert.deepEqual(descriptor.targets, [1]);
    assert.equal(typeof getActionFamily(descriptor), 'string');
    assert.match(actionDescriptorKey(descriptor), new RegExp(kind));
  }
});

test('action descriptor rejects missing essentials', () => {
  assert.throws(() => createActionDescriptor({ actorId: 0 }), /kind/);
  assert.throws(() => createActionDescriptor({ kind: AI_ACTION_KINDS.DEAL }), /actorId/);
});
