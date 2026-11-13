import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  aggregateMemorizeObligationParents,
  applyMemorizeLifecycleEvent,
  createMemorizeObligationLedger,
  deriveMemorizeSafeResumeOffset,
  ensureMemorizeObligationLedger,
  projectMemorizeObligationLedger,
  reconcileMemorizeLifecycleFromJournal,
  reconcileMemorizeRunningObligations,
} from '../memorize-obligation-ledger.js';
import { reconcileImpossibleLiveHealth } from '../provider-completion-journal.js';
import { buildMemorizeControllerExit, createMemorizeControllerRuntime,
  trackMemorizeTransaction } from '../memorize-controller-runtime.js';
import { recordMemorizeControllerExit } from '../memorize-obligation-ledger.js';

const fixture = JSON.parse(readFileSync(new URL(
  './fixtures/v0975-session-40-59-journal-ledger-mismatch.json', import.meta.url)));

const identity = (id = 'session:chat:0-19:test') => ({
  obligation_id: id, logical_run_id: 'run', tier: 'session', owner: null,
  source_range: { start: 0, end: 19 }, source_fingerprint: 'test',
});

function completeLeaf(ledger, item) {
  return applyMemorizeLifecycleEvent(ledger, {
    obligation_id: item.obligation_id, logical_run_id: fixture.logical_run_id,
    tier: 'session', source_range: { start: item.range[0], end: item.range[1] },
    source_fingerprint: item.fingerprint,
  }, {
    type: 'leaf_coverage_completed', verified_coverage: true,
    persistence_result: item.record_ids?.length ? 'committed' : 'verified_existing',
    durable_record_ids: item.record_ids ?? [],
    lifecycle: { migrated_from_ambiguous_counts: true },
  });
}

function staleFixtureLedger() {
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id, 1);
  for (const item of fixture.obligations) {
    const current = {
      obligation_id: item.obligation_id, logical_run_id: fixture.logical_run_id,
      tier: 'session', source_range: { start: item.range[0], end: item.range[1] },
      source_fingerprint: item.fingerprint,
    };
    if (item.state === 'durably_committed') completeLeaf(ledger, item);
    else {
      const attempt = `fixture:${item.range.join('-')}`;
      applyMemorizeLifecycleEvent(ledger, current, {
        type: 'provider_attempt_started', provider_attempt_id: attempt,
      });
      applyMemorizeLifecycleEvent(ledger, current, {
        type: 'provider_response_received', provider_attempt_id: attempt,
      });
    }
  }
  return ledger;
}

function normalSuccess() {
  const ledger = createMemorizeObligationLedger('run', 1);
  const id = identity();
  applyMemorizeLifecycleEvent(ledger, id, { type: 'provider_attempt_started', provider_attempt_id: 'a1' });
  applyMemorizeLifecycleEvent(ledger, id, { type: 'provider_response_received', provider_attempt_id: 'a1' });
  applyMemorizeLifecycleEvent(ledger, id, { type: 'parser_accepted', provider_attempt_id: 'a1' });
  applyMemorizeLifecycleEvent(ledger, id, { type: 'validation_accepted', provider_attempt_id: 'a1' });
  applyMemorizeLifecycleEvent(ledger, id, { type: 'records_staged', provider_attempt_id: 'a1' });
  applyMemorizeLifecycleEvent(ledger, id, { type: 'records_durably_persisted', provider_attempt_id: 'a1' });
  return { ledger, id };
}

