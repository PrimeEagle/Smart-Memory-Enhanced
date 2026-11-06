import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { coordinateProviderEvidenceIngress } from '../memorize-lifecycle-coordinator.js';
import { migrateV0981RetainedEvidenceRaceState } from '../memorize-lifecycle-migration.js';
import {
  applyMemorizeLifecycleEvent,
  createMemorizeObligationLedger,
  getCanonicalMemorizeObligation,
  getMemorizeActionContract,
  memorizeObligationStateFingerprint,
  projectMemorizeObligationLedger,
  transitionMemorizeObligation,
} from '../memorize-obligation-ledger.js';
import { deriveMemorizeResumeEligibility, getNextSourceTraversalRange }
  from '../memorize-authority-model.js';
import { createMemorizeRecoveryScheduler } from '../memorize-recovery-scheduler.js';
import {
  PROVIDER_EVIDENCE_PROVENANCE,
  revalidateRetainedProviderEvidenceSelection,
  selectRetainedProviderEvidence,
} from '../provider-completion-journal.js';

const fixture = JSON.parse(readFileSync(new URL(
  './fixtures/v0981-retained-evidence-race.json', import.meta.url), 'utf8'));
const terminal = fixture.terminal_leaf;
const pending = fixture.pending_leaf;

function identity(leaf) {
  return {
    obligation_id: leaf.obligation_id,
    logical_run_id: fixture.logical_run_id,
    root_obligation_id: fixture.root_obligation_id,
    leaf_obligation_id: leaf.obligation_id,
    parent_obligation_id: fixture.root_obligation_id,
    tier: 'session', owner: null,
    source_range: leaf.source_range,
    source_fingerprint: leaf.source_fingerprint,
  };
}

function priorEntry() {
  return {
    attempt_id: terminal.prior_attempt_id,
    logical_run_id: 'redacted-prior-run',
    root_obligation_id: fixture.root_obligation_id,
    child_obligation_id: terminal.obligation_id,
    tier: 'session', owner: null,
    source_range: terminal.source_range,
    source_fingerprint: terminal.source_fingerprint,
    terminal_outcome: 'completed',
    response_text: '<memory>redacted retained response</memory>',
    parser_result: { status: 'accepted', records: [{ id: 'redacted-candidate' }] },
    persistence: { status: 'committed', durable_record_ids: terminal.durable_record_ids },
    validated_record_identities: Object.entries(terminal.candidate_map)
      .map(([id, candidate_id]) => ({ id, candidate_id })),
    started_at: 10, updated_at: 20,
  };
}

function affectedState() {
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id, 1);
  transitionMemorizeObligation(ledger, {
    obligation_id: fixture.root_obligation_id, logical_run_id: fixture.logical_run_id,
    tier: 'session', owner: null, source_range: { start: 0, end: 19 },
    source_fingerprint: fixture.parent_source_fingerprint,
    expected_child_obligation_ids: [terminal.obligation_id, pending.obligation_id],
  }, { current_state: 'pending_recovery', exact_reason_code: 'recovery_children_pending',
    next_eligible_action: 'continue_unattempted_recovery_child',
    recovery_intent: 'complete_recovery_child_coverage', recovery_stage: 'child_coverage', at: 1 });
  transitionMemorizeObligation(ledger, identity(terminal), {
    current_state: 'durably_committed', persistence_result: 'committed',
    coverage_result: 'safely_committed', provider_attempt_id: terminal.prior_attempt_id,
    lifecycle: { durably_persisted_record_ids: terminal.durable_record_ids,
      durable_record_candidate_map: terminal.candidate_map,
      migrated_from_ambiguous_counts: true }, at: 2,
  });
  transitionMemorizeObligation(ledger, identity(pending), {
    current_state: 'unattempted', at: 3,
  });
  const longtermId = 'longterm:redacted:0-19:fnv1a-longterm';
  transitionMemorizeObligation(ledger, {
    obligation_id: longtermId, logical_run_id: fixture.logical_run_id,
    tier: 'longterm', owner: 'Redacted', source_range: { start: 0, end: 19 },
    source_fingerprint: 'fnv1a-longterm',
  }, { current_state: 'durably_committed', persistence_result: 'committed',
    lifecycle: { durably_persisted_record_ids: fixture.longterm_record_ids,
      migrated_from_ambiguous_counts: true }, at: 4 });
  ledger.transition_violations.push({
    code: 'terminal_provider_evidence_adoption_cannot_regress_terminal_state',
    obligation_id: terminal.obligation_id, provider_attempt_id: terminal.prior_attempt_id,
    classification: 'current_runtime',
  });
  const entry = priorEntry();
  const journal = { schema_version: 3, order: [entry.attempt_id],
    entries: { [entry.attempt_id]: entry } };
  return { ledger, journal, entry, longtermId };
}

