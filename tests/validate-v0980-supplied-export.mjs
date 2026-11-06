import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { deriveMemorizeResumeEligibility } from '../memorize-authority-model.js';
import { migrateV0980SameRunEvidenceState } from '../memorize-lifecycle-migration.js';
import {
  createMemorizeObligationLedger,
  normalizeMemorizeLifecycleIdentity,
  projectMemorizeObligationLedger,
  reconcileMemorizeLifecycleFromJournal,
} from '../memorize-obligation-ledger.js';

const path = process.argv[2];
if (!path) throw new Error('Pass the supplied diagnostics JSON path.');
const report = JSON.parse(readFileSync(path, 'utf8'));
const exported = report.authoritative_obligation_ledger;
const logicalRunId = report.logical_run?.logical_run_id;
const entries = report.provider_completion_journal?.entries ?? [];
const ledger = createMemorizeObligationLedger(logicalRunId, 1);
for (const obligation of exported.pending_obligations ?? []) {
  ledger.obligations[obligation.obligation_id] = structuredClone(obligation);
}
const safeEntries = entries.filter((entry) => ['committed', 'verified_existing']
  .includes(entry.persistence?.status));
for (const entry of safeEntries) {
  const id = entry.child_obligation_id ?? entry.root_obligation_id;
  if (ledger.obligations[id]) continue;
  const durable = entry.persistence?.durable_record_ids ?? [];
  const mapping = Object.fromEntries((entry.validated_record_identities ?? [])
    .filter((item) => item?.id && item?.candidate_id)
    .map((item) => [item.id, item.candidate_id]));
  ledger.obligations[id] = {
    obligation_id: id, logical_run_id: logicalRunId, tier: entry.tier,
    owner: entry.owner ?? null, source_range: entry.source_range,
    source_fingerprint: entry.source_fingerprint,
    parent_obligation_id: id === entry.root_obligation_id ? null : entry.root_obligation_id,
    expected_child_obligation_ids: [], provider_attempt_lineage: [entry.attempt_id],
    parser_result: entry.parser_status ?? 'accepted',
    downstream_validation_result: entry.validation?.status ?? 'accepted',
    persistence_result: entry.persistence.status, coverage_result: 'safely_committed',
    current_state: 'durably_committed', checkpoint_eligible: true,
    exact_reason_code: null, next_eligible_action: null,
    timestamps: { created_at: entry.started_at, updated_at: entry.updated_at },
    transition_history: [], semantic_event_ids: [], semantic_event_history: [],
    metrics: { persisted_records: durable.length },
    lifecycle: normalizeMemorizeLifecycleIdentity({ lifecycle: {
      parser_accepted_candidate_ids: Object.values(mapping),
      downstream_accepted_candidate_ids: Object.values(mapping),
      durably_persisted_record_ids: durable, durable_record_candidate_map: mapping,
    } }),
  };
}
ledger.transition_violations = structuredClone(exported.invariants?.violations ?? []);
const journal = { schema_version: report.provider_completion_journal?.schema_version ?? 3,
  order: entries.map((entry) => entry.attempt_id),
  entries: Object.fromEntries(entries.map((entry) => [entry.attempt_id,
    structuredClone(entry)])) };

const first = migrateV0980SameRunEvidenceState({ ledger, journal,
  logical_run_id: logicalRunId,
  provider_attempts: report.provider_attempt_audit?.retained_attempts ?? [] });
const partial = ledger.obligations[
  'session:chat:0-19:fnv1a-39c6c9f:leaf:10-19:fnv1a-c07b56b6'];
assert.equal(partial.current_state, 'pending_recovery');
assert.equal(partial.lifecycle.durably_persisted_record_ids.length, 3);
assert.equal(partial.lifecycle.unresolved_fragment_ids.length, 2);
assert.equal(first.provider_calls, 0);
assert.equal(first.persistence_calls, 0);
const projection = projectMemorizeObligationLedger(ledger);
const resume = deriveMemorizeResumeEligibility({ ledger, projection,
  provider_audit: report.provider_attempt_audit,
  provider_completion_journal: journal });
assert.equal(resume.eligible, true);
assert.equal(resume.next_eligible_action, 'recover_exact_unresolved_fragments');
assert.equal(resume.provider_call_required, true);
const reconciliationInput = { logical_run_id: logicalRunId, journal,
  provider_attempts: report.provider_attempt_audit?.retained_attempts ?? [], at: 1 };
reconcileMemorizeLifecycleFromJournal(ledger, reconciliationInput);
const secondReconciliation = reconcileMemorizeLifecycleFromJournal(
  ledger, reconciliationInput);
assert.equal(secondReconciliation.mutations, 0);
const secondMigration = migrateV0980SameRunEvidenceState({ ledger, journal,
  logical_run_id: logicalRunId,
  provider_attempts: report.provider_attempt_audit?.retained_attempts ?? [] });
assert.equal(secondMigration.migrated, false);
console.log(JSON.stringify({
  logical_run_id: logicalRunId,
  migrated_leaf_count: first.detail.repaired_leaf_count,
  durable_session_record_count: 5,
  partial_leaf_durable_record_count: partial.lifecycle.durably_persisted_record_ids.length,
  unresolved_fragment_count: partial.lifecycle.unresolved_fragment_ids.length,
  resume_action: resume.next_eligible_action,
  provider_call_required_on_resume: resume.provider_call_required,
  repair_provider_calls: first.provider_calls,
  repair_persistence_calls: first.persistence_calls,
  second_reconciliation_mutations: secondReconciliation.mutations,
  second_migration_mutated: secondMigration.migrated,
}, null, 2));
