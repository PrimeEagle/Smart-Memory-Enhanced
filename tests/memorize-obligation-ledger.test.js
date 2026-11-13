import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createMemorizeObligationLedger,
  ensureMemorizeObligationLedger,
  projectMemorizeObligationLedger,
  reconcileMemorizeProviderRuntime,
  reconcileMemorizeRunningObligations,
  recordMemorizeControllerExit,
  transitionMemorizeObligation,
} from '../memorize-obligation-ledger.js';
import {
  buildAutomaticRecoveryFullChatReplay,
  buildFullChatReplay,
  replayExhaustedSessionRecoveryResume,
  runMemorizeReplay,
} from '../memorize-replay-harness.js';
import { repairSessionCandidateShapes } from '../session-candidate-utils.js';
import {
  beginProviderAttempt,
  finishProviderAttempt,
  markProviderDownstreamOutcome,
  markProviderObligationOperationalPause,
  markProviderObligationRecoveryInProgress,
  markProviderRejectedFragmentsRecovered,
  readProviderRecoveryWindowState,
  stageProviderRejectedFragments,
  summarizeProviderAttemptAudit,
} from '../provider-attempt-audit.js';

const sessionId = 'session:chat:640-659:fnv1a-4ee9852e';
const sessionInput = { obligation_id: sessionId, logical_run_id: 'run', tier: 'session', source_range: { start: 640, end: 659 }, source_fingerprint: 'fnv1a-4ee9852e' };

test('current-schema interrupted provider state repairs to exact pending work', () => {
  const ledger = createMemorizeObligationLedger('run');
  ledger.obligations[sessionId] = {
    ...sessionInput, current_state: 'provider_running', checkpoint_eligible: false,
    exact_reason_code: 'provider_request_in_progress', next_eligible_action: null,
    persistence_result: 'not_committed', provider_attempt_lineage: ['provider-188', 'provider-192'],
    metrics: { persisted_records: 1, unresolved_parser_fragments: 2,
      producing_provider_attempt_id: 'provider-188' }, timestamps: {},
    lifecycle: {
      parser_accepted_candidate_ids: ['candidate-1'],
      parser_rejected_fragment_ids: ['fragment-1', 'fragment-2'],
      downstream_accepted_candidate_ids: ['candidate-1'],
      durably_persisted_record_ids: ['record-1'],
      durable_record_candidate_map: { 'record-1': 'candidate-1' },
      unresolved_fragment_ids: ['fragment-1', 'fragment-2'],
    },
  };
  const repaired = reconcileMemorizeRunningObligations(ledger, { recent_attempts: [
    { attempt_id: 'provider-192', logical_obligation_id: sessionId, terminal_outcome: 'provider_response_malformed' },
  ] });
  const obligation = repaired.ledger.obligations[sessionId];
  assert.equal(repaired.repairs.length, 1);
  assert.equal(obligation.current_state, 'pending_recovery');
  assert.equal(obligation.next_eligible_action, 'recover_unresolved_partial_output_fragments');
  assert.equal(obligation.persistence_result, 'partial_records_committed');
  assert.equal(obligation.partial_record_persistence.persisted_record_count, 1);
  assert.equal(projectMemorizeObligationLedger(repaired.ledger).invariants.valid, true);
});

test('old obligation-ledger schemas fail closed and require Fresh Start', () => {
  assert.throws(() => ensureMemorizeObligationLedger({
    schema_version: 1, implementation_version: 2, normalization_complete: true,
    logical_run_id: 'old-run', obligations: {},
  }, 'old-run'), (error) => error.code === 'SME_MEMORIZE_SCHEMA_UNSUPPORTED'
    && error.sme_reason_code === 'fresh_start_required');
});

test('provider-running requires a registered physical attempt and partial persistence never downgrades', () => {
  const ledger = createMemorizeObligationLedger('run');
  transitionMemorizeObligation(ledger, sessionInput, {
    current_state: 'pending_recovery', exact_reason_code: 'partial_valid_output_has_unresolved_fragments',
    next_eligible_action: 'recover_unresolved_partial_output_fragments',
    persistence_result: 'partial_records_committed', metrics: { persisted_records: 1 },
    lifecycle: {
      parser_accepted_candidate_ids: ['candidate-1'],
      downstream_accepted_candidate_ids: ['candidate-1'],
      durably_persisted_record_ids: ['record-1'],
      durable_record_candidate_map: { 'record-1': 'candidate-1' },
    },
  });
  const refused = transitionMemorizeObligation(ledger, sessionInput, {
    current_state: 'provider_running', persistence_result: 'not_committed',
  });
  assert.equal(refused.current_state, 'pending_recovery');
  assert.equal(refused.exact_reason_code, 'provider_attempt_registration_required');
  assert.equal(refused.persistence_result, 'partial_records_committed');
  assert.equal(refused.partial_record_persistence.persisted_record_count, 1);
});

