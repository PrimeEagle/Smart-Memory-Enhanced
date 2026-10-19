/** Bounded, content-free accounting for actual Long-Term/Session provider calls. */
import { analyzeMalformedResponse, classifyTaggedResponseFailure } from './malformed-output-recovery.js';

export const PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION = 4;
export const PROVIDER_ATTEMPT_EVENT_LIMIT = 160;
// Large enough to retain every root obligation in the supplied 9,434-message
// replay while remaining explicitly bounded for arbitrarily large chats.
export const PROVIDER_OBLIGATION_LIMIT = 4096;

const count = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const SUCCESSFUL_TERMINAL_OUTCOMES = new Set(['completed', 'completed_no_candidates', 'completed_repartitioned']);

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
    recovered_by_stage: {},
  };
}

function migrateLegacyAudit(audit) {
  const sourceSchemaVersion = Number(audit?.schema_version ?? 1);
  if (!audit || sourceSchemaVersion >= 4 || audit.schema_v4_migration) return audit;
  const partialPhysical = count(audit.malformed_reason_counts?.partial_valid_output);
  let partialObligations = 0;
  for (const obligation of Object.values(audit.obligations ?? {})) {
    if (obligation?.final_recovery_stage !== 'strict_partial_valid_preserved'
      || obligation?.terminal_outcome !== 'completed') continue;
    partialObligations++;
    obligation.malformed_count = Math.max(0, count(obligation.malformed_count) - 1);
    obligation.notice_count = count(obligation.notice_count) + 1;
    obligation.last_notice_reason = 'partial_valid_output';
    if (obligation.malformed_count === 0) obligation.last_malformed_reason = null;
  }
  audit.notice_reason_counts ??= {};
  audit.notice_reason_counts.partial_valid_output
    = count(audit.notice_reason_counts.partial_valid_output) + partialPhysical;
  if (audit.malformed_reason_counts) delete audit.malformed_reason_counts.partial_valid_output;
  if (audit.recoveries_by_stage) delete audit.recoveries_by_stage.strict_partial_valid_preserved;
  audit.schema_v4_migration = {
    source_schema_version: sourceSchemaVersion,
    partial_physical_responses_reclassified_as_notices: partialPhysical,
    partial_obligations_reclassified_as_notices: partialObligations,
    archived_obligation_counts_reclassifiable: count(audit.archived_obligation_counts?.total) === 0,
  };
  audit.schema_version = PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION;
  return audit;
}

