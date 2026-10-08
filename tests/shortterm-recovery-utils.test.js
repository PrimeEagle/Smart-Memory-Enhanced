import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceShortTermRecoveryLadder, deriveShortTermResumeEligibility, nextShortTermRecoverySegmentSize,
  reconcileShortTermRecoveryState, shortTermRecoveryPlanRepeatsFailure, validateShortTermRecoveryPlan,
  countShortTermPhysicalAttempts, isShortTermMinimumFloorExhausted, migrateCommittedShortTermFailureState,
} from '../shortterm-recovery-utils.js';

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
    { effective_request_signature: 'same' }, { failure_signature: 'same', last_failed_request: {
      source_start: 10, source_end: 17, effective_request_signature: 'same', dispatched: true,
    } },
  ), true);
  assert.equal(shortTermRecoveryPlanRepeatsFailure(
    { effective_request_signature: 'smaller' }, { failure_signature: 'parent' },
  ), false);
});

test('verified nine-message plan remains authoritative over a synthetic below-floor history entry', () => {
  const plan = { message_count: 9, effective_request_signature: 'next', next_segment_start: 7636, next_segment_end: 7644 };
  const result = reconcileShortTermRecoveryState({
    plan, validation: { valid: true, conflicts: [] }, minimumSegmentFloor: 4,
    failureState: { recovery_ladder: { failures_by_segment_size: { 18: 1, 1: 1 } } },
    currentAttempt: { physical_provider_attempts: 0, segment_sizes_attempted: [], retained_events: [] },
    cumulative: { physical_provider_attempts: 2, segment_sizes_attempted: [18] },
  });
  assert.equal(result.verified_next_plan.message_count, 9);
  assert.equal(result.next_legal_action, 'dispatch_verified_plan');
  assert.deepEqual(result.quarantined_synthetic_ladder_sizes, [1]);
  assert.equal(result.current_attempt_physical_attempts, 0);
  assert.equal(result.cumulative_physical_attempts, 2);
});

test('pre-dispatch null-range failure does not advance the ladder or become a one-message failure', () => {
  const ladder = advanceShortTermRecoveryLadder({ total_failures: 1, failures_by_segment_size: { 18: 1 } }, null, 4, {
    dispatched: false, require_range: true,
  });
  assert.equal(ladder.total_failures, 1);
  assert.deepEqual(ladder.failures_by_segment_size, { 18: 1 });
  assert.equal(ladder.ignored_predispatch_failures, 1);
  assert.equal(shortTermRecoveryPlanRepeatsFailure({ effective_request_signature: 'plan' }, {
    failure_signature: 'plan', last_failed_request: { source_start: null, source_end: null, dispatched: false },
  }), false);
});

test('recovery plan validation reports exact parent, source, configuration, and floor conflicts', () => {
  const plan = {
    schema_version: 5, logical_run_id: 'run', phase: 'shortterm_extraction', message_count: 9,
    next_segment_start: 7636, next_segment_end: 7644, source_fingerprint: 'source-a',
    summary_parent_hash: 'summary-a', prompt_shape_version: 'v3', effective_request_signature: 'request-a',
    configuration_signature: 'config-a', minimum_segment_floor: 4,
  };
  assert.equal(validateShortTermRecoveryPlan(plan, {
    logical_run_id: 'run', phase: 'shortterm_extraction', source_start: 7636, source_end: 7644,
    source_fingerprint: 'source-a', parent_summary_hash: 'summary-a', prompt_shape_version: 'v3',
    effective_request_signature: 'request-a', configuration_signature: 'config-a', minimum_segment_floor: 4,
  }).valid, true);
  const invalid = validateShortTermRecoveryPlan(plan, {
    logical_run_id: 'run', phase: 'shortterm_extraction', source_start: 7636, source_end: 7644,
    source_fingerprint: 'source-b', parent_summary_hash: 'summary-b', prompt_shape_version: 'v3',
    effective_request_signature: 'request-b', configuration_signature: 'config-b', minimum_segment_floor: 10,
  });
  assert.deepEqual(new Set(invalid.conflicts.map((item) => item.reason)), new Set([
    'source_fingerprint_mismatch', 'parent_summary_mismatch', 'effective_request_signature_mismatch',
    'configuration_changed', 'minimum_floor_violation',
  ]));
});

