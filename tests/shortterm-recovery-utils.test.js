import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceShortTermRecoveryLadder, deriveShortTermResumeEligibility, nextShortTermRecoverySegmentSize,
  reconcileShortTermRecoveryState, shortTermRecoveryPlanRepeatsFailure, validateShortTermRecoveryPlan,
  countShortTermPhysicalAttempts, isShortTermMinimumFloorExhausted,
  createShortTermAttemptAccounting, recordShortTermAttemptEvent,
  finalizeShortTermAttemptAccounting, summarizeShortTermAttemptAccounting,
  advanceShortTermRecoveryGrowth,
  deriveShortTermMissingPlanResumeEligibility,
  deriveShortTermResumePresentation,
  deriveShortTermPhaseProgress,
  reconcileShortTermSegmentLedger,
  SHORTTERM_RECOVERY_SCHEMA_VERSION,
} from '../shortterm-recovery-utils.js';

test('Short-Term phase progress distinguishes durable passes from the current provider request', () => {
  const progress = deriveShortTermPhaseProgress({
    totalSourceMessages: 9435,
    committedSourceMessages: 4820,
    committedPasses: 14,
    committedMessageCounts: [310, 320, 315],
    completedRequestDurationsMs: [3_600_000, 3_900_000, 3_750_000],
    currentRequestMessageCount: 315,
    currentRequestActive: true,
    currentRequestRemainingMs: 900_000,
  });
  assert.equal(progress.committed_passes, 14);
  assert.equal(progress.remaining_source_messages, 4615);
  assert.equal(progress.estimated_messages_per_pass, 315);
  assert.equal(progress.estimated_remaining_passes, 15);
  assert.equal(progress.estimated_future_passes, 14);
  assert.equal(progress.estimated_remaining_ms, 53_400_000);
});

test('Short-Term phase progress does not imply completion when one request reaches its token cap', () => {
  const beforeReset = deriveShortTermPhaseProgress({
    totalSourceMessages: 1000, committedSourceMessages: 400, committedPasses: 4,
    committedMessageCounts: [100, 100, 100], currentRequestMessageCount: 100,
    currentRequestActive: true, currentRequestRemainingMs: 0,
    projectedCurrentRequestDurationMs: 60_000,
  });
  assert.equal(beforeReset.estimated_remaining_passes, 6);
  assert.equal(beforeReset.estimated_future_passes, 5);
  assert.equal(beforeReset.estimated_remaining_ms, 300_000);
  const afterCommit = deriveShortTermPhaseProgress({
    totalSourceMessages: 1000, committedSourceMessages: 500, committedPasses: 5,
    committedMessageCounts: [100, 100, 100, 100], currentRequestActive: false,
    projectedCurrentRequestDurationMs: 60_000,
  });
  assert.equal(afterCommit.estimated_remaining_passes, 5);
  assert.equal(afterCommit.estimated_remaining_ms, 300_000);
});

test('Short-Term phase progress remains indeterminate before pass size or duration evidence exists', () => {
  const progress = deriveShortTermPhaseProgress({
    totalSourceMessages: 1000, committedSourceMessages: 200, committedPasses: 2,
  });
  assert.equal(progress.estimated_remaining_passes, null);
  assert.equal(progress.estimated_remaining_ms, null);
});

test('completed compaction audit does not rewrite inconsistent retained ledger evidence', () => {
  const audit = reconcileShortTermSegmentLedger({
    terminal_outcome: 'completed', successful_segment_commits: 564, segment_attempt_ledger_limit: 32,
    segment_attempt_ledger: Array.from({ length: 32 }, (_, index) => ({
      request_id: `request-${index}`, provider_completed: true, parsed: true,
      committed: false, latest_state: 'response_observed',
    })),
    attempt_accounting: {
      cumulative_physical_transmissions: 564, cumulative_terminal_transmissions: 564,
      restored_prior_physical_transmissions: 0, current_attempt_physical_transmissions: 564,
      active_attempts: {},
    },
  });
  assert.equal(audit.segment_attempt_ledger.every((entry) => entry.committed === false), true);
  assert.equal(audit.ledger_reconciliation.no_terminal_success_stuck, false);
  assert.equal(audit.ledger_reconciliation.terminal_successful_entries_stuck_at_response_observed, 32);
  assert.equal(audit.ledger_reconciliation.active_plus_terminal_equals_physical, true);
});

