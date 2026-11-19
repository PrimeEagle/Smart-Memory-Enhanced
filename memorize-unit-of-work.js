import { applyProviderCompletion, ensureMemorizeExecutionAggregate,
  observeMemorizeKernelCommit } from './memorize-execution-kernel.js';
import { preparePersistenceCommand } from './persistence-command.js';
import { deriveMemorizeSafeResumeOffset } from './memorize-obligation-ledger.js';
import { cloneSerializableDomain } from './serializable-domain.js';

export const MEMORIZE_UNIT_OF_WORK_SCHEMA_VERSION = 2;

function clone(value) {
  return cloneSerializableDomain(value, {
    path: '$.memorize_unit_of_work', stage: 'unit_of_work_boundary',
  });
}

export function prepareMemorizeUnitOfWork(stateValue, command, now = Date.now()) {
  // The command must be complete before an intent is journaled or a storage
  // callback can run.  In particular, candidate mappings cannot be discovered
  // after records have already been written.
  command = preparePersistenceCommand(command);
  const state = clone(stateValue ?? {});
  state.aggregate = ensureMemorizeExecutionAggregate(state.aggregate, command.logical_run_id);
  state.unit_of_work_journal ??= [];
  const commandId = String(command.command_id ?? command.commandId ?? '');
  const existing = state.unit_of_work_journal.find((item) => item.command_id === commandId);
  if (existing?.phase === 'committed') return { status: 'idempotent_duplicate', state, intent: existing };
  const intent = existing ?? {
    schema_version: MEMORIZE_UNIT_OF_WORK_SCHEMA_VERSION,
    command_id: commandId,
    logical_run_id: command.logical_run_id,
    obligation_leaf_id: command.obligation_leaf_id,
    attempt_id: command.attempt_id,
    command: clone(command),
    expected_revision: Number(state.aggregate.execution_kernel?.revision) || 0,
    phase: 'prepared',
    prepared_at: now,
  };
  if (!existing) state.unit_of_work_journal.push(intent);
  state.unit_of_work_journal = state.unit_of_work_journal.slice(-64);
  return { status: 'prepared', state, intent };
}

export function markMemorizeRecordsApplied(stateValue, commandId, recordResult = {}, now = Date.now()) {
  const state = clone(stateValue);
  const intent = state.unit_of_work_journal?.find((item) => item.command_id === commandId);
  if (!intent) throw Object.assign(new Error('Memorize unit-of-work intent is missing.'), {
    code: 'SME_MEMORIZE_UNIT_OF_WORK_INTENT_MISSING',
  });
  if (intent.phase === 'committed') return { status: 'idempotent_duplicate', state, intent };
  intent.phase = 'storage_write_confirmed';
  intent.record_result = clone(recordResult);
  intent.records_applied_at = now;
  return { status: 'storage_write_confirmed', state, intent };
}

export function markMemorizeStorageWriteStarted(stateValue, commandId, now = Date.now()) {
  const state = clone(stateValue);
  const intent = state.unit_of_work_journal?.find((item) => item.command_id === commandId);
  if (!intent) throw Object.assign(new Error('Memorize unit-of-work intent is missing.'), {
    code: 'SME_MEMORIZE_UNIT_OF_WORK_INTENT_MISSING',
  });
  if (intent.phase === 'committed') return { status: 'idempotent_duplicate', state, intent };
  intent.phase = 'storage_write_started';
  intent.storage_write_started_at = now;
  return { status: intent.phase, state, intent };
}

export function markMemorizeCanonicalReceiptPending(stateValue, commandId, now = Date.now()) {
  const state = clone(stateValue);
  const intent = state.unit_of_work_journal?.find((item) => item.command_id === commandId);
  if (!intent || intent.phase !== 'storage_write_confirmed') throw Object.assign(
    new Error('A canonical receipt requires a confirmed storage write.'), {
      code: 'SME_MEMORIZE_UNIT_OF_WORK_PHASE_INVALID',
    });
  intent.phase = 'canonical_receipt_pending';
  intent.canonical_receipt_pending_at = now;
  return { status: intent.phase, state, intent };
}

