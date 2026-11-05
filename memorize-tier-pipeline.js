import { beginProviderAttempt } from './provider-attempt-audit.js';
import { acknowledgeJournalTransition, createMemorizeLifecycleIdentity,
  requireAppliedLifecycleResult } from './memorize-lifecycle-coordinator.js';

const EXPECTED_EVENT_STATES = Object.freeze({
  obligation_registered: [],
  provider_attempt_started: ['provider_running'],
  provider_response_received: ['provider_response_received'],
  provider_transport_failed: ['pending_recovery'],
  parser_accepted: ['parser_accepted'],
  parser_partially_accepted: ['parser_partial'],
  parser_rejected: ['parser_rejected'],
  validation_accepted: ['validation_accepted'],
  validation_partially_accepted: ['validation_partial'],
  validation_rejected: ['validation_rejected'],
  records_staged: ['staged'],
  records_durably_persisted: ['durably_committed'],
  explicit_no_update_accepted: ['explicit_no_update'],
  recovery_required: ['pending_recovery'],
  recovery_budget_exhausted: ['operationally_paused'],
  obligation_blocked: ['blocked'],
});

function completionJournalEntry(metadata, attemptId) {
  const journal = metadata?.provider_completion_journal;
  if (!journal || !attemptId) return null;
  if (Array.isArray(journal.entries)) return journal.entries.find((entry) => entry.attempt_id === attemptId) ?? null;
  return journal.entries?.[attemptId] ?? null;
}

export function recordTierCoverage(ledger, record) {
  if (!ledger) return record;
  ledger.records ??= [];
  const index = ledger.records.findIndex((entry) => entry.range_id === record.range_id);
  if (index >= 0) ledger.records[index] = { ...ledger.records[index], ...record };
  else ledger.records.push(record);
  return record;
}

export function createTierContextOverflowError(tierLabel, preflight, range) {
  const error = new Error(`${tierLabel} extraction window exceeds the configured context budget before request dispatch.`);
  error.code = 'SME_ESTIMATED_CONTEXT_OVERFLOW';
  error.sme_request_diagnostics = {
    http_status: 400,
    likely_cause: 'estimated_context_overflow',
    request_prevented: true,
    ...preflight,
    source_start_index: range.start,
    source_end_index: range.end,
  };
  return error;
}