test('failed compaction never fabricates a committed retained segment', () => {
  const audit = reconcileShortTermSegmentLedger({
    terminal_outcome: 'request_or_compaction_failure', successful_segment_commits: 1,
    segment_attempt_ledger: [{ provider_completed: true, parsed: true, committed: false, latest_state: 'response_observed' }],
  });
  assert.equal(audit.segment_attempt_ledger[0].committed, false);
  assert.equal(audit.ledger_reconciliation.no_terminal_success_stuck, false);
});

test('a missing Short-Term recovery plan fails closed and requires Fresh Start', () => {
  const result = deriveShortTermMissingPlanResumeEligibility({
    checkpointStatus: 'awaiting_manual_resume',
    phaseDisposition: { disposition: 'failed', resumable: true },
    postCommitMarker: null,
    failureState: { operator_action_required: false },
  });
  assert.deepEqual(result, {
    eligible: false, decision: 'fresh_start_required',
    reason: 'shortterm_recovery_plan_missing', conflicts: [],
  });
  assert.deepEqual(deriveShortTermResumePresentation(result, false), {
    disabled: true, label: 'Short-Term Recovery Blocked', mode: 'blocked',
  });
});

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
    schema_version: SHORTTERM_RECOVERY_SCHEMA_VERSION, logical_run_id: 'run', phase: 'shortterm_extraction', message_count: 9,
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

