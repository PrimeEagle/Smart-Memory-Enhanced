import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMultiOwnerLongtermPrompt,
  partitionMultiOwnerLongtermResponse,
} from '../multi-owner-longterm.js';

const owners = ['A', 'B', 'C', 'D', 'E', 'F'];

test('six-owner response partitions locally with explicit no-update owners', () => {
  const result = partitionMultiOwnerLongtermResponse(JSON.stringify({ records: [
    { owner: 'A', type: 'fact', content: 'A owns a bicycle.', source_indices: [2] },
    { owner: 'B', type: 'goal', content: 'B plans a trip.', source_indices: [3] },
  ], no_update_owners: ['C', 'D', 'E', 'F'] }), {
    allowed_owners: owners, source_indices: [0, 1, 2, 3],
  });
  assert.equal(result.status, 'accepted');
  assert.equal(result.partitions.A.length, 1);
  assert.equal(result.partitions.B.length, 1);
  assert.deepEqual(result.targeted_recovery_owners, []);
});

test('unknown, ungrounded, and mixed-owner duplicates are quarantined', () => {
  const result = partitionMultiOwnerLongtermResponse(JSON.stringify({ records: [
    { owner: 'Unknown', type: 'fact', content: 'x', source_indices: [0] },
    { owner: 'A', type: 'fact', content: 'missing' },
    { owner: 'A', type: 'fact', content: 'shared', source_indices: [1] },
    { owner: 'B', type: 'fact', content: 'shared', source_indices: [1] },
    { owner: 'C', type: 'fact', content: 'outside', source_indices: [99] },
  ], no_update_owners: [] }), { allowed_owners: owners, source_indices: [0, 1] });
  assert.equal(result.accepted_record_count, 0);
  assert.deepEqual(new Set(result.rejected.map((item) => item.reason_code)), new Set([
    'unknown_owner', 'missing_source_provenance', 'cross_owner_duplicate_assignment',
    'source_provenance_outside_window',
  ]));
  assert.deepEqual(result.targeted_recovery_owners, owners);
});

test('prompt contains the full owner list and a one-owner-per-record contract', () => {
  const prompt = buildMultiOwnerLongtermPrompt('SOURCE', owners);
  for (const owner of owners) assert.match(prompt, new RegExp(`"${owner}"`));
  assert.match(prompt, /exactly one per record/);
});
