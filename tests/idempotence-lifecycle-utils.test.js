import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIdempotenceLifecycleLedger } from '../idempotence-lifecycle-utils.js';

test('lifecycle ledger keeps automatic save, manual check, restore, and export on one durable hash when no state changes', () => {
  const state = { summary: 'stable', entityRegistry: [{ id: 'one' }] };
  const ledger = buildIdempotenceLifecycleLedger(['automatic_final', 'persisted_post_save', 'manual_preparation', 'manual_final', 'restored_panel', 'diagnostics_export'].map((stage) => ({ stage, owner: 'test', state })));
  assert.equal(new Set(ledger.checkpoints.map((entry) => entry.durable_hash)).size, 1);
  assert.equal(ledger.all_transitions_accounting_reconciled, true);
});

test('lifecycle ledger exposes an unaccounted semantic transition with bounded component paths', () => {
  const ledger = buildIdempotenceLifecycleLedger([{ stage: 'automatic_final', owner: 'automatic', state: { summary: 'before' } }, { stage: 'persisted_post_save', owner: 'persistence', state: { summary: 'after' } }]);
  assert.equal(ledger.transitions[0].equal, false);
  assert.equal(ledger.transitions[0].accounting_reconciled, false);
  assert.deepEqual(ledger.transitions[0].changed_components.map((item) => item.component), ['summary']);
});

test('an accounted persistence normalization stays visible rather than becoming metadata-only', () => {
  const ledger = buildIdempotenceLifecycleLedger([{ stage: 'automatic_final', owner: 'automatic', state: { sceneHistory: [] } }, { stage: 'persisted_post_save', owner: 'persistence', mutation_accounted: true, state: { sceneHistory: [{ id: 'scene-1', summary: 'x' }] } }]);
  assert.equal(ledger.transitions[0].equal, false);
  assert.equal(ledger.transitions[0].accounting_reconciled, true);
});
