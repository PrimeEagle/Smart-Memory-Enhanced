import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { assertSerializableDomain, immutableSerializableDomain }
  from '../serializable-domain.js';
import { createRuntimeEffectExecutor, executeEffectPlanAggregate,
  validateEffectPlanAggregate }
  from '../runtime-effect-executor.js';
import { createMemorizeTierOutcome } from '../memorize-tier-outcome.js';
import { memorizeOutcomeFromException } from '../memorize-outcome.js';
import { createLongtermOwnerEffectExecutor, createLongtermOwnerPersistencePlan }
  from '../longterm-owner-persistence.js';
import { createMemorizeExecutionAggregate, ensureMemorizeExecutionAggregate }
  from '../memorize-execution-kernel.js';
import { projectMemorizeObligationLedger } from '../memorize-obligation-ledger.js';
import { settleMemorizeTransactionCheckpoint }
  from '../memorize-transaction-settlement.js';
import { executeFeaturePersistence, prepareFeaturePersistenceCommand }
  from '../feature-persistence.js';

test('domain boundary rejects a nested callback with exact operational context', () => {
  assert.throws(() => createMemorizeTierOutcome({
    kind: 'complete', operation_type: 'longterm_owner_replace_v1',
    obligation_id: 'longterm:@multi-owner:20-39',
    value: { owners: { Alex: { commit: async () => {} } } },
  }), (error) => {
    assert.equal(error.code, 'SME_NON_SERIALIZABLE_DOMAIN_DATA');
    assert.equal(error.sme_serialization_path,
      '$.tier_outcome.value.owners.Alex.commit');
    assert.equal(error.sme_serialization_type, 'function');
    assert.equal(error.sme_operation_type, 'longterm_owner_replace_v1');
    assert.equal(error.sme_obligation_id, 'longterm:@multi-owner:20-39');
    assert.equal(error.sme_request_diagnostics.provider_call_required, false);
    return true;
  });
});

test('plain-data validator rejects promises, class instances, cycles, and accessors', () => {
  assert.throws(() => assertSerializableDomain({ pending: Promise.resolve() }),
    { code: 'SME_NON_SERIALIZABLE_DOMAIN_DATA' });
  assert.throws(() => assertSerializableDomain({ created: new Date() }),
    { code: 'SME_NON_SERIALIZABLE_DOMAIN_DATA' });
  assert.throws(() => assertSerializableDomain({ element: {
    nodeType: 1, nodeName: 'DIV', ownerDocument: null,
  } }), (error) => error.sme_serialization_path === '$.element'
    && error.code === 'SME_NON_SERIALIZABLE_DOMAIN_DATA');
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => assertSerializableDomain(cyclic),
    { code: 'SME_NON_SERIALIZABLE_DOMAIN_DATA' });
  const accessor = {};
  Object.defineProperty(accessor, 'runtime', { enumerable: true, get: () => 1 });
  assert.throws(() => assertSerializableDomain(accessor),
    { code: 'SME_NON_SERIALIZABLE_DOMAIN_DATA' });
});

test('aggregate validation finishes before the first runtime effect', () => {
  let effects = 0;
  const executor = createRuntimeEffectExecutor({
    owner_write_v1: async (plan) => {
      effects++;
      return { operation_type: plan.operation_type, plan_id: plan.plan_id,
        status: 'committed' };
    },
  });
  const plans = [
    { operation_type: 'owner_write_v1', plan_id: 'one', records: [] },
    { operation_type: 'owner_write_v1', plan_id: 'two', records: [], commit: () => {} },
  ];
  assert.throws(() => validateEffectPlanAggregate(executor, plans), (error) => {
    assert.equal(error.sme_serialization_path, '$.plans[1].commit');
    return true;
  });
  assert.equal(effects, 0);
});

