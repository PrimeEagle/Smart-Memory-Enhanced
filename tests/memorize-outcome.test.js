import test from 'node:test';
import assert from 'node:assert/strict';

import {
  completedMemorizeOutcome,
  createMemorizeOutcome,
  isMemorizeOutcome,
  memorizeOutcomeFromException,
} from '../memorize-outcome.js';
import { getMemorizeReason, normalizeMemorizeReasonCode } from '../memorize-reasons.js';

test('canonical outcomes carry one stable reason and next action', () => {
  const outcome = createMemorizeOutcome({
    kind: 'paused',
    reason_code: 'recovery_request_budget_reached_with_pending_children',
    obligation_id: 'session:1-20',
  });
  assert.equal(isMemorizeOutcome(outcome), true);
  assert.equal(outcome.resumable, true);
  assert.equal(outcome.next_action, 'resume_exact_obligation');
  assert.equal(outcome.obligation_id, 'session:1-20');
  assert.equal(Object.isFrozen(outcome), true);
});

test('operational-pause exceptions normalize at the execution boundary', () => {
  const error = Object.assign(new Error('bounded recovery pause'), {
    code: 'recovery_request_budget_reached_with_pending_children',
    sme_operational_pause: true,
    sme_request_diagnostics: {
      root_obligation_id: 'longterm:a:1-20',
      next_eligible_recovery_action: 'split_range',
    },
  });
  const outcome = memorizeOutcomeFromException(error);
  assert.equal(outcome.kind, 'paused');
  assert.equal(outcome.reason_code, 'recovery_request_budget_reached_with_pending_children');
  assert.equal(outcome.next_action, 'split_range');
  assert.equal(outcome.obligation_id, 'longterm:a:1-20');
});

test('reason registry preserves unknown durable codes without silently aliasing them', () => {
  assert.equal(normalizeMemorizeReasonCode('SME_NEW_PATH'), 'new_path');
  assert.equal(getMemorizeReason('SME_NEW_PATH').unregistered, true);
  assert.equal(completedMemorizeOutcome(4).value, 4);
});

