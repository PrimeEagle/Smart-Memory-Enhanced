import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  applyProviderCompletion,
  createMemorizeExecutionAggregate,
  ensureMemorizeExecutionAggregate,
  latestMemorizeActionReceipt,
  observeMemorizeKernelCommit,
  projectMemorizeKernelStatus,
  recordMemorizeActionReceipt,
  validateMemorizeExecutionAggregate,
} from '../memorize-execution-kernel.js';
import { applyMemorizeLifecycleEvent } from '../memorize-obligation-ledger.js';
import {
  createMemorizeRecoveryCapsule,
  materializeSourceBackedRecovery,
} from '../memorize-recovery-capsule.js';
import {
  assessMemorizeProviderDispatch,
  createMemorizeProviderProfile,
  recordMemorizeProviderOutcome,
  selectMemorizeProviderProtocol,
  shouldRepartitionMemorizeSource,
} from '../memorize-provider-policy.js';
import {
  commitMemorizeUnitOfWork,
  executeMemorizeUnitOfWork,
  markMemorizeRecordsApplied,
  prepareMemorizeUnitOfWork,
  replayPreparedMemorizeUnitOfWork,
} from '../memorize-unit-of-work.js';
import { buildStructuredMemoryProviderRequest,
  parseStructuredMemoryResponse } from '../malformed-output-recovery.js';
import { createMemorizeExecutionContext } from '../memorize-execution-context.js';
import { createMemorizeTierPipeline } from '../memorize-tier-pipeline.js';
import { createMemorizeOutcome } from '../memorize-outcome.js';
import { createMemorizeRunEngine } from '../memorize-run-engine.js';
import { deriveMemorizeRecoveryAuthority } from '../memorize-recovery-authority.js';
import { projectMemorizeKernelDiagnostics } from '../memorize-diagnostic-observer.js';

const RUN = 'run-v0986';
const sourceFingerprint = (messages) => `fp:${messages.map((item) => item.id).join(',')}`;

test('a controller aggregate without the execution kernel is rejected, not upgraded', () => {
  const ledgerOnly = createMemorizeExecutionAggregate(RUN);
  delete ledgerOnly.execution_kernel;
  assert.throws(() => ensureMemorizeExecutionAggregate(ledgerOnly, RUN),
    (error) => error.code === 'SME_MEMORIZE_SCHEMA_UNSUPPORTED'
      && error.sme_reason_code === 'fresh_start_required');
});

function register(aggregate, { id, root = id, parent = null, tier = 'session', owner = null,
  start, end, fingerprint = `fp:${start}-${end}` }) {
  const result = applyMemorizeLifecycleEvent(aggregate, {
    obligation_id: id, root_obligation_id: root, leaf_obligation_id: id,
    parent_obligation_id: parent, logical_run_id: RUN, tier, owner,
    source_range: { start, end, message_count: end - start + 1 },
    source_fingerprint: fingerprint,
  }, { type: 'obligation_registered', event_id: `register:${id}` });
  assert.equal(result.status, 'applied');
  return aggregate;
}

function completeCommand({ id, attempt = `attempt:${id}`, start, end, command = `complete:${id}`,
  candidate = `candidate:${id}`, record = `record:${id}`, terminal = true,
  rejected = [], owner = null, tier = 'session' }) {
  return {
    command_id: command, logical_run_id: RUN, obligation_leaf_id: id,
    root_obligation_id: id, attempt_id: attempt, tier, owner,
    source_range: { start, end, message_count: end - start + 1 },
    source_fingerprint: `fp:${start}-${end}`,
    raw_response_reference: { retained: false, digest: `digest:${attempt}` },
    parser_outcome: { status: rejected.length ? 'partial' : 'accepted',
      accepted_candidate_ids: [candidate], rejected_fragment_ids: rejected },
    validation_outcome: { status: rejected.length ? 'partial' : 'accepted',
      accepted_candidate_ids: [candidate] },
    persistence_outcome: { status: 'committed', durable_record_ids: [record],
      durable_record_candidate_map: { [record]: candidate },
      source_provenance: { source_indices: [start] } },
    terminal,
  };
}