export function commitMemorizeUnitOfWork(stateValue, commandId, checkpointPatch = {}, now = Date.now()) {
  const state = clone(stateValue);
  const intent = state.unit_of_work_journal?.find((item) => item.command_id === commandId);
  if (!intent) throw Object.assign(new Error('Memorize unit-of-work intent is missing.'), {
    code: 'SME_MEMORIZE_UNIT_OF_WORK_INTENT_MISSING',
  });
  if (intent.phase === 'committed') return { status: 'idempotent_duplicate', state, intent,
    receipt: intent.receipt };
  if (!['storage_write_confirmed', 'canonical_receipt_pending'].includes(intent.phase)) throw Object.assign(
    new Error(`Memorize unit-of-work phase ${intent.phase} cannot commit.`), {
      code: 'SME_MEMORIZE_UNIT_OF_WORK_PHASE_INVALID',
    });
  const result = applyProviderCompletion(state.aggregate, intent.command, now);
  if (!['applied', 'idempotent_duplicate', 'late_callback_ignored'].includes(result.status)) return {
    status: 'blocked', state: stateValue, reason_code: result.reason_code,
  };
  const requestedOffset = Number(checkpointPatch.next_source_offset);
  if (Number.isFinite(requestedOffset)) {
    const safeOffset = deriveMemorizeSafeResumeOffset(result.aggregate,
      Number(state.checkpoint?.starting_source_offset) || 0);
    if (requestedOffset > safeOffset) return {
      status: 'blocked', state: stateValue,
      reason_code: 'checkpoint_would_cross_nonterminal_frontier',
      safe_offset: safeOffset, requested_offset: requestedOffset,
    };
  }
  state.aggregate = result.aggregate;
  state.checkpoint = { ...(state.checkpoint ?? {}), ...clone(checkpointPatch),
    aggregate_revision: result.receipt?.aggregate_revision
      ?? state.aggregate.execution_kernel?.revision, updated_at: now };
  intent.phase = 'committed';
  intent.receipt = clone(result.receipt);
  intent.committed_at = now;
  return { status: result.status, state, intent, receipt: result.receipt };
}

export async function executeMemorizeUnitOfWork(input = {}) {
  let prepared = prepareMemorizeUnitOfWork(input.state, input.command, input.now?.() ?? Date.now());
  if (prepared.status === 'idempotent_duplicate') return prepared;
  let state = prepared.state;
  await input.persist?.(clone(state));
  if (input.apply_records) {
    state = markMemorizeStorageWriteStarted(state, prepared.intent.command_id,
      input.now?.() ?? Date.now()).state;
    await input.persist?.(clone(state));
    try {
      const recordResult = await input.apply_records(clone(prepared.intent.command.persistence_outcome));
      state = markMemorizeRecordsApplied(state, prepared.intent.command_id, recordResult,
        input.now?.() ?? Date.now()).state;
      await input.persist?.(clone(state));
    } catch (error) {
      const failed = clone(state);
      const intent = failed.unit_of_work_journal.find((item) =>
        item.command_id === prepared.intent.command_id);
      intent.phase = 'compensation_required';
      intent.storage_error = { code: error?.code ?? null, message: error?.message ?? String(error) };
      intent.compensation_required_at = input.now?.() ?? Date.now();
      await input.persist?.(clone(failed));
      error.sme_unit_of_work_state = failed;
      error.sme_reason_code ??= 'storage_write_failed_compensation_required';
      throw error;
    }
  } else {
    state = markMemorizeRecordsApplied(state, prepared.intent.command_id, {
      persistence_status: 'not_required', durable_record_ids: [],
    }, input.now?.() ?? Date.now()).state;
  }
  state = markMemorizeCanonicalReceiptPending(state, prepared.intent.command_id,
    input.now?.() ?? Date.now()).state;
  await input.persist?.(clone(state));
  const committed = commitMemorizeUnitOfWork(state, prepared.intent.command_id,
    input.checkpoint_patch, input.now?.() ?? Date.now());
  if (committed.status === 'blocked') return committed;
  await input.persist?.(clone(committed.state));
  const observation = await observeMemorizeKernelCommit(input.observe, {
    type: 'memorize_unit_of_work_committed', receipt: committed.receipt,
  });
  return { ...committed, observation };
}

export function replayPreparedMemorizeUnitOfWork(stateValue, commandId, checkpointPatch = {}, now = Date.now()) {
  return commitMemorizeUnitOfWork(stateValue, commandId, checkpointPatch, now);
}