test('aggregate fault matrix retains exact completed and pending receipts', async () => {
  const plans = ['one', 'two'].map((planId) => ({
    operation_type: 'owner_write_v1', plan_id: planId, owner: planId, records: [],
  }));
  const run = async (failStage) => {
    const writes = [];
    const executor = createRuntimeEffectExecutor({
      owner_write_v1: async (plan) => {
        if (failStage === `effect:${plan.plan_id}`) throw new Error('injected effect failure');
        writes.push(plan.plan_id);
        return { operation_type: plan.operation_type, plan_id: plan.plan_id,
          owner: plan.owner, status: 'committed' };
      },
    });
    try {
      const result = await executeEffectPlanAggregate({ executor, plans,
        hooks: { on_boundary: ({ stage }) => {
          if (stage === failStage) throw new Error(`injected ${stage}`);
        } } });
      return { result, writes };
    } catch (error) { return { error, writes }; }
  };
  const before = await run('before_effects');
  assert.deepEqual(before.writes, []);
  assert.deepEqual(before.error.sme_request_diagnostics.pending_owner_plan_ids, ['one', 'two']);
  const first = await run('effect:one');
  assert.deepEqual(first.writes, []);
  assert.deepEqual(first.error.sme_request_diagnostics.completed_owner_receipts, []);
  const second = await run('effect:two');
  assert.deepEqual(second.writes, ['one']);
  assert.deepEqual(second.error.sme_request_diagnostics.completed_owner_receipts
    .map((receipt) => receipt.plan_id), ['one']);
  assert.deepEqual(second.error.sme_request_diagnostics.pending_owner_plan_ids, ['two']);
  const after = await run('after_effects');
  assert.deepEqual(after.writes, ['one', 'two']);
  assert.deepEqual(after.error.sme_request_diagnostics.completed_owner_receipts
    .map((receipt) => receipt.plan_id), ['one', 'two']);
  assert.deepEqual(after.error.sme_request_diagnostics.pending_owner_plan_ids, []);
  const success = await run(null);
  assert.deepEqual(success.result.receipts.map((receipt) => receipt.plan_id), ['one', 'two']);
});

test('an invalid effect receipt fails before it enters an aggregate outcome', async () => {
  const executor = createRuntimeEffectExecutor({
    owner_write_v1: async () => ({ plan_id: 'one', status: 'committed', rollback: () => {} }),
  });
  await assert.rejects(() => executeEffectPlanAggregate({ executor, plans: [{
    operation_type: 'owner_write_v1', plan_id: 'one', owner: 'Alex', records: [],
  }] }), (error) => {
    assert.equal(error.code, 'SME_NON_SERIALIZABLE_DOMAIN_DATA');
    assert.equal(error.sme_serialization_path, '$.receipt.rollback');
    assert.equal(error.sme_request_diagnostics.provider_call_required, false);
    return true;
  });
});

test('executor receipts cross the tier outcome boundary as immutable plain data', async () => {
  const executor = createRuntimeEffectExecutor({
    owner_write_v1: async (plan) => ({ operation_type: plan.operation_type,
      plan_id: plan.plan_id, owner: plan.owner, status: 'committed',
      durable_record_ids: ['memory-1'] }),
  });
  const plan = immutableSerializableDomain({ operation_type: 'owner_write_v1',
    plan_id: 'one', owner: 'Alex', records: [{ id: 'memory-1' }] });
  validateEffectPlanAggregate(executor, [plan]);
  const receipt = await executor.execute(plan);
  const outcome = createMemorizeTierOutcome({ kind: 'complete',
    durable_receipts: [receipt], value: { owners: { Alex: receipt } } });
  assert.equal(structuredClone(outcome).value.owners.Alex.status, 'committed');
  assert.equal(Object.isFrozen(receipt), true);
});

test('production Long-Term plan invokes adapters out of band and returns a plain receipt', async () => {
  const calls = [];
  const plan = createLongtermOwnerPersistencePlan({
    plan_id: 'owner-plan-1', owner: 'Alex', storage_scope: 'character',
    status: 'committed', added: 1, durable_record_ids: ['memory-1'],
    durable_record_candidate_map: { 'memory-1': 'candidate-1' },
    candidate_ids: ['candidate-1'], durable_memories: [{ id: 'memory-1' }],
    entity_registry: [{ id: 'entity-1' }],
  });
  const executor = createLongtermOwnerEffectExecutor({
    save_entity_registry: async (owner) => calls.push(`entities:${owner}`),
    save_chat_local_memories: async (owner) => calls.push(`local:${owner}`),
    save_character_memories: async (owner) => calls.push(`character:${owner}`),
  });
  validateEffectPlanAggregate(executor, [plan]);
  const receipt = await executor.execute(plan);
  assert.deepEqual(calls, ['entities:Alex', 'character:Alex']);
  assert.equal(receipt.plan_id, 'owner-plan-1');
  assert.equal(receipt.durable_record_candidate_map['memory-1'], 'candidate-1');
  assert.doesNotThrow(() => structuredClone(receipt));
  assert.equal('durable_memories' in receipt, false);
});

