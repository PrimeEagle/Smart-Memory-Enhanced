import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createMemorizeObligationLedger,
  ensureMemorizeObligationLedger,
  projectMemorizeObligationLedger,
  transitionMemorizeObligation,
} from '../memorize-obligation-ledger.js';
import { verifyPersistedPartialSessionRecords } from '../session-partial-persistence.js';
import { runMemorizeReplay } from '../memorize-replay-harness.js';
import {
  beginProviderAttempt,
  summarizeProviderAttemptAudit,
} from '../provider-attempt-audit.js';
import { parseFragmentDecisionResponse } from '../malformed-output-recovery.js';
import { parseSessionOutput } from '../parsers.js';

const fixture = JSON.parse(fs.readFileSync(new URL(
  './fixtures/v0972-session-40-59-lifecycle.json', import.meta.url), 'utf8'));

test('v0.9.72 four/one/one/five state migrates to exact actionable identity sets', () => {
  const raw = {
    schema_version: 1, implementation_version: 3, normalization_complete: true,
    logical_run_id: fixture.logical_run_id, controller_exits: [], obligations: {
      [fixture.obligation_id]: {
        obligation_id: fixture.obligation_id, logical_run_id: fixture.logical_run_id,
        tier: 'session', source_range: fixture.source_range,
        source_fingerprint: fixture.source_fingerprint, current_state: 'blocked',
        exact_reason_code: 'committed_partial_record_verification_failed',
        next_eligible_action: 'inspect_or_restore_committed_partial_record',
        metrics: {
          parser_accepted_records: fixture.parser_accepted_count,
          parser_rejected_fragments: fixture.unresolved_fragment_ids.length,
          downstream_valid_records: 3,
          persisted_records: 1,
          unresolved_parser_fragments: fixture.unresolved_fragment_ids.length,
          unresolved_fragment_ids: fixture.unresolved_fragment_ids,
          producing_provider_attempt_id: fixture.producing_provider_attempt_id,
          partial_record_verification: {
            verified: false, expected_count: 4, verified_count: 1,
            record_ids: fixture.durably_persisted_record_ids,
          },
        },
      },
    },
  };
  const ledger = ensureMemorizeObligationLedger(raw, fixture.logical_run_id);
  const obligation = ledger.obligations[fixture.obligation_id];
  assert.equal(obligation.current_state, 'pending_recovery');
  assert.equal(obligation.next_eligible_action, 'recover_unresolved_partial_output_fragments');
  assert.equal(obligation.lifecycle.counts.parser_accepted_candidate_count, 4);
  assert.equal(obligation.lifecycle.counts.downstream_accepted_candidate_count, 1);
  assert.equal(obligation.lifecycle.counts.durably_persisted_record_count, 1);
  assert.equal(obligation.metrics.downstream_valid_records, 1);
  assert.equal(obligation.metrics.partial_record_verification.verified, true);
  assert.equal(obligation.metrics.partial_record_verification.expected_count, 1);
  assert.deepEqual(obligation.lifecycle.durably_persisted_record_ids, fixture.durably_persisted_record_ids);
  assert.deepEqual(obligation.lifecycle.unresolved_fragment_ids, fixture.unresolved_fragment_ids);
  assert.equal(ledger.recovery_backlog.length, 1);
  assert.deepEqual(ledger.recovery_backlog[0].unresolved_fragment_ids, fixture.unresolved_fragment_ids);
  assert.equal(obligation.recovery_epochs.at(-1).status, 'pending');
});

test('Resume verifies the one durable ID instead of four parser candidates', () => {
  const stored = [{ id: fixture.durably_persisted_record_ids[0], source_message_indices: [43] }];
  const result = verifyPersistedPartialSessionRecords(stored, {
    parser_accepted_candidate_count: 4,
    accepted_partial_record_count: 4,
    durable_partial_record_count: 1,
    durably_persisted_record_ids: fixture.durably_persisted_record_ids,
  }, fixture.source_range);
  assert.equal(result.verified, true);
  assert.equal(result.expected_count, 1);
  assert.equal(result.verified_count, 1);
  assert.deepEqual(result.record_ids, fixture.durably_persisted_record_ids);
});

