import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createTransactionLease, inspectTransactionLease }
  from '../catchup-transaction-lease.js';
import { finalizeMemorizeController } from '../memorize-controller-finalizer.js';
import { migrateV0982ControllerLeaseRecoveryState }
  from '../memorize-lifecycle-migration.js';
import { createMemorizeObligationLedger, transitionMemorizeObligation }
  from '../memorize-obligation-ledger.js';
import { selectRecoveryPresentation } from '../memorize-projections.js';
import { deriveMemorizeRecoveryAuthority } from '../memorize-recovery-authority.js';
import { beginProviderAttempt, summarizeProviderAttemptAudit }
  from '../provider-attempt-audit.js';

const fixture = JSON.parse(readFileSync(new URL(
  './fixtures/v0982-controller-lease-failure.json', import.meta.url), 'utf8'));

function transaction(state = 'active', revision = 1) {
  return { transaction_id: fixture.transaction_id, state, revision, generation: 2,
    owner: { logical_run_id: fixture.logical_run_id,
      controller_instance_id: fixture.controller_instance_id } };
}

function affectedState() {
  const metadata = {};
  const orphan = beginProviderAttempt(metadata, {
    run_id: fixture.logical_run_id, logical_obligation_id: fixture.obligation_id,
    child_obligation_id: fixture.obligation_id, tier: 'longterm', owner: 'Lillian Kraft',
    source_range: { start: 0, end: 19, message_count: 20 },
    source_fingerprint: fixture.source_fingerprint,
    root_source_range: { start: 0, end: 19, message_count: 20 },
    root_source_fingerprint: fixture.source_fingerprint,
    request_kind: 'changed_dimension_regeneration',
    recovery_stage: 'changed_dimension_regeneration',
    changed_recovery_dimensions: ['changed_dimension_regeneration'],
    controller_instance_id: fixture.controller_instance_id,
    transaction_id: fixture.transaction_id, transaction_revision: 1,
  });
  orphan.attempt_id = fixture.orphan_attempt_id;
  const audit = metadata.live_memory_health.provider_attempt_audit;
  const window = audit.obligations[fixture.obligation_id]
    .recovery_windows[fixture.source_fingerprint];
  window.recovery_stages_attempted = ['strict_generation', 'changed_dimension_regeneration'];
  window.exhausted_stages = ['strict_generation', 'changed_dimension_regeneration'];
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id, 1);
  for (const id of fixture.preserved_obligations) transitionMemorizeObligation(ledger, {
    obligation_id: id, logical_run_id: fixture.logical_run_id, tier: 'longterm',
    owner: id.includes('alex') ? 'Alex Mercer' : 'Aster Graves',
    source_range: { start: 0, end: 19 }, source_fingerprint: fixture.source_fingerprint,
  }, { current_state: 'durably_committed', persistence_result: 'committed', at: 1 });
  transitionMemorizeObligation(ledger, {
    obligation_id: fixture.obligation_id, logical_run_id: fixture.logical_run_id,
    tier: 'longterm', owner: 'Lillian Kraft', source_range: { start: 0, end: 19 },
    source_fingerprint: fixture.source_fingerprint,
  }, { current_state: 'provider_running', provider_attempt_id: fixture.orphan_attempt_id,
    exact_reason_code: 'malformed_tag', next_eligible_action: 'dispatch_bounded_recovery_attempt',
    recovery_stage: 'strict_generation', at: 2 });
  const checkpoint = {
    status: 'in_progress', run_manifest: { logical_run_id: fixture.logical_run_id,
      obligation_ledger: ledger },
    transaction_lifecycle: { ...transaction('rolled_back'), terminal_disposition: 'controller_exit' },
    controller_heartbeat: { terminal: true,
      controller_invocation_id: fixture.controller_instance_id },
  };
  return { metadata, audit, ledger, checkpoint, orphan };
}

test('current immutable lease authorizes its exact transaction only', () => {
  const tx = transaction();
  const lease = createTransactionLease(tx, { callback_type: 'child_manifest' });
  assert.equal(inspectTransactionLease(tx, tx, lease).allowed, true);
  assert.equal(Object.isFrozen(lease), true);
});

test('rollback rejects a late child-manifest callback without durable mutation', () => {
  const tx = transaction();
  const lease = createTransactionLease(tx, { callback_type: 'child_manifest' });
  tx.state = 'rolled_back';
  const result = inspectTransactionLease(tx, null, lease);
  assert.equal(result.allowed, false);
  assert.equal(result.disposition, 'stale_lease_mutation_rejected');
  assert.equal(result.durable_mutation_performed, false);
});