test('UI and backend use the same authoritative Resume eligibility decision', () => {
  const safe = deriveShortTermResumeEligibility({ checkpointStatus: 'awaiting_manual_resume',
    plan: { message_count: 9 }, validation: { valid: true } });
  assert.deepEqual(safe, { eligible: true, decision: 'ordinary_resume_safe', reason: 'verified_recovery_plan_available' });
  const blocked = deriveShortTermResumeEligibility({ checkpointStatus: 'awaiting_manual_resume',
    plan: { message_count: 9 }, validation: { valid: false, reason: 'parent_summary_mismatch', conflicts: [] } });
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.decision, 'plan_revalidation_required');
  const reconstruct = deriveShortTermResumeEligibility({ checkpointStatus: 'awaiting_manual_resume',
    postCommitMarker: { committed_boundary: 7645, committed_summary_hash: 'summary-b' } });
  assert.deepEqual(reconstruct, { eligible: true, decision: 'reconstruct_successor_from_committed_boundary',
    reason: 'committed_progress_without_active_successor' });
});

test('one transmitted request remains one physical attempt across lifecycle diagnostics', () => {
  const result = countShortTermPhysicalAttempts([
    { state: 'in_flight', request_id: 'request-1' },
    { state: 'provider_diagnostic', request_id: 'request-1', endpoint_category: 'direct-stream' },
    { state: 'provider_diagnostic', request_id: 'request-1', endpoint_category: 'direct-stream' },
    { state: 'response_observed', request_id: 'request-1' },
  ]);
  assert.equal(result.physical_provider_attempts, 1);
  assert.deepEqual(result.provider_attempt_ids, ['request-1:primary']);
});

test('a linked fallback is a distinct physical transmission but duplicate fallback diagnostics are not', () => {
  const result = countShortTermPhysicalAttempts([
    { state: 'in_flight', request_id: 'request-1' },
    { state: 'provider_diagnostic', request_id: 'request-1', endpoint_category: 'direct-stream',
      terminal_adaptation: 'same_provider_proxy_nonstream_retry' },
    { state: 'provider_diagnostic', request_id: 'request-1', endpoint_category: 'sillytavern-proxy-fallback',
      predecessor_endpoint_category: 'direct-stream' },
  ]);
  assert.equal(result.physical_provider_attempts, 2);
  assert.deepEqual(result.provider_attempt_ids, ['request-1:primary', 'request-1:fallback']);
});

test('a committed predecessor is removed from the false failure ladder exactly once', () => {
  const migrated = migrateCommittedShortTermFailureState({
    failure_signature: 'request-9', operator_action_required: true,
    last_failed_request: { source_start: 7636, source_end: 7644, message_count: 9 },
    recovery_ladder: { total_failures: 3, failures_by_segment_size: { 18: 1, 9: 1, 1: 1 },
      reductions_attempted: [18, 9, 1], smallest_segment_attempted: 1,
      last_actual_dispatched_request: { source_start: 7636, source_end: 7644, message_count: 9 } },
  }, { committedBoundary: 7645, committedSummaryHash: 'summary-b', committedPlan: {
    next_segment_start: 7636, next_segment_end: 7644, message_count: 9,
  } });
  assert.equal(migrated.migrated, true);
  assert.deepEqual(migrated.failure_state.recovery_ladder.failures_by_segment_size, { 18: 1, 1: 1 });
  assert.equal(migrated.failure_state.recovery_ladder.total_failures, 2);
  assert.equal(migrated.failure_state.operator_action_required, false);
  const repeated = migrateCommittedShortTermFailureState(migrated.failure_state, {
    committedBoundary: 7645, committedSummaryHash: 'summary-b', committedPlan: {
      next_segment_start: 7636, next_segment_end: 7644, message_count: 9,
    },
  });
  assert.equal(repeated.migrated, false);
});

test('minimum-floor exhaustion requires a failed pending transmission at or below the floor', () => {
  const base = { dispatched: true, failedBeforeCommit: true, segmentSize: 4, minimumSegmentFloor: 4,
    sourceStart: 7645, sourceEnd: 7648, committedBoundary: 7645,
    configurationSignature: 'config', currentConfigurationSignature: 'config', alternateRecoveryAvailable: false };
  assert.equal(isShortTermMinimumFloorExhausted(base), true);
  assert.equal(isShortTermMinimumFloorExhausted({ ...base, segmentSize: 9 }), false);
  assert.equal(isShortTermMinimumFloorExhausted({ ...base, failedBeforeCommit: false }), false);
  assert.equal(isShortTermMinimumFloorExhausted({ ...base, sourceStart: 7636, sourceEnd: 7644 }), false);
  assert.equal(isShortTermMinimumFloorExhausted({ ...base, alternateRecoveryAvailable: true }), false);
});
