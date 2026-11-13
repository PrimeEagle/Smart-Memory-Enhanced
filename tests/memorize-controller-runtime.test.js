import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bindMemorizeCheckpoint,
  buildMemorizeControllerExit,
  cleanupMemorizeRuntime,
  createMemorizeControllerRuntime,
  recordMemorizeOperationalPause,
  registerMemorizeCleanup,
  trackMemorizeTransaction,
} from '../memorize-controller-runtime.js';
import { createMemorizeObligationLedger, projectMemorizeObligationLedger,
  recordMemorizeControllerExit } from '../memorize-obligation-ledger.js';
import {
  replayAutomaticPartialSessionRecovery,
  replayPartialSessionResume,
} from '../memorize-replay-harness.js';

const controllerFailureFixture = JSON.parse(readFileSync(
  new URL('./fixtures/memorize-controller-0-19-failure.json', import.meta.url),
  'utf8',
));
const automaticRecoveryFixture = JSON.parse(readFileSync(
  new URL('./fixtures/memorize-automatic-session-20-39.json', import.meta.url),
  'utf8',
));

test('operational pause owns and updates the bound checkpoint without a scope error', () => {
  const runtime = createMemorizeControllerRuntime();
  const checkpoint = { next_source_offset: 0, run_manifest: { logical_run_id: 'run', total_attempt_count: 1 } };
  bindMemorizeCheckpoint(runtime, checkpoint);
  const runResult = { operationalPauses: [] };
  const pause = recordMemorizeOperationalPause(runtime, runResult, 'Session pending', {
    code: 'SME_DOWNSTREAM_VALIDATION_PENDING',
    sme_request_diagnostics: { pause_reason: 'partial_valid_output_has_unresolved_fragments' },
  }, 'session');
  assert.equal(checkpoint.operational_pause, pause);
  assert.equal(runResult.operationalPauses.length, 1);
  assert.equal(pause.reason_code, 'partial_valid_output_has_unresolved_fragments');
});

test('cleanup is idempotent and one cleanup exception cannot stop later resources', async () => {
  const runtime = createMemorizeControllerRuntime();
  const calls = [];
  registerMemorizeCleanup(runtime, 'first', () => { calls.push('first'); throw new Error('first failed'); });
  registerMemorizeCleanup(runtime, 'second', () => calls.push('second'));
  const first = await cleanupMemorizeRuntime(runtime);
  const second = await cleanupMemorizeRuntime(runtime);
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(first[0].resource_name, 'first');
  assert.equal(second.length, 0);
});

test('0-19 partial Session path pauses safely, settles its transaction, and preserves siblings', async () => {
  const result = await replayPartialSessionResume();
  assert.equal(result.checkpoint.source_message_count, controllerFailureFixture.source_message_count);
  assert.equal(result.beforeResume.next_eligible_obligation.obligation_id, controllerFailureFixture.session_obligation_id);
  assert.deepEqual(
    Object.values(result.ledger.obligations)
      .filter((item) => item.tier === 'longterm')
      .map((item) => item.owner),
    controllerFailureFixture.committed_longterm_owners,
  );
  assert.equal(result.beforeResume.pending_obligation_count, 1);
  assert.equal(result.beforeResume.next_eligible_obligation.tier, 'session');
  assert.equal(result.beforeResume.next_eligible_obligation.metrics.parser_accepted_records, controllerFailureFixture.accepted_partial_record_count);
  assert.equal(result.beforeResume.next_eligible_obligation.metrics.parser_rejected_fragments, controllerFailureFixture.rejected_fragment_count);
  assert.equal(result.checkpoint.operational_pause.reason_code, controllerFailureFixture.reason_code);
  assert.equal(result.beforeResume.next_eligible_obligation.next_eligible_action, controllerFailureFixture.next_action);
  assert.equal(result.transaction.state, 'rolled_back');
  assert.equal(result.leaked_transaction, false);
  assert.equal(result.beforeResume.tier_coverage.longterm.safely_committed_obligation_count, 6);
});

test('Resume targets only unresolved Session fragments and never duplicates committed partial records', async () => {
  const result = await replayPartialSessionResume();
  assert.equal(result.providerRequests.filter((id) => id.startsWith('longterm:')).length, 6);
  assert.deepEqual(result.providerRequests.slice(-1), ['session:chat:0-19:fnv1a-39c6c9f:fragment_repair']);
  assert.equal(result.persisted_record_ids.filter((id) => id === 'session:one').length, 1);
  assert.equal(result.duplicate_record_count, 0);
  assert.equal(result.afterResume.pending_obligation_count, 0);
  assert.equal(result.checkpoint.next_source_offset, 20);
});