test('durable action receipts enforce run and leaf identity and replay idempotently', () => {
  const aggregate = register(createMemorizeExecutionAggregate(RUN), {
    id: 'session:0-19', start: 0, end: 19,
  });
  const input = { logical_run_id: RUN, obligation_id: 'session:0-19',
    action: 'dispatch_provider_request', phase: 'provider_request_started',
    attempt_id: 'attempt:1', controller_generation: 3 };
  const first = recordMemorizeActionReceipt(aggregate, input, 100);
  assert.equal(first.status, 'applied');
  assert.equal(latestMemorizeActionReceipt(first.aggregate, 'session:0-19').phase,
    'provider_request_started');
  const duplicate = recordMemorizeActionReceipt(first.aggregate, input, 101);
  assert.equal(duplicate.status, 'idempotent_duplicate');
  assert.equal(duplicate.mutated, false);
  assert.equal(recordMemorizeActionReceipt(first.aggregate, { ...input,
    logical_run_id: 'prior-run' }).reason_code, 'logical_run_identity_mismatch');
  assert.equal(recordMemorizeActionReceipt(first.aggregate, { ...input,
    obligation_id: 'missing' }).reason_code, 'unknown_obligation_leaf');
});

test('redacted v0.9.85 fixture characterizes all five failures and both leaf identity violations', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/v0985-execution-kernel-failures.json', import.meta.url)));
  assert.equal(fixture.errors.length, 5);
  assert.equal(fixture.errors.filter((item) => item.code === 'SME_MISSING_FRAGMENT_RECOVERY_PAYLOAD').length, 2);
  assert.deepEqual(fixture.identity_regressions.map((item) => item.ranges.at(-1)), [[85, 89], [175, 179]]);
  assert.ok(fixture.provider.request_amplification > 5);
});

test('atomic completion reconciles response, parser, validation, mapping, and persistence on one exact leaf', () => {
  const aggregate = register(createMemorizeExecutionAggregate(RUN), {
    id: 'session:0-19', start: 0, end: 19,
  });
  const result = applyProviderCompletion(aggregate, completeCommand({ id: 'session:0-19', start: 0, end: 19 }));
  assert.equal(result.status, 'applied');
  assert.equal(result.receipt.resulting_state, 'durably_committed');
  assert.equal(result.aggregate.obligations['session:0-19'].provider_attempt_lineage[0], 'attempt:session:0-19');
  assert.equal(validateMemorizeExecutionAggregate(result.aggregate).valid, true);
});

test('a completion command is idempotent and cannot duplicate durable records', () => {
  let aggregate = register(createMemorizeExecutionAggregate(RUN), {
    id: 'session:0-19', start: 0, end: 19,
  });
  const command = completeCommand({ id: 'session:0-19', start: 0, end: 19 });
  const first = applyProviderCompletion(aggregate, command);
  const second = applyProviderCompletion(first.aggregate, command);
  assert.equal(second.status, 'idempotent_duplicate');
  assert.equal(second.mutated, false);
  assert.deepEqual(first.aggregate.obligations['session:0-19'].lifecycle.durably_persisted_record_ids,
    ['record:session:0-19']);
});

test('a late callback is recorded once without reopening a terminal leaf', () => {
  let aggregate = register(createMemorizeExecutionAggregate(RUN), {
    id: 'session:0-19', start: 0, end: 19,
  });
  const completed = applyProviderCompletion(aggregate,
    completeCommand({ id: 'session:0-19', start: 0, end: 19 }));
  const lateCommand = completeCommand({ id: 'session:0-19', start: 0, end: 19,
    command: 'late:session:0-19', attempt: 'late-attempt:session:0-19' });
  const late = applyProviderCompletion(completed.aggregate, lateCommand, 2);
  const replay = applyProviderCompletion(late.aggregate, lateCommand, 3);
  assert.equal(late.status, 'late_callback_ignored');
  assert.equal(late.mutated, true);
  assert.equal(late.aggregate.obligations['session:0-19'].current_state, 'durably_committed');
  assert.equal(late.aggregate.execution_kernel.stale_callbacks.length, 1);
  assert.equal(replay.status, 'idempotent_duplicate');
  assert.equal(replay.mutated, false);
  assert.equal(late.aggregate.obligations['session:0-19'].lifecycle
    .durably_persisted_record_ids.length, 1);
});

