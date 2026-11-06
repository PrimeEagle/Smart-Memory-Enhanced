import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { coordinateProviderEvidenceIngress }
  from '../memorize-lifecycle-coordinator.js';
import { migrateV0980SameRunEvidenceState }
  from '../memorize-lifecycle-migration.js';
import {
  aggregateMemorizeObligationParents,
  applyMemorizeLifecycleEvent,
  createMemorizeObligationLedger,
  projectMemorizeObligationLedger,
  reconcileMemorizeLifecycleFromJournal,
  transitionMemorizeObligation,
} from '../memorize-obligation-ledger.js';
import { deriveMemorizeResumeEligibility, getNextSourceTraversalRange }
  from '../memorize-authority-model.js';
import {
  classifyRetainedProviderEvidence,
  PROVIDER_EVIDENCE_PROVENANCE,
  selectRetainedProviderEvidence,
} from '../provider-completion-journal.js';
import { deriveRunErrorAccounting } from '../run-status-utils.js';

const fixture = JSON.parse(readFileSync(new URL(
  './fixtures/v0980-same-run-partial-replay.json', import.meta.url), 'utf8'));
const partial = fixture.leaves.partial;
const completed = fixture.leaves.completed;

function identity(leaf = partial) {
  return {
    obligation_id: leaf.obligation_id,
    logical_run_id: fixture.logical_run_id,
    root_obligation_id: fixture.root_obligation_id,
    leaf_obligation_id: leaf.obligation_id,
    parent_obligation_id: fixture.root_obligation_id,
    tier: 'session', owner: null, source_range: leaf.source_range,
    source_fingerprint: leaf.source_fingerprint,
  };
}

function partialEntry(overrides = {}) {
  return {
    attempt_id: partial.attempt_id, logical_run_id: fixture.logical_run_id,
    root_obligation_id: fixture.root_obligation_id,
    child_obligation_id: partial.obligation_id, tier: 'session', owner: null,
    source_range: partial.source_range, source_fingerprint: partial.source_fingerprint,
    terminal_outcome: 'completed', response_text: '<record>private</record>',
    parser_result: { status: 'partial', records: [{ id: 'private-candidate' }] },
    validation: { status: 'accepted', accepted_count: 3 },
    validated_record_identities: Object.entries(partial.candidate_map)
      .map(([id, candidate_id]) => ({ id, candidate_id })),
    persistence: { status: 'committed', durable_record_ids: partial.record_ids },
    adopted_from_logical_run_id: fixture.logical_run_id,
    adopted_from_attempt_id: partial.attempt_id,
    evidence_adoption_reason: 'session_pending_downstream_completion_replay',
    started_at: 100, updated_at: 200, completed_at: null,
    ...overrides,
  };
}

function affectedState() {
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id, 1);
  transitionMemorizeObligation(ledger, {
    obligation_id: fixture.root_obligation_id, logical_run_id: fixture.logical_run_id,
    tier: 'session', source_range: { start: 0, end: 19 },
    source_fingerprint: fixture.source_fingerprint,
    expected_child_obligation_ids: [completed.obligation_id, partial.obligation_id],
  }, { current_state: 'pending_recovery', exact_reason_code: 'child_coverage_incomplete',
    next_eligible_action: 'resume_first_actionable_recovery_leaf', at: 1 });
  transitionMemorizeObligation(ledger, identity(completed), {
    current_state: 'durably_committed', persistence_result: 'committed',
    coverage_result: 'safely_committed', provider_attempt_id: completed.attempt_id,
    lifecycle: { durably_persisted_record_ids: completed.record_ids }, at: 2,
  });
  transitionMemorizeObligation(ledger, identity(), {
    current_state: 'provider_response_received', parser_result: 'partial',
    downstream_validation_result: 'accepted_partial_records',
    persistence_result: 'partial_records_committed', coverage_result: 'pending',
    exact_reason_code: 'accepted_output_pending_downstream_processing',
    next_eligible_action: 'continue_pending_downstream_processing',
    provider_attempt_id: partial.attempt_id,
    lifecycle: {
      parser_accepted_candidate_ids: Object.values(partial.candidate_map),
      downstream_accepted_candidate_ids: Object.values(partial.candidate_map),
      durably_persisted_record_ids: partial.record_ids,
      durable_record_candidate_map: partial.candidate_map,
      parser_rejected_fragment_ids: partial.unresolved_fragment_ids,
      unresolved_fragment_ids: partial.unresolved_fragment_ids,
    }, metrics: { persisted_records: 3 }, at: 3,
  });
  for (let index = 0; index < fixture.longterm_violation_count; index++) {
    const id = `longterm:owner-${index}:0-19:${fixture.source_fingerprint}`;
    transitionMemorizeObligation(ledger, { obligation_id: id,
      logical_run_id: fixture.logical_run_id, tier: 'longterm', owner: `Owner ${index}`,
      source_range: { start: 0, end: 19 }, source_fingerprint: fixture.source_fingerprint,
    }, { current_state: 'durably_committed', persistence_result: 'committed', at: 4 });
    ledger.transition_violations.push({
      code: 'terminal_attempt_reconciliation_missing_evidence', obligation_id: id,
      provider_attempt_id: `longterm-attempt-${index}`, classification: 'current_runtime',
    });
  }
  ledger.transition_violations.push({
    code: 'terminal_malformed_settlement_cannot_regress_terminal_state',
    obligation_id: completed.obligation_id,
    provider_attempt_id: completed.superseded_attempt_id, classification: 'current_runtime',
  });
  const entry = partialEntry();
  const journal = { schema_version: 3, order: [partial.attempt_id],
    entries: { [partial.attempt_id]: entry } };
  return { ledger, journal, entry };
}

