import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { beginProviderAttempt }
  from '../provider-attempt-audit.js';
import { recordProviderCompletion } from '../provider-completion-journal.js';
import { acknowledgeJournalTransition, requireAppliedLifecycleResult }
  from '../memorize-lifecycle-coordinator.js';
import {
  applyMemorizeLifecycleEvent,
  createMemorizeObligationLedger,
  reconcileMemorizeLifecycleFromJournal,
} from '../memorize-obligation-ledger.js';

const fixture = JSON.parse(readFileSync(new URL(
  './fixtures/v0978-stranded-terminal-leaf.json', import.meta.url)));

function identity(item, root = fixture.root_obligation_id) {
  return {
    obligation_id: item.obligation_id,
    root_obligation_id: root,
    logical_run_id: fixture.logical_run_id,
    tier: 'session', owner: null,
    source_range: { start: item.range[0], end: item.range[1],
      message_count: item.range[1] - item.range[0] + 1 },
    source_fingerprint: item.fingerprint,
    parent_obligation_id: root === item.obligation_id ? null : root,
  };
}

function strandedLedger() {
  const ledger = createMemorizeObligationLedger(fixture.logical_run_id, 1);
  const root = {
    obligation_id: fixture.root_obligation_id,
    logical_run_id: fixture.logical_run_id,
    tier: 'session', owner: null,
    source_range: { start: 20, end: 39, message_count: 20 },
    source_fingerprint: 'fnv1a-eeb22053',
  };
  applyMemorizeLifecycleEvent(ledger, root, {
    type: 'recovery_children_declared',
    children: fixture.children.map((item) => identity(item)),
    event_id: 'fixture:children', at: 2,
  });
  const first = fixture.children[0];
  applyMemorizeLifecycleEvent(ledger, identity(first), {
    type: 'provider_attempt_started', provider_attempt_id: first.attempt_id, at: 3,
  });
  applyMemorizeLifecycleEvent(ledger, identity(first), {
    type: 'recovery_required', reason_code: 'provider_attempt_registration_required',
    next_action: 'resume_exact_obligation', at: 4,
  });
  const second = fixture.children[1];
  const candidateMap = Object.fromEntries(fixture.journal[2].validated_record_identities
    .map((item) => [item.id, item.candidate_id]));
  applyMemorizeLifecycleEvent(ledger, identity(second), {
    type: 'leaf_coverage_completed', verified_coverage: true,
    durable_record_ids: second.record_ids,
    lifecycle: { parser_accepted_candidate_ids: Object.values(candidateMap),
      downstream_accepted_candidate_ids: Object.values(candidateMap),
      durable_record_candidate_map: candidateMap },
    at: 5,
  });
  const noUpdate = { obligation_id: 'session:chat:0-19:fnv1a-39c6c9f',
    range: [0, 19], fingerprint: 'fnv1a-39c6c9f' };
  applyMemorizeLifecycleEvent(ledger, identity(noUpdate, noUpdate.obligation_id), {
    type: 'leaf_coverage_completed', verified_coverage: true,
    explicit_no_update: true, at: 6,
  });
  return ledger;
}

test('physical attempt retains immutable root and exact leaf identities', () => {
  const metadata = { active_catchup_run_id: fixture.logical_run_id };
  const child = fixture.children[0];
  const attempt = beginProviderAttempt(metadata, {
    tier: 'session', logical_obligation_id: fixture.root_obligation_id,
    child_obligation_id: child.obligation_id,
    source_range: { start: 20, end: 29, message_count: 10 },
    source_fingerprint: child.fingerprint,
  });
  assert.equal(attempt.root_obligation_id, fixture.root_obligation_id);
  assert.equal(attempt.child_obligation_id, child.obligation_id);
  assert.equal(attempt.leaf_obligation_id, child.obligation_id);
});

test('callers cannot self-declare a journal ledger transition applied', () => {
  const metadata = {};
  const entry = recordProviderCompletion(metadata, fixture.attempts[1], {
    child_obligation_id: fixture.children[0].obligation_id,
    ledger_transition: { status: 'applied', disposition: 'durably_committed' },
  });
  assert.equal(entry.ledger_transition.status, 'pending_reconciliation');
  assert.equal(entry.ledger_transition.caller_assertion_rejected, 'applied');
});

test('reducer rejection cannot produce a verified journal acknowledgement', () => {
  const ledger = createMemorizeObligationLedger('run');
  const rejected = applyMemorizeLifecycleEvent(ledger, {
    obligation_id: 'session:chat:0-19:test', tier: 'session',
    source_range: { start: 0, end: 19 }, source_fingerprint: 'test',
  }, { type: 'parser_accepted' });
  assert.throws(() => requireAppliedLifecycleResult(rejected, ['parser_accepted']),
    { code: 'SME_LIFECYCLE_TRANSITION_REJECTED' });
  const entry = { ledger_transition: { status: 'pending' } };
  acknowledgeJournalTransition(entry, 'ledger_transition', { status: 'rejected' });
  assert.equal(entry.ledger_transition.status, 'rejected');
});

test('parent cannot close while any registered child remains incomplete', () => {
  const ledger = strandedLedger();
  const result = applyMemorizeLifecycleEvent(ledger,
    ledger.obligations[fixture.root_obligation_id], {
      type: 'parent_children_completed', event_id: 'fixture:invalid-parent-close',
    });
  assert.equal(result.status, 'rejected');
  assert.equal(result.violation.code, 'parent_completion_without_complete_registered_children');
});

test('production tier callers cannot bypass verified lifecycle authority', () => {
  for (const file of ['../session.js', '../longterm.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source,
      /(?:ledger_transition|manifest_transition)\s*:\s*\{\s*status:\s*['"]applied['"]/,
      `${file} must not self-declare canonical transition acknowledgement`);
  }
  const settings = readFileSync(new URL('../settings.js', import.meta.url), 'utf8');
  assert.doesNotMatch(settings, /retry-settlement:unknown/,
    'retry settlement must fail closed on a typed exact-identity blocker');
});
