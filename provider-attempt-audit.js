/** Bounded, content-free accounting for actual Long-Term/Session provider calls. */
import { analyzeMalformedResponse, classifyTaggedResponseFailure } from './malformed-output-recovery.js';
import { deriveRecoveryStageEligibility, RECOVERY_IMPLEMENTATION_VERSION } from './recovery-stage-eligibility.js';
import { acknowledgeProviderCompletionLedger, recordProviderCompletion } from './provider-completion-journal.js';

/** Publish audit and journal evidence inside the same transaction as the kernel receipt. */
export function settleProviderTransportFailure(metadata, command, receipt) {
  const attempt = metadata?.live_memory_health?.provider_attempt_audit?.recent_attempts
    ?.find((item) => item.attempt_id === command.attempt_id);
  if (!attempt || attempt.transmission_started !== true) {
    throw Object.assign(new Error('Transport failure has no dispatched attempt.'), {
      code: 'SME_TRANSPORT_FAILURE_ATTEMPT_REQUIRED',
    });
  }
  const entry = acknowledgeProviderCompletionLedger(metadata, command, receipt);
  finishProviderAttempt(metadata, attempt, { terminal_outcome: 'provider_failure',
    recoverable: true, failure_classification: command.reason_code });
  metadata.provider_completion_journal.entries[command.attempt_id].transport_failure = command.transport_failure ?? null;
  return entry.ledger_transition;
}
import { ensureMemorizeObligationLedger } from './memorize-obligation-ledger.js';
import { cloneSerializableDomain } from './serializable-domain.js';
import {
  createRecoveryChildManifest,
  markRecoveryChildState,
  pauseRecoveryChildManifest,
  recoveryChildManifestComplete,
  registerRecoveryChildPlan,
  resumeRecoveryChildManifest,
  summarizeRecoveryChildManifest,
} from './recovery-child-coverage.js';

export const PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION = 13;
export const PROVIDER_ATTEMPT_EVENT_LIMIT = 160;
// Large enough to retain every root obligation in the supplied 9,434-message
// replay while remaining explicitly bounded for arbitrarily large chats.
export const PROVIDER_OBLIGATION_LIMIT = 4096;

const count = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const SUCCESSFUL_TERMINAL_OUTCOMES = new Set(['completed', 'completed_no_candidates', 'completed_repartitioned']);
export const PROVIDER_ATTEMPT_STATES = Object.freeze([
  'created', 'dispatched', 'awaiting_response', 'response_received', 'parsing',
  'validation', 'persistence_pending', 'safely_committed', 'malformed', 'failed',
  'interrupted_completion_unknown', 'superseded', 'cancelled',
]);

const PROVIDER_ATTEMPT_TRANSITIONS = Object.freeze({
  created: new Set(['dispatched', 'cancelled']),
  dispatched: new Set(['awaiting_response', 'cancelled', 'failed', 'interrupted_completion_unknown']),
  awaiting_response: new Set(['response_received', 'malformed', 'failed', 'cancelled',
    'interrupted_completion_unknown', 'superseded', 'safely_committed']),
  response_received: new Set(['parsing', 'malformed', 'failed', 'interrupted_completion_unknown']),
  parsing: new Set(['validation', 'malformed', 'failed']),
  validation: new Set(['persistence_pending', 'failed']),
  persistence_pending: new Set(['safely_committed', 'failed', 'interrupted_completion_unknown']),
});

export function transitionProviderAttemptState(event, state, detail = {}, at = Date.now()) {
  if (!event || !PROVIDER_ATTEMPT_STATES.includes(state)) return {
    status: 'rejected', reason_code: 'unknown_provider_attempt_state', state: event?.lifecycle_state ?? null,
  };
  const prior = event.lifecycle_state ?? null;
  if (prior === state) return { status: 'idempotent', state };
  if (prior && !PROVIDER_ATTEMPT_TRANSITIONS[prior]?.has(state)) return {
    status: 'rejected', reason_code: 'illegal_provider_attempt_transition', prior_state: prior, state,
  };
  event.lifecycle_state = state;
  event.state_history = [...(event.state_history ?? []), {
    state, at, reason_code: detail.reason_code ?? null,
    controller_instance_id: detail.controller_instance_id ?? event.controller_instance_id ?? null,
    transaction_id: detail.transaction_id ?? event.transaction_id ?? null,
    transaction_revision: detail.transaction_revision ?? event.transaction_revision ?? null,
  }].slice(-32);
  return { status: 'applied', prior_state: prior, state };
}

function emptyArchivedObligationCounts(exact = true) {
  return {
    exact,
    total: 0,
    malformed: 0,
    recovered_malformed: 0,
    safely_checkpointed: 0,
    valid_generation: 0,
    intentionally_accepted_no_update: 0,
    terminal_failed: 0,
    strict_success: 0,
    local_normalization: 0,
    partial_output_notice: 0,
    context_repartition: 0,
    provider_recovery_attempted: 0,
    safe_notice: 0,
    ever_failed: 0,
    recovered_failed: 0,
    provider_failure: 0,
    validation_failure: 0,
    recovered_by_stage: {},
  };
}

function ensureRecoveryWindows(audit) {
  for (const obligation of Object.values(audit?.obligations ?? {})) obligation.recovery_windows ??= {};
  for (const event of audit?.recent_attempts ?? []) {
    const obligation = audit.obligations?.[event.logical_obligation_id];
    if (!obligation || !event.source_fingerprint) continue;
    if (count(event.sequence) < count(obligation.recovery_epoch_sequence)) continue;
    const window = obligation.recovery_windows[event.source_fingerprint] ??= {
      source_fingerprint: event.source_fingerprint,
      source_range: event.source_range ?? null,
      recovery_stages_attempted: [], exhausted_stages: [], staged_partial_records: [],
      completed_source_units: [], candidate_rejections: [],
    };
    if (event.recovery_stage) window.recovery_stages_attempted = [...new Set([
      ...window.recovery_stages_attempted, event.recovery_stage,
    ])];
    if (!SUCCESSFUL_TERMINAL_OUTCOMES.has(event.terminal_outcome)
      && event.source_unit_completed !== true && event.recovery_stage) {
      window.exhausted_stages = [...new Set([...window.exhausted_stages, event.recovery_stage])];
    }
    window.last_terminal_outcome = event.terminal_outcome;
    window.last_malformed_reason = event.malformed_reason ?? window.last_malformed_reason ?? null;
    window.parser_accepted_candidate_count = Math.max(count(window.parser_accepted_candidate_count), count(event.accepted_candidate_count));
    const candidateRejections = [...(window.candidate_rejections ?? []),
      ...(event.candidate_rejections ?? []).map((item) => ({ ...item, attempt_id: event.attempt_id }))];
    window.candidate_rejections = [...new Map(candidateRejections.map((item) => [
      `${item.attempt_id ?? 'legacy'}|${item.candidate_index ?? 0}|${item.candidate_fingerprint ?? 'unknown'}|${(item.reason_codes ?? []).join(',')}`,
      item,
    ])).values()].slice(-32);
  }
}

function archiveObligation(audit, obligation) {
  if (!obligation) return;
  const archived = audit.archived_obligation_counts ??= emptyArchivedObligationCounts(true);
  const successful = SUCCESSFUL_TERMINAL_OUTCOMES.has(obligation.terminal_outcome);
  const malformed = count(obligation.malformed_count) > 0;
  const providerFailed = count(obligation.provider_failure_count) > 0;
  const validationFailed = count(obligation.validation_failure_count) > 0;
  const everFailed = malformed || providerFailed || validationFailed;
  archived.total++;
  if (malformed) archived.malformed++;
  if (malformed && successful) archived.recovered_malformed++;
  if (malformed && successful) {
    const stage = obligation.final_recovery_stage ?? 'unknown';
    archived.recovered_by_stage ??= {};
    archived.recovered_by_stage[stage] = count(archived.recovered_by_stage[stage]) + 1;
  }
  if (successful) archived.safely_checkpointed++;
  if (['completed', 'completed_repartitioned'].includes(obligation.terminal_outcome)) archived.valid_generation++;
  if (obligation.terminal_outcome === 'completed_no_candidates') archived.intentionally_accepted_no_update++;
  if (!successful && !['running', 'operational_pause'].includes(obligation.terminal_outcome)) archived.terminal_failed++;
  if (successful && !malformed && !count(obligation.notice_count)) archived.strict_success++;
  if (!malformed && obligation.final_recovery_stage === 'local_normalization') archived.local_normalization++;
  if (obligation.last_notice_reason === 'partial_valid_output') archived.partial_output_notice++;
  if ((obligation.recovery_stages_attempted ?? []).includes('repartition_child')) archived.context_repartition++;
  if (malformed && count(obligation.physical_attempt_count) > 1) archived.provider_recovery_attempted++;
  if (count(obligation.notice_count) > 0) archived.safe_notice++;
  if (everFailed) archived.ever_failed++;
  if (everFailed && successful) archived.recovered_failed++;
  if (providerFailed) archived.provider_failure++;
  if (validationFailed) archived.validation_failure++;
}