test('same-run evidence is fragment continuation and never prior-run adoption', async () => {
  const entry = partialEntry();
  const classification = classifyRetainedProviderEvidence(entry, {
    ...identity(), current_logical_run_id: fixture.logical_run_id,
    child_obligation_id: partial.obligation_id,
    obligation: { current_state: 'pending_recovery', lifecycle: {
      durably_persisted_record_ids: partial.record_ids,
      unresolved_fragment_ids: partial.unresolved_fragment_ids,
    } },
  });
  assert.equal(classification.classification,
    PROVIDER_EVIDENCE_PROVENANCE.CURRENT_RUN_RECOVER_FRAGMENTS);
  assert.equal(classification.next_action, 'recover_exact_unresolved_fragments');
  let lifecycleCalls = 0;
  const rejected = await coordinateProviderEvidenceIngress({
    operation: 'adopt_exact_prior_run_evidence', identity: identity(), evidence: entry,
    emit_lifecycle_event: async () => { lifecycleCalls++; },
  });
  assert.equal(rejected.reason_code, 'same_run_evidence_cannot_use_prior_run_adoption');
  assert.equal(lifecycleCalls, 0);
});

test('current-run response continuation derives the first incomplete downstream stage', () => {
  const entry = partialEntry({ validation: { status: 'pending' },
    persistence: { status: 'not_started', durable_record_ids: [] },
    adopted_from_logical_run_id: null, adopted_from_attempt_id: null });
  const result = classifyRetainedProviderEvidence(entry, {
    ...identity(), current_logical_run_id: fixture.logical_run_id,
    child_obligation_id: partial.obligation_id,
    obligation: { current_state: 'parser_partial', lifecycle: {} },
  });
  assert.equal(result.classification,
    PROVIDER_EVIDENCE_PROVENANCE.CURRENT_RUN_CONTINUE_DOWNSTREAM);
  assert.equal(result.next_action, 'continue_validation');
});

test('attempt under active processing can be excluded from retained selection', () => {
  const metadata = { provider_completion_journal: { schema_version: 3,
    order: [partial.attempt_id], entries: { [partial.attempt_id]: partialEntry() } } };
  const selected = selectRetainedProviderEvidence(metadata, {
    ...identity(), child_obligation_id: partial.obligation_id,
    current_logical_run_id: fixture.logical_run_id,
    exclude_attempt_id: partial.attempt_id,
  });
  assert.equal(selected, null);
});

