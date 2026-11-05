import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) throw new Error('Usage: node tests/replay-v0977-diagnostics.mjs <diagnostics.json>');
const diagnostics = JSON.parse(readFileSync(path, 'utf8'));
const ledger = diagnostics.authoritative_obligation_ledger
  ?? diagnostics.catch_up_recovery?.authoritative_obligation_ledger;
assert.equal(diagnostics.build_identity?.extension_version, '0.9.77');
assert.equal(diagnostics.logical_run?.logical_run_id,
  '3e269b2e-e2a0-461f-96f5-cb9ee39a1a43');
assert.equal(diagnostics.catch_up_recovery?.source_message_count, 9434);
assert.equal(ledger?.obligation_count, 24);
assert.equal(ledger?.safely_committed_obligation_count, 24);
assert.equal(ledger?.pending_obligation_count, 0);
assert.equal(ledger?.tier_coverage?.session?.safely_committed_obligation_count, 3);
assert.equal(ledger?.tier_coverage?.longterm?.safely_committed_obligation_count, 21);
assert.equal(diagnostics.catch_up_recovery?.safely_committed_offset, 60);
assert.equal(diagnostics.logical_run?.cumulative_committed_count, 40);
assert.equal(diagnostics.provider_attempt_audit?.failure_accounting
  ?.recovery_in_progress_obligation_count, 1);
assert.equal(diagnostics.provider_attempt_audit?.failure_accounting
  ?.terminal_unresolved_obligation_count, 0);
assert.equal(diagnostics.catch_up_recovery?.next_eligible_recovery_action, null);

console.log(JSON.stringify({
  artifact_reproduced: true,
  canonical_committed_range: [0, 59],
  stale_compatibility_committed_range: [0, 39],
  canonical_safe_offset: 60,
  expected_next_source_range: [60, 79],
  expected_provider_calls_for_0_59: 0,
  expected_persistence_calls_for_0_59: 0,
}, null, 2));
