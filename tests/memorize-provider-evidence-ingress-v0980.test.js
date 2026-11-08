import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { coordinateProviderEvidenceIngress }
  from '../memorize-lifecycle-coordinator.js';
import { createMemorizeExecutionContext } from '../memorize-execution-context.js';
import { applyMemorizeLifecycleEvent, createMemorizeObligationLedger,
  reconcileMemorizeLifecycleFromJournal, reconcileMemorizeRunningObligations }
  from '../memorize-obligation-ledger.js';
import { deriveMemorizeResumeEligibility } from '../memorize-authority-model.js';
import { createMemorizeTierPipeline } from '../memorize-tier-pipeline.js';
import { createMalformedRecoveryBudget, recoverMalformedTaggedOutput }
  from '../malformed-output-recovery.js';
import { deriveRunErrorAccounting, deriveRunStatus } from '../run-status-utils.js';

const fixture = JSON.parse(readFileSync(new URL(
  './fixtures/v0979-provider-evidence-ingress.json', import.meta.url)));

function harness(owner = 'Alex Mercer') {
  const root = `longterm:${owner.toLowerCase()}:0-19:${fixture.source_fingerprint}`;
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id);
  applyMemorizeLifecycleEvent(ledger, {
    obligation_id: root, logical_run_id: fixture.logical_run_id,
    tier: 'longterm', owner, source_range: fixture.source_range,
    source_fingerprint: fixture.source_fingerprint,
  }, {
    type: 'recovery_required', reason_code: 'longterm_extraction_not_safely_committed',
    next_action: 'resume_exact_obligation', event_id: `pending:${root}`,
  });
  let providerCalls = 0;
  const execution = createMemorizeExecutionContext({
    controller: { lifecycle_required: true },
    provider: { root_obligation_id: root, root_source_range: fixture.source_range,
      root_source_fingerprint: fixture.source_fingerprint,
      resumed_pending_obligation: true, root_obligation_state: 'pending_recovery' },
    hooks: { obligation_event: async (event) => applyMemorizeLifecycleEvent(ledger, event, event) },
  });
  const pipeline = createMemorizeTierPipeline({
    tier: 'longterm', tierLabel: 'Long-Term', owner, execution,
    metadata: { active_catchup_run_id: fixture.logical_run_id }, range: fixture.source_range,
    rangeId: `longterm:${owner}:0-19`, coverageLedger: { records: [] },
    sourceFingerprint: fixture.source_fingerprint,
    preflight: { configured_context_limit: 1000, effective_context_limit: 1000,
      reserved_output_tokens: 100, safety_margin_tokens: 10,
      protocol_overhead_tokens: 10, estimated_input_tokens: 100 },
    requestBudget: { runtimeContextLookup: null }, providerConfigSignature: 'config',
    chatId: 'chat', expectedOutputFormat: 'longterm_tagged_lines_v1',
  });
  return { root, ledger, pipeline, providerCalls: () => providerCalls,
    dispatch: () => { providerCalls++; } };
}

function priorEvidence(owner = 'Alex Mercer', patch = {}) {
  const source = fixture.longterm_attempts.find((item) => item.owner === owner);
  const root = `longterm:${owner.toLowerCase()}:0-19:${fixture.source_fingerprint}`;
  return {
    attempt_id: source.attempt_id, logical_run_id: fixture.prior_logical_run_id,
    root_obligation_id: root, child_obligation_id: null, tier: 'longterm', owner,
    source_range: fixture.source_range, source_fingerprint: fixture.source_fingerprint,
    terminal_outcome: 'completed', request_kind: 'original',
    response_text: '[fact:2:permanent] retained exact response',
    parser_result: { status: 'accepted', records: [{ id: 'candidate-1',
      _raw_entity_names: [`${owner}/character`] }] },
    validation: { status: 'pending' }, persistence: { status: 'committed', durable_record_ids: [] },
    ...patch,
  };
}

