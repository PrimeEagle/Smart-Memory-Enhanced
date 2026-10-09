export const SHORTTERM_RECOVERY_SCHEMA_VERSION = 6;
export const SHORTTERM_ATTEMPT_ACCOUNTING_SCHEMA_VERSION = 1;
export const SHORTTERM_RECOVERY_GROWTH_SCHEMA_VERSION = 1;
const SHORTTERM_ATTEMPT_IDENTITY_LIMIT = 8192;

const finiteInteger = (value) => Number.isInteger(Number(value)) ? Math.floor(Number(value)) : null;
const count = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

export function nextShortTermRecoverySegmentSize(currentCount, minimumSegmentFloor = 4) {
  const current = Math.max(1, Math.floor(Number(currentCount) || 1));
  const floor = Math.max(1, Math.floor(Number(minimumSegmentFloor) || 1));
  if (current <= floor) return null;
  // Keep the successor deterministic while ensuring odd ranges retain the
  // midpoint message (169 -> 85, rather than prematurely dropping to 84).
  const next = Math.max(floor, Math.ceil(current / 2));
  return next < current ? next : null;
}

export function advanceShortTermRecoveryLadder(prior = {}, failedSegmentSize, minimumSegmentFloor = 4, evidence = {}) {
  const size = finiteInteger(failedSegmentSize);
  const sourceStart = finiteInteger(evidence.source_start);
  const sourceEnd = finiteInteger(evidence.source_end);
  const dispatched = evidence.dispatched !== false;
  const hasRange = sourceStart !== null && sourceEnd !== null && sourceEnd >= sourceStart;
  if (!dispatched || size === null || size < 1 || (evidence.require_range === true && !hasRange)) {
    return {
      ...prior,
      ignored_predispatch_failures: Number(prior.ignored_predispatch_failures ?? 0) + 1,
      last_ignored_reason: !dispatched ? 'provider_request_not_dispatched'
        : !hasRange && evidence.require_range === true ? 'source_range_missing' : 'segment_size_missing',
      minimum_segment_floor: Math.max(1, Math.floor(Number(minimumSegmentFloor) || 1)),
    };
  }
  const failuresBySize = { ...(prior.failures_by_segment_size ?? {}) };
  failuresBySize[size] = Number(failuresBySize[size] ?? 0) + 1;
  return {
    ...prior,
    total_failures: Number(prior.total_failures ?? 0) + 1,
    failures_by_segment_size: failuresBySize,
    reductions_attempted: [...new Set([...(prior.reductions_attempted ?? []), size])].sort((a, b) => b - a),
    smallest_segment_attempted: Math.min(Number(prior.smallest_segment_attempted ?? size), size),
    any_segment_committed: Boolean(prior.any_segment_committed),
    minimum_segment_floor: Math.max(1, Math.floor(Number(minimumSegmentFloor) || 1)),
    configuration_signature: prior.configuration_signature ?? null,
    last_actual_dispatched_request: hasRange ? {
      source_start: sourceStart, source_end: sourceEnd, message_count: size,
      effective_request_signature: evidence.effective_request_signature ?? null,
      terminal_outcome: evidence.terminal_outcome ?? null,
    } : prior.last_actual_dispatched_request ?? null,
  };
}

export function countShortTermPhysicalAttempts(events = []) {
  const transmissions = new Set();
  for (const event of events) {
    const requestId = event?.request_id ?? null;
    if (!requestId) continue;
    if (event.state === 'in_flight') transmissions.add(`${requestId}:primary`);
    if (event.state === 'provider_diagnostic' && (
      event.predecessor_endpoint_category
      || event.terminal_adaptation === 'same_provider_proxy_nonstream_retry'
      || /fallback/i.test(String(event.endpoint_category ?? ''))
    )) transmissions.add(`${requestId}:fallback`);
  }
  return {
    physical_provider_attempts: transmissions.size,
    provider_attempt_ids: [...transmissions],
  };
}

const emptyTerminalCounts = () => ({
  completed: 0,
  failed: 0,
  cancelled: 0,
  interrupted: 0,
  fallback_replaced: 0,
});

/**
 * Creates durable Short-Term provider accounting. Scalar totals are the
 * authority; bounded event lists elsewhere are only diagnostic samples.
 * Legacy retained-event counts are carried as an explicitly inexact lower
 * bound instead of being presented as a cumulative total.
 */
