import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCatchUpCheckpoint,
  validateCatchUpResumeSource,
  ensureCatchUpRunManifest,
  beginCatchUpAttempt,
  finalizeCatchUpRunManifest,
  summarizeCatchUpRunManifest,
  summarizeCatchUpCheckpoint,
  reconcileCatchUpRecoverySummary,
  deriveFinalizationAvailability,
  invalidatePrematureFinalization,
} from '../catchup-recovery-utils.js';
import { createMemorizeExecutionAggregate } from '../memorize-execution-kernel.js';

function mergeFixtureRanges(ranges = []) {
  const sorted = ranges.map((range) => ({ ...range,
    message_count: range.end_offset - range.start_offset + 1 }))
    .sort((left, right) => left.start_offset - right.start_offset);
  const merged = [];
  for (const range of sorted) {
    const prior = merged.at(-1);
    if (prior && range.start_offset <= prior.end_offset + 1) {
      prior.end_offset = Math.max(prior.end_offset, range.end_offset);
      prior.source_end_index = range.source_end_index ?? prior.source_end_index;
      prior.message_count = prior.end_offset - prior.start_offset + 1;
    } else merged.push(range);
  }
  return merged;
}

/** Test-fixture construction only; production coverage is rebuilt from the ledger. */
function withProjectedCommittedRange(manifestValue, rangeValue, {
  now = Date.now(), tierOutcomes = {}, attemptMetrics = {},
} = {}) {
  const manifest = structuredClone(manifestValue);
  const range = { ...rangeValue,
    message_count: rangeValue.end_offset - rangeValue.start_offset + 1 };
  const outcomes = Object.values(tierOutcomes)
    .filter((outcome) => outcome?.enabled === true && outcome?.applicable !== false);
  const terminal = (outcome) => outcome.safely_committed === true || outcome.complete === true
    || outcome.not_applicable === true || outcome.alternative_resolved === true;
  const committed = outcomes.every(terminal);
  if (committed) manifest.committed_ranges = mergeFixtureRanges([
    ...(manifest.committed_ranges ?? []), range,
  ]);
  const attempt = manifest.attempts.at(-1);
  if (attempt && committed) {
    attempt.current_attempt_ranges = mergeFixtureRanges([
      ...(attempt.current_attempt_ranges ?? []), range,
    ]);
    attempt.current_attempt_range_count = attempt.current_attempt_ranges.length;
    const isNew = !(attempt.current_attempt_chunks ?? []).some((item) =>
      item.start_offset === range.start_offset && item.end_offset === range.end_offset);
    if (isNew) attempt.current_attempt_chunks.push(range);
    if (isNew) attempt.current_attempt_chunk_count += 1;
    attempt.request_counters = {
      retry_count: Number(attemptMetrics.retry_count ?? attempt.request_counters?.retry_count ?? 0),
      provider_failure_count: Number(attemptMetrics.provider_failure_count
        ?? attempt.request_counters?.provider_failure_count ?? 0),
    };
    attempt.updated_at = now;
  }
  if (manifest.cumulative_chunk_count_available && committed) {
    const isNew = !manifest.committed_chunks.some((item) =>
      item.start_offset === range.start_offset && item.end_offset === range.end_offset);
    if (isNew) manifest.committed_chunks.push(range);
    if (isNew) manifest.cumulative_chunk_count += 1;
  }
  for (const tier of ['longterm', 'session']) {
    const outcome = tierOutcomes[tier];
    if (!outcome) continue;
    manifest.tier_coverage[tier].enabled = Boolean(outcome.enabled);
    if (terminal(outcome) && outcome.enabled) {
      manifest.tier_coverage[tier].committed_ranges = mergeFixtureRanges([
        ...manifest.tier_coverage[tier].committed_ranges, range,
      ]);
    }
  }
  return manifest;
}

