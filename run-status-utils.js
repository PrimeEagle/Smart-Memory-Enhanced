import { migrateProviderAttemptAuditReport } from './provider-attempt-audit.js';

export const RUN_STATUS_CLASSIFIER_VERSION = 2;

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const array = (value) => Array.isArray(value) ? value : [];
const cleanIntegrity = (status) => ['clean', 'repaired'].includes(String(status ?? '').toLowerCase());

/** Reconciles event-, attempt-, and obligation-scoped failure counts. */
export function deriveRunErrorAccounting(report = {}) {
  const provider = report.provider_attempt_audit ?? {};
  const logical = report.logical_run ?? {};
  const currentDetails = array(report.error_details);
  const notices = array(report.quality?.notices ?? report.quality_notices);
  const providerNoticeCategories = Object.values(provider.notice_reason_counts ?? {})
    .filter((value) => number(value) > 0).length;
  const unresolved = number(provider.terminally_unresolved_malformed_obligations
    ?? provider.coverage?.terminal_failed_obligations
    ?? report.unresolved_error_count);
  const recovered = number(provider.recovered_malformed_obligations ?? report.recovered_error_count);
  const uniqueFailed = number(provider.unique_malformed_obligations) || unresolved + recovered;
  const observedTransportFailures = number(logical.cumulative_request_counters?.provider_failure_count
    ?? report.provider_failure_observation_count
    ?? array(report.provider_failures).length);
  // A genuinely malformed root obligation is itself a historical failure
  // observation even when transport succeeded. Formatting notices are kept in
  // the provider notice counters and never enter uniqueFailed.
  const cumulativeFailureObservations = Math.max(observedTransportFailures, uniqueFailed);
  const fatalRunErrors = Math.max(
    number(report.fatal_run_error_count),
    report.final_persistence_error ? 1 : 0,
    currentDetails.filter((entry) => entry?.fatal === true).length,
  );
  const unresolvedIds = new Set(array(provider.terminal_unresolved_obligations)
    .map((item) => item?.root_obligation_id).filter(Boolean));
  const recoveredIds = new Set(array(provider.recovered_obligation_ids).filter(Boolean));
  const retainedUnresolvedCount = array(provider.terminal_unresolved_obligations).length;
  const unresolvedLimit = number(provider.terminal_unresolved_obligation_detail_limit) || null;
  const detailTruncated = unresolvedLimit !== null && unresolved > retainedUnresolvedCount;
  const providerAggregateCountsExact = provider.obligation_aggregate_counts_exact === true
    || provider.obligation_history_truncated !== true;
  return {
    schema_version: 2,
    current_attempt_error_records: {
      count: currentDetails.length, unit: 'retained_events', scope: 'current_attempt',
      includes_recovered: true, bounded: true, authoritative: false,
    },
    historical_failure_observations: {
      count: cumulativeFailureObservations, unit: 'attempt_level_observations',
      scope: 'cumulative_logical_run_across_attempts', includes_recovered: true,
      bounded: false, authoritative: true,
    },
    malformed_provider_responses: {
      count: number(provider.malformed_physical_responses), unit: 'physical_response_events',
      scope: provider.scope ?? 'provider_attempt_audit', includes_recovered: true,
      bounded: false, authoritative: true,
    },
    unique_obligations_ever_failed: {
      count: uniqueFailed, unit: 'unique_logical_obligations', scope: 'cumulative_provider_audit',
      includes_recovered: true, bounded: false,
      authoritative: providerAggregateCountsExact,
    },
    recovered_obligations: {
      count: recovered, unit: 'unique_logical_obligations', scope: 'cumulative_provider_audit',
      includes_recovered: true, bounded: false, authoritative: true,
    },
    terminal_unresolved_obligations: {
      count: unresolved, unit: 'unique_logical_obligations', scope: 'terminal_current_state',
      includes_recovered: false, bounded: false, authoritative: true,
      retained_detail_count: retainedUnresolvedCount,
      detail_limit: unresolvedLimit,
      detail_truncated: detailTruncated,
    },
    fatal_run_level_errors: {
      count: fatalRunErrors, unit: 'run_level_failures', scope: 'terminal_run_state',
      includes_recovered: false, bounded: false, authoritative: true,
    },
    nonfatal_generation_errors: {
      count: unresolved, unit: 'unique_logical_obligations', scope: 'terminal_current_state',
      includes_recovered: false, bounded: false, authoritative: true,
    },
    quality_notices: {
      count: notices.length + providerNoticeCategories, unit: 'notice_categories', scope: 'final_quality_review_and_provider_output_shape',
      includes_recovered: false, bounded: false, authoritative: true,
    },
    reconciliation: {
      terminal_unresolved_subset_of_failed: unresolved <= uniqueFailed,
      recovered_plus_unresolved_equals_failed: providerAggregateCountsExact
        ? recovered + unresolved === uniqueFailed : null,
      recovered_and_unresolved_do_not_overlap: [...recoveredIds].every((id) => !unresolvedIds.has(id)),
      fatal_not_inferred_from_transient_provider_failures: fatalRunErrors === 0
        || Boolean(report.final_persistence_error || currentDetails.some((entry) => entry?.fatal === true)),
      displayed_unresolved_equals_authoritative_set: unresolved === number(provider.terminally_unresolved_malformed_obligations
        ?? provider.coverage?.terminal_failed_obligations ?? unresolved),
      bounded_detail_does_not_replace_authoritative_count: unresolved >= retainedUnresolvedCount,
      recovered_failures_have_historical_observation: recovered === 0 || cumulativeFailureObservations > 0,
      consistent: unresolved <= uniqueFailed
        && (!providerAggregateCountsExact || recovered + unresolved === uniqueFailed)
        && unresolved >= retainedUnresolvedCount
        && (recovered === 0 || cumulativeFailureObservations > 0),
    },
  };
}

