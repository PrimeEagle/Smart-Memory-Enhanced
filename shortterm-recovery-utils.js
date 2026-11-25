export const SHORTTERM_RECOVERY_SCHEMA_VERSION = 6;
export const SHORTTERM_ATTEMPT_ACCOUNTING_SCHEMA_VERSION = 2;
export const SHORTTERM_RECOVERY_GROWTH_SCHEMA_VERSION = 1;
const SHORTTERM_ATTEMPT_IDENTITY_LIMIT = 8192;

const finiteInteger = (value) => Number.isInteger(Number(value)) ? Math.floor(Number(value)) : null;
const count = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

const medianPositive = (values = []) => {
  const sorted = values.map(Number).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

/**
 * Derives phase-level Short-Term progress from durable commit boundaries and
 * bounded observations from this page run. Provider token progress describes
 * only the current request; it must never be mistaken for the whole phase.
 */
export function deriveShortTermPhaseProgress({
  totalSourceMessages = 0,
  committedSourceMessages = 0,
  committedPasses = 0,
  committedMessageCounts = [],
  completedRequestDurationsMs = [],
  currentRequestMessageCount = null,
  currentRequestActive = false,
  currentRequestRemainingMs = null,
  projectedCurrentRequestDurationMs = null,
} = {}) {
  const total = Math.max(0, Math.floor(Number(totalSourceMessages) || 0));
  const committed = Math.min(total, Math.max(0, Math.floor(Number(committedSourceMessages) || 0)));
  const remainingMessages = Math.max(0, total - committed);
  const observedMessagesPerPass = medianPositive(committedMessageCounts);
  const requestMessages = Math.max(0, Math.floor(Number(currentRequestMessageCount) || 0));
  const estimatedMessagesPerPass = observedMessagesPerPass ?? (requestMessages > 0 ? requestMessages : null);
  const estimatedRemainingPasses = remainingMessages === 0 ? 0
    : estimatedMessagesPerPass ? Math.max(1, Math.ceil(remainingMessages / estimatedMessagesPerPass)) : null;
  const estimatedFuturePasses = estimatedRemainingPasses === null ? null
    : Math.max(0, estimatedRemainingPasses - (currentRequestActive ? 1 : 0));
  const observedRequestDurationMs = medianPositive(completedRequestDurationsMs);
  const projectedDuration = Number(projectedCurrentRequestDurationMs);
  const estimatedPassDurationMs = observedRequestDurationMs
    ?? (Number.isFinite(projectedDuration) && projectedDuration > 0 ? projectedDuration : null);
  const requestRemaining = Number(currentRequestRemainingMs);
  const currentRemainingMs = currentRequestActive && Number.isFinite(requestRemaining) && requestRemaining >= 0
    ? requestRemaining : null;
  let estimatedRemainingMs = null;
  if (remainingMessages === 0) {
    estimatedRemainingMs = 0;
  } else if (estimatedRemainingPasses !== null && estimatedPassDurationMs !== null) {
    if (currentRequestActive) {
      estimatedRemainingMs = currentRemainingMs === null ? null
        : Math.round(currentRemainingMs + estimatedFuturePasses * estimatedPassDurationMs);
    } else {
      estimatedRemainingMs = Math.round(estimatedRemainingPasses * estimatedPassDurationMs);
    }
  }
  return {
    total_source_messages: total,
    committed_source_messages: committed,
    remaining_source_messages: remainingMessages,
    committed_passes: Math.max(0, Math.floor(Number(committedPasses) || 0)),
    estimated_messages_per_pass: estimatedMessagesPerPass,
    estimated_remaining_passes: estimatedRemainingPasses,
    estimated_future_passes: estimatedFuturePasses,
    estimated_pass_duration_ms: estimatedPassDurationMs,
    estimated_remaining_ms: estimatedRemainingMs,
  };
}

/** Audits the retained segment ledger without rewriting historical entries. */
export function reconcileShortTermSegmentLedger(audit = {}) {
  const ledger = (audit.segment_attempt_ledger ?? []).map((entry) => ({ ...entry }));
  const exactCommits = Math.max(0, Number(audit.successful_segment_commits) || 0);
  const committed = ledger.filter((entry) => entry.committed === true);
  const invalidCommitted = committed.filter((entry) => entry.provider_completed !== true || entry.parsed !== true);
  const stuckSuccessful = ledger.filter((entry) => entry.provider_completed === true && entry.parsed === true
    && entry.committed !== true && entry.failed_before_commit !== true && entry.failed_after_commit !== true);
  const accounting = audit.attempt_accounting ?? {};
  const physical = Number(accounting.cumulative_physical_transmissions ?? audit.physical_provider_attempts ?? 0);
  const terminal = Number(accounting.cumulative_terminal_transmissions
    ?? Object.values(accounting.cumulative_terminal_counts ?? accounting.terminal_counts ?? {})
      .reduce((sum, value) => sum + (Number(value) || 0), 0));
  const completed = Number(accounting.cumulative_terminal_counts?.completed
    ?? accounting.terminal_counts?.completed ?? terminal);
  const active = Number(accounting.active_transmissions ?? Object.keys(accounting.active_attempts ?? {}).length);
  const restored = Number(accounting.restored_prior_physical_transmissions ?? 0);
  const current = Number(accounting.current_attempt_physical_transmissions ?? 0);
  return {
    ...audit,
    segment_attempt_ledger: ledger,
    ledger_reconciliation: {
      retained_entry_count: ledger.length,
      retained_detail_bounded: true,
      retained_detail_limit: Number(audit.segment_attempt_ledger_limit ?? 32),
      exact_successful_commit_count: exactCommits,
      successful_commits_do_not_exceed_completed_provider_attempts: exactCommits <= completed,
      completed_provider_attempts: completed,
      committed_entries_are_completed_and_parsed: invalidCommitted.length === 0,
      terminal_successful_entries_stuck_at_response_observed: stuckSuccessful.length,
      no_terminal_success_stuck: stuckSuccessful.length === 0,
      active_plus_terminal_equals_physical: active + terminal === physical,
      restored_plus_current_equals_cumulative: restored + current === physical,
    },
  };
}

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
 * Persisted accounting must use the current schema. Incomplete runs from an
 * older schema are deliberately not upgraded because doing so would invent
 * physical-transmission history.
 */
export function createShortTermAttemptAccounting({ prior = null, runId = null,
  attemptNumber = null } = {}) {
  if (prior != null
    && Number(prior?.schema_version) !== SHORTTERM_ATTEMPT_ACCOUNTING_SCHEMA_VERSION) {
    const error = new Error('Short-Term attempt accounting uses an unsupported schema; Fresh Start is required.');
    error.code = 'SME_FRESH_START_REQUIRED';
    error.sme_reason_code = 'shortterm_attempt_accounting_schema_unsupported';
    error.sme_failure_stage = 'shortterm_attempt_accounting_restore';
    throw error;
  }
  const priorTotal = count(prior?.cumulative_physical_transmissions);
  const restoredInterrupted = Object.keys(prior?.active_attempts ?? {}).length;
  const cumulativeTerminal = prior
    ? { ...emptyTerminalCounts(), ...(prior.cumulative_terminal_counts ?? {}) }
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
    cumulative_by_segment_size: { ...(prior?.cumulative_by_segment_size ?? {}) },
    retry_transmissions: 0,
    fallback_transmissions: 0,
    format_repair_transmissions: 0,
    active_attempts: {},
    counted_attempt_ids: [],
    terminal_attempt_ids: [],
    recent_attempt_ids: [],
    attempt_identity_limit: SHORTTERM_ATTEMPT_IDENTITY_LIMIT,
    totals_exact: prior?.totals_exact !== false,
    accounting_limitation: prior?.accounting_limitation ?? null,
  };
}

