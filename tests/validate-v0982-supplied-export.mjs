import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('Usage: node tests/validate-v0982-supplied-export.mjs <diagnostics.json>');
const diagnostics = JSON.parse(readFileSync(file, 'utf8'));
const recovery = diagnostics.catch_up_recovery;
const ledger = recovery.authoritative_obligation_ledger;
const pending = recovery.exact_pending_obligation;
const attempts = diagnostics.provider_completion_journal?.entries ?? [];
assert.equal(diagnostics.build_identity?.extension_version, '0.9.82');
assert.equal(recovery.logical_run?.logical_run_id, '637d0780-b9bc-4959-8ed5-72d946cb70ca');
assert.equal(recovery.transaction_lifecycle?.state, 'rolled_back');
assert.equal(recovery.status, 'in_progress');
assert.equal(diagnostics.controller_heartbeat?.terminal, true);
assert.equal(pending?.obligation_id, 'longterm:lillian kraft:0-19:fnv1a-39c6c9f');
assert.equal(pending?.current_state, 'pending_recovery');
assert.ok(pending?.provider_attempt_lineage?.includes('provider-mw50jt2w-2'));
const orphan = attempts.find((item) => item.attempt_id === 'provider-mw50jt2w-2');
assert.equal(orphan?.terminal_outcome, 'running');
const longtermCoverage = recovery.logical_run?.cumulative_tier_coverage?.longterm;
assert.equal(longtermCoverage?.authoritative_obligation_count, 3);
assert.equal(longtermCoverage?.authoritative_safely_committed_obligation_count, 2);
assert.equal(diagnostics.malformed_recovery?.unresolved_obligations?.[0]
  ?.recovery_eligibility?.eligible_action, 'malformed_source_repartition');
console.log(JSON.stringify({ validated: true,
  build: diagnostics.build_identity,
  logical_run_id: recovery.logical_run.logical_run_id,
  contradiction: { transaction_state: recovery.transaction_lifecycle.state,
    checkpoint_status: recovery.status,
    controller_terminal: diagnostics.controller_heartbeat.terminal,
    orphan_attempt_id: orphan.attempt_id,
    orphan_attempt_state: orphan.terminal_outcome },
  pending_obligation_id: pending.obligation_id,
  exact_recovery_stage: diagnostics.malformed_recovery.unresolved_obligations[0]
    .recovery_eligibility.eligible_action,
  preserved_sibling_count: longtermCoverage.authoritative_safely_committed_obligation_count,
}, null, 2));
