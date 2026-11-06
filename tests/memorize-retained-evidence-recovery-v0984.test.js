import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { migrateV0983RetainedEvidenceRecoveryState }
  from '../memorize-lifecycle-migration.js';
import {
  applyMemorizeLifecycleEvent,
  createMemorizeObligationLedger,
  transitionMemorizeObligation,
} from '../memorize-obligation-ledger.js';
import { planRetainedProviderEvidence, PROVIDER_EVIDENCE_PROVENANCE }
  from '../retained-evidence-plan.js';
import { deriveMemorizeRecoveryAuthority } from '../memorize-recovery-authority.js';
import { deriveMemorizeResumeProgress, snapshotMemorizeResumeProgress }
  from '../memorize-resume-progress.js';
import { selectRecoveryPresentation } from '../memorize-projections.js';
import { deriveRunErrorAccounting, deriveRunStatus } from '../run-status-utils.js';

const fixture = JSON.parse(readFileSync(new URL(
  './fixtures/v0983-retained-evidence-recovery.json', import.meta.url), 'utf8'));

const fingerprint = (start, end) => `fixture-session-${start}-${end}`;
const obligationId = (start, end) => `session:chat:${start}-${end}:${fingerprint(start, end)}`;
const identity = (start, end) => ({
  obligation_id: obligationId(start, end),
  logical_run_id: fixture.logical_run_id,
  tier: 'session', owner: null,
  source_range: { start, end, message_count: end - start + 1 },
  source_fingerprint: fingerprint(start, end),
});

function retainedEntry({ start, end, attempt_id, logical_run_id = 'prior-run',
  started_at = 1, privateEvidence = true, completedNoCandidates = false,
  durableIds = [] }) {
  return {
    attempt_id, logical_run_id,
    root_obligation_id: obligationId(start, end),
    child_obligation_id: obligationId(start, end),
    tier: 'session', owner: null,
    source_range: { start, end, message_count: end - start + 1 },
    source_fingerprint: fingerprint(start, end), started_at,
    terminal_outcome: completedNoCandidates ? 'completed_no_candidates' : 'completed',
    ...(privateEvidence ? {
      private_response_retained: true,
      response_text: '<memory>retained</memory>',
      parser_result: { status: 'partial', records: [{ id: `candidate-${start}` }] },
      validation: { status: 'accepted', accepted_count: 1 },
      persistence: { status: durableIds.length ? 'committed' : 'not_started',
        durable_record_ids: durableIds },
    } : {
      private_response_retained: false,
      response_text: null, parser_result: null,
      validation: { status: 'pending' },
      persistence: { status: 'not_started', durable_record_ids: [] },
    }),
    ledger_transition: { status: 'pending_reconciliation' },
  };
}

function pendingAdopted(ledger, range) {
  const id = identity(range.start, range.end);
  return transitionMemorizeObligation(ledger, id, {
    current_state: 'pending_recovery',
    exact_reason_code: 'partial_records_committed_unresolved_fragments_pending',
    next_eligible_action: 'recover_unresolved_partial_output_fragments',
    recovery_intent: 'recover_unresolved_partial_output_fragments',
    lifecycle: {
      parser_accepted_candidate_ids: range.durable_ids.map((_, i) => `candidate-${range.start}-${i}`),
      downstream_accepted_candidate_ids: range.durable_ids.map((_, i) => `candidate-${range.start}-${i}`),
      durably_persisted_record_ids: range.durable_ids,
      durable_record_candidate_map: Object.fromEntries(range.durable_ids.map((recordId, i) =>
        [recordId, `candidate-${range.start}-${i}`])),
      unresolved_fragment_ids: range.fragment_ids,
    },
    metrics: {
      adopted_from_attempt_id: range.attempt_id,
      adopted_from_logical_run_id: 'prior-run',
      adopted_evidence_fingerprint: `prior-run|${range.attempt_id}|${fingerprint(range.start, range.end)}`,
    }, at: 1,
  });
}

