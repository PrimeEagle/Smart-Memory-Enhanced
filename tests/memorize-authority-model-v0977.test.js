import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  applyMemorizeLifecycleEvent,
  createMemorizeObligationLedger,
  projectMemorizeObligationLedger,
  reconcileMemorizeLifecycleFromJournal,
} from '../memorize-obligation-ledger.js';
import {
  getAuthoritativeOwnerRangeStatus,
  getAuthoritativeTierRangeStatus,
  getContiguousSafeSourceOffset,
  getFirstActionableObligation,
  getNextSourceTraversalRange,
  isAuthoritativeTierRangeSafelyCovered,
  rebuildMemorizeCompatibilityProjection,
} from '../memorize-authority-model.js';
import {
  readProviderRecoveryWindowState,
  reconcileProviderRecoveryWindowsFromLedger,
  summarizeProviderAttemptAudit,
} from '../provider-attempt-audit.js';
import {
  shouldVerifyPersistedPartialSessionRecords,
  verifyPersistedPartialSessionRecords,
} from '../session-partial-persistence.js';
import { createMemorizeExecutionContext } from '../memorize-execution-context.js';
import { createMemorizeTierPipeline } from '../memorize-tier-pipeline.js';
import { deriveRunErrorAccounting } from '../run-status-utils.js';

const fixture = JSON.parse(readFileSync(new URL(
  './fixtures/v0977-stale-session-projection.json', import.meta.url)));

const identity = (tier, owner, start, end) => ({
  obligation_id: `${tier}:${owner ?? 'chat'}:${start}-${end}:fixture`,
  logical_run_id: fixture.logical_run_id,
  tier, owner, source_range: { start, end, message_count: end - start + 1 },
  source_fingerprint: `fixture-${start}-${end}`,
});

function complete(ledger, item, durableIds = []) {
  applyMemorizeLifecycleEvent(ledger, item, {
    type: 'leaf_coverage_completed', verified_coverage: true,
    durable_record_ids: durableIds,
    persistence_result: durableIds.length ? 'committed' : 'verified_existing',
    lifecycle: { durably_persisted_record_ids: durableIds },
  });
}

function canonicalLedger() {
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id);
  for (const [start, end] of fixture.ranges) {
    complete(ledger, identity('session', null, start, end));
    for (const owner of fixture.longterm_owners) complete(ledger, identity('longterm', owner, start, end));
  }
  return ledger;
}

function staleManifest(ledger = canonicalLedger()) {
  return {
    schema_version: 3,
    logical_run_id: fixture.logical_run_id,
    source_window: { message_count: fixture.source_message_count },
    attempts: [{ attempt_number: 3, status: 'in_progress', resume_checkpoint_offset: 40,
      current_attempt_ranges: [{ start_offset: 40, end_offset: 59 }] }],
    total_attempt_count: 3,
    total_resumption_count: 2,
    committed_chunks: [{ start_offset: 0, end_offset: 19 }, { start_offset: 20, end_offset: 39 }],
    ...structuredClone(fixture.stale_compatibility),
    obligation_ledger: ledger,
  };
}

function rebuilt() {
  return rebuildMemorizeCompatibilityProjection(staleManifest(), {
    source_message_count: fixture.source_message_count,
    chunk_size: fixture.chunk_size,
    enabled_tiers: ['longterm', 'session'],
  });
}

