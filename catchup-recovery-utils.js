import { projectMemorizeObligationLedger } from './memorize-obligation-ledger.js';
import { ensureMemorizeExecutionAggregate } from './memorize-execution-kernel.js';
import { cloneSerializableDomain } from './serializable-domain.js';
import { createUnresolvedObligationSummary } from './memorize-domain-dtos.js';

export const CATCH_UP_RUN_MANIFEST_SCHEMA_VERSION = 3;

/** Pure validation for durable, crash-safe Memorize Chat checkpoints. */
export function normalizeCatchUpCheckpoint(checkpoint) {
  if (!checkpoint || !['in_progress', 'awaiting_manual_resume', 'blocked_recovery_change_required']
    .includes(checkpoint.status)) return null;
  const total = Number(checkpoint.run_manifest?.source_window?.message_count);
  const offset = Number(checkpoint.next_source_offset);
  if (!Number.isInteger(total) || total < 0 || !Number.isInteger(offset) || offset < 0 || offset > total) return null;
  return { ...checkpoint, next_source_offset: offset };
}

/**
 * Verifies that the exact original source window is still available.
 * A resumed rebuild must never silently consume messages appended afterward
 * or skip/duplicate a changed historical window.
 */
export function validateCatchUpResumeSource(checkpoint, messages = []) {
  const normalized = normalizeCatchUpCheckpoint(checkpoint);
  if (!normalized) return { valid: false, reason: 'missing_or_invalid_checkpoint' };
  const sourceMessageCount = normalized.run_manifest.source_window.message_count;
  if (messages.length < sourceMessageCount) {
    return { valid: false, reason: 'source_window_shorter_than_checkpoint' };
  }
  if (sourceMessageCount > 0) {
    const boundary = messages[sourceMessageCount - 1];
    if (boundary?.__sme_original_index !== normalized.run_manifest.source_window.source_end_index) {
      return { valid: false, reason: 'source_window_boundary_changed' };
    }
  }
  return {
    valid: true,
    source_message_count: sourceMessageCount,
    resume_offset: normalized.next_source_offset,
  };
}

/**
 * Removes finalization commits that were recorded while source or enabled-tier
 * coverage was still incomplete. Such commits are useful only as intermediate
 * observations and must never cause a resumed run to skip its definitive
 * post-extraction finalization.
 */
export function invalidatePrematureFinalization(checkpoint) {
  if (!checkpoint?.finalization || !checkpoint?.run_manifest) {
    return { invalidated: false, phase_keys: [] };
  }
  const summary = summarizeCatchUpRunManifest(checkpoint.run_manifest);
  const sourceIncomplete = Number(checkpoint.next_source_offset ?? 0)
    < Number(checkpoint.run_manifest?.source_window?.message_count ?? 0);
  const tierIncomplete = Object.values(summary.cumulative_tier_coverage ?? {})
    .some((tier) => tier.enabled === true && tier.coverage_complete !== true);
  if (!sourceIncomplete && !tierIncomplete) return { invalidated: false, phase_keys: [] };

  const completed = checkpoint.finalization.completed_phases ?? {};
  const phaseKeys = Object.keys(completed);
  if (!phaseKeys.length) return { invalidated: false, phase_keys: [] };
  checkpoint.finalization.invalidated_phases ??= [];
  checkpoint.finalization.phase_dispositions ??= {};
  for (const key of phaseKeys) {
    checkpoint.finalization.invalidated_phases.push({
      phase: key,
      prior_completed_at: completed[key]?.completed_at ?? null,
      reason_code: 'source_or_tier_coverage_incomplete',
      invalidated_at: Date.now(),
    });
    checkpoint.finalization.phase_dispositions[key] = {
      disposition: 'invalidated_by_incomplete_source_coverage',
      resumable: true,
      reason_code: 'source_or_tier_coverage_incomplete',
    };
    delete completed[key];
  }
  checkpoint.finalization.invalidated_phases = checkpoint.finalization.invalidated_phases.slice(-24);
  checkpoint.finalization.active_phase = null;
  checkpoint.finalization.updated_at = Date.now();
  return { invalidated: true, phase_keys: phaseKeys };
}

