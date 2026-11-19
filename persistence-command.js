export const PERSISTENCE_COMMAND_SCHEMA_VERSION = 1;
import { cloneSerializableDomain, freezeDomainTree } from './serializable-domain.js';

const clone = (value) => cloneSerializableDomain(value, {
  path: '$.persistence_command', stage: 'persistence_command_validation',
  operation_type: value?.operation_type ?? value?.tier ?? null,
  obligation_id: value?.obligation_leaf_id ?? null,
  allow_undefined: true,
});
const unique = (items = []) => [...new Set((Array.isArray(items) ? items : [])
  .map((item) => String(item ?? '').trim()).filter(Boolean))];

export function providerCompletionIdentity(command = {}) {
  const commandId = String(command.command_id ?? command.commandId ?? '').trim();
  const logicalRunId = String(command.logical_run_id ?? command.logicalRunId ?? '').trim();
  const leafId = String(command.obligation_leaf_id ?? command.obligationLeafId ?? '').trim();
  const attemptId = String(command.attempt_id ?? command.attemptId ?? '').trim();
  if (!commandId || !logicalRunId || !leafId || !attemptId) throw Object.assign(
    new Error('Atomic provider completion requires command, run, leaf, and attempt identity.'), {
      code: 'SME_INVALID_PROVIDER_COMPLETION_COMMAND',
    });
  return { commandId, logicalRunId, leafId, attemptId };
}
function normalizedParserOutcome(value = {}) {
  const status = value.status ?? 'rejected';
  return {
    status: ['accepted', 'partial', 'rejected', 'explicit_none'].includes(status)
      ? status : 'rejected',
    accepted_candidate_ids: unique(value.accepted_candidate_ids),
    rejected_fragment_ids: unique(value.rejected_fragment_ids),
    reason_code: value.reason_code ?? null,
  };
}

function normalizedValidationOutcome(value = {}) {
  const status = value.status ?? 'not_applicable';
  return {
    status: ['accepted', 'partial', 'rejected', 'not_applicable', 'validated_no_update']
      .includes(status) ? status : 'rejected',
    accepted_candidate_ids: unique(value.accepted_candidate_ids),
    rejected_candidate_ids: unique(value.rejected_candidate_ids),
    reason_code: value.reason_code ?? null,
  };
}

function normalizedPersistence(value = {}) {
  return {
    status: value.status ?? 'not_required',
    durable_record_ids: unique(value.durable_record_ids),
    durable_record_candidate_map: { ...(value.durable_record_candidate_map ?? {}) },
    source_provenance: { ...(value.source_provenance ?? {}) },
  };
}

function validateDurableMappings(parser, persistence) {
  if (!persistence.durable_record_ids.length) return;
  for (const recordId of persistence.durable_record_ids) {
    const candidateId = String(persistence.durable_record_candidate_map[recordId] ?? '').trim();
    if (!candidateId || !parser.accepted_candidate_ids.includes(candidateId)) throw Object.assign(
      new Error('Every durable record must map to a parser-accepted candidate.'), {
        code: 'SME_DURABLE_RECORD_MAPPING_REQUIRED', record_id: recordId,
      });
  }
  if (!Object.keys(persistence.source_provenance).length) throw Object.assign(
    new Error('Durable records require source provenance.'), {
      code: 'SME_DURABLE_RECORD_PROVENANCE_REQUIRED',
    });
}

