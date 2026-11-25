import test from 'node:test';
import assert from 'node:assert/strict';

import { createCompactFailureDiagnostics } from '../memorize-domain-dtos.js';
import { createMemorizeFaultInjector, MEMORIZE_FAULT_STAGES }
  from '../memorize-fault-injection.js';
import { createMemorizeObligationLedger, projectMemorizeObligationLedger,
  recordMemorizeControllerExit, transitionMemorizeObligation }
  from '../memorize-obligation-ledger.js';
import { buildMemorizeControllerExit, captureMemorizePrimaryFailure,
  cleanupMemorizeRuntime, createMemorizeControllerRuntime,
  registerMemorizeCleanup, trackMemorizeTransaction }
  from '../memorize-controller-runtime.js';
import { assertSerializableDomain } from '../serializable-domain.js';
import { selectDiagnosticsProjection, selectRecoveryPresentation }
  from '../memorize-projections.js';

async function runFault(stage, { classification = 'internal_exception',
  reasonCode = 'SME_INJECTED_FAULT', resumable = false } = {}) {
  const obligationId = 'session:chat:0-19:fault-matrix';
  const ledger = createMemorizeObligationLedger('fault-matrix-run', 1);
  transitionMemorizeObligation(ledger, { obligation_id: obligationId,
    logical_run_id: 'fault-matrix-run', tier: 'session',
    source_range: { start: 0, end: 19 } }, {
    current_state: 'unattempted', exact_reason_code: 'not_attempted', at: 1,
  });
  const runtime = createMemorizeControllerRuntime({
    invocation_id: `controller:${stage}`, logical_run_id: 'fault-matrix-run',
  });
  const transaction = { transaction_id: `tx:${stage}`, state: 'active',
    terminal_disposition: null };
  trackMemorizeTransaction(runtime, transaction, {
    phase: stage, tier: 'session', obligation_id: obligationId,
  });
  registerMemorizeCleanup(runtime, 'active_transaction', () => {
    transaction.state = 'rolled_back';
    transaction.terminal_disposition = 'rolled_back';
  });
  const injector = createMemorizeFaultInjector({ fail_at: stage });
  let error;
  try { injector.hit(stage, { obligation_id: obligationId }); }
  catch (caught) { error = caught; }
  captureMemorizePrimaryFailure(runtime, error);
  await cleanupMemorizeRuntime(runtime);
  const exit = buildMemorizeControllerExit(runtime, {
    reason_code: reasonCode, classification,
    resumable, next_eligible_action: resumable ? 'dispatch_provider_request' : null,
    at: 2, finalize_transaction_evidence: true,
  });
  recordMemorizeControllerExit(ledger, exit);
  const projection = projectMemorizeObligationLedger(ledger);
  const current = {
    controller_exit: exit,
    authoritative_obligation_ledger: projection,
    catch_up_recovery: {
      available: true, logical_run_id: 'fault-matrix-run', resumable,
      resume_can_make_progress: resumable,
      reason_code: reasonCode, transaction_state: transaction.state,
      next_eligible_recovery_action: resumable ? 'dispatch_provider_request' : null,
      unresolved_obligations: projection.pending_obligations,
    },
  };
  const diagnostics = createCompactFailureDiagnostics(current, 3);
  const projectedDiagnostics = selectDiagnosticsProjection({ current, createdAt: 3 });
  const fullDiagnostics = selectDiagnosticsProjection({
    completedRun: {
      version: 2, diagnostic_type: 'memorize_fault_injection',
      status: 'failed', operational_status: 'failed',
    },
    current: { controller_exit: exit,
      authoritative_obligation_ledger: projection }, createdAt: 3,
  });
  const ui = selectRecoveryPresentation({
    checkpoint: {
      run_id: 'fault-matrix-run', status: 'awaiting_manual_resume',
      next_source_offset: 0, source_message_count: 20,
    },
    recovery: current.catch_up_recovery,
    resumeEligibility: { eligible: resumable,
      decision: resumable ? 'dispatch_provider_request' : 'blocked',
      reason: resumable ? null : reasonCode },
    manifest: { cumulative_range_count: 0, cumulative_committed_count: 0 },
  });
  return { error, transaction, exit, projection, diagnostics,
    projectedDiagnostics, fullDiagnostics, ui, injector };
}

test('fault injector rejects unknown boundaries', () => {
  assert.throws(() => createMemorizeFaultInjector({ fail_at: 'unknown' }),
    TypeError);
});

for (const stage of MEMORIZE_FAULT_STAGES) test(`fault matrix settles ${stage}`, async () => {
  const result = await runFault(stage);
  assert.equal(result.error.code, 'SME_INJECTED_FAULT');
  assert.equal(result.error.sme_failure_stage, stage);
  assert.equal(result.transaction.state, 'rolled_back');
  assert.notEqual(result.transaction.state, 'active');
  assert.equal(result.exit.failure_stage, stage);
  assert.equal(result.exit.code, 'SME_INJECTED_FAULT');
  assert.equal(result.projection.controller_exits.length, 1);
  assert.equal(result.diagnostics.root_error.code, 'SME_INJECTED_FAULT');
  assert.equal(result.diagnostics.root_error.failure_stage, stage);
  assert.equal(result.diagnostics.resume.eligible, false);
  assert.doesNotThrow(() => assertSerializableDomain(result.diagnostics));
  assert.deepEqual(result.projectedDiagnostics, result.diagnostics);
  assert.doesNotThrow(() => assertSerializableDomain(result.fullDiagnostics));
  assert.equal(result.ui.disabled, true);
  assert.deepEqual(result.injector.trace.map((entry) => entry.stage), [stage]);
});

for (const stage of MEMORIZE_FAULT_STAGES) {
  for (const interruption of [
    { classification: 'manually_cancelled', reasonCode: 'manual_cancel' },
    { classification: 'page_interruption', reasonCode: 'page_replaced' },
  ]) test(`${interruption.classification} during ${stage} settles and remains resumable`, async () => {
    const result = await runFault(stage, { ...interruption, resumable: true });
    assert.equal(result.transaction.state, 'rolled_back');
    assert.equal(result.exit.classification, interruption.classification);
    assert.equal(result.exit.reason_code, interruption.reasonCode);
    assert.equal(result.exit.next_eligible_action, 'dispatch_provider_request');
    assert.equal(result.diagnostics.resume.eligible, true);
    assert.equal(result.diagnostics.resume.next_action, 'dispatch_provider_request');
    assert.equal(result.ui.disabled, false);
    assert.equal(result.ui.auto_resume_eligible, true);
    assert.doesNotThrow(() => assertSerializableDomain(result.projectedDiagnostics));
    assert.doesNotThrow(() => assertSerializableDomain(result.fullDiagnostics));
  });
}