const MAX_CATCH_UP_ATTEMPTS = 8;
const MAX_COMMITTED_RANGES = 512;
const MAX_COMMITTED_CHUNK_DETAILS = 512;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeRange(range) {
  const start = number(range?.start_offset, null);
  const end = number(range?.end_offset, null);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
  return {
    start_offset: start,
    end_offset: end,
    source_start_index: Number.isInteger(Number(range?.source_start_index)) ? Number(range.source_start_index) : null,
    source_end_index: Number.isInteger(Number(range?.source_end_index)) ? Number(range.source_end_index) : null,
    message_count: end - start + 1,
  };
}

function mergeRanges(ranges = []) {
  const normalized = ranges.map(normalizeRange).filter(Boolean).sort((a, b) => a.start_offset - b.start_offset || a.end_offset - b.end_offset);
  const merged = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range.start_offset <= previous.end_offset + 1) {
      previous.end_offset = Math.max(previous.end_offset, range.end_offset);
      previous.source_end_index = range.source_end_index ?? previous.source_end_index;
      previous.message_count = previous.end_offset - previous.start_offset + 1;
    } else merged.push({ ...range });
  }
  return merged;
}

function gapsForRanges(ranges, total) {
  const gaps = [];
  let offset = 0;
  for (const range of ranges) {
    if (range.start_offset > offset) gaps.push({ start_offset: offset, end_offset: range.start_offset - 1, message_count: range.start_offset - offset, reason_code: 'not_safely_committed' });
    offset = Math.max(offset, range.end_offset + 1);
  }
  if (offset < total) gaps.push({ start_offset: offset, end_offset: total - 1, message_count: total - offset, reason_code: 'not_safely_committed' });
  return gaps;
}

function normalizeAttempt(attempt) {
  const ranges = mergeRanges(attempt?.current_attempt_ranges ?? []);
  const chunksAvailable = Array.isArray(attempt?.current_attempt_chunks);
  const chunks = chunksAvailable
    ? attempt.current_attempt_chunks.map(normalizeRange).filter(Boolean).slice(-MAX_COMMITTED_CHUNK_DETAILS)
    : null;
  return {
    ...attempt,
    current_attempt_ranges: ranges,
    current_attempt_range_count: ranges.length,
    current_attempt_chunks: chunks,
    current_attempt_chunk_count: chunksAvailable ? Number(attempt?.current_attempt_chunk_count ?? chunks.length) : null,
    current_attempt_chunk_count_available: chunksAvailable,
    current_attempt_chunk_count_reason: chunksAvailable ? null : 'committed_chunk_detail_unavailable',
  };
}

/** Creates or normalizes the bounded, privacy-safe manifest for one logical Memorize Chat run. */
export function ensureCatchUpRunManifest(checkpoint, sourceWindow = {}) {
  const priorValue = checkpoint?.run_manifest;
  if (priorValue && typeof priorValue === 'object'
    && Object.keys(priorValue).length > 0
    && priorValue.schema_version !== CATCH_UP_RUN_MANIFEST_SCHEMA_VERSION) {
    const error = new Error('Memorize Chat run manifest does not use the current schema. Use Fresh Start.');
    error.code = 'SME_CATCH_UP_RUN_MANIFEST_SCHEMA_UNSUPPORTED';
    throw error;
  }
  const prior = priorValue && typeof priorValue === 'object' ? priorValue : {};
  const sourceMessageCount = number(sourceWindow.message_count
    ?? prior.source_window?.message_count, 0);
  const manifest = {
    schema_version: CATCH_UP_RUN_MANIFEST_SCHEMA_VERSION,
    logical_run_id: prior.logical_run_id ?? checkpoint?.run_id ?? null,
    source_window: {
      message_count: sourceMessageCount,
      source_start_index: Number.isInteger(Number(sourceWindow.source_start_index)) ? Number(sourceWindow.source_start_index) : (prior.source_window?.source_start_index ?? null),
      source_end_index: Number.isInteger(Number(sourceWindow.source_end_index)) ? Number(sourceWindow.source_end_index) : (prior.source_window?.source_end_index ?? null),
      fingerprint: sourceWindow.fingerprint ?? prior.source_window?.fingerprint ?? null,
    },
    attempts: Array.isArray(prior.attempts) ? prior.attempts.map(normalizeAttempt).slice(-MAX_CATCH_UP_ATTEMPTS) : [],
    total_attempt_count: Math.max(number(prior.total_attempt_count), Array.isArray(prior.attempts) ? prior.attempts.length : 0),
    total_resumption_count: Math.max(number(prior.total_resumption_count), Math.max(0, (Array.isArray(prior.attempts) ? prior.attempts.length : 0) - 1)),
    committed_ranges: mergeRanges(prior.committed_ranges ?? []).slice(-MAX_COMMITTED_RANGES),
    // Coalesced coverage ranges cannot be reverse-engineered into extraction
    // chunks, so unavailable chunk detail remains explicit.
    committed_chunks: Array.isArray(prior.committed_chunks)
      ? prior.committed_chunks.map(normalizeRange).filter(Boolean).slice(-MAX_COMMITTED_CHUNK_DETAILS)
      : [],
    cumulative_chunk_count: Array.isArray(prior.committed_chunks)
      ? Number(prior.cumulative_chunk_count ?? prior.committed_chunks.length)
      : null,
    cumulative_chunk_count_available: Array.isArray(prior.committed_chunks),
    cumulative_chunk_count_reason: Array.isArray(prior.committed_chunks) ? null : 'committed_chunk_detail_unavailable',
    tier_coverage: Object.fromEntries(['longterm', 'session'].map((tier) => [tier, {
      enabled: prior.tier_coverage?.[tier]?.enabled ?? null,
      committed_ranges: mergeRanges(prior.tier_coverage?.[tier]?.committed_ranges ?? []).slice(-MAX_COMMITTED_RANGES),
    }])),
    checkpoint_transitions: Array.isArray(prior.checkpoint_transitions) ? prior.checkpoint_transitions.slice(-24) : [],
    terminal_status: prior.terminal_status ?? 'in_progress',
    terminal_reason_code: prior.terminal_reason_code ?? null,
  };
  manifest.obligation_ledger = ensureMemorizeExecutionAggregate(
    prior.obligation_ledger, manifest.logical_run_id);
  return manifest;
}