test('verified usable evidence outranks a newer incomplete no-candidates attempt', () => {
  const { start, end, verified_attempt_id: verified,
    newer_incomplete_attempt_id: incomplete } = fixture.precedence_range;
  const obligation = { ...identity(start, end), revision: 1,
    current_state: 'unattempted', checkpoint_eligible: false,
    next_eligible_action: 'dispatch_provider_request', lifecycle: {} };
  const plan = planRetainedProviderEvidence({
    ...identity(start, end),
    current_logical_run_id: fixture.logical_run_id,
    root_obligation_id: obligation.obligation_id,
    child_obligation_id: obligation.obligation_id,
    obligation,
    candidates: [
      retainedEntry({ start, end, attempt_id: verified, started_at: 10,
        durableIds: ['record-120-a', 'record-120-b'] }),
      retainedEntry({ start, end, attempt_id: incomplete, started_at: 20,
        privateEvidence: false, completedNoCandidates: true }),
    ],
  });
  assert.equal(plan.evidence_origin_attempt_id, verified);
  assert.equal(plan.evidence_classification,
    PROVIDER_EVIDENCE_PROVENANCE.PRIOR_RUN_ADOPTABLE);
  assert.equal(plan.candidate_decisions.find((item) => item.attempt_id === incomplete)
    .disposition, 'rejected_unusable_evidence');
});

test('completed-no-candidates requires complete verified no-update evidence', () => {
  const start = 140; const end = 159;
  const obligation = { ...identity(start, end), revision: 1,
    current_state: 'unattempted', checkpoint_eligible: false,
    next_eligible_action: 'dispatch_provider_request', lifecycle: {} };
  const incomplete = retainedEntry({ start, end, attempt_id: 'incomplete-none',
    privateEvidence: false, completedNoCandidates: true });
  const incompletePlan = planRetainedProviderEvidence({
    ...identity(start, end), current_logical_run_id: fixture.logical_run_id,
    root_obligation_id: obligation.obligation_id,
    child_obligation_id: obligation.obligation_id,
    obligation, candidates: [incomplete],
  });
  assert.equal(incompletePlan.evidence_classification,
    PROVIDER_EVIDENCE_PROVENANCE.INCOMPLETE_RECONCILIATION);
  const verified = structuredClone(incomplete);
  verified.attempt_id = 'verified-none';
  verified.parser_result = { status: 'accepted_no_candidates', accepted_count: 0, records: [] };
  verified.validation = { status: 'accepted_no_candidates', accepted_count: 0 };
  verified.persistence = { status: 'not_needed', durable_record_ids: [] };
  verified.ledger_transition = { status: 'applied_verified', checkpoint_eligible: true };
  const verifiedPlan = planRetainedProviderEvidence({
    ...identity(start, end), current_logical_run_id: fixture.logical_run_id,
    root_obligation_id: obligation.obligation_id,
    child_obligation_id: obligation.obligation_id,
    obligation, candidates: [verified],
  });
  assert.equal(verifiedPlan.evidence_classification,
    PROVIDER_EVIDENCE_PROVENANCE.PRIOR_RUN_ADOPTABLE);
  assert.equal(verifiedPlan.candidate_decisions[0].evidence_fitness.verified_no_update, true);
});

test('an already adopted partial attempt plans fragment recovery, never re-adoption', () => {
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id, 1);
  const range = fixture.adopted_ranges[0];
  const obligation = pendingAdopted(ledger, range);
  const entry = retainedEntry({ ...range, logical_run_id: 'prior-run',
    durableIds: range.durable_ids });
  const plan = planRetainedProviderEvidence({
    ...identity(range.start, range.end),
    current_logical_run_id: fixture.logical_run_id,
    root_obligation_id: obligation.obligation_id,
    child_obligation_id: obligation.obligation_id,
    obligation, candidates: [entry],
  });
  assert.equal(plan.adoption_state.adopted, true);
  assert.equal(plan.evidence_classification,
    PROVIDER_EVIDENCE_PROVENANCE.CURRENT_RUN_RECOVER_FRAGMENTS);
  assert.equal(plan.exact_next_action, 'recover_unresolved_partial_output_fragments');
  assert.equal(plan.provider_call_required, true);
});