/**
 * Classifies durable run lifecycle independently from result quality. This is
 * pure so UI, persistence, reload, targeted repair, and export cannot diverge.
 */
export function deriveRunStatus(report = {}) {
  const logical = report.logical_run ?? {};
  const recovery = report.catch_up_recovery ?? report.recovery ?? {};
  const accounting = report.error_accounting ?? deriveRunErrorAccounting(report);
  const sourceCount = number(logical.source_window?.message_count
    ?? report.completion_evidence?.source_message_count);
  const committedCount = number(logical.cumulative_committed_count
    ?? report.completion_evidence?.committed_message_count);
  const sourceComplete = logical.full_cumulative_coverage_confirmed === true
    || (logical.all_original_source_messages_covered === true && number(logical.remaining_gap_count) === 0)
    || (sourceCount > 0 && committedCount >= sourceCount && number(logical.remaining_gap_count) === 0);
  const finalizationCommitted = (logical.terminal_status === 'completed'
      && logical.terminal_reason_code === 'finalization_committed')
    || report.completion_evidence?.finalization_committed === true;
  const integrityStatus = report.quality?.final_integrity_status
    ?? report.final_integrity_status
    ?? report.finalReconciliation?.integrity_audit?.status
    ?? null;
  const automaticMissedMutation = report.manual_idempotence?.post_automatic_manual_dependency_trace?.automatic_missed_mutation === true
    || report.developer_idempotence_check?.post_automatic_manual_dependency_trace?.automatic_missed_mutation === true
    || report.finalReconciliation?.final_state_consistency?.automatic_missed_mutation === true;
  const integrityFailure = integrityStatus !== null && !cleanIntegrity(integrityStatus);
  const unresolvedCount = number(accounting.terminal_unresolved_obligations?.count);
  const recoveredCount = number(accounting.recovered_obligations?.count);
  const historicalFailureObservationCount = number(accounting.historical_failure_observations?.count);
  const noticeCount = number(accounting.quality_notices?.count);
  const displayedNoticeCount = noticeCount + (automaticMissedMutation ? 1 : 0);
  const fatalCount = number(accounting.fatal_run_level_errors?.count);
  const legacyStatus = String(report.lifecycle_status ?? report.operational_status ?? report.status ?? '').toLowerCase();
  const statusReasonCodes = [];
  let lifecycleStatus;
  if (sourceComplete && finalizationCommitted && fatalCount === 0) {
    lifecycleStatus = 'completed';
    statusReasonCodes.push('full_source_coverage', 'finalization_committed');
  } else if (recovery.resumable === true || (recovery.available === true && recovery.reason_code !== 'blocked')) {
    lifecycleStatus = 'incomplete';
    statusReasonCodes.push('durable_resume_available');
  } else if (recovery.available === true || legacyStatus === 'blocked') {
    lifecycleStatus = 'blocked';
    statusReasonCodes.push('durable_recovery_blocker');
  } else if (legacyStatus === 'cancelled') {
    lifecycleStatus = 'incomplete';
    statusReasonCodes.push('cancelled_before_completion');
  } else if (legacyStatus === 'not_run') {
    lifecycleStatus = 'not_run';
    statusReasonCodes.push('no_run_evidence');
  } else {
    lifecycleStatus = 'failed';
    statusReasonCodes.push(fatalCount > 0 ? 'fatal_run_error' : 'completion_evidence_missing');
  }

  let outcomeStatus;
  let severity;
  let label;
  let icon;
  if (lifecycleStatus === 'completed') {
    if (unresolvedCount > 0 || integrityFailure) {
      outcomeStatus = 'completed_with_errors'; severity = 'error'; icon = 'circle-exclamation';
      label = unresolvedCount > 0 ? `Completed with ${unresolvedCount} error${unresolvedCount === 1 ? '' : 's'}` : 'Completed with errors';
      if (unresolvedCount > 0) statusReasonCodes.push('terminal_unresolved_obligations');
      if (integrityFailure) statusReasonCodes.push('final_integrity_failure');
    } else if (recoveredCount > 0 || historicalFailureObservationCount > 0) {
      outcomeStatus = 'completed_recovered_errors'; severity = 'warning'; icon = 'triangle-exclamation';
      label = 'Completed — recovered errors'; statusReasonCodes.push('historical_errors_fully_recovered');
    } else if (displayedNoticeCount > 0) {
      outcomeStatus = 'completed_with_notices'; severity = 'warning'; icon = 'circle-info';
      label = 'Completed with notices'; statusReasonCodes.push('safe_quality_notices');
    } else {
      outcomeStatus = 'completed_clean'; severity = 'success'; icon = 'circle-check';
      label = 'Completed'; statusReasonCodes.push('no_terminal_quality_debt');
    }
  } else if (lifecycleStatus === 'incomplete') {
    outcomeStatus = 'incomplete_resumable'; severity = 'warning'; icon = 'circle-pause';
    label = 'Incomplete — resumable';
  } else if (lifecycleStatus === 'blocked') {
    outcomeStatus = 'blocked'; severity = 'error'; icon = 'ban'; label = 'Blocked';
  } else if (lifecycleStatus === 'not_run') {
    outcomeStatus = 'not_run'; severity = 'informational'; icon = 'circle-info'; label = 'Not run';
  } else {
    outcomeStatus = 'failed'; severity = 'error'; icon = 'circle-xmark'; label = 'Failed';
  }
  if (automaticMissedMutation) statusReasonCodes.push('automatic_finalization_missed_mutation');
  return {
    classifier_version: RUN_STATUS_CLASSIFIER_VERSION,
    lifecycle_status: lifecycleStatus,
    outcome_status: outcomeStatus,
    severity,
    label,
    icon,
    unresolved_error_count: unresolvedCount,
    recovered_error_count: recoveredCount,
    historical_failure_observation_count: historicalFailureObservationCount,
    notice_count: displayedNoticeCount,
    attention_required: automaticMissedMutation || unresolvedCount > 0 || integrityFailure,
    recovery_reason_code: recovery.reason_code ?? null,
    status_reason_codes: [...new Set(statusReasonCodes)],
    completion_evidence: {
      source_message_count: sourceCount || null,
      committed_message_count: committedCount,
      source_traversal_complete: sourceComplete,
      remaining_gap_count: number(logical.remaining_gap_count),
      finalization_committed: finalizationCommitted,
      final_integrity_status: integrityStatus,
      automatic_missed_mutation: automaticMissedMutation,
    },
  };
}