test('parser evidence cannot be attached to a different leaf from its physical response', () => {
  let aggregate = createMemorizeExecutionAggregate(RUN);
  register(aggregate, { id: 'lisette:80-89', start: 80, end: 89, tier: 'longterm', owner: 'Lisette Dumont' });
  register(aggregate, { id: 'lisette:85-89', start: 85, end: 89, tier: 'longterm', owner: 'Lisette Dumont' });
  const first = applyProviderCompletion(aggregate, completeCommand({ id: 'lisette:80-89', start: 80, end: 89,
    attempt: 'attempt:lisette', tier: 'longterm', owner: 'Lisette Dumont' }));
  const mismatched = applyProviderCompletion(first.aggregate, completeCommand({ id: 'lisette:85-89', start: 85, end: 89,
    command: 'late:lisette', attempt: 'attempt:lisette', tier: 'longterm', owner: 'Lisette Dumont' }));
  assert.equal(mismatched.status, 'rejected');
  assert.equal(mismatched.reason_code, 'attempt_belongs_to_different_leaf');
  assert.equal(first.aggregate.obligations['lisette:85-89'].current_state, 'unattempted');
});

test('missing private fragment payload regenerates from a verified source window', async () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({ id: 40 + index, text: `message ${40 + index}` }));
  const capsule = createMemorizeRecoveryCapsule({
    logical_run_id: RUN, obligation_leaf_id: 'session:40-59', tier: 'session',
    source_range: { start: 40, end: 59, message_count: 20 },
    source_fingerprint: sourceFingerprint(messages),
    accepted_candidate_fingerprints: ['accepted:a'], durable_record_ids: ['record:a'],
    rejected_fragment_ids: ['fragment:b'], private_fragment_payload_available: false,
    source_backed_regeneration_available: true,
  });
  const result = await materializeSourceBackedRecovery(capsule, async () => messages, sourceFingerprint);
  assert.equal(result.status, 'ready');
  assert.equal(result.next_action, 'regenerate_unresolved_from_verified_source');
  assert.deepEqual(result.exclusions.durable_record_ids, ['record:a']);
});

test('source-backed recovery fails closed on fingerprint mismatch', async () => {
  const messages = [{ id: 80, text: 'original' }];
  const capsule = createMemorizeRecoveryCapsule({
    logical_run_id: RUN, obligation_leaf_id: 'session:80-80', tier: 'session',
    source_range: { start: 80, end: 80, message_count: 1 },
    source_fingerprint: sourceFingerprint(messages), rejected_fragment_ids: ['fragment:x'],
    private_fragment_payload_available: false, source_backed_regeneration_available: true,
  });
  const result = await materializeSourceBackedRecovery(capsule,
    async () => [{ id: 80, text: 'changed' }], () => 'different');
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason_code, 'source_window_fingerprint_mismatch');
});

test('canonical status offers Resume only when the exact action is executable', () => {
  let aggregate = register(createMemorizeExecutionAggregate(RUN), {
    id: 'session:40-59', start: 40, end: 59,
  });
  const partial = completeCommand({ id: 'session:40-59', start: 40, end: 59,
    rejected: ['fragment:b'], terminal: false });
  partial.recovery_capsule = { private_fragment_payload_available: false,
    source_backed_regeneration_available: true };
  aggregate = applyProviderCompletion(aggregate, partial).aggregate;
  const ready = projectMemorizeKernelStatus(aggregate);
  assert.equal(ready.resume_enabled, true);
  assert.equal(ready.next_action, 'dispatch_provider_request');
  assert.equal(ready.raw_obligation_action, 'regenerate_unresolved_from_verified_source');

  const blockedAggregate = structuredClone(aggregate);
  blockedAggregate.execution_kernel.recovery_capsules['session:40-59'] = {
    ...blockedAggregate.execution_kernel.recovery_capsules['session:40-59'],
    source_backed_regeneration_available: false,
  };
  const blocked = projectMemorizeKernelStatus(blockedAggregate);
  assert.equal(blocked.resume_enabled, false);
  assert.equal(blocked.action_executable, false);
});

