import test from 'node:test';
import assert from 'node:assert/strict';

import { assessMemorizeProviderDispatch } from '../memorize-provider-policy.js';
import { createMemorizeOperationContext } from '../memorize-operation-context.js';
import { classifyMemorizeErrorRecord } from '../memorize-error-origin.js';
import { captureMemorizeDiagnosticSnapshot,
  validateMemorizeDiagnosticSnapshot } from '../memorize-diagnostic-snapshot.js';
import { settleMemorizeTransactionCheckpoint }
  from '../memorize-transaction-settlement.js';

test('early-run amplification cannot strand an active recovery frontier', () => {
  const profile = { logical_obligation_count: 7, physical_attempt_count: 11 };
  const recovery = assessMemorizeProviderDispatch(profile, {
    leaf_attempt_count: 1, active_recovery_tree: true, safe_boundary: false,
  });
  assert.equal(recovery.allowed, true);
  assert.equal(recovery.reason_code, 'active_recovery_frontier_dispatch_allowed');

  const nextChunk = assessMemorizeProviderDispatch(profile, {
    leaf_attempt_count: 0, active_recovery_tree: false, safe_boundary: true,
    projected_request_count: 2, projected_logical_obligation_count: 2,
    maximum_amplification: 1.25, minimum_global_sample_size: 8,
  });
  assert.equal(nextChunk.allowed, false);
  assert.equal(nextChunk.reason_code, 'safe_boundary_request_amplification_guard');
  assert.equal(nextChunk.outcome_type, 'policy_pause');
});

test('per-leaf transmission cap remains strict inside recovery', () => {
  const result = assessMemorizeProviderDispatch({
    logical_obligation_count: 20, physical_attempt_count: 20,
  }, { leaf_attempt_count: 3, active_recovery_tree: true,
    maximum_transmissions: 3 });
  assert.equal(result.allowed, false);
  assert.equal(result.reason_code, 'logical_obligation_attempt_budget_exhausted');
});

test('operation context is immutable and complete at failure boundaries', () => {
  const context = createMemorizeOperationContext({
    logical_run_id: 'run', controller_invocation_id: 'controller',
    transaction_id: 'tx', transaction_generation: 2,
    root_obligation_id: 'root', leaf_obligation_id: 'leaf', tier: 'longterm',
    owner: 'Alex Mercer', source_range: { start: 0, end: 19 },
    source_fingerprint: 'fp', selected_action: 'dispatch_provider_request',
  });
  assert.equal(context.source_range.message_count, 20);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.source_range), true);
  assert.throws(() => { context.root_obligation_id = 'changed'; }, TypeError);
});

test('typed error origin never classifies local provider-named failures as transport', () => {
  assert.equal(classifyMemorizeErrorRecord({
    code: 'SME_PROVIDER_ATTEMPT_REGISTRATION_FAILED',
    origin: 'internal_invariant',
  }), 'internal_invariant_failure');
  assert.equal(classifyMemorizeErrorRecord({
    code: 'SME_PROVIDER_POLICY_PAUSED', origin: 'policy_pause',
  }), 'operational_pause');
  assert.equal(classifyMemorizeErrorRecord({
    origin: 'provider_transport', transport_started: true,
    transport_completed: false,
  }), 'provider_transport_failure');
});

test('rolled-back transaction and checkpoint settle as one coherent projection', () => {
  const result = settleMemorizeTransactionCheckpoint({
    status: 'in_progress', next_source_offset: 0,
  }, {
    transaction_id: 'tx', state: 'rolled_back', terminal_disposition: 'rolled_back',
    revision: 4, generation: 2, settled_at: 100,
  }, { at: 101 });
  assert.equal(result.status, 'awaiting_manual_resume');
  assert.equal(result.transaction_lifecycle.state, 'rolled_back');
  assert.equal(result.next_source_offset, 0);
});

test('diagnostic snapshot is frozen, read-only, and detects revision conflicts', () => {
  const metadata = { active_catchup_run_id: 'run' };
  const checkpoint = { status: 'awaiting_manual_resume', committed_chunks: 2,
    transaction_lifecycle: { state: 'rolled_back', revision: 5 },
    run_manifest: { logical_run_id: 'run', obligation_ledger: {
      logical_run_id: 'run', execution_kernel: { revision: 12 },
    } } };
  const before = structuredClone({ metadata, checkpoint });
  const snapshot = captureMemorizeDiagnosticSnapshot({ metadata, checkpoint, at: 200 });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.deepEqual({ metadata, checkpoint }, before);
  const consistent = validateMemorizeDiagnosticSnapshot({
    logical_run: { logical_run_id: 'run', attempt_count: 2 },
    malformed_recovery: { attempt_count: 2 },
    memorize_execution_kernel: { logical_run_id: 'run', revision: 12 },
    authoritative_recovery: { logical_run_id: 'run', aggregate_revision: 12 },
  }, snapshot.identity);
  assert.equal(consistent.consistent, true);
  const inconsistent = validateMemorizeDiagnosticSnapshot({
    logical_run: { logical_run_id: 'run', attempt_count: 1 },
    malformed_recovery: { attempt_count: 2 },
    memorize_execution_kernel: { logical_run_id: 'run', revision: 76 },
    authoritative_recovery: { logical_run_id: 'run', aggregate_revision: 95 },
  }, snapshot.identity);
  assert.equal(inconsistent.consistent, false);
  assert.deepEqual([...inconsistent.violations].sort(), [
    'aggregate_revision_mismatch', 'attempt_count_mismatch',
  ]);
});