test('old or unsigned Short-Term recovery plans fail closed instead of migrating', () => {
  const base = {
    schema_version: SHORTTERM_RECOVERY_SCHEMA_VERSION,
    logical_run_id: 'run', phase: 'shortterm_extraction', message_count: 9,
    next_segment_start: 0, next_segment_end: 8, source_fingerprint: 'source',
    summary_parent_hash: 'summary', prompt_shape_version: 'shape',
    effective_request_signature: 'request', configuration_signature: 'config',
  };
  const current = {
    logical_run_id: 'run', phase: 'shortterm_extraction', source_start: 0,
    source_end: 8, source_fingerprint: 'source', parent_summary_hash: 'summary',
    prompt_shape_version: 'shape', effective_request_signature: 'request',
    configuration_signature: 'config', minimum_segment_floor: 4,
  };
  const old = validateShortTermRecoveryPlan({ ...base,
    schema_version: SHORTTERM_RECOVERY_SCHEMA_VERSION - 1 }, current);
  assert.equal(old.valid, false);
  assert.equal(old.reason, 'unsupported_recovery_schema_fresh_start_required');
  const unsigned = validateShortTermRecoveryPlan({ ...base,
    configuration_signature: null }, current);
  assert.equal(unsigned.valid, false);
  assert.ok(unsigned.conflicts.some((item) =>
    item.reason === 'missing_configuration_signature_fresh_start_required'));
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

test('durable Short-Term attempt totals remain exact after bounded detail would retain only 64 events', () => {
  let accounting = createShortTermAttemptAccounting({ runId: 'run-a', attemptNumber: 1 });
  for (let index = 0; index < 199; index++) {
    accounting = recordShortTermAttemptEvent(accounting, {
      state: 'in_flight', request_id: `request-${index}`, prompt_visible_message_count: index % 2 ? 8 : 9,
    });
    accounting = recordShortTermAttemptEvent(accounting, {
      state: 'response_observed', request_id: `request-${index}`, response_present: true,
    });
  }
  assert.equal(accounting.current_attempt_physical_transmissions, 199);
  assert.equal(accounting.cumulative_physical_transmissions, 199);
  assert.equal(accounting.current_attempt_terminal_transmissions, 199);
  assert.equal(accounting.terminal_counts.completed, 199);
  assert.equal(accounting.recent_attempt_ids.length, 64);
  assert.equal(accounting.by_segment_size[9], 100);
  assert.equal(accounting.by_segment_size[8], 99);
  assert.equal(accounting.totals_exact, true);
  const summary = summarizeShortTermAttemptAccounting(accounting, { successfulSegmentCommits: 199 });
  assert.equal(summary.reconciliation.current_terminal_plus_active_equals_physical, true);
  assert.equal(summary.reconciliation.successful_commits_do_not_exceed_completed_transmissions, true);
  assert.equal(Object.hasOwn(summary, 'counted_attempt_ids'), false);
});

test('Short-Term attempt accounting resumes from current-schema durable scalars', () => {
  let first = createShortTermAttemptAccounting({ runId: 'run-a', attemptNumber: 1 });
  first = recordShortTermAttemptEvent(first, { state: 'in_flight', request_id: 'one', prompt_visible_message_count: 9 });
  first = recordShortTermAttemptEvent(first, { state: 'request_error', request_id: 'one' });
  let resumed = createShortTermAttemptAccounting({ prior: first, runId: 'run-a', attemptNumber: 2 });
  resumed = recordShortTermAttemptEvent(resumed, { state: 'in_flight', request_id: 'two', prompt_visible_message_count: 9 });
  resumed = recordShortTermAttemptEvent(resumed, { state: 'response_observed', request_id: 'two', response_present: true });
  assert.equal(resumed.restored_prior_physical_transmissions, 1);
  assert.equal(resumed.current_attempt_physical_transmissions, 1);
  assert.equal(resumed.cumulative_physical_transmissions, 2);
  assert.deepEqual(resumed.cumulative_terminal_counts, {
    completed: 1, failed: 1, cancelled: 0, interrupted: 0, fallback_replaced: 0,
  });
});

test('old Short-Term attempt accounting fails closed and requires Fresh Start', () => {
  assert.throws(() => createShortTermAttemptAccounting({
    prior: { schema_version: 1, physical_provider_attempts: 64 },
    runId: 'run-a', attemptNumber: 2,
  }), (error) => error?.code === 'SME_FRESH_START_REQUIRED'
    && error?.sme_reason_code === 'shortterm_attempt_accounting_schema_unsupported');
});

test('Short-Term attempt lifecycle distinguishes a fallback transmission and interruption', () => {
  let accounting = createShortTermAttemptAccounting();
  accounting = recordShortTermAttemptEvent(accounting, { state: 'in_flight', request_id: 'request-1' });
  accounting = recordShortTermAttemptEvent(accounting, { state: 'provider_diagnostic', request_id: 'request-1',
    endpoint_category: 'proxy-fallback', predecessor_endpoint_category: 'direct-stream' });
  accounting = finalizeShortTermAttemptAccounting(accounting, 'interrupted');
  assert.equal(accounting.cumulative_physical_transmissions, 2);
  assert.equal(accounting.terminal_counts.fallback_replaced, 1);
  assert.equal(accounting.terminal_counts.interrupted, 1);
});

test('a persisted in-flight Short-Term transmission becomes interrupted exactly once after restart', () => {
  let prior = createShortTermAttemptAccounting({ runId: 'run-a', attemptNumber: 1 });
  prior = recordShortTermAttemptEvent(prior, { state: 'in_flight', request_id: 'in-flight' });
  const restored = createShortTermAttemptAccounting({ prior, runId: 'run-a', attemptNumber: 2 });
  assert.equal(restored.cumulative_physical_transmissions, 1);
  assert.equal(restored.restored_interrupted_transmissions, 1);
  assert.equal(restored.cumulative_terminal_counts.interrupted, 1);
  assert.deepEqual(restored.active_attempts, {});
});

test('adaptive Short-Term recovery grows only after stable successes with context headroom', () => {
  let growth = {};
  for (let index = 0; index < 3; index++) growth = advanceShortTermRecoveryGrowth(growth, {
    successfulSegmentSize: 9, estimatedInputTokens: 1800, requestedOutputTokens: 1000,
    effectiveContextLimit: 8192, configurationSignature: 'same',
  });
  assert.equal(growth.proposed_segment_size, 9);
  growth = advanceShortTermRecoveryGrowth(growth, {
    successfulSegmentSize: 9, estimatedInputTokens: 1800, requestedOutputTokens: 1000,
    effectiveContextLimit: 8192, configurationSignature: 'same',
  });
  assert.equal(growth.decision, 'grow_after_stable_successes');
  assert.equal(growth.proposed_segment_size, 14);
  const held = advanceShortTermRecoveryGrowth(growth, {
    successfulSegmentSize: 14, estimatedInputTokens: 7000, requestedOutputTokens: 1000,
    effectiveContextLimit: 8192, configurationSignature: 'same', requiredSuccesses: 1,
  });
  assert.equal(held.decision, 'hold_context_headroom_insufficient');
  assert.equal(held.proposed_segment_size, 14);
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