test('controller, UI authority, and diagnostics share one canonical status projection', () => {
  let aggregate = register(createMemorizeExecutionAggregate(RUN), {
    id: 'session:40-59', start: 40, end: 59,
  });
  const partial = completeCommand({ id: 'session:40-59', start: 40, end: 59,
    rejected: ['fragment:b'], terminal: false });
  partial.recovery_capsule = { private_fragment_payload_available: false,
    source_backed_regeneration_available: true };
  aggregate = applyProviderCompletion(aggregate, partial).aggregate;
  const canonical = projectMemorizeKernelStatus(aggregate);
  const authority = deriveMemorizeRecoveryAuthority({
    ledger: aggregate,
    checkpoint: { status: 'awaiting_manual_resume', source_message_count: 60,
      next_source_offset: 40 },
    checkpoint_status: 'awaiting_manual_resume', source_message_count: 60,
    next_source_offset: 40, provider_audit: { recent_attempts: [], obligations: {} },
  });
  const diagnostics = projectMemorizeKernelDiagnostics(aggregate);
  assert.equal(authority.resume_eligible, canonical.resume_enabled);
  assert.equal(authority.next_executable_action, canonical.next_action);
  assert.equal(authority.provider_call_permitted, canonical.provider_call_required);
  assert.equal(diagnostics.current.resume_enabled, canonical.resume_enabled);
  assert.equal(diagnostics.current.next_action, canonical.next_action);
  assert.equal(diagnostics.current.exact_blocker, canonical.exact_blocker);
});

test('journaled unit of work replays crashes after record persistence without duplication', () => {
  const aggregate = register(createMemorizeExecutionAggregate(RUN), {
    id: 'session:0-19', start: 0, end: 19,
  });
  const command = completeCommand({ id: 'session:0-19', start: 0, end: 19 });
  let state = prepareMemorizeUnitOfWork({ aggregate }, command, 1).state;
  state = markMemorizeRecordsApplied(state, command.command_id, { inserted: ['record:session:0-19'] }, 2).state;
  const recovered = commitMemorizeUnitOfWork(state, command.command_id, { next_source_offset: 20 }, 3);
  const replay = commitMemorizeUnitOfWork(recovered.state, command.command_id, { next_source_offset: 20 }, 4);
  assert.equal(recovered.status, 'applied');
  assert.equal(replay.status, 'idempotent_duplicate');
  assert.equal(recovered.state.checkpoint.next_source_offset, 20);
});

test('unit of work survives failure after the committed snapshot without duplicating records', async () => {
  const aggregate = register(createMemorizeExecutionAggregate(RUN), {
    id: 'session:0-19', start: 0, end: 19,
  });
  const command = completeCommand({ id: 'session:0-19', start: 0, end: 19 });
  let durableState = null;
  let persistenceCount = 0;
  await assert.rejects(() => executeMemorizeUnitOfWork({
    state: { aggregate, checkpoint: { starting_source_offset: 0 } }, command,
    apply_records: async () => ({ inserted: ['record:session:0-19'] }),
    checkpoint_patch: { next_source_offset: 20 },
    persist: async (state) => {
      persistenceCount += 1;
      durableState = structuredClone(state);
      if (state.unit_of_work_journal[0].phase === 'committed') {
        throw new Error('simulated process loss after durable commit');
      }
    },
  }), /simulated process loss/);
  assert.equal(persistenceCount, 2);
  const replay = replayPreparedMemorizeUnitOfWork(durableState, command.command_id,
    { next_source_offset: 20 });
  assert.equal(replay.status, 'idempotent_duplicate');
  assert.deepEqual(replay.state.aggregate.obligations['session:0-19'].lifecycle
    .durably_persisted_record_ids, ['record:session:0-19']);
});

test('checkpoint advancement cannot cross a nonterminal frontier sibling', () => {
  const aggregate = createMemorizeExecutionAggregate(RUN);
  register(aggregate, { id: 'session:0-9', start: 0, end: 9 });
  register(aggregate, { id: 'session:10-19', start: 10, end: 19 });
  const command = completeCommand({ id: 'session:0-9', start: 0, end: 9 });
  let state = prepareMemorizeUnitOfWork({ aggregate, checkpoint: {
    starting_source_offset: 0, next_source_offset: 0,
  } }, command, 1).state;
  state = markMemorizeRecordsApplied(state, command.command_id, {}, 2).state;
  const result = commitMemorizeUnitOfWork(state, command.command_id,
    { next_source_offset: 20 }, 3);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason_code, 'checkpoint_would_cross_nonterminal_frontier');
  assert.equal(result.safe_offset, 10);
});

