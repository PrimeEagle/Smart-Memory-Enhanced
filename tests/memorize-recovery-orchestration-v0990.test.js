import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createMemorizeRecoveryScheduler } from '../memorize-recovery-scheduler.js';
import { createMemorizeTierOutcome } from '../memorize-tier-outcome.js';
import { executeSessionTier } from '../session-tier-runtime.js';
import { projectMultiOwnerCoverage } from '../multi-owner-coverage.js';
import { dispatchMultiOwnerLongtermBatch, persistMultiOwnerLongtermPartitions }
  from '../multi-owner-longterm.js';

const required = ['A', 'B', 'C', 'D', 'E', 'F'];

function partial(coverage, pass = 0) {
  return createMemorizeTierOutcome({ kind: 'partial_recoverable',
    reason_code: 'missing_owner_coverage_recovery',
    next_action: 'recover_missing_owner_coverage', provider_call_required: true,
    recovery_dimension: `pass:${pass}:${coverage.owners_requiring_recovery.join('|')}`,
    accepted_owners: coverage.owners_with_accepted_records,
    explicit_no_update_owners: coverage.owners_with_explicit_no_update,
    missing_owners: coverage.owners_requiring_recovery,
    owner_coverage: coverage });
}

test('canonical scheduler automatically selects the exact missing-owner subset', () => {
  const coverage = projectMultiOwnerCoverage({ required_owners: required,
    partitions: { A: [{ content: 'a' }], B: [{ content: 'b' }], C: [], D: [], E: [], F: [] },
    no_update_owners: ['E'] });
  const decision = createMemorizeRecoveryScheduler().decide({ outcome: partial(coverage),
    remaining_attempts: 3, provider_available: true, source_available: true });
  assert.deepEqual(decision.owner_subset, ['C', 'D', 'F']);
  assert.equal(decision.decision, 'dispatch_recovery');
  assert.equal(decision.automatic, true);
  assert.notEqual(decision.decision, 'pause_for_user');
  assert.notEqual(decision.next_action, 'recover_unresolved_partial_output_fragments');
});

test('progressive owner recovery shrinks monotonically and commits without manual Resume', async () => {
  const requested = [];
  const persisted = [];
  let prior = null;
  const responses = [
    { records: [
      { owner: 'A', type: 'fact', content: 'a', source_indices: [0] },
      { owner: 'B', type: 'fact', content: 'b', source_indices: [0] },
    ], no_update_owners: [] },
    { records: [
      { owner: 'C', type: 'fact', content: 'c', source_indices: [0] },
      { owner: 'D', type: 'fact', content: 'd', source_indices: [0] },
    ], no_update_owners: [] },
    { records: [
      { owner: 'E', type: 'fact', content: 'e', source_indices: [0] },
      { owner: 'F', type: 'fact', content: 'f', source_indices: [0] },
    ], no_update_owners: [] },
  ];
  const result = await createMemorizeRecoveryScheduler().runOutcomes({
    maximum_attempts: 4,
    execute: async ({ attempt_index: index }) => {
      const owners = prior?.owners_requiring_recovery?.length
        ? prior.owners_requiring_recovery : required;
      requested.push([...owners]);
      const batch = await dispatchMultiOwnerLongtermBatch({ request: {}, owners,
        source_indices: [0], dispatch: async () => JSON.stringify(responses[index]) });
      const ownerResults = await persistMultiOwnerLongtermPartitions({ owners,
        partition: batch.partition,
        prepare_records: async (_owner, records) => ({ records, candidate_ids: [] }),
        persist_partition: async (owner, records) => {
          persisted.push(owner);
          return { status: 'committed', added: records.length, durable_record_ids: [owner],
            durable_record_candidate_map: {} };
        } });
      prior = projectMultiOwnerCoverage({ required_owners: required,
        partitions: batch.partition.partitions,
        no_update_owners: batch.partition.no_update_owners,
        owner_results: ownerResults, prior });
      return prior.complete
        ? createMemorizeTierOutcome({ kind: 'complete', reason_code: 'completed_multi_owner',
          owner_coverage: prior })
        : partial(prior, index);
    },
  });
  assert.equal(result.decision, 'commit_obligation');
  assert.deepEqual(requested, [required, ['C', 'D', 'E', 'F'], ['E', 'F']]);
  assert.deepEqual(persisted, required);
  assert.equal(new Set(persisted).size, required.length);
  assert.equal(result.attempts_used, 3);
});

