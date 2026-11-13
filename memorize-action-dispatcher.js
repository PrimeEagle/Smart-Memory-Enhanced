import {
  canonicalizeMemorizeKernelAction,
  MEMORIZE_ACTIONS,
} from './memorize-execution-kernel.js';

const ACTION_SET = new Set(MEMORIZE_ACTIONS);
export function canonicalizeMemorizeAction(action) {
  return canonicalizeMemorizeKernelAction(action);
}

const freeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
};

/** Execute exactly the action selected by the current-run kernel. */
export async function dispatchMemorizeAction({
  logical_run_id: logicalRunId,
  obligation_id: obligationId,
  selected_action: selectedAction,
  requested_action: requestedAction,
  handlers = {},
  detail = {},
} = {}) {
  if (!String(logicalRunId ?? '').trim()) return freeze({
    status: 'rejected', reason_code: 'logical_run_identity_required', executed: false,
  });
  if (!String(obligationId ?? '').trim() && !['continue_source_traversal',
    'continue_finalization', 'complete_run'].includes(requestedAction)) return freeze({
    status: 'rejected', reason_code: 'obligation_identity_required', executed: false,
  });
  const canonicalSelectedAction = canonicalizeMemorizeAction(selectedAction);
  const canonicalRequestedAction = canonicalizeMemorizeAction(requestedAction);
  if (!canonicalRequestedAction) return freeze({
    status: 'rejected', reason_code: 'unknown_requested_action', executed: false,
  });
  if (canonicalSelectedAction !== canonicalRequestedAction) return freeze({
    status: 'rejected', reason_code: 'kernel_action_mismatch', executed: false,
    selected_action: selectedAction ?? null, requested_action: requestedAction,
  });
  const handler = handlers[canonicalRequestedAction];
  if (typeof handler !== 'function') return freeze({
    status: 'rejected', reason_code: 'action_handler_missing', executed: false,
  });
  try {
    const value = await handler({ logical_run_id: logicalRunId,
      obligation_id: obligationId, action: canonicalRequestedAction, detail });
    return freeze({ status: 'executed', executed: true, action: canonicalRequestedAction, value });
  } catch (error) {
    error.sme_action ??= canonicalRequestedAction;
    error.sme_obligation_id ??= obligationId;
    throw error;
  }
}

export function assertMemorizeActionSelected({ selected_action: selectedAction,
  requested_action: requestedAction } = {}) {
  const canonicalSelectedAction = canonicalizeMemorizeAction(selectedAction);
  const canonicalRequestedAction = canonicalizeMemorizeAction(requestedAction);
  if (!canonicalRequestedAction) {
    const error = new Error(`Unknown Memorize Chat action: ${requestedAction ?? 'missing'}.`);
    error.code = 'SME_MEMORIZE_ACTION_UNKNOWN';
    throw error;
  }
  if (canonicalSelectedAction !== canonicalRequestedAction) {
    const error = new Error(`Tier adapter attempted ${requestedAction} while the kernel selected ${selectedAction ?? 'none'}.`);
    error.code = 'SME_MEMORIZE_ACTION_MISMATCH';
    error.sme_reason_code = 'kernel_action_mismatch';
    throw error;
  }
  return canonicalRequestedAction;
}