test('checkpoint remains at zero until Session commits and advances only after recovery', async () => {
  const failed = await replayPartialSessionResume({ commitFailure: true });
  assert.equal(failed.checkpoint.next_source_offset, 0);
  assert.equal(failed.afterResume.pending_obligation_count, 1);
  assert.equal(failed.resumeResult.transaction.state, 'commit_failed_with_exact_state');
  const completed = await replayPartialSessionResume();
  assert.equal(completed.checkpoint.next_source_offset, 20);
  assert.equal(completed.afterResume.tier_coverage.session.coverage_complete, true);
});

test('exception before optional cleanup initialization still yields one exit and no active transaction', async () => {
  const result = await replayPartialSessionResume({ throwBeforeInitialization: true });
  assert.equal(result.leaked_transaction, false);
  assert.equal(result.beforeResume.controller_exits.length, 1);
  assert.equal(result.beforeResume.last_controller_exit.classification, 'internal_exception');
  assert.equal(result.beforeResume.last_controller_exit.normalized_exception_class, 'ReferenceError');
});

test('rollback failure is explicit, later cleanup still runs, and no active lock survives', async () => {
  const result = await replayPartialSessionResume({ rollbackFailure: true, cleanupFailure: true });
  assert.equal(result.transaction.state, 'rollback_failed_with_exact_state');
  assert.equal(result.leaked_transaction, false);
  assert.equal(result.cleanupWarnings.some((item) => item.resource_name === 'active_transaction'), true);
  assert.equal(result.cleanupWarnings.some((item) => item.resource_name === 'provider_progress_listener'), true);
  assert.equal(result.transactionHistory.includes('retry_listener_cleaned'), true);
});

test('controller exits deduplicate by invocation and cannot leave an exited attempt unaccounted', () => {
  const runtime = createMemorizeControllerRuntime({ invocation_id: 'same', logical_run_id: 'run', attempt_number: 2 });
  const ledger = createMemorizeObligationLedger('run', 1);
  const exit = buildMemorizeControllerExit(runtime, { reason_code: 'manual_cancel', classification: 'manually_cancelled' });
  recordMemorizeControllerExit(ledger, exit);
  recordMemorizeControllerExit(ledger, exit);
  assert.equal(projectMemorizeObligationLedger(ledger).controller_exits.length, 1);
  assert.equal(projectMemorizeObligationLedger(ledger).last_controller_exit.attempt_number, 2);
});

test('a later internal exception atomically supersedes a provisional pause exit', () => {
  const runtime = createMemorizeControllerRuntime({ invocation_id: 'priority', logical_run_id: 'run' });
  const ledger = createMemorizeObligationLedger('run', 1);
  const provisional = buildMemorizeControllerExit(runtime, {
    classification: 'downstream_validation_pending', reason_code: 'recovery_stage_ladder_exhausted',
    resumable: true, next_eligible_action: 'fragment_decision_regeneration',
  });
  recordMemorizeControllerExit(ledger, provisional);
  const failure = new TypeError('presentation failed after pause');
  failure.code = 'SME_INTERNAL_PRESENTATION_FAILURE';
  // The real outer catch captures the primary failure before final exit construction.
  runtime.primary_failure = { normalized_exception_class: failure.name, code: failure.code,
    bounded_message: failure.message, stack_fingerprint_input: failure.stack };
  const finalExit = buildMemorizeControllerExit(runtime, {
    classification: 'internal_exception', reason_code: failure.code, resumable: true,
    next_eligible_action: 'fragment_decision_regeneration',
  });
  recordMemorizeControllerExit(ledger, finalExit);
  const projection = projectMemorizeObligationLedger(ledger);
  assert.equal(projection.controller_exits.length, 1);
  assert.equal(projection.last_controller_exit.classification, 'internal_exception');
  assert.equal(projection.last_controller_exit.normalized_exception_class, 'TypeError');
});

test('overlapping transaction state is observable and therefore blocks a second invocation', () => {
  const runtime = createMemorizeControllerRuntime();
  trackMemorizeTransaction(runtime, { transaction_id: 'tx', state: 'active' }, { phase: 'source_extraction' });
  const exit = buildMemorizeControllerExit(runtime, { reason_code: 'already_running', classification: 'blocked_nonresumable' });
  assert.equal(exit.active_transaction_state, 'active');
  assert.equal(exit.resumable, false);
});

