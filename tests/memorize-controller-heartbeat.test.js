import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyStaleMemorizeController,
  updateMemorizeControllerHeartbeat,
} from '../memorize-controller-heartbeat.js';

test('controller heartbeat retains the exact provider await point and transaction identity', () => {
  const checkpoint = {};
  const runtime = { invocation_id: 'controller-1', page_instance_id: 'page-1', attempt_number: 1,
    phase: 'source_extraction', active_transaction: { transaction_id: 'tx-13' } };
  const heartbeat = updateMemorizeControllerHeartbeat(checkpoint, runtime, {
    await_point: 'provider_request', active_provider_attempt_id: 'provider-342',
    root_obligation_id: 'root', child_obligation_id: '225-229', progress: true,
  }, 1000);
  assert.equal(heartbeat.await_point, 'provider_request');
  assert.equal(heartbeat.active_transaction_id, 'tx-13');
  assert.equal(heartbeat.active_provider_attempt_id, 'provider-342');
});

test('slow active provider request is never declared stale', () => {
  const heartbeat = { last_progress_at: 1000, await_point: 'provider_request' };
  const result = classifyStaleMemorizeController(heartbeat, {
    stale_threshold_ms: 100, provider_running: true, transaction_inspectable: true,
  }, 100000);
  assert.equal(result.stale, false);
  assert.ok(result.blockers.includes('provider_request_running'));
});

test('old heartbeat with no active work and inspectable transaction is stale', () => {
  const heartbeat = { last_progress_at: 1000, await_point: 'child_manifest_update' };
  const result = classifyStaleMemorizeController(heartbeat, {
    stale_threshold_ms: 100, provider_running: false, persistence_running: false,
    save_running: false, background_operation_running: false, controller_executing: false,
    transaction_inspectable: true,
  }, 100000);
  assert.equal(result.stale, true);
});

