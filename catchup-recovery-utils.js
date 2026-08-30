/** Pure validation for durable, crash-safe Memorize Chat checkpoints. */
export function normalizeCatchUpCheckpoint(checkpoint) {
  if (!checkpoint || !['in_progress', 'awaiting_manual_resume'].includes(checkpoint.status)) return null;
  const total = Number(checkpoint.source_message_count);
  const offset = Number(checkpoint.next_source_offset);
  if (!Number.isInteger(total) || total < 0 || !Number.isInteger(offset) || offset < 0 || offset > total) return null;
  return { ...checkpoint, source_message_count: total, next_source_offset: offset };
}

/**
 * Verifies that the exact original source window is still available.
 * A resumed rebuild must never silently consume messages appended afterward
 * or skip/duplicate a changed historical window.
 */
export function validateCatchUpResumeSource(checkpoint, messages = []) {
  const normalized = normalizeCatchUpCheckpoint(checkpoint);
  if (!normalized) return { valid: false, reason: 'missing_or_invalid_checkpoint' };
  if (messages.length < normalized.source_message_count) {
    return { valid: false, reason: 'source_window_shorter_than_checkpoint' };
  }
  if (normalized.source_message_count > 0) {
    const boundary = messages[normalized.source_message_count - 1];
    if (boundary?.__sme_original_index !== normalized.source_last_original_index) {
      return { valid: false, reason: 'source_window_boundary_changed' };
    }
  }
  return {
    valid: true,
    source_message_count: normalized.source_message_count,
    resume_offset: normalized.next_source_offset,
  };
}

const MAX_CATCH_UP_ATTEMPTS = 8;
const MAX_COMMITTED_RANGES = 512;

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

/** Creates or normalizes the bounded, privacy-safe manifest for one logical Memorize Chat run. */
export function ensureCatchUpRunManifest(checkpoint, sourceWindow = {}) {
  const prior = checkpoint?.run_manifest && typeof checkpoint.run_manifest === 'object' ? checkpoint.run_manifest : {};
  const sourceMessageCount = number(sourceWindow.source_message_count ?? prior.source_window?.message_count ?? checkpoint?.source_message_count, 0);
  return {
    schema_version: 1,
    logical_run_id: prior.logical_run_id ?? checkpoint?.run_id ?? null,
    source_window: {
      message_count: sourceMessageCount,
      source_start_index: Number.isInteger(Number(sourceWindow.source_start_index)) ? Number(sourceWindow.source_start_index) : (prior.source_window?.source_start_index ?? null),
      source_end_index: Number.isInteger(Number(sourceWindow.source_end_index)) ? Number(sourceWindow.source_end_index) : (prior.source_window?.source_end_index ?? checkpoint?.source_last_original_index ?? null),
      fingerprint: sourceWindow.fingerprint ?? prior.source_window?.fingerprint ?? null,
    },
    attempts: Array.isArray(prior.attempts) ? prior.attempts.slice(-MAX_CATCH_UP_ATTEMPTS) : [],
    committed_ranges: mergeRanges(prior.committed_ranges ?? []).slice(-MAX_COMMITTED_RANGES),
    tier_coverage: Object.fromEntries(['longterm', 'session'].map((tier) => [tier, {
      enabled: prior.tier_coverage?.[tier]?.enabled ?? null,
      committed_ranges: mergeRanges(prior.tier_coverage?.[tier]?.committed_ranges ?? []).slice(-MAX_COMMITTED_RANGES),
    }])),
    checkpoint_transitions: Array.isArray(prior.checkpoint_transitions) ? prior.checkpoint_transitions.slice(-24) : [],
    terminal_status: prior.terminal_status ?? 'in_progress',
    terminal_reason_code: prior.terminal_reason_code ?? null,
  };
}