test('cross-run Long-Term evidence is adopted without provider start or provider call', async () => {
  const h = harness();
  const result = await h.pipeline.ingestProviderEvidence('adopt_exact_prior_run_evidence', {
    evidence: priorEvidence(),
  });
  assert.equal(result.status, 'pending_downstream_processing');
  assert.equal(result.provider_call_required, false);
  assert.equal(h.providerCalls(), 0);
  const obligation = h.ledger.obligations[h.root];
  assert.equal(obligation.current_state, 'provider_response_received');
  assert.deepEqual(obligation.provider_attempt_lineage, ['provider-mvzrjqfz-1']);
  assert.equal(obligation.metrics.adopted_from_logical_run_id, fixture.prior_logical_run_id);
  assert.equal(obligation.semantic_event_history.some((item) =>
    item.type === 'provider_attempt_started'), false);
});

test('all six recorded Long-Term completions adopt exactly with zero provider calls', async () => {
  for (const recorded of fixture.longterm_attempts) {
    const h = harness(recorded.owner);
    const result = await h.pipeline.ingestProviderEvidence('adopt_exact_prior_run_evidence', {
      evidence: priorEvidence(recorded.owner),
    });
    assert.equal(result.status, 'pending_downstream_processing');
    assert.equal(result.physical_attempt_id, recorded.attempt_id);
    assert.equal(result.provider_call_required, false);
    assert.equal(h.providerCalls(), 0);
  }
});

for (const [label, patch, missing] of [
  ['fingerprint', { source_fingerprint: 'fnv1a-wrong' }, 'source_fingerprint'],
  ['owner', { owner: 'Wrong Owner' }, 'owner'],
  ['range', { source_range: { start: 1, end: 19 } }, 'source_range'],
]) test(`cross-run evidence with mismatched ${label} is rejected`, async () => {
  const h = harness();
  const result = await h.pipeline.ingestProviderEvidence('adopt_exact_prior_run_evidence', {
    evidence: priorEvidence('Alex Mercer', patch),
  });
  assert.equal(result.status, 'rejected');
  assert.ok(result.missing_evidence.includes(missing));
  assert.equal(h.ledger.obligations[h.root].current_state, 'pending_recovery');
});

