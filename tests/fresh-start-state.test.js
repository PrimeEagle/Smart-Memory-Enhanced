import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEMORIZE_FRESH_START_METADATA_KEYS,
  resetMemorizeRunMetadata,
} from '../fresh-start-state.js';

test('Fresh Start removes every Memorize run-state key and preserves unrelated chat data', () => {
  const metadata = Object.fromEntries(MEMORIZE_FRESH_START_METADATA_KEYS
    .map((key) => [key, { stale: true }]));
  metadata.summary = 'owned by the short-term store';
  metadata.custom_chat_value = 42;

  const result = resetMemorizeRunMetadata(metadata);

  assert.deepEqual(result.deleted_keys, [...MEMORIZE_FRESH_START_METADATA_KEYS]);
  for (const key of MEMORIZE_FRESH_START_METADATA_KEYS) {
    assert.equal(Object.hasOwn(metadata, key), false, `${key} must be removed`);
  }
  assert.equal(metadata.summary, 'owned by the short-term store');
  assert.equal(metadata.custom_chat_value, 42);
});

test('Fresh Start reset rejects invalid metadata instead of silently doing nothing', () => {
  for (const value of [null, [], 'metadata']) {
    assert.throws(() => resetMemorizeRunMetadata(value), {
      code: 'SME_FRESH_START_METADATA_REQUIRED',
    });
  }
});