test('partial Session output recovers automatically and continues into the next chunk', async () => {
  const result = await replayAutomaticPartialSessionRecovery();
  assert.equal(result.checkpoint.next_source_offset, automaticRecoveryFixture.next_checkpoint);
  assert.equal(result.checkpoint.automatic_recovery.status, 'recovered_automatically');
  assert.equal(result.nextChunkStarted, true);
  assert.equal(result.providerRequests[0].root_obligation_id, automaticRecoveryFixture.session_obligation_id);
  assert.deepEqual(result.providerRequests[0].fragment_ids, automaticRecoveryFixture.rejected_fragment_ids);
  assert.equal(result.providerRequests.at(-1).root_obligation_id, 'session:chat:40-59:offline');
  assert.equal(result.projection.pending_obligation_count, 0);
  assert.equal(result.transaction.state, 'committed');
});

test('automatic fragment repair preserves accepted records and does not replay Long-Term siblings', async () => {
  const result = await replayAutomaticPartialSessionRecovery();
  for (const id of automaticRecoveryFixture.accepted_record_ids) {
    assert.equal(result.records.filter((item) => item === id).length, 1);
  }
  assert.equal(result.providerRequests.some((item) => item.root_obligation_id.startsWith('longterm:')), false);
  assert.equal(result.records.includes('session:20-39:recovered-fragment'), true);
  assert.equal(result.duplicate_record_count, 0);
});

test('a failed compact repair advances to a changed recovery dimension in the same invocation', async () => {
  const result = await replayAutomaticPartialSessionRecovery({ recoveryOutcomes: ['malformed', 'success'] });
  assert.deepEqual(result.providerRequests.slice(0, 2).map((item) => item.recovery_stage),
    ['compact_response_repair', 'changed_dimension_regeneration']);
  assert.equal(result.checkpoint.next_source_offset, 40);
  assert.equal(result.nextChunkStarted, true);
});

test('automatic recovery request exhaustion creates one safe resumable pause', async () => {
  const result = await replayAutomaticPartialSessionRecovery({
    recoveryOutcomes: ['malformed', 'malformed', 'malformed'], maximumRequests: 2,
  });
  assert.equal(result.providerRequests.length, 2);
  assert.equal(result.checkpoint.next_source_offset, 20);
  assert.equal(result.checkpoint.automatic_recovery.status, 'operationally_paused_resumable');
  assert.equal(result.checkpoint.automatic_recovery.fresh_budget_on_resume, true);
  assert.equal(result.projection.pending_obligation_count, 1);
  assert.equal(result.projection.last_controller_exit.classification, 'operationally_paused');
  assert.notEqual(result.transaction.state, 'active');
});

test('page interruption after the durable partial boundary preserves exact Resume work', async () => {
  const result = await replayAutomaticPartialSessionRecovery({ interruptAfterBoundary: true });
  assert.equal(result.checkpoint.next_source_offset, 20);
  assert.deepEqual(result.records, automaticRecoveryFixture.accepted_record_ids);
  assert.equal(result.projection.next_eligible_obligation.recovery_intent,
    automaticRecoveryFixture.recovery_intent);
  assert.equal(result.projection.next_eligible_obligation.recovery_stage,
    automaticRecoveryFixture.recovery_stage);
  assert.equal(result.transaction.state, 'rolled_back');
});

test('commit failure after fragment recovery cannot advance the chunk checkpoint', async () => {
  const result = await replayAutomaticPartialSessionRecovery({ commitFailure: true });
  assert.equal(result.checkpoint.next_source_offset, 20);
  assert.equal(result.nextChunkStarted, false);
  assert.equal(result.transaction.state, 'commit_failed_with_exact_state');
  assert.equal(result.projection.pending_obligation_count, 1);
});

test('manual cancellation during automatic recovery settles the transaction', async () => {
  const result = await replayAutomaticPartialSessionRecovery({ manualCancel: true });
  assert.equal(result.checkpoint.next_source_offset, 20);
  assert.equal(result.checkpoint.automatic_recovery.status, 'manually_cancelled');
  assert.equal(result.transaction.state, 'rolled_back');
  assert.equal(result.projection.last_controller_exit.classification, 'manually_cancelled');
});