test('local serialization defects are terminal and never select provider retry', () => {
  let error;
  try { assertSerializableDomain({ commit: () => {} }, {
    obligation_id: 'longterm:@multi-owner:20-39', operation_type: 'owner_write_v1',
  }); } catch (caught) { error = caught; }
  const outcome = memorizeOutcomeFromException(error);
  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.reason_code, 'non_serializable_domain_data');
  assert.equal(outcome.resumable, false);
  assert.equal(outcome.provider_call_required, false);
  assert.equal(outcome.next_action, null);
});

test('authoritative kernel rejects runtime effects before state reduction', () => {
  const aggregate = createMemorizeExecutionAggregate('run-boundary');
  aggregate.runtime_adapter = () => {};
  assert.throws(() => ensureMemorizeExecutionAggregate(aggregate, 'run-boundary'),
    (error) => error.code === 'SME_NON_SERIALIZABLE_DOMAIN_DATA'
      && error.sme_serialization_path === '$.execution_aggregate.runtime_adapter'
      && error.sme_request_diagnostics.provider_call_required === false);
});

test('checkpoint settlement and diagnostic projection reject runtime handles with exact paths', () => {
  assert.throws(() => settleMemorizeTransactionCheckpoint({
    status: 'in_progress', controller: { cancel: () => {} },
  }, { state: 'committed', owner: {} }), (error) =>
    error.code === 'SME_NON_SERIALIZABLE_DOMAIN_DATA'
      && error.sme_serialization_path === '$.checkpoint.controller.cancel');

  const aggregate = createMemorizeExecutionAggregate('run-projection');
  aggregate.recovery_backlog = [{ obligation_id: 'one', apply: () => {} }];
  assert.throws(() => projectMemorizeObligationLedger(aggregate), (error) =>
    error.code === 'SME_NON_SERIALIZABLE_DOMAIN_DATA'
      && error.sme_serialization_path
        === '$.obligation_projection.recovery_backlog[0].apply');
});

test('production feature writers validate actual records before identity derivation or effects', async () => {
  let effects = 0;
  assert.throws(() => prepareFeaturePersistenceCommand({
    workflow_id: 'realtime:one', feature: 'session', records: [{
      id: 'memory-1', content: 'plain evidence', adapter: () => {},
    }],
  }), (error) => error.code === 'SME_NON_SERIALIZABLE_DOMAIN_DATA'
    && error.sme_serialization_path === '$.feature_records[0].adapter'
    && error.sme_request_diagnostics.provider_call_required === false);

  const command = prepareFeaturePersistenceCommand({
    workflow_id: 'realtime:one', feature: 'session', records: [{
      id: 'memory-1', content: 'plain evidence', source_message_indices: [1],
    }],
  });
  const container = {};
  const result = await executeFeaturePersistence({ command,
    snapshot: () => [], apply: () => { effects++; }, persist: () => { effects++; },
    restore: () => { effects++; }, receipt_container: container });
  assert.equal(effects, 2);
  assert.equal(result.status, 'committed');
  assert.doesNotThrow(() => structuredClone(result));
  assert.equal(container.durable_persistence_receipts.length, 1);
});

test('production multi-owner wiring contains plans and receipts, never deferred callbacks', () => {
  const runtime = fs.readFileSync(new URL('../multi-owner-longterm-runtime.js', import.meta.url), 'utf8');
  const longterm = fs.readFileSync(new URL('../longterm.js', import.meta.url), 'utf8');
  assert.match(runtime, /validateEffectPlanAggregate/);
  assert.match(runtime, /createLongtermOwnerPersistenceExecutor/);
  assert.doesNotMatch(runtime, /\.commit\?\.|defer_commit/);
  const planner = longterm.slice(longterm.indexOf('export async function prepareLongtermOwnerPersistencePlan'),
    longterm.indexOf('export function createLongtermOwnerPersistenceExecutor'));
  assert.match(planner, /operation_type: LONGTERM_OWNER_REPLACE_OPERATION/);
  assert.doesNotMatch(planner, /const commit|async \(\) =>/);
});
