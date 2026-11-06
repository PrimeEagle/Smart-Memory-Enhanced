/**
 * Deterministic, iterative recovery work queue. It owns ordering, skip,
 * allowance, and terminal accounting; tier workers only execute one leaf.
 */
export function createMemorizeRecoveryScheduler(input = {}) {
  const maximumTasks = Math.max(1, Number(input.maximum_tasks ?? 512));
  let active = false;

  return Object.freeze({
    get active() { return active; },
    async run({ tasks = [], keyOf, completedKeys = [], allowance = null,
      execute, shouldSkip = null, onSkipped = null, onCommitted = null, onFailed = null }) {
      if (active) throw Object.assign(new Error('Recovery scheduler cannot be re-entered.'), {
        code: 'SME_RECOVERY_SCHEDULER_REENTRY',
      });
      if (!Array.isArray(tasks) || tasks.length > maximumTasks) {
        throw Object.assign(new Error('Recovery task count exceeds the bounded scheduler limit.'), {
          code: 'SME_RECOVERY_SCHEDULER_TASK_LIMIT',
        });
      }
      active = true;
      const committed = new Set(completedKeys);
      const result = { completed: true, added: 0, executed: 0, skipped: 0,
        committed_keys: [], pause_reason: null, next_task_key: null,
        unattempted_task_keys: [],
        registered_task_keys: tasks.map((item, index) => keyOf(item, index)),
        terminal_skipped_task_keys: [], locally_repaired_task_keys: [],
        selected_incomplete_task_key: null, reason_no_task_selected: null,
        parent_aggregation_status: 'waiting_for_children', next_sibling_action: null };
      try {
        for (let index = 0; index < tasks.length; index++) {
          const task = tasks[index];
          const key = keyOf(task, index);
          const canonicalSkip = shouldSkip ? await shouldSkip(task, { key, index }) : null;
          if (committed.has(key) || canonicalSkip?.skip === true) {
            result.skipped++;
            if (canonicalSkip?.terminal === true) {
              committed.add(key);
              result.committed_keys.push(key);
              result.terminal_skipped_task_keys.push(key);
            }
            if (canonicalSkip?.locally_repaired === true) {
              result.locally_repaired_task_keys.push(key);
            }
            await onSkipped?.(task, { key, index, canonical: canonicalSkip });
            continue;
          }
          const permission = allowance ? await allowance(task, { key, index }) : { allowed: true };
          if (permission?.allowed === false) {
            result.completed = false;
            result.pause_reason = permission.reason ?? 'recovery_allowance_denied';
            result.next_task_key = key;
            result.unattempted_task_keys = tasks.slice(index).map((item, offset) => keyOf(item, index + offset));
            break;
          }
          result.selected_incomplete_task_key ??= key;
          result.next_sibling_action = 'dispatch_provider_request';
          try {
            const value = await execute(task, { key, index });
            result.executed++;
            result.added += Number(value?.added ?? value ?? 0) || 0;
            if (value?.committed === false) continue;
            committed.add(key);
            result.committed_keys.push(key);
            await onCommitted?.(task, { key, index, value });
          } catch (error) {
            result.completed = false;
            await onFailed?.(task, { key, index, error });
            throw error;
          }
        }
        if (result.completed) {
          result.parent_aggregation_status = 'ready_for_local_aggregation';
          result.next_sibling_action = 'aggregate_completed_children';
        }
        if (!result.selected_incomplete_task_key) {
          result.reason_no_task_selected = result.completed
            ? 'all_registered_children_terminal' : result.pause_reason ?? 'no_actionable_child';
        }
        return Object.freeze(result);
      } finally {
        active = false;
      }
    },
  });
}

