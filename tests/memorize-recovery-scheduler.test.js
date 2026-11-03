import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemorizeRecoveryScheduler } from '../memorize-recovery-scheduler.js';

test('recovery scheduler executes leaves iteratively and skips committed work', async () => {
  const scheduler = createMemorizeRecoveryScheduler();
  const executed = [];
  const result = await scheduler.run({
    tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    keyOf: (task) => task.id,
    completedKeys: ['b'],
    execute: async (task) => { executed.push(task.id); return 2; },
  });
  assert.deepEqual(executed, ['a', 'c']);
  assert.equal(result.added, 4);
  assert.equal(result.executed, 2);
  assert.equal(result.skipped, 1);
  assert.equal(scheduler.active, false);
});

test('scheduler stops at an allowance boundary with an exact next leaf', async () => {
  let allowanceCount = 0;
  const scheduler = createMemorizeRecoveryScheduler();
  const result = await scheduler.run({
    tasks: ['a', 'b', 'c'], keyOf: (task) => task,
    allowance: async () => (++allowanceCount <= 1
      ? { allowed: true } : { allowed: false, reason: 'budget_reached' }),
    execute: async () => 1,
  });
  assert.equal(result.completed, false);
  assert.equal(result.pause_reason, 'budget_reached');
  assert.equal(result.next_task_key, 'b');
  assert.deepEqual(result.unattempted_task_keys, ['b', 'c']);
});

test('scheduler rejects re-entry instead of creating recursive recovery', async () => {
  const scheduler = createMemorizeRecoveryScheduler();
  await assert.rejects(() => scheduler.run({
    tasks: ['root'], keyOf: (task) => task,
    execute: async () => scheduler.run({ tasks: [], keyOf: String, execute: async () => 0 }),
  }), { code: 'SME_RECOVERY_SCHEDULER_REENTRY' });
});