test('a later transaction rejects an old provider-journal lease', () => {
  const old = transaction();
  const lease = createTransactionLease(old, { callback_type: 'provider_journal' });
  const current = { ...transaction(), transaction_id: 'new-transaction', generation: 3 };
  assert.equal(inspectTransactionLease(old, current, lease).reason_code,
    'transaction_lease_not_current');
});

test('authority detects the closed-controller running-attempt contradiction', () => {
  const { metadata, ledger, checkpoint } = affectedState();
  const result = deriveMemorizeRecoveryAuthority({ ledger,
    provider_audit: metadata.live_memory_health.provider_attempt_audit,
    provider_completion_journal: metadata.provider_completion_journal,
    controller_heartbeat: checkpoint.controller_heartbeat,
    transaction_lifecycle: checkpoint.transaction_lifecycle,
    checkpoint_status: checkpoint.status });
  assert.equal(result.resume_eligible, false);
  assert.deepEqual(result.orphaned_provider_attempt_ids, [fixture.orphan_attempt_id]);
  assert.equal(result.state, 'recoverable_after_automatic_repair');
});

test('v0.9.82 repair settles orphan, preserves siblings, and exposes exact Resume', () => {
  const { metadata, ledger, checkpoint, orphan } = affectedState();
  const first = migrateV0982ControllerLeaseRecoveryState({ checkpoint, metadata, at: 10 });
  assert.equal(first.provider_calls, 0);
  assert.equal(first.persistence_calls, 0);
  assert.equal(orphan.terminal_outcome, 'interrupted_completion_unknown');
  assert.equal(orphan.lifecycle_state, 'interrupted_completion_unknown');
  assert.equal(checkpoint.status, 'awaiting_manual_resume');
  assert.equal(checkpoint.resume_eligibility.eligible, true);
  assert.equal(checkpoint.resume_eligibility.next_eligible_action,
    fixture.expected_recovery_stage);
  assert.equal(ledger.obligations[fixture.obligation_id].current_state, 'pending_recovery');
  for (const id of fixture.preserved_obligations) {
    assert.equal(ledger.obligations[id].checkpoint_eligible, true);
  }
  const serialized = JSON.stringify({ checkpoint, metadata });
  const second = migrateV0982ControllerLeaseRecoveryState({ checkpoint, metadata, at: 20 });
  assert.equal(second.migrated, false);
  assert.equal(JSON.stringify({ checkpoint, metadata }), serialized);
});

test('UI and controller consume the identical repaired authority decision', () => {
  const { metadata, ledger, checkpoint } = affectedState();
  migrateV0982ControllerLeaseRecoveryState({ checkpoint, metadata, at: 10 });
  const authority = deriveMemorizeRecoveryAuthority({ ledger,
    provider_audit: metadata.live_memory_health.provider_attempt_audit,
    provider_completion_journal: metadata.provider_completion_journal,
    controller_heartbeat: checkpoint.controller_heartbeat,
    transaction_lifecycle: checkpoint.transaction_lifecycle,
    checkpoint_status: checkpoint.status });
  assert.equal(authority.resume_eligible, checkpoint.resume_eligibility.eligible);
  assert.equal(authority.next_executable_action,
    checkpoint.resume_eligibility.next_eligible_action);
  assert.equal(authority.invariants.closed_controller_owns_no_running_attempt, true);
  assert.equal(authority.invariants.rolled_back_transaction_has_no_in_progress_checkpoint, true);
  const presentation = selectRecoveryPresentation({
    checkpoint, recovery: { authoritative_recovery: authority },
    resumeEligibility: checkpoint.resume_eligibility,
  });
  assert.equal(presentation.disabled, false);
  assert.match(presentation.status_text, /Safe Resume is authorized/);
});