/** Privacy-safe run timing and request-volume explanation; never treats manual gaps as provider time. */
export function deriveRunPerformanceDiagnostics(report = {}) {
  const provider = report.provider_attempt_audit ?? {};
  const providerPerformance = provider.performance ?? {};
  const attempts = array(report.logical_run?.attempts);
  const betweenAttemptWaits = [];
  for (let index = 1; index < attempts.length; index++) {
    const previous = attempts[index - 1];
    const previousEnd = number(previous.started_at) + number(previous.duration_ms);
    const nextStart = number(attempts[index].started_at);
    if (previousEnd > 0 && nextStart >= previousEnd) betweenAttemptWaits.push({
      prior_attempt_number: previous.attempt_number ?? index,
      next_attempt_number: attempts[index].attempt_number ?? index + 1,
      wait_ms: nextStart - previousEnd,
      scope: 'between_page_attempts_not_provider_processing',
    });
  }
  const retainedAttempts = array(provider.retained_attempts);
  const retainedProviderMs = retainedAttempts.reduce((sum, item) => sum + number(item.duration_ms), 0);
  const compaction = report.compaction_request_audit ?? {};
  const compactionDistribution = compaction.segment_size_distribution ?? {};
  return {
    schema_version: 1,
    cumulative_attempt_wall_time_ms: number(report.logical_run?.cumulative_attempt_elapsed_ms),
    cumulative_attempt_wall_time_scope: 'sum_of_active_page_attempt_elapsed_time',
    provider_elapsed_time: {
      total_ms: providerPerformance.provider_elapsed_ms_total ?? retainedProviderMs,
      by_operation_type: providerPerformance.provider_elapsed_ms_by_operation_type ?? {},
      by_extraction_category: providerPerformance.provider_elapsed_ms_by_extraction_category ?? {},
      exact_cumulative: providerPerformance.exact_cumulative_timing === true,
      scope: providerPerformance.exact_cumulative_timing === true
        ? 'all_provider_transmissions' : provider.retained_attempt_scope ?? 'retained_provider_attempts_only',
    },
    queue_wait_time: {
      total_ms: providerPerformance.queue_wait_time_ms ?? null,
      available: providerPerformance.queue_wait_time_available === true,
      limitation: providerPerformance.queue_wait_time_limitation
        ?? 'provider adapter does not expose queue admission timestamps',
    },
    request_counts: {
      by_operation_type: provider.request_kind_counts ?? {},
      by_extraction_category: providerPerformance.request_counts_by_extraction_category ?? {},
      physical_provider_requests: number(provider.physical_attempts),
      unique_logical_obligations: number(provider.unique_logical_obligations),
    },
    messages_per_request: {
      source_messages_attempted: providerPerformance.source_messages_attempted ?? null,
      average: providerPerformance.average_source_messages_per_request ?? null,
      exact_cumulative: providerPerformance.exact_cumulative_timing === true,
    },
    segment_size_distribution: {
      longterm_and_session: providerPerformance.segment_size_distribution ?? {},
      shortterm_compaction: compactionDistribution,
      shortterm_distribution_exact: Boolean(compaction.segment_size_distribution),
    },
    request_amplification: {
      ratio: provider.request_amplification ?? null,
      extra_requests_caused_by_recovery: number(provider.extra_requests_caused_by_recovery),
      repartition_requests: number(provider.request_kind_counts?.repartition_child)
        + number(provider.request_kind_counts?.malformed_repartition_child),
      format_repair_requests: number(provider.request_kind_counts?.format_repair),
      same_signature_retries: number(compaction.same_signature_retries),
      shortterm_segment_reductions: number(compaction.segment_reductions),
    },
    failed_or_superseded_request_time: {
      provider_elapsed_ms: providerPerformance.failed_or_superseded_elapsed_ms ?? null,
      exact_cumulative: providerPerformance.exact_cumulative_timing === true,
    },
    between_attempt_wait_time: {
      total_ms: betweenAttemptWaits.reduce((sum, item) => sum + item.wait_ms, 0),
      intervals: betweenAttemptWaits,
      excluded_from_provider_elapsed_time: true,
    },
    longest_requests: {
      provider: providerPerformance.longest_requests ?? [...retainedAttempts]
        .filter((item) => number(item.duration_ms) > 0)
        .sort((a, b) => number(b.duration_ms) - number(a.duration_ms)).slice(0, 16)
        .map((item) => ({ attempt_id: item.attempt_id, tier: item.tier, request_kind: item.request_kind,
          source_range: item.source_range, duration_ms: item.duration_ms, terminal_outcome: item.terminal_outcome })),
      shortterm_compaction: array(compaction.longest_requests).slice(0, 16),
      bounded: true,
      detail_limit_per_category: 16,
    },
    adaptive_shortterm_recovery: {
      growth: compaction.recovery_growth ?? null,
      ladder: compaction.recovery_ladder ?? null,
      observed_segment_sizes: compaction.segment_sizes_attempted ?? [],
      growth_cap_messages: 32,
      growth_cap_scope: 'adaptive_recovery_growth_only_not_normal_compaction_passes',
      retained_segment_cap_decisions: array(compaction.segment_attempt_ledger).map((entry) => ({
        request_id: entry.request_id ?? null,
        message_count: entry.message_count ?? null,
        segment_origin: entry.segment_origin ?? 'legacy_unknown',
        growth_cap_applies: entry.recovery_growth_cap_applies ?? null,
        growth_cap_messages: entry.recovery_growth_cap_messages ?? null,
        growth_decision: entry.recovery_growth_decision ?? null,
      })),
      retained_segment_cap_decisions_bounded: true,
      retained_segment_cap_decision_limit: Number(compaction.segment_attempt_ledger_limit ?? 32),
    },
    overhead_estimates: {
      avoidable: providerPerformance.avoidable_overhead_estimate ?? {
        request_count: number(provider.request_kind_counts?.format_repair),
        definition: 'format-repair requests; retained timing cannot prove avoidability',
      },
      unavoidable: providerPerformance.unavoidable_overhead_estimate ?? {
        request_count: number(provider.request_kind_counts?.repartition_child),
        definition: 'bounded repartition requests required by effective context limits',
      },
      diagnostic_only: true,
    },
  };
}