test('Resume presentation cannot claim resumable when pending work has no safe action', () => {
  const ledger = createMemorizeExecutionAggregate('run');
  ledger.obligations['session:chat:100-119:test'] = {
    obligation_id: 'session:chat:100-119:test', logical_run_id: 'run', tier: 'session', owner: null,
    source_range: { start: 100, end: 119, message_count: 20 }, provider_attempt_lineage: [],
    current_state: 'provider_running', checkpoint_eligible: false,
    exact_reason_code: 'provider_request_in_progress', next_eligible_action: null,
    timestamps: {}, metrics: {}, schema_version: 1, implementation_version: 2,
  };
  const runManifest = ensureCatchUpRunManifest({ run_id: 'run' }, { message_count: 9434 });
  runManifest.obligation_ledger = ledger;
  const summary = summarizeCatchUpCheckpoint({
    schema_version: 1, status: 'awaiting_manual_resume', next_source_offset: 100,
    source_fingerprint: 'source',
    run_manifest: runManifest,
  });
  assert.equal(summary.pending_obligation_count, 1);
  assert.equal(summary.running_obligation_count, 1);
  assert.equal(summary.actionable_pending_obligation_count, 0);
  assert.equal(summary.resumable, false);
  assert.equal(summary.resume_can_make_progress, false);
  assert.equal(summary.blocked, true);
});

