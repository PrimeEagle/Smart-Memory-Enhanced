import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMemorizeExecutionAggregate } from '../memorize-execution-kernel.js';
import { summarizeCatchUpRunManifest } from '../catchup-recovery-utils.js';
import { summarizeProviderAttemptAudit } from '../provider-attempt-audit.js';
import { projectMemorizeKernelDiagnostics } from '../memorize-diagnostic-observer.js';
import { observeMemorizeDiagnostics } from '../memorize-diagnostic-boundary.js';
import { projectMultiOwnerCoverage, selectMultiOwnerRecoverySubset }
  from '../multi-owner-coverage.js';
import { createMemorizeRecoveryCapsule, assessMemorizeRecoveryCapsule }
  from '../memorize-recovery-capsule.js';
import { settleMemorizeTransactionCheckpoint } from '../memorize-transaction-settlement.js';
import { dispatchMemorizeAction } from '../memorize-action-dispatcher.js';
import { dispatchMultiOwnerLongtermBatch, persistMultiOwnerLongtermPartitions }
  from '../multi-owner-longterm.js';

const freeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
};

test('every read-only Memorize projection accepts a deeply frozen current-schema graph', () => {
  const aggregate = createMemorizeExecutionAggregate('run-frozen', 1);
  const manifest = freeze({
    schema_version: 3, logical_run_id: 'run-frozen',
    source_window: { message_count: 20, source_start_index: 0, source_end_index: 19,
      fingerprint: 'source-fingerprint' },
    attempts: [], total_attempt_count: 0, total_resumption_count: 0,
    committed_ranges: [], committed_chunks: [], cumulative_chunk_count: 0,
    tier_coverage: { longterm: { enabled: true, committed_ranges: [] },
      session: { enabled: true, committed_ranges: [] } },
    tier_obligations: [], owner_obligations: [], checkpoint_transitions: [],
    terminal_status: 'in_progress', terminal_reason_code: null,
    obligation_ledger: aggregate,
  });
  const metadata = freeze({ live_memory_health: { provider_attempt_audit: {
    schema_version: 13, run_id: 'run-frozen', obligations: {}, recent_attempts: [],
    terminal_counts: {}, archived_obligation_counts: { exact: true, total: 0 },
  } } });
  const beforeManifest = JSON.stringify(manifest);
  const beforeMetadata = JSON.stringify(metadata);
  assert.doesNotThrow(() => summarizeCatchUpRunManifest(manifest));
  assert.doesNotThrow(() => summarizeProviderAttemptAudit(metadata));
  assert.doesNotThrow(() => projectMemorizeKernelDiagnostics(aggregate));
  assert.equal(JSON.stringify(manifest), beforeManifest);
  assert.equal(JSON.stringify(metadata), beforeMetadata);
});

test('diagnostic observer exceptions are contained and preserve the execution result', () => {
  const result = observeMemorizeDiagnostics(() => {
    throw new TypeError('projector exploded');
  }, 99);
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'diagnostic_observer_failure');
  assert.equal(result.failure.provider_fault_attribution, false);
  assert.equal(result.failure.execution_result_preserved, true);
  assert.equal(result.failure.recorded_at, 99);
});

test('every diagnostic and UI observer fault domain is non-fatal', () => {
  for (const stage of ['snapshot', 'kernel_projection', 'provider_projection',
    'recovery_projection', 'status_projection', 'ui_projection']) {
    const result = observeMemorizeDiagnostics(() => {
      throw Object.assign(new Error(`fault:${stage}`), { code: `FAULT_${stage}` });
    }, 100);
    assert.equal(result.ok, false);
    assert.equal(result.failure.execution_result_preserved, true);
    assert.equal(result.failure.provider_fault_attribution, false);
  }
});

test('multi-owner coverage targets only missing owners and merges prior durable coverage', () => {
  const first = projectMultiOwnerCoverage({
    required_owners: ['Alex Mercer', 'Aster Graves', 'Valerie Erikssen'],
    partitions: { 'Alex Mercer': [{ content: 'supported' }], 'Aster Graves': [],
      'Valerie Erikssen': [] },
    no_update_owners: ['Valerie Erikssen'],
    owner_results: { 'Alex Mercer': { status: 'committed' },
      'Valerie Erikssen': { status: 'verified_no_update' } },
  });
  assert.deepEqual(first.owners_requiring_recovery, ['Aster Graves']);
  assert.deepEqual(selectMultiOwnerRecoverySubset(first), ['Aster Graves']);
  assert.equal(first.complete, false);
  const recovered = projectMultiOwnerCoverage({
    required_owners: first.required_owners,
    partitions: { 'Aster Graves': [{ content: 'supported recovery' }] },
    owner_results: { 'Aster Graves': { status: 'committed' } },
    prior: first,
  });
  assert.equal(recovered.complete, true);
  assert.deepEqual(recovered.owners_requiring_recovery, []);
  assert.deepEqual(new Set(recovered.owners_durably_persisted),
    new Set(['Alex Mercer', 'Aster Graves', 'Valerie Erikssen']));
});