/** Starts a new attempt without losing the committed coverage of earlier attempts. */
export function beginCatchUpAttempt(manifest, { type = 'initial', resumeOffset = 0, now = Date.now() } = {}) {
  const next = ensureCatchUpRunManifest({ run_manifest: manifest });
  const priorCommitted = mergeRanges(next.committed_ranges);
  const previous = next.attempts.at(-1);
  if (previous?.status === 'in_progress') {
    previous.status = 'interrupted_before_next_attempt';
    previous.ended_at = now;
  }
  const attempt = {
    attempt_number: next.total_attempt_count + 1,
    type,
    started_at: now,
    resume_checkpoint_offset: number(resumeOffset),
    prior_safely_committed_count: priorCommitted.reduce((sum, range) => sum + range.message_count, 0),
    current_attempt_ranges: [],
    current_attempt_range_count: 0,
    current_attempt_chunks: [],
    current_attempt_chunk_count: 0,
    current_attempt_chunk_count_available: true,
    current_attempt_chunk_count_reason: null,
    request_counters: { retry_count: 0, provider_failure_count: 0 },
    status: 'in_progress',
  };
  next.attempts = [...next.attempts, attempt].slice(-MAX_CATCH_UP_ATTEMPTS);
  next.total_attempt_count += 1;
  if (next.total_attempt_count > 1) next.total_resumption_count += 1;
  next.checkpoint_transitions = [...next.checkpoint_transitions, { state: 'in_progress', at: now, reason_code: type }].slice(-24);
  next.terminal_status = 'in_progress';
  next.terminal_reason_code = null;
  return next;
}

export function finalizeCatchUpRunManifest(manifest, { status, reasonCode = null, now = Date.now(), attemptMetrics = {} } = {}) {
  const next = ensureCatchUpRunManifest({ run_manifest: manifest });
  const attempt = next.attempts.at(-1);
  if (attempt) {
    attempt.status = status;
    attempt.ended_at = now;
    attempt.request_counters = {
      retry_count: Number(attemptMetrics.retry_count ?? attempt.request_counters?.retry_count ?? 0),
      provider_failure_count: Number(attemptMetrics.provider_failure_count ?? attempt.request_counters?.provider_failure_count ?? 0),
    };
  }
  next.terminal_status = status;
  next.terminal_reason_code = reasonCode;
  next.checkpoint_transitions = [...next.checkpoint_transitions, { state: status, at: now, reason_code: reasonCode }].slice(-24);
  return next;
}