test('1 canonical ledger stays complete while compatibility Session 40-59 is stale', () => {
  assert.equal(projectMemorizeObligationLedger(canonicalLedger()).pending_obligation_count, 0);
  assert.equal(fixture.stale_compatibility.tier_obligations.at(-1).safely_committed, false);
});
test('2 authoritative Session status ignores the stale compatibility entry', () => {
  assert.equal(getAuthoritativeTierRangeStatus(canonicalLedger(), 'session', { start: 40, end: 59 }).safely_committed, true);
});
test('3 authoritative Long-Term status requires every owner root', () => {
  assert.equal(getAuthoritativeTierRangeStatus(canonicalLedger(), 'longterm', { start: 40, end: 59 }).root_obligation_ids.length, 7);
});
test('4 owner status is ledger-derived', () => {
  assert.equal(getAuthoritativeOwnerRangeStatus(canonicalLedger(), 'Taylor', { start: 40, end: 59 }).safely_committed, true);
});
test('5 Session coverage rebuilds from 0 through 59', () => {
  assert.deepEqual(rebuilt().manifest.tier_coverage.session.committed_ranges.map((r) => [r.start_offset, r.end_offset]), [[0, 59]]);
});
test('6 Long-Term coverage rebuilds from 0 through 59', () => {
  assert.deepEqual(rebuilt().manifest.tier_coverage.longterm.committed_ranges.map((r) => [r.start_offset, r.end_offset]), [[0, 59]]);
});
test('7 general committed coverage rebuilds from 0 through 59', () => {
  assert.deepEqual(rebuilt().manifest.committed_ranges.map((r) => [r.start_offset, r.end_offset]), [[0, 59]]);
});
test('8 committed message count becomes 60', () => assert.equal(rebuilt().committed_message_count, 60));
test('9 contiguous safe offset becomes 60', () => assert.equal(rebuilt().safe_resume_offset, 60));
test('10 canonical safe-offset query returns 60', () => assert.equal(getContiguousSafeSourceOffset(canonicalLedger()), 60));
test('11 next work is normal source traversal', () => assert.equal(rebuilt().selection.action, 'continue_source_traversal'));
test('12 next traversal starts at 60', () => assert.equal(rebuilt().selection.source_range.start_offset, 60));
test('13 next traversal ends at 79', () => assert.equal(rebuilt().selection.source_range.end_offset, 79));
test('14 Resume never selects stale 40-59', () => assert.notEqual(rebuilt().selection.source_range.start_offset, 40));
test('15 committed root skips partial verification', () => assert.equal(shouldVerifyPersistedPartialSessionRecords({
  canonical_obligation: { current_state: 'durably_committed', checkpoint_eligible: true,
    source_range: { start: 40, end: 59 } },
  recovery_state: { resume_unresolved_obligation: true, unresolved_semantic_units: ['x'],
    durably_persisted_record_ids: ['record'] }, selected_range: { start: 40, end: 59 },
  selected_action: 'recover',
}), false));
test('16 genuine exact pending recovery invokes strict verification', () => assert.equal(shouldVerifyPersistedPartialSessionRecords({
  canonical_obligation: { obligation_id: 'session:chat:40-59:fixture', source_fingerprint: 'fixture-40-59',
    current_state: 'pending_recovery', checkpoint_eligible: false,
    source_range: { start: 40, end: 59 } },
  recovery_state: { root_obligation_id: 'session:chat:40-59:fixture', source_fingerprint: 'fixture-40-59',
    source_range: { start: 40, end: 59 }, selected_recovery_action: 'fragment_decision_regeneration',
    resume_unresolved_obligation: true, unresolved_semantic_units: ['x'], durably_persisted_record_ids: ['record'] },
  selected_range: { start: 40, end: 59 },
  selected_action: 'fragment_decision_regeneration',
}), true));
test('17 a mismatched selected range cannot invoke verification', () => assert.equal(shouldVerifyPersistedPartialSessionRecords({
  canonical_obligation: { current_state: 'pending_recovery', source_range: { start: 40, end: 59 } },
  recovery_state: { resume_unresolved_obligation: true, unresolved_semantic_units: ['x'],
    durably_persisted_record_ids: ['record'] }, selected_range: { start: 60, end: 79 }, selected_action: 'recover',
}), false));
test('17b mismatched recovery root identity cannot invoke verification', () => assert.equal(shouldVerifyPersistedPartialSessionRecords({
  canonical_obligation: { obligation_id: 'session:chat:40-59:fixture', source_fingerprint: 'fixture-40-59',
    current_state: 'pending_recovery', source_range: { start: 40, end: 59 } },
  recovery_state: { root_obligation_id: 'session:chat:20-39:fixture', source_fingerprint: 'fixture-40-59',
    resume_unresolved_obligation: true, unresolved_semantic_units: ['x'], durably_persisted_record_ids: ['record'] },
  selected_range: { start: 40, end: 59 }, selected_action: 'recover',
}), false));
test('17c mismatched recovery fingerprint cannot invoke verification', () => assert.equal(shouldVerifyPersistedPartialSessionRecords({
  canonical_obligation: { obligation_id: 'session:chat:40-59:fixture', source_fingerprint: 'fixture-40-59',
    current_state: 'pending_recovery', source_range: { start: 40, end: 59 } },
  recovery_state: { root_obligation_id: 'session:chat:40-59:fixture', source_fingerprint: 'other-window',
    resume_unresolved_obligation: true, unresolved_semantic_units: ['x'], durably_persisted_record_ids: ['record'] },
  selected_range: { start: 40, end: 59 }, selected_action: 'recover',
}), false));
test('18 missing durable record fails strict verification', () => assert.equal(verifyPersistedPartialSessionRecords([], {
  durably_persisted_record_ids: ['record'] }, { start: 40, end: 59 }).verified, false));
