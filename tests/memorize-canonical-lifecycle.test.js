import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createMemorizeObligationLedger,
  projectMemorizeObligationLedger,
  transitionMemorizeObligation,
} from '../memorize-obligation-ledger.js';
import { migrateAmbiguousRecoveryParents } from '../memorize-lifecycle-migration.js';
import {
  beginProviderAttempt,
  finishProviderAttempt,
} from '../provider-attempt-audit.js';
import { exportProviderCompletionJournal } from '../provider-completion-journal.js';
import {
  closeMemorizeControllerHeartbeat,
  updateMemorizeControllerHeartbeat,
} from '../memorize-controller-heartbeat.js';

const fixture = JSON.parse(fs.readFileSync(new URL(
  './fixtures/v0974-session-280-299-ambiguous-parent.json', import.meta.url), 'utf8'));

test('authoritative reducer rejects committed to provider-running before mutation', () => {
  const ledger = createMemorizeObligationLedger('run');
  const input = { obligation_id: 'session:leaf', tier: 'session',
    source_range: { start: 0, end: 4 } };
  const committed = transitionMemorizeObligation(ledger, input, {
    current_state: 'durably_committed', persistence_result: 'committed',
    coverage_result: 'safely_committed', lifecycle: {
      parser_accepted_candidate_ids: ['candidate'],
      downstream_accepted_candidate_ids: ['candidate'],
      durably_persisted_record_ids: ['record'],
      durable_record_candidate_map: { record: 'candidate' },
    },
  });
  const snapshot = structuredClone(committed);
  const rejected = transitionMemorizeObligation(ledger, input, {
    current_state: 'provider_running', provider_attempt_id: 'provider-next',
  });
  assert.deepEqual(rejected, snapshot);
  assert.deepEqual(ledger.obligations[input.obligation_id], snapshot);
  assert.equal(ledger.transition_violations.at(-1).from, 'durably_committed');
  assert.equal(ledger.transition_violations.at(-1).to, 'provider_running');
  const violationSnapshot = structuredClone(ledger.transition_violations);
  transitionMemorizeObligation(ledger, input, {
    current_state: 'provider_running', provider_attempt_id: 'provider-next',
  });
  assert.deepEqual(ledger.transition_violations, violationSnapshot);
});