/** Builds an export-safe, cumulative summary. Ranges use numeric source offsets only. */
export function summarizeCatchUpRunManifest(manifest) {
  const next = ensureCatchUpRunManifest({ run_manifest: cloneSerializableDomain(manifest, {
    path: '$.run_manifest', stage: 'run_manifest_projection',
    operation_type: 'memorize_run_manifest',
  }) });
  const total = next.source_window.message_count;
  const committed = mergeRanges(next.committed_ranges);
  const gaps = gapsForRanges(committed, total);
  const count = committed.reduce((sum, range) => sum + range.message_count, 0);
  const tierCoverage = Object.fromEntries(['longterm', 'session'].map((tier) => {
    const coverage = next.tier_coverage?.[tier] ?? {};
    const ranges = mergeRanges(coverage.committed_ranges ?? []);
    const tierGaps = coverage.enabled ? gapsForRanges(ranges, total) : [];
    return [tier, {
      enabled: coverage.enabled,
      committed_ranges: ranges,
      committed_count: ranges.reduce((sum, range) => sum + range.message_count, 0),
      coverage_complete: coverage.enabled === false ? null : tierGaps.length === 0,
      remaining_gaps: tierGaps,
      pending_obligations: [],
    }];
  }));
  const attemptStartTransitions = next.checkpoint_transitions.filter((entry) => entry?.state === 'in_progress');
  const attempts = next.attempts.map((attempt, attemptIndex) => {
    const normalized = normalizeAttempt(attempt);
    const matchingTransitionIndex = next.checkpoint_transitions.findIndex((entry) => entry === attemptStartTransitions[attemptIndex]);
    const precedingReason = matchingTransitionIndex > 0 ? next.checkpoint_transitions[matchingTransitionIndex - 1]?.reason_code : null;
    const started = Number(normalized.started_at);
    const ended = Number(normalized.ended_at);
    return {
      ...normalized,
      type: normalized.type,
      preceding_terminal_reason: precedingReason,
      timing_scope: 'current_attempt',
      duration_ms: Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null,
      request_counter_scope: 'current_attempt',
    };
  });
  const allAttemptTimingAvailable = attempts.every((attempt) => attempt.duration_ms !== null);
  const allRequestCountersAvailable = attempts.every((attempt) => attempt.request_counters && Number.isFinite(Number(attempt.request_counters.retry_count)) && Number.isFinite(Number(attempt.request_counters.provider_failure_count)));
  const obligationProjection = projectMemorizeObligationLedger(next.obligation_ledger);
  for (const [tier, authoritative] of Object.entries(obligationProjection.tier_coverage ?? {})) {
    if (!tierCoverage[tier]) continue;
    tierCoverage[tier] = {
      ...tierCoverage[tier],
      coverage_complete: tierCoverage[tier].coverage_complete === true
        && authoritative.coverage_complete === true,
      authoritative_obligation_count: authoritative.total_obligation_count,
      authoritative_safely_committed_obligation_count: authoritative.safely_committed_obligation_count,
      authoritative_pending_obligations: authoritative.pending_obligations,
      pending_obligations: authoritative.pending_obligations.length
        ? authoritative.pending_obligations.map((item) => ({
          start_offset: item.source_range?.start ?? null,
          end_offset: item.source_range?.end ?? null,
          source_start_index: item.source_range?.start ?? null,
          source_end_index: item.source_range?.end ?? null,
          reason_code: item.exact_reason_code,
          obligation_id: item.obligation_id,
          next_eligible_action: item.next_eligible_action,
        })) : tierCoverage[tier].pending_obligations,
      projection_source: 'authoritative_obligation_ledger',
    };
  }
  return {
    schema_version: next.schema_version,
    logical_run_id: next.logical_run_id,
    source_window: next.source_window,
    attempt_count: next.total_attempt_count,
    retained_detailed_attempt_count: next.attempts.length,
    omitted_attempt_detail_count: Math.max(0, next.total_attempt_count - next.attempts.length),
    resumption_count: next.total_resumption_count,
    scope: 'cumulative_logical_run_across_attempts',
    attempts,
    cumulative_committed_ranges: committed,
    cumulative_committed_count: count,
    cumulative_range_count: committed.length,
    cumulative_chunk_count: next.cumulative_chunk_count_available ? next.cumulative_chunk_count : null,
    cumulative_chunk_count_available: next.cumulative_chunk_count_available,
    cumulative_chunk_count_reason: next.cumulative_chunk_count_reason,
    cumulative_committed_chunk_details: next.cumulative_chunk_count_available ? next.committed_chunks : null,
    cumulative_committed_chunk_details_retained_count: next.cumulative_chunk_count_available ? next.committed_chunks.length : null,
    cumulative_timing_scope: 'cumulative_logical_run_across_attempts',
    cumulative_attempt_elapsed_ms: allAttemptTimingAvailable ? attempts.reduce((sum, attempt) => sum + attempt.duration_ms, 0) : null,
    cumulative_attempt_elapsed_ms_available: allAttemptTimingAvailable,
    cumulative_request_counter_scope: 'cumulative_logical_run_across_attempts',
    cumulative_request_counters: allRequestCountersAvailable ? {
      retry_count: attempts.reduce((sum, attempt) => sum + Number(attempt.request_counters.retry_count), 0),
      provider_failure_count: attempts.reduce((sum, attempt) => sum + Number(attempt.request_counters.provider_failure_count), 0),
    } : null,
    cumulative_request_counters_available: allRequestCountersAvailable,
    cumulative_tier_coverage: tierCoverage,
    all_original_source_messages_covered: total === 0 ? true : gaps.length === 0,
    full_cumulative_coverage_confirmed: (total === 0 ? true : gaps.length === 0)
      && Object.values(tierCoverage).every((tier) => tier.enabled !== true || tier.coverage_complete === true),
    remaining_gaps: gaps,
    remaining_gap_count: gaps.reduce((sum, gap) => sum + gap.message_count, 0),
    terminal_status: next.terminal_status,
    terminal_reason_code: next.terminal_reason_code,
    checkpoint_transitions: next.checkpoint_transitions,
    authoritative_obligation_ledger: obligationProjection,
  };
}