test('missing retained response blocks locally and never requests an equivalent replay', async () => {
  const h = harness();
  const result = await h.pipeline.ingestProviderEvidence('adopt_exact_prior_run_evidence', {
    evidence: priorEvidence('Alex Mercer', { response_text: null }),
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.provider_call_required, false);
  assert.equal(result.next_action, 'inspect_or_restore_private_terminal_evidence');
  assert.equal(h.providerCalls(), 0);
});

test('response ingress before registration is an exhaustive rejection, not an exception', async () => {
  const h = harness();
  const result = await h.pipeline.ingestProviderEvidence('record_new_response', {
    attempt: { attempt_id: 'unregistered-attempt' },
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.provider_call_required, false);
});

test('pending accepted output selects local downstream continuation', async () => {
  const identity = {
    logical_run_id: fixture.logical_run_id,
    root_obligation_id: fixture.session.root_obligation_id,
    leaf_obligation_id: fixture.session.root_obligation_id,
    tier: 'session', owner: null, source_range: fixture.source_range,
    source_fingerprint: fixture.source_fingerprint,
  };
  const result = await coordinateProviderEvidenceIngress({
    operation: 'continue_pending_downstream_processing', identity,
    prior_state: 'provider_response_received', emit_lifecycle_event: async () => null,
    evidence: { attempt_id: fixture.session.accepted_pending_attempt_id,
      response_text: '{"type":"detail","content":"retained"}',
      parser_result: { status: 'accepted', records: [{ id: 'candidate-1' }] } },
  });
  assert.equal(result.status, 'pending_downstream_processing');
  assert.equal(result.provider_call_required, false);
  assert.equal(result.persistence_required, true);
});

test('terminal malformed attempts settle out of provider_running and second repair is stable', () => {
  const root = fixture.session.root_obligation_id;
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id);
  const identity = { obligation_id: root, logical_run_id: fixture.logical_run_id,
    tier: 'session', owner: null, source_range: fixture.source_range,
    source_fingerprint: fixture.source_fingerprint };
  for (const attemptId of fixture.session.malformed_attempt_ids) {
    applyMemorizeLifecycleEvent(ledger, identity, {
      type: 'provider_attempt_started', provider_attempt_id: attemptId,
      event_id: `start:${attemptId}`,
    });
    if (attemptId !== fixture.session.malformed_attempt_ids.at(-1)) {
      applyMemorizeLifecycleEvent(ledger, identity, {
        type: 'terminal_malformed_attempt_settled', provider_attempt_id: attemptId,
        terminal_outcome: 'provider_response_malformed',
        event_id: `settle-live:${attemptId}`,
      });
    }
  }
  const journal = fixture.session.malformed_attempt_ids.map((attemptId) => ({
    attempt_id: attemptId, root_obligation_id: root, child_obligation_id: root,
    tier: 'session', owner: null, source_range: fixture.source_range,
    source_fingerprint: fixture.source_fingerprint,
    terminal_outcome: 'provider_response_malformed', recovery_stage: 'regeneration',
    persistence: { status: 'not_applicable', reason_code: 'invalid_output' },
    ledger_transition: { status: 'pending_reconciliation' },
  }));
  const attempts = { recent_attempts: journal.map((entry) => ({ ...entry,
    logical_obligation_id: root, malformed_reason: 'invalid_output' })) };
  const first = reconcileMemorizeLifecycleFromJournal(ledger, {
    logical_run_id: fixture.logical_run_id, journal, provider_attempts: attempts, at: 10,
  });
  assert.equal(ledger.obligations[root].current_state, 'pending_recovery');
  assert.equal(first.provider_calls, 0);
  const second = reconcileMemorizeLifecycleFromJournal(ledger, {
    logical_run_id: fixture.logical_run_id, journal, provider_attempts: attempts, at: 10,
  });
  assert.equal(second.mutations, 0);
});

test('bounded recovery settles each terminal physical attempt before registering its successor', async () => {
  const settled = [];
  const finished = [];
  const registered = new Set();
  let sequence = 1;
  let lastBegun = null;
  const original = { attempt_id: 'physical-0' };
  await assert.rejects(() => recoverMalformedTaggedOutput({
    response: 'unstructured response', tier: 'session', parse: () => [],
    generate: async () => {
      assert.ok(registered.has(lastBegun), `${lastBegun} must be registered before dispatch`);
      return 'still unstructured';
    },
    originalPrompt: 'prompt', responseLength: 50,
    originalAttempt: original,
    beginAttempt: () => {
      lastBegun = `physical-${sequence++}`;
      return { attempt_id: lastBegun };
    },
    finishAttempt: (attempt, patch) => {
      Object.assign(attempt, patch);
      finished.push(attempt.attempt_id);
      return attempt;
    },
    budget: createMalformedRecoveryBudget({ maximum_additional_provider_requests: 3 }),
    sourceUnits: [],
    onAttemptSettled: async (attempt) => { settled.push(attempt.attempt_id); },
    onAttemptRegistered: async (attempt) => {
      for (const attemptId of finished) assert.ok(settled.includes(attemptId),
        `${attemptId} must be semantically settled before successor registration`);
      registered.add(attempt.attempt_id);
    },
  }));
  assert.ok(settled.includes('physical-0'));
});

test('redacted v0.9.79 fixture converges to coherent local work with preserved Session records', async () => {
  let providerCalls = 0;
  for (const recorded of fixture.longterm_attempts) {
    const h = harness(recorded.owner);
    const adopted = await h.pipeline.ingestProviderEvidence('adopt_exact_prior_run_evidence', {
      evidence: priorEvidence(recorded.owner),
    });
    assert.equal(adopted.provider_call_required, false);
    const identity = h.ledger.obligations[h.root];
    for (const type of ['parser_accepted', 'validation_accepted', 'records_staged',
      'records_durably_persisted']) {
      const result = applyMemorizeLifecycleEvent(h.ledger, identity, {
        type, provider_attempt_id: recorded.attempt_id,
      });
      assert.equal(result.applied, true);
    }
    assert.equal(h.ledger.obligations[h.root].current_state, 'durably_committed');
    providerCalls += h.providerCalls();
  }
  assert.equal(providerCalls, 0);

  const root = fixture.session.root_obligation_id;
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id);
  applyMemorizeLifecycleEvent(ledger, {
    obligation_id: root, logical_run_id: fixture.logical_run_id,
    tier: 'session', owner: null, source_range: fixture.source_range,
    source_fingerprint: fixture.source_fingerprint,
  }, {
    type: 'recovery_required', reason_code: 'session_extraction_not_safely_committed',
    next_action: 'resume_exact_obligation',
  });
  const session = ledger.obligations[root];
  session.current_state = 'provider_running';
  session.provider_attempt_lineage = [fixture.session.accepted_pending_attempt_id,
    ...fixture.session.malformed_attempt_ids];
  session.lifecycle.durably_persisted_record_ids = [...fixture.session.durable_record_ids];
  session.lifecycle.durable_record_candidate_map = {
    ...fixture.session.durable_record_candidate_map,
  };
  session.metrics.persisted_records = fixture.session.durable_record_ids.length;
  const acceptedEntry = {
    attempt_id: fixture.session.accepted_pending_attempt_id,
    logical_run_id: fixture.logical_run_id,
    root_obligation_id: root, child_obligation_id: root,
    tier: 'session', owner: null, source_range: fixture.source_range,
    source_fingerprint: fixture.source_fingerprint,
    terminal_outcome: 'completed', private_response_retained: true,
    response_text: '{"type":"detail","content":"retained"}',
    parser_result: { status: 'accepted', records: [{ id: 'pending-candidate' }] },
    validation: { status: 'pending' }, persistence: { status: 'pending' },
  };
  const malformedEntries = fixture.session.malformed_attempt_ids.map((attemptId) => ({
    attempt_id: attemptId, logical_run_id: fixture.logical_run_id,
    root_obligation_id: root, child_obligation_id: root,
    tier: 'session', owner: null, source_range: fixture.source_range,
    source_fingerprint: fixture.source_fingerprint,
    terminal_outcome: 'provider_response_malformed',
    persistence: { status: 'not_applicable', reason_code: 'invalid_output' },
    ledger_transition: { status: 'pending_reconciliation' },
  }));
  const journal = { entries: [acceptedEntry, ...malformedEntries] };
  const attempts = { recent_attempts: journal.entries.map((entry) => ({
    ...entry, logical_obligation_id: root,
  })) };
  const first = reconcileMemorizeLifecycleFromJournal(ledger, {
    logical_run_id: fixture.logical_run_id, journal, provider_attempts: attempts, at: 20,
  });
  assert.equal(ledger.obligations[root].current_state, 'pending_recovery');
  assert.equal(ledger.obligations[root].lifecycle.durably_persisted_record_ids.length, 3);
  assert.deepEqual(ledger.obligations[root].lifecycle.durable_record_candidate_map,
    fixture.session.durable_record_candidate_map);
  const eligibility = deriveMemorizeResumeEligibility({
    ledger, provider_audit: attempts, provider_completion_journal: journal,
  });
  assert.equal(eligibility.mode, 'local_reconciliation_only');
  assert.equal(eligibility.next_eligible_action, 'continue_pending_downstream_processing');
  assert.equal(eligibility.provider_call_required, false);
  const second = reconcileMemorizeLifecycleFromJournal(ledger, {
    logical_run_id: fixture.logical_run_id, journal, provider_attempts: attempts, at: 20,
  });
  assert.ok(first.mutations > 0);
  assert.equal(second.mutations, 0);
});

