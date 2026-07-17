import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDirectProvenance, isGrounded } from '../grounding.js';

test('grounding: valid citations become direct provenance with absolute message ranges', () => {
  const memories = [{ content: 'The gate is locked.', source_message_indices: [0, 2] }];
  applyDirectProvenance(memories, [{}, {}, {}], 14);

  assert.equal(memories[0].grounding_status, 'direct');
  assert.equal(memories[0].validation_status, 'validated');
  assert.deepEqual(memories[0].source_message_indices, [0, 2]);
  assert.deepEqual(memories[0].source_messages, [[14, 14], [16, 16]]);
  assert.equal(isGrounded(memories[0]), true);
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

test('grounding: duplicated citations are treated as malformed rather than silently accepted', () => {
  const memories = [{ content: 'The gate is locked.', source_message_indices: [0, 0] }];
  applyDirectProvenance(memories, [{}], 0);
  assert.equal(memories[0].validation_status, 'needs_review');
  assert.match(memories[0].validation_issues[0], /outside this extraction chunk/);
});

test('grounding: an explicitly approved quarantined memory is injectable', () => {
  assert.equal(isGrounded({ grounding_status: 'ungrounded', validation_status: 'approved' }), true);
});