test('provider runtime reconciliation identifies ledger/audit mismatches exactly', () => {
  const ledger = createMemorizeObligationLedger('run');
  transitionMemorizeObligation(ledger, sessionInput, {
    current_state: 'provider_running', provider_attempt_id: 'provider-1',
    exact_reason_code: 'provider_request_in_progress',
  });
  const result = reconcileMemorizeProviderRuntime(ledger, { recent_attempts: [] });
  assert.equal(result.consistent, false);
  assert.equal(result.violations.some((item) => item.code === 'ledger_provider_running_without_physical_attempt'), true);
});

test('Session 640-659 downstream rejection remains exact pending recovery', () => {
  const ledger = createMemorizeObligationLedger('run');
  transitionMemorizeObligation(ledger, sessionInput, { current_state: 'parser_partial', parser_result: 'one accepted, two rejected', exact_reason_code: 'partial_valid_output_has_unresolved_fragments', metrics: { parser_accepted_records: 1, parser_rejected_fragments: 2 } });
  transitionMemorizeObligation(ledger, sessionInput, { current_state: 'pending_recovery', downstream_validation_result: 'rejected_invalid_candidate_shape', persistence_result: 'not_committed', coverage_result: 'pending', exact_reason_code: 'invalid_candidate_shape', next_eligible_action: 'session_validation_repair_or_bounded_regeneration', recovery_intent: 'recover_unresolved_partial_output_fragments', recovery_stage: 'compact_response_repair' });
  const result = projectMemorizeObligationLedger(ledger);
  assert.equal(result.pending_obligation_count, 1);
  assert.equal(result.next_eligible_obligation.obligation_id, sessionId);
  assert.equal(result.next_eligible_obligation.checkpoint_eligible, false);
  assert.equal(result.next_eligible_obligation.recovery_intent, 'recover_unresolved_partial_output_fragments');
  assert.equal(result.next_eligible_obligation.recovery_stage, 'compact_response_repair');
  assert.equal(result.tier_coverage.session.coverage_complete, false);
  assert.equal(result.chunks[0].status, 'pending_session_recovery');
  assert.equal(result.invariants.valid, true);
});

test('provider response completion cannot bypass downstream validation', () => {
  const metadata = { active_catchup_run_id: 'run' };
  const attempt = beginProviderAttempt(metadata, {
    logical_obligation_id: sessionId, tier: 'session', source_range: { start: 640, end: 659 },
    source_fingerprint: 'fnv1a-4ee9852e', root_source_range: { start: 640, end: 659 },
  });
  finishProviderAttempt(metadata, attempt, { terminal_outcome: 'completed', notice_reason: 'partial_valid_output' });
  markProviderDownstreamOutcome(metadata, sessionId, {
    validation_accepted: false, persistence_committed: false,
    rejected_count: 1, reason_code: 'invalid_candidate_shape',
    unresolved_semantic_requirements: true,
  });
  const obligation = metadata.live_memory_health.provider_attempt_audit.obligations[sessionId];
  assert.equal(attempt.terminal_outcome, 'completed');
  assert.equal(attempt.checkpoint_eligible, false);
  assert.equal(obligation.terminal_outcome, 'pending_recovery');
  assert.equal(obligation.checkpoint_eligible, false);
  const summary = summarizeProviderAttemptAudit(metadata);
  assert.equal(summary.retained_attempts[0].root_obligation_id, sessionId);
  assert.equal(summary.retained_attempts[0].logical_run_id, 'run');
  assert.equal(summary.reconciliation.physical_attempts_without_root_obligation_id, 0);
  assert.equal(summary.terminal_unresolved_obligations[0].root_obligation_id, sessionId);
  assert.equal(summary.reconciliation.authoritative_unresolved_count, 1);
  assert.equal(summary.reconciliation.retained_unresolved_detail_count, 1);
  assert.equal(summary.reconciliation.unresolved_count_consistent, true);
});

