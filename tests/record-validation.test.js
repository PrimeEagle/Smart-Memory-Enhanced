import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenConsolidationProvenance, isGeneratedRecordApproved, isRecordApprovedForPropagation, normalizeMemoryProvenance, prepareRecordForValidation, sanitizeStructuredModelOutput, validateGeneratedRecord, validateMemoryAncestry } from '../record-validation.js';

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

test('derived summaries cannot propagate before semantic verification', () => {
  assert.equal(isRecordApprovedForPropagation({ grounding_status: 'derived', validation_status: 'pending_verification', semantic_support: 'not_checked' }), false);
  assert.equal(isRecordApprovedForPropagation({ grounding_status: 'derived', validation_status: 'validated', semantic_support: 'supported' }), true);
  assert.equal(isRecordApprovedForPropagation({ grounding_status: 'derived', validation_status: 'needs_review', semantic_support: 'unsupported' }), false);
});

test('preparation maps chunk-relative sources before validation and clears stale missing-source errors', () => {
  const memory = {
    id: 'memory-1914',
    source_message_indices: [2, 0, 2],
    validation_status: 'needs_review',
    validation_issues: ['No source messages were supplied.'],
  };
  const result = prepareRecordForValidation(memory, {
    originalMessageIndices: [1912, 1913, 1914],
    sourceLength: 3,
    indicesAreRelative: true,
    chatLength: 2000,
  });
  assert.equal(result.valid, true);
  assert.deepEqual(memory.source_message_indices, [1912, 1914]);
  assert.deepEqual(memory.source_messages, [[1912, 1912], [1914, 1914]]);
  assert.equal(memory.validation_status, 'validated');
  assert.deepEqual(memory.validation_issues, []);
});

test('preparation rejects out-of-window chunk claims rather than treating them as absolute chat indices', () => {
  const memory = { id: 'memory-invalid', source_message_indices: [9] };
  const result = prepareRecordForValidation(memory, { sourceLength: 3, indicesAreRelative: true });
  assert.equal(result.valid, false);
  assert.deepEqual(memory.source_message_indices, []);
  assert.match(memory.validation_issues.join(' '), /outside this extraction chunk/);
});

test('consolidation flattens discarded candidate parents into source evidence', () => {
  const source = { id: 'temporary-source', source_message_indices: [10, 11], parent_memory_ids: [] };
  const result = { id: 'final-memory', source_message_indices: [], parent_memory_ids: ['temporary-source'] };
  flattenConsolidationProvenance(result, [source], [result]);
  assert.deepEqual(result.source_message_indices, [10, 11]);
  assert.deepEqual(result.parent_memory_ids, []);
  assert.equal(validateGeneratedRecord(result, { parentStore: [result] }).valid, true);
});
