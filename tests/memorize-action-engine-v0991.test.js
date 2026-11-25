import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runCanonicalMemorizeActions, selectCanonicalMemorizeAction }
  from '../memorize-action-engine.js';
import { aggregateMemorizeObligationParents, createMemorizeObligationLedger,
  transitionMemorizeObligation } from '../memorize-obligation-ledger.js';
import { classifyMemorizeErrorRecord } from '../memorize-error-origin.js';

const obligation = (id, start, end, patch = {}) => ({
  obligation_id: id, tier: 'session', owner: null,
  source_range: { start, end, message_count: end - start + 1 },
  source_fingerprint: `fp-${start}-${end}`, parent_obligation_id: null,
  current_state: 'unattempted', checkpoint_eligible: false,
  exact_reason_code: 'recovery_child_not_attempted',
  next_eligible_action: 'dispatch_provider_request',
  expected_child_obligation_ids: [], updated_at: 1, ...patch,
});

function nestedLedger() {
  const root = obligation('root', 20, 39, {
    current_state: 'pending_recovery', exact_reason_code: 'recovery_children_pending',
    next_eligible_action: 'aggregate_completed_children',
    expected_child_obligation_ids: ['20-29', '30-39'],
  });
  const left = obligation('20-29', 20, 29, { parent_obligation_id: 'root',
    current_state: 'durably_committed', checkpoint_eligible: true });
  const right = obligation('30-39', 30, 39, { parent_obligation_id: 'root',
    current_state: 'pending_recovery', expected_child_obligation_ids: ['30-34', '35-39'],
    next_eligible_action: 'aggregate_completed_children' });
  const committed = obligation('30-34', 30, 34, { parent_obligation_id: '30-39',
    current_state: 'durably_committed', checkpoint_eligible: true });
  const pending = obligation('35-39', 35, 39, { parent_obligation_id: '30-39' });
  return { logical_run_id: 'run', obligations: Object.fromEntries(
    [root, left, right, committed, pending].map((item) => [item.obligation_id, item])) };
}

test('nested Session recovery selects exact 35-39 and never redispatches a parent', () => {
  const selected = selectCanonicalMemorizeAction({ ledger: nestedLedger(), tier: 'session',
    source_range: { start: 20, end: 39 } });
  assert.equal(selected.kind, 'dispatch_leaf');
  assert.equal(selected.obligation.obligation_id, '35-39');
  assert.deepEqual(selected.obligation.source_range, { start: 35, end: 39, message_count: 5 });
  assert.equal(selected.root_obligation.obligation_id, 'root');
});