test('v0.9.74 attempt 399/400 migration preserves records and exposes exact leaves', () => {
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id);
  ledger.obligations[fixture.root_obligation_id] = {
    obligation_id: fixture.root_obligation_id, logical_run_id: fixture.logical_run_id,
    tier: 'session', owner: null, source_range: fixture.source_range,
    source_fingerprint: 'fnv1a-f662dcb6', parent_obligation_id: null,
    expected_child_obligation_ids: [], provider_attempt_lineage: fixture.attempts.map((a) => a.attempt_id),
    parser_result: 'accepted', downstream_validation_result: 'accepted',
    persistence_result: 'committed', coverage_result: 'safely_committed',
    current_state: 'provider_response_received', checkpoint_eligible: false,
    exact_reason_code: 'downstream_parser_pending', next_eligible_action: null,
    recovery_intent: null, recovery_stage: null, timestamps: {}, transition_history: [],
    implementation_version: 5, schema_version: 3,
    metrics: { persisted_records: 4 },
    lifecycle: {
      parser_accepted_candidate_ids: ['c1', 'c2', 'c3', 'c4'],
      downstream_accepted_candidate_ids: ['c1', 'c2', 'c3', 'c4'],
      durably_persisted_record_ids: fixture.durable_record_ids,
      durable_record_candidate_map: Object.fromEntries(
        fixture.durable_record_ids.map((id, index) => [id, `c${index + 1}`])),
    },
  };
  const metadata = {};
  const first = migrateAmbiguousRecoveryParents({ ledger, metadata,
    provider_audit: { recent_attempts: fixture.attempts } });
  assert.equal(first.migrated, true);
  const detail = first.detail.migrated_parents[0];
  const committed = ledger.obligations[detail.committed_leaf_id];
  const failed = ledger.obligations[detail.failed_leaf_id];
  const unattempted = detail.unattempted_leaf_ids.map((id) => ledger.obligations[id]);
  assert.deepEqual(committed.lifecycle.durably_persisted_record_ids,
    fixture.durable_record_ids);
  assert.deepEqual(committed.source_range, { start: 280, end: 284, message_count: 5 });
  assert.equal(failed.current_state, 'operationally_paused');
  assert.equal(failed.exact_reason_code, 'malformed_recovery_exhausted');
  assert.equal(failed.next_eligible_action, 'resume_changed_dimension_or_single_source_recovery');
  assert.deepEqual(failed.source_range, { start: 285, end: 289, message_count: 5 });
  assert.deepEqual(unattempted.map((item) => item.source_range), [
    { start: 290, end: 299, message_count: 10 },
  ]);
  assert.equal(ledger.obligations[fixture.root_obligation_id].checkpoint_eligible, false);
  assert.equal(projectMemorizeObligationLedger(ledger).next_eligible_obligation.obligation_id,
    detail.failed_leaf_id);
  const journal = exportProviderCompletionJournal(metadata);
  const attempt399 = journal.entries.find((entry) => entry.attempt_id.endsWith('-399'));
  const attempt400 = journal.entries.find((entry) => entry.attempt_id.endsWith('-400'));
  assert.equal(attempt399.persistence.status, 'verified_existing');
  assert.deepEqual(attempt399.persistence.durable_record_ids, fixture.durable_record_ids);
  assert.equal(attempt400.persistence.status, 'not_applicable');
  assert.equal(attempt400.ledger_transition.disposition, 'operationally_paused');
  const snapshot = structuredClone(ledger);
  const second = migrateAmbiguousRecoveryParents({ ledger, metadata,
    provider_audit: { recent_attempts: fixture.attempts } });
  assert.equal(second.migrated, false);
  assert.deepEqual(ledger, snapshot);
});

test('every physical terminal attempt receives an explicit journal disposition', () => {
  const metadata = { active_catchup_run_id: 'run' };
  const failed = beginProviderAttempt(metadata, { logical_obligation_id: 'session:root',
    child_obligation_id: 'session:leaf', tier: 'session', request_kind: 'original',
    source_range: { start: 0, end: 4 }, source_fingerprint: 'range-a' });
  finishProviderAttempt(metadata, failed, { terminal_outcome: 'provider_response_malformed',
    malformed_reason: 'invalid_json' });
  const success = beginProviderAttempt(metadata, { logical_obligation_id: 'session:root',
    child_obligation_id: 'session:leaf-b', tier: 'session', request_kind: 'original',
    source_range: { start: 5, end: 9 }, source_fingerprint: 'range-b' });
  finishProviderAttempt(metadata, success, { terminal_outcome: 'completed' });
  const journal = exportProviderCompletionJournal(metadata);
  assert.equal(journal.entries.length, 2);
  assert.equal(journal.entries[0].persistence.status, 'not_applicable');
  assert.equal(journal.entries[1].persistence.status, 'pending');
  assert.equal(journal.entries[1].child_obligation_id, 'session:leaf-b');
});

test('controller exit closes heartbeat ownership and every await point', () => {
  const checkpoint = {};
  const runtime = { invocation_id: 'controller-1', page_instance_id: 'page-1',
    attempt_number: 2, active_transaction: { transaction_id: 'tx-19' } };
  updateMemorizeControllerHeartbeat(checkpoint, runtime, {
    phase: 'source_extraction', active_provider_attempt_id: 'provider-400',
    await_point: 'provider_request', progress: true,
  }, 100);
  const closed = closeMemorizeControllerHeartbeat(checkpoint, runtime, {
    classification: 'operationally_paused', reason_code: 'malformed_recovery_exhausted',
    next_eligible_action: 'resume_changed_dimension_or_single_source_recovery',
  }, 200);
  assert.equal(closed.terminal, true);
  assert.equal(closed.active_transaction_id, null);
  assert.equal(closed.active_provider_attempt_id, null);
  assert.equal(closed.await_point, null);
  assert.equal(closed.exit_reason_code, 'malformed_recovery_exhausted');
});
