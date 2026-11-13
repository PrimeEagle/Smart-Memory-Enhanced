import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertMemorizeActionSelected,
  canonicalizeMemorizeAction,
  dispatchMemorizeAction,
} from '../memorize-action-dispatcher.js';

test('legacy provider recovery labels collapse to one dispatch action', () => {
  assert.equal(canonicalizeMemorizeAction('resume_exact_obligation'),
    'dispatch_provider_request');
  assert.equal(assertMemorizeActionSelected({ selected_action: 'resume_exact_obligation',
    requested_action: 'dispatch_provider_request' }), 'dispatch_provider_request');
  assert.equal(canonicalizeMemorizeAction('continue_pending_downstream_processing'),
    'apply_journaled_provider_completion');
});

test('dispatcher rejects a tier action that differs from the kernel action', async () => {
  let called = false;
  const result = await dispatchMemorizeAction({
    logical_run_id: 'run-1', obligation_id: 'leaf-1',
    selected_action: 'stop_blocked', requested_action: 'dispatch_provider_request',
    handlers: { dispatch_provider_request: async () => { called = true; } },
  });
  assert.equal(result.reason_code, 'kernel_action_mismatch');
  assert.equal(result.executed, false);
  assert.equal(called, false);
});

test('dispatcher invokes only the exact registered handler', async () => {
  const result = await dispatchMemorizeAction({
    logical_run_id: 'run-1', obligation_id: 'leaf-1',
    selected_action: 'resume_exact_obligation',
    requested_action: 'dispatch_provider_request',
    handlers: { dispatch_provider_request: async ({ action }) => ({ action, sent: true }) },
  });
  assert.equal(result.status, 'executed');
  assert.deepEqual(result.value, { action: 'dispatch_provider_request', sent: true });
});

test('dispatcher fails closed for every incomplete action identity', async () => {
  const missingRun = await dispatchMemorizeAction({
    obligation_id: 'leaf-1', selected_action: 'dispatch_provider_request',
    requested_action: 'dispatch_provider_request', handlers: {},
  });
  assert.equal(missingRun.reason_code, 'logical_run_identity_required');

  const missingLeaf = await dispatchMemorizeAction({
    logical_run_id: 'run-1', selected_action: 'dispatch_provider_request',
    requested_action: 'dispatch_provider_request', handlers: {},
  });
  assert.equal(missingLeaf.reason_code, 'obligation_identity_required');

  const unknown = await dispatchMemorizeAction({
    logical_run_id: 'run-1', obligation_id: 'leaf-1',
    selected_action: 'invented_action', requested_action: 'invented_action', handlers: {},
  });
  assert.equal(unknown.reason_code, 'unknown_requested_action');

  const missingHandler = await dispatchMemorizeAction({
    logical_run_id: 'run-1', obligation_id: 'leaf-1',
    selected_action: 'dispatch_provider_request',
    requested_action: 'dispatch_provider_request', handlers: {},
  });
  assert.equal(missingHandler.reason_code, 'action_handler_missing');
});

test('run-level actions do not require a leaf and handler failures retain action identity', async () => {
  const traversal = await dispatchMemorizeAction({
    logical_run_id: 'run-1', selected_action: 'continue_source_traversal',
    requested_action: 'continue_source_traversal',
    handlers: { continue_source_traversal: async () => 'continued' },
  });
  assert.equal(traversal.value, 'continued');

  const failure = new Error('scripted failure');
  await assert.rejects(dispatchMemorizeAction({
    logical_run_id: 'run-1', obligation_id: 'leaf-1',
    selected_action: 'dispatch_provider_request',
    requested_action: 'dispatch_provider_request',
    handlers: { dispatch_provider_request: async () => { throw failure; } },
  }), (error) => {
    assert.equal(error, failure);
    assert.equal(error.sme_action, 'dispatch_provider_request');
    assert.equal(error.sme_obligation_id, 'leaf-1');
    return true;
  });

  assert.throws(() => assertMemorizeActionSelected({
    selected_action: 'dispatch_provider_request', requested_action: 'invented_action',
  }), (error) => error.code === 'SME_MEMORIZE_ACTION_UNKNOWN');
  assert.throws(() => assertMemorizeActionSelected({
    selected_action: 'stop_blocked', requested_action: 'dispatch_provider_request',
  }), (error) => error.code === 'SME_MEMORIZE_ACTION_MISMATCH');
});
