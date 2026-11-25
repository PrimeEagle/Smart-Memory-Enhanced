import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertMemorizeArchitectureAggregate,
  assertProviderLifecycleOrdering,
  runMemorizeLongRunReleaseGate,
  runMemorizeStartupReleaseGate,
} from '../memorize-architecture-gates.js';
import { executeFeaturePersistence, executeFeaturePersistenceSync,
  prepareFeaturePersistenceCommand }
  from '../feature-persistence.js';
import { MEMORIZE_ACTIONS } from '../memorize-execution-kernel.js';
import { MEMORIZE_ACTION_CONTRACTS } from '../memorize-obligation-ledger.js';

test('kernel commands and obligation action contracts use one exact vocabulary', () => {
  assert.deepEqual(Object.keys(MEMORIZE_ACTION_CONTRACTS).sort(),
    [...MEMORIZE_ACTIONS].sort());
  for (const removedAlias of ['resume_exact_obligation',
    'recover_unresolved_partial_output_fragments',
    'continue_pending_downstream_processing', 'single_source_unit_regeneration']) {
    assert.equal(MEMORIZE_ACTIONS.includes(removedAlias), false);
    assert.equal(MEMORIZE_ACTION_CONTRACTS[removedAlias], undefined);
  }
});

test('whole-state gate rejects invalid values in commands, outcomes, receipts, and diagnostics', () => {
  for (const [section, value] of [
    ['commands', [{ callback: () => {} }]],
    ['outcomes', [{ elapsed_ms: Number.POSITIVE_INFINITY }]],
    ['receipts', [{ optional: undefined }]],
    ['diagnostics', { pending: Promise.resolve() }],
  ]) assert.throws(() => assertMemorizeArchitectureAggregate({ [section]: value }),
    { code: 'SME_NON_SERIALIZABLE_DOMAIN_DATA' });
});

test('provider lifecycle gate rejects dispatch without durable registration', () => {
  assert.throws(() => assertProviderLifecycleOrdering([
    { type: 'provider_attempt_started', attempt_id: 'attempt-1' },
  ]), { code: 'SME_PROVIDER_DISPATCH_BEFORE_REGISTRATION' });
  assert.equal(assertProviderLifecycleOrdering([
    { type: 'provider_attempt_registered', attempt_id: 'attempt-1' },
    { type: 'provider_attempt_started', attempt_id: 'attempt-1' },
  ]), true);
});

test('startup release gate reaches dispatch with no prior heartbeat or diagnostics', async () => {
  const result = await runMemorizeStartupReleaseGate();
  assert.equal(result.status, 'provider_dispatched');
  assert.equal(result.provider_transmissions, 1);
  assert.deepEqual(result.lifecycleEvents.map((event) => event.type), [
    'obligation_registered', 'provider_attempt_registered', 'provider_attempt_started',
  ]);
  assert.equal(result.attempt.transmission_started, true);
  assert.equal(result.metadata.live_memory_health.provider_attempt_audit
    .recent_attempts.at(-1), result.attempt,
  'the returned attempt remains the authoritative audit object');
  assert.ok(result.fresh_start_reset.deleted_keys.includes('catch_up_checkpoint'));
  assert.ok(result.fresh_start_reset.deleted_keys.includes('provider_completion_journal'));
  assert.equal(result.metadata.preserved_chat_setting, 'preserved');
  assert.equal(result.metadata.catch_up_checkpoint, undefined);
  assert.equal(result.metadata.catch_up_diagnostics, undefined);
});

test('registration persistence failure leaves no attempt, journal, or provider transmission', async () => {
  const result = await runMemorizeStartupReleaseGate({
    fault_at: 'provider_attempt_registered',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.provider_transmissions, 0);
  assert.equal(result.metadata.live_memory_health?.provider_attempt_audit, undefined);
  assert.equal(result.metadata.provider_completion_journal, undefined);
  assert.equal(result.projection.pending_obligations[0].current_state, 'unattempted');
  assert.equal(result.error.code, 'SME_INJECTED_RELEASE_GATE_FAILURE');
});

test('failure after registration but before dispatch retains only registered evidence', async () => {
  const result = await runMemorizeStartupReleaseGate({
    fault_at: 'provider_attempt_started',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.provider_transmissions, 0);
  assert.equal(result.authoritative_attempt.transmission_started, false);
  assert.equal(result.authoritative_attempt.lifecycle_state, 'created');
  assert.equal(result.projection.pending_obligations[0].current_state,
    'provider_registered');
  assert.equal(result.error.code, 'SME_INJECTED_RELEASE_GATE_FAILURE');
});

test('independent real-time writer uses the shared command and receipt boundary', async () => {
  const durable = [];
  const receipts = {};
  const command = prepareFeaturePersistenceCommand({
    workflow_id: 'realtime-gate', feature: 'session', records: [{
      id: 'memory-1', content: 'Observed fact', source_message_indices: [1],
    }],
  });
  const result = await executeFeaturePersistence({ command,
    snapshot: () => [...durable],
    apply: (prepared) => durable.push(...prepared.durable_records),
    persist: async () => {},
    restore: (before) => durable.splice(0, durable.length, ...before),
    receipt_container: receipts,
  });
  assert.equal(result.status, 'committed');
  assert.equal(durable.length, 1);
  assert.equal(receipts.durable_persistence_receipts.length, 1);
  assert.doesNotThrow(() => assertMemorizeArchitectureAggregate({
    commands: [command], receipts: receipts.durable_persistence_receipts,
    outcomes: [result],
  }));
});

test('extension-settings writers use the synchronous shared executor with rollback', () => {
  const state = { records: [{ id: 'before', content: 'before' }] };
  const receipts = {};
  const command = prepareFeaturePersistenceCommand({
    workflow_id: 'settings-gate', feature: 'canon', records: [{
      id: 'after', content: 'after', source_message_indices: [1],
    }],
  });
  assert.throws(() => executeFeaturePersistenceSync({ command,
    snapshot: () => state.records,
    apply: () => { state.records = [{ id: 'after', content: 'after' }]; },
    persist: () => { throw Object.assign(new Error('settings write failed'), {
      code: 'SME_TEST_SETTINGS_WRITE_FAILED',
    }); },
    restore: (before) => { state.records = before; },
    receipt_container: receipts,
  }), { code: 'SME_TEST_SETTINGS_WRITE_FAILED' });
  assert.deepEqual(state.records, [{ id: 'before', content: 'before' }]);
  assert.equal(receipts.durable_persistence_receipts, undefined);
});

test('deterministic 9,434-message gate reaches finalization with stable state', () => {
  const result = runMemorizeLongRunReleaseGate();
  assert.equal(result.message_count, 9434);
  assert.equal(result.checkpoint, 9434);
  assert.equal(result.duplicate_record_count, 0);
  assert.equal(result.finalization_reachable, true);
  assert.equal(result.idempotent, true);
  assert.equal(result.first_hash, result.second_hash);
});