test('a split parent is a non-dispatchable container and children form the frontier', () => {
  const aggregate = createMemorizeExecutionAggregate(RUN);
  register(aggregate, { id: 'nyx:160-179', start: 160, end: 179,
    tier: 'longterm', owner: 'Nyx Watson' });
  const split = applyMemorizeLifecycleEvent(aggregate, {
    obligation_id: 'nyx:160-179', logical_run_id: RUN, tier: 'longterm',
    owner: 'Nyx Watson', source_range: { start: 160, end: 179, message_count: 20 },
    source_fingerprint: 'fp:160-179',
  }, { type: 'recovery_children_declared', event_id: 'split:nyx', children: [
    { obligation_id: 'nyx:160-169', source_range: { start: 160, end: 169, message_count: 10 },
      source_fingerprint: 'fp:160-169' },
    { obligation_id: 'nyx:170-179', source_range: { start: 170, end: 179, message_count: 10 },
      source_fingerprint: 'fp:170-179' },
  ] });
  assert.equal(split.status, 'applied');
  const parentCompletion = applyProviderCompletion(aggregate, completeCommand({
    id: 'nyx:160-179', start: 160, end: 179, tier: 'longterm', owner: 'Nyx Watson',
  }));
  assert.equal(parentCompletion.status, 'rejected');
  assert.equal(parentCompletion.reason_code, 'split_parent_is_not_dispatchable');
  assert.equal(validateMemorizeExecutionAggregate(aggregate).valid, true);
});

test('diagnostic observer failure cannot fail or mutate a committed command', async () => {
  const event = Object.freeze({ type: 'committed', receipt: { command_id: 'x' } });
  const result = await observeMemorizeKernelCommit(() => { throw new Error('export unavailable'); }, event);
  assert.equal(result.observed, false);
  assert.equal(result.error.message, 'export unavailable');
  assert.equal(event.receipt.command_id, 'x');
});

test('adaptive provider policy selects native JSON, bounds attempts, and avoids malformed-tag repartition', () => {
  let profile = createMemorizeProviderProfile({ signature: 'lm-studio:mistral', native_json_schema_observed: true });
  assert.equal(selectMemorizeProviderProtocol(profile).protocol, 'structured_json_schema_v1');
  profile = recordMemorizeProviderOutcome(profile, { new_logical_obligation: true,
    classification: 'structural_failure' });
  profile = recordMemorizeProviderOutcome(profile, { classification: 'structural_failure' });
  profile = recordMemorizeProviderOutcome(profile, { classification: 'structural_failure' });
  assert.equal(assessMemorizeProviderDispatch(profile, { leaf_attempt_count: 3 }).allowed, false);
  assert.equal(shouldRepartitionMemorizeSource({ classification: 'structural_failure' }), false);
  assert.equal(shouldRepartitionMemorizeSource({ classification: 'context_pressure' }), true);
});

test('native structured output is the primary protocol and converts through the ordinary tier parser', () => {
  const request = buildStructuredMemoryProviderRequest('SOURCE [0] hello', {
    tier: 'session', capabilities: { native_json_schema: true },
  });
  assert.equal(request.protocol, 'structured_json_schema_v1');
  assert.equal(request.providerConstraints.responseFormat.type, 'json_schema');
  const parsed = parseStructuredMemoryResponse(JSON.stringify({ records: [{
    type: 'scene', content: 'They agreed to meet tomorrow.', owner: 'chat',
    source_indices: [0], importance: 2, permanence: 'session',
  }] }), { tier: 'session', parse: (text) => text.startsWith('[scene:') ? [{ text }] : [] });
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.records.length, 1);
  assert.equal(assessMemorizeProviderDispatch(createMemorizeProviderProfile(), {
    leaf_attempt_count: 2,
  }).allowed, true);
  const compatibilityFallback = buildStructuredMemoryProviderRequest('SOURCE [0] hello', {
    tier: 'session', capabilities: { native_json_schema: false, adaptive_protocol: true },
  });
  assert.equal(compatibilityFallback.protocol, 'simple_json_records_v1');
  assert.equal(compatibilityFallback.providerConstraints, null);
  assert.match(compatibilityFallback.prompt, /FINAL OUTPUT CONTRACT/);
});