/** Domain-neutral, immutable validation boundary used by every provider writer. */
export function preparePersistenceCommand(commandValue = {}) {
  const command = clone(commandValue);
  command.schema_version = PERSISTENCE_COMMAND_SCHEMA_VERSION;
  providerCompletionIdentity(command);
  const parser = normalizedParserOutcome(command.parser_outcome);
  const validation = normalizedValidationOutcome(command.validation_outcome);
  const rawDurableIds = (command.persistence_outcome?.durable_record_ids ?? [])
    .map((value) => String(value ?? '').trim()).filter(Boolean);
  if (new Set(rawDurableIds).size !== rawDurableIds.length) throw Object.assign(
    new Error('A persistence command cannot contain duplicate durable record IDs.'), {
      code: 'SME_PERSISTENCE_COMMAND_DUPLICATE_RECORD_ID',
    });
  const persistence = normalizedPersistence(command.persistence_outcome);
  const required = {
    workflow_id: command.workflow_id,
    controller_instance_id: command.controller_identity?.instance_id,
    page_instance_id: command.controller_identity?.page_instance_id,
    transaction_id: command.transaction_identity?.transaction_id,
    transaction_generation: command.transaction_identity?.generation,
    work_item_id: command.work_item_id,
    source_range: command.source_range,
    source_fingerprint: command.source_fingerprint,
    intended_state_transition: command.intended_state_transition,
    journal_receipt_identity: command.journal_receipt_identity,
  };
  const missing = Object.entries(required).filter(([, value]) =>
    value == null || (typeof value !== 'object' && String(value).trim() === ''))
    .map(([key]) => key);
  if (missing.length) throw Object.assign(
    new Error(`Persistence command is incomplete: ${missing.join(', ')}.`), {
      code: 'SME_PERSISTENCE_COMMAND_IDENTITY_REQUIRED', missing_fields: missing,
    });
  if (!Array.isArray(command.idempotency_keys)
    || !command.idempotency_keys.includes(command.command_id)) throw Object.assign(
    new Error('Persistence command requires its command id as an idempotency key.'), {
      code: 'SME_PERSISTENCE_COMMAND_IDEMPOTENCY_REQUIRED',
    });
  validateDurableMappings(parser, persistence);
  const parserIds = new Set(parser.accepted_candidate_ids);
  const validationIds = new Set(validation.accepted_candidate_ids);
  for (const candidateId of validation.accepted_candidate_ids) {
    if (!parserIds.has(candidateId)) throw Object.assign(
      new Error('Validation accepted a candidate that the parser did not accept.'), {
        code: 'SME_VALIDATION_CANDIDATE_NOT_PARSER_ACCEPTED', candidate_id: candidateId,
      });
  }
  for (const [recordId, candidateIdValue] of Object.entries(
    persistence.durable_record_candidate_map)) {
    const candidateId = String(candidateIdValue ?? '').trim();
    if (!persistence.durable_record_ids.includes(recordId)) throw Object.assign(
      new Error('A durable candidate mapping refers to a record outside the durable receipt.'), {
        code: 'SME_DURABLE_RECORD_MAPPING_EXTRANEOUS', record_id: recordId,
      });
    if (!validationIds.has(candidateId)) throw Object.assign(
      new Error('Every durable record must map to a downstream-accepted candidate.'), {
        code: 'SME_DURABLE_RECORD_VALIDATION_MAPPING_REQUIRED', record_id: recordId,
        candidate_id: candidateId,
      });
  }
  const structuralRecords = Array.isArray(command.durable_records)
    ? command.durable_records : [];
  if (command.execution_scope === 'controller_managed'
    && structuralRecords.length !== persistence.durable_record_ids.length) throw Object.assign(
    new Error('Durable structural records must exactly match the persistence receipt.'), {
      code: 'SME_PERSISTENCE_COMMAND_RECORD_SET_MISMATCH',
    });
  for (const record of structuralRecords) {
    if (!record?.record_id || !record.candidate_id || !record.idempotency_key
      || !Object.keys(record.source_provenance ?? {}).length) throw Object.assign(
      new Error('Every durable structural record requires identity, mapping, provenance, and idempotency.'), {
        code: 'SME_PERSISTENCE_COMMAND_RECORD_INCOMPLETE', record_id: record?.record_id ?? null,
      });
  }
  command.parser_outcome = parser;
  command.validation_outcome = validation;
  command.persistence_outcome = persistence;
  cloneSerializableDomain(command, {
    path: '$.persistence_command', stage: 'persistence_command_validation',
    operation_type: command.tier ?? null,
    obligation_id: command.obligation_leaf_id ?? null,
  });
  return freezeDomainTree(command);
}