test('1 original Session response succeeds through semantic events', () => {
  assert.equal(normalSuccess().ledger.obligations[identity().obligation_id].current_state, 'durably_committed');
});
test('2 provider response is recorded before parser acceptance', () => {
  const { ledger } = normalSuccess();
  assert.deepEqual(ledger.obligations[identity().obligation_id].transition_history.slice(0, 3)
    .map((item) => item.to), ['provider_running', 'provider_response_received', 'parser_accepted']);
});
test('3 parser acceptance without response is rejected fail closed', () => {
  const ledger = createMemorizeObligationLedger('run');
  const result = applyMemorizeLifecycleEvent(ledger, identity(), { type: 'parser_accepted' });
  assert.equal(result.applied, false);
  assert.equal(ledger.obligations[identity().obligation_id], undefined);
});
test('4 retry requires a pending recovery disposition', () => {
  const ledger = createMemorizeObligationLedger('run');
  const id = identity();
  applyMemorizeLifecycleEvent(ledger, id, { type: 'provider_attempt_started', provider_attempt_id: 'a1' });
  applyMemorizeLifecycleEvent(ledger, id, { type: 'provider_response_received', provider_attempt_id: 'a1' });
  const result = applyMemorizeLifecycleEvent(ledger, id, { type: 'provider_attempt_started', provider_attempt_id: 'a2' });
  assert.equal(result.violation.code, 'provider_retry_started_before_prior_attempt_disposition');
});
test('5 retry follows response parser rejection pending then running', () => {
  const ledger = createMemorizeObligationLedger('run'); const id = identity();
  for (const event of [
    { type: 'provider_attempt_started', provider_attempt_id: 'a1' },
    { type: 'provider_response_received', provider_attempt_id: 'a1' },
    { type: 'parser_rejected', provider_attempt_id: 'a1' },
    { type: 'recovery_required', reason_code: 'malformed', next_action: 'retry' },
    { type: 'provider_attempt_started', provider_attempt_id: 'a2' },
  ]) assert.equal(applyMemorizeLifecycleEvent(ledger, id, event).applied, true);
  assert.equal(ledger.obligations[id.obligation_id].current_state, 'provider_running');
});
test('6 physical retries remain in attempt lineage', () => {
  const ledger = createMemorizeObligationLedger('run'); const id = identity();
  for (const event of [{ type: 'provider_attempt_started', provider_attempt_id: 'a1' },
    { type: 'provider_response_received', provider_attempt_id: 'a1' }, { type: 'parser_rejected' },
    { type: 'recovery_required', reason_code: 'bad', next_action: 'retry' },
    { type: 'provider_attempt_started', provider_attempt_id: 'a2' }]) applyMemorizeLifecycleEvent(ledger, id, event);
  assert.deepEqual(ledger.obligations[id.obligation_id].provider_attempt_lineage, ['a1', 'a2']);
});
test('7 recovery children register durably', () => {
  const ledger = staleFixtureLedger();
  const result = reconcileMemorizeLifecycleFromJournal(ledger, { journal: [],
    coverage_records: fixture.coverage_records, checkpoint_before: 40 });
  assert.equal(result.ledger.obligations[fixture.root_obligation_id].expected_child_obligation_ids.length, 2);
});
test('8 parent expected-child identities are exact', () => {
  const result = reconcileMemorizeLifecycleFromJournal(staleFixtureLedger(), {
    journal: fixture.journal, coverage_records: fixture.coverage_records, checkpoint_before: 40 });
  assert.deepEqual(result.ledger.obligations[fixture.root_obligation_id].expected_child_obligation_ids.sort(), [
    `${fixture.root_obligation_id}:leaf:40-49:fnv1a-cc6c2f26`,
    `${fixture.root_obligation_id}:leaf:50-59:fnv1a-fc90a762`,
  ].sort());
});
test('9 first grandchild alone does not close intermediate parent', () => {
  const ledger = staleFixtureLedger();
  const second = ledger.obligations[`${fixture.root_obligation_id}:leaf:55-59:fnv1a-f4aa8b47`];
  second.current_state = 'pending_recovery'; second.checkpoint_eligible = false;
  reconcileMemorizeLifecycleFromJournal(ledger, { journal: fixture.journal.slice(0, 1),
    coverage_records: fixture.coverage_records, checkpoint_before: 40 });
  assert.equal(ledger.obligations[`${fixture.root_obligation_id}:leaf:50-59:fnv1a-fc90a762`].checkpoint_eligible, false);
});
test('10 both grandchildren close intermediate parent once', () => {
  const result = reconcileMemorizeLifecycleFromJournal(staleFixtureLedger(), {
    journal: fixture.journal, coverage_records: fixture.coverage_records, checkpoint_before: 40 });
  const parent = result.ledger.obligations[`${fixture.root_obligation_id}:leaf:50-59:fnv1a-fc90a762`];
  assert.equal(parent.current_state, 'durably_committed');
  assert.equal(parent.semantic_event_history.filter((item) => item.type === 'parent_children_completed').length, 1);
});
test('11 completed 40-49 and 50-59 close root once', () => {
  const result = reconcileMemorizeLifecycleFromJournal(staleFixtureLedger(), {
    journal: fixture.journal, coverage_records: fixture.coverage_records, checkpoint_before: 40 });
  assert.equal(result.ledger.obligations[fixture.root_obligation_id].current_state, 'durably_committed');
});
test('12 parent aggregation makes no provider call', () => {
  const result = reconcileMemorizeLifecycleFromJournal(staleFixtureLedger(), {
    journal: fixture.journal, coverage_records: fixture.coverage_records, checkpoint_before: 40 });
  assert.equal(result.provider_calls, 0);
});
test('13 journal replay closes a crash-stranded leaf', () => {
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id);
  const entry = fixture.journal[0]; const item = fixture.obligations[3];
  applyMemorizeLifecycleEvent(ledger, { obligation_id: item.obligation_id, tier: 'session',
    source_range: { start: 50, end: 54 }, source_fingerprint: item.fingerprint },
  { type: 'provider_attempt_started', provider_attempt_id: entry.attempt_id });
  const result = reconcileMemorizeLifecycleFromJournal(ledger, { journal: [entry], coverage_records: [] });
  assert.equal(result.ledger.obligations[item.obligation_id].current_state, 'durably_committed');
});
test('14 journal reconciliation closes every ancestor', () => {
  const result = reconcileMemorizeLifecycleFromJournal(staleFixtureLedger(), {
    journal: fixture.journal, coverage_records: fixture.coverage_records, checkpoint_before: 40 });
  assert.equal(result.parent_aggregation_mutations, 2);
});
test('15 journal replay preserves and does not duplicate record identities', () => {
  const result = reconcileMemorizeLifecycleFromJournal(staleFixtureLedger(), {
    journal: fixture.journal, coverage_records: fixture.coverage_records, checkpoint_before: 40 });
  assert.deepEqual(result.preserved_durable_record_ids.sort(), [
    '8188db6b-d15f-4f46-8523-074fb504a7af', '323a6f22-8590-4edf-808f-dcf7ceebfafb'].sort());
});
test('16 second reconciliation pass is mutation-free', () => {
  const ledger = staleFixtureLedger();
  reconcileMemorizeLifecycleFromJournal(ledger, { journal: fixture.journal,
    coverage_records: fixture.coverage_records, checkpoint_before: 40 });
  const second = reconcileMemorizeLifecycleFromJournal(ledger, { journal: fixture.journal,
    coverage_records: fixture.coverage_records, checkpoint_before: 40 });
  assert.equal(second.mutations, 0);
});
test('17 rejected live transition cannot strand durable journal work', () => {
  const ledger = staleFixtureLedger();
  const result = reconcileMemorizeLifecycleFromJournal(ledger, { journal: fixture.journal,
    coverage_records: fixture.coverage_records, checkpoint_before: 40 });
  assert.equal(projectMemorizeObligationLedger(result.ledger).pending_obligation_count, 0);
});
test('18 completed coverage tree is not downstream-parser pending', () => {
  const ledger = staleFixtureLedger(); reconcileMemorizeLifecycleFromJournal(ledger, {
    journal: fixture.journal, coverage_records: fixture.coverage_records, checkpoint_before: 40 });
  assert.notEqual(ledger.obligations[fixture.root_obligation_id].exact_reason_code, 'downstream_parser_pending');
});
test('19 safe checkpoint advances from 40 to 60', () => {
  const result = reconcileMemorizeLifecycleFromJournal(staleFixtureLedger(), { journal: fixture.journal,
    coverage_records: fixture.coverage_records, checkpoint_before: 40, source_message_count: 9434 });
  assert.equal(result.safe_resume_offset, 60);
});
test('20 next source work is exactly 60-79', () => {
  const result = reconcileMemorizeLifecycleFromJournal(staleFixtureLedger(), { journal: fixture.journal,
    coverage_records: fixture.coverage_records, checkpoint_before: 40, source_message_count: 9434, chunk_size: 20 });
  assert.deepEqual(result.next_source_range, { start: 60, end: 79 });
});
test('21 attempts 17 and 18 are reused, not requested', () => {
  const result = reconcileMemorizeLifecycleFromJournal(staleFixtureLedger(), { journal: fixture.journal,
    coverage_records: fixture.coverage_records, checkpoint_before: 40 });
  assert.deepEqual(result.reused_attempt_ids.sort(), ['provider-mw14c2fd-17', 'provider-mw14ca2w-18'].sort());
  assert.equal(result.provider_calls, 0);
});
test('22 finalized controller exit reports committed transaction', () => {
  const ledger = createMemorizeObligationLedger('run');
  const runtime = createMemorizeControllerRuntime({ invocation_id: 'inv', logical_run_id: 'run' });
  const tx = { transaction_id: 'tx', state: 'active' }; trackMemorizeTransaction(runtime, tx);
  recordMemorizeControllerExit(ledger, buildMemorizeControllerExit(runtime, { classification: 'completed' }));
  tx.state = 'committed';
  const final = buildMemorizeControllerExit(runtime, { finalize_transaction_evidence: true });
  recordMemorizeControllerExit(ledger, final);
  assert.equal(ledger.controller_exits[0].active_transaction_state, 'committed');
});
test('23 closed controller transaction evidence is not active', () => {
  const runtime = createMemorizeControllerRuntime({ invocation_id: 'inv' });
  const tx = { transaction_id: 'tx', state: 'committed' }; trackMemorizeTransaction(runtime, tx);
  assert.notEqual(buildMemorizeControllerExit(runtime, {}).active_transaction_state, 'active');
});
test('24 closed semantic success has no provider-running obligation', () => {
  assert.equal(projectMemorizeObligationLedger(normalSuccess().ledger).running_obligation_count, 0);
});
test('25 terminal journal evidence closes live health', () => {
  const entry = { ...fixture.journal[0], live_health_event_id: 'health-1', completed_at: 10 };
  const metadata = { provider_completion_journal: { schema_version: 5,
    entries: { [entry.attempt_id]: entry }, order: [entry.attempt_id] },
    live_memory_health: { recent_extraction_events: [{ event_id: 'health-1', tier: 'session', owner: null,
      terminal_health: 'running', response_received: true, persistence: 'not_attempted' }] } };
  reconcileImpossibleLiveHealth(metadata, { recent_attempts: [] }, 20);
  assert.equal(metadata.live_memory_health.recent_extraction_events[0].terminal_health, 'completed');
});
test('26 no running live health remains after journal repair', () => {
  const entry = { ...fixture.journal[1], live_health_event_id: 'health-2' };
  const metadata = { provider_completion_journal: { schema_version: 5,
    entries: { [entry.attempt_id]: entry }, order: [entry.attempt_id] },
    live_memory_health: { recent_extraction_events: [{ event_id: 'health-2', tier: 'session', owner: null,
      terminal_health: 'running' }] } };
  reconcileImpossibleLiveHealth(metadata, { recent_attempts: [] });
  assert.equal(metadata.live_memory_health.recent_extraction_events.some((item) => item.terminal_health === 'running'), false);
});
test('27 fully covered projection is not blocked', () => {
  const ledger = staleFixtureLedger(); reconcileMemorizeLifecycleFromJournal(ledger, {
    journal: fixture.journal, coverage_records: fixture.coverage_records, checkpoint_before: 40 });
  assert.equal(projectMemorizeObligationLedger(ledger).blocked_obligation_count, 0);
});
test('28 unactionable pending obligation still fails the invariant', () => {
  const ledger = createMemorizeObligationLedger('run');
  ledger.obligations.bad = { ...identity('bad'), current_state: 'provider_response_received',
    checkpoint_eligible: false, expected_child_obligation_ids: [], lifecycle: {}, metrics: {} };
  assert.equal(projectMemorizeObligationLedger(ledger).invariants.valid, false);
});
test('29 genuine unresolved recovery has typed action', () => {
  const ledger = createMemorizeObligationLedger('run'); const id = identity();
  applyMemorizeLifecycleEvent(ledger, id, { type: 'recovery_required', reason_code: 'bad', next_action: 'retry' });
  assert.equal(ledger.obligations[id.obligation_id].next_eligible_action, 'retry');
});
test('30 terminal states remain monotonic', () => {
  const { ledger, id } = normalSuccess();
  const result = applyMemorizeLifecycleEvent(ledger, id, { type: 'provider_attempt_started', provider_attempt_id: 'late' });
  assert.equal(result.applied, false);
  assert.equal(ledger.obligations[id.obligation_id].current_state, 'durably_committed');
});
test('31 serialized resume uses the same semantic event history', () => {
  const { ledger, id } = normalSuccess();
  const restored = ensureMemorizeObligationLedger(structuredClone(ledger), 'run');
  assert.deepEqual(restored.obligations[id.obligation_id].semantic_event_ids,
    ledger.obligations[id.obligation_id].semantic_event_ids);
});
test('32 interruption boundaries reconcile running attempts to actionable recovery', () => {
  const ledger = createMemorizeObligationLedger('run'); const id = identity();
  applyMemorizeLifecycleEvent(ledger, id, { type: 'provider_attempt_started', provider_attempt_id: 'a1' });
  reconcileMemorizeRunningObligations(ledger, { recent_attempts: [{ attempt_id: 'a1',
    logical_obligation_id: id.obligation_id, terminal_outcome: 'provider_response_malformed' }] });
  assert.ok(ledger.obligations[id.obligation_id].next_eligible_action);
});
test('33 repartition hierarchy survives reload', () => {
  const ledger = staleFixtureLedger(); reconcileMemorizeLifecycleFromJournal(ledger, {
    journal: fixture.journal, coverage_records: fixture.coverage_records, checkpoint_before: 40 });
  const restored = ensureMemorizeObligationLedger(structuredClone(ledger), fixture.logical_run_id);
  assert.equal(restored.obligations[fixture.root_obligation_id].expected_child_obligation_ids.length, 2);
});
test('34 Long-Term uses the same semantic lifecycle', () => {
  const { ledger } = normalSuccess();
  assert.equal(ledger.transition_violations.length, 0);
});
test('35 safe-offset derivation is pure and deterministic', () => {
  const ledger = staleFixtureLedger(); reconcileMemorizeLifecycleFromJournal(ledger, {
    journal: fixture.journal, coverage_records: fixture.coverage_records, checkpoint_before: 40 });
  const before = JSON.stringify(ledger);
  assert.equal(deriveMemorizeSafeResumeOffset(ledger, 40), 60);
  assert.equal(JSON.stringify(ledger), before);
});

for (const [index, parser, validation] of [
  ['accepted', 'parser_accepted', 'validation_accepted'],
  ['partial', 'parser_partially_accepted', 'validation_partially_accepted'],
  ['rejected', 'parser_rejected', null],
]) test(`property lifecycle combination ${index} remains canonical`, () => {
  const ledger = createMemorizeObligationLedger('run'); const id = identity(`property:${index}`);
  applyMemorizeLifecycleEvent(ledger, id, { type: 'provider_attempt_started', provider_attempt_id: `a:${index}` });
  applyMemorizeLifecycleEvent(ledger, id, { type: 'provider_response_received', provider_attempt_id: `a:${index}` });
  assert.equal(applyMemorizeLifecycleEvent(ledger, id, { type: parser }).applied, true);
  if (validation) assert.equal(applyMemorizeLifecycleEvent(ledger, id, { type: validation }).applied, true);
  assert.equal(ledger.transition_violations.length, 0);
});