test('later lifecycle stages cannot regress to response/parser state', () => {
  const { ledger } = affectedState();
  const leaf = ledger.obligations[partial.obligation_id];
  transitionMemorizeObligation(ledger, leaf, {
    current_state: 'pending_recovery', exact_reason_code: 'fragments_pending',
    next_eligible_action: 'recover_exact_unresolved_fragments', at: 5,
  });
  const response = applyMemorizeLifecycleEvent(ledger, leaf, {
    type: 'provider_response_received', provider_attempt_id: partial.attempt_id, at: 6,
  });
  assert.equal(response.status, 'idempotent_duplicate_verified');
  assert.equal(ledger.obligations[partial.obligation_id].current_state, 'pending_recovery');
  const sameRunAdoption = applyMemorizeLifecycleEvent(ledger, leaf, {
    type: 'terminal_provider_evidence_adopted', provider_attempt_id: partial.attempt_id,
    adopted_from_logical_run_id: fixture.logical_run_id,
    adopted_from_attempt_id: partial.attempt_id, evidence_fingerprint: 'same-run',
    adopted_terminal_evidence: {
      original_root_obligation_id: fixture.root_obligation_id,
      original_leaf_obligation_id: partial.obligation_id, tier: 'session', owner: null,
      source_range: partial.source_range, source_fingerprint: partial.source_fingerprint,
      terminal_outcome: 'completed', private_response_retained: true,
    }, at: 7,
  });
  assert.equal(sameRunAdoption.status, 'rejected');
  assert.equal(ledger.obligations[partial.obligation_id].current_state, 'pending_recovery');
});

test('parser enrichment is idempotent and does not emit a second disposition', () => {
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id, 1);
  const id = identity();
  applyMemorizeLifecycleEvent(ledger, id, { type: 'provider_attempt_started',
    provider_attempt_id: partial.attempt_id });
  applyMemorizeLifecycleEvent(ledger, id, { type: 'provider_response_received',
    provider_attempt_id: partial.attempt_id });
  applyMemorizeLifecycleEvent(ledger, id, { type: 'parser_partially_accepted',
    provider_attempt_id: partial.attempt_id });
  const event = { type: 'parser_evidence_enriched', provider_attempt_id: partial.attempt_id,
    lifecycle: { parser_accepted_candidate_ids: Object.values(partial.candidate_map) } };
  assert.equal(applyMemorizeLifecycleEvent(ledger, id, event).status, 'applied');
  assert.equal(applyMemorizeLifecycleEvent(ledger, id, event).status,
    'idempotent_duplicate_verified');
  assert.equal(ledger.obligations[partial.obligation_id].current_state, 'parser_partial');
  assert.equal(ledger.obligations[partial.obligation_id].semantic_event_history
    .filter((item) => item.type === 'parser_partially_accepted').length, 1);
});

test('v0.9.80 migration preserves five records, mappings, fragments, and converges', () => {
  const { ledger, journal, entry } = affectedState();
  const first = migrateV0980SameRunEvidenceState({ ledger, journal,
    logical_run_id: fixture.logical_run_id,
    provider_attempts: { recent_attempts: [{ attempt_id: partial.attempt_id,
      terminal_outcome: 'completed', completed_at: 190 }] } });
  const leaf = ledger.obligations[partial.obligation_id];
  assert.equal(first.provider_calls, 0);
  assert.equal(first.persistence_calls, 0);
  assert.equal(leaf.current_state, 'pending_recovery');
  assert.equal(leaf.next_eligible_action, 'recover_exact_unresolved_fragments');
  assert.deepEqual(leaf.lifecycle.durably_persisted_record_ids.sort(),
    [...partial.record_ids].sort());
  assert.deepEqual(leaf.lifecycle.durable_record_candidate_map, partial.candidate_map);
  assert.deepEqual(leaf.lifecycle.unresolved_fragment_ids.sort(),
    [...partial.unresolved_fragment_ids].sort());
  assert.deepEqual(ledger.obligations[completed.obligation_id]
    .lifecycle.durably_persisted_record_ids.sort(), [...completed.record_ids].sort());
  assert.equal(entry.adopted_from_logical_run_id, null);
  assert.equal(entry.physical_completed_at, 190);
  assert.equal(entry.logical_completed_at, null);
  assert.equal(ledger.transition_violations.length, 0);
  assert.equal(first.detail.retired_violation_count, 7);
  const second = migrateV0980SameRunEvidenceState({ ledger, journal,
    logical_run_id: fixture.logical_run_id });
  assert.equal(second.migrated, false);
});