test('provider obligations authoritatively correct stale checkpoint recovery presentation', () => {
  const checkpoint = { available: true, resumable: true, unresolved_obligation_count: 0,
    safely_committed_offset: 60 };
  const pending = reconcileCatchUpRecoverySummary(checkpoint, {
    terminal_unresolved_obligations: [{ root_obligation_id: 'longterm:nyx:60-79:root',
      tier: 'longterm', owner: 'Nyx Watson', recovery_blocked: false,
      eligible_recovery_stage: 'single_source_unit_regeneration',
      next_eligible_recovery_action: 'dispatch_provider_request' }],
  });
  assert.equal(pending.unresolved_obligation_count, 1);
  assert.equal(pending.resumable, true);
  assert.equal(pending.next_eligible_recovery_action, 'dispatch_provider_request');
  const blocked = reconcileCatchUpRecoverySummary(checkpoint, {
    terminal_unresolved_obligations: [{ root_obligation_id: 'longterm:nyx:60-79:root',
      tier: 'longterm', owner: 'Nyx Watson', recovery_blocked: true,
      next_eligible_recovery_action: 'stop_blocked' }],
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.resumable, false);
  assert.equal(blocked.blocked_obligation_count, 1);
});

test('provider recovery-budget pause is resumable without becoming an unresolved error', () => {
  const result = reconcileCatchUpRecoverySummary({
    available: true, resumable: true, safely_committed_offset: 600,
    reason_code: 'tier_coverage_incomplete',
  }, {
    terminal_unresolved_obligations: [],
    operational_pauses: [{
      root_obligation_id: 'longterm:aster graves:600-619:fnv1a-a39ee667',
      reason_code: 'recovery_request_budget_reached_with_pending_children',
      next_resumable_child: 'longterm:aster graves:615-619:pending',
    }],
  });
  assert.equal(result.resumable, true);
  assert.equal(result.blocked, false);
  assert.equal(result.unresolved_obligation_count, 0);
  assert.equal(result.operational_pause_count, 1);
  assert.match(result.next_eligible_recovery_action, /615-619/);
});

test('incomplete tier coverage invalidates premature finalization before resume', () => {
  let manifest = ensureCatchUpRunManifest({ run_id: 'run-incomplete' }, { message_count: 9434 });
  assert.equal(manifest.obligation_ledger.logical_run_id, 'run-incomplete');
  assert.equal(manifest.obligation_ledger.execution_kernel.schema_version, 3);
  const checkpoint = {
    next_source_offset: 0,
    run_manifest: manifest,
    finalization: {
      active_phase: null,
      completed_phases: { final_reconciliation: { completed_at: 10 } },
      phase_dispositions: { final_reconciliation: { disposition: 'completed' } },
    },
  };
  const result = invalidatePrematureFinalization(checkpoint);
  assert.equal(result.invalidated, true);
  assert.deepEqual(result.phase_keys, ['final_reconciliation']);
  assert.deepEqual(checkpoint.finalization.completed_phases, {});
  assert.equal(checkpoint.finalization.phase_dispositions.final_reconciliation.disposition,
    'invalidated_by_incomplete_source_coverage');
  assert.equal(checkpoint.finalization.invalidated_phases[0].reason_code,
    'source_or_tier_coverage_incomplete');
});

test('complete source and tier coverage preserves committed finalization', () => {
  let manifest = ensureCatchUpRunManifest({ run_id: 'run-complete' }, { message_count: 20 });
  manifest = withProjectedCommittedRange(manifest, {
    start_offset: 0, end_offset: 19, source_start_index: 0, source_end_index: 19,
  }, {
    tierOutcomes: {
      longterm: { enabled: true, complete: true },
      session: { enabled: true, complete: true },
    },
  });
  const checkpoint = {
    next_source_offset: 20,
    run_manifest: manifest,
    finalization: {
      active_phase: null,
      completed_phases: { final_reconciliation: { completed_at: 10 } },
      phase_dispositions: { final_reconciliation: { disposition: 'completed' } },
    },
  };
  const result = invalidatePrematureFinalization(checkpoint);
  assert.equal(result.invalidated, false);
  assert.equal(checkpoint.finalization.completed_phases.final_reconciliation.completed_at, 10);
});

const checkpoint = {
  schema_version: 1,
  status: 'in_progress',
  run_id: 'run-1',
  next_source_offset: 2,
  run_manifest: ensureCatchUpRunManifest({ run_id: 'run-1' }, {
    message_count: 3, source_start_index: 2, source_end_index: 8,
  }),
};

test('a valid incomplete checkpoint resumes at its committed source offset', () => {
  assert.deepEqual(normalizeCatchUpCheckpoint(checkpoint), checkpoint);
  assert.deepEqual(validateCatchUpResumeSource(checkpoint, [
    { __sme_original_index: 2 }, { __sme_original_index: 5 }, { __sme_original_index: 8 }, { __sme_original_index: 10 },
  ]), {
    valid: true,
    source_message_count: 3,
    resume_offset: 2,
  });
});

test('a 9,434-message restart after source completion resumes finalization with zero source replay', () => {
  const completedSourceCheckpoint = {
    schema_version: 1,
    status: 'in_progress',
    run_id: 'run-long-finalization',
    next_source_offset: 9434,
    run_manifest: ensureCatchUpRunManifest({ run_id: 'run-long-finalization' }, {
      message_count: 9434, source_start_index: 0, source_end_index: 9433,
    }),
    finalization: { active_phase: 'scene_detection', completed_phases: {} },
  };
  const source = Array.from({ length: 9434 }, (_, index) => ({ __sme_original_index: index }));
  const validation = validateCatchUpResumeSource(completedSourceCheckpoint, source);
  assert.equal(validation.valid, true);
  assert.equal(validation.resume_offset, 9434);
  assert.equal(source.slice(validation.resume_offset).length, 0);
  assert.equal(normalizeCatchUpCheckpoint(completedSourceCheckpoint)?.finalization.active_phase, 'scene_detection');
});

test('completed, malformed, shortened, and changed source windows cannot resume', () => {
  assert.equal(normalizeCatchUpCheckpoint({ ...checkpoint, status: 'awaiting_manual_resume' })?.run_id, 'run-1');
  assert.equal(normalizeCatchUpCheckpoint({ ...checkpoint, status: 'completed' }), null);
  assert.equal(normalizeCatchUpCheckpoint({ ...checkpoint, next_source_offset: 4 }), null);
  assert.equal(validateCatchUpResumeSource(checkpoint, [{ __sme_original_index: 2 }]).reason, 'source_window_shorter_than_checkpoint');
  assert.equal(validateCatchUpResumeSource(checkpoint, [
    { __sme_original_index: 2 }, { __sme_original_index: 5 }, { __sme_original_index: 9 },
  ]).reason, 'source_window_boundary_changed');
});

test('a resumed logical run retains cumulative committed coverage while keeping per-attempt ranges explicit', () => {
  let manifest = ensureCatchUpRunManifest({ run_id: 'run-1' }, {
    message_count: 10, source_start_index: 0, source_end_index: 9, fingerprint: 'safe-fingerprint',
  });
  manifest = beginCatchUpAttempt(manifest, { type: 'initial', now: 1 });
  manifest = withProjectedCommittedRange(manifest, { start_offset: 0, end_offset: 4, source_start_index: 0, source_end_index: 4 }, {
    now: 2, tierOutcomes: { longterm: { enabled: true, complete: true }, session: { enabled: true, complete: true } },
  });
  manifest = finalizeCatchUpRunManifest(manifest, { status: 'awaiting_manual_resume', reasonCode: 'manual_cancel', now: 3 });
  manifest = beginCatchUpAttempt(manifest, { type: 'resumed_after_manual_cancel', resumeOffset: 5, now: 4 });
  manifest = withProjectedCommittedRange(manifest, { start_offset: 5, end_offset: 9, source_start_index: 5, source_end_index: 9 }, {
    now: 5, tierOutcomes: { longterm: { enabled: true, complete: true }, session: { enabled: true, complete: true } },
  });
  const summary = summarizeCatchUpRunManifest(finalizeCatchUpRunManifest(manifest, { status: 'completed', now: 6 }));
  assert.equal(summary.attempt_count, 2);
  assert.equal(summary.cumulative_committed_count, 10);
  assert.equal(summary.all_original_source_messages_covered, true);
  assert.equal(summary.remaining_gaps.length, 0);
  assert.equal(summary.cumulative_tier_coverage.longterm.coverage_complete, true);
  assert.equal(summary.cumulative_tier_coverage.session.coverage_complete, true);
  assert.equal(summary.attempts[0].current_attempt_ranges[0].start_offset, 0);
  assert.equal(summary.attempts[1].current_attempt_ranges[0].start_offset, 5);
});

test('recovery accounting keeps actual chunks distinct from coalesced coverage ranges across attempts', () => {
  let manifest = ensureCatchUpRunManifest({ run_id: 'run-3' }, {
    message_count: 293, source_start_index: 0, source_end_index: 292,
  });
  manifest = beginCatchUpAttempt(manifest, { type: 'initial', now: 1 });
  manifest = withProjectedCommittedRange(manifest, { start_offset: 0, end_offset: 69 }, { now: 2 });
  manifest = withProjectedCommittedRange(manifest, { start_offset: 70, end_offset: 139 }, { now: 3 });
  manifest = beginCatchUpAttempt(manifest, { type: 'resumed_after_crash', resumeOffset: 140, now: 4 });
  manifest = withProjectedCommittedRange(manifest, { start_offset: 140, end_offset: 199 }, { now: 5 });
  manifest = withProjectedCommittedRange(manifest, { start_offset: 200, end_offset: 259 }, { now: 6 });
  manifest = finalizeCatchUpRunManifest(manifest, { status: 'awaiting_manual_resume', now: 7, attemptMetrics: { retry_count: 1, provider_failure_count: 0 } });
  manifest = beginCatchUpAttempt(manifest, { type: 'resumed_after_manual_cancel', resumeOffset: 260, now: 8 });
  manifest = withProjectedCommittedRange(manifest, { start_offset: 260, end_offset: 279 }, { now: 9 });
  manifest = withProjectedCommittedRange(manifest, { start_offset: 280, end_offset: 292 }, { now: 10 });
  const summary = summarizeCatchUpRunManifest(finalizeCatchUpRunManifest(manifest, {
    status: 'completed', now: 11, attemptMetrics: { retry_count: 2, provider_failure_count: 1 },
  }));

  assert.equal(summary.scope, 'cumulative_logical_run_across_attempts');
  assert.equal(summary.attempt_count, 3);
  assert.equal(summary.cumulative_range_count, 1);
  assert.equal(summary.cumulative_chunk_count, 6);
  assert.equal(summary.cumulative_chunk_count_available, true);
  assert.equal(summary.attempts[2].current_attempt_range_count, 1);
  assert.equal(summary.attempts[2].current_attempt_chunk_count, 2);
  assert.equal(summary.attempts[2].current_attempt_chunks.length, 2);
  assert.equal(summary.cumulative_committed_count, 293);
  assert.equal(summary.remaining_gap_count, 0);
  assert.equal(summary.cumulative_request_counters.retry_count, 3);
  assert.equal(summary.cumulative_request_counters.provider_failure_count, 1);
  assert.equal(summary.cumulative_attempt_elapsed_ms_available, true);
});

test('current range-only diagnostic input never masquerades as chunk accounting', () => {
  const summary = summarizeCatchUpRunManifest({
    schema_version: 3,
    source_window: { message_count: 4 },
    committed_ranges: [{ start_offset: 0, end_offset: 3 }],
    attempts: [{ attempt_number: 1, current_attempt_ranges: [{ start_offset: 0, end_offset: 3 }], current_attempt_chunk_count: 1 }],
  });
  assert.equal(summary.cumulative_range_count, 1);
  assert.equal(summary.cumulative_chunk_count, null);
  assert.equal(summary.cumulative_chunk_count_available, false);
  assert.equal(summary.cumulative_chunk_count_reason, 'committed_chunk_detail_unavailable');
  assert.equal(summary.attempts[0].current_attempt_chunk_count, null);
  assert.equal(summary.attempts[0].current_attempt_chunk_count_reason, 'committed_chunk_detail_unavailable');
});

test('obsolete run-manifest schemas fail closed and require Fresh Start', () => {
  assert.throws(() => summarizeCatchUpRunManifest({
    schema_version: 2,
    source_window: { message_count: 4 },
  }), (error) => error.code === 'SME_CATCH_UP_RUN_MANIFEST_SCHEMA_UNSUPPORTED');
});

test('uncommitted and incomplete tier ranges cannot be mistaken for full cumulative coverage', () => {
  let manifest = ensureCatchUpRunManifest({ run_id: 'run-2' }, { message_count: 8 });
  manifest = beginCatchUpAttempt(manifest, { type: 'initial' });
  manifest = withProjectedCommittedRange(manifest, { start_offset: 0, end_offset: 3 }, {
    tierOutcomes: { longterm: { enabled: true, complete: false }, session: { enabled: true, complete: true } },
  });
  const summary = summarizeCatchUpRunManifest(manifest);
  assert.equal(summary.cumulative_committed_count, 0);
  assert.equal(summary.remaining_gap_count, 8);
  assert.equal(summary.cumulative_tier_coverage.longterm.coverage_complete, false);
  assert.equal(summary.cumulative_tier_coverage.session.coverage_complete, false);
  assert.equal(summary.full_cumulative_coverage_confirmed, false);
  assert.deepEqual(summary.cumulative_tier_coverage.longterm.pending_obligations, []);
});

test('a resumed tier obligation replays only its missing tier and makes the range source-safe once complete', () => {
  let manifest = ensureCatchUpRunManifest({ run_id: 'run-tier-replay' }, { message_count: 4 });
  manifest = beginCatchUpAttempt(manifest, { type: 'initial', now: 1 });
  const range = { start_offset: 0, end_offset: 3, source_start_index: 10, source_end_index: 13 };
  manifest = withProjectedCommittedRange(manifest, range, {
    now: 2,
    tierOutcomes: {
      longterm: { enabled: true, complete: true },
      session: { enabled: true, complete: false, reason_code: 'provider_retry_exhausted' },
    },
  });
  let summary = summarizeCatchUpRunManifest(manifest);
  assert.equal(summary.cumulative_tier_coverage.longterm.coverage_complete, true);
  assert.equal(summary.cumulative_tier_coverage.session.coverage_complete, false);
  manifest = beginCatchUpAttempt(manifest, { type: 'resumed_after_crash', now: 3 });
  manifest = withProjectedCommittedRange(manifest, range, {
    now: 4,
    tierOutcomes: {
      longterm: { enabled: true, complete: true }, // retained, not replayed
      session: { enabled: true, complete: true },
    },
  });
  summary = summarizeCatchUpRunManifest(manifest);
  assert.equal(summary.cumulative_committed_count, 4);
  assert.equal(summary.full_cumulative_coverage_confirmed, true);
  assert.equal(summary.cumulative_tier_coverage.session.pending_obligations.length, 0);
  assert.equal(summary.attempt_count, 2);
  assert.equal(summary.resumption_count, 1);
});

test('total attempt counters remain exact after bounded detail retention', () => {
  let manifest = ensureCatchUpRunManifest({ run_id: 'run-attempts' }, { message_count: 0 });
  for (let index = 0; index < 10; index++) manifest = beginCatchUpAttempt(manifest, { type: index ? 'resumed_after_crash' : 'initial', now: index + 1 });
  const summary = summarizeCatchUpRunManifest(manifest);
  assert.equal(summary.attempt_count, 10);
  assert.equal(summary.resumption_count, 9);
  assert.equal(summary.retained_detailed_attempt_count, 8);
  assert.equal(summary.omitted_attempt_detail_count, 2);
});

test('checkpoint diagnostics distinguish missing, resumable, and invalidated recovery states', () => {
  assert.deepEqual(summarizeCatchUpCheckpoint(null), { available: false, resumable: false, reason_code: 'no_checkpoint' });
  assert.equal(summarizeCatchUpCheckpoint(checkpoint).resumable, true);
  const invalidManifest = ensureCatchUpRunManifest({ run_id: 'run-1' }, {
    message_count: 3, source_start_index: 2, source_end_index: 8,
  });
  invalidManifest.terminal_reason_code = 'source_window_boundary_changed';
  const invalid = summarizeCatchUpCheckpoint({ ...checkpoint,
    status: 'invalidated_source_mismatch', run_manifest: invalidManifest });
  assert.equal(invalid.resumable, false);
  assert.equal(invalid.status, 'invalidated_source_mismatch');
  assert.equal(invalid.reason_code, 'source_window_boundary_changed');
  const blocked = summarizeCatchUpCheckpoint({ ...checkpoint,
    status: 'blocked_recovery_change_required' });
  assert.equal(blocked.resumable, false);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.unresolved_obligation_count, 0);
  assert.equal(blocked.blocked_reason_code, 'recovery_change_required');
});

