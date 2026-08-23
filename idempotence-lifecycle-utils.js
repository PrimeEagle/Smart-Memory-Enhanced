import { compareDurableSemanticStates } from './idempotence-utils.js';

/** Builds a privacy-safe ledger from immutable durable-state snapshots. */
export function buildIdempotenceLifecycleLedger(checkpoints = []) {
  const normalized = checkpoints.filter((checkpoint) => checkpoint?.state && checkpoint?.stage).map((checkpoint) => ({
    stage: checkpoint.stage,
    owner: checkpoint.owner ?? 'unknown',
    mutation_accounted: Boolean(checkpoint.mutation_accounted),
    state: checkpoint.state,
  }));
  const entries = normalized.map(({ stage, owner, mutation_accounted, state }) => {
    const self = compareDurableSemanticStates(state, state);
    return { stage, owner, durable_hash: self.first_hash, mutation_accounted };
  });
  const transitions = normalized.slice(1).map((current, index) => {
    const previous = normalized[index];
    const comparison = compareDurableSemanticStates(previous.state, current.state);
    return {
      from_stage: previous.stage, to_stage: current.stage, owner: current.owner,
      equal: !comparison.changed, changed_components: comparison.changed_components,
      changed_paths: comparison.paths, mutation_accounted: current.mutation_accounted,
      accounting_reconciled: !comparison.changed || current.mutation_accounted,
    };
  });
  return { schema_version: 1, projection: 'durable_semantic_state_v1', checkpoints: entries, transitions,
    all_transitions_accounting_reconciled: transitions.every((transition) => transition.accounting_reconciled),
    final_durable_hash: entries.at(-1)?.durable_hash ?? null };
}