test('provider journal and state history retain exact controller transaction ownership', () => {
  const metadata = {};
  const attempt = beginProviderAttempt(metadata, {
    run_id: fixture.logical_run_id, logical_obligation_id: fixture.obligation_id,
    tier: 'longterm', owner: 'Lillian Kraft', source_fingerprint: fixture.source_fingerprint,
    source_range: { start: 0, end: 19, message_count: 20 },
    controller_instance_id: fixture.controller_instance_id,
    transaction_id: fixture.transaction_id, transaction_revision: 7,
    transaction_generation: 3,
  });
  const journal = metadata.provider_completion_journal.entries[attempt.attempt_id];
  assert.equal(journal.controller_instance_id, fixture.controller_instance_id);
  assert.equal(journal.transaction_id, fixture.transaction_id);
  assert.equal(journal.transaction_revision, 7);
  assert.equal(journal.transaction_generation, 3);
  assert.deepEqual(attempt.state_history.map((item) => item.state),
    ['created', 'dispatched', 'awaiting_response']);
});

test('schema-12 attempts receive an honest reconstructed lifecycle without provider calls', () => {
  const metadata = { live_memory_health: { provider_attempt_audit: {
    schema_version: 12, run_id: fixture.logical_run_id, sequence: 1,
    attempted: 1, running_count: 1, terminal_counts: {}, obligations: {},
    recent_attempts: [{ attempt_id: fixture.orphan_attempt_id,
      logical_run_id: fixture.logical_run_id, terminal_outcome: 'running', at: 5 }],
  } } };
  const summary = summarizeProviderAttemptAudit(metadata);
  assert.equal(summary.schema_version, 13);
  assert.equal(summary.retained_attempts[0].lifecycle_state, 'awaiting_response');
  assert.equal(summary.retained_attempts[0].state_history[0].reason_code,
    'legacy_terminal_state_reconstructed');
});

test('failure-safe finalizer cannot replace the primary error with diagnostic failure', async () => {
  const { metadata, checkpoint } = affectedState();
  migrateV0982ControllerLeaseRecoveryState({ checkpoint, metadata, at: 10 });
  const result = await finalizeMemorizeController({
    primary_error: Object.assign(new Error('primary checkpoint failure'),
      { code: 'checkpoint_persistence_failure' }),
    checkpoint,
    provider_audit: metadata.live_memory_health.provider_attempt_audit,
    provider_completion_journal: metadata.provider_completion_journal,
    record_exit: () => { throw new Error('secondary record failure'); },
    persist_diagnostics: () => { throw new Error('secondary save failure'); },
  });
  assert.equal(result.exit.primary_failure.code, 'checkpoint_persistence_failure');
  assert.equal(result.secondary_failures.length, 2);
  assert.equal(checkpoint.secondary_finalization_failures.length, 2);
  assert.equal(result.exit.resumable, true);
});

test('manual cancellation remains distinct and resumable from source traversal', async () => {
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id, 1);
  const checkpoint = {
    status: 'awaiting_manual_resume', source_message_count: 40,
    next_source_offset: 20,
    run_manifest: { logical_run_id: fixture.logical_run_id,
      obligation_ledger: ledger },
    transaction_lifecycle: transaction('rolled_back'),
    controller_heartbeat: { terminal: false,
      controller_invocation_id: fixture.controller_instance_id },
  };
  const result = await finalizeMemorizeController({
    reason_code: 'manual_cancel', classification: 'manually_cancelled', checkpoint,
    close_controller: () => { checkpoint.controller_heartbeat.terminal = true; },
  });
  assert.equal(result.exit.classification, 'manually_cancelled');
  assert.equal(result.exit.resumable, true);
  assert.equal(result.exit.next_eligible_action, 'continue_source_traversal');
  assert.equal(checkpoint.status, 'awaiting_manual_resume');
});

test('terminal failure projection cannot advertise Resume', () => {
  const checkpoint = { status: 'terminal_failure', source_message_count: 40,
    next_source_offset: 40 };
  const authority = deriveMemorizeRecoveryAuthority({ checkpoint,
    ledger: createMemorizeObligationLedger(fixture.logical_run_id, 1),
    checkpoint_status: checkpoint.status });
  const presentation = selectRecoveryPresentation({ checkpoint,
    recovery: { authoritative_recovery: authority } });
  assert.equal(authority.state, 'terminal_failure');
  assert.equal(presentation.disabled, true);
  assert.equal(presentation.label, 'Terminal Failure');
});

test('production catch branch no longer references undeclared Resume variables', () => {
  const source = readFileSync(new URL('../settings.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /resumable:\s*canResume/);
  assert.match(source, /finalizeMemorizeController\(\{/);
  assert.match(source, /mutateAndCheckpointCatchUpTransaction/);
  assert.match(source, /close_controller:\s*\(\)\s*=>\s*closeMemorizeControllerHeartbeat/);
});
