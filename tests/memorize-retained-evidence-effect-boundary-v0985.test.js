import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createMemorizeExecutionContext } from '../memorize-execution-context.js';
import { migrateV0984RetainedEvidenceEffectBoundaryState }
  from '../memorize-lifecycle-migration.js';
import { applyMemorizeLifecycleEvent, createMemorizeObligationLedger }
  from '../memorize-obligation-ledger.js';
import { deriveMemorizeRecoveryAuthority } from '../memorize-recovery-authority.js';
import { createMemorizeTierPipeline } from '../memorize-tier-pipeline.js';
import { selectRecoveryPresentation } from '../memorize-projections.js';
import { appendRetainedEvidenceDecision, selectRetainedProviderEvidence }
  from '../provider-completion-journal.js';
import { planRetainedProviderEvidence, PROVIDER_EVIDENCE_PROVENANCE }
  from '../retained-evidence-plan.js';
import { deriveRunErrorAccounting } from '../run-status-utils.js';

const fixture = JSON.parse(readFileSync(new URL(
  './fixtures/v0984-frozen-retained-evidence.json', import.meta.url), 'utf8'));

const identity = () => ({
  obligation_id: fixture.obligation_id,
  logical_run_id: fixture.logical_run_id,
  tier: 'longterm', owner: fixture.owner,
  source_range: fixture.source_range,
  source_fingerprint: fixture.source_fingerprint,
});

function retainedEntry(patch = {}) {
  return {
    attempt_id: fixture.attempt_id,
    logical_run_id: fixture.prior_logical_run_id,
    root_obligation_id: fixture.obligation_id,
    child_obligation_id: fixture.obligation_id,
    tier: 'longterm', owner: fixture.owner,
    source_range: fixture.source_range,
    source_fingerprint: fixture.source_fingerprint,
    terminal_outcome: 'completed',
    response_text: '[fact:2:permanent] retained exact response',
    parser_result: { status: 'accepted', accepted_count: 1,
      records: [{ id: 'candidate-1',
        _raw_entity_names: [`${fixture.owner}/character`] }] },
    validation: { status: 'accepted', accepted_count: 1 },
    persistence: { status: 'committed', durable_record_ids: ['record-1'] },
    ledger_transition: { status: 'pending_reconciliation' },
    ...patch,
  };
}

function createProductionHarness({ adopted = false, entryPatch = {} } = {}) {
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id);
  applyMemorizeLifecycleEvent(ledger, identity(), {
    type: 'recovery_required', reason_code: 'longterm_extraction_not_safely_committed',
    next_action: 'resume_exact_obligation', event_id: 'pending',
  });
  const entry = retainedEntry(entryPatch);
  if (adopted) {
    applyMemorizeLifecycleEvent(ledger, identity(), {
      type: 'terminal_provider_evidence_adopted',
      provider_attempt_id: entry.attempt_id,
      evidence_fingerprint: `${entry.logical_run_id}|${entry.attempt_id}|${entry.source_fingerprint}`,
      adopted_from_logical_run_id: entry.logical_run_id,
      adopted_from_attempt_id: entry.attempt_id,
      owner_applicability: { eligible: true, classification: 'exact_owner_scope' },
      adopted_terminal_evidence: {
        original_root_obligation_id: entry.root_obligation_id,
        original_leaf_obligation_id: entry.child_obligation_id,
        tier: entry.tier, owner: entry.owner, source_range: entry.source_range,
        source_fingerprint: entry.source_fingerprint,
        terminal_outcome: entry.terminal_outcome, private_response_retained: true,
      },
    });
    applyMemorizeLifecycleEvent(ledger, identity(), {
      type: 'recovery_required', reason_code: 'post_adoption_controller_interruption',
      next_action: 'continue_pending_downstream_processing', event_id: 'interrupted',
    });
  }
  const metadata = {
    active_catchup_run_id: fixture.logical_run_id,
    provider_completion_journal: {
      schema_version: 5, entries: { [entry.attempt_id]: entry }, order: [entry.attempt_id],
    },
  };
  const execution = createMemorizeExecutionContext({
    controller: { lifecycle_required: true },
    provider: { root_obligation_id: fixture.obligation_id,
      root_source_range: fixture.source_range,
      root_source_fingerprint: fixture.source_fingerprint,
      resumed_pending_obligation: true, root_obligation_state: 'pending_recovery' },
    hooks: {
      obligation_event: async (event) => applyMemorizeLifecycleEvent(ledger, event, event),
      get_canonical_obligation: () => ledger.obligations[fixture.obligation_id],
      retained_evidence_decision_recorded: async (attemptId, decision) =>
        appendRetainedEvidenceDecision(metadata, attemptId, decision),
    },
  });
  const pipeline = createMemorizeTierPipeline({
    tier: 'longterm', tierLabel: 'Long-Term', owner: fixture.owner, execution, metadata,
    range: fixture.source_range, rangeId: 'longterm:alex:0-19',
    coverageLedger: { records: [] }, sourceFingerprint: fixture.source_fingerprint,
    preflight: { configured_context_limit: 1000, effective_context_limit: 1000,
      reserved_output_tokens: 100, safety_margin_tokens: 10,
      protocol_overhead_tokens: 10, estimated_input_tokens: 100 },
    requestBudget: { runtimeContextLookup: null }, providerConfigSignature: 'config',
    chatId: 'chat', expectedOutputFormat: 'longterm_tagged_lines_v1',
  });
  return { ledger, metadata, pipeline, entry };
}