test('Resume authority and UI dispatch the same adopted-fragment recovery plan', () => {
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id, 1);
  const range = fixture.adopted_ranges[0];
  const obligation = pendingAdopted(ledger, range);
  const entry = retainedEntry({ ...range, logical_run_id: 'prior-run',
    durableIds: range.durable_ids });
  const checkpoint = { status: 'awaiting_manual_resume',
    next_source_offset: 40, source_message_count: 9434,
    run_manifest: { logical_run_id: fixture.logical_run_id, obligation_ledger: ledger },
    controller_heartbeat: { terminal: true } };
  const authority = deriveMemorizeRecoveryAuthority({ checkpoint, ledger,
    provider_audit: { recent_attempts: [], attempted: 1, obligations: {} },
    provider_completion_journal: { entries: { [entry.attempt_id]: entry },
      order: [entry.attempt_id] },
    checkpoint_status: checkpoint.status });
  assert.equal(authority.resume_eligible, true);
  assert.equal(authority.provider_call_permitted, true);
  assert.equal(authority.next_executable_action,
    'recover_unresolved_partial_output_fragments');
  assert.equal(authority.base_resume_eligibility.retained_evidence_plan
    .evidence_origin_attempt_id, range.attempt_id);
  checkpoint.authoritative_recovery = authority;
  checkpoint.resume_eligibility = authority.base_resume_eligibility;
  const presentation = selectRecoveryPresentation({ checkpoint,
    recovery: { authoritative_recovery: authority },
    resumeEligibility: authority.base_resume_eligibility });
  assert.equal(presentation.disabled, false);
  assert.match(presentation.status_text, /Safe Resume is authorized/);
  assert.equal(obligation.current_state, 'pending_recovery');
});

test('a no-progress Resume with the same exact action is not advertised again', () => {
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id, 1);
  const range = fixture.adopted_ranges[0];
  pendingAdopted(ledger, range);
  const checkpoint = { status: 'awaiting_manual_resume', next_source_offset: 40,
    source_message_count: 9434, committed_chunks: 2,
    run_manifest: { logical_run_id: fixture.logical_run_id, obligation_ledger: ledger },
    controller_heartbeat: { terminal: true } };
  const providerAudit = { attempted: 2, recent_attempts: [], obligations: {} };
  const before = snapshotMemorizeResumeProgress({ checkpoint, ledger,
    provider_audit: providerAudit });
  const after = snapshotMemorizeResumeProgress({ checkpoint, ledger,
    provider_audit: providerAudit, at: before.captured_at + 10 });
  checkpoint.resume_progress = deriveMemorizeResumeProgress(before, after, {
    invocation_id: 'resume-no-progress',
    planned_exact_action: before.exact_action,
    action_actually_executed: before.exact_action,
  });
  assert.equal(checkpoint.resume_progress.progress, false);
  assert.equal(checkpoint.resume_progress.no_progress_reason,
    'resume_no_progress_same_action');
  const authority = deriveMemorizeRecoveryAuthority({ checkpoint, ledger,
    provider_audit: providerAudit, checkpoint_status: checkpoint.status });
  assert.equal(authority.resume_eligible, false);
  assert.equal(authority.resume_blockers[0].reason_code,
    'resume_no_progress_same_action');
});