test('fixture preserves all three pre-existing Session records and mappings', () => {
  assert.equal(fixture.session.durable_record_ids.length, 3);
  for (const id of fixture.session.durable_record_ids) {
    assert.ok(fixture.session.durable_record_candidate_map[id]);
  }
});

test('resume eligibility permits only local reconciliation while historical violations remain', () => {
  const h = harness();
  h.ledger.transition_violations.push({
    code: 'provider_response_without_registered_attempt', obligation_id: h.root,
  });
  const obligation = h.ledger.obligations[h.root];
  obligation.next_eligible_action = 'continue_pending_downstream_processing';
  const local = deriveMemorizeResumeEligibility({ ledger: h.ledger,
    provider_audit: { recent_attempts: [] } });
  assert.equal(local.eligible, true);
  assert.equal(local.mode, 'local_reconciliation_only');
  assert.equal(local.provider_call_required, false);

  obligation.next_eligible_action = 'dispatch_bounded_recovery_attempt';
  const provider = deriveMemorizeResumeEligibility({ ledger: h.ledger,
    provider_audit: { recent_attempts: [] } });
  assert.equal(provider.eligible, false);
  assert.equal(provider.reason_code, 'lifecycle_invariants_invalid_for_provider_resume');
  assert.equal(provider.provider_call_required, false);
});