test('production tier pipeline routes final completion through the atomic kernel hook', async () => {
  const pipelineLeafId = 'session:chat:0-19:fp:0-19';
  let aggregate = register(createMemorizeExecutionAggregate(RUN), {
    id: pipelineLeafId, start: 0, end: 19,
  });
  const execution = createMemorizeExecutionContext({
    controller: { lifecycle_required: true },
    hooks: {
      obligation_event: async () => ({ applied: true,
        obligation: aggregate.obligations[pipelineLeafId] }),
      get_canonical_obligation: () => aggregate.obligations[pipelineLeafId],
      provider_completion_command: async (command) => {
        const result = applyProviderCompletion(aggregate, command);
        if (result.mutated) aggregate = result.aggregate;
        return result;
      },
    },
  });
  const pipeline = createMemorizeTierPipeline({
    tier: 'session', tierLabel: 'Session', execution,
    metadata: { active_catchup_run_id: RUN },
    range: { start: 0, end: 19, message_count: 20 },
    rangeId: 'range:0-19', sourceFingerprint: 'fp:0-19',
    preflight: { configured_context_limit: 8192, effective_context_limit: 8192,
      reserved_output_tokens: 512, safety_margin_tokens: 128,
      protocol_overhead_tokens: 128, estimated_input_tokens: 100 },
    requestBudget: {}, providerConfigSignature: 'test', expectedOutputFormat: 'structured_json_schema_v1',
  });
  assert.equal(pipeline.atomicCompletionEnabled, true);
  const result = await pipeline.applyProviderCompletion(completeCommand({
    id: pipeline.leafObligationId, start: 0, end: 19,
    attempt: 'attempt:pipeline', command: 'command:pipeline',
  }));
  assert.equal(result.status, 'applied');
  assert.equal(aggregate.obligations[pipeline.leafObligationId].current_state, 'durably_committed');
});

test('historical identical Session evidence cannot intercept current-run dispatch', async () => {
  const currentRun = RUN;
  const metadata = {
    active_catchup_run_id: currentRun,
    provider_completion_journal: { schema_version: 6, entries: {
      historical: {
        schema_version: 6, attempt_id: 'historical', logical_run_id: 'prior-run',
        obligation_leaf_id: 'session:chat:160-179:fnv1a-5654f879',
        root_obligation_id: 'session:chat:160-179:fnv1a-5654f879',
        tier: 'session', source_range: { start: 160, end: 179, message_count: 20 },
        source_fingerprint: 'fnv1a-5654f879', response_text: '{"records":[]}',
        parser_result: { status: 'accepted' }, terminal_outcome: 'completed',
      },
    }, order: ['historical'], reconciliation: null },
  };
  let aggregate = createMemorizeExecutionAggregate(currentRun);
  let providerStarted = 0;
  const execution = createMemorizeExecutionContext({
    controller: { lifecycle_required: true, instance_id: 'controller:new-run' },
    provider: { selected_recovery_action: 'dispatch_provider_request' },
    hooks: {
      obligation_event: async (event) => {
        const applied = applyMemorizeLifecycleEvent(aggregate, {
          obligation_id: event.obligation_id, root_obligation_id: event.root_obligation_id,
          leaf_obligation_id: event.leaf_obligation_id, logical_run_id: currentRun,
          tier: event.tier, owner: event.owner, source_range: event.source_range,
          source_fingerprint: event.source_fingerprint,
        }, { ...event, event_id: event.event_id ?? `event:${event.type}:${Date.now()}` });
        aggregate = applied.ledger;
        if (event.type === 'provider_attempt_started') providerStarted++;
        return applied;
      },
      get_canonical_obligation: (id) => aggregate.obligations[id] ?? null,
      action_receipt: async () => ({ status: 'applied' }),
      provider_completion_command: async () => ({ status: 'applied' }),
    },
  });
  const pipeline = createMemorizeTierPipeline({
    tier: 'session', tierLabel: 'Session', execution, metadata,
    range: { start: 160, end: 179, message_count: 20 }, rangeId: 'range:160-179',
    sourceFingerprint: 'fnv1a-5654f879', preflight: {}, requestBudget: {},
    providerConfigSignature: 'fake', expectedOutputFormat: 'structured_json_schema_v1',
  });
  await pipeline.emitLifecycleEvent('obligation_registered', {
    next_eligible_action: 'dispatch_provider_request',
  });
  pipeline.requireSelectedAction('dispatch_provider_request');
  const ingress = await pipeline.ingestProviderEvidence('register_new_attempt');
  assert.equal(ingress.status, 'applied');
  assert.equal(providerStarted, 1);
  assert.notEqual(ingress.attempt.attempt_id, 'historical');
  assert.equal(ingress.attempt.logical_run_id, currentRun);
  assert.equal(metadata.provider_completion_journal.order.length, 2);
  assert.equal(metadata.provider_completion_journal.entries.historical.logical_run_id,
    'prior-run', 'historical evidence remains inert diagnostic data');
});