test('declared recovery children receive a complete initial dispatch contract', () => {
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id, 1);
  const root = {
    obligation_id: fixture.root_obligation_id, logical_run_id: fixture.logical_run_id,
    tier: 'session', owner: null, source_range: { start: 0, end: 19 },
    source_fingerprint: fixture.parent_source_fingerprint,
  };
  applyMemorizeLifecycleEvent(ledger, root, { type: 'recovery_children_declared',
    children: [identity(terminal), identity(pending)], at: 2 });
  for (const child of [terminal, pending].map((item) => ledger.obligations[item.obligation_id])) {
    assert.equal(child.current_state, 'unattempted');
    assert.equal(child.exact_reason_code, 'recovery_child_not_attempted');
    assert.equal(child.next_eligible_action, 'dispatch_provider_request');
    assert.equal(child.recovery_intent, 'complete_recovery_child_coverage');
    assert.equal(child.recovery_stage, 'initial_child_dispatch');
  }
});

test('selection captures canonical revision and state fingerprint', () => {
  const { ledger, journal } = affectedState();
  const leaf = ledger.obligations[terminal.obligation_id];
  leaf.current_state = 'unattempted'; leaf.checkpoint_eligible = false;
  const selected = selectRetainedProviderEvidence({ provider_completion_journal: journal }, {
    ...identity(terminal), child_obligation_id: terminal.obligation_id,
    current_logical_run_id: fixture.logical_run_id, obligation: leaf,
  });
  assert.equal(selected.classification, PROVIDER_EVIDENCE_PROVENANCE.PRIOR_RUN_ADOPTABLE);
  assert.equal(selected.selected_obligation_revision, leaf.revision);
  assert.equal(selected.selected_obligation_state_fingerprint,
    memorizeObligationStateFingerprint(leaf));
});

test('race mutation revalidates terminal leaf as an idempotent local success', async () => {
  const { ledger, journal } = affectedState();
  const leaf = ledger.obligations[terminal.obligation_id];
  leaf.current_state = 'unattempted'; leaf.checkpoint_eligible = false;
  const selected = selectRetainedProviderEvidence({ provider_completion_journal: journal }, {
    ...identity(terminal), child_obligation_id: terminal.obligation_id,
    current_logical_run_id: fixture.logical_run_id, obligation: leaf,
  });
  transitionMemorizeObligation(ledger, identity(terminal), {
    current_state: 'durably_committed', persistence_result: 'committed',
    lifecycle: { durably_persisted_record_ids: terminal.durable_record_ids,
      migrated_from_ambiguous_counts: true }, at: 5,
  });
  let reducerCalls = 0;
  const result = await coordinateProviderEvidenceIngress({
    operation: 'apply_retained_evidence_decision', identity: identity(terminal),
    selection: selected,
    get_canonical_obligation: () => ledger.obligations[terminal.obligation_id],
    emit_lifecycle_event: async () => { reducerCalls++; },
  });
  assert.equal(result.status, 'idempotent_duplicate_verified');
  assert.equal(result.reason_code, 'retained_evidence_target_already_terminal');
  assert.equal(result.checkpoint_eligible, true);
  assert.equal(result.provider_call_required, false);
  assert.equal(result.persistence_required, false);
  assert.equal(result.decision_revalidation.changed_since_selection, true);
  assert.equal(reducerCalls, 0);
});