test('production pipeline records a decision without mutating the frozen planner snapshot', async () => {
  const h = createProductionHarness();
  const obligation = h.ledger.obligations[fixture.obligation_id];
  const selection = selectRetainedProviderEvidence(h.metadata, {
    root_obligation_id: fixture.obligation_id,
    child_obligation_id: fixture.obligation_id,
    tier: 'longterm', owner: fixture.owner, source_range: fixture.source_range,
    source_fingerprint: fixture.source_fingerprint,
    current_logical_run_id: fixture.logical_run_id, obligation,
  });
  assert.equal(Object.isFrozen(selection.entry), true);
  assert.equal(selection.entry.retained_evidence_decisions, undefined);
  const result = await h.pipeline.applyRetainedEvidenceDecision(selection, {
    evidence_adoption_reason: 'production_path_test',
  });
  assert.equal(result.status, 'pending_downstream_processing');
  assert.equal(h.ledger.obligations[fixture.obligation_id].current_state,
    'provider_response_received');
  assert.equal(selection.entry.retained_evidence_decisions, undefined);
  assert.equal(h.metadata.provider_completion_journal.entries[fixture.attempt_id]
    .retained_evidence_decisions.length, 1);
  assert.equal(h.metadata.provider_completion_journal.entries[fixture.attempt_id]
    .retained_evidence_decisions[0].effect_owner, 'provider_completion_journal');
});

test('adopted evidence is canonically reopened before parser continuation', async () => {
  const h = createProductionHarness({ adopted: true });
  const beforeRevision = h.ledger.obligations[fixture.obligation_id].revision;
  const selection = selectRetainedProviderEvidence(h.metadata, {
    root_obligation_id: fixture.obligation_id,
    child_obligation_id: fixture.obligation_id,
    tier: 'longterm', owner: fixture.owner, source_range: fixture.source_range,
    source_fingerprint: fixture.source_fingerprint,
    current_logical_run_id: fixture.logical_run_id,
    obligation: h.ledger.obligations[fixture.obligation_id],
  });
  assert.equal(selection.classification,
    PROVIDER_EVIDENCE_PROVENANCE.CURRENT_RUN_CONTINUE_DOWNSTREAM);
  const result = await h.pipeline.applyRetainedEvidenceDecision(selection);
  assert.equal(result.status, 'pending_downstream_processing');
  const obligation = h.ledger.obligations[fixture.obligation_id];
  assert.equal(obligation.current_state, 'provider_response_received');
  assert.ok(obligation.revision > beforeRevision);
  assert.equal(obligation.metrics.retained_evidence_reopened_from_state,
    'pending_recovery');
});

test('explicit owner-irrelevant evidence is rejected before adoption', () => {
  const entry = retainedEntry({ owner_applicability: {
    eligible: false, classification: 'owner_irrelevant',
    local_no_update_validated: true,
  } });
  const plan = planRetainedProviderEvidence({
    root_obligation_id: fixture.obligation_id,
    child_obligation_id: fixture.obligation_id,
    tier: 'longterm', owner: fixture.owner, source_range: fixture.source_range,
    source_fingerprint: fixture.source_fingerprint,
    current_logical_run_id: fixture.logical_run_id,
    obligation: { ...identity(), current_state: 'unattempted', revision: 1 },
    candidates: [entry],
  });
  assert.equal(plan.evidence_classification,
    null);
  assert.equal(plan.selected_entry, null);
  assert.equal(plan.candidate_decisions[0].classification,
    PROVIDER_EVIDENCE_PROVENANCE.OWNER_INAPPLICABLE);
  assert.equal(plan.candidate_decisions[0].owner_applicability.eligible, false);
  assert.equal(plan.provider_call_required, false);
});

