export const SHORTTERM_RECOVERY_SCHEMA_VERSION = 4;

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
  plan = null, validation = null, failureState = null } = {}) {
  if (!['in_progress', 'awaiting_manual_resume'].includes(checkpointStatus)) return { eligible: false, decision: 'terminal_non_resumable', reason: 'checkpoint_not_resumable' };
  if (plan && validation?.valid) return { eligible: true, decision: 'ordinary_resume_safe', reason: 'verified_recovery_plan_available' };
  if (plan && validation && !validation.valid) return { eligible: false, decision: 'plan_revalidation_required', reason: validation.reason, conflicts: validation.conflicts ?? [] };
  if (failureState?.operator_action_required) return { eligible: false, decision: 'configuration_or_provider_change_required', reason: failureState.adaptation ?? 'recovery_ladder_exhausted' };
  if (phaseDisposition?.disposition === 'explicitly_skipped') return { eligible: false, decision: 'explicit_skip_available', reason: 'phase_skipped_by_user_policy' };
  return { eligible: true, decision: 'ordinary_resume_safe', reason: 'checkpoint_boundary_available' };
}