export function createShortTermAttemptAccounting({ prior = null, runId = null,
  attemptNumber = null, legacyPhysicalAttempts = 0 } = {}) {
  const compatible = Number(prior?.schema_version) === SHORTTERM_ATTEMPT_ACCOUNTING_SCHEMA_VERSION;
  const priorTotal = compatible ? count(prior.cumulative_physical_transmissions) : 0;
  const legacyLowerBound = compatible
    ? count(prior.legacy_cumulative_lower_bound)
    : Math.max(0, count(legacyPhysicalAttempts));
  const restoredInterrupted = compatible ? Object.keys(prior?.active_attempts ?? {}).length : 0;
  const cumulativeTerminal = compatible
    ? { ...emptyTerminalCounts(), ...(prior.cumulative_terminal_counts ?? prior.terminal_counts ?? {}) }
    : emptyTerminalCounts();
  cumulativeTerminal.interrupted = count(cumulativeTerminal.interrupted) + restoredInterrupted;
  return {
    schema_version: SHORTTERM_ATTEMPT_ACCOUNTING_SCHEMA_VERSION,
    run_id: runId ?? prior?.run_id ?? null,
    attempt_number: attemptNumber,
    cumulative_physical_transmissions: priorTotal,
    restored_prior_physical_transmissions: priorTotal,
    current_attempt_physical_transmissions: 0,
    current_attempt_terminal_transmissions: 0,
    terminal_counts: emptyTerminalCounts(),
    cumulative_terminal_counts: cumulativeTerminal,
    restored_interrupted_transmissions: restoredInterrupted,
    by_segment_size: {},
    cumulative_by_segment_size: compatible ? { ...(prior.cumulative_by_segment_size ?? prior.by_segment_size ?? {}) } : {},
    retry_transmissions: 0,
    fallback_transmissions: 0,
    format_repair_transmissions: 0,
    active_attempts: {},
    counted_attempt_ids: [],
    terminal_attempt_ids: [],
    recent_attempt_ids: [],
    attempt_identity_limit: SHORTTERM_ATTEMPT_IDENTITY_LIMIT,
    totals_exact: compatible ? prior.totals_exact !== false : legacyLowerBound === 0,
    legacy_cumulative_lower_bound: legacyLowerBound,
    legacy_limitation: !compatible && legacyLowerBound > 0
      ? 'prior_build_retained_only_a_bounded_attempt_sample' : null,
  };
}

function terminalizeShortTermAttempt(next, attemptId, outcome) {
  if (!attemptId || next.terminal_attempt_ids.includes(attemptId)) return;
  if (next.terminal_attempt_ids.length >= SHORTTERM_ATTEMPT_IDENTITY_LIMIT) {
    next.totals_exact = false;
    next.legacy_limitation ??= 'attempt_identity_limit_exceeded';
    return;
  }
  next.terminal_attempt_ids.push(attemptId);
  next.current_attempt_terminal_transmissions++;
  next.terminal_counts[outcome] = count(next.terminal_counts[outcome]) + 1;
  next.cumulative_terminal_counts[outcome] = count(next.cumulative_terminal_counts[outcome]) + 1;
  delete next.active_attempts[attemptId];
}

/** Records one lifecycle event without consulting or mutating retained detail. */
export function recordShortTermAttemptEvent(accounting, event = {}) {
  const next = {
    ...accounting,
    terminal_counts: { ...emptyTerminalCounts(), ...(accounting?.terminal_counts ?? {}) },
    cumulative_terminal_counts: { ...emptyTerminalCounts(), ...(accounting?.cumulative_terminal_counts ?? {}) },
    by_segment_size: { ...(accounting?.by_segment_size ?? {}) },
    cumulative_by_segment_size: { ...(accounting?.cumulative_by_segment_size ?? {}) },
    active_attempts: { ...(accounting?.active_attempts ?? {}) },
    counted_attempt_ids: [...(accounting?.counted_attempt_ids ?? [])],
    terminal_attempt_ids: [...(accounting?.terminal_attempt_ids ?? [])],
    recent_attempt_ids: [...(accounting?.recent_attempt_ids ?? [])],
  };
  const requestId = event.request_id ? String(event.request_id) : null;
  if (!requestId) return next;
  const fallbackEvent = event.state === 'provider_diagnostic' && (
    event.predecessor_endpoint_category
    || event.terminal_adaptation === 'same_provider_proxy_nonstream_retry'
    || /fallback/i.test(String(event.endpoint_category ?? ''))
  );
  const attemptId = `${requestId}:${fallbackEvent ? 'fallback' : 'primary'}`;
  if (event.state === 'in_flight' || fallbackEvent) {
    if (!next.counted_attempt_ids.includes(attemptId)) {
      if (next.counted_attempt_ids.length >= SHORTTERM_ATTEMPT_IDENTITY_LIMIT) {
        next.totals_exact = false;
        next.legacy_limitation ??= 'attempt_identity_limit_exceeded';
      } else {
        next.counted_attempt_ids.push(attemptId);
        next.recent_attempt_ids = [...next.recent_attempt_ids, attemptId].slice(-64);
        next.current_attempt_physical_transmissions++;
        next.cumulative_physical_transmissions++;
        const size = finiteInteger(event.prompt_visible_message_count);
        if (size !== null) {
          next.by_segment_size[size] = count(next.by_segment_size[size]) + 1;
          next.cumulative_by_segment_size[size] = count(next.cumulative_by_segment_size[size]) + 1;
        }
        if (Number(event.attempt ?? 1) > 1) next.retry_transmissions++;
        if (fallbackEvent) next.fallback_transmissions++;
        if (event.request_kind === 'format_repair') next.format_repair_transmissions++;
        next.active_attempts[attemptId] = { request_id: requestId, segment_size: size };
      }
    }
    if (fallbackEvent) terminalizeShortTermAttempt(next, `${requestId}:primary`, 'fallback_replaced');
    return next;
  }
  if (event.state === 'response_observed' || event.state === 'request_error') {
    const activeId = next.active_attempts[`${requestId}:fallback`]
      ? `${requestId}:fallback` : `${requestId}:primary`;
    const outcome = event.state === 'request_error' || event.response_present === false ? 'failed' : 'completed';
    terminalizeShortTermAttempt(next, activeId, outcome);
  }
  return next;
}

