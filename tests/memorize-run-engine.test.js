import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemorizeOutcome } from '../memorize-outcome.js';
import { createMemorizeRunEngine } from '../memorize-run-engine.js';

test('initial and resume invocations use the same engine boundary', async () => {
  const engine = createMemorizeRunEngine();
  const initial = await engine.execute({ mode: 'initial' }, async () => 7);
  const resumed = await engine.execute({ mode: 'resume' }, async () =>
    createMemorizeOutcome({ kind: 'paused', reason_code: 'tier_coverage_incomplete' }));
  assert.equal(initial.kind, 'completed');
  assert.equal(initial.value, 7);
  assert.equal(resumed.kind, 'paused');
  assert.equal(engine.active_invocation, null);
});

test('engine rejects overlapping ownership without invoking a second operation', async () => {
  const engine = createMemorizeRunEngine();
  let release;
  const first = engine.execute({ invocation_id: 'first' }, () => new Promise((resolve) => { release = resolve; }));
  let secondInvoked = false;
  const second = await engine.execute({ invocation_id: 'second' }, async () => { secondInvoked = true; });
  assert.equal(second.kind, 'blocked');
  assert.equal(second.reason_code, 'already_running');
  assert.equal(secondInvoked, false);
  release('done');
  assert.equal((await first).kind, 'completed');
});

test('expected operational pauses become outcomes while unexpected exceptions still throw', async () => {
  const engine = createMemorizeRunEngine();
  const pause = Object.assign(new Error('pause'), {
    code: 'recovery_request_budget_reached_with_pending_children', sme_operational_pause: true,
  });
  const paused = await engine.execute({}, async () => { throw pause; });
  assert.equal(paused.kind, 'paused');
  await assert.rejects(() => engine.execute({}, async () => { throw new TypeError('bug'); }), /bug/);
});

