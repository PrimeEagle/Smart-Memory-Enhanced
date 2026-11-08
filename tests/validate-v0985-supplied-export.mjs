import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { migrateV0984RetainedEvidenceEffectBoundaryState }
  from '../memorize-lifecycle-migration.js';
import { selectDiagnosticsProjection, selectRecoveryPresentation }
  from '../memorize-projections.js';
import { deriveRunErrorAccounting } from '../run-status-utils.js';

const source = process.argv[2]
  ?? 'C:/Users/John/Downloads/smart-memory-enhanced-diagnostics.json';
const report = JSON.parse(readFileSync(source, 'utf8'));
const logicalRunId = report.logical_run?.logical_run_id;
const pending = report.authoritative_obligation_ledger?.pending_obligations ?? [];
const entries = report.provider_completion_journal?.entries ?? [];
const selectedPrivateEntry = report.authoritative_recovery?.base_resume_eligibility
  ?.retained_evidence_plan?.selected_entry ?? null;
const frozenMessage = /cannot add property retained_evidence_decisions, object is not extensible/i;

assert.equal(report.build_identity?.extension_version, '0.9.84');
assert.equal(report.build_identity?.build_fingerprint,
  'sme-v0.9.84-retained-evidence-recovery-r1');
assert.equal(logicalRunId, 'c8410003-34f7-4ea4-b480-e39d96942d76');
assert.equal(report.logical_run?.source_window?.message_count, 9434);
assert.equal(report.provider_attempt_audit?.physical_attempts, 0);
assert.equal(report.errors, 4);
assert.equal((report.error_details ?? []).filter((item) =>
  frozenMessage.test(String(item?.message ?? ''))).length, 4);
assert.equal(report.authoritative_recovery?.resume_blockers?.[0]?.reason_code,
  'resume_no_progress_same_action');
assert.equal(pending.length, 7);
const redactedProjection = selectDiagnosticsProjection({ completedRun: report });
const projectedEntry = redactedProjection.authoritative_recovery?.base_resume_eligibility
  ?.retained_evidence_plan?.selected_entry;
assert.equal(Object.hasOwn(projectedEntry, 'response_text'), false);
assert.equal(Object.hasOwn(projectedEntry?.parser_result ?? {}, 'records'), false);

const obligations = Object.fromEntries(pending.map((item) => [item.obligation_id,
  structuredClone(item)]));
const adoptionBefore = Object.values(obligations).map((item) => ({
  obligation_id: item.obligation_id,
  attempt_id: item.evidence_adoptions?.at(-1)?.origin_attempt_id ?? null,
  durable_record_ids: [...(item.lifecycle?.durably_persisted_record_ids ?? [])].sort(),
}));
assert.equal(adoptionBefore.every((item) => Boolean(item.attempt_id)), true);

const ledger = {
  schema_version: report.authoritative_obligation_ledger.schema_version,
  implementation_version: report.authoritative_obligation_ledger.implementation_version,
  logical_run_id: logicalRunId,
  obligations,
  recovery_backlog: structuredClone(
    report.authoritative_obligation_ledger.recovery_backlog ?? []),
  transition_violations: [], historical_transition_observations: [],
  controller_exits: [],
};
const checkpoint = {
  status: report.catch_up_recovery?.status ?? 'blocked_reconciliation_required',
  source_message_count: report.catch_up_recovery?.source_message_count ?? 9434,
  next_source_offset: report.catch_up_recovery?.safely_committed_offset ?? 0,
  committed_chunks: report.logical_run?.cumulative_chunk_count ?? 0,
  run_manifest: { logical_run_id: logicalRunId, obligation_ledger: ledger },
  controller_heartbeat: structuredClone(report.controller_heartbeat ?? { terminal: true }),
  transaction_lifecycle: structuredClone(report.catch_up_recovery?.transaction_lifecycle ?? null),
  resume_progress: structuredClone(
    report.authoritative_recovery?.resume_blockers?.[0]?.evidence ?? null),
};
const metadata = {
  provider_completion_journal: {
    schema_version: report.provider_completion_journal?.schema_version,
    entries: Object.fromEntries(entries.map((entry) => [entry.attempt_id,
      structuredClone(entry.attempt_id === selectedPrivateEntry?.attempt_id
        ? selectedPrivateEntry : entry)])),
    order: entries.map((entry) => entry.attempt_id),
  },
  live_memory_health: { provider_attempt_audit: {
    attempted: report.provider_attempt_audit?.physical_attempts ?? 0,
    recent_attempts: [], obligations: {},
  } },
  catch_up_diagnostics: {
    build_identity: structuredClone(report.build_identity),
    errors: report.errors,
    error_details: structuredClone(report.error_details ?? []),
    local_lifecycle_failures: structuredClone(report.local_lifecycle_failures ?? []),
  },
};

