import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { beginProviderAttempt, reconcileProviderAttemptIdentitiesFromJournal }
  from '../provider-attempt-audit.js';
import { recordProviderCompletion } from '../provider-completion-journal.js';
import { acknowledgeJournalTransition, requireAppliedLifecycleResult }
  from '../memorize-lifecycle-coordinator.js';
import { createMemorizeExecutionContext } from '../memorize-execution-context.js';
import { createMemorizeTierPipeline } from '../memorize-tier-pipeline.js';
import {
  applyMemorizeLifecycleEvent,
  createMemorizeObligationLedger,
  reconcileMemorizeLifecycleFromJournal,
} from '../memorize-obligation-ledger.js';

const fixture = JSON.parse(readFileSync(new URL(
  './fixtures/v0978-stranded-terminal-leaf.json', import.meta.url)));

function identity(item, root = fixture.root_obligation_id) {
  return {
    obligation_id: item.obligation_id,
    root_obligation_id: root,
    logical_run_id: fixture.logical_run_id,
    tier: 'session', owner: null,
    source_range: { start: item.range[0], end: item.range[1],
      message_count: item.range[1] - item.range[0] + 1 },
    source_fingerprint: item.fingerprint,
    parent_obligation_id: root === item.obligation_id ? null : root,
  };
}

function strandedLedger() {
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id, 1);
  const root = {
    obligation_id: fixture.root_obligation_id,
    logical_run_id: fixture.logical_run_id,
    tier: 'session', owner: null,
    source_range: { start: 20, end: 39, message_count: 20 },
    source_fingerprint: 'fnv1a-eeb22053',
  };
  applyMemorizeLifecycleEvent(ledger, root, {
    type: 'recovery_children_declared',
    children: fixture.children.map((item) => identity(item)),
    event_id: 'fixture:children', at: 2,
  });
  const first = fixture.children[0];
  applyMemorizeLifecycleEvent(ledger, identity(first), {
    type: 'provider_attempt_started', provider_attempt_id: first.attempt_id, at: 3,
  });
  applyMemorizeLifecycleEvent(ledger, identity(first), {
    type: 'recovery_required', reason_code: 'provider_attempt_registration_required',
    next_action: 'resume_exact_obligation', at: 4,
  });
  const second = fixture.children[1];
  const candidateMap = Object.fromEntries(fixture.journal[2].validated_record_identities
    .map((item) => [item.id, item.candidate_id]));
  applyMemorizeLifecycleEvent(ledger, identity(second), {
    type: 'leaf_coverage_completed', verified_coverage: true,
    durable_record_ids: second.record_ids,
    lifecycle: { parser_accepted_candidate_ids: Object.values(candidateMap),
      downstream_accepted_candidate_ids: Object.values(candidateMap),
      durable_record_candidate_map: candidateMap },
    at: 5,
  });
  const noUpdate = { obligation_id: 'session:chat:0-19:fnv1a-39c6c9f',
    range: [0, 19], fingerprint: 'fnv1a-39c6c9f' };
  applyMemorizeLifecycleEvent(ledger, identity(noUpdate, noUpdate.obligation_id), {
    type: 'leaf_coverage_completed', verified_coverage: true,
    explicit_no_update: true, at: 6,
  });
  return ledger;
}

test('physical attempt retains immutable root and exact leaf identities', () => {
  const metadata = { active_catchup_run_id: fixture.logical_run_id };
  const child = fixture.children[0];
  const attempt = beginProviderAttempt(metadata, {
    tier: 'session', logical_obligation_id: fixture.root_obligation_id,
    child_obligation_id: child.obligation_id,
    source_range: { start: 20, end: 29, message_count: 10 },
    source_fingerprint: child.fingerprint,
  });
  assert.equal(attempt.root_obligation_id, fixture.root_obligation_id);
  assert.equal(attempt.child_obligation_id, child.obligation_id);
  assert.equal(attempt.leaf_obligation_id, child.obligation_id);
});

