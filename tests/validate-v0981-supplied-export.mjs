import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) throw new Error('Usage: node tests/validate-v0981-supplied-export.mjs <diagnostics.json>');
const report = JSON.parse(readFileSync(path, 'utf8'));
const ledger = report.authoritative_obligation_ledger;
const pending = ledger?.pending_obligations ?? [];
const entries = Array.isArray(report.provider_completion_journal?.entries)
  ? report.provider_completion_journal.entries
  : Object.values(report.provider_completion_journal?.entries ?? {});
const rootId = 'session:chat:0-19:fnv1a-39c6c9f';
const terminalId = `${rootId}:leaf:0-9:fnv1a-9f08f7d4`;
const pendingId = `${rootId}:leaf:10-19:fnv1a-c07b56b6`;
const prior = entries.find((entry) => entry.attempt_id === 'provider-mw4czixy-4');
const pendingLeaf = pending.find((item) => item.obligation_id === pendingId);

assert.equal(report.build_identity?.build_fingerprint,
  'sme-v0.9.81-monotonic-downstream-cursor-r1');
assert.equal(report.logical_run?.logical_run_id,
  '2d0f04bf-05c0-4fdb-b05d-4e3b07d3abe4');
assert.equal(ledger?.obligation_count, 11);
assert.equal(ledger?.safely_committed_obligation_count, 9);
assert.equal(ledger?.pending_obligation_count, 2);
assert.equal(ledger?.actionable_pending_obligation_count, 0);
assert.equal(report.catch_up_recovery?.resumable, false);
assert.equal(report.catch_up_recovery?.blocked, true);
assert.equal(pendingLeaf?.current_state, 'unattempted');
assert.equal(pendingLeaf?.exact_reason_code, null);
assert.equal(pendingLeaf?.next_eligible_action, 'dispatch_provider_request');
assert.equal(pendingLeaf?.provider_call_required, false);
assert.equal(pendingLeaf?.actionability_reason, 'missing_exact_reason');
assert.equal(prior?.child_obligation_id, terminalId);
assert.equal(prior?.terminal_outcome, 'completed');
assert.equal(prior?.ledger_transition?.resulting_state, 'durably_committed');
assert.equal(prior?.ledger_transition?.checkpoint_eligible, true);
assert.deepEqual(prior?.persistence?.durable_record_ids, [
  '0f0d5377-ee3b-45f6-adfc-b24221f0853f',
  '0e415969-1765-4632-8de0-7c7ac5e7d68c',
]);
assert.equal(prior?.logical_disposition, 'accepted_records_persisted');
assert.equal(prior?.downstream_cursor, 'accepted_records_persisted');
assert.equal((report.provider_completion_reconciliation?.running_attempt_ids ?? []).length, 0);
assert.equal(ledger?.running_obligation_count, 0);

console.log(JSON.stringify({
  validated: true,
  build_fingerprint: report.build_identity.build_fingerprint,
  logical_run_id: report.logical_run.logical_run_id,
  supplied_failure_shape: {
    obligations: ledger.obligation_count,
    safely_committed: ledger.safely_committed_obligation_count,
    pending: ledger.pending_obligation_count,
    actionable: ledger.actionable_pending_obligation_count,
    pending_leaf: pendingId,
    prior_terminal_leaf: terminalId,
    durable_record_ids: prior.persistence.durable_record_ids,
  },
}, null, 2));