test('pure revalidation reports the old and new revisions', () => {
  const selectedObligation = { ...identity(terminal), current_state: 'unattempted',
    checkpoint_eligible: false, revision: 1, lifecycle: {} };
  const selection = { entry: priorEntry(), selected_obligation_revision: 1,
    selected_obligation_state_fingerprint: memorizeObligationStateFingerprint(selectedObligation) };
  const current = { ...selectedObligation, current_state: 'durably_committed',
    checkpoint_eligible: true, revision: 2 };
  const result = revalidateRetainedProviderEvidenceSelection(selection, {
    ...identity(terminal), current_logical_run_id: fixture.logical_run_id,
    obligation: current,
  });
  assert.equal(result.classification, PROVIDER_EVIDENCE_PROVENANCE.ALREADY_TERMINAL);
  assert.equal(result.selected_obligation_revision, 1);
  assert.equal(result.applied_obligation_revision, 2);
  assert.equal(result.changed_since_selection, true);
});

test('scheduler skips terminal 0-9 and dispatches only 10-19', async () => {
  const { ledger } = affectedState();
  const calls = [];
  const result = await createMemorizeRecoveryScheduler().run({
    tasks: [terminal, pending], keyOf: (item) => item.obligation_id,
    shouldSkip: async (item) => ({ skip: ledger.obligations[item.obligation_id]
      ?.checkpoint_eligible === true, terminal: true }),
    execute: async (item) => { calls.push(item.obligation_id); return { added: 1 }; },
  });
  assert.deepEqual(calls, [pending.obligation_id]);
  assert.equal(result.skipped, 1);
  assert.equal(result.executed, 1);
  assert.equal(result.added, 1);
  assert.deepEqual(result.registered_task_keys,
    [terminal.obligation_id, pending.obligation_id]);
  assert.deepEqual(result.terminal_skipped_task_keys, [terminal.obligation_id]);
  assert.equal(result.selected_incomplete_task_key, pending.obligation_id);
  assert.equal(result.parent_aggregation_status, 'ready_for_local_aggregation');
  assert.equal(result.next_sibling_action, 'aggregate_completed_children');
});

test('v0.9.81 migration repairs sibling, journal, error residue, and converges', () => {
  const { ledger, journal, entry, longtermId } = affectedState();
  const durableBefore = [...ledger.obligations[terminal.obligation_id]
    .lifecycle.durably_persisted_record_ids];
  const mappingsBefore = JSON.stringify(ledger.obligations[terminal.obligation_id]
    .lifecycle.durable_record_candidate_map);
  const longtermBefore = JSON.stringify(ledger.obligations[longtermId].lifecycle);
  const first = migrateV0981RetainedEvidenceRaceState({ ledger, journal,
    logical_run_id: fixture.logical_run_id });
  const child = ledger.obligations[pending.obligation_id];
  assert.equal(first.provider_calls, 0);
  assert.equal(first.persistence_calls, 0);
  assert.equal(child.exact_reason_code, 'recovery_child_not_attempted');
  assert.equal(child.next_eligible_action, 'dispatch_provider_request');
  assert.equal(child.recovery_intent, 'complete_recovery_child_coverage');
  assert.equal(child.recovery_stage, 'initial_child_dispatch');
  assert.equal(entry.downstream_cursor, 'fully_terminal');
  assert.equal(entry.logical_disposition, 'durably_committed');
  assert.equal(entry.ledger_transition.status, 'applied_verified');
  assert.deepEqual(ledger.obligations[terminal.obligation_id]
    .lifecycle.durably_persisted_record_ids, durableBefore);
  assert.equal(JSON.stringify(ledger.obligations[terminal.obligation_id]
    .lifecycle.durable_record_candidate_map), mappingsBefore);
  assert.equal(JSON.stringify(ledger.obligations[longtermId].lifecycle), longtermBefore);
  assert.equal(ledger.transition_violations.length, 0);
  const serialized = JSON.stringify({ ledger, journal });
  const second = migrateV0981RetainedEvidenceRaceState({ ledger, journal,
    logical_run_id: fixture.logical_run_id });
  assert.equal(second.migrated, false);
  assert.equal(JSON.stringify({ ledger, journal }), serialized);
});

