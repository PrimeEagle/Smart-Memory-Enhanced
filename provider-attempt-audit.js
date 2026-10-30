/** Bounded, content-free accounting for actual Long-Term/Session provider calls. */
import { analyzeMalformedResponse, classifyTaggedResponseFailure } from './malformed-output-recovery.js';
import { deriveRecoveryStageEligibility, RECOVERY_IMPLEMENTATION_VERSION } from './recovery-stage-eligibility.js';
import {
  createRecoveryChildManifest,
  markRecoveryChildState,
  pauseRecoveryChildManifest,
  recoveryChildManifestComplete,
  registerRecoveryChildPlan,
  resumeRecoveryChildManifest,
  summarizeRecoveryChildManifest,
} from './recovery-child-coverage.js';

export const PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION = 10;
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
    ever_failed: 0,
    recovered_failed: 0,
    provider_failure: 0,
    validation_failure: 0,
    recovered_by_stage: {},
  };
}

function migrateLegacyAudit(audit) {
  const sourceSchemaVersion = Number(audit?.schema_version ?? 1);
  if (!audit || sourceSchemaVersion >= PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION) return audit;
  const partialPhysical = sourceSchemaVersion < 4 ? count(audit.malformed_reason_counts?.partial_valid_output) : 0;
  let partialObligations = 0;
  for (const obligation of Object.values(audit.obligations ?? {})) {
    obligation.provider_failure_count ??= 0;
    obligation.validation_failure_count ??= 0;
    obligation.provider_failure_lineage ??= [];
    if (sourceSchemaVersion >= 4) continue;
    if (obligation?.final_recovery_stage !== 'strict_partial_valid_preserved'
      || obligation?.terminal_outcome !== 'completed') continue;
    partialObligations++;
    obligation.malformed_count = Math.max(0, count(obligation.malformed_count) - 1);
    obligation.notice_count = count(obligation.notice_count) + 1;
    obligation.last_notice_reason = 'partial_valid_output';
    if (obligation.malformed_count === 0) obligation.last_malformed_reason = null;
  }
  if (sourceSchemaVersion < 4) {
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
  }
  audit.provider_failure_lineage ??= [];
  audit.equivalent_request_count ??= count(audit.equivalent_retry_count);
  audit.permitted_equivalent_request_count ??= 0;
  audit.modifier_failure_subtype_stats ??= {};
  audit.schema_v5_migration = { source_schema_version: sourceSchemaVersion,
    provider_failure_lineage_available: sourceSchemaVersion >= 5,
    limitation: count(audit.terminal_counts?.provider_failure) > 0
      ? 'legacy provider-failure detail may have been pruned before schema v5' : null };
  audit.schema_v6_migration = {
    source_schema_version: sourceSchemaVersion,
    recovery_terminal_signatures_available: false,
    response_contract_diagnostics_available: false,
  };
  audit.schema_v7_migration = {
    source_schema_version: sourceSchemaVersion,
    recovery_windows_reconstructed_from_retained_attempts: true,
    equivalent_replays_reclassified: 0,
  };
  audit.schema_v8_migration = {
    source_schema_version: sourceSchemaVersion,
    recovery_implementation_version_assumed: 1,
    per_unit_obligations_available: false,
    baseline_physical_attempts: count(audit.attempted),
    baseline_malformed_physical_responses: Object.values(audit.malformed_reason_counts ?? {})
      .reduce((sum, value) => sum + count(value), 0),
    baseline_extra_requests: Math.max(0, count(audit.attempted) - count(audit.logical_obligation_count)),
  };
  audit.schema_v9_migration = {
    source_schema_version: sourceSchemaVersion,
    owner_applicability_evidence_available: false,
    response_fragment_accounting_available: false,
    single_source_success_scopes_reconstructed_from_durable_unit_obligations: true,
  };
  audit.schema_v10_migration = {
    source_schema_version: sourceSchemaVersion,
    child_coverage_manifests_reconstructed_on_next_resume: true,
    optimistic_recovered_roots_reopened_when_child_coverage_is_incomplete: true,
  };
  for (const obligation of Object.values(audit.obligations ?? {})) {
    obligation.recovery_implementation_version ??= 1;
    for (const window of Object.values(obligation.recovery_windows ?? {})) {
      window.recovery_implementation_version ??= 1;
      window.unit_obligations ??= {};
    }
  }
  const seenBySignature = new Map();
  for (const event of audit.recent_attempts ?? []) {
    const key = `${event.logical_obligation_id}|${event.request_signature}`;
    const priorEvent = seenBySignature.get(key);
    if (event.equivalent_prior_attempt && !event.equivalent_retry_reason && priorEvent
      && !SUCCESSFUL_TERMINAL_OUTCOMES.has(priorEvent.terminal_outcome)) {
      event.equivalent_retry_reason = 'checkpoint_pending_obligation_retry';
      event.equivalent_retry_permitted = true;
      audit.equivalent_retry_count = Math.max(0, count(audit.equivalent_retry_count) - 1);
      audit.permitted_equivalent_request_count = count(audit.permitted_equivalent_request_count) + 1;
      audit.equivalent_request_reason_counts ??= {};
      audit.equivalent_request_reason_counts.unexplained_equivalent_request = Math.max(0,
        count(audit.equivalent_request_reason_counts.unexplained_equivalent_request) - 1);
      audit.equivalent_request_reason_counts.checkpoint_pending_obligation_retry = count(
        audit.equivalent_request_reason_counts.checkpoint_pending_obligation_retry) + 1;
      const obligation = audit.obligations?.[event.logical_obligation_id];
      if (obligation) obligation.retry_replay_count = count(obligation.retry_replay_count) + 1;
      audit.schema_v7_migration.equivalent_replays_reclassified++;
    }
    seenBySignature.set(key, event);
  }
  audit.schema_version = PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION;
  return audit;
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
    window.accepted_partial_record_count = Math.max(count(window.accepted_partial_record_count), count(event.accepted_candidate_count));
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

/** Read-only migration for already-exported/persisted schema-v3 summaries. */
export function migrateProviderAttemptAuditReport(report) {
  if (!report || Number(report.schema_version) >= PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION) return report;
  const migrated = typeof structuredClone === 'function'
    ? structuredClone(report) : JSON.parse(JSON.stringify(report));
  if (Number(report.schema_version) >= 4) {
    const malformed = count(migrated.malformed_physical_responses);
    const transport = count(migrated.terminal_counts?.provider_failure
      ?? migrated.outcome_taxonomy?.provider_transport_failures);
    const uniqueFailed = count(migrated.unique_malformed_obligations
      ?? migrated.obligation_outcome_counts?.true_failed_obligations);
    const recovered = count(migrated.recovered_malformed_obligations
      ?? migrated.obligation_outcome_counts?.provider_recovered_obligations);
    migrated.schema_version = PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION;
    migrated.failure_accounting = {
      physical_failure_observation_count: malformed + transport,
      malformed_response_count: malformed,
      provider_transport_failure_count: transport,
      parser_structural_failure_count: malformed,
      validation_failure_count: 0,
      unique_failed_obligation_count: uniqueFailed,
      recovered_failed_obligation_count: recovered,
      terminal_unresolved_obligation_count: count(migrated.terminally_unresolved_malformed_obligations),
      local_normalization_notice_count: count(migrated.notice_reason_counts?.local_normalization),
      partial_valid_output_notice_count: count(migrated.notice_reason_counts?.partial_valid_output),
      authoritative_scalars: true,
    };
    migrated.provider_failure_lineage = {
      exact_count: transport,
      retained: [],
      retained_detail_limit: 64,
      details_pruned_or_legacy: transport > 0,
      limitation: transport > 0 ? 'schema-v4 export did not retain provider-failure lineage' : null,
    };
    const equivalent = count(migrated.equivalent_retries_without_changed_dimension
      ?? migrated.reconciliation?.equivalent_requests_without_changed_recovery_dimension);
    migrated.equivalent_request_accounting = {
      total_equivalent_requests: equivalent,
      permitted_equivalent_requests: 0,
      unexplained_equivalent_requests: equivalent,
      consistent: equivalent === 0,
      limitation: equivalent > 0 ? 'schema-v4 did not retain equivalence disposition' : null,
    };
    migrated.schema_v5_migration = { source_schema_version: Number(report.schema_version),
      provider_failure_lineage_available: false, equivalent_request_disposition_available: false };
    return migrated;
  }
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
  migrated.failure_accounting = {
    physical_failure_observation_count: count(migrated.malformed_physical_responses)
      + count(migrated.terminal_counts?.provider_failure),
    malformed_response_count: count(migrated.malformed_physical_responses),
    provider_transport_failure_count: count(migrated.terminal_counts?.provider_failure),
    parser_structural_failure_count: count(migrated.malformed_physical_responses),
    validation_failure_count: 0,
    unique_failed_obligation_count: count(migrated.unique_malformed_obligations),
    recovered_failed_obligation_count: count(migrated.recovered_malformed_obligations),
    terminal_unresolved_obligation_count: count(migrated.terminally_unresolved_malformed_obligations),
    local_normalization_notice_count: count(migrated.notice_reason_counts?.local_normalization),
    partial_valid_output_notice_count: count(migrated.notice_reason_counts?.partial_valid_output),
    authoritative_scalars: migrated.obligation_outcome_counts?.counts_exact === true,
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
    obligation.next_eligible_recovery_action = 'changed_configuration_retry';
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
    at: Date.now(), run_id: audit.run_id, logical_obligation_id: obligationId,
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
      accepted_partial_record_count: count(recoveryWindow.accepted_partial_record_count),
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
  Object.defineProperty(event.prior_window_recovery_state, 'staged_partial_records', {
    value: (recoveryWindow.staged_partial_records ?? [])
      .filter((item) => item.state === 'staged').map((item) => item.record).filter(Boolean),
    enumerable: false,
  });
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
  return event;
}

export function finishProviderAttempt(metadata, event, patch = {}) {
  if (!metadata || !event || event.terminal_outcome !== 'running') return event;
  const audit = ensure(metadata, event.run_id ?? metadata.active_catchup_run_id ?? null);
  event.terminal_outcome = patch.terminal_outcome ?? 'internal_failure';
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
    recoveryWindow.accepted_partial_record_count = Math.max(count(recoveryWindow.accepted_partial_record_count),
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
    obligation.accepted_partial_record_count = Math.max(count(obligation.accepted_partial_record_count),
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
        accepted_partial_record_count: recoveryWindow.accepted_partial_record_count,
        unresolved_semantic_units: recoveryWindow.unresolved_semantic_units ?? [],
        implementation_version_changed: event.implementation_version_changed === true,
      });
      obligation.recovery_eligibility = eligibility;
      obligation.recovery_blocked = eligibility.blocked;
      obligation.next_eligible_recovery_action = eligibility.eligible_action
        ?? 'change_provider_configuration_or_install_updated_build';
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
  return event;
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
    : details.next_eligible_action ?? (reasonCode === 'invalid_candidate_shape'
      ? 'session_validation_repair_or_bounded_regeneration' : 'resume_exact_obligation');
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
  window.accepted_partial_record_count = window.staged_partial_records.length;
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

export function readProviderRecoveryWindowState(metadata, logicalObligationId, sourceFingerprint) {
  const audit = ensure(metadata, metadata?.active_catchup_run_id ?? null);
  const window = audit?.obligations?.[logicalObligationId]?.recovery_windows?.[sourceFingerprint];
  if (!window) return null;
  return {
    resume_unresolved_obligation: true,
    configuration_signature: audit?.obligations?.[logicalObligationId]?.configuration_signature ?? null,
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
    accepted_partial_record_count: count(window.accepted_partial_record_count),
    durable_partial_record_count: count(window.accepted_partial_record_count),
    last_malformed_reason: window.last_malformed_reason ?? null,
  };
}

/** Marks valid partial records durable without closing their still-pending obligation. */
export function markProviderPartialRecordsPersisted(metadata, logicalObligationId, acceptedCount = 0, sourceFingerprint = null) {
  if (!metadata || !logicalObligationId) return false;
  const audit = ensure(metadata, metadata.active_catchup_run_id ?? null);
  const obligation = audit.obligations?.[logicalObligationId];
  if (!obligation) return false;
  obligation.accepted_partial_record_count = Math.max(count(obligation.accepted_partial_record_count), count(acceptedCount));
  obligation.accepted_partial_output_persisted = true;
  const windows = sourceFingerprint
    ? [obligation.recovery_windows?.[sourceFingerprint]].filter(Boolean)
    : Object.values(obligation.recovery_windows ?? {});
  for (const window of windows) {
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
    durable_partial_record_count: Math.max(
      count(obligation.last_response_contract?.durable_partial_record_count), count(acceptedCount)),
    missing_required_results: true,
    obligation_closure_reason: 'valid_partial_records_persisted_obligation_remains_open',
  };
  const event = [...(audit.recent_attempts ?? [])].reverse()
    .find((item) => item.logical_obligation_id === logicalObligationId
      && count(item.accepted_candidate_count) > 0);
  if (event) event.accepted_partial_output_persisted = true;
  return true;
}

/** Closes an obligation only after all staged source units reach durable canonical storage. */
export function markProviderStagedRecoveryCompleted(metadata, logicalObligationId, sourceFingerprint, acceptedCount = 0) {
  if (!markProviderPartialRecordsPersisted(metadata, logicalObligationId, acceptedCount, sourceFingerprint)) return false;
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
    ? acceptedCount > 0 ? 'completed' : 'completed_no_candidates'
    : 'partial_output_pending';
  obligation.final_disposition = childCoverageComplete
    ? 'completed_after_single_source_unit_recovery'
    : 'child_completed_parent_coverage_pending';
  obligation.final_recovery_stage = 'single_source_unit_regeneration';
  obligation.produced_no_update = childCoverageComplete && acceptedCount === 0;
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
    obligation.next_eligible_recovery_action = obligation.child_coverage_manifest.coverage
      ?.unattempted_child_keys?.[0] ?? obligation.child_coverage_manifest.coverage?.pending_child_keys?.[0] ?? null;
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
    obligation.terminal_outcome = Number(obligation.accepted_partial_record_count ?? 0) > 0
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
  obligation.next_eligible_recovery_action = details.next_child_key ?? null;
  return summarizeRecoveryChildManifest(obligation.child_coverage_manifest);
}

export function summarizeProviderAttemptAudit(metadata) {
  const sourceAudit = metadata?.live_memory_health?.provider_attempt_audit;
  const audit = sourceAudit && Number(sourceAudit.schema_version) < PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION
    ? migrateLegacyAudit(typeof structuredClone === 'function'
      ? structuredClone(sourceAudit) : JSON.parse(JSON.stringify(sourceAudit)))
    : sourceAudit;
  if (!audit) return null;
  ensureRecoveryWindows(audit);
  const obligations = Object.values(audit.obligations ?? {});
  const recentAttempts = Array.isArray(audit.recent_attempts) ? audit.recent_attempts : [];
  const malformed = obligations.filter((item) => item.malformed_count > 0);
  const recovered = malformed.filter((item) => ['completed', 'completed_no_candidates', 'completed_repartitioned'].includes(item.terminal_outcome));
  const operationalPauses = obligations.filter((item) => item.terminal_outcome === 'operational_pause');
  const pausedMalformed = operationalPauses.filter((item) => count(item.malformed_count) > 0);
  const unresolved = obligations.filter((item) =>
    !SUCCESSFUL_TERMINAL_OUTCOMES.has(item.terminal_outcome)
    && item.terminal_outcome !== 'operational_pause'
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
  const terminalUnresolvedMalformed = Math.max(0, uniqueMalformed - recoveredMalformed - pausedMalformed.length);
  const failedObligations = obligations.filter((item) => count(item.malformed_count) > 0
    || count(item.provider_failure_count) > 0 || count(item.validation_failure_count) > 0);
  const recoveredFailedObligations = failedObligations.filter((item) => SUCCESSFUL_TERMINAL_OUTCOMES.has(item.terminal_outcome));
  const uniqueFailedObligations = count(archived.ever_failed) + failedObligations.length;
  const recoveredFailedCount = count(archived.recovered_failed) + recoveredFailedObligations.length;
  const pausedFailedCount = operationalPauses.filter((item) => count(item.malformed_count) > 0
    || count(item.provider_failure_count) > 0 || count(item.validation_failure_count) > 0).length;
  const terminalUnresolvedFailedCount = Math.max(0,
    uniqueFailedObligations - recoveredFailedCount - pausedFailedCount);
  const childCoverageManifests = obligations.map((item) => summarizeRecoveryChildManifest(item.child_coverage_manifest))
    .filter(Boolean);
  const malformedPhysicalCount = Object.values(audit.malformed_reason_counts ?? {}).reduce((sum, value) => sum + count(value), 0);
  const providerTransportFailureCount = count(audit.terminal_counts?.provider_failure);
  const validationFailureCount = count(audit.terminal_counts?.validation_failure);
  const physicalFailureObservationCount = malformedPhysicalCount + providerTransportFailureCount + validationFailureCount;
  const unexplainedEquivalentRequests = count(audit.equivalent_retry_count);
  const totalEquivalentRequests = count(audit.equivalent_request_count);
  const permittedEquivalentRequests = count(audit.permitted_equivalent_request_count);
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
    operational_pauses: operationalPauses.map((item) => ({
      root_obligation_id: item.logical_obligation_id,
      tier: item.tier,
      owner: item.owner ?? null,
      reason_code: item.final_disposition ?? 'recovery_request_budget_reached_with_pending_children',
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
    legacy_accounting_migration: audit.schema_v4_migration ?? null,
    failure_accounting: {
      physical_failure_observation_count: physicalFailureObservationCount,
      malformed_response_count: malformedPhysicalCount,
      provider_transport_failure_count: providerTransportFailureCount,
      parser_structural_failure_count: malformedPhysicalCount,
      validation_failure_count: validationFailureCount,
      unique_failed_obligation_count: uniqueFailedObligations,
      recovered_failed_obligation_count: recoveredFailedCount,
      operationally_paused_obligation_count: pausedFailedCount,
      terminal_unresolved_obligation_count: terminalUnresolvedFailedCount,
      local_normalization_notice_count: Object.entries(audit.notice_reason_counts ?? {})
        .filter(([reason]) => reason.startsWith('local_normalization:'))
        .reduce((sum, [, value]) => sum + count(value), 0),
      partial_valid_output_notice_count: count(audit.notice_reason_counts?.partial_valid_output),
      authoritative_scalars: aggregateCountsExact,
      retained_arrays_are_diagnostic_only: true,
    },
    provider_failure_lineage: {
      exact_count: providerTransportFailureCount,
      retained: [...(audit.provider_failure_lineage ?? [])],
      retained_detail_limit: 64,
      details_pruned_or_legacy: providerTransportFailureCount > (audit.provider_failure_lineage ?? []).length,
      limitation: providerTransportFailureCount > (audit.provider_failure_lineage ?? []).length
        ? audit.schema_v5_migration?.limitation ?? 'bounded lineage detail does not replace the exact scalar' : null,
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
      partial_output_rejected_fragments_exact: Number(audit.schema_v4_migration?.source_schema_version ?? 4) >= 4,
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
        accepted_partial_record_count: recoveryWindow?.accepted_partial_record_count ?? 0,
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
        accepted_partial_record_count: count(recoveryWindow?.accepted_partial_record_count),
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
        next_eligible_recovery_action: eligibility.eligible_action
          ?? 'change_provider_configuration_or_install_updated_build',
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
        legacy_single_source_unit_regeneration_successes_meaning:
          'fully_recovered_root_obligations_by_terminal_stage',
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
    malformed_output_amplification_comparison: (() => {
      const migrated = audit.schema_v8_migration ?? null;
      const beforeRequests = count(migrated?.baseline_physical_attempts);
      const beforeMalformed = count(migrated?.baseline_malformed_physical_responses);
      const afterRequests = count(audit.request_counts_by_recovery_implementation?.[RECOVERY_IMPLEMENTATION_VERSION]);
      const afterMalformed = count(audit.malformed_counts_by_recovery_implementation?.[RECOVERY_IMPLEMENTATION_VERSION]);
      return {
        comparison_basis: migrated
          ? 'persisted_pre_v2_baseline_vs_current_recovery_implementation_requests'
          : 'current_recovery_implementation_requests_only',
        current_recovery_implementation_version: RECOVERY_IMPLEMENTATION_VERSION,
        pre_v2: {
          physical_requests: beforeRequests,
          malformed_responses: beforeMalformed,
          malformed_response_rate: beforeRequests ? beforeMalformed / beforeRequests : null,
          extra_requests: migrated ? count(migrated.baseline_extra_requests) : null,
        },
        v2_and_later: {
          physical_requests: afterRequests,
          malformed_responses: afterMalformed,
          malformed_response_rate: afterRequests ? afterMalformed / afterRequests : null,
          single_source_requests: count(audit.recovery_stage_request_counts?.single_source_unit_regeneration),
        },
        limitations: 'rates are cumulative observed provider responses, not a controlled provider A/B test',
      };
    })(),
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
          : 'not_observed_or_legacy_attempts',
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
      equivalent_requests_without_changed_recovery_dimension: unexplainedEquivalentRequests,
      equivalent_request_accounting_consistent: unexplainedEquivalentRequests === 0
        && totalEquivalentRequests === permittedEquivalentRequests,
      physical_failure_observations_not_less_than_unique_failed_obligations:
        physicalFailureObservationCount >= uniqueFailedObligations,
      recovered_plus_unresolved_equals_unique_failed: aggregateCountsExact
        ? recoveredFailedCount + pausedFailedCount + terminalUnresolvedFailedCount === uniqueFailedObligations : null,
      malformed_plus_transport_plus_validation_reconcile_physical_failures:
        malformedPhysicalCount + providerTransportFailureCount + validationFailureCount
          === physicalFailureObservationCount,
      malformed_obligations_reconcile: aggregateCountsExact
        ? uniqueMalformed === recoveredMalformed + pausedMalformed.length + terminalUnresolvedMalformed : null,
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
      authoritative_unresolved_count: terminalUnresolvedMalformed,
      retained_unresolved_detail_count: unresolved.slice(-64).length,
      source_traversal_coverage_scope: 'checkpointed_source_ranges',
      valid_generation_coverage_scope: 'logical_obligations_with_valid_terminal_output',
      consistent: terminalTotal === count(audit.attempted) && count(audit.running_count) === 0
        && unexplainedEquivalentRequests === 0 && totalEquivalentRequests === permittedEquivalentRequests
        && physicalFailureObservationCount >= uniqueFailedObligations
        && (!aggregateCountsExact || recoveredFailedCount + pausedFailedCount
          + terminalUnresolvedFailedCount === uniqueFailedObligations)
        && childCoverageManifests.every((manifest) => manifest.reconciliation.consistent),
      limitation: obligationHistoryTruncated
        ? aggregateCountsExact
          ? 'obligation detail retention is bounded; archived cumulative counters remain authoritative'
          : 'legacy obligation detail retention was bounded before exact archive counters were available'
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
        + obligations.filter((item) => !['running', 'operational_pause', 'completed', 'completed_no_candidates', 'completed_repartitioned'].includes(item.terminal_outcome)).length,
      operationally_paused_obligations: operationalPauses.length,
      source_traversal_and_generation_are_distinct: true,
    },
  };
}