test('identity model properties hold for independently varied lifecycle stages', () => {
  const seeds = [7, 19, 41, 73, 101, 211, 509, 997];
  for (const seed of seeds) {
    let state = seed >>> 0;
    const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
    for (let iteration = 0; iteration < 40; iteration++) {
      const parsedCount = Math.floor(random() * 7);
      const rejectedCount = Math.floor(random() * 6);
      const acceptedCount = Math.floor(random() * (parsedCount + 1));
      const persistedCount = Math.floor(random() * (acceptedCount + 1));
      const id = `session:seed-${seed}:${iteration}`;
      const parsed = Array.from({ length: parsedCount }, (_, index) => `${id}:candidate:${index}`);
      const accepted = parsed.slice(0, acceptedCount);
      const rejected = parsed.slice(acceptedCount);
      const fragments = Array.from({ length: rejectedCount }, (_, index) => `${id}:fragment:${index}`);
      const records = accepted.slice(0, persistedCount).map((_, index) => `${id}:record:${index}`);
      const map = Object.fromEntries(records.map((record, index) => [record, accepted[index]]));
      const ledger = createMemorizeObligationLedger(`seed-${seed}`);
      const obligation = transitionMemorizeObligation(ledger, {
        obligation_id: id, tier: 'session', source_range: { start: iteration, end: iteration },
      }, {
        current_state: fragments.length || persistedCount < acceptedCount ? 'pending_recovery' : 'durably_committed',
        exact_reason_code: fragments.length || persistedCount < acceptedCount ? 'model_pending' : null,
        next_eligible_action: fragments.length || persistedCount < acceptedCount ? 'resume_exact_obligation' : null,
        persistence_result: records.length ? 'partial_records_committed' : 'not_committed',
        coverage_result: fragments.length || persistedCount < acceptedCount ? 'pending' : 'safely_committed',
        lifecycle: {
          parser_accepted_candidate_ids: parsed,
          parser_rejected_fragment_ids: fragments,
          downstream_accepted_candidate_ids: accepted,
          downstream_rejected_candidate_ids: rejected,
          durably_persisted_record_ids: records,
          durable_record_candidate_map: map,
          unresolved_fragment_ids: fragments,
        },
      });
      assert.equal(obligation.lifecycle.invariants.valid, true, `seed ${seed}, iteration ${iteration}`);
      assert.equal(obligation.lifecycle.counts.durably_persisted_record_count, records.length);
      assert.ok(records.every((record) => obligation.lifecycle.durably_persisted_record_ids.includes(record)));
      const afterRepeat = transitionMemorizeObligation(ledger, obligation, {
        current_state: obligation.current_state, lifecycle: obligation.lifecycle,
      });
      assert.deepEqual(afterRepeat.lifecycle.durably_persisted_record_ids, records);
      assert.equal(new Set(afterRepeat.lifecycle.durably_persisted_record_ids).size, records.length);
    }
  }
});