/** Shared provider -> obligation -> coverage lifecycle for an extraction leaf. */
export function createMemorizeTierPipeline(input) {
  const {
    tier, tierLabel, owner = null, execution, metadata, range, rangeId,
    parentRangeId = null, depth = 0, coverageLedger, sourceFingerprint,
    preflight, requestBudget, providerConfigSignature, chatId,
    expectedOutputFormat, schemaVersion = expectedOutputFormat,
  } = input;
  const rootObligationId = execution.provider.root_obligation_id
    ?? `${tier}:${owner == null ? 'chat' : String(owner).toLowerCase()}:${range.start}-${range.end}:${sourceFingerprint}`;
  const rootSourceRange = execution.provider.root_source_range
    ?? { start: range.start, end: range.end, message_count: range.message_count };
  const isRecoveryLeaf = range.start !== rootSourceRange.start || range.end !== rootSourceRange.end;
  const leafObligationId = isRecoveryLeaf
    ? `${rootObligationId}:leaf:${range.start}-${range.end}:${sourceFingerprint}`
    : rootObligationId;
  const coverageBase = Object.freeze({
    range_id: rangeId,
    parent_range_id: parentRangeId,
    tier,
    ...(owner == null ? {} : { owner }),
    original_range: { start: range.start, end: range.end, message_count: range.message_count },
    effective_range: { start: range.start, end: range.end, message_count: range.message_count },
    citation_mapping_valid: Array.isArray(range.source_indices) && range.source_indices.every(Number.isInteger),
    source_fingerprint: sourceFingerprint,
    preflight,
    request_sent: false,
  });

  const recordCoverage = (patch) => recordTierCoverage(coverageLedger, { ...coverageBase, ...patch });
  const recordCompletedCoverage = (providerOutcome = 'completed') => recordCoverage({
    request_sent: true,
    provider_outcome: providerOutcome,
    coverage_terminal_state: 'completed',
    all_source_messages_covered: true,
  });
  const lifecycleIdentity = createMemorizeLifecycleIdentity({
    logical_run_id: metadata?.active_catchup_run_id ?? null,
    root_obligation_id: rootObligationId,
    leaf_obligation_id: leafObligationId,
    parent_obligation_id: isRecoveryLeaf ? rootObligationId : null,
    tier, owner,
    source_range: { start: range.start, end: range.end, message_count: range.message_count },
    source_fingerprint: sourceFingerprint,
  });
  const emitLifecycleEvent = async (type, details = {}) => {
    const event = {
      obligation_id: leafObligationId,
      root_obligation_id: rootObligationId,
      leaf_obligation_id: leafObligationId,
      parent_obligation_id: isRecoveryLeaf ? rootObligationId : null,
      tier, owner,
      source_range: lifecycleIdentity.source_range,
      source_fingerprint: sourceFingerprint,
      type,
      ...details,
    };
    const result = await execution.hooks.obligation_event(event);
    if (!execution.controller.lifecycle_required) return result;
    const receipt = requireAppliedLifecycleResult(result, EXPECTED_EVENT_STATES[type] ?? [], {
      stage: type, obligation_id: leafObligationId, event_type: type,
      prior_state: execution.provider.root_obligation_state,
      evidence_fingerprint: details.evidence_fingerprint ?? null,
    });
    if (['records_durably_persisted', 'explicit_no_update_accepted'].includes(type)) {
      const entry = completionJournalEntry(metadata, details.provider_attempt_id);
      if (!entry) {
        const error = new Error('Terminal lifecycle transition has no matching provider-completion journal entry.');
        error.code = 'SME_TERMINAL_JOURNAL_ENTRY_REQUIRED';
        error.sme_recovery_blocked = true;
        error.sme_obligation_id = leafObligationId;
        throw error;
      }
      const disposition = type === 'explicit_no_update_accepted'
        ? 'explicit_no_update' : 'durably_committed';
      acknowledgeJournalTransition(entry, 'ledger_transition', receipt, {
        target_obligation_id: leafObligationId, disposition,
      });
      acknowledgeJournalTransition(entry, 'manifest_transition', receipt, {
        target_obligation_id: leafObligationId,
        disposition: type === 'explicit_no_update_accepted' ? 'explicit_no_update' : 'leaf_covered',
      });
      entry.completed_at ??= Date.now();
      entry.updated_at = Date.now();
      await execution.hooks.provider_completion_journal_updated(entry, {
        await_point: 'obligation_update', progress: true,
        last_durable_transition: disposition,
      });
    }
    return receipt;
  };
  const beginAttempt = (requestKind = execution.provider.request_kind
    ?? (depth ? 'repartition_child' : 'original'), changedDimensions = execution.provider.changed_recovery_dimensions.length
    ? execution.provider.changed_recovery_dimensions
    : (depth ? ['source_range', 'estimated_request_size'] : []), recovery = {}) => beginProviderAttempt(metadata, {
      tier,
      owner,
      logical_obligation_id: rootObligationId,
      child_obligation_id: leafObligationId,
      controller_attempt_number: execution.controller.attempt_number,
      chat_id: chatId,
      parent_attempt_id: execution.provider.parent_attempt_id,
      repartition_parent_id: parentRangeId,
      request_kind: requestKind,
      changed_recovery_dimensions: changedDimensions,
      recovery_of_attempt_id: recovery.recovery_of_attempt_id ?? null,
      source_unit_key: recovery.source_unit_key ?? null,
      target_source_unit: recovery.target_source_unit ?? recovery.source_unit_key ?? null,
      target_source_fingerprint: recovery.target_source_fingerprint ?? null,
      context_source_range: recovery.context_source_range ?? null,
      context_message_count: recovery.context_message_count ?? null,
      permitted_citation_indexes: recovery.permitted_citation_indexes ?? [],
      context_only_messages_eligible: recovery.context_only_messages_eligible ?? null,
      applicability_decision: recovery.applicability_decision ?? null,
      provider_capability_path: recovery.provider_capability_path ?? null,
      repair_reason: recovery.repair_reason ?? null,
      recovery_stage: recovery.recovery_stage ?? null,
      expected_output_format: recovery.expected_output_format ?? expectedOutputFormat,
      root_source_range: rootSourceRange,
      root_source_fingerprint: execution.provider.root_source_fingerprint ?? sourceFingerprint,
      source_range: { start: range.start, end: range.end, message_count: range.message_count },
      source_fingerprint: sourceFingerprint,
      configured_context_limit: preflight.configured_context_limit,
      effective_context_limit: preflight.effective_context_limit,
      context_limit_source: requestBudget.runtimeContextLookup?.status === 'hit'
        ? 'persisted_learned_limit' : 'configured_preference',
      runtime_context_lookup_status: requestBudget.runtimeContextLookup?.status ?? null,
      reserved_output_tokens: preflight.reserved_output_tokens,
      safety_margin: preflight.safety_margin_tokens,
      protocol_overhead: preflight.protocol_overhead_tokens,
      estimated_input_tokens: preflight.estimated_input_tokens,
      estimated_final_request_tokens: preflight.estimated_input_tokens
        + preflight.reserved_output_tokens + preflight.protocol_overhead_tokens,
      resumed_pending_obligation: execution.provider.resumed_pending_obligation,
      schema_version: schemaVersion,
      configuration_signature: providerConfigSignature,
    });
  // Registration and the canonical running transition form one awaited
  // dispatch boundary. Callers cannot send the provider request between them.
  const beginRegisteredAttempt = async (...args) => {
    const attempt = beginAttempt(...args);
    if (attempt?.attempt_id) await emitLifecycleEvent('provider_attempt_started', {
      provider_attempt_id: attempt.attempt_id,
      exact_reason_code: 'provider_request_in_progress',
      recovery_intent: attempt.recovery_intent,
      recovery_stage: attempt.recovery_stage,
    });
    return attempt;
  };

  return Object.freeze({
    tier, tierLabel, owner, range, rangeId, rootSourceRange,
    rootObligationId, leafObligationId, isRecoveryLeaf, coverageBase,
    lifecycleIdentity,
    recordCoverage, recordCompletedCoverage, emitLifecycleEvent, beginAttempt,
    beginRegisteredAttempt,
    contextOverflowError: () => createTierContextOverflowError(tierLabel, preflight, range),
  });
}