test('blocked recovery checkpoints remain durable while updated-build eligibility can reopen resume', () => {
  const blockedCheckpoint = {
    ...checkpoint,
    status: 'blocked_recovery_change_required',
  };
  assert.equal(normalizeCatchUpCheckpoint(blockedCheckpoint)?.status,
    'blocked_recovery_change_required');
  const reconciled = reconcileCatchUpRecoverySummary(
    summarizeCatchUpCheckpoint(blockedCheckpoint),
    { terminal_unresolved_obligations: [{
      root_obligation_id: 'root', tier: 'longterm', owner: 'Lillian Kraft',
      recovery_blocked: false,
      eligible_recovery_stage: 'single_source_unit_regeneration',
      next_eligible_recovery_action: 'dispatch_provider_request',
    }] },
  );
  assert.equal(reconciled.blocked, false);
  assert.equal(reconciled.resumable, true);
  assert.equal(reconciled.next_eligible_recovery_action, 'dispatch_provider_request');
});

test('checkpoint diagnostics retain completed finalization phases and the recovery settings snapshot', () => {
  const summary = summarizeCatchUpCheckpoint({
    ...checkpoint,
    finalization: { schema_version: 1, active_phase: 'shortterm_extraction', completed_phases: { scene_detection: { completed_at: 1 } },
      shortterm_post_commit_recovery_marker: { marker_id: 'marker-1', committed_boundary: 7645 },
      shortterm_recovery_plan: { schema_version: 6, plan_id: 'successor', lifecycle_state: 'successor_reload_verified',
        next_segment_start: 7645, next_segment_end: 7653, message_count: 9,
        summary_parent_hash: 'fnv1a-summary', persistence_result: 'committed', reload_result: 'verified' } },
    run_settings_snapshot: { compaction_response_length: 3000, longterm_inject_budget: 600 },
  });
  assert.equal(summary.finalization.active_phase, 'shortterm_extraction');
  assert.deepEqual(summary.finalization.completed_phases, ['scene_detection']);
  assert.equal(summary.finalization.shortterm_post_commit_recovery_marker.committed_boundary, 7645);
  assert.equal(summary.finalization.shortterm_recovery_plan.next_segment_start, 7645);
  assert.equal(summary.finalization.shortterm_recovery_plan.reload_result, 'verified');
  assert.equal(summary.run_settings_snapshot.available, true);
  assert.deepEqual(summary.run_settings_snapshot.setting_keys, ['compaction_response_length', 'longterm_inject_budget']);
});