test('19 explicit alias verifies a canonicalized durable record', () => assert.equal(verifyPersistedPartialSessionRecords([
  { id: 'canonical-record', source_message_indices: [41] }], {
  durably_persisted_record_ids: ['old-record'], durable_record_aliases: { 'old-record': 'canonical-record' },
}, { start: 40, end: 59 }).verified, true));
test('20 unrelated range evidence never substitutes for an expected durable ID', () => assert.equal(verifyPersistedPartialSessionRecords([
  { id: 'other', source_message_indices: [41] }], { durably_persisted_record_ids: ['record'] },
{ start: 40, end: 59 }).verified, false));

function staleRecoveryMetadata() {
  return { active_catchup_run_id: fixture.logical_run_id, live_memory_health: { provider_attempt_audit: {
    schema_version: 11, run_id: fixture.logical_run_id, attempted: 1, running_count: 0,
    terminal_counts: { provider_failure: 1 }, recent_attempts: [],
    obligations: { 'session:chat:40-59:fixture': {
      logical_obligation_id: 'session:chat:40-59:fixture', tier: 'session', malformed_count: 1,
      provider_failure_count: 0, validation_failure_count: 0, terminal_outcome: 'recovery_in_progress',
      recovery_windows: { 'fixture-40-59': { unresolved_semantic_units: ['fragment'],
        unresolved_fragments: [{ fragment_id: 'fragment', state: 'pending', raw: 'private' }],
        durably_persisted_record_ids: ['record'], active_recovery_epoch: { status: 'running' } } },
    } }, malformed_reason_counts: { malformed: 1 }, notice_reason_counts: {},
    request_kind_counts: {}, repair_reason_counts: {}, recovery_stage_request_counts: {},
    recoveries_by_stage: {}, recovery_effectiveness: {}, archived_obligation_counts: { exact: true },
  } } };
}
test('21 stale recovery windows are retired by canonical root completion', () => {
  const metadata = staleRecoveryMetadata();
  assert.equal(reconcileProviderRecoveryWindowsFromLedger(metadata, canonicalLedger()).retired_windows.length, 1);
});
test('22 retired windows cannot be restored as active recovery', () => {
  const metadata = staleRecoveryMetadata(); reconcileProviderRecoveryWindowsFromLedger(metadata, canonicalLedger());
  assert.equal(readProviderRecoveryWindowState(metadata, 'session:chat:40-59:fixture', 'fixture-40-59'), null);
});
test('23 retirement preserves durable record IDs', () => {
  const metadata = staleRecoveryMetadata(); reconcileProviderRecoveryWindowsFromLedger(metadata, canonicalLedger());
  assert.deepEqual(metadata.live_memory_health.provider_attempt_audit.obligations['session:chat:40-59:fixture']
    .recovery_windows['fixture-40-59'].retained_durable_record_ids, ['record']);
});
test('24 retirement clears private pending fragments', () => {
  const metadata = staleRecoveryMetadata(); reconcileProviderRecoveryWindowsFromLedger(metadata, canonicalLedger());
  const fragment = metadata.live_memory_health.provider_attempt_audit.obligations['session:chat:40-59:fixture']
    .recovery_windows['fixture-40-59'].unresolved_fragments[0];
  assert.equal(fragment.state, 'superseded_by_canonical_commit'); assert.equal(fragment.raw, undefined);
});
test('25 recovery-window retirement is idempotent', () => {
  const metadata = staleRecoveryMetadata(); reconcileProviderRecoveryWindowsFromLedger(metadata, canonicalLedger());
  assert.equal(reconcileProviderRecoveryWindowsFromLedger(metadata, canonicalLedger()).mutations, 0);
});
test('26 projection rebuild makes no provider calls', () => assert.equal(rebuilt().provider_calls, 0));
test('27 projection rebuild makes no persistence calls', () => assert.equal(rebuilt().persistence_calls, 0));
test('28 projection rebuild preserves attempt history', () => assert.equal(rebuilt().manifest.total_attempt_count, 3));
test('29 second projection pass is mutation-free', () => {
  const first = rebuilt(); const second = rebuildMemorizeCompatibilityProjection(first.manifest, {
    source_message_count: fixture.source_message_count, chunk_size: 20, enabled_tiers: ['longterm', 'session'],
  }); assert.equal(second.mutations, 0);
});
test('30 no actionable recovery exists after repair', () => assert.equal(getFirstActionableObligation(canonicalLedger()), null));
test('31 direct next-range query always has an executable action', () => assert.equal(
  getNextSourceTraversalRange(canonicalLedger(), { source_message_count: 9434, chunk_size: 20 }).action,
  'continue_source_traversal'));
