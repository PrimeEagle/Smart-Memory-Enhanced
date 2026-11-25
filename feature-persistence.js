import { assignCandidateIdentity, candidateIdentityOf } from './candidate-identity.js';
import { preparePersistenceCommand } from './persistence-command.js';
import { assertSerializableDomain, cloneSerializableDomain,
  immutableSerializableDomain } from './serializable-domain.js';

const fingerprint = (value) => {
  let hash = 2166136261;
  for (const character of String(value ?? '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const recordIdOf = (record, feature, owner, index) => String(record?.id
  ?? record?.key ?? record?._canonical_card_id
  ?? `${feature}:${owner ?? 'global'}:${index}:${fingerprint(JSON.stringify(record ?? null))}`);

const provenanceOf = (record, fallback) => {
  const indices = [...new Set((record?.source_message_indices ?? record?.source_indices ?? [])
    .map(Number).filter(Number.isInteger))];
  if (indices.length) return { source_indices: indices };
  const sourceIds = [...new Set((record?.source_memory_ids ?? record?.source_scene_ids ?? [])
    .map(String).filter(Boolean))];
  return sourceIds.length ? { source_record_ids: sourceIds } : { ...fallback };
};

/**
 * Creates the same structural command for independent domain writers without
 * coupling their state machines to the Memorize obligation graph.
 */
export function prepareFeaturePersistenceCommand({
  workflow_id: workflowId, feature, operation = 'replace_snapshot', owner = null,
  records = [], source_provenance: fallbackProvenance = null, command_id: commandId = null,
} = {}) {
  if (!workflowId || !feature) throw Object.assign(
    new Error('Feature persistence requires workflow and feature identity.'), {
      code: 'SME_FEATURE_PERSISTENCE_IDENTITY_REQUIRED',
    });
  assertSerializableDomain(records, {
    path: '$.feature_records', stage: 'feature_record_plan_validation',
    operation_type: String(operation), obligation_id: `${feature}:${owner ?? 'global'}`,
  });
  const fallback = fallbackProvenance ?? {
    workflow_id: String(workflowId), feature: String(feature), operation: String(operation),
  };
  const descriptors = records.map((record, index) => {
    const recordId = recordIdOf(record, feature, owner, index);
    const candidateId = candidateIdentityOf(record)
      ?? `${feature}-candidate:${fingerprint(`${workflowId}:${recordId}`)}`;
    assignCandidateIdentity(record, candidateId);
    return { record_id: recordId, candidate_id: candidateId,
      source_provenance: provenanceOf(record, fallback) };
  });
  const id = commandId ?? `${workflowId}:${feature}:${operation}:${fingerprint(
    descriptors.map((record) => `${record.record_id}:${record.candidate_id}`).join('|'))}`;
  const sourceIndices = [...new Set(descriptors.flatMap((record) =>
    record.source_provenance.source_indices ?? []).map(Number).filter(Number.isInteger))]
    .sort((left, right) => left - right);
  const sourceRange = sourceIndices.length
    ? { start: sourceIndices[0], end: sourceIndices.at(-1) }
    : { start: null, end: null, kind: 'validated_domain_snapshot' };
  const sourceFingerprint = `fnv1a-${fingerprint(JSON.stringify({
    workflowId, feature, owner, sourceRange, records: descriptors.map((record) => record.record_id),
  }))}`;
  const candidateIds = descriptors.map((record) => record.candidate_id);
  const durableIds = descriptors.map((record) => record.record_id);
  const candidateMap = Object.fromEntries(descriptors.map((record) =>
    [record.record_id, record.candidate_id]));
  return preparePersistenceCommand({
    command_id: id, logical_run_id: String(workflowId), workflow_id: String(workflowId),
    obligation_leaf_id: `${feature}:${owner ?? 'global'}`,
    attempt_id: `${id}:attempt`, execution_scope: 'independent_workflow',
    controller_identity: { instance_id: `feature-controller:${feature}`,
      page_instance_id: 'current-page', cancellation_epoch: 0 },
    transaction_identity: { transaction_id: id, generation: 1 },
    tier: feature, owner, work_item_id: `${feature}:${owner ?? 'global'}`,
    source_range: sourceRange, source_fingerprint: sourceFingerprint,
    parser_outcome: { status: records.length ? 'accepted' : 'explicit_none',
      accepted_candidate_ids: candidateIds },
    validation_outcome: { status: records.length ? 'accepted' : 'validated_no_update',
      accepted_candidate_ids: candidateIds },
    // Replacing a domain snapshot with an empty collection is still a durable
    // mutation (a clear), not an explicit no-update outcome.  Feature commands
    // are effect requests by construction; callers that have no effect should
    // not dispatch a command.
    persistence_outcome: { status: 'committed',
      durable_record_ids: durableIds, durable_record_candidate_map: candidateMap,
      source_provenance: fallback },
    durable_records: descriptors.map((record) => ({ ...record,
      idempotency_key: `${id}:record:${record.record_id}` })),
    idempotency_keys: [id, ...descriptors.map((record) =>
      `${id}:record:${record.record_id}`)],
    duplicate_no_update_disposition: records.length
      ? 'replace_validated_domain_snapshot' : 'clear_validated_domain_snapshot',
    intended_state_transition: 'durably_committed',
    checkpoint_effect: { feature, operation, checkpoint_eligible_on_commit: true },
    journal_receipt_identity: id,
  });
}
export function recordFeaturePersistenceReceipt(command, receiptContainer) {
  const prepared = preparePersistenceCommand(command);
  const receipt = immutableSerializableDomain({
    schema_version: 1, command_id: prepared.command_id,
    journal_receipt_identity: prepared.journal_receipt_identity,
    workflow_id: prepared.workflow_id, feature: prepared.tier,
    owner: prepared.owner ?? null, durable_record_count: prepared.durable_records.length,
    intended_state_transition: prepared.intended_state_transition,
    checkpoint_effect: cloneSerializableDomain(prepared.checkpoint_effect, {
      path: '$.feature_persistence_receipt.checkpoint_effect',
      stage: 'feature_receipt_construction', operation_type: prepared.tier,
    }), committed_at: Date.now(),
  }, {
    path: '$.feature_persistence_receipt', stage: 'feature_receipt_construction',
    operation_type: prepared.tier, obligation_id: prepared.obligation_leaf_id,
  });
  if (receiptContainer) {
    receiptContainer.durable_persistence_receipts = [
      ...(receiptContainer.durable_persistence_receipts ?? [])
        .filter((item) => item?.command_id !== receipt.command_id), receipt,
    ].slice(-128);
  }
  return receipt;
}

/** Validate first, then mutate and persist; restore the prior in-memory state on failure. */
export async function executeFeaturePersistence({ command, snapshot, apply, persist,
  restore, receipt_container: receiptContainer = null } = {}) {
  const prepared = preparePersistenceCommand(command);
  const before = snapshot?.();
  const priorReceipts = receiptContainer
    ? cloneSerializableDomain(receiptContainer.durable_persistence_receipts ?? [], {
      path: '$.feature_persistence.prior_receipts', stage: 'feature_receipt_snapshot',
      operation_type: prepared.tier,
    }) : null;
  try {
    await apply(prepared);
    const receipt = recordFeaturePersistenceReceipt(prepared, receiptContainer);
    await persist(prepared, receipt);
    return immutableSerializableDomain({ status: 'committed', command: prepared, receipt }, {
      path: '$.feature_persistence_result', stage: 'feature_result_construction',
      operation_type: prepared.tier, obligation_id: prepared.obligation_leaf_id,
    });
  } catch (error) {
    await restore?.(before);
    if (receiptContainer) {
      if (priorReceipts.length) receiptContainer.durable_persistence_receipts = priorReceipts;
      else delete receiptContainer.durable_persistence_receipts;
    }
    error.sme_failure_stage ??= 'storage_write';
    error.sme_reason_code ??= 'feature_persistence_storage_failure';
    error.sme_persistence_command_id = prepared.command_id;
    throw error;
  }
}

/**
 * Synchronous form for SillyTavern's extension-settings store. The same
 * validated command, receipt, snapshot, and rollback rules apply; callers may
 * not publish a receipt by mutating the settings object directly.
 */
export function executeFeaturePersistenceSync({ command, snapshot, apply, persist,
  restore, receipt_container: receiptContainer = null } = {}) {
  const prepared = preparePersistenceCommand(command);
  const before = cloneSerializableDomain(snapshot?.(), {
    path: '$.feature_persistence.snapshot', stage: 'feature_snapshot',
    operation_type: prepared.tier,
  });
  const priorReceipts = receiptContainer
    ? cloneSerializableDomain(receiptContainer.durable_persistence_receipts ?? [], {
      path: '$.feature_persistence.prior_receipts', stage: 'feature_receipt_snapshot',
      operation_type: prepared.tier,
    }) : null;
  try {
    apply(prepared);
    const receipt = recordFeaturePersistenceReceipt(prepared, receiptContainer);
    persist(prepared, receipt);
    return immutableSerializableDomain({ status: 'committed', command: prepared, receipt }, {
      path: '$.feature_persistence_result', stage: 'feature_result_construction',
      operation_type: prepared.tier, obligation_id: prepared.obligation_leaf_id,
    });
  } catch (error) {
    restore?.(before);
    if (receiptContainer) {
      if (priorReceipts.length) receiptContainer.durable_persistence_receipts = priorReceipts;
      else delete receiptContainer.durable_persistence_receipts;
    }
    error.sme_failure_stage ??= 'storage_write';
    error.sme_reason_code ??= 'feature_persistence_storage_failure';
    error.sme_persistence_command_id = prepared.command_id;
    throw error;
  }
}

