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

test('targeted replay refuses stale source fingerprints and unsupported tiers', () => {
  const candidates = buildTargetedReplayCandidates({ terminal_unresolved_obligations: [
    { ...obligation, source_fingerprint: 'fnv1a-stale' },
    { ...obligation, tier: 'session', root_obligation_id: 'session:chat:10-19' },
  ] }, { chat, chatId: 'chat-a' });
  assert.equal(candidates[0].eligible, false);
  assert.ok(candidates[0].rejection_reasons.includes('source_fingerprint_mismatch'));
  assert.equal(candidates[1].eligible, false);
  assert.ok(candidates[1].rejection_reasons.includes('unsupported_tier'));
});

test('targeted replay rejects a known provider-configuration mismatch but labels legacy evidence honestly', () => {
  const [changed, legacy] = buildTargetedReplayCandidates({ terminal_unresolved_obligations: [
    { ...obligation, configuration_signature: 'config-old' },
    { ...obligation, root_obligation_id: 'legacy-obligation' },
  ] }, { chat, chatId: 'chat-a', configurationSignature: 'config-current' });
  assert.equal(changed.eligible, false);
  assert.ok(changed.rejection_reasons.includes('provider_configuration_changed'));
  assert.equal(legacy.eligible, true);
  assert.equal(legacy.configuration_validation, 'unavailable_for_legacy_obligation');
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
  checkpoint.status = 'completed';
  const summary = summarizeTargetedReplayCheckpoint(checkpoint);
  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.added_memories, 2);
  assert.equal(summary.targets[0].attempts, 1);
});