test('32 canonical coverage cannot be downgraded by stale compatibility', () => assert.equal(
  isAuthoritativeTierRangeSafelyCovered(staleManifest().obligation_ledger, 'session', { start: 40, end: 59 }), true));

test('33 journal-backed candidate mappings repair all three records without duplication', () => {
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id);
  const item = identity('session', null, 0, 19);
  const ids = Object.keys(fixture.candidate_mappings); complete(ledger, item, ids);
  const journal = [{ attempt_id: 'provider-mw2lfprg-3', root_obligation_id: item.obligation_id,
    child_obligation_id: item.obligation_id, terminal_outcome: 'completed',
    tier: 'session', source_range: item.source_range, source_fingerprint: item.source_fingerprint,
    parser_result: { status: 'accepted' }, validation: { status: 'accepted' },
    persistence: { status: 'committed', durable_record_ids: ids }, manifest_transition: { status: 'applied' },
    validated_record_identities: ids.map((id) => ({ id, candidate_id: fixture.candidate_mappings[id] })) }];
  const first = reconcileMemorizeLifecycleFromJournal(ledger, { journal });
  assert.deepEqual(first.ledger.obligations[item.obligation_id].lifecycle.durable_record_candidate_map,
    fixture.candidate_mappings);
  assert.equal(reconcileMemorizeLifecycleFromJournal(ledger, { journal }).mutations, 0);
});

test('34 beginRegisteredAttempt emits the semantic running event before dispatch returns', async () => {
  const events = []; const execution = createMemorizeExecutionContext({ hooks: {
    obligation_event: async (event) => events.push(event.type),
  } });
  const pipeline = createMemorizeTierPipeline({ tier: 'longterm', tierLabel: 'Long-Term', owner: 'Taylor',
    execution, metadata: {}, range: { start: 0, end: 19, message_count: 20, source_indices: [0] },
    rangeId: 'range', coverageLedger: { records: [] }, sourceFingerprint: 'fingerprint',
    preflight: { configured_context_limit: 8192, effective_context_limit: 8192,
      reserved_output_tokens: 100, safety_margin_tokens: 10, protocol_overhead_tokens: 10,
      estimated_input_tokens: 100 }, requestBudget: {}, providerConfigSignature: 'config', chatId: 'chat',
    expectedOutputFormat: 'longterm-v1' });
  const attempt = await pipeline.beginRegisteredAttempt();
  assert.ok(attempt.attempt_id); assert.deepEqual(events, ['provider_attempt_started']);
});
test('35 current and reconciled lifecycle violations remain separately classified', () => {
  const ledger = canonicalLedger();
  ledger.historical_transition_observations = [{ classification: 'reconciled_from_provider_completion_journal' }];
  ledger.transition_violations = [{ classification: 'current_runtime' }];
  assert.equal(ledger.transition_violations[0].classification, 'current_runtime');
  assert.equal(ledger.historical_transition_observations[0].classification,
    'reconciled_from_provider_completion_journal');
});
test('36 failed-obligation identity partition is exposed after canonical retirement', () => {
  const metadata = staleRecoveryMetadata(); reconcileProviderRecoveryWindowsFromLedger(metadata, canonicalLedger());
  const summary = summarizeProviderAttemptAudit(metadata);
  assert.deepEqual(summary.failed_obligation_dispositions.recovered, ['session:chat:40-59:fixture']);
});
test('37 run accounting includes recovery-in-progress in the exact partition', () => {
  const accounting = deriveRunErrorAccounting({ provider_attempt_audit: { obligation_aggregate_counts_exact: true,
    failure_accounting: { unique_failed_obligation_count: 3, recovered_failed_obligation_count: 2,
      recovery_in_progress_obligation_count: 1, operationally_paused_obligation_count: 0,
      terminal_unresolved_obligation_count: 0, physical_failure_observation_count: 3,
      malformed_response_count: 3, parser_structural_failure_count: 3,
      provider_transport_failure_count: 0, validation_failure_count: 0 } } });
  assert.equal(accounting.reconciliation.recovered_plus_unresolved_equals_failed, true);
  assert.equal(accounting.reconciliation.consistent, true);
});