test('retained-evidence rejection remains a local unresolved error, not provider transport', () => {
  const report = {
    errors: 1,
    error_details: [{ label: 'session extraction error',
      message: 'Session retained provider evidence could not be applied safely.' }],
    local_lifecycle_failures: [{ code: 'SME_PROVIDER_EVIDENCE_DECISION_REJECTED',
      obligation_id: obligationId(40, 59), resolved: false }],
    provider_attempt_audit: { obligation_history_truncated: false,
      terminally_unresolved_malformed_obligations: 0,
      recovered_malformed_obligations: 0, recent_attempts: [],
      failure_accounting: { terminal_unresolved_obligation_count: 0,
        recovered_failed_obligation_count: 0, unique_failed_obligation_count: 0,
        provider_transport_failure_count: 0, physical_failure_observation_count: 0 } },
  };
  const accounting = deriveRunErrorAccounting(report);
  assert.equal(accounting.current_local_lifecycle_failures.count, 1);
  assert.equal(accounting.terminal_unresolved_obligations.count, 1);
  assert.equal(accounting.provider_transport_failures.count, 0);
  const status = deriveRunStatus({ ...report, error_accounting: accounting,
    status: 'completed', logical_run: { terminal_status: 'completed',
      terminal_reason_code: 'finalization_committed', full_cumulative_coverage_confirmed: true,
      source_window: { message_count: 20 }, cumulative_committed_count: 20,
      remaining_gap_count: 0 },
    completion_evidence: { finalization_committed: true } });
  assert.equal(status.outcome_status, 'completed_with_errors');
  assert.equal(status.unresolved_error_count, 1);
});

test('duplicate adoption receipt is a monotonic no-op in pending recovery', () => {
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id, 1);
  const range = fixture.adopted_ranges[0];
  const obligation = pendingAdopted(ledger, range);
  obligation.evidence_adoptions = [{
    origin_attempt_id: range.attempt_id, origin_logical_run_id: 'prior-run',
    adopted_into_logical_run_id: fixture.logical_run_id,
    canonical_obligation_id: obligation.obligation_id,
  }];
  const revision = obligation.revision;
  const result = applyMemorizeLifecycleEvent(ledger, identity(range.start, range.end), {
    type: 'terminal_provider_evidence_adopted', provider_attempt_id: range.attempt_id,
    adopted_from_attempt_id: range.attempt_id,
    adopted_from_logical_run_id: 'prior-run',
    evidence_fingerprint: `prior-run|${range.attempt_id}|${fingerprint(range.start, range.end)}`,
    adopted_terminal_evidence: {
      original_root_obligation_id: obligation.obligation_id,
      original_leaf_obligation_id: obligation.obligation_id,
      tier: 'session', owner: null, source_range: obligation.source_range,
      source_fingerprint: obligation.source_fingerprint,
      terminal_outcome: 'completed', private_response_retained: true,
    }, at: 2,
  });
  assert.equal(result.status, 'idempotent_duplicate_verified');
  assert.equal(obligation.current_state, 'pending_recovery');
  assert.equal(obligation.revision, revision);
  assert.equal(ledger.transition_violations.length, 0);
});