test('attempt summaries preserve the canonical durable attempt type', () => {
  let manifest = ensureCatchUpRunManifest({}, { message_count: 1, source_start_index: 0, source_end_index: 0, fingerprint: 'x' });
  manifest = beginCatchUpAttempt(manifest, { type: 'initial', now: 1 });
  manifest = finalizeCatchUpRunManifest(manifest, { status: 'awaiting_manual_resume', reasonCode: 'finalization_phase_failed', now: 2 });
  manifest = beginCatchUpAttempt(manifest, { type: 'resumed_after_manual_cancel', now: 3 });
  const summary = summarizeCatchUpRunManifest(manifest);
  assert.equal(summary.attempts[1].type, 'resumed_after_manual_cancel');
  assert.equal(Object.hasOwn(summary.attempts[1], 'legacy_attempt_type'), false);
  assert.equal(Object.hasOwn(summary.attempts[1], 'attempt_type_migrated'), false);
});

test('Arc and Profile finalization remain not evaluated while source recovery is pending', () => {
  const result = deriveFinalizationAvailability({
    next_source_offset: 20,
    total_source_messages: 9434,
    pending_obligation_count: 1,
    arcs_enabled: true,
    profiles_enabled: true,
  });
  assert.equal(result.source_extraction_complete, false);
  assert.deepEqual(result.availability, {
    state: 'not_reached',
    blocked_by: 'upstream_source_coverage_incomplete',
    arc_extraction: 'not_evaluated',
    profile_generation: 'not_evaluated',
  });
});

test('finalization becomes evaluable only after source offset and obligations are complete', () => {
  assert.equal(deriveFinalizationAvailability({
    next_source_offset: 9434,
    total_source_messages: 9434,
    pending_obligation_count: 1,
    arcs_enabled: true,
  }).source_extraction_complete, false);
  assert.deepEqual(deriveFinalizationAvailability({
    next_source_offset: 9434,
    total_source_messages: 9434,
    pending_obligation_count: 0,
    arcs_enabled: true,
  }).availability, { state: 'ready_or_completed', blocked_by: null });
});