function fingerprint(value) {
  let hash = 2166136261;
  for (const character of String(value ?? '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}

export function providerConfigurationSignature(input = {}) {
  return fingerprint(JSON.stringify({
    connection_profile_id: input.connection_profile_id ?? null,
    model: input.model ?? null,
    source: input.source ?? null,
    response_length: input.response_length ?? null,
    context_length: input.context_length ?? null,
  }));
}

function ensure(metadata, runId = null) {
  metadata.live_memory_health ??= {};
  const health = metadata.live_memory_health;
  const prior = health.provider_attempt_audit;
  if (prior && (!runId || prior.run_id === runId)
    && Number(prior.schema_version) !== PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION) {
    const error = new Error('Provider-attempt state uses an unsupported execution schema. Fresh Start is required.');
    error.code = 'SME_MEMORIZE_SCHEMA_UNSUPPORTED';
    error.sme_origin = 'internal_invariant';
    error.sme_recovery_blocked = true;
    error.sme_reason_code = 'fresh_start_required';
    throw error;
  }
  if (!prior || (runId && prior.run_id !== runId)) {
    health.provider_attempt_audit = {
      schema_version: PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION,
      run_id: runId,
      sequence: 0,
      attempted: 0,
      registered_count: 0,
      transmitted_count: 0,
      terminal_counts: {},
      malformed_reason_counts: {},
      request_kind_counts: {},
      repair_reason_counts: {},
      changed_recovery_dimension_counts: {},
      runtime_context_lookup_counts: {},
      overflow_despite_valid_learned_limit_count: 0,
      local_preflight_underestimate_count: 0,
      equivalent_retry_count: 0,
      equivalent_request_count: 0,
      permitted_equivalent_request_count: 0,
      equivalent_request_reason_counts: {},
      provider_failure_lineage: [],
      modifier_failure_subtype_stats: {},
      logical_obligation_count: 0,
      obligations: {},
      recent_attempts: [],
      running_count: 0,
      provider_elapsed_ms: 0,
      provider_elapsed_ms_by_request_kind: {},
      provider_elapsed_ms_by_tier: {},
      provider_elapsed_ms_by_terminal_outcome: {},
      provider_elapsed_ms_by_recovery_stage: {},
      request_counts_by_tier: {},
      source_messages_attempted: 0,
      segment_size_distribution: {},
      failed_or_superseded_elapsed_ms: 0,
      longest_requests: [],
      archived_obligation_counts: emptyArchivedObligationCounts(true),
      recovery_stage_request_counts: {},
      recoveries_by_stage: {},
      notice_reason_counts: {},
      avoided_repair_request_counts: {},
      partial_output_rejected_fragment_count: 0,
      recovery_effectiveness: {},
      request_counts_by_recovery_implementation: {},
      malformed_counts_by_recovery_implementation: {},
    };
  }
  const audit = health.provider_attempt_audit;
  const performanceTotalsCompatible = true;
  const recoveryStageTotalsCompatible = true;
  audit.schema_version = PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION;
  audit.performance_totals_exact ??= performanceTotalsCompatible;
  audit.provider_elapsed_ms ??= 0;
  audit.provider_elapsed_ms_by_request_kind ??= {};
  audit.provider_elapsed_ms_by_tier ??= {};
  audit.provider_elapsed_ms_by_terminal_outcome ??= {};
  audit.provider_elapsed_ms_by_recovery_stage ??= {};
  audit.request_counts_by_tier ??= {};
  audit.source_messages_attempted ??= 0;
  audit.segment_size_distribution ??= {};
  audit.failed_or_superseded_elapsed_ms ??= 0;
  audit.longest_requests ??= [];
  audit.archived_obligation_counts ??= emptyArchivedObligationCounts(false);
  audit.recovery_stage_request_counts ??= {};
  audit.recoveries_by_stage ??= {};
  audit.notice_reason_counts ??= {};
  audit.avoided_repair_request_counts ??= {};
  audit.partial_output_rejected_fragment_count ??= 0;
  audit.recovery_effectiveness ??= {};
  audit.equivalent_request_count ??= count(audit.equivalent_retry_count);
  audit.permitted_equivalent_request_count ??= 0;
  audit.equivalent_request_reason_counts ??= {};
  audit.provider_failure_lineage ??= [];
  audit.modifier_failure_subtype_stats ??= {};
  audit.request_counts_by_recovery_implementation ??= {};
  audit.malformed_counts_by_recovery_implementation ??= {};
  audit.recovery_stage_totals_exact ??= recoveryStageTotalsCompatible;
  ensureRecoveryWindows(audit);
  return audit;
}

export function classifyMalformedProviderOutput(response, {
  expectedFormat = 'tagged_records',
  shapeFailure = null,
  expectedOwnerCount = null,
  observedOwnerCount = null,
  tier = 'longterm',
  finishReason = null,
  requestedOutputTokens = null,
  reportedOutputTokens = null,
} = {}) {
  const taggedShapeFailure = String(shapeFailure ?? '').trim().toLowerCase();
  if (['wrong_field_types', 'partial_owner_result', 'unsupported_schema_fields',
    'structured_provider_error_mistaken_for_generated_content'].includes(taggedShapeFailure)) return taggedShapeFailure;
  if (Number.isFinite(expectedOwnerCount) && Number.isFinite(observedOwnerCount)
    && observedOwnerCount < expectedOwnerCount) return 'partial_owner_result';
  if (expectedFormat === 'tagged_records') {
    const reason = classifyTaggedResponseFailure(response, {
      tier, finishReason, requestedOutputTokens, reportedOutputTokens,
    });
    return reason;
  }
  const normalizedShapeFailure = String(shapeFailure ?? '').trim().toLowerCase();
  const supportedShapeFailures = new Set([
    'wrong_field_types', 'partial_owner_result', 'unsupported_schema_fields',
    'structured_provider_error_mistaken_for_generated_content',
  ]);
  if (supportedShapeFailures.has(normalizedShapeFailure)) return normalizedShapeFailure;
  if (Number.isFinite(expectedOwnerCount) && Number.isFinite(observedOwnerCount)
    && observedOwnerCount < expectedOwnerCount) return 'partial_owner_result';
  const text = typeof response === 'string' ? response.trim() : '';
  if (!text) return 'empty_or_whitespace_response';
  if (/^(?:<analysis>|<think>)[\s\S]*?(?:<\/analysis>|<\/think>)?$/i.test(text)) return 'reasoning_only_response';
  if (/^\s*\{[\s\S]*"error"\s*:\s*\{/i.test(text)) return 'structured_provider_error_mistaken_for_generated_content';
  if (/^\s*\{[\s\S]*"(?:choices|usage)"\s*:/i.test(text)) return 'transport_envelope_mistaken_for_model_content';
  if (expectedFormat === 'json') {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return 'missing_required_top_level_structure';
      return 'unsupported_schema_fields';
    } catch {
      if (/^[^{]*\{[\s\S]*\}[^}]*$/.test(text)) return 'prose_around_json';
      if (/^[\[{]/.test(text) && !/[\]}]\s*$/.test(text)) return 'truncated_json';
      return 'invalid_json';
    }
  }
  if (/^[\[{]/.test(text)) {
    try { JSON.parse(text); return 'wrong_top_level_structure'; }
    catch { return /[\]}]\s*$/.test(text) ? 'invalid_json' : 'truncated_json'; }
  }
  if (!/^\s*\[[^\]\r\n:]+(?::[^\]\r\n]*)?\]/m.test(text)) {
    return /\b(?:here(?:'s| is)|result|response|memory|summary)\b/i.test(text)
      ? 'prose_around_structured_output' : 'missing_required_top_level_structure';
  }
  return 'wrong_field_types_or_unsupported_schema';
}

export function beginProviderAttempt(metadata, input = {}) {
  if (!metadata) return null;
  const audit = ensure(metadata, input.run_id ?? metadata.active_catchup_run_id ?? null);
  audit.sequence++;
  audit.attempted++;
  audit.registered_count = count(audit.registered_count) + 1;
  const obligationId = input.logical_obligation_id ?? fingerprint([
    input.tier, input.owner, input.root_source_fingerprint ?? input.source_fingerprint,
    input.root_source_start, input.root_source_end,
  ].join('|'));
  const signature = input.request_signature ?? fingerprint([
    obligationId, input.source_fingerprint, input.request_kind, input.effective_context_limit,
    input.reserved_output_tokens, input.schema_version, input.source_unit_key,
    input.recovery_implementation_version ?? RECOVERY_IMPLEMENTATION_VERSION,
  ].join('|'));
  const priorEquivalent = [...audit.recent_attempts].reverse().find((item) =>
    item.logical_obligation_id === obligationId && item.request_signature === signature);
  const priorObligation = audit.obligations?.[obligationId];
  const unresolvedObligationReplay = Boolean(priorEquivalent && priorObligation
    && !SUCCESSFUL_TERMINAL_OUTCOMES.has(priorObligation.terminal_outcome));
  const equivalentRetryReason = priorEquivalent
    ? priorEquivalent.terminal_outcome === 'provider_failure' && (input.request_kind ?? 'original') === 'original'
      ? 'provider_transport_retry'
      : input.restored_in_flight === true ? 'restored_in_flight_attempt'
        : input.resumed_pending_obligation === true || unresolvedObligationReplay
          ? 'checkpoint_pending_obligation_retry'
        : null
    : null;
  const changedRecoveryDimensions = [...new Set(input.changed_recovery_dimensions ?? [])];
  if (['repartition_child', 'malformed_repartition_child'].includes(input.request_kind)
    && !changedRecoveryDimensions.includes('source_range_repartition')) {
    changedRecoveryDimensions.push('source_range_repartition');
  }
  const isNewObligation = !audit.obligations[obligationId];
  const obligation = audit.obligations[obligationId] ?? {
    logical_obligation_id: obligationId,
    tier: input.tier ?? 'unknown', owner: input.owner ?? null,
    root_source_range: input.root_source_range ?? input.source_range ?? null,
    root_source_fingerprint: input.root_source_fingerprint ?? input.source_fingerprint ?? null,
    chat_id: input.chat_id ?? null,
    configuration_signature: input.configuration_signature ?? null,
    physical_attempt_count: 0, malformed_count: 0, terminal_outcome: 'running',
  };
  if (obligation.configuration_signature && input.configuration_signature
    && obligation.configuration_signature !== input.configuration_signature) {
    obligation.prior_configuration_signature = obligation.configuration_signature;
    obligation.configuration_signature = input.configuration_signature;
    obligation.recovery_windows = {};
    obligation.recovery_epoch_sequence = count(audit.sequence);
    obligation.last_terminal_signature = null;
    obligation.terminal_signature_repeat_count = 0;
    obligation.recovery_blocked = false;
    obligation.next_eligible_recovery_action = 'dispatch_provider_request';
  } else obligation.configuration_signature ??= input.configuration_signature ?? null;
  obligation.chat_id ??= input.chat_id ?? null;
  if (isNewObligation) audit.logical_obligation_count = count(audit.logical_obligation_count) + 1;
  obligation.physical_attempt_count++;
  obligation.last_attempt_at = Date.now();
  obligation.recovery_windows ??= {};
  const recoveryWindowAlreadyExisted = Boolean(obligation.recovery_windows[input.source_fingerprint]);
  const recoveryWindow = obligation.recovery_windows[input.source_fingerprint] ??= {
    source_fingerprint: input.source_fingerprint ?? null,
    configuration_signature: input.configuration_signature ?? null,
    source_range: input.source_range ?? null,
    recovery_stages_attempted: [], exhausted_stages: [], staged_partial_records: [],
    completed_source_units: [], candidate_rejections: [], unit_obligations: {},
  };
  const recoveryImplementationVersion = Number(input.recovery_implementation_version
    ?? RECOVERY_IMPLEMENTATION_VERSION);
  const priorRecoveryImplementationVersion = Number(recoveryWindow.recovery_implementation_version
    ?? (recoveryWindowAlreadyExisted ? obligation.recovery_implementation_version ?? 1 : recoveryImplementationVersion));
  const implementationVersionChanged = priorRecoveryImplementationVersion < recoveryImplementationVersion;
  if (implementationVersionChanged && !changedRecoveryDimensions.includes('recovery_implementation_version')) {
    changedRecoveryDimensions.push('recovery_implementation_version');
  }
  recoveryWindow.prior_recovery_implementation_version = implementationVersionChanged
    ? priorRecoveryImplementationVersion : recoveryWindow.prior_recovery_implementation_version ?? null;
  recoveryWindow.recovery_implementation_version = recoveryImplementationVersion;
  obligation.recovery_implementation_version = recoveryImplementationVersion;
  audit.obligations[obligationId] = obligation;
  const keys = Object.keys(audit.obligations);
  if (keys.length > PROVIDER_OBLIGATION_LIMIT) {
    // Prefer archiving a completed record so unresolved obligations remain
    // available for targeted replay. Aggregate counters survive detail
    // eviction and therefore remain exact for newly recorded audits.
    const evictionKey = keys.find((key) => key !== obligationId
      && SUCCESSFUL_TERMINAL_OUTCOMES.has(audit.obligations[key]?.terminal_outcome))
      ?? keys.find((key) => key !== obligationId);
    if (evictionKey) {
      archiveObligation(audit, audit.obligations[evictionKey]);
      delete audit.obligations[evictionKey];
    }
  }
  const event = {
    attempt_id: `provider-${Date.now().toString(36)}-${audit.sequence}`,
    sequence: audit.sequence,
    at: Date.now(), run_id: audit.run_id, logical_run_id: audit.run_id,
    controller_attempt_number: Number(input.controller_attempt_number ?? 0) || null,
    logical_obligation_id: obligationId, root_obligation_id: obligationId,
    child_obligation_id: input.child_obligation_id ?? obligationId,
    leaf_obligation_id: input.child_obligation_id ?? obligationId,
    tier: input.tier ?? 'unknown', owner: input.owner ?? null,
    request_kind: input.request_kind ?? 'original',
    parent_attempt_id: input.parent_attempt_id ?? null,
    repartition_parent_id: input.repartition_parent_id ?? null,
    source_range: input.source_range ?? null,
    source_fingerprint: input.source_fingerprint ?? null,
    request_signature: signature,
    equivalent_prior_attempt: Boolean(priorEquivalent),
    equivalent_retry_reason: equivalentRetryReason,
    equivalent_retry_permitted: Boolean(equivalentRetryReason),
    resumed_pending_obligation: input.resumed_pending_obligation === true,
    prior_recovery_stages_attempted: [...new Set(obligation.recovery_stages_attempted ?? [])],
    prior_window_recovery_state: {
      recovery_stages_attempted: [...new Set(recoveryWindow.recovery_stages_attempted ?? [])],
      exhausted_stages: [...new Set(recoveryWindow.exhausted_stages ?? [])],
      completed_source_units: [...new Set(recoveryWindow.completed_source_units ?? [])],
      parser_accepted_candidate_count: count(recoveryWindow.parser_accepted_candidate_count),
      durable_partial_record_count: [...new Set(recoveryWindow.durably_persisted_record_ids ?? [])].length,
      last_malformed_reason: recoveryWindow.last_malformed_reason ?? null,
      recovery_implementation_version: recoveryWindow.recovery_implementation_version,
      implementation_version_changed: implementationVersionChanged,
    },
    prior_terminal_signature: obligation.last_terminal_signature ?? null,
    recovery_replay_count: count(obligation.retry_replay_count),
    changed_recovery_dimensions: changedRecoveryDimensions.slice(0, 8),
    recovery_of_attempt_id: input.recovery_of_attempt_id ?? null,
    source_unit_key: input.source_unit_key ?? null,
    recovery_implementation_version: recoveryImplementationVersion,
    prior_recovery_implementation_version: priorRecoveryImplementationVersion,
    implementation_version_changed: implementationVersionChanged,
    target_source_unit: input.target_source_unit ?? input.source_unit_key ?? null,
    target_source_fingerprint: input.target_source_fingerprint ?? null,
    context_source_range: input.context_source_range ?? null,
    context_message_count: input.context_message_count ?? null,
    permitted_citation_indexes: [...(input.permitted_citation_indexes ?? [])],
    context_only_messages_eligible: input.context_only_messages_eligible ?? null,
    applicability_decision: input.applicability_decision ?? null,
    provider_capability_path: input.provider_capability_path ?? null,
    repair_reason: input.repair_reason ?? null,
    recovery_intent: input.recovery_intent
      ?? (input.request_kind === 'original' ? 'extract_root_obligation'
        : 'recover_unresolved_partial_output_fragments'),
    recovery_stage: input.recovery_stage
      ?? ((input.request_kind ?? 'original') === 'original'
        ? 'strict_generation' : (input.request_kind ?? 'original')),
    expected_output_format: input.expected_output_format ?? `${input.tier ?? 'unknown'}_tagged_lines_v1`,
    configured_context_limit: input.configured_context_limit ?? null,
    effective_context_limit: input.effective_context_limit ?? null,
    context_limit_source: input.context_limit_source ?? null,
    runtime_context_lookup_status: input.runtime_context_lookup_status ?? null,
    reserved_output_tokens: input.reserved_output_tokens ?? null,
    safety_margin: input.safety_margin ?? null,
    protocol_overhead: input.protocol_overhead ?? null,
    estimated_input_tokens: input.estimated_input_tokens ?? null,
    estimated_final_request_tokens: input.estimated_final_request_tokens ?? null,
    terminal_outcome: 'running',
    registration_state: 'registered',
    transmission_started: false,
    transmission_started_at: null,
    controller_instance_id: input.controller_instance_id ?? null,
    transaction_id: input.transaction_id ?? null,
    transaction_revision: input.transaction_revision ?? null,
    transaction_generation: input.transaction_generation ?? null,
  };
  transitionProviderAttemptState(event, 'created', input, event.at);
  if (recoveryWindow.active_recovery_epoch
    && recoveryWindow.active_recovery_epoch.status === 'initialized_before_dispatch') {
    recoveryWindow.active_recovery_epoch.status = 'running';
    recoveryWindow.active_recovery_epoch.provider_attempt_id = event.attempt_id;
    recoveryWindow.active_recovery_epoch.dispatched_at = event.at;
  }
  if (event.resumed_pending_obligation || unresolvedObligationReplay) {
    obligation.retry_replay_count = count(obligation.retry_replay_count) + 1;
    event.recovery_replay_count = obligation.retry_replay_count;
    event.replay_ordinal = obligation.retry_replay_count;
    event.replay_of_terminal_signature = obligation.last_terminal_signature ?? null;
  }
  if (!obligation.original_attempt_id && event.request_kind === 'original') obligation.original_attempt_id = event.attempt_id;
  if (event.request_kind === 'format_repair') obligation.repair_attempt_id = event.attempt_id;
  audit.request_kind_counts[event.request_kind] = count(audit.request_kind_counts[event.request_kind]) + 1;
  audit.request_counts_by_recovery_implementation[recoveryImplementationVersion]
    = count(audit.request_counts_by_recovery_implementation[recoveryImplementationVersion]) + 1;
  audit.recovery_stage_request_counts[event.recovery_stage]
    = count(audit.recovery_stage_request_counts[event.recovery_stage]) + 1;
  audit.request_counts_by_tier[event.tier] = count(audit.request_counts_by_tier[event.tier]) + 1;
  const sourceMessageCount = count(event.source_range?.message_count);
  audit.source_messages_attempted = count(audit.source_messages_attempted) + sourceMessageCount;
  if (sourceMessageCount > 0) audit.segment_size_distribution[sourceMessageCount]
    = count(audit.segment_size_distribution[sourceMessageCount]) + 1;
  if (event.runtime_context_lookup_status) {
    audit.runtime_context_lookup_counts[event.runtime_context_lookup_status] = count(audit.runtime_context_lookup_counts[event.runtime_context_lookup_status]) + 1;
  }
  if (event.repair_reason) audit.repair_reason_counts[event.repair_reason] = count(audit.repair_reason_counts[event.repair_reason]) + 1;
  if (event.equivalent_prior_attempt && event.changed_recovery_dimensions.length === 0) {
    audit.equivalent_request_count++;
    const reason = event.equivalent_retry_reason ?? 'unexplained_equivalent_request';
    audit.equivalent_request_reason_counts[reason] = count(audit.equivalent_request_reason_counts[reason]) + 1;
    if (event.equivalent_retry_permitted) audit.permitted_equivalent_request_count++;
    else audit.equivalent_retry_count++;
  }
  for (const dimension of event.changed_recovery_dimensions) {
    audit.changed_recovery_dimension_counts[dimension] = count(audit.changed_recovery_dimension_counts[dimension]) + 1;
  }
  audit.recent_attempts.push(event);
  audit.recent_attempts = audit.recent_attempts.slice(-PROVIDER_ATTEMPT_EVENT_LIMIT);
  // Attempt registration and completion share one WAL for every tier.  This
  // closes the former Long-Term-only integration hole that omitted Session
  // attempts from durable completion accounting.
  recordProviderCompletion(metadata, event, {
    child_obligation_id: input.child_obligation_id ?? input.source_unit_key ?? null,
    request_kind: event.request_kind,
    recovery_stage: event.recovery_stage,
    provider_disposition: 'registered_not_dispatched',
  });
  return event;
}

/** Marks the exact boundary at which a durably registered request may leave. */
export function markProviderAttemptDispatched(metadata, event, patch = {}) {
  if (!metadata || !event || event.transmission_started === true) return event;
  const audit = ensure(metadata, event.run_id ?? metadata.active_catchup_run_id ?? null);
  event.transmission_started = true;
  event.transmission_started_at = patch.at ?? Date.now();
  event.registration_state = 'durably_registered_and_dispatched';
  audit.transmitted_count = count(audit.transmitted_count) + 1;
  audit.running_count = count(audit.running_count) + 1;
  transitionProviderAttemptState(event, 'dispatched', patch, event.transmission_started_at);
  transitionProviderAttemptState(event, 'awaiting_response', patch, event.transmission_started_at);
  const journal = metadata.provider_completion_journal;
  const entry = Array.isArray(journal?.entries)
    ? journal.entries.find((item) => item?.attempt_id === event.attempt_id)
    : journal?.entries?.[event.attempt_id];
  if (entry) {
    entry.provider_disposition = 'running';
    entry.provider_transmission_started = true;
    entry.provider_transmission_started_at = event.transmission_started_at;
    entry.updated_at = event.transmission_started_at;
  }
  return event;
}

export function finishProviderAttempt(metadata, event, patch = {}) {
  if (!metadata || !event || event.terminal_outcome !== 'running') return event;
  // A terminal provider response/failure is itself conclusive evidence that
  // transmission occurred. This also keeps independent non-controller paths
  // on the same accounting model.
  if (event.transmission_started !== true) markProviderAttemptDispatched(metadata, event, patch);
  const audit = ensure(metadata, event.run_id ?? metadata.active_catchup_run_id ?? null);
  event.terminal_outcome = patch.terminal_outcome ?? 'internal_failure';
  const terminalState = event.terminal_outcome === 'interrupted_completion_unknown'
    ? 'interrupted_completion_unknown'
    : event.terminal_outcome === 'provider_response_malformed' ? 'malformed'
      : SUCCESSFUL_TERMINAL_OUTCOMES.has(event.terminal_outcome) ? 'safely_committed'
        : event.terminal_outcome === 'cancelled' ? 'cancelled'
          : event.terminal_outcome === 'superseded' ? 'superseded' : 'failed';
  transitionProviderAttemptState(event, terminalState, patch);
  event.malformed_reason = patch.malformed_reason ?? null;
  event.notice_reason = patch.notice_reason ?? null;
  event.failure_classification = patch.failure_classification ?? null;
  event.provider_reported_prompt_tokens = patch.provider_reported_prompt_tokens ?? null;
  event.provider_reported_context_tokens = patch.provider_reported_context_tokens ?? null;
  event.local_preflight_underestimated_provider_prompt_total = Number.isFinite(Number(event.provider_reported_prompt_tokens))
    && Number.isFinite(Number(event.estimated_final_request_tokens))
    ? Number(event.provider_reported_prompt_tokens) > Number(event.estimated_final_request_tokens) : null;
  event.overflow_despite_valid_learned_limit = event.terminal_outcome === 'context_overflow_repartitioned'
    && event.runtime_context_lookup_status === 'hit';
  if (event.local_preflight_underestimated_provider_prompt_total === true) audit.local_preflight_underestimate_count++;
  if (event.overflow_despite_valid_learned_limit === true) audit.overflow_despite_valid_learned_limit_count++;
  event.recoverable = patch.recoverable ?? null;
  event.recovery_stage = patch.recovery_stage ?? event.recovery_stage ?? null;
  event.changed_recovery_dimensions = patch.changed_recovery_dimensions ?? event.changed_recovery_dimensions ?? [];
  event.response_shape = patch.response_shape ?? (patch.response_text !== undefined
    ? analyzeMalformedResponse(patch.response_text, {
      tier: event.tier, finishReason: patch.provider_finish_reason,
      requestedOutputTokens: event.reserved_output_tokens,
      reportedOutputTokens: patch.reported_output_tokens,
    }) : null);
  event.parser_paths_attempted = [...new Set(patch.parser_paths_attempted ?? [])].slice(0, 12);
  event.local_normalization_paths_attempted = [...new Set(patch.local_normalization_paths_attempted ?? [])].slice(0, 12);
  event.smaller_window_retry_followed = patch.smaller_window_retry_followed ?? false;
  event.partial_output_policy = patch.partial_output_policy ?? null;
  event.parser_count_consistent = patch.parser_count_consistent ?? null;
  event.recovery_route = patch.recovery_route ?? null;
  event.avoided_repair_reason = patch.avoided_repair_reason ?? null;
  event.requested_output_format = patch.requested_output_format ?? event.expected_output_format ?? null;
  event.actual_output_format = patch.actual_output_format ?? null;
  event.parser_selected = patch.parser_selected ?? null;
  event.output_contract_followed = patch.output_contract_followed ?? null;
  event.outer_response_shape_followed = patch.outer_response_shape_followed ?? null;
  event.cardinality_followed = patch.cardinality_followed ?? null;
  event.prohibited_prose_avoided = patch.prohibited_prose_avoided ?? null;
  event.modifier_restrictions_followed = patch.modifier_restrictions_followed ?? null;
  event.citation_requirement_followed = patch.citation_requirement_followed ?? null;
  event.normalization_eligibility = patch.normalization_eligibility ?? null;
  event.normalization_result = patch.normalization_result ?? null;
  event.original_rejection_reasons = [...new Set(patch.original_rejection_reasons ?? [])].slice(0, 16);
  event.strict_parse_result = patch.strict_parse_result ?? null;
  event.fallback_parse_result = patch.fallback_parse_result ?? null;
  event.total_candidate_count = count(patch.total_candidate_count);
  event.accepted_candidate_count = count(patch.accepted_candidate_count);
  event.rejected_candidate_count = count(patch.rejected_candidate_count);
  event.candidate_accounting_consistent = event.total_candidate_count
    === event.accepted_candidate_count + event.rejected_candidate_count;
  event.rejection_reasons = [...new Set(patch.rejection_reasons ?? [])].slice(0, 16);
  event.candidate_rejections = (patch.candidate_rejections ?? []).slice(0, 32);
  event.response_fragment_count = count(patch.response_fragment_count);
  event.tagged_candidate_count = count(patch.tagged_candidate_count);
  event.pipe_candidate_count = count(patch.pipe_candidate_count);
  event.parsed_core_field_count = count(patch.parsed_core_field_count);
  event.conversational_prose_detected = patch.conversational_prose_detected === true;
  event.applicability_decision = patch.applicability_decision ?? event.applicability_decision ?? null;
  event.provider_capability_path = patch.provider_capability_path ?? event.provider_capability_path ?? null;
  event.contract_enforcement_retry_scheduled = patch.contract_enforcement_retry_scheduled === true;
  event.contract_enforcement_retry_performed = patch.contract_enforcement_retry_performed === true;
  event.source_unit_key = patch.source_unit_key ?? event.source_unit_key ?? null;
  event.target_source_unit = patch.target_source_unit ?? event.target_source_unit ?? event.source_unit_key ?? null;
  event.target_source_fingerprint = patch.target_source_fingerprint ?? event.target_source_fingerprint ?? null;
  event.actual_citation_indexes = [...new Set(patch.actual_citation_indexes ?? [])];
  event.accepted_record_cites_target = patch.accepted_record_cites_target ?? null;
  event.source_unit_completed = patch.source_unit_completed === true;
  event.unresolved_semantic_units = [...new Set(patch.unresolved_semantic_units ?? [])].slice(0, 128);
  event.missing_required_results = patch.missing_required_results ?? null;
  event.accepted_partial_output_persisted = patch.accepted_partial_output_persisted ?? null;
  event.obligation_closure_reason = patch.obligation_closure_reason ?? null;
  event.recovery_ladder_terminal = patch.recovery_ladder_terminal === true;
  event.duration_ms = Math.max(0, Date.now() - event.at);
  audit.provider_elapsed_ms = count(audit.provider_elapsed_ms) + event.duration_ms;
  audit.provider_elapsed_ms_by_request_kind[event.request_kind]
    = count(audit.provider_elapsed_ms_by_request_kind[event.request_kind]) + event.duration_ms;
  audit.provider_elapsed_ms_by_tier[event.tier]
    = count(audit.provider_elapsed_ms_by_tier[event.tier]) + event.duration_ms;
  audit.provider_elapsed_ms_by_terminal_outcome[event.terminal_outcome]
    = count(audit.provider_elapsed_ms_by_terminal_outcome[event.terminal_outcome]) + event.duration_ms;
  audit.provider_elapsed_ms_by_recovery_stage[event.recovery_stage ?? 'unknown']
    = count(audit.provider_elapsed_ms_by_recovery_stage[event.recovery_stage ?? 'unknown']) + event.duration_ms;
  if (!['completed', 'completed_no_candidates', 'completed_repartitioned'].includes(event.terminal_outcome)) {
    audit.failed_or_superseded_elapsed_ms = count(audit.failed_or_superseded_elapsed_ms) + event.duration_ms;
  }
  audit.longest_requests = [...(audit.longest_requests ?? []), {
    attempt_id: event.attempt_id, tier: event.tier, request_kind: event.request_kind,
    source_range: event.source_range, duration_ms: event.duration_ms,
    terminal_outcome: event.terminal_outcome,
  }].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 16);
  audit.running_count = Math.max(0, count(audit.running_count) - 1);
  audit.terminal_counts[event.terminal_outcome] = count(audit.terminal_counts[event.terminal_outcome]) + 1;
  const obligation = audit.obligations[event.logical_obligation_id];
  if (obligation) {
    obligation.recovery_windows ??= {};
    const recoveryWindow = obligation.recovery_windows[event.source_fingerprint] ??= {
      source_fingerprint: event.source_fingerprint ?? null, source_range: event.source_range ?? null,
      recovery_stages_attempted: [], exhausted_stages: [], staged_partial_records: [],
      completed_source_units: [], candidate_rejections: [], unit_obligations: {},
    };
    recoveryWindow.unit_obligations ??= {};
    recoveryWindow.recovery_implementation_version ??= event.recovery_implementation_version
      ?? RECOVERY_IMPLEMENTATION_VERSION;
    obligation.terminal_outcome = event.terminal_outcome;
    obligation.last_attempt_id = event.attempt_id;
    obligation.last_source_range = event.source_range ?? obligation.root_source_range ?? null;
    obligation.last_source_fingerprint = event.source_fingerprint ?? obligation.root_source_fingerprint ?? null;
    obligation.prior_authoritative_memory_preserved = patch.prior_authoritative_memory_preserved ?? true;
    obligation.produced_no_update = patch.produced_no_update
      ?? !['completed', 'completed_repartitioned'].includes(event.terminal_outcome);
    obligation.targeted_replay_eligible = patch.targeted_replay_eligible
      ?? Boolean(event.malformed_reason || String(event.terminal_outcome).includes('malformed'));
    obligation.final_disposition = patch.final_disposition ?? event.terminal_outcome;
    obligation.final_recovery_stage = patch.final_recovery_stage ?? event.recovery_stage ?? obligation.final_recovery_stage ?? null;
    obligation.total_attempts = obligation.physical_attempt_count;
    obligation.recovery_stages_attempted = [...new Set([
      ...(obligation.recovery_stages_attempted ?? []), event.recovery_stage,
    ].filter(Boolean))].slice(-12);
    recoveryWindow.recovery_stages_attempted = [...new Set([
      ...(recoveryWindow.recovery_stages_attempted ?? []), event.recovery_stage,
    ].filter(Boolean))].slice(-12);
    if (!SUCCESSFUL_TERMINAL_OUTCOMES.has(event.terminal_outcome)
      && event.source_unit_completed !== true && event.recovery_stage) {
      recoveryWindow.exhausted_stages = [...new Set([
        ...(recoveryWindow.exhausted_stages ?? []), event.recovery_stage,
      ])].slice(-12);
    }
    recoveryWindow.last_terminal_outcome = event.terminal_outcome;
    recoveryWindow.last_malformed_reason = event.malformed_reason ?? recoveryWindow.last_malformed_reason ?? null;
    recoveryWindow.parser_accepted_candidate_count = Math.max(count(recoveryWindow.parser_accepted_candidate_count),
      count(event.accepted_candidate_count));
    recoveryWindow.rejected_fragment_count = count(recoveryWindow.rejected_fragment_count)
      + count(event.rejected_candidate_count);
    const candidateRejections = [...(recoveryWindow.candidate_rejections ?? []),
      ...event.candidate_rejections.map((item) => ({ ...item, attempt_id: event.attempt_id }))];
    recoveryWindow.candidate_rejections = [...new Map(candidateRejections.map((item) => [
      `${item.attempt_id ?? 'legacy'}|${item.candidate_index ?? 0}|${item.candidate_fingerprint ?? 'unknown'}|${(item.reason_codes ?? []).join(',')}`,
      item,
    ])).values()].slice(-32);
    if (event.source_unit_key && event.source_unit_completed === true) {
      recoveryWindow.completed_source_units = [...new Set([
        ...(recoveryWindow.completed_source_units ?? []), event.source_unit_key,
      ])].slice(-128);
    }
    if (event.source_unit_key) {
      const unitKey = String(event.source_unit_key);
      const disposition = event.source_unit_completed === true
        ? event.obligation_closure_reason === 'source_unit_explicit_none' ? 'validated_no_update' : 'record_staged'
        : event.terminal_outcome === 'provider_failure' ? 'blocked_provider_failure' : 'blocked_validation';
      recoveryWindow.unit_obligations[unitKey] = {
        source_unit_key: unitKey,
        child_obligation_id: `${event.logical_obligation_id}:unit:${unitKey}`,
        target_source_fingerprint: event.target_source_fingerprint ?? null,
        disposition,
        producing_attempt_id: event.attempt_id,
        actual_citation_indexes: event.actual_citation_indexes,
        accepted_record_cites_target: event.accepted_record_cites_target,
        normalization_result: event.normalization_result,
        candidate_accounting_consistent: event.candidate_accounting_consistent,
        rejection_reasons: event.rejection_reasons,
        applicability_decision: event.applicability_decision,
        provider_capability_path: event.provider_capability_path,
        recovery_implementation_version: event.recovery_implementation_version,
      };
    }
    if (event.unresolved_semantic_units.length || event.source_unit_completed === true) {
      recoveryWindow.unresolved_semantic_units = event.unresolved_semantic_units;
    }
    obligation.parser_accepted_candidate_count = Math.max(count(obligation.parser_accepted_candidate_count),
      count(event.accepted_candidate_count));
    obligation.rejected_fragment_count = count(obligation.rejected_fragment_count)
      + count(event.rejected_candidate_count);
    obligation.provider_contract_violation_count = count(obligation.provider_contract_violation_count)
      + (event.output_contract_followed === false ? 1 : 0);
    obligation.last_response_contract = {
      requested_output_format: event.requested_output_format,
      actual_output_format: event.actual_output_format,
      parser_selected: event.parser_selected,
      output_contract_followed: event.output_contract_followed,
      outer_response_shape_followed: event.outer_response_shape_followed,
      cardinality_followed: event.cardinality_followed,
      prohibited_prose_avoided: event.prohibited_prose_avoided,
      modifier_restrictions_followed: event.modifier_restrictions_followed,
      citation_requirement_followed: event.citation_requirement_followed,
      normalization_eligibility: event.normalization_eligibility,
      normalization_result: event.normalization_result,
      original_rejection_reasons: event.original_rejection_reasons,
      target_source_unit: event.target_source_unit,
      target_source_fingerprint: event.target_source_fingerprint,
      context_source_range: event.context_source_range,
      context_message_count: event.context_message_count,
      permitted_citation_indexes: event.permitted_citation_indexes,
      actual_citation_indexes: event.actual_citation_indexes,
      accepted_record_cites_target: event.accepted_record_cites_target,
      candidate_accounting_consistent: event.candidate_accounting_consistent,
      strict_parse_result: event.strict_parse_result,
      fallback_parse_result: event.fallback_parse_result,
      total_candidate_count: event.total_candidate_count,
      accepted_candidate_count: event.accepted_candidate_count,
      rejected_candidate_count: event.rejected_candidate_count,
      rejection_reasons: event.rejection_reasons,
      candidate_rejections: event.candidate_rejections,
      response_fragment_count: event.response_fragment_count,
      tagged_candidate_count: event.tagged_candidate_count,
      pipe_candidate_count: event.pipe_candidate_count,
      parsed_core_field_count: event.parsed_core_field_count,
      conversational_prose_detected: event.conversational_prose_detected,
      applicability_decision: event.applicability_decision,
      provider_capability_path: event.provider_capability_path,
      contract_enforcement_retry_scheduled: event.contract_enforcement_retry_scheduled,
      contract_enforcement_retry_performed: event.contract_enforcement_retry_performed,
      missing_required_results: event.missing_required_results,
      accepted_partial_output_persisted: event.accepted_partial_output_persisted,
      obligation_closure_reason: event.obligation_closure_reason,
    };
    if (event.recovery_ladder_terminal) {
      const terminalSignature = fingerprint(JSON.stringify({
        logical_obligation_id: event.logical_obligation_id,
        source_fingerprint: event.source_fingerprint ?? obligation.root_source_fingerprint,
        configuration_signature: obligation.configuration_signature,
        stages: obligation.recovery_stages_attempted,
        malformed_reason: event.malformed_reason,
        accepted_candidate_count: event.accepted_candidate_count,
        rejected_candidate_count: event.rejected_candidate_count,
      }));
      obligation.terminal_signature_repeat_count = terminalSignature === obligation.last_terminal_signature
        ? count(obligation.terminal_signature_repeat_count) + 1 : 1;
      obligation.last_terminal_signature = terminalSignature;
      recoveryWindow.terminal_signature_repeat_count = terminalSignature === recoveryWindow.last_terminal_signature
        ? count(recoveryWindow.terminal_signature_repeat_count) + 1 : 1;
      recoveryWindow.last_terminal_signature = terminalSignature;
      const eligibility = deriveRecoveryStageEligibility({
        attempted_stages: recoveryWindow.recovery_stages_attempted,
        exhausted_stages: recoveryWindow.exhausted_stages,
        durable_partial_record_count: (recoveryWindow.durably_persisted_record_ids ?? []).length,
        unresolved_semantic_units: recoveryWindow.unresolved_semantic_units ?? [],
        implementation_version_changed: event.implementation_version_changed === true,
      });
      obligation.recovery_eligibility = eligibility;
      obligation.recovery_blocked = eligibility.blocked;
      obligation.eligible_recovery_stage = eligibility.eligible_action ?? null;
      obligation.next_eligible_recovery_action = eligibility.blocked
        ? 'stop_blocked' : 'dispatch_provider_request';
    } else if (SUCCESSFUL_TERMINAL_OUTCOMES.has(event.terminal_outcome)) {
      obligation.recovery_blocked = false;
      obligation.next_eligible_recovery_action = null;
    }
    if (event.malformed_reason) {
      obligation.malformed_count++;
      obligation.last_malformed_reason = event.malformed_reason;
      obligation.modifier_failure_subtypes = [...new Set([
        ...(obligation.modifier_failure_subtypes ?? []),
        ...Object.keys(event.response_shape?.modifier_failure_subtype_counts ?? {}),
        ...Object.keys(event.response_shape?.modifier_normalization_subtype_counts ?? {}),
      ])].slice(0, 24);
    }
    if (event.terminal_outcome === 'provider_failure') {
      obligation.provider_failure_count = count(obligation.provider_failure_count) + 1;
      const lineage = {
        attempt_id: event.attempt_id,
        root_obligation_id: event.logical_obligation_id,
        tier: event.tier,
        request_kind: event.request_kind,
        failure_classification: event.failure_classification ?? 'provider_transport_failure',
        recovery_disposition: 'pending_or_unresolved',
        recovered_by_attempt_id: null,
        affected_final_obligation_status: true,
      };
      obligation.provider_failure_lineage = [...(obligation.provider_failure_lineage ?? []), lineage].slice(-8);
      audit.provider_failure_lineage = [...(audit.provider_failure_lineage ?? []), lineage].slice(-64);
    }
    if (event.terminal_outcome === 'validation_failure') {
      obligation.validation_failure_count = count(obligation.validation_failure_count) + 1;
    }
    if (event.notice_reason) {
      obligation.notice_count = count(obligation.notice_count) + 1;
      obligation.last_notice_reason = event.notice_reason;
    }
  }
  if (event.malformed_reason) {
    audit.malformed_reason_counts[event.malformed_reason] = count(audit.malformed_reason_counts[event.malformed_reason]) + 1;
    audit.malformed_counts_by_recovery_implementation[event.recovery_implementation_version]
      = count(audit.malformed_counts_by_recovery_implementation[event.recovery_implementation_version]) + 1;
  }
  if (event.notice_reason) audit.notice_reason_counts[event.notice_reason]
    = count(audit.notice_reason_counts[event.notice_reason]) + 1;
  if (event.notice_reason === 'partial_valid_output') audit.partial_output_rejected_fragment_count
    = count(audit.partial_output_rejected_fragment_count)
      + count(event.response_shape?.structurally_rejected_record_count ?? event.response_shape?.rejected_tagged_record_count);
  for (const [subtype, observed] of Object.entries(event.response_shape?.modifier_failure_subtype_counts ?? {})) {
    const stats = audit.modifier_failure_subtype_stats[subtype] ?? {
      observed_count: 0, locally_normalizable_count: 0, local_normalization_success_count: 0,
      provider_regeneration_count: 0, repartition_count: 0, terminal_unresolved_count: 0,
      added_request_count: 0, provider_configuration_signatures: [],
    };
    stats.observed_count += count(observed);
    const obligationSignature = obligation?.configuration_signature;
    if (obligationSignature) stats.provider_configuration_signatures = [...new Set([
      ...stats.provider_configuration_signatures, obligationSignature,
    ])].slice(-8);
    audit.modifier_failure_subtype_stats[subtype] = stats;
  }
  for (const [subtype, observed] of Object.entries(event.response_shape?.modifier_normalization_subtype_counts ?? {})) {
    const stats = audit.modifier_failure_subtype_stats[subtype] ?? {
      observed_count: 0, locally_normalizable_count: 0, local_normalization_success_count: 0,
      provider_regeneration_count: 0, repartition_count: 0, terminal_unresolved_count: 0,
      added_request_count: 0, provider_configuration_signatures: [],
    };
    stats.observed_count += count(observed);
    stats.locally_normalizable_count += count(observed);
    if (event.notice_reason?.startsWith('local_normalization:')) stats.local_normalization_success_count += count(observed);
    const obligationSignature = obligation?.configuration_signature;
    if (obligationSignature) stats.provider_configuration_signatures = [...new Set([
      ...stats.provider_configuration_signatures, obligationSignature,
    ])].slice(-8);
    audit.modifier_failure_subtype_stats[subtype] = stats;
  }
  if (count(event.response_shape?.modifier_missing_source_citation_count) > 0) {
    const subtype = 'missing_source_citation';
    const stats = audit.modifier_failure_subtype_stats[subtype] ?? {
      observed_count: 0, locally_normalizable_count: 0, local_normalization_success_count: 0,
      provider_regeneration_count: 0, repartition_count: 0, terminal_unresolved_count: 0,
      added_request_count: 0, provider_configuration_signatures: [],
    };
    stats.observed_count += count(event.response_shape.modifier_missing_source_citation_count);
    const obligationSignature = obligation?.configuration_signature;
    if (obligationSignature) stats.provider_configuration_signatures = [...new Set([
      ...stats.provider_configuration_signatures, obligationSignature,
    ])].slice(-8);
    audit.modifier_failure_subtype_stats[subtype] = stats;
  }
  if (event.avoided_repair_reason) audit.avoided_repair_request_counts[event.avoided_repair_reason]
    = count(audit.avoided_repair_request_counts[event.avoided_repair_reason]) + 1;
  const effectivenessReason = event.repair_reason ?? event.malformed_reason ?? event.avoided_repair_reason ?? 'unspecified';
  const configurationSignature = obligation?.configuration_signature ?? 'unknown';
  if (event.request_kind !== 'original' || event.avoided_repair_reason) {
    const stage = event.avoided_repair_reason ? 'compact_response_repair_avoided' : event.recovery_stage ?? event.request_kind;
    const effectivenessKey = [configurationSignature, event.tier, effectivenessReason, stage].join('|');
    const effectiveness = audit.recovery_effectiveness[effectivenessKey] ?? {
      provider_configuration_signature: configurationSignature,
      tier: event.tier,
      malformed_reason: effectivenessReason,
      recovery_stage: stage,
      attempts: 0,
      successes: 0,
      requests_avoided: 0,
      provider_elapsed_ms: 0,
      recovered_obligation_ids: [],
    };
    if (event.avoided_repair_reason) effectiveness.requests_avoided++;
    else {
      effectiveness.attempts++;
      effectiveness.provider_elapsed_ms += event.duration_ms;
      if (SUCCESSFUL_TERMINAL_OUTCOMES.has(event.terminal_outcome)) {
        effectiveness.successes++;
        effectiveness.recovered_obligation_ids = [...new Set([
          ...effectiveness.recovered_obligation_ids, event.logical_obligation_id,
        ])].slice(-PROVIDER_OBLIGATION_LIMIT);
      }
    }
    audit.recovery_effectiveness[effectivenessKey] = effectiveness;
  }
  if (['completed', 'completed_no_candidates', 'completed_repartitioned'].includes(event.terminal_outcome)) {
    for (const lineage of obligation?.provider_failure_lineage ?? []) {
      if (lineage.recovered_by_attempt_id) continue;
      lineage.recovery_disposition = 'recovered_by_retry';
      lineage.recovered_by_attempt_id = event.attempt_id;
      lineage.affected_final_obligation_status = false;
      const aggregateLineage = (audit.provider_failure_lineage ?? []).find((item) => item.attempt_id === lineage.attempt_id);
      if (aggregateLineage) Object.assign(aggregateLineage, lineage);
    }
    if (obligation?.modifier_failure_subtypes?.length && !obligation.modifier_recovery_accounted) {
      for (const subtype of obligation.modifier_failure_subtypes) {
        const stats = audit.modifier_failure_subtype_stats[subtype];
        if (!stats) continue;
        if (event.request_kind === 'malformed_repartition_child') stats.repartition_count++;
        else if (event.request_kind !== 'original') stats.provider_regeneration_count++;
        stats.added_request_count++;
      }
      obligation.modifier_recovery_accounted = true;
    }
    if (obligation?.malformed_count > 0 && event.recovery_stage && event.recovery_stage !== 'strict_generation') {
      audit.recoveries_by_stage[event.recovery_stage] = count(audit.recoveries_by_stage[event.recovery_stage]) + 1;
    }
    for (const prior of audit.recent_attempts) {
      if (prior === event || prior.logical_obligation_id !== event.logical_obligation_id || !prior.malformed_reason || prior.recovered_by_attempt_id) continue;
      prior.recovered_by_attempt_id = event.attempt_id;
      prior.recovery_same_source_fingerprint = prior.source_fingerprint === event.source_fingerprint;
    }
  }
  const providerSucceeded = SUCCESSFUL_TERMINAL_OUTCOMES.has(event.terminal_outcome);
  recordProviderCompletion(metadata, event, {
    request_kind: event.request_kind,
    recovery_stage: event.recovery_stage,
    provider_disposition: event.terminal_outcome,
    response_text: patch.response_text,
    parser_result: patch.parser_result,
    validation: patch.validation,
    persistence: patch.persistence ?? (providerSucceeded
      ? { status: 'pending', durable_record_ids: [] }
      : { status: 'not_applicable', durable_record_ids: [],
        reason_code: event.malformed_reason ?? event.failure_classification
          ?? event.terminal_outcome }),
    manifest_transition: patch.manifest_transition ?? (providerSucceeded
      ? { status: 'pending' }
      : { status: 'rejected', reason_code: event.terminal_outcome }),
    ledger_transition: patch.ledger_transition ?? (providerSucceeded
      ? { status: 'pending' }
      : { status: 'pending_reconciliation', requested_disposition: 'pending_recovery' }),
    live_health_transition: patch.live_health_transition ?? (providerSucceeded
      ? { status: 'pending' }
      : { status: 'applied', disposition: event.terminal_outcome }),
    completed_at: providerSucceeded ? null : Date.now(),
  });
  return event;
}

/** Idempotently closes attempts whose controller lease can no longer finish them. */
export function settleOrphanedProviderAttempts(metadata, input = {}) {
  const audit = metadata?.live_memory_health?.provider_attempt_audit;
  if (!audit) return { mutations: 0, settled_attempt_ids: [], provider_calls: 0 };
  const lineage = new Set(input.provider_attempt_lineage ?? []);
  const settled = [];
  for (const attempt of audit.recent_attempts ?? []) {
    if (attempt?.terminal_outcome !== 'running') continue;
    if (input.logical_run_id && attempt.logical_run_id !== input.logical_run_id) continue;
    if (input.controller_instance_id
      && attempt.controller_instance_id !== input.controller_instance_id
      && !lineage.has(attempt.attempt_id)) continue;
    if (input.transaction_id && attempt.transaction_id !== input.transaction_id
      && !lineage.has(attempt.attempt_id)) continue;
    if (input.obligation_id && ![
      attempt.logical_obligation_id, attempt.root_obligation_id,
      attempt.child_obligation_id, attempt.leaf_obligation_id,
    ].includes(input.obligation_id)) continue;
    if (lineage.size && !lineage.has(attempt.attempt_id)) continue;
    finishProviderAttempt(metadata, attempt, {
      terminal_outcome: 'interrupted_completion_unknown',
      failure_classification: input.reason_code ?? 'controller_lease_closed_before_completion',
      recoverable: true,
      final_disposition: 'completion_unknown_recovery_required',
      reason_code: input.reason_code ?? 'controller_lease_closed_before_completion',
      controller_instance_id: input.controller_instance_id ?? null,
      transaction_id: input.transaction_id ?? null,
      transaction_revision: input.transaction_revision ?? null,
      persistence: { status: 'not_applicable', durable_record_ids: [],
        reason_code: 'interrupted_completion_unknown' },
      manifest_transition: { status: 'pending_reconciliation',
        reason_code: 'interrupted_completion_unknown' },
    });
    settled.push(attempt.attempt_id);
  }
  return { mutations: settled.length, settled_attempt_ids: settled, provider_calls: 0 };
}

/**
 * Applies the downstream validator/persistence verdict to the same logical
 * provider obligation.  Physical request completion is retained on the event,
 * but it can no longer be mistaken for safe extraction completion.
 */
export function markProviderDownstreamOutcome(metadata, logicalObligationId, details = {}) {
  if (!metadata || !logicalObligationId) return null;
  const audit = ensure(metadata, metadata.active_catchup_run_id ?? null);
  const obligation = audit.obligations?.[logicalObligationId];
  if (!obligation) return null;
  const attempt = [...(audit.recent_attempts ?? [])].reverse()
    .find((item) => item.logical_obligation_id === logicalObligationId);
  const validationAccepted = details.validation_accepted === true;
  const explicitNoUpdate = details.explicit_no_update === true;
  const persistenceCommitted = details.persistence_committed === true;
  const safelyComplete = explicitNoUpdate || (validationAccepted && persistenceCommitted
    && details.unresolved_semantic_requirements !== true);
  const reasonCode = safelyComplete ? null : details.reason_code ?? 'downstream_validation_pending';
  const terminalOutcome = safelyComplete
    ? explicitNoUpdate ? 'completed_no_candidates' : 'completed'
    : details.blocked === true ? 'validation_failure' : 'pending_recovery';
  obligation.terminal_outcome = terminalOutcome;
  obligation.final_disposition = safelyComplete
    ? explicitNoUpdate ? 'validated_no_update' : 'downstream_validated_and_persisted'
    : reasonCode;
  obligation.downstream_validation_result = {
    accepted_count: count(details.accepted_count),
    rejected_count: count(details.rejected_count),
    reason_code: reasonCode,
    candidate_shape_repair_count: count(details.candidate_shape_repair_count),
    unresolved_semantic_requirements: details.unresolved_semantic_requirements === true,
    at: Date.now(),
  };
  obligation.persistence_result = explicitNoUpdate ? 'not_required_validated_no_update'
    : persistenceCommitted ? 'committed' : 'not_committed';
  obligation.checkpoint_eligible = safelyComplete;
  obligation.recovery_blocked = details.blocked === true;
  obligation.next_eligible_recovery_action = safelyComplete ? null
    : details.next_eligible_action ?? 'dispatch_provider_request';
  if (!safelyComplete) {
    obligation.validation_failure_count = count(obligation.validation_failure_count) + 1;
    obligation.produced_no_update = false;
  }
  if (attempt) {
    attempt.downstream_validation_result = obligation.downstream_validation_result;
    attempt.persistence_result = obligation.persistence_result;
    attempt.checkpoint_eligible = safelyComplete;
    attempt.unresolved_semantic_requirements = details.unresolved_semantic_requirements === true;
    attempt.downstream_terminal_outcome = terminalOutcome;
  }
  return obligation;
}

/** Durably stages valid records or NONE decisions for one exact source unit. */
export function stageProviderPartialRecovery(metadata, logicalObligationId, sourceFingerprint, records = [], details = {}) {
  if (!metadata || !logicalObligationId || !sourceFingerprint) return false;
  const audit = ensure(metadata, metadata.active_catchup_run_id ?? null);
  const obligation = audit.obligations?.[logicalObligationId];
  if (!obligation) return false;
  obligation.recovery_windows ??= {};
  const window = obligation.recovery_windows[sourceFingerprint] ??= {
    source_fingerprint: sourceFingerprint, source_range: details.source_range ?? null,
    recovery_stages_attempted: [], exhausted_stages: [], staged_partial_records: [],
    completed_source_units: [], candidate_rejections: [], unit_obligations: {},
  };
  window.unit_obligations ??= {};
  const unitKey = String(details.source_unit_key ?? 'unknown');
  for (const record of records) {
    const recordFingerprint = fingerprint(JSON.stringify({
      type: record?.type ?? null, content: record?.content ?? null,
      source_message_indices: record?.source_message_indices ?? [], owner: obligation.owner, tier: obligation.tier,
    }));
    if (window.staged_partial_records.some((item) => item.record_fingerprint === recordFingerprint)) continue;
    window.staged_partial_records.push({
      record_fingerprint: recordFingerprint, record,
      root_obligation_id: logicalObligationId, child_source_fingerprint: sourceFingerprint,
      owner: obligation.owner ?? null, tier: obligation.tier,
      source_message_indices: [...(record?.source_message_indices ?? [])],
      source_unit_key: unitKey, producing_attempt_id: details.producing_attempt_id ?? null,
      recovery_stage: details.recovery_stage ?? null, validation_result: 'parser_and_citation_validated',
      state: 'staged', staged_at: Date.now(),
    });
  }
  window.staged_partial_records = window.staged_partial_records.slice(-128);
  window.completed_source_units = [...new Set([...(window.completed_source_units ?? []), unitKey])].slice(-128);
  window.parser_accepted_candidate_count = Math.max(count(window.parser_accepted_candidate_count),
    window.staged_partial_records.length);
  if (Array.isArray(details.unresolved_semantic_units)) {
    window.unresolved_semantic_units = [...new Set(details.unresolved_semantic_units.map(String))].slice(-128);
  }
  if (details.explicit_none === true) {
    window.explicit_none_source_units = [...new Set([...(window.explicit_none_source_units ?? []), unitKey])].slice(-128);
  }
  window.unit_obligations[unitKey] = {
    ...(window.unit_obligations[unitKey] ?? {}),
    source_unit_key: unitKey,
    child_obligation_id: `${logicalObligationId}:unit:${unitKey}`,
    target_source_fingerprint: details.target_source_fingerprint ?? null,
    disposition: details.explicit_none === true ? 'validated_no_update' : 'record_staged',
    producing_attempt_id: details.producing_attempt_id ?? null,
    normalization_result: details.normalization_result ?? 'not_needed',
    applicability_decision: details.applicability_decision ?? null,
    local_no_update_reason: details.local_no_update_reason ?? null,
    recovery_implementation_version: Number(details.recovery_implementation_version
      ?? RECOVERY_IMPLEMENTATION_VERSION),
    updated_at: Date.now(),
  };
  window.recovery_implementation_version = Math.max(
    Number(window.recovery_implementation_version ?? 1),
    Number(details.recovery_implementation_version ?? RECOVERY_IMPLEMENTATION_VERSION),
  );
  return true;
}

/** Persists exact rejected fragments for crash-safe, fragment-only recovery. Export projections omit raw text. */
export function stageProviderRejectedFragments(metadata, logicalObligationId, sourceFingerprint, fragments = [], details = {}) {
  if (!metadata || !logicalObligationId || !sourceFingerprint) return false;
  const audit = ensure(metadata, metadata.active_catchup_run_id ?? null);
  const obligation = audit.obligations?.[logicalObligationId];
  if (!obligation) return false;
  obligation.recovery_windows ??= {};
  const window = obligation.recovery_windows[sourceFingerprint] ??= {
    source_fingerprint: sourceFingerprint, source_range: details.source_range ?? null,
    recovery_stages_attempted: [], exhausted_stages: [], staged_partial_records: [],
    completed_source_units: [], candidate_rejections: [], unit_obligations: {},
  };
  window.unresolved_fragments ??= [];
  for (const fragment of fragments) {
    if (!fragment?.fragment_id || !fragment?.raw) continue;
    const existing = window.unresolved_fragments.find((item) => item.fragment_id === fragment.fragment_id);
    const record = {
      fragment_id: fragment.fragment_id,
      raw: fragment.raw,
      reason_codes: [...new Set(fragment.reason_codes ?? [])].slice(0, 12),
      producing_attempt_id: details.producing_attempt_id ?? null,
      state: 'pending',
      staged_at: Date.now(),
    };
    if (existing) Object.assign(existing, record);
    else window.unresolved_fragments.push(record);
  }
  window.unresolved_fragments = window.unresolved_fragments.slice(-32);
  window.unresolved_semantic_units = window.unresolved_fragments
    .filter((item) => item.state === 'pending').map((item) => item.fragment_id);
  return true;
}

export function markProviderRejectedFragmentsRecovered(metadata, logicalObligationId, sourceFingerprint, fragmentIds = []) {
  if (!metadata || !logicalObligationId || !sourceFingerprint) return false;
  const audit = ensure(metadata, metadata.active_catchup_run_id ?? null);
  const window = audit.obligations?.[logicalObligationId]?.recovery_windows?.[sourceFingerprint];
  if (!window) return false;
  const recovered = new Set(fragmentIds.map(String));
  for (const item of window.unresolved_fragments ?? []) {
    if (!recovered.has(String(item.fragment_id))) continue;
    item.state = 'recovered';
    item.recovered_at = Date.now();
    delete item.raw;
  }
  window.unresolved_semantic_units = (window.unresolved_fragments ?? [])
    .filter((item) => item.state === 'pending').map((item) => item.fragment_id);
  if (window.unresolved_semantic_units.length === 0 && window.active_recovery_epoch) {
    window.active_recovery_epoch.status = 'completed';
    window.active_recovery_epoch.completed_at = Date.now();
  }
  return true;
}

export function readProviderRecoveryWindowState(metadata, logicalObligationId, sourceFingerprint) {
  const audit = ensure(metadata, metadata?.active_catchup_run_id ?? null);
  const obligation = audit?.obligations?.[logicalObligationId];
  const window = obligation?.recovery_windows?.[sourceFingerprint];
  if (!window) return null;
  if (window.canonical_terminal_state === 'retired_committed_root') return null;
  const result = {
    resume_unresolved_obligation: true,
    root_obligation_id: logicalObligationId,
    source_fingerprint: window.source_fingerprint ?? sourceFingerprint,
    source_range: window.source_range ?? obligation?.last_source_range
      ?? obligation?.root_source_range ?? null,
    selected_recovery_action: obligation?.next_eligible_recovery_action ?? null,
    configuration_signature: obligation?.configuration_signature ?? null,
    recovery_stages_attempted: [...(window.recovery_stages_attempted ?? [])],
    exhausted_stages: [...(window.exhausted_stages ?? [])],
    staged_partial_records: (window.staged_partial_records ?? [])
      .filter((item) => item.state === 'staged').map((item) => item.record).filter(Boolean),
    completed_source_units: [...(window.completed_source_units ?? [])],
    explicit_none_source_units: [...(window.explicit_none_source_units ?? [])],
    unit_obligations: { ...(window.unit_obligations ?? {}) },
    unit_outcomes: Object.values(window.unit_obligations ?? {}),
    recovery_implementation_version: Number(window.recovery_implementation_version ?? 1),
    implementation_version_changed: Number(window.recovery_implementation_version ?? 1)
      < RECOVERY_IMPLEMENTATION_VERSION,
    parser_accepted_candidate_count: count(window.parser_accepted_candidate_count),
    durable_partial_record_count: [...new Set(window.durably_persisted_record_ids ?? [])].length,
    durably_persisted_record_ids: [...new Set(window.durably_persisted_record_ids ?? [])],
    unresolved_semantic_units: [...new Set(window.unresolved_semantic_units ?? [])],
    last_malformed_reason: window.last_malformed_reason ?? null,
    prior_attempt_id: obligation?.last_attempt_id ?? null,
  };
  Object.defineProperty(result, 'unresolved_fragments', {
    value: (window.unresolved_fragments ?? []).filter((item) => item.state === 'pending')
      .map((item) => ({ ...item })),
    enumerable: false,
  });
  return result;
}

/**
 * Retires stale provider-recovery windows only when the canonical obligation
 * ledger proves the same root terminal. Historical attempts and record IDs are
 * preserved; only future recovery eligibility is removed.
 */
export function reconcileProviderRecoveryWindowsFromLedger(metadata, ledgerValue, at = Date.now()) {
  if (!metadata) return { mutations: 0, retired_windows: [], provider_calls: 0, persistence_calls: 0 };
  const audit = ensure(metadata, metadata.active_catchup_run_id ?? null);
  const ledger = ensureMemorizeObligationLedger(ledgerValue);
  const retired = [];
  let mutations = 0;
  for (const [obligationId, obligation] of Object.entries(audit.obligations ?? {})) {
    const canonical = ledger.obligations?.[obligationId];
    if (!canonical?.checkpoint_eligible) continue;
    for (const [sourceFingerprint, window] of Object.entries(obligation.recovery_windows ?? {})) {
      if (window.canonical_terminal_state === 'retired_committed_root') continue;
      window.canonical_terminal_state = 'retired_committed_root';
      window.retired_at = at;
      window.retirement_reason = 'canonical_obligation_safely_committed';
      window.retained_historical_attempts = true;
      window.retained_durable_record_ids = [...new Set(window.durably_persisted_record_ids ?? [])];
      for (const fragment of window.unresolved_fragments ?? []) {
        if (fragment.state === 'pending') {
          fragment.state = 'superseded_by_canonical_commit';
          fragment.superseded_at = at;
          delete fragment.raw;
        }
      }
      window.unresolved_semantic_units = [];
      if (window.active_recovery_epoch
        && !['completed', 'superseded_by_canonical_commit'].includes(window.active_recovery_epoch.status)) {
        window.active_recovery_epoch.status = 'superseded_by_canonical_commit';
        window.active_recovery_epoch.completed_at = at;
      }
      retired.push({ obligation_id: obligationId, source_fingerprint: sourceFingerprint });
      mutations++;
    }
    if (['recovery_in_progress', 'partial_output_pending', 'pending_recovery',
      'provider_response_malformed'].includes(obligation.terminal_outcome)) {
      obligation.terminal_outcome = canonical.current_state === 'explicit_no_update'
        ? 'completed_no_candidates' : 'completed';
      obligation.final_disposition = 'canonical_commit_reconciled';
      obligation.recovery_blocked = false;
      obligation.recovery_intent = null;
      obligation.recovery_stage = null;
      obligation.next_eligible_recovery_action = null;
      obligation.canonical_terminal_reconciliation = {
        version: 1, reconciled_at: at,
        canonical_state: canonical.current_state,
        reason_code: 'canonical_obligation_safely_committed',
      };
      mutations++;
    }
  }
  return {
    mutations,
    retired_windows: retired,
    provider_calls: 0,
    persistence_calls: 0,
  };
}

export function beginProviderRecoveryEpoch(metadata, logicalObligationId, sourceFingerprint, details = {}) {
  if (!metadata || !logicalObligationId || !sourceFingerprint) return null;
  const audit = ensure(metadata, metadata.active_catchup_run_id ?? null);
  const obligation = audit.obligations?.[logicalObligationId];
  const window = obligation?.recovery_windows?.[sourceFingerprint];
  if (!window) return null;
  window.recovery_epochs ??= [];
  const activeEpoch = window.active_recovery_epoch;
  if (activeEpoch && ['initialized_before_dispatch', 'running'].includes(activeEpoch.status)) {
    const activePhysicalAttempt = (audit.recent_attempts ?? []).find((attempt) =>
      attempt.logical_obligation_id === logicalObligationId && attempt.terminal_outcome === 'running');
    if (activePhysicalAttempt) return { ...cloneSerializableDomain(activeEpoch, {
      path: '$.provider_recovery_epoch', stage: 'provider_recovery_epoch_projection',
      operation_type: 'provider_recovery_epoch',
    }), overlap_prevented: true };
    activeEpoch.status = 'interrupted_without_running_attempt';
    activeEpoch.completed_at = Date.now();
  }
  const priorRecoveryRequestCount = (audit.recent_attempts ?? []).filter((attempt) =>
    attempt.logical_obligation_id === logicalObligationId
      && attempt.request_kind !== 'original'
      && attempt.recovery_stage !== 'strict_generation').length;
  const priorRecoveryRequestsByStage = (audit.recent_attempts ?? []).filter((attempt) =>
    attempt.logical_obligation_id === logicalObligationId
      && attempt.request_kind !== 'original'
      && attempt.recovery_stage !== 'strict_generation').reduce((counts, attempt) => {
    const stage = attempt.recovery_stage ?? attempt.request_kind ?? 'unknown';
    counts[stage] = Number(counts[stage] ?? 0) + 1;
    return counts;
  }, {});
  const epoch = {
    schema_version: 1,
    resume_epoch: Math.max(0, ...window.recovery_epochs.map((item) => Number(item.resume_epoch ?? 0))) + 1,
    recovery_intent: details.recovery_intent ?? 'recover_unresolved_partial_output_fragments',
    recovery_stage: details.recovery_stage ?? 'fragment_decision_regeneration',
    unresolved_fragment_ids: [...new Set(details.unresolved_fragment_ids ?? window.unresolved_semantic_units ?? [])],
    accepted_records_preserved: Number(details.accepted_records_preserved
      ?? (window.durably_persisted_record_ids ?? []).length),
    global_request_ceiling: Number(details.global_request_ceiling ?? 20),
    epoch_request_ceiling: Number(details.epoch_request_ceiling ?? 4),
    global_requests_consumed_before_epoch: Number(details.global_requests_consumed_before_epoch
      ?? priorRecoveryRequestCount),
    global_requests_by_stage_before_epoch: cloneSerializableDomain(
      details.global_requests_by_stage_before_epoch ?? priorRecoveryRequestsByStage, {
        path: '$.provider_recovery_epoch.global_requests_by_stage_before_epoch',
        stage: 'provider_recovery_epoch_projection', operation_type: 'provider_recovery_epoch',
      }),
    status: 'initialized_before_dispatch',
    started_at: Date.now(),
  };
  window.recovery_epochs.push(epoch);
  window.recovery_epochs = window.recovery_epochs.slice(-16);
  window.active_recovery_epoch = epoch;
  obligation.recovery_intent = epoch.recovery_intent;
  obligation.recovery_stage = epoch.recovery_stage;
  obligation.next_eligible_recovery_action = 'dispatch_provider_request';
  return cloneSerializableDomain(epoch, {
    path: '$.provider_recovery_epoch', stage: 'provider_recovery_epoch_projection',
    operation_type: 'provider_recovery_epoch',
  });
}

/** Marks valid partial records durable without closing their still-pending obligation. */
export function markProviderPartialRecordsPersisted(metadata, logicalObligationId, sourceFingerprint = null,
  durableRecordIds = []) {
  if (!metadata || !logicalObligationId) return false;
  const audit = ensure(metadata, metadata.active_catchup_run_id ?? null);
  const obligation = audit.obligations?.[logicalObligationId];
  if (!obligation) return false;
  obligation.accepted_partial_output_persisted = true;
  const windows = sourceFingerprint
    ? [obligation.recovery_windows?.[sourceFingerprint]].filter(Boolean)
    : Object.values(obligation.recovery_windows ?? {});
  const durableIds = durableRecordIds.filter(Boolean).map(String);
  for (const window of windows) {
    window.durably_persisted_record_ids = [...new Set([
      ...(window.durably_persisted_record_ids ?? []),
      ...durableIds,
    ])].slice(-128);
    window.durable_partial_record_count = window.durably_persisted_record_ids.length;
    for (const item of window.staged_partial_records ?? []) {
      if (item.state === 'staged') { item.state = 'committed'; item.committed_at = Date.now(); }
    }
  }
  obligation.last_response_contract = {
    ...(obligation.last_response_contract ?? {}),
    accepted_partial_output_persisted: true,
    // Candidate counts describe one physical response and must remain
    // internally reconciled. Durable staged records accumulate across several
    // source-unit responses, so expose that total separately.
    durable_partial_record_count: Math.max(0, ...windows
      .map((window) => (window.durably_persisted_record_ids ?? []).length)),
    durably_persisted_record_ids: [...new Set(windows
      .flatMap((window) => window.durably_persisted_record_ids ?? []))],
    missing_required_results: true,
    obligation_closure_reason: 'valid_partial_records_persisted_obligation_remains_open',
  };
  const event = [...(audit.recent_attempts ?? [])].reverse()
    .find((item) => item.logical_obligation_id === logicalObligationId
      && count(item.accepted_candidate_count) > 0);
  if (event) event.accepted_partial_output_persisted = true;
  return true;
}

/** Marks one safely persisted obligation as paused without converting it into a terminal failure. */
export function markProviderObligationOperationalPause(metadata, logicalObligationId, details = {}) {
  if (!metadata || !logicalObligationId) return false;
  const audit = ensure(metadata, metadata.active_catchup_run_id ?? null);
  const obligation = audit.obligations?.[logicalObligationId];
  if (!obligation) return false;
  obligation.terminal_outcome = 'operational_pause';
  obligation.final_disposition = details.reason_code
    ?? 'recovery_request_budget_reached_with_pending_children';
  obligation.recovery_blocked = false;
  obligation.next_eligible_recovery_action = details.next_eligible_action
    ?? 'dispatch_provider_request';
  obligation.recovery_intent = details.recovery_intent
    ?? obligation.next_eligible_recovery_action;
  obligation.recovery_stage = details.recovery_stage ?? null;
  obligation.operational_pause = {
    reason_code: obligation.final_disposition,
    recovery_intent: obligation.recovery_intent,
    recovery_stage: obligation.recovery_stage,
    consumed_requests: count(details.consumed_requests),
    remaining_requests: count(details.remaining_requests),
    budget_accounting: details.budget_accounting ? cloneSerializableDomain(
      details.budget_accounting, {
        path: '$.provider_attempt.budget_accounting', stage: 'provider_attempt_registration',
        operation_type: 'provider_attempt',
      }) : null,
    fresh_budget_on_resume: details.fresh_budget_on_resume === true,
    paused_at: Date.now(),
  };
  return true;
}

/** Marks bounded automatic recovery as active; this is neither a pause nor a terminal error. */
export function markProviderObligationRecoveryInProgress(metadata, logicalObligationId, details = {}) {
  if (!metadata || !logicalObligationId) return false;
  const audit = ensure(metadata, metadata.active_catchup_run_id ?? null);
  const obligation = audit.obligations?.[logicalObligationId];
  if (!obligation) return false;
  obligation.terminal_outcome = 'recovery_in_progress';
  obligation.final_disposition = 'recovery_in_progress';
  obligation.recovery_blocked = false;
  obligation.recovery_intent = details.recovery_intent
    ?? 'recover_unresolved_partial_output_fragments';
  obligation.recovery_stage = details.recovery_stage ?? 'compact_response_repair';
  obligation.next_eligible_recovery_action = 'dispatch_provider_request';
  obligation.automatic_recovery = {
    unresolved_fragment_count: count(details.unresolved_fragment_count),
    accepted_records_preserved: count(details.accepted_records_preserved),
    request_budget_used: count(details.request_budget_used),
    request_budget_maximum: count(details.request_budget_maximum),
    started_at: Number(details.recovery_started_at ?? Date.now()),
  };
  return true;
}

/** Closes an obligation only after all staged source units reach durable canonical storage. */
export function markProviderStagedRecoveryCompleted(metadata, logicalObligationId, sourceFingerprint, acceptedRecordIds = []) {
  if (!markProviderPartialRecordsPersisted(metadata, logicalObligationId, sourceFingerprint, acceptedRecordIds)) return false;
  const audit = ensure(metadata, metadata.active_catchup_run_id ?? null);
  const obligation = audit.obligations?.[logicalObligationId];
  const window = obligation?.recovery_windows?.[sourceFingerprint];
  if (!obligation || !window) return false;
  const childCoverageComplete = !obligation.child_coverage_manifest
    || recoveryChildManifestComplete(obligation.child_coverage_manifest);
  window.terminal_outcome = 'completed';
  window.missing_required_results = false;
  window.completed_at = Date.now();
  obligation.terminal_outcome = childCoverageComplete
    ? acceptedRecordIds.length > 0 ? 'completed' : 'completed_no_candidates'
    : 'partial_output_pending';
  obligation.final_disposition = childCoverageComplete
    ? 'completed_after_single_source_unit_recovery'
    : 'child_completed_parent_coverage_pending';
  obligation.final_recovery_stage = 'single_source_unit_regeneration';
  obligation.produced_no_update = childCoverageComplete && acceptedRecordIds.length === 0;
  obligation.recovery_blocked = false;
  obligation.next_eligible_recovery_action = null;
  obligation.recovery_eligibility = null;
  return true;
}

export function registerProviderRecoveryChildPlan(metadata, logicalObligationId, details = {}) {
  if (!metadata || !logicalObligationId) return null;
  const audit = ensure(metadata, metadata.active_catchup_run_id ?? null);
  const obligation = audit.obligations?.[logicalObligationId];
  if (!obligation) return null;
  const priorManifest = obligation.child_coverage_manifest ?? null;
  if (priorManifest?.operational_pause?.active === true && !details.parent_child_key && details.budget) {
    const lastEpoch = Math.max(0, ...(priorManifest.budget_epochs ?? [])
      .map((entry) => Number(entry.resume_epoch ?? 0)));
    details.budget.resume_epoch = lastEpoch + 1;
    details.budget.started_at = Date.now();
    details.budget.additional_provider_requests = 0;
    details.budget.requests_by_stage = {};
    details.budget.requests_by_child = {};
  }
  obligation.child_coverage_manifest = createRecoveryChildManifest({
    root_obligation_id: logicalObligationId,
    tier: details.tier ?? obligation.tier,
    owner: details.owner ?? obligation.owner,
    root_source_range: details.root_source_range ?? obligation.root_source_range,
    root_source_fingerprint: details.root_source_fingerprint ?? obligation.root_source_fingerprint,
  }, priorManifest);
  registerRecoveryChildPlan(obligation.child_coverage_manifest, details);
  resumeRecoveryChildManifest(obligation.child_coverage_manifest);
  if (!recoveryChildManifestComplete(obligation.child_coverage_manifest)) {
    obligation.terminal_outcome = 'partial_output_pending';
    obligation.final_disposition = 'repartition_child_coverage_pending';
    obligation.recovery_blocked = false;
    obligation.next_eligible_recovery_action = 'dispatch_provider_request';
  }
  return summarizeRecoveryChildManifest(obligation.child_coverage_manifest);
}

export function markProviderRecoveryChildCompleted(metadata, logicalObligationId, childKey, details = {}) {
  const audit = ensure(metadata, metadata?.active_catchup_run_id ?? null);
  const obligation = audit?.obligations?.[logicalObligationId];
  if (!obligation?.child_coverage_manifest) return null;
  resumeRecoveryChildManifest(obligation.child_coverage_manifest);
  markRecoveryChildState(obligation.child_coverage_manifest, childKey,
    details.explicit_none === true ? 'validated_no_update' : 'completed', details);
  if (recoveryChildManifestComplete(obligation.child_coverage_manifest)) {
    const durableRecordCount = [...new Set(Object.values(obligation.recovery_windows ?? {})
      .flatMap((window) => window.durably_persisted_record_ids ?? []))].length;
    obligation.terminal_outcome = durableRecordCount > 0
      ? 'completed_repartitioned' : 'completed_no_candidates';
    obligation.final_disposition = 'completed_after_full_child_coverage';
    obligation.recovery_blocked = false;
    obligation.next_eligible_recovery_action = null;
  } else {
    obligation.terminal_outcome = 'partial_output_pending';
    obligation.final_disposition = 'child_completed_parent_coverage_pending';
  }
  return summarizeRecoveryChildManifest(obligation.child_coverage_manifest);
}

export function markProviderRecoveryBudgetPause(metadata, logicalObligationId, details = {}) {
  const audit = ensure(metadata, metadata?.active_catchup_run_id ?? null);
  const obligation = audit?.obligations?.[logicalObligationId];
  if (!obligation?.child_coverage_manifest) return null;
  pauseRecoveryChildManifest(obligation.child_coverage_manifest, details);
  obligation.terminal_outcome = 'operational_pause';
  obligation.final_disposition = details.reason_code
    ?? 'recovery_request_budget_reached_with_pending_children';
  obligation.recovery_blocked = false;
  obligation.next_eligible_recovery_action = 'dispatch_provider_request';
  return summarizeRecoveryChildManifest(obligation.child_coverage_manifest);
}

export function summarizeProviderAttemptAudit(metadata) {
  const sourceAudit = metadata?.live_memory_health?.provider_attempt_audit;
  const audit = sourceAudit ? cloneSerializableDomain(sourceAudit, {
    path: '$.provider_attempt_audit_projection', stage: 'diagnostic_projection',
  }) : null;
  if (!audit) return null;
  if (Number(audit.schema_version) !== PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION) {
    return Object.freeze({ schema_version: PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION,
      unavailable: true, reason_code: 'fresh_start_required_for_unsupported_provider_audit' });
  }
  ensureRecoveryWindows(audit);
  const obligations = Object.values(audit.obligations ?? {});
  const recentAttempts = Array.isArray(audit.recent_attempts) ? audit.recent_attempts : [];
  const malformed = obligations.filter((item) => item.malformed_count > 0);
  const recovered = malformed.filter((item) => ['completed', 'completed_no_candidates', 'completed_repartitioned'].includes(item.terminal_outcome));
  const operationalPauses = obligations.filter((item) => item.terminal_outcome === 'operational_pause');
  const recoveriesInProgress = obligations.filter((item) => item.terminal_outcome === 'recovery_in_progress');
  const pausedMalformed = operationalPauses.filter((item) => count(item.malformed_count) > 0);
  const inProgressMalformed = recoveriesInProgress.filter((item) => count(item.malformed_count) > 0);
  const unresolved = obligations.filter((item) =>
    !SUCCESSFUL_TERMINAL_OUTCOMES.has(item.terminal_outcome)
    && item.terminal_outcome !== 'operational_pause'
    && item.terminal_outcome !== 'recovery_in_progress'
    && (count(item.malformed_count) > 0
      || count(item.provider_failure_count) > 0
      || count(item.validation_failure_count) > 0
      || ['partial_output_pending', 'pending_recovery', 'validation_failure'].includes(item.terminal_outcome)));
  const terminalTotal = Object.values(audit.terminal_counts ?? {}).reduce((sum, value) => sum + count(value), 0);
  const planned = count(audit.logical_obligation_count) || obligations.length;
  const archived = audit.archived_obligation_counts ?? emptyArchivedObligationCounts(false);
  const obligationHistoryTruncated = count(archived.total) > 0 || planned > obligations.length;
  const aggregateCountsExact = archived.exact === true || !obligationHistoryTruncated;
  const uniqueMalformed = count(archived.malformed) + malformed.length;
  const recoveredMalformed = count(archived.recovered_malformed) + recovered.length;
  const terminalUnresolvedMalformed = Math.max(0,
    uniqueMalformed - recoveredMalformed - pausedMalformed.length - inProgressMalformed.length);
  const failedObligations = obligations.filter((item) => count(item.malformed_count) > 0
    || count(item.provider_failure_count) > 0 || count(item.validation_failure_count) > 0);
  const recoveredFailedObligations = failedObligations.filter((item) => SUCCESSFUL_TERMINAL_OUTCOMES.has(item.terminal_outcome));
  const uniqueFailedObligations = count(archived.ever_failed) + failedObligations.length;
  const recoveredFailedCount = count(archived.recovered_failed) + recoveredFailedObligations.length;
  const pausedFailedCount = operationalPauses.filter((item) => count(item.malformed_count) > 0
    || count(item.provider_failure_count) > 0 || count(item.validation_failure_count) > 0).length;
  const recoveryInProgressFailedCount = recoveriesInProgress.filter((item) => count(item.malformed_count) > 0
    || count(item.provider_failure_count) > 0 || count(item.validation_failure_count) > 0).length;
  const terminalUnresolvedFailedCount = Math.max(0,
    uniqueFailedObligations - recoveredFailedCount - pausedFailedCount - recoveryInProgressFailedCount);
  const failedId = (item) => item.logical_obligation_id ?? null;
  const failedObligationDispositions = {
    retained_identity_scope: 'currently_retained_provider_obligations',
    ever_failed: failedObligations.map(failedId).filter(Boolean),
    recovered: recoveredFailedObligations.map(failedId).filter(Boolean),
    recovery_in_progress: recoveriesInProgress
      .filter((item) => failedObligations.includes(item)).map(failedId).filter(Boolean),
    operationally_paused: operationalPauses
      .filter((item) => failedObligations.includes(item)).map(failedId).filter(Boolean),
    terminal_unresolved: unresolved
      .filter((item) => failedObligations.includes(item)).map(failedId).filter(Boolean),
    archived_identity_count_unavailable: count(archived.ever_failed),
    archived_identity_limitation: count(archived.ever_failed) > 0
      ? 'Archived obligation scalars are exact, but pruned obligation identities cannot be reconstructed.'
      : null,
  };
  const childCoverageManifests = obligations.map((item) => summarizeRecoveryChildManifest(item.child_coverage_manifest))
    .filter(Boolean);
  const malformedPhysicalCount = Object.values(audit.malformed_reason_counts ?? {}).reduce((sum, value) => sum + count(value), 0);
  const providerTransportFailureCount = count(audit.terminal_counts?.provider_failure);
  const validationFailureCount = count(audit.terminal_counts?.validation_failure);
  const physicalFailureObservationCount = malformedPhysicalCount + providerTransportFailureCount + validationFailureCount;
  const unexplainedEquivalentRequests = count(audit.equivalent_retry_count);
  const totalEquivalentRequests = count(audit.equivalent_request_count);
  const permittedEquivalentRequests = count(audit.permitted_equivalent_request_count);
  const attemptsWithoutRootObligation = recentAttempts.filter((item) =>
    !(item.root_obligation_id ?? item.logical_obligation_id)).length;
  const successfulObligations = obligations.filter((item) => SUCCESSFUL_TERMINAL_OUTCOMES.has(item.terminal_outcome));
  const localNormalizationObligations = count(archived.local_normalization) + obligations.filter((item) =>
    item.final_recovery_stage === 'local_normalization' && count(item.malformed_count) === 0).length;
  const partialOutputObligations = count(archived.partial_output_notice) + obligations.filter((item) =>
    item.last_notice_reason === 'partial_valid_output').length;
  const contextRepartitionObligations = count(archived.context_repartition) + obligations.filter((item) =>
    (item.recovery_stages_attempted ?? []).includes('repartition_child')).length;
  const providerRecoveryAttemptedObligations = count(archived.provider_recovery_attempted) + malformed.filter((item) =>
    count(item.physical_attempt_count) > 1).length;
  const safeNoticeObligations = count(archived.safe_notice) + obligations.filter((item) => count(item.notice_count) > 0).length;
  const strictSuccessObligations = count(archived.strict_success) + successfulObligations.filter((item) =>
    count(item.malformed_count) === 0 && count(item.notice_count) === 0
      && item.final_recovery_stage !== 'local_normalization').length;
  const obligationsRecoveredByStage = recovered.reduce((counts, item) => {
    const stage = item.final_recovery_stage ?? 'unknown';
    counts[stage] = count(counts[stage]) + 1;
    return counts;
  }, { ...(archived.recovered_by_stage ?? {}) });
  const reconciliationViolations = [];
  const addViolation = (condition, invariantId, affected = []) => {
    if (!condition) reconciliationViolations.push({
      invariant_id: invariantId,
      affected_obligation_ids: [...new Set(affected.filter(Boolean))],
    });
  };
  const transmittedCount = count(audit.transmitted_count);
  addViolation(terminalTotal === transmittedCount && count(audit.running_count) === 0,
    'provider_attempt_terminal_accounting', recentAttempts
      .filter((item) => item.terminal_outcome === 'running').map((item) => item.logical_obligation_id));
  addViolation(attemptsWithoutRootObligation === 0, 'physical_attempt_root_obligation_identity', recentAttempts
    .filter((item) => !(item.root_obligation_id ?? item.logical_obligation_id)).map((item) => item.logical_obligation_id));
  addViolation(unexplainedEquivalentRequests === 0 && totalEquivalentRequests === permittedEquivalentRequests,
    'equivalent_request_changed_dimension_accounting', obligations
      .filter((item) => count(item.retry_replay_count) > 0).map((item) => item.logical_obligation_id));
  addViolation(physicalFailureObservationCount >= uniqueFailedObligations,
    'physical_failures_cover_unique_failed_obligations', malformed.map((item) => item.logical_obligation_id));
  addViolation(!aggregateCountsExact || recoveredFailedCount + recoveryInProgressFailedCount
    + pausedFailedCount + terminalUnresolvedFailedCount === uniqueFailedObligations,
  'failed_obligation_disposition_partition', malformed.map((item) => item.logical_obligation_id));
  for (const manifest of childCoverageManifests) addViolation(manifest.reconciliation.consistent,
    'recovery_child_coverage_reconciliation', [manifest.root_obligation_id]);
  addViolation(Math.min(unresolved.length, 64) === unresolved.slice(-64).length,
    'retained_unresolved_detail_count', unresolved.map((item) => item.logical_obligation_id));
  return {
    schema_version: audit.schema_version,
    scope: 'longterm_and_session_extraction_provider_calls',
    definitions: {
      logical_obligation: 'one tier-owner-root-source requirement',
      physical_attempt: 'one request sent to the provider',
      repartition_child: 'a smaller source window linked to one root obligation',
      repair_request: 'a request that changes format/schema instructions without repeating extraction intent',
    },
    physical_attempts: transmittedCount,
    registered_attempts: count(audit.registered_count ?? audit.attempted),
    registered_not_dispatched_attempts: Math.max(0,
      count(audit.registered_count ?? audit.attempted) - count(audit.transmitted_count)),
    terminal_attempts: terminalTotal,
    running_attempts: audit.running_count,
    accounting_reconciled: terminalTotal + count(audit.running_count) === transmittedCount,
    terminal_counts: { ...audit.terminal_counts },
    operational_pauses: operationalPauses.map((item) => ({
      root_obligation_id: item.logical_obligation_id,
      tier: item.tier,
      owner: item.owner ?? null,
      reason_code: item.final_disposition ?? 'recovery_request_budget_reached_with_pending_children',
      recovery_intent: item.recovery_intent ?? item.next_eligible_recovery_action ?? null,
      recovery_stage: item.recovery_stage ?? null,
      budget_accounting: item.budget_accounting ?? null,
      next_resumable_child: item.child_coverage_manifest?.operational_pause?.next_resumable_child ?? null,
      child_coverage: summarizeRecoveryChildManifest(item.child_coverage_manifest),
    })),
    operational_pause_count: operationalPauses.length,
    child_coverage_manifests: childCoverageManifests,
    request_kind_counts: { ...audit.request_kind_counts },
    repair_reason_counts: { ...audit.repair_reason_counts },
    recovery_stage_request_counts: { ...audit.recovery_stage_request_counts },
    recoveries_by_stage: { ...audit.recoveries_by_stage },
    unique_logical_obligations: planned,
    malformed_physical_responses: malformedPhysicalCount,
    malformed_reason_counts: { ...audit.malformed_reason_counts },
    notice_physical_responses: Object.values(audit.notice_reason_counts ?? {}).reduce((sum, value) => sum + count(value), 0),
    notice_reason_counts: { ...audit.notice_reason_counts },
    avoided_repair_request_counts: { ...audit.avoided_repair_request_counts },
    failure_accounting: {
      physical_failure_observation_count: physicalFailureObservationCount,
      malformed_response_count: malformedPhysicalCount,
      provider_transport_failure_count: providerTransportFailureCount,
      parser_structural_failure_count: malformedPhysicalCount,
      validation_failure_count: validationFailureCount,
      unique_failed_obligation_count: uniqueFailedObligations,
      recovered_failed_obligation_count: recoveredFailedCount,
      recovery_in_progress_obligation_count: recoveryInProgressFailedCount,
      operationally_paused_obligation_count: pausedFailedCount,
      terminal_unresolved_obligation_count: terminalUnresolvedFailedCount,
      local_normalization_notice_count: Object.entries(audit.notice_reason_counts ?? {})
        .filter(([reason]) => reason.startsWith('local_normalization:'))
        .reduce((sum, [, value]) => sum + count(value), 0),
      partial_valid_output_notice_count: count(audit.notice_reason_counts?.partial_valid_output),
      authoritative_scalars: aggregateCountsExact,
      retained_arrays_are_diagnostic_only: true,
    },
    failed_obligation_dispositions: failedObligationDispositions,
    provider_failure_lineage: {
      exact_count: providerTransportFailureCount,
      retained: [...(audit.provider_failure_lineage ?? [])],
      retained_detail_limit: 64,
      details_pruned: providerTransportFailureCount > (audit.provider_failure_lineage ?? []).length,
      limitation: providerTransportFailureCount > (audit.provider_failure_lineage ?? []).length
        ? 'bounded lineage detail does not replace the exact scalar' : null,
    },
    modifier_failure_subtype_statistics: Object.fromEntries(Object.entries(audit.modifier_failure_subtype_stats ?? {})
      .map(([subtype, stats]) => [subtype, {
        ...stats,
        terminal_unresolved_count: obligations.filter((item) => !SUCCESSFUL_TERMINAL_OUTCOMES.has(item.terminal_outcome)
          && (item.modifier_failure_subtypes ?? []).includes(subtype)).length,
        terminal_unresolved_count_exact: !obligationHistoryTruncated,
      }])),
    equivalent_request_accounting: {
      total_equivalent_requests: totalEquivalentRequests,
      permitted_equivalent_requests: permittedEquivalentRequests,
      unexplained_equivalent_requests: unexplainedEquivalentRequests,
      reason_counts: { ...(audit.equivalent_request_reason_counts ?? {}) },
      consistent: unexplainedEquivalentRequests === 0
        && totalEquivalentRequests === permittedEquivalentRequests,
    },
    outcome_taxonomy: {
      strict_successful_physical_attempts: count(audit.terminal_counts?.completed)
        - Object.values(audit.notice_reason_counts ?? {}).reduce((sum, value) => sum + count(value), 0),
      harmless_notice_physical_attempts: Object.values(audit.notice_reason_counts ?? {}).reduce((sum, value) => sum + count(value), 0),
      genuine_failed_obligations: uniqueFailedObligations,
      recovered_failed_obligations: recoveredFailedCount,
      unresolved_failed_obligations: terminalUnresolvedFailedCount,
      provider_transport_failures: count(audit.terminal_counts?.provider_failure),
      empty_or_no_candidate_successes: count(audit.terminal_counts?.completed_no_candidates),
      context_repartition_requests: count(audit.request_kind_counts?.repartition_child),
      compact_provider_repair_requests: count(audit.request_kind_counts?.format_repair),
      changed_dimension_regeneration_requests: count(audit.request_kind_counts?.changed_dimension_regeneration),
      minimal_record_regeneration_requests: count(audit.request_kind_counts?.minimal_record_regeneration),
      malformed_repartition_requests: count(audit.request_kind_counts?.malformed_repartition_child),
    },
    obligation_outcome_counts: {
      strict_success_obligations: strictSuccessObligations,
      local_normalization_obligations: localNormalizationObligations,
      partial_output_obligations: partialOutputObligations,
      partial_output_rejected_fragments: count(audit.partial_output_rejected_fragment_count),
      partial_output_rejected_fragments_exact: true,
      context_repartition_obligations: contextRepartitionObligations,
      true_failed_obligations: uniqueFailedObligations,
      provider_recovery_attempted_obligations: providerRecoveryAttemptedObligations,
      provider_recovered_obligations: recoveredFailedCount,
      operationally_paused_obligations: pausedFailedCount,
      terminal_unresolved_obligations: terminalUnresolvedFailedCount,
      safe_notice_obligations: safeNoticeObligations,
      counts_exact: aggregateCountsExact,
    },
    recovery_effectiveness: Object.values(audit.recovery_effectiveness ?? {}).map((entry) => ({
      provider_configuration_signature: entry.provider_configuration_signature,
      tier: entry.tier,
      malformed_reason: entry.malformed_reason,
      recovery_stage: entry.recovery_stage,
      attempts: count(entry.attempts),
      successes: count(entry.successes),
      unique_obligations_recovered: new Set(entry.recovered_obligation_ids ?? []).size,
      added_provider_time_ms: count(entry.provider_elapsed_ms),
      requests_avoided: count(entry.requests_avoided),
    })),
    unique_malformed_obligations: uniqueMalformed,
    recovered_malformed_obligations: recoveredMalformed,
    terminally_unresolved_malformed_obligations: terminalUnresolvedMalformed,
    obligation_aggregate_counts_exact: aggregateCountsExact,
    terminal_unresolved_obligations: unresolved.slice(-64).map((item) => {
      const retainedAttempts = recentAttempts.filter((attempt) => attempt.logical_obligation_id === item.logical_obligation_id);
      const sourceFingerprint = item.last_source_fingerprint ?? item.root_source_fingerprint ?? null;
      const recoveryWindow = item.recovery_windows?.[sourceFingerprint] ?? null;
      const implementationVersionChanged = Number(recoveryWindow?.recovery_implementation_version ?? 1)
        < RECOVERY_IMPLEMENTATION_VERSION;
      const eligibility = deriveRecoveryStageEligibility({
        attempted_stages: recoveryWindow?.recovery_stages_attempted ?? [],
        exhausted_stages: recoveryWindow?.exhausted_stages ?? [],
        durable_partial_record_count: (recoveryWindow?.durably_persisted_record_ids ?? []).length,
        unresolved_semantic_units: recoveryWindow?.unresolved_semantic_units ?? [],
        implementation_version_changed: implementationVersionChanged,
        unit_outcomes: Object.values(recoveryWindow?.unit_obligations ?? {}),
      });
      const unitOutcomes = Object.values(recoveryWindow?.unit_obligations ?? {});
      return {
        tier: item.tier ?? 'unknown', owner: item.owner ?? null,
        source_range: item.last_source_range ?? item.root_source_range ?? null,
        source_fingerprint: sourceFingerprint,
        root_obligation_id: item.logical_obligation_id,
        chat_id: item.chat_id ?? null,
        configuration_signature: item.configuration_signature ?? null,
        original_attempt_id: item.original_attempt_id
          ?? retainedAttempts.find((attempt) => attempt.request_kind === 'original')?.attempt_id ?? null,
        repair_attempt_id: item.repair_attempt_id
          ?? retainedAttempts.findLast((attempt) => attempt.request_kind === 'format_repair')?.attempt_id ?? null,
        malformed_reason: item.last_malformed_reason ?? null,
        prior_authoritative_memory_preserved: item.prior_authoritative_memory_preserved !== false,
        produced_no_update: item.produced_no_update !== false,
        targeted_replay_eligible: item.targeted_replay_eligible !== false,
        final_disposition: item.final_disposition ?? item.terminal_outcome ?? 'terminal_malformed_unresolved',
        recovery_stages_attempted: recoveryWindow?.recovery_stages_attempted ?? item.recovery_stages_attempted ?? [],
        exhausted_recovery_stages: recoveryWindow?.exhausted_stages ?? [],
        final_recovery_stage: item.final_recovery_stage ?? null,
        retry_replay_count: count(item.retry_replay_count),
        parser_accepted_candidate_count: count(recoveryWindow?.parser_accepted_candidate_count),
        durable_partial_record_count: (recoveryWindow?.durably_persisted_record_ids ?? []).length,
        durably_persisted_record_ids: [...new Set(recoveryWindow?.durably_persisted_record_ids ?? [])],
        completed_source_units: [...(recoveryWindow?.completed_source_units ?? [])],
        validated_no_update_source_units: [...(recoveryWindow?.explicit_none_source_units ?? [])],
        blocked_source_units: unitOutcomes
          .filter((unit) => String(unit.disposition ?? '').startsWith('blocked_'))
          .map((unit) => unit.source_unit_key),
        unit_outcomes: unitOutcomes,
        recovery_implementation_version: Number(recoveryWindow?.recovery_implementation_version ?? 1),
        implementation_version_changed: implementationVersionChanged,
        staged_partial_record_count: (recoveryWindow?.staged_partial_records ?? []).length,
        missing_semantic_unit_count: (recoveryWindow?.unresolved_semantic_units ?? []).length,
        rejected_fragment_count: count(recoveryWindow?.rejected_fragment_count),
        candidate_rejections: (recoveryWindow?.candidate_rejections ?? []).slice(-32),
        provider_contract_violation_count: count(item.provider_contract_violation_count),
        last_response_contract: item.last_response_contract ?? null,
        last_terminal_signature: item.last_terminal_signature ?? null,
        terminal_signature_repeat_count: count(item.terminal_signature_repeat_count),
        recovery_blocked: eligibility.blocked,
        recovery_eligibility: eligibility,
        eligible_recovery_stage: eligibility.eligible_action ?? null,
        next_eligible_recovery_action: eligibility.blocked
          ? 'stop_blocked' : 'dispatch_provider_request',
        total_attempts: item.total_attempts ?? item.physical_attempt_count ?? 0,
        attempt_lineage_available: Boolean(item.original_attempt_id || retainedAttempts.length),
      };
    }),
    terminal_unresolved_obligation_detail_limit: 64,
    recovery_success_rate: uniqueMalformed ? recoveredMalformed / uniqueMalformed : 1,
    malformed_recovery_performance: (() => {
      const attemptCounts = malformed.map((item) => count(item.total_attempts ?? item.physical_attempt_count)).sort((a, b) => a - b);
      const durableUnitOutcomes = obligations.flatMap((item) => Object.values(item.recovery_windows ?? {})
        .flatMap((window) => Object.values(window.unit_obligations ?? {})));
      const completedUnitOutcomes = durableUnitOutcomes.filter((item) =>
        ['record_staged', 'validated_no_update'].includes(item.disposition));
      const physicalUnitSuccesses = completedUnitOutcomes.filter((item) =>
        item.producing_attempt_id);
      const locallyAvoidedUnitRequests = completedUnitOutcomes.filter((item) =>
        !item.producing_attempt_id && item.disposition === 'validated_no_update'
        && item.applicability_decision?.local_no_update_validated === true);
      const applicabilityDecisionCounts = durableUnitOutcomes.reduce((counts, item) => {
        const decision = item.applicability_decision?.classification;
        if (decision) counts[decision] = count(counts[decision]) + 1;
        return counts;
      }, {});
      const fullyRecoveredRoots = obligations.filter((item) =>
        SUCCESSFUL_TERMINAL_OUTCOMES.has(item.terminal_outcome)
        && Object.values(item.recovery_windows ?? {}).some((window) =>
          Object.keys(window.unit_obligations ?? {}).length > 0));
      return {
        requests_added_by_stage: { ...audit.recovery_stage_request_counts },
        single_source_unit_regeneration_requests:
          count(audit.recovery_stage_request_counts?.single_source_unit_regeneration),
        successful_physical_single_source_unit_requests: physicalUnitSuccesses.length,
        successfully_completed_source_units: completedUnitOutcomes.length,
        fully_recovered_root_obligations: fullyRecoveredRoots.length,
        locally_avoided_single_source_provider_requests: locallyAvoidedUnitRequests.length,
        applicability_decision_counts: applicabilityDecisionCounts,
        contract_enforcement_requests:
          count(audit.recovery_stage_request_counts?.single_source_contract_enforcement),
        single_source_unit_regeneration_successes:
          count(audit.recoveries_by_stage?.single_source_unit_regeneration),
        obligations_recovered_by_stage: obligationsRecoveredByStage,
        successful_physical_attempts_by_stage: { ...audit.recoveries_by_stage },
        recovery_success_rate_by_stage: Object.fromEntries(Object.entries(audit.recovery_stage_request_counts ?? {})
          .map(([stage, requests]) => [stage, count(requests)
            ? count(obligationsRecoveredByStage[stage]) / count(requests) : 0])),
        provider_elapsed_ms_by_recovery_stage: { ...audit.provider_elapsed_ms_by_recovery_stage },
        recovery_stage_totals_exact: audit.recovery_stage_totals_exact === true,
        terminal_physical_failures_by_recovery_stage: recentAttempts.reduce((counts, attempt) => {
          if (!SUCCESSFUL_TERMINAL_OUTCOMES.has(attempt.terminal_outcome)) {
            const stage = attempt.recovery_stage ?? 'unknown';
            counts[stage] = count(counts[stage]) + 1;
          }
          return counts;
        }, {}),
        median_attempts_per_retained_malformed_obligation: attemptCounts.length
          ? attemptCounts[Math.floor((attemptCounts.length - 1) / 2)] : 0,
        maximum_attempts_per_retained_malformed_obligation: attemptCounts.at(-1) ?? 0,
        retained_obligation_scope: obligations.length,
        avoided_full_chat_reruns: recoveredMalformed,
      };
    })(),
    equivalent_retries_without_changed_dimension: unexplainedEquivalentRequests,
    changed_recovery_dimension_counts: { ...audit.changed_recovery_dimension_counts },
    runtime_context_lookup_counts: { ...audit.runtime_context_lookup_counts },
    local_preflight_underestimated_provider_prompt_total: count(audit.local_preflight_underestimate_count),
    overflow_despite_valid_learned_limit: count(audit.overflow_despite_valid_learned_limit_count),
    extra_requests_caused_by_recovery: Math.max(0, count(audit.attempted) - planned),
    request_amplification: planned ? count(audit.attempted) / planned : 0,
    performance: {
      schema_version: 1,
      scope: 'provider_transmissions_only',
      provider_elapsed_ms_total: count(audit.provider_elapsed_ms),
      provider_elapsed_ms_by_operation_type: { ...audit.provider_elapsed_ms_by_request_kind },
      provider_elapsed_ms_by_extraction_category: { ...audit.provider_elapsed_ms_by_tier },
      provider_elapsed_ms_by_terminal_outcome: { ...audit.provider_elapsed_ms_by_terminal_outcome },
      queue_wait_time_ms: null,
      queue_wait_time_available: false,
      queue_wait_time_limitation: 'provider adapter does not expose queue admission timestamps',
      request_counts_by_operation_type: { ...audit.request_kind_counts },
      request_counts_by_extraction_category: { ...audit.request_counts_by_tier },
      source_messages_attempted: count(audit.source_messages_attempted),
      average_source_messages_per_request: count(audit.attempted)
        ? count(audit.source_messages_attempted) / count(audit.attempted) : 0,
      segment_size_distribution: { ...audit.segment_size_distribution },
      format_repair_amplification_requests: count(audit.request_kind_counts?.format_repair),
      repartition_amplification_requests: count(audit.request_kind_counts?.repartition_child)
        + count(audit.request_kind_counts?.malformed_repartition_child),
      equivalent_retry_amplification_requests: totalEquivalentRequests,
      permitted_equivalent_retry_requests: permittedEquivalentRequests,
      unexplained_equivalent_retry_requests: unexplainedEquivalentRequests,
      failed_or_superseded_elapsed_ms: count(audit.failed_or_superseded_elapsed_ms),
      longest_requests: [...(audit.longest_requests ?? [])],
      longest_request_detail_limit: 16,
      exact_cumulative_timing: audit.performance_totals_exact === true,
      provider_capability_path_counts: recentAttempts.reduce((counts, attempt) => {
        const path = attempt.provider_capability_path;
        if (path) counts[path] = count(counts[path]) + 1;
        return counts;
      }, {}),
      provider_structured_output_capability: recentAttempts.some((attempt) =>
        String(attempt.provider_capability_path ?? '').includes('native_json_schema'))
        ? 'native_json_schema_observed'
        : recentAttempts.some((attempt) => attempt.provider_capability_path)
          ? 'role_or_bounded_envelope_fallback_observed'
          : 'not_observed',
      avoidable_overhead_estimate: {
        request_count: count(audit.request_kind_counts?.format_repair) + unexplainedEquivalentRequests,
        definition: 'format-repair and unchanged-equivalent retries; diagnostic estimate only',
      },
      unavoidable_overhead_estimate: {
        request_count: count(audit.request_kind_counts?.repartition_child)
          + count(audit.request_kind_counts?.malformed_repartition_child),
        definition: 'bounded repartition requests required by effective context limits; diagnostic estimate only',
      },
    },
    retained_attempt_scope: `last_${PROVIDER_ATTEMPT_EVENT_LIMIT}_attempts`,
    retained_attempts: recentAttempts.map((item) => ({
      ...item,
      root_obligation_id: item.root_obligation_id ?? item.logical_obligation_id ?? null,
      logical_run_id: item.logical_run_id ?? item.run_id ?? null,
      recovery_intent: item.recovery_intent ?? (item.request_kind === 'original'
        ? 'extract_root_obligation' : 'recover_unresolved_partial_output_fragments'),
    })),
    retained_obligation_count: obligations.length,
    obligation_history_truncated: obligationHistoryTruncated,
    archived_obligation_counts: { ...archived },
    reconciliation: {
      every_provider_attempt_has_one_terminal_category:
        terminalTotal === transmittedCount && count(audit.running_count) === 0,
      running_attempts: count(audit.running_count),
      repartition_children_without_parent_lineage: recentAttempts.filter((item) => item.request_kind === 'repartition_child'
        && !item.parent_attempt_id && !item.repartition_parent_id).length,
      accepted_outputs_without_known_obligation: recentAttempts.filter((item) =>
        ['completed', 'completed_no_candidates'].includes(item.terminal_outcome)
        && !item.logical_obligation_id).length,
      physical_attempts_without_root_obligation_id: attemptsWithoutRootObligation,
      equivalent_requests_without_changed_recovery_dimension: unexplainedEquivalentRequests,
      equivalent_request_accounting_consistent: unexplainedEquivalentRequests === 0
        && totalEquivalentRequests === permittedEquivalentRequests,
      physical_failure_observations_not_less_than_unique_failed_obligations:
        physicalFailureObservationCount >= uniqueFailedObligations,
      recovered_plus_unresolved_equals_unique_failed: aggregateCountsExact
        ? recoveredFailedCount + recoveryInProgressFailedCount + pausedFailedCount
          + terminalUnresolvedFailedCount === uniqueFailedObligations : null,
      malformed_plus_transport_plus_validation_reconcile_physical_failures:
        malformedPhysicalCount + providerTransportFailureCount + validationFailureCount
          === physicalFailureObservationCount,
      malformed_obligations_reconcile: aggregateCountsExact
        ? uniqueMalformed === recoveredMalformed + inProgressMalformed.length
          + pausedMalformed.length + terminalUnresolvedMalformed : null,
      root_recovered_implies_every_expected_child_complete: childCoverageManifests.every((manifest) =>
        manifest.parent_closure_state !== 'complete' || manifest.coverage.complete === true),
      safely_checkpointed_root_implies_child_coverage_complete: childCoverageManifests.every((manifest) =>
        manifest.safely_checkpointed !== true || manifest.coverage.complete === true),
      valid_generation_root_has_no_unattempted_child: childCoverageManifests.every((manifest) =>
        manifest.valid_generation !== true || manifest.coverage.unattempted_leaf_count === 0),
      incomplete_child_coverage_not_classified_recovered: obligations.every((item) =>
        !item.child_coverage_manifest || recoveryChildManifestComplete(item.child_coverage_manifest)
        || !SUCCESSFUL_TERMINAL_OUTCOMES.has(item.terminal_outcome)),
      repair_attempts_with_failed_attempt_link: recentAttempts.filter((item) => item.request_kind === 'format_repair'
        && !item.recovery_of_attempt_id && !item.parent_attempt_id).length === 0,
      recovery_attempts_without_failed_attempt_or_unresolved_obligation: recentAttempts.filter((item) => {
        if (item.request_kind === 'original') return false;
        const obligation = audit.obligations?.[item.logical_obligation_id];
        return !item.recovery_of_attempt_id && !item.parent_attempt_id && !item.repartition_parent_id
          && count(obligation?.malformed_count) === 0;
      }).length,
      every_malformed_response_belongs_to_physical_attempt: count(audit.attempted)
        >= Object.values(audit.malformed_reason_counts ?? {}).reduce((sum, value) => sum + count(value), 0),
      recovered_and_terminal_unresolved_disjoint: recovered.every((item) => !unresolved.includes(item)),
      parser_and_structural_counts_agree: !recentAttempts.some((attempt) => attempt.parser_count_consistent === false),
      retained_unresolved_detail_is_internally_consistent: unresolved.slice(-64).length
        === Math.min(unresolved.length, 64),
      authoritative_unresolved_count: unresolved.length,
      retained_unresolved_detail_count: unresolved.slice(-64).length,
      unresolved_count_consistent: Math.min(unresolved.length, 64) === unresolved.slice(-64).length,
      source_traversal_coverage_scope: 'checkpointed_source_ranges',
      valid_generation_coverage_scope: 'logical_obligations_with_valid_terminal_output',
      consistent: terminalTotal === transmittedCount && count(audit.running_count) === 0
        && attemptsWithoutRootObligation === 0
        && unexplainedEquivalentRequests === 0 && totalEquivalentRequests === permittedEquivalentRequests
        && physicalFailureObservationCount >= uniqueFailedObligations
        && (!aggregateCountsExact || recoveredFailedCount + recoveryInProgressFailedCount + pausedFailedCount
          + terminalUnresolvedFailedCount === uniqueFailedObligations)
        && childCoverageManifests.every((manifest) => manifest.reconciliation.consistent)
        && Math.min(unresolved.length, 64) === unresolved.slice(-64).length,
      violated_invariants: reconciliationViolations,
      violated_invariant_ids: reconciliationViolations.map((item) => item.invariant_id),
      limitation: obligationHistoryTruncated
        ? aggregateCountsExact
          ? 'obligation detail retention is bounded; archived cumulative counters remain authoritative'
          : 'obligation detail retention is bounded and exact archive counters are unavailable'
        : null,
    },
    coverage: {
      source_traversal_obligations: planned,
      safely_checkpointed_obligations: count(archived.safely_checkpointed)
        + obligations.filter((item) => SUCCESSFUL_TERMINAL_OUTCOMES.has(item.terminal_outcome)).length,
      valid_generation_obligations: count(archived.valid_generation)
        + obligations.filter((item) => ['completed', 'completed_repartitioned'].includes(item.terminal_outcome)).length,
      intentionally_accepted_no_update_obligations: count(archived.intentionally_accepted_no_update)
        + obligations.filter((item) => item.terminal_outcome === 'completed_no_candidates').length,
      terminal_failed_obligations: count(archived.terminal_failed)
        + obligations.filter((item) => !['running', 'recovery_in_progress', 'operational_pause', 'completed', 'completed_no_candidates', 'completed_repartitioned'].includes(item.terminal_outcome)).length,
      operationally_paused_obligations: operationalPauses.length,
      source_traversal_and_generation_are_distinct: true,
    },
  };
}