test('0-119 canary traverses six chunks, recovers backlog, and gates finalization', () => {
  const obligations = [];
  const events = [];
  for (let start = 0; start < 120; start += 20) {
    const end = start + 19;
    const longterm = `longterm:owner:${start}-${end}:canary`;
    const session = `session:chat:${start}-${end}:canary`;
    obligations.push({ obligation_id: longterm, tier: 'longterm', owner: 'owner', source_range: { start, end } });
    obligations.push({ obligation_id: session, tier: 'session', source_range: { start, end } });
    events.push({ obligation_id: longterm, current_state: 'durably_committed',
      persistence_result: 'committed', coverage_result: 'safely_committed' });
    if (start === 40) {
      const candidates = Array.from({ length: 4 }, (_, index) => `candidate-${index}`);
      events.push({ obligation_id: session, current_state: 'pending_recovery',
        exact_reason_code: 'partial_valid_output_has_unresolved_fragments',
        next_eligible_action: 'recover_unresolved_partial_output_fragments',
        lifecycle: {
          parser_accepted_candidate_ids: candidates,
          parser_rejected_fragment_ids: fixture.unresolved_fragment_ids,
          downstream_accepted_candidate_ids: [candidates[0]],
          downstream_rejected_candidate_ids: candidates.slice(1),
          durably_persisted_record_ids: fixture.durably_persisted_record_ids,
          durable_record_candidate_map: { [fixture.durably_persisted_record_ids[0]]: candidates[0] },
          unresolved_fragment_ids: fixture.unresolved_fragment_ids,
        } });
      events.push({ obligation_id: session, current_state: 'durably_committed',
        persistence_result: 'committed', coverage_result: 'safely_committed',
        lifecycle: { explicit_no_update_fragment_ids: fixture.unresolved_fragment_ids } });
    } else events.push({ obligation_id: session, current_state: 'durably_committed',
      persistence_result: 'committed', coverage_result: 'safely_committed' });
  }
  const replay = runMemorizeReplay({ logicalRunId: 'canary-0-119', obligations, events });
  assert.equal(replay.finalization_reachable, true);
  assert.equal(replay.checkpoint, 120);
  assert.equal(replay.projection.recovery_backlog_count, 0);
  assert.equal(replay.projection.completion_gate_satisfied, true);
  assert.equal(replay.duplicate_record_count, 0);
  assert.equal(replay.projection.invariants.valid, true);
});

test('provider reconciliation false always exports exact violated invariant IDs', () => {
  const metadata = { active_catchup_run_id: 'provider-reconciliation-canary' };
  beginProviderAttempt(metadata, {
    tier: 'session', logical_obligation_id: 'session:chat:0-19:canary',
    source_range: { start: 0, end: 19 }, request_kind: 'original',
  });
  const summary = summarizeProviderAttemptAudit(metadata);
  assert.equal(summary.reconciliation.consistent, false);
  assert.ok(summary.reconciliation.violated_invariant_ids.includes(
    'provider_attempt_terminal_accounting'));
  assert.ok(summary.reconciliation.violated_invariants.every((item) =>
    item.invariant_id && Array.isArray(item.affected_obligation_ids)));
});

test('mixed fragment recovery keeps RECORD and NONE terminal identities distinct', () => {
  const fragments = [
    { fragment_id: 'fragment-record' },
    { fragment_id: 'fragment-none' },
  ];
  const parsed = parseFragmentDecisionResponse(JSON.stringify({ decisions: [
    { fragment_id: 'fragment-record', disposition: 'record', type: 'detail',
      claim: 'A supported durable detail.', source_indices: [0] },
    { fragment_id: 'fragment-none', disposition: 'no_update' },
  ] }), fragments, { tier: 'session', parse: parseSessionOutput });
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.record_fragment_ids, ['fragment-record']);
  assert.deepEqual(parsed.no_update_fragment_ids, ['fragment-none']);
  const ledger = createMemorizeObligationLedger('mixed-fragment');
  const obligation = transitionMemorizeObligation(ledger, {
    obligation_id: 'session:mixed', tier: 'session', source_range: { start: 0, end: 1 },
  }, {
    current_state: 'durably_committed', persistence_result: 'committed',
    coverage_result: 'safely_committed', lifecycle: {
      parser_rejected_fragment_ids: fragments.map((item) => item.fragment_id),
      unresolved_fragment_ids: fragments.map((item) => item.fragment_id),
      recovered_fragment_ids: parsed.record_fragment_ids,
      explicit_no_update_fragment_ids: parsed.no_update_fragment_ids,
    },
  });
  assert.equal(obligation.lifecycle.unresolved_fragment_ids.length, 0);
  assert.equal(obligation.lifecycle.invariants.valid, true);
});