test('projection and Resume agree that 10-19 is the sole provider action', () => {
  const { ledger, journal } = affectedState();
  migrateV0981RetainedEvidenceRaceState({ ledger, journal,
    logical_run_id: fixture.logical_run_id });
  const projection = projectMemorizeObligationLedger(ledger);
  assert.equal(projection.actionable_pending_obligation_count, 1);
  assert.equal(projection.next_eligible_obligation.obligation_id, pending.obligation_id);
  assert.equal(projection.next_eligible_obligation.provider_call_required, true);
  assert.equal(projection.next_eligible_obligation.persistence_required, false);
  const resume = deriveMemorizeResumeEligibility({ ledger, projection,
    provider_audit: { recent_attempts: [] }, provider_completion_journal: journal });
  assert.equal(resume.eligible, true);
  assert.equal(resume.mode, 'provider_resume');
  assert.equal(resume.obligation_id, pending.obligation_id);
  assert.equal(resume.provider_call_required, true);
});

test('parent remains open until 10-19 is terminal, then traversal advances to 20-39', () => {
  const { ledger, journal } = affectedState();
  migrateV0981RetainedEvidenceRaceState({ ledger, journal,
    logical_run_id: fixture.logical_run_id });
  assert.equal(ledger.obligations[fixture.root_obligation_id].checkpoint_eligible, false);
  transitionMemorizeObligation(ledger, identity(pending), {
    current_state: 'durably_committed', persistence_result: 'committed', at: 20 });
  applyMemorizeLifecycleEvent(ledger, {
    obligation_id: fixture.root_obligation_id, logical_run_id: fixture.logical_run_id,
    tier: 'session', source_range: { start: 0, end: 19 },
    source_fingerprint: fixture.parent_source_fingerprint,
  }, { type: 'parent_children_completed', at: 21 });
  const next = getNextSourceTraversalRange(ledger, { source_message_count: 9434,
    chunk_size: 20 });
  assert.equal(next.kind, 'source_traversal');
  assert.equal(next.source_range.start_offset, fixture.next_source_range.start);
  assert.equal(next.source_range.end_offset, fixture.next_source_range.end);
});

const actionCases = [
  ['dispatch_provider_request', true, false],
  ['dispatch_bounded_recovery_attempt', true, false],
  ['recover_exact_unresolved_fragments', true, false],
  ['resume_exact_obligation', true, false],
  ['session_validation_repair_or_bounded_regeneration', true, false],
  ['continue_pending_downstream_processing', false, true],
  ['continue_current_run_downstream', false, true],
  ['parse_retained_response', false, false],
  ['continue_validation', false, false],
  ['persist_validated_records', false, true],
  ['reconcile_terminal_attempt_evidence', false, false],
  ['settle_terminal_malformed_attempt', false, false],
  ['adopt_exact_prior_run_evidence', false, false],
  ['continue_unattempted_recovery_child', false, false],
  ['derive_parent_child_coverage', false, false],
];
for (const [action, provider, persistence] of actionCases) {
  test(`action contract is authoritative for ${action}`, () => {
    assert.equal(getMemorizeActionContract(action).provider_call_required, provider);
    assert.equal(getMemorizeActionContract(action).persistence_required, persistence);
  });
}

const lookupCases = [terminal.obligation_id, pending.obligation_id,
  fixture.root_obligation_id];
for (const obligationId of lookupCases) {
  test(`canonical exact-id lookup returns ${obligationId.split(':').at(-2)}`, () => {
    const { ledger } = affectedState();
    assert.equal(getCanonicalMemorizeObligation(ledger, obligationId,
      fixture.logical_run_id)?.obligation_id, obligationId);
    assert.equal(getCanonicalMemorizeObligation(ledger, obligationId,
      'different-run'), null);
  });
}

