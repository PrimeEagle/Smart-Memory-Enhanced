import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCatchUpCheckpoint,
  validateCatchUpResumeSource,
  ensureCatchUpRunManifest,
  beginCatchUpAttempt,
  recordCommittedCatchUpRange,
  finalizeCatchUpRunManifest,
  summarizeCatchUpRunManifest,
  summarizeCatchUpCheckpoint,
} from '../catchup-recovery-utils.js';

const checkpoint = {
  schema_version: 1,
  status: 'in_progress',
  run_id: 'run-1',
  source_message_count: 3,
  source_last_original_index: 8,
  next_source_offset: 2,
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
  let manifest = ensureCatchUpRunManifest({ run_id: 'run-1', source_message_count: 10 }, {
    source_message_count: 10, source_start_index: 0, source_end_index: 9, fingerprint: 'safe-fingerprint',
  });
  manifest = beginCatchUpAttempt(manifest, { type: 'initial', now: 1 });
  manifest = recordCommittedCatchUpRange(manifest, { start_offset: 0, end_offset: 4, source_start_index: 0, source_end_index: 4 }, {
    now: 2, tierOutcomes: { longterm: { enabled: true, complete: true }, session: { enabled: true, complete: true } },
  });
  manifest = finalizeCatchUpRunManifest(manifest, { status: 'awaiting_manual_resume', reasonCode: 'manual_cancel', now: 3 });
  manifest = beginCatchUpAttempt(manifest, { type: 'resumed_after_manual_cancel', resumeOffset: 5, now: 4 });
  manifest = recordCommittedCatchUpRange(manifest, { start_offset: 5, end_offset: 9, source_start_index: 5, source_end_index: 9 }, {
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
  let manifest = ensureCatchUpRunManifest({ run_id: 'run-3', source_message_count: 293 }, {
    source_message_count: 293, source_start_index: 0, source_end_index: 292,
  });
  manifest = beginCatchUpAttempt(manifest, { type: 'initial', now: 1 });
  manifest = recordCommittedCatchUpRange(manifest, { start_offset: 0, end_offset: 69 }, { now: 2 });
  manifest = recordCommittedCatchUpRange(manifest, { start_offset: 70, end_offset: 139 }, { now: 3 });
  manifest = beginCatchUpAttempt(manifest, { type: 'resumed_after_crash', resumeOffset: 140, now: 4 });
  manifest = recordCommittedCatchUpRange(manifest, { start_offset: 140, end_offset: 199 }, { now: 5 });
  manifest = recordCommittedCatchUpRange(manifest, { start_offset: 200, end_offset: 259 }, { now: 6 });
  manifest = finalizeCatchUpRunManifest(manifest, { status: 'awaiting_manual_resume', now: 7, attemptMetrics: { retry_count: 1, provider_failure_count: 0 } });
  manifest = beginCatchUpAttempt(manifest, { type: 'resumed_after_manual_cancel', resumeOffset: 260, now: 8 });
  manifest = recordCommittedCatchUpRange(manifest, { start_offset: 260, end_offset: 279 }, { now: 9 });
  manifest = recordCommittedCatchUpRange(manifest, { start_offset: 280, end_offset: 292 }, { now: 10 });
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

test('legacy range-only checkpoint data never masquerades as chunk accounting', () => {
  const summary = summarizeCatchUpRunManifest({
    schema_version: 1,
    source_window: { message_count: 4 },
    committed_ranges: [{ start_offset: 0, end_offset: 3 }],
    attempts: [{ attempt_number: 1, current_attempt_ranges: [{ start_offset: 0, end_offset: 3 }], current_attempt_chunk_count: 1 }],
  });
  assert.equal(summary.cumulative_range_count, 1);
  assert.equal(summary.cumulative_chunk_count, null);
  assert.equal(summary.cumulative_chunk_count_available, false);
  assert.equal(summary.cumulative_chunk_count_reason, 'legacy_chunk_detail_unavailable');
  assert.equal(summary.attempts[0].current_attempt_chunk_count, null);
  assert.equal(summary.attempts[0].current_attempt_chunk_count_reason, 'legacy_chunk_detail_unavailable');
});

test('uncommitted and incomplete tier ranges cannot be mistaken for full cumulative coverage', () => {
  let manifest = ensureCatchUpRunManifest({ run_id: 'run-2', source_message_count: 8 }, { source_message_count: 8 });
  manifest = beginCatchUpAttempt(manifest, { type: 'initial' });
  manifest = recordCommittedCatchUpRange(manifest, { start_offset: 0, end_offset: 3 }, {
    tierOutcomes: { longterm: { enabled: true, complete: false }, session: { enabled: true, complete: true } },
  });
  const summary = summarizeCatchUpRunManifest(manifest);
  assert.equal(summary.cumulative_committed_count, 4);
  assert.equal(summary.remaining_gap_count, 4);
  assert.equal(summary.cumulative_tier_coverage.longterm.coverage_complete, false);
  assert.equal(summary.cumulative_tier_coverage.session.coverage_complete, false);
});

test('checkpoint diagnostics distinguish missing, resumable, and invalidated recovery states', () => {
  assert.deepEqual(summarizeCatchUpCheckpoint(null), { available: false, resumable: false, reason_code: 'no_checkpoint' });
  assert.equal(summarizeCatchUpCheckpoint(checkpoint).resumable, true);
  const invalid = summarizeCatchUpCheckpoint({ ...checkpoint, status: 'invalidated_source_mismatch', run_manifest: { terminal_reason_code: 'source_window_boundary_changed' } });
  assert.equal(invalid.resumable, false);
  assert.equal(invalid.status, 'invalidated_source_mismatch');
  assert.equal(invalid.reason_code, 'source_window_boundary_changed');
});