/** Export-safe checkpoint state for recovery UI and diagnostics. */
export function summarizeCatchUpCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return { available: false, resumable: false, reason_code: 'no_checkpoint' };
  const normalized = normalizeCatchUpCheckpoint(checkpoint);
  const obligationProjection = projectMemorizeObligationLedger(
    checkpoint.run_manifest?.obligation_ledger);
  const projectedPendingCount = obligationProjection.pending_obligation_count;
  const exactPending = obligationProjection.next_eligible_obligation;
  const blockedObligations = obligationProjection.pending_obligations
    .filter((item) => ['blocked', 'terminal_failed'].includes(item.current_state)
      || !item.next_eligible_action)
    .slice(-16)
    .map(createUnresolvedObligationSummary);
  const sourceMessageCount = Number(checkpoint.run_manifest?.source_window?.message_count ?? 0);
  const safeOffset = Number(checkpoint.next_source_offset ?? 0);
  const traversalAction = projectedPendingCount === 0 && safeOffset < sourceMessageCount
    ? 'continue_source_traversal'
    : projectedPendingCount === 0 && safeOffset >= sourceMessageCount
      ? 'continue_finalization' : null;
  const pendingWithoutAction = projectedPendingCount > 0
    && !exactPending?.next_eligible_action;
  const statusBlocked = ['blocked_recovery_change_required',
    'blocked_reconciliation_required', 'terminal_failure'].includes(checkpoint.status);
  const blocked = pendingWithoutAction || statusBlocked;
  const blockedReasonCode = exactPending?.exact_reason_code
    ?? blockedObligations[0]?.exact_reason_code
    ?? (statusBlocked ? 'recovery_change_required' : null);
  const operationalPause = exactPending?.current_state === 'operationally_paused' ? {
    obligation_id: exactPending.obligation_id,
    tier: exactPending.tier ?? null,
    reason_code: exactPending.exact_reason_code ?? null,
    next_eligible_recovery_action: exactPending.next_eligible_action ?? null,
    recovery_intent: exactPending.recovery_intent ?? null,
    recovery_stage: exactPending.recovery_stage ?? null,
    projection_source: 'authoritative_obligation_ledger',
  } : null;
  const resumeCanMakeProgress = Boolean(normalized) && !blocked
    && (projectedPendingCount === 0
      || Boolean(exactPending?.next_eligible_action));
  return {
    available: true,
    resumable: resumeCanMakeProgress,
    blocked,
    blocked_reason_code: blockedReasonCode,
    unresolved_obligation_count: projectedPendingCount,
    pending_obligation_count: projectedPendingCount,
    actionable_pending_obligation_count: obligationProjection.actionable_pending_obligation_count,
    operationally_paused_obligation_count: obligationProjection.operationally_paused_obligation_count,
    blocked_obligation_count: pendingWithoutAction
      ? Math.max(obligationProjection.blocked_obligation_count,
        projectedPendingCount)
      : obligationProjection.blocked_obligation_count,
    running_obligation_count: obligationProjection.running_obligation_count,
    terminal_failed_obligation_count: obligationProjection.terminal_failed_obligation_count,
    blocked_obligations: blockedObligations,
    safe_progress_preserved: obligationProjection.safely_committed_obligation_count > 0
      || Number(checkpoint.next_source_offset ?? 0) > 0,
    next_eligible_recovery_action: exactPending?.next_eligible_action ?? traversalAction,
    recovery_intent: exactPending?.recovery_intent
      ?? exactPending?.next_eligible_action ?? traversalAction,
    recovery_stage: exactPending?.recovery_stage ?? null,
    status: checkpoint.status ?? 'unknown',
    reason_code: (String(checkpoint.status ?? '').startsWith('invalidated')
        ? checkpoint.run_manifest?.terminal_reason_code : null)
      ?? exactPending?.exact_reason_code
      ?? blockedReasonCode
      ?? (traversalAction === 'continue_source_traversal' ? 'source_traversal_incomplete'
        : checkpoint.run_manifest?.terminal_reason_code ?? null),
    source_message_count: sourceMessageCount,
    safely_committed_offset: safeOffset,
    operational_pause: operationalPause,
    operational_pause_count: operationalPause ? 1 : 0,
    transaction_lifecycle: checkpoint.transaction_lifecycle ?? null,
    authoritative_obligation_ledger: obligationProjection,
    exact_pending_obligation: exactPending ?? null,
    resume_can_make_progress: resumeCanMakeProgress,
    finalization: {
      schema_version: Number(checkpoint.finalization?.schema_version ?? 0) || null,
      active_phase: checkpoint.finalization?.active_phase ?? null,
      completed_phases: Object.keys(checkpoint.finalization?.completed_phases ?? {}),
      completed_phase_count: Object.keys(checkpoint.finalization?.completed_phases ?? {}).length,
      completed_phase_summaries: Object.fromEntries(Object.entries(checkpoint.finalization?.completed_phases ?? {}).map(([key, value]) => [key, {
        disposition: value?.disposition ?? 'completed',
        terminal_outcome: value?.terminal_outcome ?? (value?.completed_at ? 'completed_terminal_summary_unavailable' : null),
        completed_at: value?.completed_at ?? null,
        attempt_number: value?.attempt_number ?? null,
        summary_available: Boolean(value?.summary || value?.terminal_outcome),
      }])),
      phase_dispositions: checkpoint.finalization?.phase_dispositions ?? {},
      shortterm_recovery: checkpoint.finalization?.shortterm_failure_state ?? null,
      shortterm_post_commit_recovery_marker: checkpoint.finalization?.shortterm_post_commit_recovery_marker ?? null,
      shortterm_recovery_plan: checkpoint.finalization?.shortterm_recovery_plan ? {
        schema_version: checkpoint.finalization.shortterm_recovery_plan.schema_version ?? null,
        plan_id: checkpoint.finalization.shortterm_recovery_plan.plan_id ?? null,
        lifecycle_state: checkpoint.finalization.shortterm_recovery_plan.lifecycle_state ?? null,
        next_segment_start: checkpoint.finalization.shortterm_recovery_plan.next_segment_start ?? null,
        next_segment_end: checkpoint.finalization.shortterm_recovery_plan.next_segment_end ?? null,
        message_count: checkpoint.finalization.shortterm_recovery_plan.message_count ?? null,
        summary_parent_hash: checkpoint.finalization.shortterm_recovery_plan.summary_parent_hash ?? null,
        persistence_result: checkpoint.finalization.shortterm_recovery_plan.persistence_result ?? null,
        reload_result: checkpoint.finalization.shortterm_recovery_plan.reload_result ?? null,
      } : null,
    },
    run_settings_snapshot: {
      available: Boolean(checkpoint.run_settings_snapshot && typeof checkpoint.run_settings_snapshot === 'object'),
      setting_keys: Object.keys(checkpoint.run_settings_snapshot ?? {}).sort(),
    },
    logical_run: summarizeCatchUpRunManifest(checkpoint.run_manifest ?? null),
  };
}