test('owner-coverage capsule selects an exact provider recovery action without fragments', () => {
  const coverage = projectMultiOwnerCoverage({ required_owners: ['Alex', 'Aster'],
    partitions: { Alex: [{ content: 'fact' }], Aster: [] } });
  const capsule = createMemorizeRecoveryCapsule({
    logical_run_id: 'run-owner', obligation_leaf_id: 'longterm:multi:0-19',
    source_range: { start: 0, end: 19, message_count: 20 },
    source_fingerprint: 'fnv1a-owner', owner_coverage: coverage,
    rejected_fragment_ids: [], source_backed_regeneration_available: true,
  });
  const assessment = assessMemorizeRecoveryCapsule(capsule);
  assert.equal(assessment.next_action, 'recover_missing_owner_coverage');
  assert.deepEqual(assessment.owner_subset, ['Aster']);
  assert.equal(assessment.provider_call_required, true);
});

test('missing-owner recovery is an exact dispatcher action', async () => {
  let calls = 0;
  const result = await dispatchMemorizeAction({
    logical_run_id: 'run-owner', obligation_id: 'longterm:multi:0-19',
    selected_action: 'recover_missing_owner_coverage',
    requested_action: 'recover_missing_owner_coverage',
    handlers: { recover_missing_owner_coverage: async () => { calls++; return 'done'; } },
  });
  assert.equal(result.status, 'executed');
  assert.equal(calls, 1);
});

test('rollback after durable subwrites reports the real saga boundary', () => {
  const settled = settleMemorizeTransactionCheckpoint({ status: 'in_progress' }, {
    transaction_id: 'tx-saga', state: 'rolled_back', terminal_disposition: 'rolled_back',
    durable_checkpoint_count: 2, saga_disposition: 'rolled_back_to_last_durable_boundary',
    durable_subwrites_preserved: true,
  }, { at: 50 });
  assert.equal(settled.status, 'awaiting_manual_resume');
  assert.equal(settled.transaction_lifecycle.saga_disposition,
    'rolled_back_to_last_durable_boundary');
  assert.equal(settled.transaction_lifecycle.durable_subwrites_preserved, true);
});

test('diagnostic observer module has no execution dispatch or persistence authority', () => {
  const source = fs.readFileSync(new URL('../memorize-diagnostic-observer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /generateMemory|dispatchMemorizeAction|saveChat|saveSettings|applyProviderCompletion/);
});

test('production controller resumes multi-owner work with only the capsule owner subset', () => {
  const source = fs.readFileSync(new URL('../settings.js', import.meta.url), 'utf8');
  assert.match(source, /owners_requiring_recovery/);
  assert.match(source, /longtermOwnersForRequest/);
  assert.match(source, /priorOwnerCoverage/);
});

test('production owner boundaries recover only the omitted owner without duplicate persistence', async () => {
  const requiredOwners = ['Alex Mercer', 'Aster Graves', 'Valerie Erikssen'];
  const providerRequests = [];
  const persistedOwners = [];
  const persist = async (owner, records) => {
    persistedOwners.push(owner);
    return { owner, status: 'committed', added: records.length,
      durable_record_ids: records.map((_, index) => `${owner}:${index}`),
      durable_record_candidate_map: {} };
  };
  const prepare = async (_owner, records) => ({ records,
    candidate_ids: records.map((_, index) => `candidate:${index}`) });
  const first = await dispatchMultiOwnerLongtermBatch({
    request: { pass: 1 }, owners: requiredOwners, source_indices: [0],
    dispatch: async (request) => {
      providerRequests.push(request);
      return JSON.stringify({ records: [{ owner: 'Alex Mercer', type: 'fact',
        content: 'Supported fact', source_indices: [0] }],
      no_update_owners: ['Valerie Erikssen'] });
    },
  });
  const firstResults = await persistMultiOwnerLongtermPartitions({
    owners: requiredOwners, partition: first.partition,
    prepare_records: prepare, persist_partition: persist,
  });
  const firstCoverage = projectMultiOwnerCoverage({ required_owners: requiredOwners,
    partitions: first.partition.partitions,
    no_update_owners: first.partition.no_update_owners,
    owner_results: firstResults });
  assert.deepEqual(firstCoverage.owners_requiring_recovery, ['Aster Graves']);
  assert.deepEqual(persistedOwners, ['Alex Mercer']);
  assert.equal(firstResults['Valerie Erikssen'].status, 'verified_no_update');
  assert.equal(firstResults['Aster Graves'].status, 'missing_owner_output');

  const recoveryOwners = selectMultiOwnerRecoverySubset(firstCoverage);
  const second = await dispatchMultiOwnerLongtermBatch({
    request: { pass: 2 }, owners: recoveryOwners, source_indices: [0],
    dispatch: async (request) => {
      providerRequests.push(request);
      return JSON.stringify({ records: [{ owner: 'Aster Graves', type: 'fact',
        content: 'Recovered fact', source_indices: [0] }], no_update_owners: [] });
    },
  });
  const secondResults = await persistMultiOwnerLongtermPartitions({
    owners: recoveryOwners, partition: second.partition,
    prepare_records: prepare, persist_partition: persist,
  });
  const finalCoverage = projectMultiOwnerCoverage({ required_owners: requiredOwners,
    partitions: second.partition.partitions,
    no_update_owners: second.partition.no_update_owners,
    owner_results: secondResults, prior: firstCoverage });
  assert.equal(finalCoverage.complete, true);
  assert.deepEqual(finalCoverage.owners_requiring_recovery, []);
  assert.deepEqual(persistedOwners, ['Alex Mercer', 'Aster Graves']);
  assert.equal(providerRequests.length, 2);
});
