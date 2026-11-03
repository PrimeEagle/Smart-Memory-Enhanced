import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMemorizeExecutionContext,
  extendMemorizeExecutionContext,
  resolveMemorizeExecutionContext,
} from '../memorize-execution-context.js';

test('execution context exposes named controller, provider, and hook dependencies', async () => {
  const events = [];
  const context = createMemorizeExecutionContext({
    controller: { attempt_number: 3 },
    provider: {
      root_obligation_id: 'session:1-20',
      resumed_pending_obligation: true,
      changed_recovery_dimensions: ['source_range'],
    },
    hooks: { obligation_state: async (event) => events.push(event) },
  });
  assert.equal(context.controller.attempt_number, 3);
  assert.equal(context.provider.resumed_pending_obligation, true);
  await context.hooks.obligation_state({ state: 'running' });
  assert.deepEqual(events, [{ state: 'running' }]);
  assert.equal(Object.isFrozen(context.provider), true);
});

test('legacy underscore options cannot override the explicit execution context', () => {
  const context = createMemorizeExecutionContext({
    provider: { root_obligation_id: 'root', parent_attempt_id: 'parent-a' },
  });
  const resolved = resolveMemorizeExecutionContext({
    executionContext: context,
    _providerParentAttemptId: 'parent-b',
  });
  assert.equal(resolved.provider.root_obligation_id, 'root');
  assert.equal(resolved.provider.parent_attempt_id, 'parent-a');
});

test('child execution contexts override provider identity without losing hooks', async () => {
  const events = [];
  const root = createMemorizeExecutionContext({
    provider: { root_obligation_id: 'root', request_kind: 'original' },
    hooks: { obligation_state: async (event) => events.push(event) },
  });
  const child = extendMemorizeExecutionContext(root, {
    provider: { parent_attempt_id: 'attempt-1', request_kind: 'repartition_child' },
  });
  assert.equal(child.provider.root_obligation_id, 'root');
  assert.equal(child.provider.parent_attempt_id, 'attempt-1');
  assert.equal(child.provider.request_kind, 'repartition_child');
  await child.hooks.obligation_state('child-running');
  assert.deepEqual(events, ['child-running']);
});

test('missing hooks are stable asynchronous no-ops', async () => {
  const resolved = resolveMemorizeExecutionContext();
  assert.equal(await resolved.hooks.provider_await_point({}), undefined);
  assert.equal(await resolved.hooks.provider_completion_journal_updated({}), undefined);
});