test('parsed records for a different owner cannot be retained under request identity', () => {
  const entry = retainedEntry({ parser_result: {
    status: 'accepted', accepted_count: 1,
    records: [{ id: 'wrong-owner-candidate',
      _raw_entity_names: ['Aster Graves/character'] }],
  } });
  const plan = planRetainedProviderEvidence({
    root_obligation_id: fixture.obligation_id,
    child_obligation_id: fixture.obligation_id,
    tier: 'longterm', owner: fixture.owner, source_range: fixture.source_range,
    source_fingerprint: fixture.source_fingerprint,
    current_logical_run_id: fixture.logical_run_id,
    obligation: { ...identity(), current_state: 'unattempted', revision: 1,
      next_eligible_action: 'dispatch_provider_request' },
    candidates: [entry],
  });
  assert.equal(plan.selected_entry, null);
  assert.equal(plan.candidate_decisions[0].classification,
    PROVIDER_EVIDENCE_PROVENANCE.OWNER_INAPPLICABLE);
  assert.equal(plan.candidate_decisions[0].owner_applicability.classification,
    'parsed_record_owner_scope_mismatch');
  assert.deepEqual(plan.candidate_decisions[0].owner_applicability.reason_codes,
    ['retained_evidence_record_owner_scope_mismatch']);
});

test('v0.9.84 frozen-effect migration clears only the local blocker and converges', () => {
  const h = createProductionHarness({ adopted: true });
  const ledger = h.ledger;
  const checkpoint = {
    status: 'blocked_recovery_change_required', next_source_offset: 0,
    source_message_count: fixture.source_message_count, committed_chunks: 0,
    run_manifest: { logical_run_id: fixture.logical_run_id, obligation_ledger: ledger },
    controller_heartbeat: { terminal: true },
    transaction_lifecycle: { state: 'rolled_back' },
    resume_progress: {
      progress: false, no_progress_reason: 'resume_no_progress_same_action',
      after: { canonical_obligation_id: fixture.obligation_id,
        canonical_revision: ledger.obligations[fixture.obligation_id].revision,
        current_state: 'pending_recovery', exact_action: 'continue_pending_downstream_processing',
        downstream_cursor: 'accepted_records_persisted', provider_attempt_count: 0,
        next_source_offset: 0, committed_chunk_count: 0, pending_obligation_count: 1 },
    },
  };
  h.metadata.live_memory_health = { provider_attempt_audit: {
    recent_attempts: [], attempted: 0, obligations: {},
  } };
  h.metadata.catch_up_diagnostics = {
    build_identity: { extension_version: '0.9.84',
      build_fingerprint: fixture.build_fingerprint },
    errors: 4,
    error_details: Array.from({ length: 4 }, () => ({
      label: 'long-term extraction error (chunk)', tier: 'long-term',
      persistence: false, message: fixture.error_message,
    })),
  };
  const first = migrateV0984RetainedEvidenceEffectBoundaryState({
    checkpoint, metadata: h.metadata, at: 10,
  });
  assert.equal(first.provider_calls, 0);
  assert.equal(first.persistence_calls, 0);
  assert.equal(first.detail.frozen_error_count, 4);
  assert.equal(first.detail.repaired_obligation_count, 1);
  assert.equal(checkpoint.resume_progress, undefined);
  assert.equal(checkpoint.status, 'awaiting_manual_resume');
  assert.equal(checkpoint.resume_eligibility.eligible, true);
  assert.equal(h.metadata.catch_up_diagnostics.errors, 0);
  assert.equal(h.metadata.catch_up_diagnostics.error_details.every((item) =>
    item.resolved === true && item.provider_fault_attribution === false), true);
  const accounting = deriveRunErrorAccounting(h.metadata.catch_up_diagnostics);
  assert.equal(accounting.displayed_error_records.count, 0);
  assert.equal(accounting.resolved_local_lifecycle_failures.count, 4);
  assert.equal(accounting.provider_transport_failures.count, 0);
  const serialized = JSON.stringify({ checkpoint, metadata: h.metadata });
  const second = migrateV0984RetainedEvidenceEffectBoundaryState({
    checkpoint, metadata: h.metadata, at: 20,
  });
  assert.equal(second.migrated, false);
  assert.equal(JSON.stringify({ checkpoint, metadata: h.metadata }), serialized);
  const authority = deriveMemorizeRecoveryAuthority({ checkpoint, ledger,
    provider_audit: h.metadata.live_memory_health.provider_attempt_audit,
    provider_completion_journal: h.metadata.provider_completion_journal,
    controller_heartbeat: checkpoint.controller_heartbeat,
    transaction_lifecycle: checkpoint.transaction_lifecycle,
    checkpoint_status: checkpoint.status });
  assert.equal(authority.resume_eligible, true);
  assert.notEqual(authority.resume_blockers[0]?.reason_code,
    'resume_no_progress_same_action');
  const presentation = selectRecoveryPresentation({
    checkpoint,
    recovery: { authoritative_recovery: authority },
    manifest: checkpoint.run_manifest,
    resumeEligibility: authority.base_resume_eligibility,
  });
  assert.equal(presentation.visible, true);
  assert.equal(presentation.disabled, false);
  assert.equal(presentation.label, 'Resume Incomplete Run');
  assert.equal(presentation.auto_resume_eligible, true);
});