test('migration exposes truthful exact-fragment Resume action', () => {
  const { ledger, journal } = affectedState();
  migrateV0980SameRunEvidenceState({ ledger, journal,
    logical_run_id: fixture.logical_run_id });
  const projection = projectMemorizeObligationLedger(ledger);
  assert.equal(projection.actionable_pending_obligation_count, 1);
  const resume = deriveMemorizeResumeEligibility({ ledger, projection,
    provider_audit: { recent_attempts: [] }, provider_completion_journal: journal });
  assert.equal(resume.eligible, true);
  assert.equal(resume.mode, 'provider_resume');
  assert.equal(resume.next_eligible_action, 'recover_exact_unresolved_fragments');
  assert.equal(resume.provider_call_required, true);
});

test('parent waits for both leaves then closes locally and advances once to 20-39', () => {
  const { ledger, journal } = affectedState();
  migrateV0980SameRunEvidenceState({ ledger, journal,
    logical_run_id: fixture.logical_run_id });
  assert.equal(aggregateMemorizeObligationParents(ledger, 10).mutations, 0);
  transitionMemorizeObligation(ledger, ledger.obligations[partial.obligation_id], {
    current_state: 'durably_committed', persistence_result: 'committed',
    coverage_result: 'safely_committed', at: 11,
  });
  assert.equal(aggregateMemorizeObligationParents(ledger, 12).mutations, 1);
  assert.equal(ledger.obligations[fixture.root_obligation_id].checkpoint_eligible, true);
  assert.equal(aggregateMemorizeObligationParents(ledger, 13).mutations, 0);
  const next = getNextSourceTraversalRange(ledger, {
    source_message_count: 9434, chunk_size: 20,
  });
  assert.equal(next.kind, 'source_traversal');
  assert.equal(next.source_range.start_offset, 20);
  assert.equal(next.source_range.end_offset, 39);
});

test('journal reconciliation treats superseded malformed evidence as historical and stabilizes', () => {
  const { ledger, journal } = affectedState();
  migrateV0980SameRunEvidenceState({ ledger, journal,
    logical_run_id: fixture.logical_run_id });
  journal.entries[completed.superseded_attempt_id] = {
    attempt_id: completed.superseded_attempt_id, logical_run_id: fixture.logical_run_id,
    root_obligation_id: fixture.root_obligation_id,
    child_obligation_id: completed.obligation_id, tier: 'session', owner: null,
    source_range: completed.source_range, source_fingerprint: completed.source_fingerprint,
    terminal_outcome: 'provider_response_malformed',
    persistence: { status: 'not_applicable' },
  };
  journal.order.unshift(completed.superseded_attempt_id);
  const input = { logical_run_id: fixture.logical_run_id, journal,
    provider_attempts: { recent_attempts: [] }, at: 20 };
  reconcileMemorizeLifecycleFromJournal(ledger, input);
  const second = reconcileMemorizeLifecycleFromJournal(ledger, input);
  assert.equal(second.mutations, 0);
  assert.ok(ledger.historical_transition_observations.some((item) =>
    item.provider_attempt_id === completed.superseded_attempt_id
      && item.classification === 'superseded_by_later_attempt'));
});

test('provider-evidence ingress rejection is local lifecycle failure, not provider fault', () => {
  const accounting = deriveRunErrorAccounting({ errors: 1,
    error_details: [{ label: 'session extraction error',
      message: 'Memorize provider-evidence ingress rejected parser_partially_accepted.' }] });
  assert.equal(accounting.lifecycle_transition_rejections.count, 1);
  assert.equal(accounting.lifecycle_transition_rejections.provider_fault_attribution, false);
  assert.equal(accounting.displayed_error_records.categories.malformed_or_parser_failure, 0);
});

test('production Session uses provenance selection and explicit parser enrichment', () => {
  const source = readFileSync(new URL('../session.js', import.meta.url), 'utf8');
  assert.match(source, /selectRetainedProviderEvidence/);
  assert.match(source, /CURRENT_RUN_RECOVER_FRAGMENTS/);
  assert.match(source, /applyRetainedEvidenceDecision/);
  assert.match(source, /parser_evidence_enriched/);
  assert.doesNotMatch(source,
    /emitLifecycleEvent\(unresolvedPartialFragments > 0\s*\? 'parser_partially_accepted' : 'parser_accepted', \{\s*lifecycle:/);
});