const fingerprintMutations = [
  ['state', (item) => { item.current_state = 'pending_recovery'; }],
  ['checkpoint', (item) => { item.checkpoint_eligible = true; }],
  ['reason', (item) => { item.exact_reason_code = 'changed'; }],
  ['action', (item) => { item.next_eligible_action = 'resume_exact_obligation'; }],
  ['lineage', (item) => { item.provider_attempt_lineage = ['attempt']; }],
  ['durable ids', (item) => { item.lifecycle = { durably_persisted_record_ids: ['record'] }; }],
  ['fragments', (item) => { item.lifecycle = { unresolved_fragment_ids: ['fragment'] }; }],
];
for (const [name, mutate] of fingerprintMutations) {
  test(`state fingerprint detects ${name} mutation`, () => {
    const base = { ...identity(pending), current_state: 'unattempted',
      checkpoint_eligible: false, lifecycle: {} };
    const changed = structuredClone(base); mutate(changed);
    assert.notEqual(memorizeObligationStateFingerprint(base),
      memorizeObligationStateFingerprint(changed));
  });
}

test('unknown actions fail closed in the canonical contract', () => {
  assert.equal(getMemorizeActionContract('invented_action'), null);
});

test('prior-run retained evidence never authorizes a provider call', () => {
  const { ledger, journal } = affectedState();
  const leaf = ledger.obligations[terminal.obligation_id];
  leaf.current_state = 'unattempted'; leaf.checkpoint_eligible = false;
  const selected = selectRetainedProviderEvidence({ provider_completion_journal: journal }, {
    ...identity(terminal), child_obligation_id: terminal.obligation_id,
    current_logical_run_id: fixture.logical_run_id, obligation: leaf,
  });
  assert.equal(selected.provider_call_required, false);
  assert.equal(selected.persistence_required, true);
});

test('terminal adoption reducer event is a historical no-op, not a violation', () => {
  const { ledger } = affectedState();
  const result = applyMemorizeLifecycleEvent(ledger, identity(terminal), {
    type: 'terminal_provider_evidence_adopted', provider_attempt_id: terminal.prior_attempt_id,
    adopted_from_logical_run_id: 'redacted-prior-run',
    adopted_from_attempt_id: terminal.prior_attempt_id,
    evidence_fingerprint: 'redacted-evidence',
    adopted_terminal_evidence: {
      original_root_obligation_id: fixture.root_obligation_id,
      original_leaf_obligation_id: terminal.obligation_id,
      tier: 'session', owner: null, source_range: terminal.source_range,
      source_fingerprint: terminal.source_fingerprint,
      terminal_outcome: 'completed', private_response_retained: true,
    }, at: 30,
  });
  assert.equal(result.status, 'idempotent_duplicate_verified');
  assert.equal(ledger.obligations[terminal.obligation_id].current_state,
    'durably_committed');
});

test('a terminal reducer receipt after revalidation is still an idempotent adoption no-op', async () => {
  const canonical = { ...identity(terminal), current_state: 'unattempted',
    checkpoint_eligible: false, revision: 1, lifecycle: {} };
  const selection = { entry: priorEntry(),
    classification: PROVIDER_EVIDENCE_PROVENANCE.PRIOR_RUN_ADOPTABLE,
    selected_obligation_revision: 1,
    selected_obligation_state_fingerprint: memorizeObligationStateFingerprint(canonical) };
  const result = await coordinateProviderEvidenceIngress({
    operation: 'apply_retained_evidence_decision', identity: identity(terminal), selection,
    get_canonical_obligation: () => canonical,
    emit_lifecycle_event: async () => ({ status: 'idempotent_duplicate_verified',
      resulting_state: 'durably_committed', checkpoint_eligible: true }),
  });
  assert.equal(result.status, 'idempotent_duplicate_verified');
  assert.equal(result.reason_code, 'adoption_superseded_by_terminal_coverage');
  assert.equal(result.evidence_classification,
    PROVIDER_EVIDENCE_PROVENANCE.ALREADY_TERMINAL);
  assert.equal(result.provider_call_required, false);
  assert.equal(result.persistence_required, false);
});
