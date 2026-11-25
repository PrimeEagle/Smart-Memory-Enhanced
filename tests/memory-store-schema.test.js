import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION } from '../constants.js';
import { assertCurrentMemoryRecord, assertCurrentMemoryStore, createCurrentMemoryStore }
  from '../memory-store-schema.js';

test('new character and chat stores are stamped with the current schema', () => {
  for (const kind of ['character', 'chat']) {
    const store = createCurrentMemoryStore(kind, { retained: true });
    assert.equal(store.schema_version, SCHEMA_VERSION);
    assert.equal(store.retained, true);
    assert.equal(assertCurrentMemoryStore(store, kind), store);
  }
});

test('old, missing, malformed, and runtime-bearing stores fail before use', () => {
  for (const store of [null, {}, { schema_version: SCHEMA_VERSION - 1 },
    { schema_version: SCHEMA_VERSION, callback: () => {} }]) {
    assert.throws(() => assertCurrentMemoryStore(store, 'chat'), (error) =>
      error?.code === 'SME_FRESH_START_REQUIRED'
      || error?.code === 'SME_NON_SERIALIZABLE_DOMAIN_DATA');
  }
});

test('store construction rejects runtime data and unknown store kinds', () => {
  assert.throws(() => createCurrentMemoryStore('chat', { pending: undefined }),
    { code: 'SME_NON_SERIALIZABLE_DOMAIN_DATA' });
  assert.throws(() => createCurrentMemoryStore('unknown'),
    { code: 'SME_INVALID_MEMORY_STORE_KIND' });
});

test('memory records require durable identity and current consolidation state', () => {
  const record = { id: 'memory-1', type: 'fact', content: 'Grounded fact.',
    ts: 1, consolidated: false };
  assert.equal(assertCurrentMemoryRecord(record, 'longterm'), record);
  for (const invalid of [
    { ...record, id: null }, { ...record, ts: null },
    { ...record, consolidated: undefined }, { ...record, content: '' },
  ]) assert.throws(() => assertCurrentMemoryRecord(invalid, 'session'),
    (error) => error.code === 'SME_FRESH_START_REQUIRED'
      && error.sme_reason_code === 'session_memory_record_schema_unsupported');
});
