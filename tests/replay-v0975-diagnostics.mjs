import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  applyMemorizeLifecycleEvent,
  createMemorizeObligationLedger,
  projectMemorizeObligationLedger,
  reconcileMemorizeLifecycleFromJournal,
} from '../memorize-obligation-ledger.js';

const path = process.argv[2];
if (!path) throw new Error('Pass the exported diagnostics JSON path.');
const artifact = JSON.parse(readFileSync(path, 'utf8'));
const rootId = 'session:chat:40-59:fnv1a-e3dd3b39';
const attemptIds = new Set(['provider-mw14c2fd-17', 'provider-mw14ca2w-18']);
const objects = [];
const visit = (value) => {
  if (!value || typeof value !== 'object') return;
  objects.push(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
};
visit(artifact);
let ledger = objects.find((value) => value.obligations?.[rootId]);
const journalEntries = objects.filter(Array.isArray)
  .find((items) => attemptIds.size && [...attemptIds].every((id) =>
    items.some((item) => item?.attempt_id === id && item.persistence)));
const coverageRecords = [...new Map(objects.filter((value) => value.range_id && value.tier === 'session')
  .map((value) => [`${value.range_id}:${value.source_fingerprint ?? ''}`, value])).values()];
assert.ok(journalEntries, 'provider completion journal entries not found');
assert.ok(coverageRecords.length >= 5, 'Session extraction coverage tree not found');
if (!ledger) {
  // The v0.9.75 export includes the authoritative pending objects and terminal
  // journal/coverage projections, but intentionally omits the private ledger
  // map. Reconstruct only those durable identities; never infer source text.
  ledger = createMemorizeObligationLedger('b3d00e2a-6927-4adc-98c5-7160f45e616b', 1);
  const exportedObligations = [...new Map(objects.filter((value) =>
    value.obligation_id && value.current_state && value.source_range)
    .map((value) => [value.obligation_id, value])).values()];
  for (const obligation of exportedObligations) ledger.obligations[obligation.obligation_id]
    = structuredClone(obligation);
  for (const entry of journalEntries.filter((item) => item?.child_obligation_id
    && ['committed', 'verified_existing', 'not_needed'].includes(item.persistence?.status)
    && item.manifest_transition?.status === 'applied'
    && coverageRecords.some((record) => record.source_fingerprint === item.source_fingerprint
      && !coverageRecords.some((child) => child.parent_range_id === record.range_id)))) {
    if (ledger.obligations[entry.child_obligation_id]?.checkpoint_eligible) continue;
    applyMemorizeLifecycleEvent(ledger, {
      obligation_id: entry.child_obligation_id,
      logical_run_id: entry.logical_run_id, tier: entry.tier, owner: entry.owner,
      source_range: entry.source_range, source_fingerprint: entry.source_fingerprint,
    }, { type: 'leaf_coverage_completed', verified_coverage: true,
      persistence_result: entry.persistence.status,
      durable_record_ids: entry.persistence.durable_record_ids,
      lifecycle: { migrated_from_ambiguous_counts: true },
      event_id: `export-reconstruction:${entry.attempt_id}` });
  }
}
const repaired = reconcileMemorizeLifecycleFromJournal(structuredClone(ledger), {
  logical_run_id: 'b3d00e2a-6927-4adc-98c5-7160f45e616b',
  journal: journalEntries,
  coverage_records: coverageRecords,
  checkpoint_before: 40,
  source_message_count: 9434,
  chunk_size: 20,
});
const second = reconcileMemorizeLifecycleFromJournal(repaired.ledger, {
  journal: journalEntries, coverage_records: coverageRecords,
  checkpoint_before: repaired.safe_resume_offset, source_message_count: 9434, chunk_size: 20,
});
const projection = projectMemorizeObligationLedger(repaired.ledger);
const intermediateId = `${rootId}:leaf:50-59:fnv1a-fc90a762`;
const result = {
  first_pass_mutations: repaired.mutations,
  second_pass_mutations: second.mutations,
  provider_calls: repaired.provider_calls,
  persistence_calls: repaired.persistence_calls,
  reused_attempt_ids: repaired.reused_attempt_ids.filter((id) => attemptIds.has(id)),
  preserved_durable_record_ids: repaired.preserved_durable_record_ids,
  intermediate_state: repaired.ledger.obligations[intermediateId]?.current_state,
  root_state: repaired.ledger.obligations[rootId]?.current_state,
  root_expected_child_ids: repaired.ledger.obligations[rootId]?.expected_child_obligation_ids,
  intermediate_expected_child_ids: repaired.ledger.obligations[intermediateId]?.expected_child_obligation_ids,
  safe_resume_offset: repaired.safe_resume_offset,
  next_source_range: repaired.next_source_range,
  pending_obligations: projection.pending_obligation_count,
  current_runtime_illegal_transitions: repaired.ledger.transition_violations.filter((item) =>
    item.classification === 'current_runtime').length,
};
assert.equal(result.intermediate_state, 'durably_committed');
assert.equal(result.root_state, 'durably_committed');
assert.equal(result.safe_resume_offset, 60);
assert.deepEqual(result.next_source_range, { start: 60, end: 79 });
assert.equal(result.second_pass_mutations, 0);
assert.equal(result.provider_calls, 0);
assert.equal(result.persistence_calls, 0);
console.log(JSON.stringify(result, null, 2));