test('exact retained completion turns a legacy resume action into local-only adoption', () => {
  const h = harness();
  h.ledger.transition_violations.push({
    code: 'provider_response_without_registered_attempt', obligation_id: h.root,
  });
  const evidence = priorEvidence();
  evidence.private_response_retained = true;
  const eligibility = deriveMemorizeResumeEligibility({
    ledger: h.ledger, provider_audit: { recent_attempts: [] },
    provider_completion_journal: { entries: [evidence] },
  });
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.mode, 'local_reconciliation_only');
  assert.equal(eligibility.next_eligible_action, 'adopt_exact_prior_run_evidence');
  assert.equal(eligibility.physical_attempt_id, evidence.attempt_id);
  assert.equal(eligibility.provider_call_required, false);
});

test('Resume eligibility refuses an orphan ledger-running obligation', () => {
  const h = harness();
  const obligation = h.ledger.obligations[h.root];
  obligation.current_state = 'provider_running';
  obligation.next_eligible_action = null;
  const eligibility = deriveMemorizeResumeEligibility({
    ledger: h.ledger, provider_audit: { recent_attempts: [] },
  });
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason_code, 'provider_runtime_not_reconciled');
  assert.equal(eligibility.provider_call_required, false);
});

test('stale running reconciliation matches the exact child attempt and selects local settlement', () => {
  const root = 'session:chat:0-19:fnv1a-root';
  const child = 'session:chat:0-9:fnv1a-child';
  const ledger = createMemorizeObligationLedger('run-child');
  applyMemorizeLifecycleEvent(ledger, {
    obligation_id: root, logical_run_id: 'run-child', tier: 'session', owner: null,
    source_range: { start: 0, end: 19 }, source_fingerprint: 'fnv1a-root',
  }, {
    type: 'recovery_children_declared', event_id: 'declare-child', children: [{
      obligation_id: child, root_obligation_id: root, parent_obligation_id: root,
      logical_run_id: 'run-child', tier: 'session', owner: null,
      source_range: { start: 0, end: 9 }, source_fingerprint: 'fnv1a-child',
    }, {
      obligation_id: 'session:chat:10-19:fnv1a-child-2', root_obligation_id: root,
      parent_obligation_id: root, logical_run_id: 'run-child', tier: 'session', owner: null,
      source_range: { start: 10, end: 19 }, source_fingerprint: 'fnv1a-child-2',
    }],
  });
  applyMemorizeLifecycleEvent(ledger, ledger.obligations[child], {
    type: 'provider_attempt_started', provider_attempt_id: 'attempt-child',
  });
  const result = reconcileMemorizeRunningObligations(ledger, { recent_attempts: [{
    attempt_id: 'attempt-child', root_obligation_id: root, child_obligation_id: child,
    logical_obligation_id: root, terminal_outcome: 'provider_response_malformed',
  }] });
  assert.equal(result.repairs.length, 1);
  assert.equal(result.repairs[0].next_eligible_action, 'settle_terminal_malformed_attempt');
  assert.equal(ledger.obligations[child].current_state, 'pending_recovery');
});