test('legacy audit leaf identities migrate only from exact journal evidence', () => {
  const metadata = { live_memory_health: { provider_attempt_audit: {
    schema_version: 12, run_id: fixture.logical_run_id, recent_attempts: structuredClone(fixture.attempts),
    obligations: {}, sequence: 10, attempted: 10,
  } } };
  const result = reconcileProviderAttemptIdentitiesFromJournal(metadata, fixture.journal, 10);
  assert.deepEqual(result.repaired_attempt_ids.sort(), fixture.attempts.map((item) => item.attempt_id).sort());
  assert.equal(metadata.live_memory_health.provider_attempt_audit.recent_attempts[1].child_obligation_id,
    fixture.children[0].obligation_id);
});

test('callers cannot self-declare a journal ledger transition applied', () => {
  const metadata = {};
  const entry = recordProviderCompletion(metadata, fixture.attempts[1], {
    child_obligation_id: fixture.children[0].obligation_id,
    ledger_transition: { status: 'applied', disposition: 'durably_committed' },
  });
  assert.equal(entry.ledger_transition.status, 'pending_reconciliation');
  assert.equal(entry.ledger_transition.legacy_caller_assertion, 'applied');
});

test('reducer rejection cannot produce a verified journal acknowledgement', () => {
  const ledger = createMemorizeObligationLedger('run');
  const rejected = applyMemorizeLifecycleEvent(ledger, {
    obligation_id: 'session:chat:0-19:test', tier: 'session',
    source_range: { start: 0, end: 19 }, source_fingerprint: 'test',
  }, { type: 'parser_accepted' });
  assert.throws(() => requireAppliedLifecycleResult(rejected, ['parser_accepted']),
    { code: 'SME_LIFECYCLE_TRANSITION_REJECTED' });
  const entry = { ledger_transition: { status: 'pending' } };
  acknowledgeJournalTransition(entry, 'ledger_transition', { status: 'rejected' });
  assert.equal(entry.ledger_transition.status, 'rejected');
});

test('v0.9.78 terminal evidence repairs both leaves, parent, and attempt 3 locally', () => {
  const ledger = strandedLedger();
  assert.equal(ledger.obligations[fixture.children[0].obligation_id].current_state, 'pending_recovery');
  assert.equal(ledger.obligations[fixture.root_obligation_id].checkpoint_eligible, false);
  const journal = structuredClone(fixture.journal);
  const attempts = { recent_attempts: structuredClone(fixture.attempts) };
  const first = reconcileMemorizeLifecycleFromJournal(ledger, {
    logical_run_id: fixture.logical_run_id, journal, provider_attempts: attempts, at: 20,
  });
  assert.equal(first.provider_calls, 0);
  assert.equal(first.persistence_calls, 0);
  assert.equal(ledger.obligations[fixture.children[0].obligation_id].current_state, 'durably_committed');
  assert.equal(ledger.obligations[fixture.children[1].obligation_id].current_state, 'durably_committed');
  assert.equal(ledger.obligations[fixture.root_obligation_id].current_state, 'durably_committed');
  assert.deepEqual(ledger.obligations[fixture.children[0].obligation_id]
    .lifecycle.durably_persisted_record_ids, fixture.children[0].record_ids);
  assert.deepEqual(ledger.obligations[fixture.children[1].obligation_id]
    .lifecycle.durably_persisted_record_ids.sort(), [...fixture.children[1].record_ids].sort());
  assert.equal(journal[0].persistence.status, 'not_required_validated_no_update');
  assert.equal(journal[0].ledger_transition.status, 'idempotent_duplicate_verified');
  assert.equal(journal[1].ledger_transition.status, 'applied_verified');
  const second = reconcileMemorizeLifecycleFromJournal(ledger, {
    logical_run_id: fixture.logical_run_id, journal, provider_attempts: attempts, at: 20,
  });
  assert.equal(second.mutations, 0);
  assert.equal(second.provider_calls, 0);
  assert.equal(second.persistence_calls, 0);
});

test('parent cannot close while any registered child remains incomplete', () => {
  const ledger = strandedLedger();
  const result = applyMemorizeLifecycleEvent(ledger,
    ledger.obligations[fixture.root_obligation_id], {
      type: 'parent_children_completed', event_id: 'fixture:invalid-parent-close',
    });
  assert.equal(result.status, 'rejected');
  assert.equal(result.violation.code, 'parent_completion_without_complete_registered_children');
});

