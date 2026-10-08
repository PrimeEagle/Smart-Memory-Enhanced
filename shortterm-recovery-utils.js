export const SHORTTERM_RECOVERY_SCHEMA_VERSION = 5;

const finiteInteger = (value) => Number.isInteger(Number(value)) ? Math.floor(Number(value)) : null;

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
  const currentPhysical = Number(currentAttempt.physical_provider_attempts ?? 0);
  return {
    schema_version: SHORTTERM_RECOVERY_SCHEMA_VERSION,
    cumulative_physical_attempts: Number(cumulative.physical_provider_attempts ?? 0) + currentPhysical,
    current_attempt_physical_attempts: currentPhysical,
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
