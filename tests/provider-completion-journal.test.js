import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findReplayableProviderCompletion,
  inspectProviderCompletionConsistency,
  migrateTerminalProviderCompletions,
  recordProviderCompletion,
  reconcileImpossibleLiveHealth,
  replayProviderCompletion,
} from '../provider-completion-journal.js';
import {
  createRecoveryChildManifest,
  markRecoveryChildState,
  recoveryChildManifestComplete,
  registerRecoveryChildPlan,
} from '../recovery-child-coverage.js';

const attempt = (patch = {}) => ({
  attempt_id: 'provider-mvzlqkmi-342', logical_run_id: 'run-1',
  logical_obligation_id: 'longterm:lisette:220-239:root',
  root_obligation_id: 'longterm:lisette:220-239:root', tier: 'longterm', owner: 'Lisette Dumont',
  source_range: { start: 225, end: 229, message_count: 5 },
  source_fingerprint: 'fnv1a-629e21dd', terminal_outcome: 'completed', at: 1000,
  ...patch,
});

test('completion journal replays missing transitions once and never duplicates persisted records', async () => {
  const metadata = {};
  const entry = recordProviderCompletion(metadata, attempt(), {
    child_key: 'longterm:lisette:225-229:child', response_text: '[fact] retained',
    parser_result: { status: 'accepted', records: [{ id: 'candidate-1' }] },
  });
  let persistCalls = 0, manifestCalls = 0, ledgerCalls = 0, healthCalls = 0;
  const handlers = {
    persist: async () => { persistCalls++; return { verified: true, status: 'committed', durable_record_ids: ['record-1'] }; },
    applyManifest: async () => { manifestCalls++; return { status: 'applied_verified' }; },
    applyLedger: async () => { ledgerCalls++; return { status: 'applied_verified' }; },
    closeHealth: async () => { healthCalls++; return { status: 'applied_verified' }; },
  };
  assert.equal((await replayProviderCompletion(entry, handlers)).replayed, true);
  assert.equal((await replayProviderCompletion(entry, handlers)).replayed, true);
  assert.deepEqual([persistCalls, manifestCalls, ledgerCalls, healthCalls], [1, 1, 1, 1]);
  assert.deepEqual(entry.persistence.durable_record_ids, ['record-1']);
  assert.ok(entry.completed_at);
});

test('unverified records cannot complete the child', async () => {
  const entry = recordProviderCompletion({}, attempt(), {
    response_text: '[fact] retained', parser_result: { records: [{ id: 'candidate-1' }] },
  });
  const result = await replayProviderCompletion(entry, { persist: async () => ({ verified: false }) });
  assert.equal(result.replayed, false);
  assert.equal(result.reason, 'persistence_unverified');
  assert.equal(entry.manifest_transition.status, 'pending');
});

test('journal replay cannot self-verify live-health closure', async () => {
  const entry = recordProviderCompletion({}, attempt(), {
    response_text: '[fact] retained', parser_result: { records: [{ id: 'candidate-1' }] },
    persistence: { status: 'committed', durable_record_ids: ['record-1'] },
  });
  await replayProviderCompletion(entry, {
    applyManifest: async () => ({ status: 'applied_verified' }),
    applyLedger: async () => ({ status: 'applied_verified' }),
    closeHealth: async () => undefined,
  });
  assert.equal(entry.live_health_transition.status, 'pending_reconciliation');
});

test('terminal provider attempt plus unattempted child and provider_running ledger is diagnosed directly', () => {
  const metadata = {};
  const result = inspectProviderCompletionConsistency({
    metadata,
    provider_audit: { recent_attempts: [attempt()] },
    ledger: { obligations: { root: {
      obligation_id: 'longterm:lisette:220-239:root', current_state: 'provider_running',
      provider_attempt_lineage: ['provider-mvzlqkmi-342'],
    } } },
    child_manifests: { roots: { root: {
      root_obligation_id: 'longterm:lisette:220-239:root', children: { child: {
        key: 'longterm:lisette:225-229:child', source_fingerprint: 'fnv1a-629e21dd',
        source_range: { start: 225, end: 229 }, state: 'unattempted',
      } },
    } } },
    live_health: { recent_extraction_events: [] },
  });
  assert.equal(result.consistent, false);
  assert.ok(result.violations.some((item) => item.code === 'terminal_attempt_left_obligation_provider_running'
    && item.attempt_id === 'provider-mvzlqkmi-342'));
  assert.ok(result.violations.some((item) => item.code === 'completed_attempt_has_unattempted_manifest_child'
    && item.source_range.start === 225));
});

