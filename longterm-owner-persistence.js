import { cloneSerializableDomain, immutableSerializableDomain } from './serializable-domain.js';
import { createRuntimeEffectExecutor } from './runtime-effect-executor.js';

export const LONGTERM_OWNER_REPLACE_OPERATION = 'longterm_owner_replace_v1';
export const LONGTERM_OWNER_NOOP_OPERATION = 'longterm_owner_noop_v1';

export function createLongtermOwnerPersistencePlan(input = {}) {
  const operationType = input.operation_type ?? LONGTERM_OWNER_REPLACE_OPERATION;
  const plan = operationType === LONGTERM_OWNER_NOOP_OPERATION ? {
    schema_version: 1, operation_type: operationType,
    plan_id: input.plan_id, owner: input.owner ?? null,
    status: input.status ?? 'not_applicable', added: 0,
    durable_record_ids: [], durable_record_candidate_map: {}, candidate_ids: [],
  } : {
    schema_version: 1, operation_type: operationType,
    plan_id: input.plan_id, owner: input.owner,
    storage_scope: input.storage_scope,
    status: input.status, added: input.added,
    durable_record_ids: input.durable_record_ids,
    durable_record_candidate_map: input.durable_record_candidate_map,
    candidate_ids: input.candidate_ids,
    durable_memories: input.durable_memories,
    entity_registry: input.entity_registry,
  };
  return immutableSerializableDomain(plan, {
    path: '$.owner_persistence_plan', stage: 'owner_plan_construction',
    operation_type: operationType,
  });
}

export function createLongtermOwnerEffectExecutor(adapters = {}) {
  const saveRegistry = adapters.save_entity_registry;
  const saveChatLocal = adapters.save_chat_local_memories;
  const saveCharacter = adapters.save_character_memories;
  if (![saveRegistry, saveChatLocal, saveCharacter].every((value) => typeof value === 'function')) {
    throw new TypeError('Long-Term owner persistence requires all three runtime storage adapters.');
  }
  return createRuntimeEffectExecutor({
    [LONGTERM_OWNER_NOOP_OPERATION]: async (plan) => ({
      schema_version: 1, operation_type: plan.operation_type,
      plan_id: plan.plan_id, owner: plan.owner, status: plan.status, added: 0,
      durable_record_ids: [], durable_record_candidate_map: {}, candidate_ids: [],
    }),
    [LONGTERM_OWNER_REPLACE_OPERATION]: async (plan) => {
      if (plan.entity_registry.length) await saveRegistry(plan.owner, cloneSerializableDomain(plan.entity_registry));
      const memories = cloneSerializableDomain(plan.durable_memories);
      if (plan.storage_scope === 'chat_local') {
        await saveChatLocal(plan.owner, memories);
      } else await saveCharacter(plan.owner, memories);
      return {
        schema_version: 1, operation_type: plan.operation_type,
        plan_id: plan.plan_id, owner: plan.owner, status: plan.status,
        added: plan.added, durable_record_ids: plan.durable_record_ids,
        durable_record_candidate_map: plan.durable_record_candidate_map,
        candidate_ids: plan.candidate_ids,
      };
    },
  });
}