/** Starts a new attempt without losing the committed coverage of earlier attempts. */
export function beginCatchUpAttempt(manifest, { type = 'initial', resumeOffset = 0, now = Date.now() } = {}) {
  const next = ensureCatchUpRunManifest({ run_manifest: manifest });
  const priorCommitted = mergeRanges(next.committed_ranges);
  const previous = next.attempts.at(-1);
  if (previous?.status === 'in_progress') previous.status = 'interrupted_before_next_attempt';
  const attempt = {
    attempt_number: (next.attempts.at(-1)?.attempt_number ?? 0) + 1,
    type,
    started_at: now,
    resume_checkpoint_offset: number(resumeOffset),
    prior_safely_committed_count: priorCommitted.reduce((sum, range) => sum + range.message_count, 0),
    current_attempt_ranges: [],
    current_attempt_chunk_count: 0,
    status: 'in_progress',
  };
  next.attempts = [...next.attempts, attempt].slice(-MAX_CATCH_UP_ATTEMPTS);
  next.checkpoint_transitions = [...next.checkpoint_transitions, { state: 'in_progress', at: now, reason_code: type }].slice(-24);
  next.terminal_status = 'in_progress';
  next.terminal_reason_code = null;
  return next;
}

/** Records a chunk only after its transaction has committed durably. */
export function recordCommittedCatchUpRange(manifest, range, { now = Date.now(), tierOutcomes = {} } = {}) {
  const next = ensureCatchUpRunManifest({ run_manifest: manifest });
  const normalized = normalizeRange(range);
  if (!normalized) return next;
  next.committed_ranges = mergeRanges([...next.committed_ranges, normalized]).slice(-MAX_COMMITTED_RANGES);
  const attempt = next.attempts.at(-1);
  if (attempt) {
    attempt.current_attempt_ranges = mergeRanges([...(attempt.current_attempt_ranges ?? []), normalized]).slice(-MAX_COMMITTED_RANGES);
    attempt.current_attempt_chunk_count = attempt.current_attempt_ranges.length;
    attempt.updated_at = now;
  }
  for (const tier of ['longterm', 'session']) {
    const outcome = tierOutcomes[tier];
    if (!outcome) continue;
    next.tier_coverage[tier].enabled = Boolean(outcome.enabled);
    if (outcome.complete) {
      next.tier_coverage[tier].committed_ranges = mergeRanges([
        ...next.tier_coverage[tier].committed_ranges,
        normalized,
      ]).slice(-MAX_COMMITTED_RANGES);
    }
  }
  return next;
}

export function finalizeCatchUpRunManifest(manifest, { status, reasonCode = null, now = Date.now() } = {}) {
  const next = ensureCatchUpRunManifest({ run_manifest: manifest });
  const attempt = next.attempts.at(-1);
  if (attempt) { attempt.status = status; attempt.ended_at = now; }
  next.terminal_status = status;
  next.terminal_reason_code = reasonCode;
  next.checkpoint_transitions = [...next.checkpoint_transitions, { state: status, at: now, reason_code: reasonCode }].slice(-24);
  return next;
}

/** Builds an export-safe, cumulative summary. Ranges use numeric source offsets only. */
export function summarizeCatchUpRunManifest(manifest) {
  const next = ensureCatchUpRunManifest({ run_manifest: manifest });
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
    }];
  }));
  return {
    schema_version: next.schema_version,
    logical_run_id: next.logical_run_id,
    source_window: next.source_window,
    attempt_count: next.attempts.length,
    attempts: next.attempts.map((attempt) => ({ ...attempt, current_attempt_ranges: mergeRanges(attempt.current_attempt_ranges ?? []) })),
    cumulative_committed_ranges: committed,
    cumulative_committed_count: count,
    cumulative_chunk_count: committed.length,
    cumulative_tier_coverage: tierCoverage,
    all_original_source_messages_covered: total === 0 ? true : gaps.length === 0,
    remaining_gaps: gaps,
    remaining_gap_count: gaps.reduce((sum, gap) => sum + gap.message_count, 0),
    terminal_status: next.terminal_status,
    terminal_reason_code: next.terminal_reason_code,
    checkpoint_transitions: next.checkpoint_transitions,
  };
}

/** Export-safe checkpoint state for recovery UI and diagnostics. */
export function summarizeCatchUpCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return { available: false, resumable: false, reason_code: 'no_checkpoint' };
  const normalized = normalizeCatchUpCheckpoint(checkpoint);
  return {
    available: true,
    resumable: Boolean(normalized),
    status: checkpoint.status ?? 'unknown',
    reason_code: checkpoint.run_manifest?.terminal_reason_code ?? null,
    source_message_count: Number(checkpoint.source_message_count ?? 0),
    safely_committed_offset: Number(checkpoint.next_source_offset ?? 0),
    logical_run: summarizeCatchUpRunManifest(checkpoint.run_manifest ?? null),
  };
}
