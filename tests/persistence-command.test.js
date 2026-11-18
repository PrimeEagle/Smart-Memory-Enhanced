import test from 'node:test';
import assert from 'node:assert/strict';

import { preparePersistenceCommand } from '../persistence-command.js';

const command = (overrides = {}) => ({
  command_id: 'command-1', logical_run_id: 'run-1', workflow_id: 'run-1',
  obligation_leaf_id: 'scenes:global', attempt_id: 'attempt-1',
  execution_scope: 'independent_workflow', tier: 'scenes', owner: null,
  controller_identity: { instance_id: 'feature-controller:scenes',
    page_instance_id: 'page-1', cancellation_epoch: 0 },
  transaction_identity: { transaction_id: 'transaction-1', generation: 1 },
  work_item_id: 'scenes:global', source_range: { start: 4, end: 5 },
  source_fingerprint: 'fnv1a-source',
  parser_outcome: { status: 'accepted', accepted_candidate_ids: ['candidate-1'] },
  validation_outcome: { status: 'accepted', accepted_candidate_ids: ['candidate-1'] },
  persistence_outcome: {
    status: 'committed', durable_record_ids: ['scene-1'],
    durable_record_candidate_map: { 'scene-1': 'candidate-1' },
    source_provenance: { source_indices: [4, 5] },
  },
  durable_records: [{ record_id: 'scene-1', candidate_id: 'candidate-1',
    source_provenance: { source_indices: [4, 5] }, idempotency_key: 'scene-1:write' }],
  idempotency_keys: ['command-1', 'scene-1:write'],
  intended_state_transition: 'durably_committed',
  checkpoint_effect: { feature: 'scenes' }, journal_receipt_identity: 'command-1',
  ...overrides,
});

test('persistence commands are recursively immutable after validation', () => {
  const prepared = preparePersistenceCommand(command());
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.persistence_outcome), true);
  assert.equal(Object.isFrozen(prepared.durable_records[0]), true);
});

test('a rejected validation outcome cannot produce a durable write', () => {
  assert.throws(() => preparePersistenceCommand(command({
    validation_outcome: { status: 'rejected', accepted_candidate_ids: [],
      rejected_candidate_ids: ['candidate-1'] },
  })), { code: 'SME_DURABLE_RECORD_VALIDATION_MAPPING_REQUIRED' });
});

test('duplicate durable ids and extraneous mappings fail before mutation', () => {
  assert.throws(() => preparePersistenceCommand(command({
    persistence_outcome: {
      status: 'committed', durable_record_ids: ['scene-1', 'scene-1'],
      durable_record_candidate_map: { 'scene-1': 'candidate-1' },
      source_provenance: { source_indices: [4, 5] },
    },
  })), { code: 'SME_PERSISTENCE_COMMAND_DUPLICATE_RECORD_ID' });
  assert.throws(() => preparePersistenceCommand(command({
    persistence_outcome: {
      status: 'committed', durable_record_ids: ['scene-1'],
      durable_record_candidate_map: {
        'scene-1': 'candidate-1', 'scene-outside-receipt': 'candidate-1',
      }, source_provenance: { source_indices: [4, 5] },
    },
  })), { code: 'SME_DURABLE_RECORD_MAPPING_EXTRANEOUS' });
});