function pipelineInput(metadata, execution) {
  return {
    tier: 'session', tierLabel: 'Session', execution, metadata,
    range: { start: 0, end: 9, message_count: 10, source_indices: [0] },
    rangeId: 'session:0-9', coverageLedger: { records: [] },
    sourceFingerprint: 'fnv1a-pipeline',
    preflight: { configured_context_limit: 1000, effective_context_limit: 1000,
      reserved_output_tokens: 100, safety_margin_tokens: 10,
      protocol_overhead_tokens: 10, estimated_input_tokens: 100 },
    requestBudget: { runtimeContextLookup: null }, providerConfigSignature: 'config',
    chatId: 'chat', expectedOutputFormat: 'session_tagged_lines_v1',
  };
}

test('required shared pipeline stops before dispatch when reducer start is rejected', async () => {
  const metadata = { active_catchup_run_id: 'run' };
  const execution = createMemorizeExecutionContext({
    controller: { lifecycle_required: true },
    hooks: { obligation_event: async () => ({ applied: false, duplicate: false,
      violation: { code: 'fixture_rejection' } }) },
  });
  const pipeline = createMemorizeTierPipeline(pipelineInput(metadata, execution));
  await assert.rejects(pipeline.beginRegisteredAttempt(), {
    code: 'SME_LIFECYCLE_TRANSITION_REJECTED',
  });
});

test('shared pipeline writes verified terminal acknowledgement only after reducer success', async () => {
  const metadata = { active_catchup_run_id: 'run' };
  const ledger = createMemorizeObligationLedger('run');
  const execution = createMemorizeExecutionContext({
    controller: { lifecycle_required: true },
    hooks: {
      obligation_event: async (event) => applyMemorizeLifecycleEvent(ledger, event, event),
      provider_completion_journal_updated: async () => {},
    },
  });
  const pipeline = createMemorizeTierPipeline(pipelineInput(metadata, execution));
  const attempt = await pipeline.beginRegisteredAttempt();
  attempt.terminal_outcome = 'completed';
  const recordId = 'record-pipeline-1';
  const candidateId = 'candidate-pipeline-1';
  recordProviderCompletion(metadata, attempt, {
    child_obligation_id: pipeline.leafObligationId,
    parser_result: { status: 'accepted' }, validation: { status: 'accepted' },
    validated_record_identities: [{ id: recordId, candidate_id: candidateId }],
    persistence: { status: 'committed', durable_record_ids: [recordId] },
  });
  await pipeline.emitLifecycleEvent('provider_response_received', { provider_attempt_id: attempt.attempt_id });
  await pipeline.emitLifecycleEvent('parser_accepted', { provider_attempt_id: attempt.attempt_id });
  await pipeline.emitLifecycleEvent('validation_accepted', { provider_attempt_id: attempt.attempt_id });
  await pipeline.emitLifecycleEvent('records_staged', { provider_attempt_id: attempt.attempt_id });
  await pipeline.emitLifecycleEvent('records_durably_persisted', {
    provider_attempt_id: attempt.attempt_id,
    durable_record_ids: [recordId],
    lifecycle: { parser_accepted_candidate_ids: [candidateId],
      downstream_accepted_candidate_ids: [candidateId],
      durable_record_candidate_map: { [recordId]: candidateId } },
  });
  const entry = metadata.provider_completion_journal.entries[attempt.attempt_id];
  assert.equal(entry.ledger_transition.status, 'applied_verified');
  assert.equal(entry.manifest_transition.status, 'applied_verified');
  assert.equal(ledger.obligations[pipeline.leafObligationId].checkpoint_eligible, true);
});

test('production tier callers cannot bypass verified lifecycle authority', () => {
  for (const file of ['../session.js', '../longterm.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source,
      /(?:ledger_transition|manifest_transition)\s*:\s*\{\s*status:\s*['"]applied['"]/,
      `${file} must not self-declare canonical transition acknowledgement`);
  }
  const settings = readFileSync(new URL('../settings.js', import.meta.url), 'utf8');
  assert.doesNotMatch(settings, /retry-settlement:unknown/,
    'retry settlement must fail closed on a typed exact-identity blocker');
});
