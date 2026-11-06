import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { migrateV0983RetainedEvidenceRecoveryState }
  from '../memorize-lifecycle-migration.js';
import { planRetainedProviderEvidence, PROVIDER_EVIDENCE_PROVENANCE }
  from '../retained-evidence-plan.js';

const source = process.argv[2]
  ?? 'C:/Users/John/Downloads/smart-memory-enhanced-diagnostics.json';
const report = JSON.parse(readFileSync(source, 'utf8'));
const logicalRunId = report.logical_run?.logical_run_id;
const pending = report.authoritative_obligation_ledger?.pending_obligations ?? [];
const entries = report.provider_completion_journal?.entries ?? [];
assert.equal(logicalRunId, '762154f5-12e7-4e2a-87f4-6286c07a601d');

function planFor(start, end) {
  const obligation = pending.find((item) => item.tier === 'session'
    && item.source_fingerprint && Number(item.source_range?.start) === start
    && Number(item.source_range?.end) === end);
  assert.ok(obligation, `missing canonical Session ${start}-${end}`);
  return { obligation, plan: planRetainedProviderEvidence({
    current_logical_run_id: logicalRunId,
    root_obligation_id: obligation.parent_obligation_id ?? obligation.obligation_id,
    child_obligation_id: obligation.obligation_id,
    tier: obligation.tier, owner: obligation.owner,
    source_range: obligation.source_range,
    source_fingerprint: obligation.source_fingerprint,
    obligation, candidates: entries,
  }) };
}

const range40 = planFor(40, 59);
const range80 = planFor(80, 99);
const range120 = planFor(120, 139);
for (const result of [range40, range80]) {
  assert.equal(result.plan.evidence_classification,
    PROVIDER_EVIDENCE_PROVENANCE.CURRENT_RUN_RECOVER_FRAGMENTS);
  assert.equal(result.plan.exact_next_action,
    'recover_unresolved_partial_output_fragments');
  assert.equal(result.plan.provider_call_required, true);
}
assert.equal(range40.plan.evidence_origin_attempt_id, 'provider-mw2ls0mr-8');
assert.equal(range80.plan.evidence_origin_attempt_id, 'provider-mw0ukct9-61');
assert.equal(range120.plan.evidence_origin_attempt_id, 'provider-mw0v4ljk-80');
assert.equal(range120.plan.evidence_classification,
  PROVIDER_EVIDENCE_PROVENANCE.PRIOR_RUN_ADOPTABLE);
assert.equal(range120.plan.candidate_decisions.find((item) =>
  item.attempt_id === 'provider-mw0v6mzn-83')?.disposition,
'rejected_unusable_evidence');

const obligations = Object.fromEntries(pending.map((item) => [item.obligation_id,
  structuredClone(item)]));
const durableBefore = [...new Set(Object.values(obligations).flatMap((item) =>
  item.lifecycle?.durably_persisted_record_ids ?? []))].sort();
const ledger = {
  schema_version: report.authoritative_obligation_ledger.schema_version,
  implementation_version: report.authoritative_obligation_ledger.implementation_version,
  logical_run_id: logicalRunId,
  obligations,
  recovery_backlog: structuredClone(report.authoritative_obligation_ledger.recovery_backlog ?? []),
  transition_violations: [], historical_transition_observations: [], controller_exits: [],
};
const checkpoint = {
  status: 'awaiting_manual_resume', next_source_offset: 80,
  source_message_count: report.logical_run?.source_window?.message_count ?? 9434,
  run_manifest: { logical_run_id: logicalRunId, obligation_ledger: ledger },
  controller_heartbeat: { terminal: true }, transaction_lifecycle: null,
};
const metadata = {
  provider_completion_journal: { entries: structuredClone(entries),
    order: entries.map((entry) => entry.attempt_id) },
  live_memory_health: { provider_attempt_audit: {
    recent_attempts: [], attempted: report.provider_attempt_audit?.attempted ?? 0,
    obligations: {},
  } },
};
const first = migrateV0983RetainedEvidenceRecoveryState({ checkpoint, metadata, at: 1 });
assert.equal(first.provider_calls, 0);
assert.equal(first.persistence_calls, 0);
assert.equal(first.detail.removed_legacy_obligation_count, 3);
assert.equal(Object.keys(ledger.obligations).filter((id) => id.endsWith(':legacy')).length, 0);
assert.deepEqual([...new Set(Object.values(ledger.obligations).flatMap((item) =>
  item.lifecycle?.durably_persisted_record_ids ?? []))].sort(), durableBefore);
assert.equal(checkpoint.resume_eligibility.eligible, true);
assert.equal(checkpoint.resume_eligibility.next_eligible_action,
  'recover_unresolved_partial_output_fragments');
const serialized = JSON.stringify({ checkpoint, metadata });
const second = migrateV0983RetainedEvidenceRecoveryState({ checkpoint, metadata, at: 2 });
assert.equal(second.migrated, false);
assert.equal(JSON.stringify({ checkpoint, metadata }), serialized);

console.log(JSON.stringify({
  logical_run_id: logicalRunId,
  committed_session_messages_preserved: report.logical_run?.cumulative_committed_by_tier?.session
    ?? report.logical_run?.cumulative_tier_committed_counts?.session ?? 80,
  durable_record_ids_preserved: durableBefore.length,
  removed_legacy_obligations: first.detail.removed_legacy_obligation_count,
  first_resume_obligation: checkpoint.resume_eligibility.obligation_id,
  first_resume_action: checkpoint.resume_eligibility.next_eligible_action,
  provider_call_required_on_resume: checkpoint.resume_eligibility.provider_call_required,
  range_120_selected_attempt: range120.plan.evidence_origin_attempt_id,
  migration_provider_calls: first.provider_calls,
  migration_persistence_calls: first.persistence_calls,
  second_pass_mutations: second.migrated ? 1 : 0,
}, null, 2));