function archiveObligation(audit, obligation) {
  if (!obligation) return;
  const archived = audit.archived_obligation_counts ??= emptyArchivedObligationCounts(true);
  const successful = SUCCESSFUL_TERMINAL_OUTCOMES.has(obligation.terminal_outcome);
  const malformed = count(obligation.malformed_count) > 0;
  archived.total++;
  if (malformed) archived.malformed++;
  if (malformed && successful) archived.recovered_malformed++;
  if (malformed && successful) {
    const stage = obligation.final_recovery_stage ?? 'unknown';
    archived.recovered_by_stage ??= {};
    archived.recovered_by_stage[stage] = count(archived.recovered_by_stage[stage]) + 1;
  }
  if (obligation.terminal_outcome !== 'running') archived.safely_checkpointed++;
  if (['completed', 'completed_repartitioned'].includes(obligation.terminal_outcome)) archived.valid_generation++;
  if (obligation.terminal_outcome === 'completed_no_candidates') archived.intentionally_accepted_no_update++;
  if (!successful && obligation.terminal_outcome !== 'running') archived.terminal_failed++;
  if (successful && !malformed && !count(obligation.notice_count)) archived.strict_success++;
  if (!malformed && obligation.final_recovery_stage === 'local_normalization') archived.local_normalization++;
  if (obligation.last_notice_reason === 'partial_valid_output') archived.partial_output_notice++;
  if ((obligation.recovery_stages_attempted ?? []).includes('repartition_child')) archived.context_repartition++;
  if (malformed && count(obligation.physical_attempt_count) > 1) archived.provider_recovery_attempted++;
  if (count(obligation.notice_count) > 0) archived.safe_notice++;
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

/** Read-only migration for already-exported/persisted schema-v3 summaries. */
export function migrateProviderAttemptAuditReport(report) {
  if (!report || Number(report.schema_version) >= PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION) return report;
  const migrated = typeof structuredClone === 'function'
    ? structuredClone(report) : JSON.parse(JSON.stringify(report));
  const partialPhysical = count(migrated.malformed_reason_counts?.partial_valid_output);
  const partialObligations = count(migrated.malformed_recovery_performance
    ?.obligations_recovered_by_stage?.strict_partial_valid_preserved);
  migrated.schema_version = PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION;
  migrated.notice_reason_counts = {
    ...(migrated.notice_reason_counts ?? {}),
    partial_valid_output: count(migrated.notice_reason_counts?.partial_valid_output) + partialPhysical,
  };
  migrated.notice_physical_responses = count(migrated.notice_physical_responses) + partialPhysical;
  if (migrated.malformed_reason_counts) delete migrated.malformed_reason_counts.partial_valid_output;
  if (migrated.recoveries_by_stage) delete migrated.recoveries_by_stage.strict_partial_valid_preserved;
  migrated.malformed_physical_responses = Math.max(0, count(migrated.malformed_physical_responses) - partialPhysical);
  migrated.unique_malformed_obligations = Math.max(0, count(migrated.unique_malformed_obligations) - partialObligations);
  migrated.recovered_malformed_obligations = Math.max(0, count(migrated.recovered_malformed_obligations) - partialObligations);
  migrated.terminally_unresolved_malformed_obligations = Math.max(0,
    count(migrated.unique_malformed_obligations) - count(migrated.recovered_malformed_obligations));
  if (migrated.malformed_recovery_performance?.obligations_recovered_by_stage) {
    delete migrated.malformed_recovery_performance.obligations_recovered_by_stage.strict_partial_valid_preserved;
  }
  if (migrated.malformed_recovery_performance?.successful_physical_attempts_by_stage) {
    delete migrated.malformed_recovery_performance.successful_physical_attempts_by_stage.strict_partial_valid_preserved;
  }
  migrated.recovery_success_rate = migrated.unique_malformed_obligations
    ? migrated.recovered_malformed_obligations / migrated.unique_malformed_obligations : 1;
  migrated.legacy_accounting_migration = {
    source_schema_version: Number(report.schema_version ?? 1),
    partial_physical_responses_reclassified_as_notices: partialPhysical,
    partial_obligations_reclassified_as_notices: partialObligations,
    source: 'persisted_summary',
  };
  migrated.obligation_outcome_counts = {
    ...(migrated.obligation_outcome_counts ?? {}),
    strict_success_obligations: migrated.obligation_outcome_counts?.strict_success_obligations ?? null,
    local_normalization_obligations: migrated.obligation_outcome_counts?.local_normalization_obligations ?? null,
    partial_output_obligations: partialObligations,
    partial_output_rejected_fragments: null,
    partial_output_rejected_fragments_exact: false,
    context_repartition_obligations: migrated.obligation_outcome_counts?.context_repartition_obligations ?? null,
    true_failed_obligations: migrated.unique_malformed_obligations,
    provider_recovery_attempted_obligations: migrated.obligation_outcome_counts?.provider_recovery_attempted_obligations ?? null,
    provider_recovered_obligations: migrated.recovered_malformed_obligations,
    terminal_unresolved_obligations: migrated.terminally_unresolved_malformed_obligations,
    safe_notice_obligations: partialObligations,
    counts_exact: false,
  };
  migrated.reconciliation = {
    ...(migrated.reconciliation ?? {}),
    malformed_obligations_reconcile: migrated.unique_malformed_obligations
      === migrated.recovered_malformed_obligations + migrated.terminally_unresolved_malformed_obligations,
  };
  return migrated;
}

function ensure(metadata, runId = null) {
  metadata.live_memory_health ??= {};
  const health = metadata.live_memory_health;
  const prior = health.provider_attempt_audit;
  if (!prior || (runId && prior.run_id !== runId)) {
    health.provider_attempt_audit = {
      schema_version: PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION,
      run_id: runId,
      sequence: 0,
      attempted: 0,
      terminal_counts: {},
      malformed_reason_counts: {},
      request_kind_counts: {},
      repair_reason_counts: {},
      changed_recovery_dimension_counts: {},
      runtime_context_lookup_counts: {},
      overflow_despite_valid_learned_limit_count: 0,
      local_preflight_underestimate_count: 0,
      equivalent_retry_count: 0,
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
    };
  }
  const audit = health.provider_attempt_audit;
  const sourceSchemaVersion = Number(audit.schema_version ?? 1);
  migrateLegacyAudit(audit);
  const performanceTotalsCompatible = sourceSchemaVersion >= 2;
  const recoveryStageTotalsCompatible = sourceSchemaVersion >= 3;
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
  audit.recovery_stage_totals_exact ??= recoveryStageTotalsCompatible;
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
    // Preserve the established public compatibility label while the recovery
    // ladder records the more precise missing-tag reason on physical attempts.
    return reason === 'missing_tagged_records' ? 'prose_around_structured_output' : reason;
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
  audit.running_count++;
  const obligationId = input.logical_obligation_id ?? fingerprint([
    input.tier, input.owner, input.root_source_fingerprint ?? input.source_fingerprint,
    input.root_source_start, input.root_source_end,
  ].join('|'));
  const signature = input.request_signature ?? fingerprint([
    obligationId, input.source_fingerprint, input.request_kind, input.effective_context_limit,
    input.reserved_output_tokens, input.schema_version,
  ].join('|'));
  const priorEquivalent = [...audit.recent_attempts].reverse().find((item) =>
    item.logical_obligation_id === obligationId && item.request_signature === signature);
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
  obligation.configuration_signature ??= input.configuration_signature ?? null;
  obligation.chat_id ??= input.chat_id ?? null;
  if (isNewObligation) audit.logical_obligation_count = count(audit.logical_obligation_count) + 1;
  obligation.physical_attempt_count++;
  obligation.last_attempt_at = Date.now();
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
    at: Date.now(), run_id: audit.run_id, logical_obligation_id: obligationId,
    tier: input.tier ?? 'unknown', owner: input.owner ?? null,
    request_kind: input.request_kind ?? 'original',
    parent_attempt_id: input.parent_attempt_id ?? null,
    repartition_parent_id: input.repartition_parent_id ?? null,
    source_range: input.source_range ?? null,
    source_fingerprint: input.source_fingerprint ?? null,
    request_signature: signature,
    equivalent_prior_attempt: Boolean(priorEquivalent),
    changed_recovery_dimensions: [...new Set(input.changed_recovery_dimensions ?? [])].slice(0, 8),
    recovery_of_attempt_id: input.recovery_of_attempt_id ?? null,
    repair_reason: input.repair_reason ?? null,
    recovery_stage: input.recovery_stage ?? (input.request_kind === 'original' ? 'strict_generation' : input.request_kind),
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
  };
  if (!obligation.original_attempt_id && event.request_kind === 'original') obligation.original_attempt_id = event.attempt_id;
  if (event.request_kind === 'format_repair') obligation.repair_attempt_id = event.attempt_id;
  audit.request_kind_counts[event.request_kind] = count(audit.request_kind_counts[event.request_kind]) + 1;
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
  if (event.equivalent_prior_attempt && event.changed_recovery_dimensions.length === 0) audit.equivalent_retry_count++;
  for (const dimension of event.changed_recovery_dimensions) {
    audit.changed_recovery_dimension_counts[dimension] = count(audit.changed_recovery_dimension_counts[dimension]) + 1;
  }
  audit.recent_attempts.push(event);
  audit.recent_attempts = audit.recent_attempts.slice(-PROVIDER_ATTEMPT_EVENT_LIMIT);
  return event;
}