test('budget exhaustion is reported only after every automatic allowance is consumed', async () => {
  const decisions = [];
  const coverage = projectMultiOwnerCoverage({ required_owners: ['A'], partitions: { A: [] } });
  const result = await createMemorizeRecoveryScheduler().runOutcomes({
    maximum_attempts: 3,
    execute: async ({ attempt_index: index }) => partial(coverage, index),
    onDecision: (decision) => decisions.push(decision.reason_code),
  });
  assert.equal(result.decision, 'pause_for_user');
  assert.equal(result.reason_code, 'recovery_budget_exhausted');
  assert.equal(result.attempts_used, 3);
  assert.deepEqual(decisions.slice(0, 2), [
    'missing_owner_coverage_recovery', 'missing_owner_coverage_recovery']);
  assert.equal(decisions.includes('recovery_budget_exhausted'), true);
});

test('production missing-owner flow is typed and controller-owned, not exception-driven', () => {
  const runtime = fs.readFileSync(new URL('../multi-owner-longterm-runtime.js', import.meta.url), 'utf8');
  const controller = fs.readFileSync(new URL('../settings.js', import.meta.url), 'utf8');
  assert.doesNotMatch(runtime, /SME_MISSING_OWNER_COVERAGE_RECOVERY/);
  assert.doesNotMatch(runtime, /sme_operational_pause/);
  assert.match(runtime, /kind: 'partial_recoverable'/);
  assert.match(controller, /runOutcomes\(\{/);
  assert.match(controller, /Automatically recovering Long-Term owner coverage/);
});

test('diagnostics and UI modules do not own provider dispatch or persistence', () => {
  for (const file of ['memorize-diagnostic-observer.js', 'memorize-diagnostic-boundary.js',
    'memorize-projections.js', 'run-status-utils.js']) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /generateMemoryExtract|persistLongtermOwnerPartition|dispatchMultiOwnerLongtermBatch/);
  }
});

test('Session controller boundary returns typed expected outcomes and preserves unexpected faults', async () => {
  const complete = await executeSessionTier([], null, {}, async () => 2);
  assert.equal(complete.kind, 'complete');
  assert.equal(complete.value.added, 2);

  const pauseError = Object.assign(new Error('bounded recovery consumed'), {
    code: 'recovery_request_budget_reached_with_pending_children',
    sme_operational_pause: true,
    sme_reason_code: 'recovery_stage_ladder_exhausted',
    sme_obligation_id: 'session:40-59',
    sme_request_diagnostics: {
      next_eligible_recovery_action: 'dispatch_provider_request',
      consumed_requests: 2, remaining_requests: 0,
    },
  });
  const paused = await executeSessionTier([], null, {}, async () => { throw pauseError; });
  assert.equal(paused.kind, 'policy_paused');
  assert.equal(paused.reason_code, 'recovery_stage_ladder_exhausted');
  assert.equal(paused.value.obligation_id, 'session:40-59');
  assert.equal(Object.isFrozen(paused.evidence), true);

  const programmingFault = new TypeError('unexpected mutation');
  await assert.rejects(() => executeSessionTier([], null, {}, async () => {
    throw programmingFault;
  }), programmingFault);
});

test('typed outcomes deeply freeze coverage, receipts, evidence, and values', () => {
  const outcome = createMemorizeTierOutcome({ kind: 'partial_recoverable',
    owner_coverage: { owners: { A: { status: 'accepted' } } },
    durable_receipts: [{ id: 'record:A' }], evidence: { budget: { remaining: 2 } },
    value: { nested: { added: 1 } } });
  assert.equal(Object.isFrozen(outcome.owner_coverage.owners.A), true);
  assert.equal(Object.isFrozen(outcome.durable_receipts[0]), true);
  assert.equal(Object.isFrozen(outcome.evidence.budget), true);
  assert.equal(Object.isFrozen(outcome.value.nested), true);
});

test('leaf work queue never commits a parent for a nonterminal typed child outcome', async () => {
  const scheduler = createMemorizeRecoveryScheduler();
  const result = await scheduler.run({ tasks: ['child-a', 'child-b'], keyOf: (item) => item,
    execute: async (item) => item === 'child-a'
      ? createMemorizeTierOutcome({ kind: 'partial_recoverable',
        reason_code: 'missing_owner_coverage_recovery',
        next_action: 'recover_missing_owner_coverage', provider_call_required: true,
        missing_owners: ['C'] })
      : createMemorizeTierOutcome({ kind: 'complete', value: { added: 1 } }) });
  assert.equal(result.completed, false);
  assert.equal(result.pause_reason, 'missing_owner_coverage_recovery');
  assert.equal(result.next_task_key, 'child-a');
  assert.deepEqual(result.committed_keys, []);
  assert.equal(result.executed, 1);
});