test('v0.9.83 migration converges legacy duplicates, plans all evidence, and repairs journal truth', () => {
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id, 1);
  for (const range of fixture.adopted_ranges) {
    pendingAdopted(ledger, range);
    transitionMemorizeObligation(ledger, {
      obligation_id: `session:chat:${range.start}-${range.end}:legacy`,
      logical_run_id: fixture.logical_run_id, tier: 'session', owner: null,
      source_range: { start: range.start, end: range.end }, source_fingerprint: null,
    }, { current_state: 'pending_recovery', exact_reason_code: 'legacy_pending',
      next_eligible_action: 'resume_exact_obligation', at: 1 });
  }
  const precedence = fixture.precedence_range;
  transitionMemorizeObligation(ledger, identity(precedence.start, precedence.end), {
    current_state: 'unattempted', exact_reason_code: 'not_attempted',
    next_eligible_action: 'dispatch_provider_request', at: 1,
  });
  transitionMemorizeObligation(ledger, {
    obligation_id: 'longterm:test:80-99:journal', logical_run_id: fixture.logical_run_id,
    tier: 'longterm', owner: 'Test', source_range: { start: 80, end: 99 },
    source_fingerprint: 'journal-fingerprint',
  }, { current_state: 'durably_committed', persistence_result: 'committed',
    lifecycle: { durably_persisted_record_ids: ['journal-record'] }, at: 1 });
  const entries = {};
  const order = [];
  for (const range of fixture.adopted_ranges) {
    const entry = retainedEntry({ ...range, logical_run_id: 'prior-run',
      durableIds: range.durable_ids });
    entries[entry.attempt_id] = entry; order.push(entry.attempt_id);
  }
  const verified = retainedEntry({ start: precedence.start, end: precedence.end,
    attempt_id: precedence.verified_attempt_id, started_at: 10,
    durableIds: ['record-120-a', 'record-120-b'] });
  const incomplete = retainedEntry({ start: precedence.start, end: precedence.end,
    attempt_id: precedence.newer_incomplete_attempt_id, started_at: 20,
    privateEvidence: false, completedNoCandidates: true });
  entries[verified.attempt_id] = verified; entries[incomplete.attempt_id] = incomplete;
  order.push(verified.attempt_id, incomplete.attempt_id);
  const journalMismatch = {
    attempt_id: fixture.journal_reconciliation_attempt_id,
    logical_run_id: fixture.logical_run_id,
    root_obligation_id: 'longterm:test:80-99:journal',
    child_obligation_id: 'longterm:test:80-99:journal', tier: 'longterm', owner: 'Test',
    source_range: { start: 80, end: 99 }, source_fingerprint: 'journal-fingerprint',
    terminal_outcome: 'completed', response_text: '<memory>journal</memory>',
    parser_result: { status: 'accepted', records: [{ id: 'journal-candidate' }] },
    validation: { status: 'accepted' },
    persistence: { status: 'not_started', durable_record_ids: [] },
    ledger_transition: { status: 'applied_verified', checkpoint_eligible: true },
  };
  entries[journalMismatch.attempt_id] = journalMismatch; order.push(journalMismatch.attempt_id);
  const metadata = { provider_completion_journal: { entries, order },
    live_memory_health: { provider_attempt_audit: { recent_attempts: [], obligations: {} } } };
  const checkpoint = { status: 'awaiting_manual_resume',
    run_manifest: { logical_run_id: fixture.logical_run_id, obligation_ledger: ledger },
    controller_heartbeat: { terminal: true }, transaction_lifecycle: null };
  const first = migrateV0983RetainedEvidenceRecoveryState({ checkpoint, metadata, at: 10 });
  assert.equal(first.provider_calls, 0);
  assert.equal(first.persistence_calls, 0);
  assert.equal(first.detail.removed_legacy_obligation_count, 2);
  assert.equal(first.detail.planned_obligation_count, 3);
  for (const range of fixture.adopted_ranges) {
    const obligation = ledger.obligations[obligationId(range.start, range.end)];
    assert.equal(obligation.current_state, 'pending_recovery');
    assert.equal(obligation.next_eligible_action,
      'recover_unresolved_partial_output_fragments');
    assert.equal(obligation.evidence_adoptions[0].origin_attempt_id, range.attempt_id);
  }
  assert.equal(ledger.obligations[obligationId(precedence.start, precedence.end)]
    .next_eligible_action, 'adopt_exact_prior_run_evidence');
  assert.equal(first.detail.planned_obligations.find((item) =>
    item.obligation_id === obligationId(precedence.start, precedence.end))
    .evidence_origin_attempt_id, precedence.verified_attempt_id);
  assert.equal(journalMismatch.persistence.status, 'verified_existing');
  assert.deepEqual(journalMismatch.persistence.durable_record_ids, ['journal-record']);
  const serialized = JSON.stringify({ checkpoint, metadata });
  const second = migrateV0983RetainedEvidenceRecoveryState({ checkpoint, metadata, at: 20 });
  assert.equal(second.migrated, false);
  assert.equal(JSON.stringify({ checkpoint, metadata }), serialized);
});