/** Read-only compatibility normalization for persisted legacy reports. */
export function normalizeRunStatusReport(report = {}) {
  const providerAttemptAudit = migrateProviderAttemptAuditReport(report.provider_attempt_audit);
  const normalizedInput = { ...report, provider_attempt_audit: providerAttemptAudit };
  const errorAccounting = deriveRunErrorAccounting(normalizedInput);
  const runStatus = deriveRunStatus({ ...normalizedInput, error_accounting: errorAccounting });
  return {
    ...normalizedInput,
    status: runStatus.lifecycle_status,
    operational_status: runStatus.lifecycle_status,
    lifecycle_status: runStatus.lifecycle_status,
    outcome_status: runStatus.outcome_status,
    severity: runStatus.severity,
    run_status: runStatus,
    error_accounting: errorAccounting,
    performance_diagnostics: deriveRunPerformanceDiagnostics(normalizedInput),
    quality: report.quality ? {
      ...report.quality,
      status: runStatus.outcome_status,
      completion_quality_status: runStatus.outcome_status,
      operational_status: runStatus.lifecycle_status,
    } : report.quality,
    legacy_status_compatibility: {
      original_status: report.legacy_status_compatibility?.original_status ?? report.status ?? null,
      original_operational_status: report.legacy_status_compatibility?.original_operational_status ?? report.operational_status ?? null,
      original_completion_quality_status: report.legacy_status_compatibility?.original_completion_quality_status
        ?? report.quality?.completion_quality_status ?? null,
      derived_without_destructive_rewrite: true,
    },
  };
}