/** Reconciles checkpoint presentation with the authoritative provider obligations. */
export function reconcileCatchUpRecoverySummary(checkpointSummary, providerSummary) {
  const base = { ...(checkpointSummary ?? { available: false, resumable: false }) };
  const authoritativePending = base.exact_pending_obligation ?? null;
  const unresolved = providerSummary?.terminal_unresolved_obligations ?? [];
  const operationalPauses = providerSummary?.operational_pauses ?? [];
  if (!unresolved.length && !operationalPauses.length) return base;
  if (!unresolved.length && operationalPauses.length) {
    const action = authoritativePending?.next_eligible_action
      ?? operationalPauses[0]?.next_resumable_child
      ?? (operationalPauses[0]?.recovery_stage !== 'bounded_recovery_exhausted'
        ? operationalPauses[0]?.recovery_stage : null);
    const canProgress = Boolean(action);
    return {
      ...base,
      available: true,
      resumable: canProgress,
      resume_can_make_progress: canProgress,
      blocked: !canProgress,
      unresolved_obligation_count: Number(base.authoritative_obligation_ledger?.pending_obligation_count
        ?? (authoritativePending ? 1 : 0)),
      actionable_pending_obligation_count: canProgress ? 1 : 0,
      operational_pause_count: operationalPauses.length,
      blocked_obligation_count: canProgress ? 0 : 1,
      operational_pauses: operationalPauses,
      reason_code: operationalPauses[0]?.reason_code
        ?? 'recovery_request_budget_reached_with_pending_children',
      next_eligible_recovery_action: action,
      recovery_intent: operationalPauses[0]?.recovery_intent
        ?? base.recovery_intent ?? null,
      recovery_stage: action ?? operationalPauses[0]?.recovery_stage
        ?? base.recovery_stage ?? null,
      safe_progress_preserved: true,
    };
  }
  const blocked = unresolved.filter((item) => item.recovery_blocked === true
    || item.recovery_eligibility?.blocked === true);
  const resumable = unresolved.filter((item) => !blocked.includes(item)
    && Boolean(item.next_eligible_recovery_action));
  return {
    ...base,
    unresolved_obligation_count: unresolved.length,
    blocked_obligation_count: blocked.length,
    blocked_obligations: blocked.map(createUnresolvedObligationSummary),
    unresolved_obligations: unresolved.map(createUnresolvedObligationSummary),
    blocked: blocked.length > 0 && resumable.length === 0,
    resumable: Boolean(base.available) && resumable.length > 0,
    resume_can_make_progress: resumable.length > 0,
    next_eligible_recovery_action: authoritativePending?.next_eligible_action
      ?? resumable[0]?.next_eligible_recovery_action ?? null,
    recovery_intent: authoritativePending?.recovery_intent
      ?? authoritativePending?.next_eligible_action
      ?? base.recovery_intent ?? null,
    recovery_stage: authoritativePending?.recovery_stage
      ?? resumable[0]?.recovery_eligibility?.eligible_action
      ?? base.recovery_stage ?? null,
    reason_code: authoritativePending?.exact_reason_code
      ?? (blocked.length > 0 && resumable.length === 0
        ? 'recovery_change_required' : 'tier_coverage_incomplete'),
    blocked_reason_code: blocked.length > 0 && resumable.length === 0
      ? 'all_recovery_stages_exhausted_for_unchanged_inputs' : null,
    safe_progress_preserved: base.authoritative_obligation_ledger?.safely_committed_obligation_count > 0
      || Number(base.safely_committed_offset ?? 0) > 0,
  };
}

/**
 * Finalization phases are evaluable only after every source obligation is
 * complete. A correctly deferred phase is not a quality failure.
 */
export function deriveFinalizationAvailability({
  next_source_offset = 0,
  total_source_messages = 0,
  pending_obligation_count = 0,
  arcs_enabled = false,
  profiles_enabled = false,
} = {}) {
  const source_extraction_complete = Number(next_source_offset) >= Number(total_source_messages)
    && Number(pending_obligation_count) === 0;
  return {
    source_extraction_complete,
    availability: source_extraction_complete ? {
      state: 'ready_or_completed', blocked_by: null,
    } : {
      state: 'not_reached',
      blocked_by: 'upstream_source_coverage_incomplete',
      arc_extraction: arcs_enabled ? 'not_evaluated' : 'disabled',
      profile_generation: profiles_enabled ? 'not_evaluated' : 'disabled',
    },
  };
}