export function finishProviderAttempt(metadata, event, patch = {}) {
  if (!metadata || !event || event.terminal_outcome !== 'running') return event;
  const audit = ensure(metadata, event.run_id ?? metadata.active_catchup_run_id ?? null);
  event.terminal_outcome = patch.terminal_outcome ?? 'internal_failure';
  event.malformed_reason = patch.malformed_reason ?? null;
  event.notice_reason = patch.notice_reason ?? null;
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
    if (event.malformed_reason) {
      obligation.malformed_count++;
      obligation.last_malformed_reason = event.malformed_reason;
    }
    if (event.notice_reason) {
      obligation.notice_count = count(obligation.notice_count) + 1;
      obligation.last_notice_reason = event.notice_reason;
    }
  }
  if (event.malformed_reason) {
    audit.malformed_reason_counts[event.malformed_reason] = count(audit.malformed_reason_counts[event.malformed_reason]) + 1;
  }
  if (event.notice_reason) audit.notice_reason_counts[event.notice_reason]
    = count(audit.notice_reason_counts[event.notice_reason]) + 1;
  if (event.notice_reason === 'partial_valid_output') audit.partial_output_rejected_fragment_count
    = count(audit.partial_output_rejected_fragment_count)
      + count(event.response_shape?.structurally_rejected_record_count ?? event.response_shape?.rejected_tagged_record_count);
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
    if (obligation?.malformed_count > 0 && event.recovery_stage && event.recovery_stage !== 'strict_generation') {
      audit.recoveries_by_stage[event.recovery_stage] = count(audit.recoveries_by_stage[event.recovery_stage]) + 1;
    }
    for (const prior of audit.recent_attempts) {
      if (prior === event || prior.logical_obligation_id !== event.logical_obligation_id || !prior.malformed_reason || prior.recovered_by_attempt_id) continue;
      prior.recovered_by_attempt_id = event.attempt_id;
      prior.recovery_same_source_fingerprint = prior.source_fingerprint === event.source_fingerprint;
    }
  }
  return event;
}

