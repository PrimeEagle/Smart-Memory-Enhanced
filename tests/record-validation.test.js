import test from 'node:test';
import assert from 'node:assert/strict';
import { isGeneratedRecordApproved, normalizeMemoryProvenance, sanitizeStructuredModelOutput, validateGeneratedRecord, validateMemoryAncestry } from '../record-validation.js';

test('provenance normalization expands legacy ranges without false missing-source errors', () => {
  const memory = { source_messages: [[2001, 2003]], source_message_indices: [] };
  const result = normalizeMemoryProvenance(memory, { chatLength: 3000 });
  assert.deepEqual(result.indices, [2001, 2002, 2003]);
  assert.deepEqual(memory.source_messages, [[2001, 2003]]);
});

test('ancestry validation rejects self parents and longer cycles', () => {
  assert.equal(validateMemoryAncestry('A', ['A'], []).valid, false);
  const cycle = validateMemoryAncestry('A', ['B'], [{ id: 'B', parent_memory_ids: ['C'] }, { id: 'C', parent_memory_ids: ['A'] }]);
  assert.equal(cycle.valid, false);
  assert.match(cycle.issues.join(' '), /cycle/);
});

test('structured sanitizer removes list markdown and separates inline epistemic retirement', () => {
  assert.equal(sanitizeStructuredModelOutput('1. **Alissa -> Paul: warm(high)**', 'relationship'), 'Alissa -> Paul: warm(high)');
  assert.match(sanitizeStructuredModelOutput("[knows] Alissa | She understands Kyle (retires [24])", 'epistemic'), /\[retire\] 24/);
});

test('shared cross-tier validation quarantines source-less generated records and permits derived evidence', () => {
  const unsupported = { id: 'arc-1', parent_memory_ids: [] };
  assert.equal(validateGeneratedRecord(unsupported).valid, false);
  assert.equal(isGeneratedRecordApproved(unsupported), false);

  const parent = { id: 'memory-1', parent_memory_ids: [] };
  const derived = { id: 'profile-1', parent_memory_ids: ['memory-1'] };
  assert.equal(validateGeneratedRecord(derived, { allowDerived: true, parentStore: [parent] }).valid, true);
  assert.equal(derived.grounding_status, 'derived');
});