test('run-status projection names local reconciliation separately from provider failure', () => {
  const status = deriveRunStatus({
    lifecycle_status: 'incomplete',
    catch_up_recovery: { available: true, resumable: true,
      resume_mode: 'local_reconciliation_only' },
    error_accounting: {
      terminal_unresolved_obligations: { count: 0 }, recovered_obligations: { count: 0 },
      historical_failure_observations: { count: 0 }, quality_notices: { count: 0 },
      fatal_run_level_errors: { count: 0 }, operational_pauses: { count: 0 },
    },
  });
  assert.equal(status.label, 'Incomplete — local reconciliation required');
  assert.ok(status.status_reason_codes.includes('provider_call_not_required'));
  assert.equal(status.unresolved_error_count, 0);
});

test('displayed lifecycle failures reconcile without provider-transport misattribution', () => {
  const lifecycleErrors = fixture.longterm_attempts.map(() => ({
    label: 'long-term extraction error (chunk)',
    message: 'Memorize lifecycle transition was rejected at provider_response_received.',
    persistence: false,
  }));
  const violations = fixture.longterm_attempts.map((item) => ({
    code: 'provider_response_without_registered_attempt',
    provider_attempt_id: item.attempt_id,
  }));
  const accounting = deriveRunErrorAccounting({
    error_details: [...lifecycleErrors, {
      label: 'session extraction error (chunk)',
      message: 'Session extraction exhausted bounded malformed-output recovery.',
      persistence: false,
    }],
    authoritative_obligation_ledger: { invariants: { violations } },
    provider_completion_journal: { entries: fixture.longterm_attempts.map((item) => ({
      attempt_id: item.attempt_id, private_response_retained: true,
      terminal_outcome: 'completed',
    })) },
    provider_attempt_audit: { failure_accounting: {
      physical_failure_observation_count: 4, malformed_response_count: 4,
      provider_transport_failure_count: 0, parser_structural_failure_count: 4,
      validation_failure_count: 0, unique_failed_obligation_count: 1,
      terminal_unresolved_obligation_count: 1,
    } },
  });
  assert.equal(accounting.displayed_error_records.count, 7);
  assert.equal(accounting.lifecycle_transition_rejections.count, 6);
  assert.equal(accounting.displayed_error_records.categories.provider_transport_failure, 0);
  assert.equal(accounting.locally_repairable_reconciliation_failures.count, 6);
  assert.equal(accounting.terminal_unresolved_obligations.count, 1);
  assert.equal(accounting.reconciliation.displayed_error_records_reconcile_to_categories, true);
  assert.equal(accounting.reconciliation.consistent, true);
});

test('production replay branches use ingress and cannot construct null attempts', () => {
  for (const file of ['../longterm.js', '../session.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /applyRetainedEvidenceDecision/);
    assert.doesNotMatch(source, /bypassEquivalentRootReplay/);
    assert.doesNotMatch(source, /attempt_id:\s*null,[\s\S]{0,160}prior_window_recovery_state/);
    assert.match(source, /recoveryOnlyMode \? \[\] : parse(?:Extraction|Session)Output\(response\)/);
    assert.match(source, /onAttemptRegistered:[\s\S]{0,900}ingestProviderEvidence\('register_new_attempt'/);
  }
  const settingsSource = readFileSync(new URL('../settings.js', import.meta.url), 'utf8');
  const reconciliation = settingsSource.indexOf('const runningReconciliation =');
  const eligibility = settingsSource.indexOf('const reconciledResumeEligibility =', reconciliation);
  const attemptStart = settingsSource.indexOf('beginCatchUpAttempt(', eligibility);
  assert.ok(reconciliation >= 0 && reconciliation < eligibility && eligibility < attemptStart,
    'Resume must reconcile, derive eligibility, and only then begin an attempt');
});
