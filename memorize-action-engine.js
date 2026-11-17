import { getMemorizeActionContract } from './memorize-obligation-ledger.js';

const TERMINAL_STATES = new Set(['durably_committed', 'explicit_no_update']);
const BLOCKED_STATES = new Set(['blocked', 'terminal_failed']);

function sameRange(left, right) {
  return Number(left?.start) === Number(right?.start)
    && Number(left?.end) === Number(right?.end);
}

function orderedChildren(ledger, obligation) {
  return (obligation?.expected_child_obligation_ids ?? [])
    .map((id) => ledger?.obligations?.[id])
    .filter(Boolean)
    .sort((left, right) => Number(left.source_range?.start ?? 0)
      - Number(right.source_range?.start ?? 0));
}

function selectWithin(ledger, obligation, root) {
  if (!obligation) return null;
  if (obligation.checkpoint_eligible === true
    || TERMINAL_STATES.has(obligation.current_state)) return null;
  if (BLOCKED_STATES.has(obligation.current_state)) return Object.freeze({
    kind: 'blocked', reason_code: obligation.exact_reason_code ?? obligation.current_state,
    obligation: structuredClone(obligation), root_obligation: structuredClone(root),
  });
  const children = orderedChildren(ledger, obligation);
  for (const child of children) {
    const selected = selectWithin(ledger, child, root);
    if (selected) return selected;
  }
  if (children.length) return Object.freeze({
    kind: 'aggregate_parent', reason_code: 'all_registered_children_terminal',
    action: 'aggregate_completed_children', obligation: structuredClone(obligation),
    root_obligation: structuredClone(root), provider_call_required: false,
  });
  const action = obligation.next_eligible_action ?? 'dispatch_provider_request';
  const contract = getMemorizeActionContract(action);
  return Object.freeze({
    kind: contract?.provider_call_required === false ? 'local_action' : 'dispatch_leaf',
    reason_code: obligation.exact_reason_code ?? 'canonical_leaf_actionable', action,
    obligation: structuredClone(obligation), root_obligation: structuredClone(root),
    provider_call_required: contract?.provider_call_required !== false,
  });
}

/**
 * Selects one action from the canonical obligation graph. Parents with
 * registered children are never redispatched; their first incomplete leaf is
 * selected, or they are aggregated after every child is terminal.
 */
export function selectCanonicalMemorizeAction({ ledger, tier, source_range: sourceRange,
  root_obligation_id: rootObligationId = null } = {}) {
  const obligations = Object.values(ledger?.obligations ?? {});
  let root = rootObligationId ? ledger?.obligations?.[rootObligationId] : obligations
    .filter((item) => item.tier === tier && !item.parent_obligation_id
      && sameRange(item.source_range, sourceRange))
    .sort((left, right) => Number(right.updated_at ?? 0) - Number(left.updated_at ?? 0))[0];
  const visited = new Set();
  while (root?.parent_obligation_id && !visited.has(root.obligation_id)) {
    visited.add(root.obligation_id);
    root = ledger?.obligations?.[root.parent_obligation_id] ?? root;
  }
  if (!root) return Object.freeze({
    kind: 'dispatch_root', reason_code: 'root_obligation_not_registered',
    action: 'dispatch_provider_request', provider_call_required: true,
    obligation: null, root_obligation: null,
  });
  if (root.checkpoint_eligible === true || TERMINAL_STATES.has(root.current_state)) {
    return Object.freeze({ kind: 'complete', reason_code: 'root_obligation_terminal',
      obligation: structuredClone(root), root_obligation: structuredClone(root),
      provider_call_required: false });
  }
  return selectWithin(ledger, root, root) ?? Object.freeze({
    kind: 'complete', reason_code: 'root_obligation_terminal',
    obligation: structuredClone(root), root_obligation: structuredClone(root),
    provider_call_required: false,
  });
}

/** Iterative controller loop. Durable graph state is reread after every action. */
export async function runCanonicalMemorizeActions({ read_ledger: readLedger, select,
  execute, execute_local: executeLocal = null, aggregate, cancelled = () => false,
  maximum_actions: maximumActions = 512,
  on_action: onAction = null } = {}) {
  if (![readLedger, select, execute, aggregate].every((value) => typeof value === 'function')) {
    throw new TypeError('Canonical Memorize action engine requires graph, selector, executor, and aggregator.');
  }
  const history = [];
  let priorSignature = null;
  for (let index = 0; index < Math.max(1, Number(maximumActions) || 1); index++) {
    if (cancelled()) return Object.freeze({ status: 'cancelled', history: Object.freeze(history) });
    const selected = select(readLedger());
    await onAction?.(selected, { action_index: index });
    if (selected.kind === 'complete') return Object.freeze({ status: 'complete',
      history: Object.freeze(history), selected });
    if (selected.kind === 'blocked') return Object.freeze({ status: 'blocked',
      reason_code: selected.reason_code, history: Object.freeze(history), selected });
    if (selected.kind === 'local_action' && typeof executeLocal !== 'function') {
      return Object.freeze({ status: 'blocked', reason_code: 'canonical_local_action_has_no_handler',
        history: Object.freeze(history), selected });
    }
    const signature = JSON.stringify([selected.kind, selected.obligation?.obligation_id,
      selected.action, selected.obligation?.current_state, selected.obligation?.revision,
      selected.obligation?.provider_attempt_lineage?.length ?? 0]);
    const result = selected.kind === 'aggregate_parent'
      ? await aggregate(selected, { action_index: index })
      : selected.kind === 'local_action'
        ? await executeLocal(selected, { action_index: index })
        : await execute(selected, { action_index: index });
    history.push(Object.freeze({ selected, result }));
    if (result?.kind === 'cancelled') return Object.freeze({ status: 'cancelled',
      history: Object.freeze(history), selected });
    if (result?.kind === 'blocked') return Object.freeze({ status: 'blocked',
      reason_code: result.reason_code, history: Object.freeze(history), selected });
    if (result?.kind === 'policy_paused') return Object.freeze({ status: 'paused',
      reason_code: result.reason_code, history: Object.freeze(history), selected });
    if (result?.kind === 'terminal_failure') return Object.freeze({ status: 'failed',
      reason_code: result.reason_code, history: Object.freeze(history), selected });
    const next = select(readLedger());
    const nextSignature = JSON.stringify([next.kind, next.obligation?.obligation_id,
      next.action, next.obligation?.current_state, next.obligation?.revision,
      next.obligation?.provider_attempt_lineage?.length ?? 0]);
    if (['complete', 'complete_no_update'].includes(result?.kind)
      && signature === nextSignature) return Object.freeze({
      status: 'failed', reason_code: 'action_outcome_without_canonical_transition',
      history: Object.freeze(history), selected: next,
    });
    if (signature === nextSignature && signature === priorSignature) return Object.freeze({
      status: 'blocked', reason_code: 'canonical_action_made_no_progress',
      history: Object.freeze(history), selected: next,
    });
    priorSignature = signature;
  }
  return Object.freeze({ status: 'paused', reason_code: 'canonical_action_limit_reached',
    history: Object.freeze(history) });
}
