import { runCanonicalMemorizeActions, selectCanonicalMemorizeAction } from './memorize-action-engine.js';

// Eligibility and dispatch use the same production action bindings. Whether
// an action calls the provider is its contract, not a parallel dispatch path.
const sessionActionBindings = Object.freeze({
  dispatch_provider_request: 'extract',
  apply_journaled_provider_completion: 'extract',
  aggregate_completed_children: 'aggregate',
});

export function hasSessionActionHandler(action) {
  return Object.hasOwn(sessionActionBindings, action);
}

export function runSessionActionController({ read_ledger, source_range,
  read_root_obligation_id, extract, aggregate, cancelled, maximum_actions } = {}) {
  const adapters = { extract, aggregate };
  const handlers = Object.fromEntries(Object.entries(sessionActionBindings).map(([action, adapter]) => {
    if (typeof adapters[adapter] !== 'function') throw new TypeError(`Session action ${action} has no ${adapter} adapter.`);
    return [action, adapters[adapter]];
  }));
  return runCanonicalMemorizeActions({
    read_ledger, handlers, cancelled, maximum_actions,
    select: (ledger) => selectCanonicalMemorizeAction({ ledger, tier: 'session',
      source_range, root_obligation_id: read_root_obligation_id?.() ?? null }),
  });
}