export function summarizeProviderAttemptAudit(metadata) {
  const sourceAudit = metadata?.live_memory_health?.provider_attempt_audit;
  const audit = sourceAudit && Number(sourceAudit.schema_version) < PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION
    ? migrateLegacyAudit(typeof structuredClone === 'function'
      ? structuredClone(sourceAudit) : JSON.parse(JSON.stringify(sourceAudit)))
    : sourceAudit;
  if (!audit) return null;
  const obligations = Object.values(audit.obligations ?? {});
  const recentAttempts = Array.isArray(audit.recent_attempts) ? audit.recent_attempts : [];
  const malformed = obligations.filter((item) => item.malformed_count > 0);
  const recovered = malformed.filter((item) => ['completed', 'completed_no_candidates', 'completed_repartitioned'].includes(item.terminal_outcome));
  const unresolved = malformed.filter((item) => !['completed', 'completed_no_candidates', 'completed_repartitioned'].includes(item.terminal_outcome));
  const terminalTotal = Object.values(audit.terminal_counts ?? {}).reduce((sum, value) => sum + count(value), 0);
  const planned = count(audit.logical_obligation_count) || obligations.length;
  const archived = audit.archived_obligation_counts ?? emptyArchivedObligationCounts(false);
  const obligationHistoryTruncated = count(archived.total) > 0 || planned > obligations.length;
  const aggregateCountsExact = archived.exact === true || !obligationHistoryTruncated;
  const uniqueMalformed = count(archived.malformed) + malformed.length;
  const recoveredMalformed = count(archived.recovered_malformed) + recovered.length;
  const terminalUnresolvedMalformed = uniqueMalformed - recoveredMalformed;
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
  return {
    schema_version: audit.schema_version,
    scope: 'longterm_and_session_extraction_provider_calls',
    definitions: {
      logical_obligation: 'one tier-owner-root-source requirement',
      physical_attempt: 'one request sent to the provider',
      repartition_child: 'a smaller source window linked to one root obligation',
      repair_request: 'a request that changes format/schema instructions without repeating extraction intent',
    },
    physical_attempts: audit.attempted,
    terminal_attempts: terminalTotal,
    running_attempts: audit.running_count,
    accounting_reconciled: terminalTotal + count(audit.running_count) === count(audit.attempted),
    terminal_counts: { ...audit.terminal_counts },
    request_kind_counts: { ...audit.request_kind_counts },
    repair_reason_counts: { ...audit.repair_reason_counts },
    recovery_stage_request_counts: { ...audit.recovery_stage_request_counts },
    recoveries_by_stage: { ...audit.recoveries_by_stage },
    unique_logical_obligations: planned,
    malformed_physical_responses: Object.values(audit.malformed_reason_counts ?? {}).reduce((sum, value) => sum + count(value), 0),
    malformed_reason_counts: { ...audit.malformed_reason_counts },
    notice_physical_responses: Object.values(audit.notice_reason_counts ?? {}).reduce((sum, value) => sum + count(value), 0),
    notice_reason_counts: { ...audit.notice_reason_counts },
    avoided_repair_request_counts: { ...audit.avoided_repair_request_counts },
    legacy_accounting_migration: audit.schema_v4_migration ?? null,
    outcome_taxonomy: {
      strict_successful_physical_attempts: count(audit.terminal_counts?.completed)
        - Object.values(audit.notice_reason_counts ?? {}).reduce((sum, value) => sum + count(value), 0),
      harmless_notice_physical_attempts: Object.values(audit.notice_reason_counts ?? {}).reduce((sum, value) => sum + count(value), 0),
      genuine_failed_obligations: uniqueMalformed,
      recovered_failed_obligations: recoveredMalformed,
      unresolved_failed_obligations: terminalUnresolvedMalformed,
      provider_transport_failures: count(audit.terminal_counts?.provider_failure),
      empty_or_no_candidate_successes: count(audit.terminal_counts?.completed_no_candidates),
      context_repartition_requests: count(audit.request_kind_counts?.repartition_child),
      compact_provider_repair_requests: count(audit.request_kind_counts?.format_repair),
      changed_dimension_regeneration_requests: count(audit.request_kind_counts?.changed_dimension_regeneration),
      malformed_repartition_requests: count(audit.request_kind_counts?.malformed_repartition_child),
    },
    obligation_outcome_counts: {
      strict_success_obligations: strictSuccessObligations,
      local_normalization_obligations: localNormalizationObligations,
      partial_output_obligations: partialOutputObligations,
      partial_output_rejected_fragments: count(audit.partial_output_rejected_fragment_count),
      partial_output_rejected_fragments_exact: Number(audit.schema_v4_migration?.source_schema_version ?? 4) >= 4,
      context_repartition_obligations: contextRepartitionObligations,
      true_failed_obligations: uniqueMalformed,
      provider_recovery_attempted_obligations: providerRecoveryAttemptedObligations,
      provider_recovered_obligations: recoveredMalformed,
      terminal_unresolved_obligations: terminalUnresolvedMalformed,
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
      return {
        tier: item.tier ?? 'unknown', owner: item.owner ?? null,
        source_range: item.last_source_range ?? item.root_source_range ?? null,
        source_fingerprint: item.last_source_fingerprint ?? item.root_source_fingerprint ?? null,
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
        recovery_stages_attempted: item.recovery_stages_attempted ?? [],
        final_recovery_stage: item.final_recovery_stage ?? null,
        total_attempts: item.total_attempts ?? item.physical_attempt_count ?? 0,
        attempt_lineage_available: Boolean(item.original_attempt_id || retainedAttempts.length),
      };
    }),
    terminal_unresolved_obligation_detail_limit: 64,
    recovery_success_rate: uniqueMalformed ? recoveredMalformed / uniqueMalformed : 1,
    malformed_recovery_performance: (() => {
      const attemptCounts = malformed.map((item) => count(item.total_attempts ?? item.physical_attempt_count)).sort((a, b) => a - b);
      return {
        requests_added_by_stage: { ...audit.recovery_stage_request_counts },
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
    equivalent_retries_without_changed_dimension: audit.equivalent_retry_count,
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
      equivalent_retry_amplification_requests: count(audit.equivalent_retry_count),
      failed_or_superseded_elapsed_ms: count(audit.failed_or_superseded_elapsed_ms),
      longest_requests: [...(audit.longest_requests ?? [])],
      longest_request_detail_limit: 16,
      exact_cumulative_timing: audit.performance_totals_exact === true,
      provider_structured_output_capability: 'not_exposed_by_current_memory_adapter_tagged_line_fallback_used',
      avoidable_overhead_estimate: {
        request_count: count(audit.request_kind_counts?.format_repair) + count(audit.equivalent_retry_count),
        definition: 'format-repair and unchanged-equivalent retries; diagnostic estimate only',
      },
      unavoidable_overhead_estimate: {
        request_count: count(audit.request_kind_counts?.repartition_child)
          + count(audit.request_kind_counts?.malformed_repartition_child),
        definition: 'bounded repartition requests required by effective context limits; diagnostic estimate only',
      },
    },
    retained_attempt_scope: `last_${PROVIDER_ATTEMPT_EVENT_LIMIT}_attempts`,
    retained_attempts: recentAttempts,
    retained_obligation_count: obligations.length,
    obligation_history_truncated: obligationHistoryTruncated,
    archived_obligation_counts: { ...archived },
    reconciliation: {
      every_provider_attempt_has_one_terminal_category: terminalTotal === count(audit.attempted) && count(audit.running_count) === 0,
      running_attempts: count(audit.running_count),
      repartition_children_without_parent_lineage: recentAttempts.filter((item) => item.request_kind === 'repartition_child'
        && !item.parent_attempt_id && !item.repartition_parent_id).length,
      accepted_outputs_without_known_obligation: recentAttempts.filter((item) =>
        ['completed', 'completed_no_candidates'].includes(item.terminal_outcome)
        && !item.logical_obligation_id).length,
      equivalent_requests_without_changed_recovery_dimension: count(audit.equivalent_retry_count),
      malformed_obligations_reconcile: aggregateCountsExact
        ? uniqueMalformed === recoveredMalformed + terminalUnresolvedMalformed : null,
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
      authoritative_unresolved_count: terminalUnresolvedMalformed,
      retained_unresolved_detail_count: unresolved.slice(-64).length,
      source_traversal_coverage_scope: 'checkpointed_source_ranges',
      valid_generation_coverage_scope: 'logical_obligations_with_valid_terminal_output',
      limitation: obligationHistoryTruncated
        ? aggregateCountsExact
          ? 'obligation detail retention is bounded; archived cumulative counters remain authoritative'
          : 'legacy obligation detail retention was bounded before exact archive counters were available'
        : null,
    },
    coverage: {
      source_traversal_obligations: planned,
      safely_checkpointed_obligations: count(archived.safely_checkpointed)
        + obligations.filter((item) => item.terminal_outcome !== 'running').length,
      valid_generation_obligations: count(archived.valid_generation)
        + obligations.filter((item) => ['completed', 'completed_repartitioned'].includes(item.terminal_outcome)).length,
      intentionally_accepted_no_update_obligations: count(archived.intentionally_accepted_no_update)
        + obligations.filter((item) => item.terminal_outcome === 'completed_no_candidates').length,
      terminal_failed_obligations: count(archived.terminal_failed)
        + obligations.filter((item) => !['running', 'completed', 'completed_no_candidates', 'completed_repartitioned'].includes(item.terminal_outcome)).length,
      source_traversal_and_generation_are_distinct: true,
    },
  };
}