test('rejected fragments survive a recovery boundary but raw text stays out of diagnostics', () => {
  const metadata = { active_catchup_run_id: 'run-fragment-resume' };
  const attempt = beginProviderAttempt(metadata, {
    logical_obligation_id: sessionId, tier: 'session', source_range: { start: 640, end: 659 },
    source_fingerprint: 'fnv1a-4ee9852e', request_kind: 'original',
  });
  finishProviderAttempt(metadata, attempt, { terminal_outcome: 'completed', notice_reason: 'partial_valid_output' });
  stageProviderRejectedFragments(metadata, sessionId, 'fnv1a-4ee9852e', [{
    fragment_id: 'session-fragment-3-fnv1a-test', raw: '[detail:2:session:sources=1:sources=2] private claim',
    reason_codes: ['duplicate_source_modifier'],
  }], { producing_attempt_id: attempt.attempt_id });
  const restored = readProviderRecoveryWindowState(metadata, sessionId, 'fnv1a-4ee9852e');
  assert.equal(restored.unresolved_fragments.length, 1);
  assert.equal(restored.unresolved_fragments[0].producing_attempt_id, attempt.attempt_id);
  assert.equal(JSON.stringify(summarizeProviderAttemptAudit(metadata)).includes('private claim'), false);
  markProviderRejectedFragmentsRecovered(metadata, sessionId, 'fnv1a-4ee9852e',
    ['session-fragment-3-fnv1a-test']);
  assert.equal(readProviderRecoveryWindowState(metadata, sessionId, 'fnv1a-4ee9852e').unresolved_fragments.length, 0);
});

test('bounded recovery exhaustion is one operational pause rather than a terminal failure', () => {
  const metadata = { active_catchup_run_id: 'run-operational-pause' };
  const attempt = beginProviderAttempt(metadata, {
    logical_obligation_id: sessionId, tier: 'session', source_range: { start: 640, end: 659 },
    source_fingerprint: 'fnv1a-4ee9852e', request_kind: 'original',
  });
  finishProviderAttempt(metadata, attempt, {
    terminal_outcome: 'completed', notice_reason: 'partial_valid_output',
    accepted_candidate_count: 3, rejected_candidate_count: 1, total_candidate_count: 4,
  });
  markProviderDownstreamOutcome(metadata, sessionId, {
    validation_accepted: true, persistence_committed: true, accepted_count: 3, rejected_count: 1,
    reason_code: 'partial_valid_output_has_unresolved_fragments', unresolved_semantic_requirements: true,
  });
  markProviderObligationOperationalPause(metadata, sessionId, {
    reason_code: 'automatic_partial_recovery_exhausted',
    recovery_intent: 'recover_unresolved_partial_output_fragments',
    recovery_stage: 'bounded_recovery_exhausted', consumed_requests: 4, remaining_requests: 0,
    fresh_budget_on_resume: true,
  });
  const summary = summarizeProviderAttemptAudit(metadata);
  assert.equal(summary.operational_pause_count, 1);
  assert.equal(summary.failure_accounting.operationally_paused_obligation_count, 1);
  assert.equal(summary.failure_accounting.terminal_unresolved_obligation_count, 0);
  assert.equal(summary.coverage.operationally_paused_obligations, 1);
  assert.equal(summary.coverage.terminal_failed_obligations, 0);
});

test('automatic recovery in progress accounts for the failed obligation without reporting it unresolved', () => {
  const metadata = { active_catchup_run_id: 'run-recovery-in-progress' };
  const attempt = beginProviderAttempt(metadata, {
    logical_obligation_id: sessionId, tier: 'session', source_range: { start: 640, end: 659 },
    source_fingerprint: 'fnv1a-4ee9852e', request_kind: 'original',
  });
  finishProviderAttempt(metadata, attempt, {
    terminal_outcome: 'completed', notice_reason: 'partial_valid_output',
    accepted_candidate_count: 3, rejected_candidate_count: 1, total_candidate_count: 4,
  });
  markProviderDownstreamOutcome(metadata, sessionId, {
    validation_accepted: true, persistence_committed: true, accepted_count: 3, rejected_count: 1,
    reason_code: 'partial_valid_output_has_unresolved_fragments', unresolved_semantic_requirements: true,
  });
  markProviderObligationRecoveryInProgress(metadata, sessionId, {
    recovery_intent: 'recover_unresolved_partial_output_fragments',
    recovery_stage: 'compact_response_repair',
  });
  const summary = summarizeProviderAttemptAudit(metadata);
  assert.equal(summary.failure_accounting.recovery_in_progress_obligation_count, 1);
  assert.equal(summary.failure_accounting.terminal_unresolved_obligation_count, 0);
  assert.equal(summary.terminal_unresolved_obligations.length, 0);
  assert.equal(summary.reconciliation.recovered_plus_unresolved_equals_unique_failed, true);
  assert.equal(summary.reconciliation.malformed_obligations_reconcile, true);
  assert.equal(summary.coverage.terminal_failed_obligations, 0);
});