test('38 source-index gaps project onto contiguous processing offsets without replaying committed work', () => {
  const ledger = createMemorizeObligationLedger('coordinate-gap-run');
  complete(ledger, { ...identity('session', null, 2, 21), logical_run_id: 'coordinate-gap-run' });
  complete(ledger, { ...identity('longterm', 'Taylor', 2, 21), logical_run_id: 'coordinate-gap-run' });
  const result = rebuildMemorizeCompatibilityProjection({
    logical_run_id: 'coordinate-gap-run', obligation_ledger: ledger,
  }, {
    source_message_count: 100, chunk_size: 20, enabled_tiers: ['longterm', 'session'],
    coordinate_ranges: [{ start_offset: 40, end_offset: 59,
      source_start_index: 2, source_end_index: 21 }],
  });
  assert.deepEqual(result.manifest.committed_ranges.map((range) => [
    range.start_offset, range.end_offset, range.source_start_index, range.source_end_index,
  ]), [[0, 19, 2, 21]]);
  assert.equal(result.safe_resume_offset, 20);
  assert.equal(result.selection.action, 'continue_source_traversal');
  assert.deepEqual([result.selection.source_range.start_offset,
    result.selection.source_range.end_offset], [20, 39]);
});
test('39 a fully covered source-index-gap run advances to finalization', () => {
  const ledger = createMemorizeObligationLedger('coordinate-gap-complete');
  complete(ledger, { ...identity('session', null, 2, 21), logical_run_id: 'coordinate-gap-complete' });
  complete(ledger, { ...identity('longterm', 'Taylor', 2, 21), logical_run_id: 'coordinate-gap-complete' });
  const result = rebuildMemorizeCompatibilityProjection({
    logical_run_id: 'coordinate-gap-complete', obligation_ledger: ledger,
    committed_ranges: [{ start_offset: 40, end_offset: 59,
      source_start_index: 2, source_end_index: 21 }],
  }, { source_message_count: 20, chunk_size: 20, enabled_tiers: ['longterm', 'session'] });
  assert.equal(result.safe_resume_offset, 20);
  assert.equal(result.selection.action, 'continue_finalization');
  assert.equal(result.selection.source_range, null);
});

for (const staleSession of [false, true]) for (const repeat of [false, true]) {
  test(`property projection is monotonic (stale=${staleSession}, repeat=${repeat})`, () => {
    const manifest = staleManifest();
    if (!staleSession) manifest.tier_coverage.session.committed_ranges = [{ start_offset: 0, end_offset: 59 }];
    const first = rebuildMemorizeCompatibilityProjection(manifest, {
      source_message_count: 9434, chunk_size: 20, enabled_tiers: ['longterm', 'session'],
    });
    const result = repeat ? rebuildMemorizeCompatibilityProjection(first.manifest, {
      source_message_count: 9434, chunk_size: 20, enabled_tiers: ['longterm', 'session'],
    }) : first;
    assert.equal(result.safe_resume_offset, 60);
    assert.equal(result.selection.source_range.start_offset, 60);
    assert.equal(projectMemorizeObligationLedger(result.manifest.obligation_ledger).pending_obligation_count, 0);
  });
}