/** Closes transmissions that were active when a page/process stopped. */
export function finalizeShortTermAttemptAccounting(accounting, outcome = 'interrupted') {
  const next = recordShortTermAttemptEvent(accounting, {});
  for (const attemptId of Object.keys(next.active_attempts)) terminalizeShortTermAttempt(next, attemptId, outcome);
  return next;
}

/** Export-safe accounting view; identity ledgers stay checkpoint-internal. */
export function summarizeShortTermAttemptAccounting(accounting, { successfulSegmentCommits = 0 } = {}) {
  const terminalCounts = { ...emptyTerminalCounts(), ...(accounting?.terminal_counts ?? {}) };
  const cumulativeTerminalCounts = { ...emptyTerminalCounts(), ...(accounting?.cumulative_terminal_counts ?? {}) };
  const terminalTotal = Object.values(terminalCounts).reduce((sum, value) => sum + count(value), 0);
  const cumulativeTerminalTotal = Object.values(cumulativeTerminalCounts).reduce((sum, value) => sum + count(value), 0);
  const currentPhysical = count(accounting?.current_attempt_physical_transmissions);
  const cumulativePhysical = count(accounting?.cumulative_physical_transmissions);
  const active = Object.keys(accounting?.active_attempts ?? {}).length;
  const completed = count(terminalCounts.completed);
  return {
    schema_version: SHORTTERM_ATTEMPT_ACCOUNTING_SCHEMA_VERSION,
    run_id: accounting?.run_id ?? null,
    attempt_number: accounting?.attempt_number ?? null,
    current_attempt_physical_transmissions: currentPhysical,
    restored_prior_physical_transmissions: count(accounting?.restored_prior_physical_transmissions),
    cumulative_physical_transmissions: cumulativePhysical,
    current_attempt_terminal_transmissions: terminalTotal,
    cumulative_terminal_transmissions: cumulativeTerminalTotal,
    current_attempt_active_transmissions: active,
    terminal_counts: terminalCounts,
    cumulative_terminal_counts: cumulativeTerminalCounts,
    by_segment_size: { ...(accounting?.by_segment_size ?? {}) },
    cumulative_by_segment_size: { ...(accounting?.cumulative_by_segment_size ?? {}) },
    retry_transmissions: count(accounting?.retry_transmissions),
    fallback_transmissions: count(accounting?.fallback_transmissions),
    format_repair_transmissions: count(accounting?.format_repair_transmissions),
    totals_exact: accounting?.totals_exact !== false,
    legacy_cumulative_lower_bound: count(accounting?.legacy_cumulative_lower_bound),
    legacy_limitation: accounting?.legacy_limitation ?? null,
    retained_attempt_id_count: (accounting?.recent_attempt_ids ?? []).length,
    retained_attempt_id_limit: 64,
    recent_attempt_ids: [...(accounting?.recent_attempt_ids ?? [])].slice(-64),
    reconciliation: {
      current_terminal_plus_active_equals_physical: terminalTotal + active === currentPhysical,
      cumulative_terminal_equals_physical: accounting?.totals_exact === false
        ? null : cumulativeTerminalTotal === cumulativePhysical,
      successful_commits_do_not_exceed_completed_transmissions:
        Number(successfulSegmentCommits) <= completed,
      successful_segment_commits: Number(successfulSegmentCommits) || 0,
      completed_transmissions: completed,
    },
  };
}

/**
 * Conservative upward recovery after a reduced segment size has demonstrated
 * stability. A proposal is never larger than 1.5x, 32 messages, or the proven
 * context headroom. Missing budget/configuration evidence freezes the size.
 */