function terminalizeShortTermAttempt(next, attemptId, outcome) {
  if (!attemptId || next.terminal_attempt_ids.includes(attemptId)) return;
  if (next.terminal_attempt_ids.length >= SHORTTERM_ATTEMPT_IDENTITY_LIMIT) {
    next.totals_exact = false;
    next.accounting_limitation ??= 'attempt_identity_limit_exceeded';
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
        next.accounting_limitation ??= 'attempt_identity_limit_exceeded';
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
    accounting_limitation: accounting?.accounting_limitation ?? null,
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

/** Authoritative no-plan path used by the recovery panel and Resume preflight. */
export function deriveShortTermMissingPlanResumeEligibility({ checkpointStatus = null,
  phaseDisposition = null, postCommitMarker = null, failureState = null } = {}) {
  if (!postCommitMarker) {
    return { eligible: false, decision: 'fresh_start_required',
      reason: 'shortterm_recovery_plan_missing', conflicts: [] };
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
  if (finiteInteger(plan.schema_version) !== SHORTTERM_RECOVERY_SCHEMA_VERSION) {
    conflicts.push({ field: 'schema_version', persisted: plan.schema_version ?? null,
      current: SHORTTERM_RECOVERY_SCHEMA_VERSION,
      reason: 'unsupported_recovery_schema_fresh_start_required' });
  }
  if (typeof plan.configuration_signature !== 'string'
    || !plan.configuration_signature.trim()) {
    conflicts.push({ field: 'configuration_signature',
      persisted: plan.configuration_signature ?? null,
      current: current.configuration_signature ?? null,
      reason: 'missing_configuration_signature_fresh_start_required' });
  }
  return {
    valid: conflicts.length === 0,
    reason: conflicts[0]?.reason ?? 'validated_against_current_state',
    conflicts,
    minimum_segment_floor: floor,
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
    accounting_limitation: accounting?.accounting_limitation ?? null,
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
