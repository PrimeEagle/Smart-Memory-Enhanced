import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceWindowFingerprint } from '../extraction-window-utils.js';
import {
  buildTargetedReplayCandidates, createTargetedReplayCheckpoint,
  updateTargetedReplayCheckpoint, summarizeTargetedReplayCheckpoint,
} from '../targeted-replay-utils.js';

const chat = Array.from({ length: 30 }, (_, index) => ({ name: index % 2 ? 'Aster' : 'User', mes: `message ${index}` }));
const window = chat.slice(10, 20).map((message, offset) => ({ ...message, __sme_original_index: 10 + offset }));
const obligation = {
  tier: 'longterm', owner: 'Aster Graves', source_range: { start: 10, end: 19, message_count: 10 },
  source_fingerprint: sourceWindowFingerprint(window), root_obligation_id: 'longterm:aster:10-19',
  configuration_signature: 'config-a',
  targeted_replay_eligible: true, prior_authoritative_memory_preserved: true,
  malformed_reason: 'missing_required_top_level_structure',
};

test('targeted replay validates exact current source identity without exposing text in its checkpoint', () => {
  const [candidate] = buildTargetedReplayCandidates({ terminal_unresolved_obligations: [obligation] }, {
    chat, chatId: 'chat-a', configurationSignature: 'config-a',
  });
  assert.equal(candidate.eligible, true);
  assert.equal(candidate.source_messages.length, 10);
  const checkpoint = createTargetedReplayCheckpoint([candidate], { chatId: 'chat-a', configurationSignature: 'config-a' });
  assert.equal(JSON.stringify(checkpoint).includes('message 10'), false);
  assert.deepEqual(checkpoint.targets[0].source_range, { start: 10, end: 19, message_count: 10 });
});

test('targeted replay refuses stale source fingerprints while supporting session parity', () => {
  const candidates = buildTargetedReplayCandidates({ terminal_unresolved_obligations: [
    { ...obligation, source_fingerprint: 'fnv1a-stale' },
    { ...obligation, tier: 'session', root_obligation_id: 'session:chat:10-19' },
  ] }, { chat, chatId: 'chat-a', configurationSignature: 'config-a' });
  assert.equal(candidates[0].eligible, false);
  assert.ok(candidates[0].rejection_reasons.includes('source_fingerprint_mismatch'));
  assert.equal(candidates[1].eligible, true);
  assert.equal(candidates[1].owner, 'Aster Graves');
});

test('session replay does not require an owner while unknown tiers remain unsupported', () => {
  const [session, unknown] = buildTargetedReplayCandidates({ terminal_unresolved_obligations: [
    { ...obligation, tier: 'session', owner: null, root_obligation_id: 'session:chat:10-19' },
    { ...obligation, tier: 'profile', owner: null, root_obligation_id: 'profile:chat:10-19' },
  ] }, { chat, chatId: 'chat-a', configurationSignature: 'config-a' });
  assert.equal(session.eligible, true);
  assert.equal(unknown.eligible, false);
  assert.ok(unknown.rejection_reasons.includes('unsupported_tier'));
});

test('tier-specific configuration signatures validate Session independently from Long-Term', () => {
  const [session] = buildTargetedReplayCandidates({ terminal_unresolved_obligations: [
    { ...obligation, tier: 'session', owner: null, configuration_signature: 'session-config' },
  ] }, { chat, chatId: 'chat-a', configurationSignature: {
    longterm: 'longterm-config', session: 'session-config',
  } });
  assert.equal(session.eligible, true);
  assert.equal(session.configuration_signature, 'session-config');
});

test('targeted replay rejects changed or missing provider configuration evidence', () => {
  const [changed, unsigned] = buildTargetedReplayCandidates({ terminal_unresolved_obligations: [
    { ...obligation, configuration_signature: 'config-old' },
    { ...obligation, root_obligation_id: 'unsigned-obligation', configuration_signature: null },
  ] }, { chat, chatId: 'chat-a', configurationSignature: 'config-current' });
  assert.equal(changed.eligible, false);
  assert.ok(changed.rejection_reasons.includes('provider_configuration_changed'));
  assert.equal(unsigned.eligible, false);
  assert.ok(unsigned.rejection_reasons.includes('configuration_signature_missing'));
  assert.equal(unsigned.configuration_validation, 'configuration_not_verified');
});

test('old targeted replay checkpoints fail closed instead of migrating', () => {
  assert.throws(() => createTargetedReplayCheckpoint([], {
    chatId: 'chat-a', configurationSignature: 'config-a',
    prior: { schema_version: 2, status: 'in_progress' },
  }), { code: 'SME_FRESH_START_REQUIRED' });
});

test('targeted replay checkpoint is restart-safe and summarizes one/all outcomes', () => {
  const [candidate] = buildTargetedReplayCandidates({ terminal_unresolved_obligations: [obligation] }, {
    chat, chatId: 'chat-a', configurationSignature: 'config-a',
  });
  let checkpoint = createTargetedReplayCheckpoint([candidate], { chatId: 'chat-a', configurationSignature: 'config-a' });
  checkpoint = updateTargetedReplayCheckpoint(checkpoint, candidate.root_obligation_id, {
    terminal_outcome: 'running', attempted: true,
  });
  const restored = JSON.parse(JSON.stringify(checkpoint));
  checkpoint = updateTargetedReplayCheckpoint(restored, candidate.root_obligation_id, {
    terminal_outcome: 'completed', added_memories: 2,
  });
  assert.equal(Object.hasOwn(checkpoint.targets[0], 'attempted'), false);
  checkpoint.status = 'completed';
  const summary = summarizeTargetedReplayCheckpoint(checkpoint);
  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.added_memories, 2);
  assert.equal(summary.targets[0].attempts, 1);
});

test('restored in-flight targeted replay reuses its invocation and never duplicates a committed target', () => {
  const [candidate] = buildTargetedReplayCandidates({ terminal_unresolved_obligations: [obligation] }, {
    chat, chatId: 'chat-a', configurationSignature: 'config-a',
  });
  let prior = createTargetedReplayCheckpoint([candidate], {
    chatId: 'chat-a', configurationSignature: 'config-a', originalRunId: 'run-original', now: 100,
  });
  prior = updateTargetedReplayCheckpoint(prior, candidate.root_obligation_id, {
    terminal_outcome: 'running', attempted: true, provider_outcome: 'in_progress',
  }, 101);
  const resumed = createTargetedReplayCheckpoint([candidate], {
    chatId: 'chat-a', configurationSignature: 'config-a', prior, originalRunId: 'run-original', now: 200,
  });
  assert.equal(resumed.replay_run_id, prior.replay_run_id);
  assert.equal(resumed.invocation_count, 2);
  assert.equal(resumed.targets[0].terminal_outcome, 'pending');
  assert.equal(resumed.targets[0].restored_in_flight_as_pending, true);
  assert.equal(resumed.targets[0].attempts, 1);
});