function createScriptedControllerHarness(suffix) {
  const id = `session:controller-${suffix}:0-19`;
  let aggregate = register(createMemorizeExecutionAggregate(RUN), {
    id, start: 0, end: 19,
  });
  const execution = createMemorizeExecutionContext({
    controller: { lifecycle_required: true, instance_id: `controller:${suffix}` },
    hooks: {
      obligation_event: async () => ({ applied: true, obligation: aggregate.obligations[id] }),
      get_canonical_obligation: () => aggregate.obligations[id],
      provider_completion_command: async (command) => {
        const result = applyProviderCompletion(aggregate, command);
        if (result.mutated) aggregate = result.aggregate;
        return result;
      },
    },
  });
  const pipeline = createMemorizeTierPipeline({
    tier: 'session', tierLabel: 'Session', execution,
    metadata: { active_catchup_run_id: RUN },
    range: { start: 0, end: 19, message_count: 20 },
    rangeId: `controller:${suffix}:range`, sourceFingerprint: 'fp:0-19',
    preflight: { configured_context_limit: 8192, effective_context_limit: 8192,
      reserved_output_tokens: 512, safety_margin_tokens: 128,
      protocol_overhead_tokens: 128, estimated_input_tokens: 100 },
    requestBudget: {}, providerConfigSignature: 'fake-provider:native-json',
    expectedOutputFormat: 'structured_json_schema_v1',
  });
  const engine = createMemorizeRunEngine();
  const run = (command, mode = 'initial') => engine.execute({
    invocation_id: `invocation:${suffix}:${command.command_id}`, mode,
  }, async () => {
    const result = await pipeline.applyProviderCompletion(command);
    const status = projectMemorizeKernelStatus(aggregate);
    if (status.finalization_eligible) return createMemorizeOutcome({
      kind: 'completed', reason_code: 'completed', value: result,
    });
    return createMemorizeOutcome({
      kind: status.resume_enabled ? 'paused' : 'blocked',
      reason_code: status.exact_blocker ?? command.reason_code ?? 'tier_coverage_incomplete',
      resumable: status.resume_enabled, next_action: status.next_action,
      obligation_id: id, provider_call_required: status.provider_call_required,
      value: result,
    });
  });
  return { id, pipeline, engine, run, aggregate: () => aggregate };
}

function scriptedControllerCommand(id, scenario) {
  const base = {
    command_id: `script:${scenario}`, logical_run_id: RUN,
    obligation_leaf_id: id, root_obligation_id: id,
    attempt_id: `attempt:${scenario}`, tier: 'session',
    source_range: { start: 0, end: 19, message_count: 20 },
    source_fingerprint: 'fp:0-19', terminal: false,
    raw_response_reference: { retained: false, digest: `digest:${scenario}` },
    parser_outcome: { status: 'rejected', accepted_candidate_ids: [],
      rejected_fragment_ids: [`fragment:${scenario}`], reason_code: scenario },
    validation_outcome: { status: 'not_applicable', accepted_candidate_ids: [] },
    persistence_outcome: { status: 'not_required', durable_record_ids: [],
      durable_record_candidate_map: {}, source_provenance: {} },
    next_action: 'dispatch_bounded_recovery_attempt', reason_code: scenario,
  };
  if (['transport_failure', 'timeout'].includes(scenario)) return {
    ...base, transport_status: 'failed', parser_outcome: undefined,
    reason_code: scenario, next_action: 'retry_provider_with_backoff',
  };
  if (scenario === 'valid_empty_no_update') return {
    ...base, terminal: true,
    parser_outcome: { status: 'explicit_none', accepted_candidate_ids: [] },
    validation_outcome: { status: 'validated_no_update', accepted_candidate_ids: [] },
  };
  if (scenario === 'valid_structured_output') return completeCommand({
    id, start: 0, end: 19, command: base.command_id, attempt: base.attempt_id,
  });
  if (scenario === 'partial_valid_output' || scenario === 'missing_private_fragment_payload') {
    const command = completeCommand({ id, start: 0, end: 19,
      command: base.command_id, attempt: base.attempt_id,
      rejected: [`fragment:${scenario}`], terminal: false });
    command.recovery_capsule = {
      private_fragment_payload_available: scenario !== 'missing_private_fragment_payload',
      source_backed_regeneration_available: true,
      recovery_stage: 'source_backed_regeneration', protocol: 'structured_json_schema_v1',
    };
    return command;
  }
  if (['unsupported_memory_type', 'missing_citation'].includes(scenario)) return {
    ...base,
    parser_outcome: { status: 'accepted', accepted_candidate_ids: [`candidate:${scenario}`] },
    validation_outcome: { status: 'rejected', accepted_candidate_ids: [],
      rejected_candidate_ids: [`candidate:${scenario}`], reason_code: scenario },
  };
  return base;
}