const first = migrateV0984RetainedEvidenceEffectBoundaryState({
  checkpoint, metadata, at: 1794152000000,
});
assert.equal(first.provider_calls, 0);
assert.equal(first.persistence_calls, 0);
assert.equal(first.detail.affected_v0984_state_detected, true);
assert.equal(first.detail.frozen_error_count, 4);
assert.equal(first.detail.repaired_obligation_count, 1);
assert.equal(first.detail.rejected_adoption_count, 6);
assert.equal(first.detail.stale_no_progress_block_cleared, true);
assert.equal(checkpoint.resume_progress, undefined);
assert.equal(checkpoint.status, 'awaiting_manual_resume');
assert.equal(checkpoint.resume_eligibility.eligible, true);
assert.equal(checkpoint.resume_eligibility.next_eligible_action,
  'dispatch_provider_request');
assert.equal(checkpoint.resume_eligibility.provider_call_required, true);

const adoptionAfter = Object.values(ledger.obligations).map((item) => ({
  obligation_id: item.obligation_id,
  attempt_id: item.evidence_adoptions?.at(-1)?.origin_attempt_id ?? null,
  durable_record_ids: [...(item.lifecycle?.durably_persisted_record_ids ?? [])].sort(),
}));
const rejectedIds = new Set(first.detail.rejected_adoptions
  .map((item) => item.obligation_id));
assert.equal(rejectedIds.size, 6);
assert.equal(rejectedIds.has('longterm:alex mercer:0-19:fnv1a-39c6c9f'), true);
assert.deepEqual(adoptionAfter.filter((item) => !rejectedIds.has(item.obligation_id)),
  adoptionBefore.filter((item) => !rejectedIds.has(item.obligation_id)));
assert.equal(adoptionAfter.find((item) => rejectedIds.has(item.obligation_id))
  ?.attempt_id, null);
assert.equal(adoptionAfter.filter((item) => item.attempt_id).length, 1);

const accounting = deriveRunErrorAccounting(metadata.catch_up_diagnostics);
assert.equal(metadata.catch_up_diagnostics.errors, 0);
assert.equal(accounting.displayed_error_records.count, 0);
assert.equal(accounting.resolved_local_lifecycle_failures.count, 4);
assert.equal(accounting.provider_transport_failures.count, 0);
const presentation = selectRecoveryPresentation({
  checkpoint,
  recovery: { authoritative_recovery: checkpoint.authoritative_recovery },
  manifest: checkpoint.run_manifest,
  resumeEligibility: checkpoint.authoritative_recovery.base_resume_eligibility,
});
assert.equal(presentation.visible, true);
assert.equal(presentation.disabled, false);
assert.equal(presentation.label, 'Resume Incomplete Run');
assert.equal(presentation.auto_resume_eligible, true);

const serialized = JSON.stringify({ checkpoint, metadata });
const second = migrateV0984RetainedEvidenceEffectBoundaryState({
  checkpoint, metadata, at: 1794152001000,
});
assert.equal(second.migrated, false);
assert.equal(JSON.stringify({ checkpoint, metadata }), serialized);

console.log(JSON.stringify({
  logical_run_id: logicalRunId,
  source_message_count: checkpoint.source_message_count,
  frozen_local_errors_resolved: first.detail.frozen_error_count,
  repaired_obligations: first.detail.repaired_obligation_count,
  rejected_adoptions: first.detail.rejected_adoption_count,
  retained_adoptions_preserved: adoptionAfter.filter((item) => item.attempt_id).length,
  resume_eligible: checkpoint.resume_eligibility.eligible,
  next_action: checkpoint.resume_eligibility.next_eligible_action,
  provider_call_required_on_resume: checkpoint.resume_eligibility.provider_call_required,
  migration_provider_calls: first.provider_calls,
  migration_persistence_calls: first.persistence_calls,
  active_errors_after_migration: accounting.displayed_error_records.count,
  provider_transport_failures: accounting.provider_transport_failures.count,
  resume_button_enabled: presentation.disabled === false,
  second_pass_mutations: second.migrated ? 1 : 0,
}, null, 2));
