/**
 * Deterministic, iterative recovery work queue. It owns ordering, skip,
 * allowance, and terminal accounting; tier workers only execute one leaf.
 */
export function decideMemorizeRecovery(state = {}) {
  if (state.cancelled === true) return Object.freeze({
    decision: 'cancelled', reason_code: 'cancelled', automatic: false,
  });
  const outcome = state.outcome;
  if (['complete', 'complete_no_update'].includes(outcome?.kind)) return Object.freeze({
    decision: 'commit_obligation', reason_code: outcome.reason_code,
    automatic: true,
  });
  if (outcome?.kind === 'policy_paused') return Object.freeze({
    decision: 'pause_for_user', reason_code: outcome.reason_code,
    automatic: false, next_action: outcome.next_action,
  });
  if (outcome?.kind === 'blocked') return Object.freeze({
    decision: 'stop_blocked', reason_code: outcome.reason_code,
    automatic: false, next_action: outcome.next_action,
  });
  if (outcome?.kind === 'cancelled') return Object.freeze({
    decision: 'cancelled', reason_code: outcome.reason_code,
    automatic: false,
  });
  if (outcome?.kind === 'terminal_failure') return Object.freeze({
    decision: 'terminal_failure', reason_code: outcome.reason_code,
    automatic: false,
  });
  const recoverable = ['partial_recoverable', 'malformed_recoverable',
    'context_overflow_recoverable', 'validation_recoverable',
    'transport_retryable'].includes(outcome?.kind);
  if (!recoverable) return Object.freeze({
    decision: 'terminal_failure', reason_code: 'unknown_tier_outcome', automatic: false,
  });
  if (!outcome.next_action || outcome.provider_call_required !== true) return Object.freeze({
    decision: 'stop_blocked', reason_code: 'recovery_action_not_executable',
    automatic: false, next_action: outcome.next_action,
  });
  if (Number(state.remaining_attempts ?? 0) <= 0) return Object.freeze({
    decision: 'pause_for_user', reason_code: 'recovery_budget_exhausted',
    automatic: false, next_action: outcome.next_action,
  });
  if (state.provider_available === false || state.source_available === false) return Object.freeze({
    decision: 'pause_for_user',
    reason_code: state.provider_available === false
      ? 'provider_unavailable' : 'recovery_source_unavailable',
    automatic: false, next_action: outcome.next_action,
  });
  return Object.freeze({
    decision: 'dispatch_recovery', reason_code: outcome.reason_code,
    automatic: true, next_action: outcome.next_action,
    owner_subset: Object.freeze([...(outcome.missing_owners ?? [])]),
  });
}

export function createMemorizeRecoveryScheduler(input = {}) {
  const maximumTasks = Math.max(1, Number(input.maximum_tasks ?? 512));
  let active = false;

  return Object.freeze({
    get active() { return active; },
    decide: decideMemorizeRecovery,
    async runOutcomes({ execute, maximum_attempts: maximumAttempts = 1,
      initial_action: initialAction = 'dispatch_provider_request', cancelled = () => false,
      provider_available: providerAvailable = true, source_available: sourceAvailable = true,
      onDecision = null }) {
      if (active) throw Object.assign(new Error('Recovery scheduler cannot be re-entered.'), {
        code: 'SME_RECOVERY_SCHEDULER_REENTRY',
      });
      if (typeof execute !== 'function') throw new TypeError('Recovery scheduler requires an executor.');
      active = true;
      const maximum = Math.max(1, Math.min(maximumTasks, Number(maximumAttempts) || 1));
      const attempts = [];
      const seenDimensions = new Set();
      let action = initialAction;
      try {
        for (let index = 0; index < maximum; index++) {
          if (cancelled()) return Object.freeze({ decision: 'cancelled', attempts, outcome: null });
          const outcome = await execute(Object.freeze({ action, attempt_index: index,
            attempts_remaining_before_dispatch: maximum - index }));
          attempts.push(Object.freeze({ action, outcome }));
          const decision = decideMemorizeRecovery({ outcome, cancelled: cancelled(),
            remaining_attempts: maximum - attempts.length,
            provider_available: providerAvailable, source_available: sourceAvailable });
          await onDecision?.(decision, outcome, { attempt_index: index,
            attempts_used: attempts.length, maximum_attempts: maximum });
          if (decision.decision !== 'dispatch_recovery') return Object.freeze({
            ...decision, attempts: Object.freeze(attempts), outcome,
            attempts_used: attempts.length, maximum_attempts: maximum,
          });
          const dimension = outcome.recovery_dimension
            ?? JSON.stringify([outcome.next_action, outcome.missing_owners ?? []]);
          if (seenDimensions.has(dimension)) return Object.freeze({
            decision: 'pause_for_user', reason_code: 'recovery_dimension_exhausted',
            automatic: false, next_action: outcome.next_action,
            attempts: Object.freeze(attempts), outcome,
            attempts_used: attempts.length, maximum_attempts: maximum,
          });
          seenDimensions.add(dimension);
          action = decision.next_action;
        }
        return Object.freeze({ decision: 'pause_for_user',
          reason_code: 'recovery_budget_exhausted', automatic: false,
          next_action: action, attempts: Object.freeze(attempts),
          outcome: attempts.at(-1)?.outcome ?? null,
          attempts_used: attempts.length, maximum_attempts: maximum,
        });
      } finally {
        active = false;
      }
    },
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
            const typedOutcome = value?.schema_version === 1 && typeof value?.kind === 'string';
            result.added += Number(typedOutcome ? value?.value?.added
              : value?.added ?? value ?? 0) || 0;
            const typedCommitted = typedOutcome
              ? ['complete', 'complete_no_update'].includes(value.kind) : null;
            if (value?.committed === false || typedCommitted === false) {
              result.completed = false;
              result.pause_reason = value?.reason_code ?? 'recovery_leaf_not_committed';
              result.next_task_key = key;
              result.unattempted_task_keys = tasks.slice(index)
                .map((item, offset) => keyOf(item, index + offset));
              break;
            }
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

