import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDirectProvenance, isGrounded, validateCitationSemanticSupport, validateGeneratedMemoryRecord } from '../grounding.js';

test('grounding: valid citations become direct provenance with absolute message ranges', () => {
  const memories = [{ content: 'The gate is locked.', source_message_indices: [0, 2] }];
  applyDirectProvenance(memories, [{}, {}, {}], 14);

  assert.equal(memories[0].grounding_status, 'direct');
  assert.equal(memories[0].validation_status, 'validated');
  assert.deepEqual(memories[0].source_message_indices, [14, 16]);
  assert.deepEqual(memories[0].source_messages, [[14, 14], [16, 16]]);
  assert.equal(isGrounded(memories[0]), true);
});

test('grounding: filtered catch-up messages retain their original chat indices', () => {
  const memories = [{ content: 'The gate is locked.', source_message_indices: [0, 1] }];
  applyDirectProvenance(memories, [{}, {}], 0, [2001, 2003]);
  assert.deepEqual(memories[0].source_message_indices, [2001, 2003]);
  assert.deepEqual(memories[0].source_messages, [[2001, 2001], [2003, 2003]]);
});

test('grounding: missing or malformed citations are quarantined for review', () => {
  const memories = [
    { content: 'Unsupported claim.' },
    { content: 'Partly unsupported claim.', source_message_indices: [0, 4] },
  ];
  applyDirectProvenance(memories, [{}, {}], 0);

  for (const memory of memories) {
    assert.equal(memory.grounding_status, 'ungrounded');
    assert.equal(memory.validation_status, 'needs_review');
    assert.deepEqual(memory.source_messages, []);
    assert.equal(isGrounded(memory), false);
  }
});

test('grounding: duplicated citations are normalized rather than creating competing provenance', () => {
  const memories = [{ content: 'The gate is locked.', source_message_indices: [0, 0] }];
  applyDirectProvenance(memories, [{}], 0);
  assert.equal(memories[0].validation_status, 'validated');
  assert.deepEqual(memories[0].source_message_indices, [0]);
});

test('grounding: cited source with no meaningful support is quarantined', () => {
  const memory = { content: 'The crystal is hidden beneath the bridge.', source_message_indices: [0] };
  applyDirectProvenance([memory], [{ mes: 'Mara quietly closes the tavern door.' }], 0);
  assert.equal(memory.validation_status, 'needs_review');
  assert.match(memory.validation_issues.join(' '), /no meaningful term overlap/i);
});

test('grounding: overlapping cited terms remain approved without pretending to prove the claim', () => {
  const memory = { content: 'Mara hides the crystal beneath the bridge.' };
  const result = validateCitationSemanticSupport(memory, [{ mes: 'Mara takes the crystal toward the bridge.' }]);
  assert.equal(result.supported, true);
  assert.equal(memory.validation_status, undefined);
});

test('grounding: an explicitly approved quarantined memory is injectable', () => {
  assert.equal(isGrounded({ grounding_status: 'ungrounded', validation_status: 'approved' }), true);
});

test('grounding: self-parent ancestry is removed and quarantined before persistence', () => {
  const memory = { id: 'A', parent_memory_ids: ['A'], source_message_indices: [4] };
  validateGeneratedMemoryRecord(memory, []);
  assert.deepEqual(memory.parent_memory_ids, []);
  assert.equal(memory.validation_status, 'needs_review');
  assert.match(memory.validation_issues.join(' '), /cannot list itself/);
});