test('representation-only candidate repair requires no provider call', () => {
  const first = 'A'.repeat(120) + '.';
  const second = 'B'.repeat(120) + '.';
  const repaired = repairSessionCandidateShapes([{ type: 'detail', content: `${first} ${second}`, source_message_indices: [2] }]);
  assert.equal(repaired.repaired_count, 1);
  assert.equal(repaired.records.length, 2);
  assert.equal(repaired.rejected.length, 0);
  assert.deepEqual(repaired.records.map((item) => item.source_message_indices), [[2], [2]]);
});

test('genuinely invalid single claim remains bounded recovery work', () => {
  const repaired = repairSessionCandidateShapes([{ type: 'detail', content: 'X'.repeat(300), source_message_indices: [2] }]);
  assert.equal(repaired.records.length, 0);
  assert.equal(repaired.rejected[0].reason_code, 'invalid_candidate_shape');
});

test('validated no-update explicitly closes a Session range', () => {
  const ledger = createMemorizeObligationLedger('run');
  transitionMemorizeObligation(ledger, sessionInput, { current_state: 'explicit_no_update', downstream_validation_result: 'validated_duplicate_only_no_update', persistence_result: 'not_required' });
  const result = projectMemorizeObligationLedger(ledger);
  assert.equal(result.pending_obligation_count, 0);
  assert.equal(result.safely_committed_obligation_count, 1);
});

test('every resumable exit retains exact reason and next action', () => {
  const ledger = createMemorizeObligationLedger('run');
  transitionMemorizeObligation(ledger, sessionInput, { current_state: 'pending_recovery', exact_reason_code: 'invalid_candidate_shape', next_eligible_action: 'session_validation_repair_or_bounded_regeneration' });
  recordMemorizeControllerExit(ledger, { reason_code: 'invalid_candidate_shape', classification: 'downstream_validation_pending', obligation_id: sessionId, next_eligible_action: 'session_validation_repair_or_bounded_regeneration' });
  const result = projectMemorizeObligationLedger(ledger);
  assert.equal(result.last_controller_exit.reason_code, 'invalid_candidate_shape');
  assert.equal(result.last_controller_exit.next_eligible_action, 'session_validation_repair_or_bounded_regeneration');
  assert.equal(result.invariants.valid, true);
});

test('crash/reload retains exact obligation and deduplicates record identity', () => {
  const first = runMemorizeReplay({ logicalRunId: 'run', obligations: [sessionInput], events: [
    { obligation_id: sessionId, current_state: 'pending_recovery', exact_reason_code: 'invalid_candidate_shape', next_eligible_action: 'session_validation_repair_or_bounded_regeneration' },
    { type: 'controller_exit', reason_code: 'page_interruption', obligation_id: sessionId, next_eligible_action: 'session_validation_repair_or_bounded_regeneration' },
  ] });
  const restored = structuredClone(first.ledger);
  transitionMemorizeObligation(restored, sessionInput, { current_state: 'durably_committed', downstream_validation_result: 'accepted', persistence_result: 'committed', coverage_result: 'safely_committed' });
  assert.equal(projectMemorizeObligationLedger(restored).pending_obligation_count, 0);
  const replay = runMemorizeReplay({ logicalRunId: 'run', obligations: [sessionInput], events: [
    { obligation_id: sessionId, current_state: 'durably_committed', persisted_record_ids: ['record-1'] },
    { obligation_id: sessionId, current_state: 'durably_committed', persisted_record_ids: ['record-1'] },
  ] });
  assert.equal(replay.persisted_record_ids.length, 1);
  assert.equal(replay.duplicate_record_count, 0);
  assert.equal(replay.duplicate_persistence_attempts_suppressed, 1);
});

