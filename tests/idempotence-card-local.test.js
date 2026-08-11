import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCardLocalMemoryChanges } from '../idempotence-utils.js';

test('card-local diff identifies the nested durable leaf without exposing memory text', () => {
  const before = { card_local_memories: { Alpha: [{ id: 'm-1', content: 'private', entities: ['one'] }] } };
  const after = { card_local_memories: { Alpha: [{ id: 'm-1', content: 'private', entities: ['two'] }] } };
  const result = summarizeCardLocalMemoryChanges(before, after);
  assert.equal(result.changed, true);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].logical_record_fingerprint, 'memory:m-1');
  assert.deepEqual(result.records[0].changed_fields.map((field) => field.canonical_field_path), ['entities[0]']);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('card-local diff distinguishes one changed scope from an unchanged scope', () => {
  const before = { card_local_memories: { Alpha: [{ id: 'm-1', entities: ['one'] }], Beta: [{ id: 'm-2', entities: ['two'] }] } };
  const after = { card_local_memories: { Alpha: [{ id: 'm-1', entities: ['three'] }], Beta: [{ id: 'm-2', entities: ['two'] }] } };
  const result = summarizeCardLocalMemoryChanges(before, after);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].logical_record_fingerprint, 'memory:m-1');
});

test('an empty card-local comparison is already accounting-reconciled', () => {
  const state = { card_local_memories: { Alpha: [{ id: 'm-1', entities: ['one'] }] } };
  const result = summarizeCardLocalMemoryChanges(state, structuredClone(state));
  assert.equal(result.changed, false);
  assert.equal(result.total, 0);
  assert.equal(result.accounting_reconciled, true);
});