export function advanceShortTermRecoveryGrowth(prior = {}, {
  successfulSegmentSize = null, estimatedInputTokens = null,
  requestedOutputTokens = null, effectiveContextLimit = null,
  safetyAndProtocolTokens = 1256, configurationSignature = null,
  requiredSuccesses = 4, maximumSegmentSize = 32,
} = {}) {
  const size = finiteInteger(successfulSegmentSize);
  const previousSize = finiteInteger(prior.current_segment_size) ?? size;
  const sameConfiguration = !prior.configuration_signature || !configurationSignature
    || prior.configuration_signature === configurationSignature;
  const consecutive = sameConfiguration && size !== null && previousSize === size
    ? count(prior.consecutive_successes) + 1 : 1;
  const base = {
    schema_version: SHORTTERM_RECOVERY_GROWTH_SCHEMA_VERSION,
    current_segment_size: size,
    last_known_safe_size: Math.max(count(prior.last_known_safe_size), size ?? 0) || null,
    consecutive_successes: consecutive,
    required_successes: requiredSuccesses,
    maximum_segment_size: maximumSegmentSize,
    configuration_signature: configurationSignature,
    decision: 'hold', proposed_segment_size: size,
  };
  const numericEvidence = [size, estimatedInputTokens, requestedOutputTokens, effectiveContextLimit]
    .every((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  if (!sameConfiguration) return { ...base, decision: 'hold_configuration_changed', consecutive_successes: 1 };
  if (!numericEvidence) return { ...base, decision: 'hold_missing_context_evidence' };
  if (consecutive < requiredSuccesses) return { ...base, decision: 'hold_collecting_success_evidence' };
  const proposed = Math.min(maximumSegmentSize, Math.max(size + 1, Math.ceil(size * 1.5)));
  const projectedInput = Math.ceil(Number(estimatedInputTokens) * (proposed / size));
  const projectedTotal = projectedInput + Number(requestedOutputTokens) + Number(safetyAndProtocolTokens);
  if (proposed <= size) return { ...base, decision: 'hold_at_growth_cap', consecutive_successes: 0 };
  if (projectedTotal > Number(effectiveContextLimit)) return {
    ...base, decision: 'hold_context_headroom_insufficient', projected_input_tokens: projectedInput,
    projected_total_tokens: projectedTotal,
  };
  return {
    ...base, decision: 'grow_after_stable_successes', consecutive_successes: 0,
    proposed_segment_size: proposed, projected_input_tokens: projectedInput,
    projected_total_tokens: projectedTotal,
  };
}

export function isShortTermMinimumFloorExhausted({ dispatched = false, failedBeforeCommit = false,
  segmentSize = null, minimumSegmentFloor = 4, sourceStart = null, sourceEnd = null,
  committedBoundary = null, configurationSignature = null, currentConfigurationSignature = null,
  alternateRecoveryAvailable = false } = {}) {
  const size = finiteInteger(segmentSize);
  const floor = Math.max(1, finiteInteger(minimumSegmentFloor) ?? 4);
  const start = finiteInteger(sourceStart);
  const end = finiteInteger(sourceEnd);
  const boundary = finiteInteger(committedBoundary);
  const pending = start !== null && end !== null && boundary !== null && end >= boundary;
  const configurationMatches = !configurationSignature || !currentConfigurationSignature
    || configurationSignature === currentConfigurationSignature;
  return Boolean(dispatched && failedBeforeCommit && size !== null && size <= floor
    && pending && configurationMatches && !alternateRecoveryAvailable);
}

export function migrateCommittedShortTermFailureState(failureState = {}, {
  committedBoundary = null, committedPlan = null, committedSummaryHash = null, migratedAt = Date.now(),
} = {}) {
  const boundary = finiteInteger(committedBoundary);
  const start = finiteInteger(committedPlan?.next_segment_start);
  const end = finiteInteger(committedPlan?.next_segment_end);
  const size = finiteInteger(committedPlan?.message_count);
  const safelyCommitted = boundary !== null && start !== null && end !== null
    && end < boundary && size !== null && committedSummaryHash;
  if (!safelyCommitted) return { failure_state: failureState, migrated: false, removed_failure_size: null };
  const ladder = { ...(failureState?.recovery_ladder ?? {}) };
  const failures = { ...(ladder.failures_by_segment_size ?? {}) };
  if (!Number(failures[size] ?? 0)) return { failure_state: failureState, migrated: false, removed_failure_size: null };
  const last = failureState?.last_failed_request ?? ladder.last_actual_dispatched_request ?? null;
  const sameRange = finiteInteger(last?.source_start) === start && finiteInteger(last?.source_end) === end;
  if (!sameRange) return { failure_state: failureState, migrated: false, removed_failure_size: null };
  failures[size] = Math.max(0, Number(failures[size]) - 1);
  if (failures[size] === 0) delete failures[size];
  ladder.failures_by_segment_size = failures;
  ladder.total_failures = Math.max(0, Number(ladder.total_failures ?? 0) - 1);
  ladder.reductions_attempted = (ladder.reductions_attempted ?? []).filter((value) => Number(value) !== size || Number(failures[size] ?? 0) > 0);
  ladder.smallest_segment_attempted = Object.keys(failures).length
    ? Math.min(...Object.keys(failures).map(Number)) : null;
  if (sameRange) delete ladder.last_actual_dispatched_request;
  return {
    migrated: true,
    removed_failure_size: size,
    failure_state: {
      ...failureState,
      failure_signature: null,
      last_failed_request: null,
      operator_action_required: false,
      adaptation: 'committed_segment_failure_reclassified',
      next_resume_strategy: 'reconstruct_successor_from_committed_boundary',
      recovery_ladder: ladder,
      committed_failure_migration: {
        source_start: start, source_end: end, message_count: size,
        committed_boundary: boundary, committed_summary_hash: committedSummaryHash,
        migrated_at: migratedAt,
      },
    },
  };
}

/**
 * Proves the legacy state where a committed compaction pass survived, but the
 * active recovery plan and its post-commit marker were cleared. This is a
 * read-only derivation: callers may safely use it while rendering the panel.
 */
export function deriveMissingPlanCommittedCheckpoint({ activePlan = null, postCommitMarker = null,
  compactionCheckpoint = null, summaryEnd = null, currentSummaryHash = null,
  currentSourceFingerprint = null, failureState = null, logicalRunId = null,
  phase = 'shortterm_extraction', configurationSignature = null,
  promptShapeVersion = null, minimumSegmentFloor = 4, migratedAt = null } = {}) {
  const conflicts = [];
  const compare = (field, persisted, current, reason) => {
    if (persisted !== current) conflicts.push({ field, persisted: persisted ?? null, current: current ?? null, reason });
  };
  if (activePlan) conflicts.push({ field: 'shortterm_recovery_plan', persisted: 'present', current: 'absent', reason: 'newer_active_plan_present' });
  if (postCommitMarker) conflicts.push({ field: 'shortterm_post_commit_recovery_marker', persisted: 'present', current: 'absent', reason: 'post_commit_marker_already_present' });
  if (!compactionCheckpoint) conflicts.push({ field: 'shortterm_compaction_checkpoint', persisted: null, current: 'committed checkpoint', reason: 'committed_checkpoint_missing' });

  const boundary = finiteInteger(summaryEnd);
  const checkpointBoundary = finiteInteger(compactionCheckpoint?.summary_end);
  const sourceEnd = finiteInteger(compactionCheckpoint?.source_end);
  const tailStart = finiteInteger(compactionCheckpoint?.pending_tail_start);
  const tailEnd = finiteInteger(compactionCheckpoint?.pending_tail_end);
  const failure = failureState?.last_failed_request ?? failureState?.recovery_ladder?.last_actual_dispatched_request ?? null;
  const failureStart = finiteInteger(failure?.source_start);
  const failureEnd = finiteInteger(failure?.source_end);
  const failureSize = finiteInteger(failure?.message_count)
    ?? (failureStart !== null && failureEnd !== null ? failureEnd - failureStart + 1 : null);

  if (compactionCheckpoint?.commit_status !== 'committed') {
    conflicts.push({ field: 'commit_status', persisted: compactionCheckpoint?.commit_status ?? null, current: 'committed', reason: 'checkpoint_not_committed' });
  }
  if (!currentSummaryHash || !compactionCheckpoint?.summary_hash) {
    conflicts.push({ field: 'summary_hash', persisted: compactionCheckpoint?.summary_hash ?? null,
      current: currentSummaryHash ?? null, reason: 'summary_hash_missing' });
  }
  compare('summary_end', checkpointBoundary, boundary, 'summary_boundary_mismatch');
  compare('summary_hash', compactionCheckpoint?.summary_hash ?? null, currentSummaryHash ?? null, 'summary_hash_mismatch');
  if (!currentSourceFingerprint || !compactionCheckpoint?.source_fingerprint) {
    conflicts.push({ field: 'source_fingerprint', persisted: compactionCheckpoint?.source_fingerprint ?? null,
      current: currentSourceFingerprint ?? null, reason: 'source_fingerprint_missing' });
  }
  compare('source_fingerprint', compactionCheckpoint?.source_fingerprint ?? null, currentSourceFingerprint ?? null, 'source_fingerprint_mismatch');
  if (sourceEnd === null || boundary === null || sourceEnd >= boundary || sourceEnd + 1 !== boundary) {
    conflicts.push({ field: 'source_end', persisted: sourceEnd, current: boundary === null ? null : boundary - 1, reason: 'committed_source_boundary_mismatch' });
  }
  compare('pending_tail_start', tailStart, boundary, 'pending_tail_boundary_mismatch');
  if (tailEnd === null || boundary === null || tailEnd < boundary) {
    conflicts.push({ field: 'pending_tail_end', persisted: tailEnd, current: boundary, reason: 'remaining_tail_missing' });
  }
  if (failureStart === null || failureEnd === null || failureEnd < failureStart || sourceEnd === null || failureEnd > sourceEnd) {
    conflicts.push({ field: 'last_failed_request', persisted: failure ?? null,
      current: sourceEnd === null ? null : { source_end_at_or_before: sourceEnd }, reason: 'stale_failure_range_mismatch' });
  }
  const evidenceRun = failure?.logical_run_id ?? failureState?.logical_run_id ?? compactionCheckpoint?.logical_run_id ?? null;
  if (evidenceRun != null && logicalRunId != null && evidenceRun !== logicalRunId) {
    conflicts.push({ field: 'logical_run_id', persisted: evidenceRun, current: logicalRunId, reason: 'logical_run_mismatch' });
  }
  const evidencePhase = failure?.phase ?? failureState?.phase ?? compactionCheckpoint?.phase ?? null;
  if (evidencePhase != null && evidencePhase !== phase) {
    conflicts.push({ field: 'phase', persisted: evidencePhase, current: phase, reason: 'phase_mismatch' });
  }

  const proven = conflicts.length === 0;
  if (!proven) return { proven: false, eligible: false, reason: conflicts[0]?.reason ?? 'committed_checkpoint_unproven', conflicts };
  const markerId = `missing-plan:${logicalRunId ?? 'legacy'}:${boundary}:${currentSummaryHash}`;
  const committedPlan = {
    schema_version: SHORTTERM_RECOVERY_SCHEMA_VERSION,
    plan_id: failure?.plan_id ?? failure?.effective_request_signature ?? markerId,
    effective_request_signature: failure?.effective_request_signature ?? failureState?.effective_request_signature ?? null,
    logical_run_id: logicalRunId,
    phase,
    next_segment_start: failureStart,
    next_segment_end: failureEnd,
    message_count: failureSize,
    target_message_count: failureSize,
    source_fingerprint: failure?.source_fingerprint ?? null,
    summary_parent_hash: failure?.parent_summary_hash ?? compactionCheckpoint?.parent_summary_hash ?? null,
    configuration_signature: failureState?.configuration_signature ?? configurationSignature,
    prompt_shape_version: promptShapeVersion,
    lifecycle_state: 'consumed_successfully', terminal_state: 'committed',
    provider_terminal_outcome: 'completed', segment_terminal_outcome: 'committed',
    committed_boundary: boundary, committed_summary_hash: currentSummaryHash,
    successor_start: boundary, successor_parent_hash: currentSummaryHash,
    migrated_from_missing_active_plan: true, migrated_at: migratedAt,
  };
  return {
    proven: true, eligible: true,
    decision: 'reconstruct_successor_from_committed_boundary',
    reason: 'committed_progress_without_active_successor', conflicts: [],
    evidence_source: 'durable_shortterm_compaction_checkpoint_and_failure_state',
    committed_boundary: boundary, committed_summary_hash: currentSummaryHash,
    successor_start: boundary, successor_parent_hash: currentSummaryHash,
    committed_predecessor_range: { start: failureStart, end: failureEnd },
    false_failure_size: failureSize, remaining_tail_end: tailEnd,
    marker_id: markerId, committed_plan: committedPlan,
    post_commit_marker: {
      schema_version: 2, marker_id: markerId,
      predecessor_plan_id: committedPlan.plan_id,
      predecessor_terminal_state: 'committed',
      predecessor_source_range: { start: failureStart, end: failureEnd },
      committed_boundary: boundary, committed_summary_hash: currentSummaryHash,
      remaining_tail_end: tailEnd,
      configuration_signature: failureState?.configuration_signature ?? configurationSignature,
      prompt_shape_version: promptShapeVersion,
      recovery_strategy: 'smaller_segment_rebuild',
      minimum_segment_floor: Math.max(1, finiteInteger(minimumSegmentFloor) ?? 4),
      successor_state: 'reconstruction_required',
      migration_provenance: 'legacy_missing_plan_committed_checkpoint',
      evidence_source: 'durable_shortterm_compaction_checkpoint_and_failure_state',
      created_at: migratedAt,
    },
  };
}

/** Authoritative no-plan path used by the recovery panel and Resume preflight. */
export function deriveShortTermMissingPlanResumeEligibility({ checkpointStatus = null,
  phaseDisposition = null, postCommitMarker = null, compactionCheckpoint = null,
  summaryEnd = null, currentSummaryHash = null, currentSourceFingerprint = null,
  failureState = null, logicalRunId = null, phase = 'shortterm_extraction',
  configurationSignature = null, promptShapeVersion = null, minimumSegmentFloor = 4 } = {}) {
  if (!postCommitMarker && compactionCheckpoint) {
    const proof = deriveMissingPlanCommittedCheckpoint({
      activePlan: null, postCommitMarker: null, compactionCheckpoint, summaryEnd,
      currentSummaryHash, currentSourceFingerprint, failureState, logicalRunId,
      phase, configurationSignature, promptShapeVersion, minimumSegmentFloor,
    });
    if (proof.proven) return {
      eligible: true, decision: proof.decision, reason: proof.reason,
      inferred_post_commit_state: true, evidence_source: proof.evidence_source,
      committed_boundary: proof.committed_boundary, conflicts: [],
    };
    return { eligible: false, decision: 'committed_checkpoint_revalidation_required',
      reason: proof.reason, conflicts: proof.conflicts };
  }
  return deriveShortTermResumeEligibility({ checkpointStatus, phaseDisposition,
    plan: null, validation: null, failureState, postCommitMarker });
}

export function deriveShortTermResumePresentation(eligibility = {}, running = false) {
  const blocked = !eligibility?.eligible;
  const reconstructing = eligibility?.decision === 'reconstruct_successor_from_committed_boundary';
  return {
    disabled: Boolean(running || blocked),
    label: running ? 'Resumed Automatically' : blocked ? 'Short-Term Recovery Blocked'
      : reconstructing ? 'Resume From Safe Boundary' : 'Resume Incomplete Run',
    mode: running ? 'running' : blocked ? 'blocked' : reconstructing ? 'safe_boundary' : 'ordinary',
  };
}

export function migrateMissingPlanCommittedCheckpoint(input = {}) {
  const proof = deriveMissingPlanCommittedCheckpoint(input);
  if (!proof.proven) return { applied: false, proof, reason: proof.reason, conflicts: proof.conflicts };
  const migratedFailure = migrateCommittedShortTermFailureState(input.failureState ?? {}, {
    committedBoundary: proof.committed_boundary,
    committedPlan: proof.committed_plan,
    committedSummaryHash: proof.committed_summary_hash,
    migratedAt: input.migratedAt,
  });
  if (!migratedFailure.migrated && input.failureState?.operator_action_required) {
    const conflict = { field: 'recovery_ladder', persisted: input.failureState?.recovery_ladder ?? null,
      current: { removable_failure_size: proof.false_failure_size }, reason: 'committed_failure_cleanup_unproven' };
    return { applied: false, proof, reason: conflict.reason, conflicts: [conflict] };
  }
  return {
    applied: true, proof,
    failure_state: migratedFailure.failure_state,
    post_commit_marker: { ...proof.post_commit_marker,
      migrated_false_failed_ladder_entry: migratedFailure.migrated },
    removed_failure_size: migratedFailure.removed_failure_size,
  };
}

export function shortTermRecoveryPlanRepeatsFailure(plan, failure) {
  if (!plan || !failure) return false;
  const last = failure.last_failed_request ?? failure;
  if (last.dispatched === false || !Number.isInteger(Number(last.source_start))
    || !Number.isInteger(Number(last.source_end))) return false;
  return Boolean(plan.effective_request_signature
    && (last.effective_request_signature ?? failure.failure_signature)
    && plan.effective_request_signature === (last.effective_request_signature ?? failure.failure_signature));
}

export function validateShortTermRecoveryPlan(plan, current = {}) {
  if (!plan) return { valid: false, reason: 'recovery_plan_missing', conflicts: [] };
  const conflicts = [];
  const compare = (field, actual, expected, reason) => {
    if (expected !== undefined && expected !== null && actual !== expected) conflicts.push({ field, persisted: actual ?? null, current: expected, reason });
  };
  compare('logical_run_id', plan.logical_run_id, current.logical_run_id, 'logical_run_mismatch');
  compare('phase', plan.phase, current.phase ?? 'shortterm_extraction', 'phase_mismatch');
  compare('source_fingerprint', plan.source_fingerprint, current.source_fingerprint, 'source_fingerprint_mismatch');
  compare('next_segment_start', finiteInteger(plan.next_segment_start), finiteInteger(current.source_start), 'source_range_mismatch');
  compare('next_segment_end', finiteInteger(plan.next_segment_end), finiteInteger(current.source_end), 'source_range_mismatch');
  compare('summary_parent_hash', plan.summary_parent_hash, current.parent_summary_hash, 'parent_summary_mismatch');
  compare('prompt_shape_version', plan.prompt_shape_version, current.prompt_shape_version, 'prompt_shape_version_mismatch');
  compare('effective_request_signature', plan.effective_request_signature, current.effective_request_signature, 'effective_request_signature_mismatch');
  if (plan.configuration_signature != null) compare('configuration_signature', plan.configuration_signature, current.configuration_signature, 'configuration_changed');
  const floor = Math.max(1, finiteInteger(current.minimum_segment_floor ?? plan.minimum_segment_floor) ?? 4);
  const messageCount = finiteInteger(plan.message_count);
  if (messageCount === null || messageCount < floor) conflicts.push({ field: 'message_count', persisted: messageCount, current: floor, reason: 'minimum_floor_violation' });
  if (finiteInteger(plan.schema_version) < 3) conflicts.push({ field: 'schema_version', persisted: plan.schema_version ?? null, current: SHORTTERM_RECOVERY_SCHEMA_VERSION, reason: 'unsupported_legacy_recovery_schema' });
  return {
    valid: conflicts.length === 0,
    reason: conflicts[0]?.reason ?? 'validated_against_current_state',
    conflicts,
    minimum_segment_floor: floor,
    legacy_configuration_signature_missing: plan.configuration_signature == null,
  };
}

export function reconcileShortTermRecoveryState({ plan = null, validation = null, failureState = null,
  currentAttempt = {}, cumulative = {}, minimumSegmentFloor = 4 } = {}) {
  const retained = currentAttempt.retained_events ?? [];
  const dispatched = retained.filter((event) => event?.state === 'in_flight'
    && Number.isInteger(Number(event.requested_source_start)) && Number.isInteger(Number(event.requested_source_end)));
  const outcomes = retained.filter((event) => ['response_observed', 'request_error'].includes(event?.state)
    && Number.isInteger(Number(event.requested_source_start)) && Number.isInteger(Number(event.requested_source_end)));
  const historicalLadder = failureState?.recovery_ladder ?? {};
  const staleBelowFloor = Object.keys(historicalLadder.failures_by_segment_size ?? {}).map(Number)
    .filter((size) => Number.isFinite(size) && size < minimumSegmentFloor && !historicalLadder.last_actual_dispatched_request);
  const planValid = Boolean(plan && validation?.valid);
  const consumed = Boolean(retained.some((event) => event?.consumed_recovery_plan?.effective_request_signature === plan?.effective_request_signature));
  const blockingInvariant = planValid ? null : validation?.reason ?? 'recovery_plan_missing';
  const accounting = currentAttempt.attempt_accounting ?? null;
  const currentPhysical = Number(accounting?.current_attempt_physical_transmissions
    ?? currentAttempt.physical_provider_attempts ?? 0);
  const cumulativePhysical = accounting
    ? Number(accounting.cumulative_physical_transmissions ?? currentPhysical)
    : Number(cumulative.physical_provider_attempts ?? 0) + currentPhysical;
  return {
    schema_version: SHORTTERM_RECOVERY_SCHEMA_VERSION,
    cumulative_physical_attempts: cumulativePhysical,
    current_attempt_physical_attempts: currentPhysical,
    cumulative_physical_attempts_exact: accounting ? accounting.totals_exact !== false : null,
    legacy_cumulative_lower_bound: accounting?.legacy_cumulative_lower_bound ?? null,
    cumulative_segment_sizes_attempted: [...new Set([...(cumulative.segment_sizes_attempted ?? []),
      ...Object.keys(historicalLadder.failures_by_segment_size ?? {}).map(Number).filter(Number.isFinite),
      ...(currentAttempt.segment_sizes_attempted ?? [])])].sort((a, b) => b - a),
    current_attempt_segment_sizes_attempted: [...(currentAttempt.segment_sizes_attempted ?? [])],
    last_actual_dispatched_request: dispatched.at(-1) ?? historicalLadder.last_actual_dispatched_request ?? null,
    last_actual_provider_outcome: outcomes.at(-1) ?? null,
    verified_next_plan: planValid ? plan : null,
    plan_consumed: consumed,
    blocking_invariant: blockingInvariant,
    state_conflicts: validation?.conflicts ?? [],
    quarantined_synthetic_ladder_sizes: staleBelowFloor,
    minimum_segment_floor: minimumSegmentFloor,
    floor_policy_decision: planValid ? 'verified_plan_above_floor_is_authoritative'
      : staleBelowFloor.length ? 'synthetic_below_floor_history_ignored' : 'apply_to_actual_dispatched_requests_only',
    next_legal_action: planValid ? (consumed ? 'continue_segmented_rebuild' : 'dispatch_verified_plan')
      : blockingInvariant === 'configuration_changed' ? 'change_back_configuration_or_rebuild_plan' : 'repair_or_revalidate_plan',
  };
}

export function deriveShortTermResumeEligibility({ checkpointStatus = null, phaseDisposition = null,
  plan = null, validation = null, failureState = null, postCommitMarker = null } = {}) {
  if (!['in_progress', 'awaiting_manual_resume'].includes(checkpointStatus)) return { eligible: false, decision: 'terminal_non_resumable', reason: 'checkpoint_not_resumable' };
  if (plan && validation?.valid) return { eligible: true, decision: 'ordinary_resume_safe', reason: 'verified_recovery_plan_available' };
  if (!plan && postCommitMarker?.committed_boundary != null && postCommitMarker?.committed_summary_hash) {
    return { eligible: true, decision: 'reconstruct_successor_from_committed_boundary', reason: 'committed_progress_without_active_successor' };
  }
  if (plan && validation && !validation.valid) return { eligible: false, decision: 'plan_revalidation_required', reason: validation.reason, conflicts: validation.conflicts ?? [] };
  if (failureState?.operator_action_required) return { eligible: false, decision: 'configuration_or_provider_change_required', reason: failureState.adaptation ?? 'recovery_ladder_exhausted' };
  if (phaseDisposition?.disposition === 'explicitly_skipped') return { eligible: false, decision: 'explicit_skip_available', reason: 'phase_skipped_by_user_policy' };
  return { eligible: true, decision: 'ordinary_resume_safe', reason: 'checkpoint_boundary_available' };
}
