import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceShortTermRecoveryLadder, nextShortTermRecoverySegmentSize, shortTermRecoveryPlanRepeatsFailure } from '../shortterm-recovery-utils.js';

test('Short-Term reduction ladder replaces 84 messages with 42 and stops at its floor', () => {
  assert.equal(nextShortTermRecoverySegmentSize(169, 4), 85);
  assert.equal(nextShortTermRecoverySegmentSize(84, 4), 42);
  assert.equal(nextShortTermRecoverySegmentSize(5, 4), 4);
  assert.equal(nextShortTermRecoverySegmentSize(4, 4), null);
});

test('Short-Term ladder retains per-size and cumulative failures across restarts', () => {
  const first = advanceShortTermRecoveryLadder({}, 84, 4);
  const restored = JSON.parse(JSON.stringify(first));
  const second = advanceShortTermRecoveryLadder(restored, 42, 4);
  assert.equal(second.total_failures, 2);
  assert.deepEqual(second.failures_by_segment_size, { 42: 1, 84: 1 });
  assert.deepEqual(second.reductions_attempted, [84, 42]);
  assert.equal(second.smallest_segment_attempted, 42);
});

test('Resume rejects a plan whose effective signature repeats the exhausted request', () => {
  assert.equal(shortTermRecoveryPlanRepeatsFailure(
    { effective_request_signature: 'same' }, { failure_signature: 'same' },
  ), true);
  assert.equal(shortTermRecoveryPlanRepeatsFailure(
    { effective_request_signature: 'smaller' }, { failure_signature: 'parent' },
  ), false);
});