test('legacy terminal migration preserves evidence but refuses to invent unavailable provider output', () => {
  const metadata = {};
  const migrated = migrateTerminalProviderCompletions(metadata, { recent_attempts: [attempt()] },
    ['provider-mvzlqkmi-342']);
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].migration.provider_output_available, false);
  assert.equal(findReplayableProviderCompletion(metadata, {
    root_obligation_id: attempt().root_obligation_id, source_fingerprint: attempt().source_fingerprint,
  }), null);
});

test('live health impossible running combination is closed to pending child coverage', () => {
  const metadata = { live_memory_health: { recent_extraction_events: [{
    event_id: 'extract-1', tier: 'longterm', owner: 'Lisette Dumont', terminal_health: 'running',
    response_received: true, provider_outcome: 'not_started', parser_outcome: 'not_started',
    persistence: 'not_attempted',
  }] } };
  const repairs = reconcileImpossibleLiveHealth(metadata, { recent_attempts: [attempt()] }, 2000);
  assert.equal(repairs.length, 1);
  const event = metadata.live_memory_health.recent_extraction_events[0];
  assert.equal(event.terminal_health, 'pending_child_coverage');
  assert.equal(event.provider_outcome, 'terminal_response_pending_downstream_reconciliation');
});

test('0-239 post-provider interruption canary resumes 225-229 downstream then runs 230-239', async () => {
  let manifest = createRecoveryChildManifest({
    root_obligation_id: 'longterm:lisette:220-239:root', tier: 'longterm', owner: 'Lisette Dumont',
    root_source_range: { start: 220, end: 239, message_count: 20 }, root_source_fingerprint: 'root-fp',
  });
  manifest = registerRecoveryChildPlan(manifest, { children: [
    { key: '220-224', source_range: { start: 220, end: 224 }, source_fingerprint: 'fp-a' },
    { key: '225-229', source_range: { start: 225, end: 229 }, source_fingerprint: 'fnv1a-629e21dd' },
    { key: '230-239', source_range: { start: 230, end: 239 }, source_fingerprint: 'fp-c' },
  ] });
  manifest = markRecoveryChildState(manifest, '220-224', 'completed');
  const metadata = {};
  const entry = recordProviderCompletion(metadata, attempt(), {
    child_key: '225-229', response_text: '[fact] one\n[fact] two\n[event] three',
    parser_result: { status: 'accepted', records: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] },
  });
  let providerRequests = 0;
  await replayProviderCompletion(entry, {
    persist: async () => ({ verified: true, status: 'committed', durable_record_ids: ['r1', 'r2', 'r3'] }),
    applyManifest: async () => { manifest = markRecoveryChildState(manifest, '225-229', 'completed'); },
    applyLedger: async () => {}, closeHealth: async () => {},
  });
  assert.equal(providerRequests, 0, 'attempt 342 must not be transmitted again');
  assert.equal(manifest.children['225-229'].state, 'completed');
  providerRequests++;
  manifest = markRecoveryChildState(manifest, '230-239', 'completed');
  assert.equal(providerRequests, 1, 'only the unattempted sibling is transmitted');
  assert.equal(recoveryChildManifestComplete(manifest), true);
  assert.equal(entry.persistence.durable_record_ids.length, 3);
  const run = { contiguous_checkpoint: 80, traversal_progress: 200,
    recovery_backlog: ['session:chat:80-99:fnv1a-b86f4be8'], finalization_eligible: false };
  assert.deepEqual(run, { contiguous_checkpoint: 80, traversal_progress: 200,
    recovery_backlog: ['session:chat:80-99:fnv1a-b86f4be8'], finalization_eligible: false });
});

