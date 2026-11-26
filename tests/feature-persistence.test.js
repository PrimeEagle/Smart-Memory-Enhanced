import test from 'node:test';
import assert from 'node:assert/strict';

import { executeFeaturePersistence, prepareFeaturePersistenceCommand }
  from '../feature-persistence.js';

test('feature persistence validates, applies, persists, and records one receipt', async () => {
  const metadata = { scenes: [] };
  const record = Object.freeze({ id: 'scene-1', summary: 'A grounded scene.', source_message_indices: [1, 2] });
  const command = prepareFeaturePersistenceCommand({
    workflow_id: 'chat-1', feature: 'scenes', records: [record],
  });
  let persisted = 0;
  const result = await executeFeaturePersistence({
    command, snapshot: () => structuredClone(metadata.scenes),
    apply: () => { metadata.scenes = [record]; },
    persist: () => { persisted += 1; },
    restore: (before) => { metadata.scenes = before; }, receipt_container: metadata,
  });
  assert.equal(result.status, 'committed');
  assert.equal(persisted, 1);
  assert.equal(metadata.scenes[0].candidate_identity, undefined);
  assert.equal(result.command.persistence_outcome.durable_record_candidate_map['scene-1'],
    command.durable_records[0].candidate_id);
  assert.equal(metadata.durable_persistence_receipts.length, 1);
});

test('feature persistence restores domain state and receipts after storage failure', async () => {
  const metadata = { scenes: [{ id: 'old' }], durable_persistence_receipts: [
    { command_id: 'older-command' },
  ] };
  const record = { id: 'scene-1', source_message_indices: [1] };
  const command = prepareFeaturePersistenceCommand({
    workflow_id: 'chat-1', feature: 'scenes', records: [record],
  });
  await assert.rejects(() => executeFeaturePersistence({
    command, snapshot: () => structuredClone(metadata.scenes),
    apply: () => { metadata.scenes = [record]; },
    persist: () => { throw new Error('disk unavailable'); },
    restore: (before) => { metadata.scenes = before; }, receipt_container: metadata,
  }), (error) => error.sme_reason_code === 'feature_persistence_storage_failure');
  assert.deepEqual(metadata.scenes, [{ id: 'old' }]);
  assert.deepEqual(metadata.durable_persistence_receipts, [{ command_id: 'older-command' }]);
});

test('feature persistence receipts are idempotent and bounded', async () => {
  const metadata = { durable_persistence_receipts: Array.from({ length: 128 }, (_, index) =>
    ({ command_id: `old-${index}` })) };
  const record = { id: 'profile-1' };
  const command = prepareFeaturePersistenceCommand({
    workflow_id: 'chat-1', feature: 'profiles', records: [record],
  });
  const run = () => executeFeaturePersistence({
    command, snapshot: () => null, apply: () => {}, persist: () => {},
    restore: () => {}, receipt_container: metadata,
  });
  await run();
  await run();
  assert.equal(metadata.durable_persistence_receipts.length, 128);
  assert.equal(metadata.durable_persistence_receipts.filter(
    (item) => item.command_id === command.command_id).length, 1);
});

test('an empty replacement is a durable clear rather than an explicit no-update', async () => {
  const metadata = { records: [{ id: 'old' }] };
  const command = prepareFeaturePersistenceCommand({
    workflow_id: 'chat-1', feature: 'profiles', operation: 'clear_profiles', records: [],
  });
  assert.equal(command.persistence_outcome.status, 'committed');
  assert.equal(command.intended_state_transition, 'durably_committed');
  assert.equal(command.duplicate_no_update_disposition, 'clear_validated_domain_snapshot');
  await executeFeaturePersistence({
    command, snapshot: () => structuredClone(metadata.records),
    apply: () => { metadata.records = []; }, persist: () => {},
    restore: (before) => { metadata.records = before; }, receipt_container: metadata,
  });
  assert.deepEqual(metadata.records, []);
  assert.equal(metadata.durable_persistence_receipts.at(-1).durable_record_count, 0);
});