test('canary corpus is routed through actionable terminal states', () => {
  const corpus = JSON.parse(fs.readFileSync(new URL('./fixtures/memorize-recovery-canary-corpus.json', import.meta.url)));
  assert.equal(corpus.cases.length, 10);
  for (const [index, name] of corpus.cases.entries()) {
    const id = `session:chat:${index}-${index}:canary`;
    const replay = runMemorizeReplay({ obligations: [{ obligation_id: id, tier: 'session', source_range: { start: index, end: index } }], events: [
      { obligation_id: id, current_state: 'pending_recovery', exact_reason_code: name, next_eligible_action: 'resume_exact_obligation' },
      { obligation_id: id, current_state: 'durably_committed', persistence_result: 'committed', coverage_result: 'safely_committed' },
    ] });
    assert.equal(replay.finalization_reachable, true, name);
  }
});

test('9,434-message offline replay finalizes monotonically and is idempotent', () => {
  const script = buildFullChatReplay(9434, 20, ['alex', 'aster', 'lillian', 'lisette', 'nyx', 'valerie']);
  const first = runMemorizeReplay(script);
  const second = runMemorizeReplay(script);
  assert.equal(first.finalization_reachable, true);
  assert.equal(first.checkpoint, 9434);
  assert.equal(first.duplicate_record_count, 0);
  assert.deepEqual(first.projection.tier_coverage, second.projection.tier_coverage);
  assert.deepEqual(first.persisted_record_ids, second.persisted_record_ids);
});

test('9,434-message replay automatically recovers frequent partial Session output without pauses', () => {
  const script = buildAutomaticRecoveryFullChatReplay();
  const result = runMemorizeReplay(script);
  assert.equal(script.expectedAutomaticRecoveries, Math.ceil(9434 / 20));
  assert.equal(script.expectedOperationalPauses, 0);
  assert.equal(result.finalization_reachable, true);
  assert.equal(result.checkpoint, 9434);
  assert.equal(result.projection.pending_obligation_count, 0);
  assert.equal(result.duplicate_record_count, 0);
  assert.equal(result.projection.tier_coverage.longterm.coverage_complete, true);
  assert.equal(result.projection.tier_coverage.session.coverage_complete, true);
  assert.equal(script.providerMetrics.root_obligations, 3304);
  assert.equal(script.providerMetrics.physical_provider_requests, 3776);
  assert.equal(script.providerMetrics.request_amplification, 8 / 7);
  assert.equal(script.providerMetrics.partial_valid_response_rate, 1 / 8);
  assert.equal(script.providerMetrics.fragment_recovery_success_rate, 1);
});

test('current-schema exhaustion reload resumes only exact fragments and continues 100 to 120-139', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL(
    './fixtures/memorize-exhausted-session-100-119.json', import.meta.url), 'utf8'));
  const result = replayExhaustedSessionRecoveryResume();
  assert.equal(result.beforeRepair.running_obligation_count, 1);
  assert.equal(result.afterRepair.running_obligation_count, 0);
  assert.equal(result.afterRepair.actionable_pending_obligation_count, 1);
  assert.equal(result.afterRepair.next_eligible_obligation.obligation_id, fixture.obligation_id);
  assert.equal(result.afterRepair.next_eligible_obligation.partial_record_persistence.persisted_record_count, 1);
  assert.equal(result.runtimeAfterRepair.consistent, true);
  assert.equal(result.epoch.recovery_stage, fixture.resume_recovery_stage);
  assert.equal(result.epoch.global_requests_consumed_before_epoch, 4);
  assert.deepEqual(result.providerRequests.at(-2).fragment_ids, fixture.unresolved_fragment_ids);
  assert.equal(result.providerRequests.at(-2).accepted_record_ids_excluded.length, 1);
  assert.equal(result.longtermReplayCount, 0);
  assert.equal(result.checkpoint, fixture.checkpoint_after_recovery);
  assert.deepEqual(result.providerRequests.at(-1).source_range, fixture.next_source_range);
  assert.equal(result.duplicateRecordCount, 0);
  assert.equal(result.finalProjection.pending_obligation_count, 0);
  assert.equal(result.finalProjection.invariants.valid, true);
});

test('9,434-message replay includes exhaustion, reload, focused Resume, and complete coverage', () => {
  const result = replayExhaustedSessionRecoveryResume({ completeRemainingChat: true });
  assert.equal(result.checkpoint, 9434);
  assert.equal(result.finalProjection.pending_obligation_count, 0);
  assert.equal(result.finalProjection.invariants.valid, true);
  assert.equal(result.longtermReplayCount, 0);
  assert.equal(result.duplicateRecordCount, 0);
});