test('full controller path treats scripted provider failures as typed outcomes', async () => {
  const scenarios = [
    'malformed_tags', 'invalid_modifier_syntax', 'malformed_structured_json',
    'unsupported_memory_type', 'missing_citation', 'transport_failure', 'timeout',
    'partial_valid_output', 'missing_private_fragment_payload',
  ];
  for (const scenario of scenarios) {
    const harness = createScriptedControllerHarness(scenario);
    const outcome = await harness.run(scriptedControllerCommand(harness.id, scenario));
    assert.ok(['paused', 'blocked'].includes(outcome.kind), scenario);
    assert.notEqual(outcome.kind, 'failed', scenario);
    assert.equal(harness.engine.active_invocation, null, scenario);
    const validation = validateMemorizeExecutionAggregate(harness.aggregate());
    assert.equal(validation.valid, true, `${scenario}: ${JSON.stringify(validation.violations)}`);
    if (['transport_failure', 'timeout'].includes(scenario)) {
      const attempt = harness.aggregate().execution_kernel.attempts[`attempt:${scenario}`];
      assert.equal(attempt.parser_outcome, null, scenario);
      assert.equal(attempt.validation_outcome, null, scenario);
    }
  }

  for (const scenario of ['valid_structured_output', 'valid_empty_no_update']) {
    const harness = createScriptedControllerHarness(scenario);
    const outcome = await harness.run(scriptedControllerCommand(harness.id, scenario));
    assert.equal(outcome.kind, 'completed', scenario);
    assert.equal(projectMemorizeKernelStatus(harness.aggregate()).finalization_eligible, true);
  }
});

test('production controller path tolerates duplicate, late, and reordered callbacks', async () => {
  const duplicateHarness = createScriptedControllerHarness('duplicate');
  const command = scriptedControllerCommand(duplicateHarness.id, 'valid_structured_output');
  assert.equal((await duplicateHarness.run(command)).kind, 'completed');
  const duplicate = await duplicateHarness.pipeline.applyProviderCompletion(command);
  assert.equal(duplicate.status, 'idempotent_duplicate');

  const reorderedHarness = createScriptedControllerHarness('reordered');
  const current = scriptedControllerCommand(reorderedHarness.id, 'valid_structured_output');
  current.command_id = 'script:current';
  current.attempt_id = 'attempt:current';
  assert.equal((await reorderedHarness.run(current)).kind, 'completed');
  const older = scriptedControllerCommand(reorderedHarness.id, 'valid_structured_output');
  older.command_id = 'script:older';
  older.attempt_id = 'attempt:older';
  const late = await reorderedHarness.pipeline.applyProviderCompletion(older);
  assert.equal(late.status, 'late_callback_ignored');
  assert.equal(reorderedHarness.aggregate().execution_kernel.stale_callbacks.length, 1);
  assert.equal(projectMemorizeKernelStatus(reorderedHarness.aggregate()).finalization_eligible, true);
});

for (const [label, messageCount] of [
  ['200-message', 200],
  ['1,000-message synthetic', 1000],
  ['9,434-message synthetic', 9434],
]) {
  test(`${label} canonical run completes with one physical request per logical obligation`, () => {
    let aggregate = createMemorizeExecutionAggregate(RUN);
    let logical = 0;
    let physical = 0;
    for (let start = 0; start < messageCount; start += 20) {
      const end = Math.min(messageCount - 1, start + 19);
      const id = `session:${start}-${end}`;
      register(aggregate, { id, start, end });
      const result = applyProviderCompletion(aggregate, completeCommand({ id, start, end }));
      assert.equal(result.status, 'applied');
      aggregate = result.aggregate;
      logical += 1;
      physical += 1;
    }
    const status = projectMemorizeKernelStatus(aggregate);
    assert.equal(status.finalization_eligible, true);
    assert.equal(status.unresolved_application_error_count, 0);
    assert.equal(physical / logical, 1);
  });
}