test('crash after 30-34 resumes 35-39, then aggregates each ancestor without provider replay', async () => {
  const ledger = nestedLedger();
  const providerDispatches = [];
  const aggregations = [];
  const result = await runCanonicalMemorizeActions({
    read_ledger: () => ledger,
    select: (graph) => selectCanonicalMemorizeAction({ ledger: graph, tier: 'session',
      source_range: { start: 20, end: 39 } }),
    execute: async (selected) => {
      providerDispatches.push(selected.obligation.obligation_id);
      Object.assign(ledger.obligations[selected.obligation.obligation_id], {
        current_state: 'durably_committed', checkpoint_eligible: true, updated_at: 2,
      });
      return { kind: 'complete' };
    },
    aggregate: async (selected) => {
      aggregations.push(selected.obligation.obligation_id);
      Object.assign(ledger.obligations[selected.obligation.obligation_id], {
        current_state: 'durably_committed', checkpoint_eligible: true, updated_at: 3,
      });
    },
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(providerDispatches, ['35-39']);
  assert.deepEqual(aggregations, ['30-39', 'root']);
});

test('real obligation reducer and action engine complete nested Session recovery end to end', async () => {
  const ledger = createMemorizeObligationLedger('run', 1);
  const identity = (id, start, end, parent = null, children = []) => ({
    obligation_id: id, logical_run_id: 'run', tier: 'session', owner: null,
    source_range: { start, end, message_count: end - start + 1 },
    source_fingerprint: `fp-${start}-${end}`, parent_obligation_id: parent,
    expected_child_obligation_ids: children,
  });
  transitionMemorizeObligation(ledger, identity('root', 20, 39, null, ['20-29', '30-39']), {
    current_state: 'pending_recovery', exact_reason_code: 'recovery_children_pending',
    next_eligible_action: 'aggregate_completed_children', at: 2,
  });
  transitionMemorizeObligation(ledger, identity('20-29', 20, 29, 'root'), {
    current_state: 'durably_committed', at: 3,
  });
  transitionMemorizeObligation(ledger,
    identity('30-39', 30, 39, 'root', ['30-34', '35-39']), {
      current_state: 'pending_recovery', exact_reason_code: 'recovery_children_pending',
      next_eligible_action: 'aggregate_completed_children', at: 4,
    });
  transitionMemorizeObligation(ledger, identity('30-34', 30, 34, '30-39'), {
    current_state: 'durably_committed', at: 5,
  });
  transitionMemorizeObligation(ledger, identity('35-39', 35, 39, '30-39'), {
    current_state: 'unattempted', exact_reason_code: 'recovery_child_not_attempted',
    next_eligible_action: 'dispatch_provider_request', at: 6,
  });
  const dispatches = [];
  const result = await runCanonicalMemorizeActions({
    read_ledger: () => ledger,
    select: (graph) => selectCanonicalMemorizeAction({ ledger: graph, tier: 'session',
      source_range: { start: 20, end: 39 }, root_obligation_id: 'root' }),
    execute: async (selected) => {
      dispatches.push(selected.obligation.obligation_id);
      transitionMemorizeObligation(ledger, selected.obligation, {
        current_state: 'durably_committed', at: 7,
      });
      return { kind: 'complete' };
    },
    aggregate: async () => aggregateMemorizeObligationParents(ledger, 8),
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(dispatches, ['35-39']);
  assert.equal(ledger.obligations['30-39'].checkpoint_eligible, true);
  assert.equal(ledger.obligations.root.checkpoint_eligible, true);
});

test('production Session wiring delegates recursion and automatic continuation to the controller', async () => {
  const [settings, session] = await Promise.all([
    readFile(new URL('../settings.js', import.meta.url), 'utf8'),
    readFile(new URL('../session.js', import.meta.url), 'utf8'),
  ]);
  assert.match(settings, /runCanonicalMemorizeActions\s*\(/);
  assert.match(settings, /selectCanonicalMemorizeAction\s*\(/);
  assert.match(settings, /controller_owned:\s*true/);
  assert.match(session, /canonical_recovery_children_declared/);
  assert.match(session, /!execution\.recovery\.controller_owned\s*\n\s*&& execution\.recovery\.automatic_partial_recovery/);
});

test('truncated provider output is provider-output evidence, never an internal invariant failure', () => {
  assert.equal(classifyMemorizeErrorRecord({ code: 'SME_MALFORMED_PROVIDER_OUTPUT' }),
    'provider_output_failure');
  assert.equal(classifyMemorizeErrorRecord({
    code: 'recovery_request_budget_reached_with_pending_children',
    sme_operational_pause: true,
  }), 'operational_pause');
});

test('a claimed completion without a canonical transition fails before duplicate dispatch', async () => {
  const ledger = { logical_run_id: 'run', obligations: {
    root: obligation('root', 0, 19),
  } };
  let calls = 0;
  const result = await runCanonicalMemorizeActions({
    read_ledger: () => ledger,
    select: (graph) => selectCanonicalMemorizeAction({ ledger: graph, tier: 'session',
      source_range: { start: 0, end: 19 }, root_obligation_id: 'root' }),
    execute: async () => { calls++; return { kind: 'complete' }; },
    aggregate: async () => {},
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason_code, 'action_outcome_without_canonical_transition');
  assert.equal(calls, 1);
});
