/**
 * Explicit dependency object shared by Session and Long-Term extraction.
 * Controller call sites pass only `executionContext`; private underscore
 * option protocols are deliberately not interpreted here.
 */

const noopAsync = async () => {};
const noopLookup = () => null;

export function createMemorizeExecutionContext(input = {}) {
  return Object.freeze({
    schema_version: 1,
    controller: Object.freeze({
      attempt_number: input.controller?.attempt_number ?? null,
      lifecycle_required: input.controller?.lifecycle_required === true,
      instance_id: input.controller?.instance_id ?? null,
      transaction_id: input.controller?.transaction_id ?? null,
      transaction_revision: input.controller?.transaction_revision ?? null,
      transaction_generation: input.controller?.transaction_generation ?? null,
    }),
    provider: Object.freeze({
      root_obligation_id: input.provider?.root_obligation_id ?? null,
      root_source_range: input.provider?.root_source_range ?? null,
      root_source_fingerprint: input.provider?.root_source_fingerprint ?? null,
      parent_attempt_id: input.provider?.parent_attempt_id ?? null,
      request_kind: input.provider?.request_kind ?? null,
      resumed_pending_obligation: input.provider?.resumed_pending_obligation === true,
      root_obligation_state: input.provider?.root_obligation_state ?? null,
      selected_recovery_action: input.provider?.selected_recovery_action ?? null,
      changed_recovery_dimensions: Object.freeze([...(input.provider?.changed_recovery_dimensions ?? [])]),
    }),
    recovery: Object.freeze({
      context_overflow_depth: Number(input.recovery?.context_overflow_depth ?? 0),
      context_overflow_parent_range_id: input.recovery?.context_overflow_parent_range_id ?? null,
      context_overflow_range_id: input.recovery?.context_overflow_range_id ?? null,
      completed_child_keys: Object.freeze([...(input.recovery?.completed_child_keys ?? [])]),
      malformed_budget: input.recovery?.malformed_budget ?? null,
      malformed_depth: Number(input.recovery?.malformed_depth ?? 0),
      manifest_parent_child_key: input.recovery?.manifest_parent_child_key ?? null,
      targeted_replay: input.recovery?.targeted_replay === true,
      automatic_fragment_recovery: input.recovery?.automatic_fragment_recovery ?? null,
      automatic_partial_recovery: input.recovery?.automatic_partial_recovery === true,
      automatic_budget: input.recovery?.automatic_budget ?? null,
      automatic_depth: Number(input.recovery?.automatic_depth ?? 0),
    }),
    hooks: Object.freeze({
      obligation_event: input.hooks?.obligation_event ?? noopAsync,
      provider_await_point: input.hooks?.provider_await_point ?? noopAsync,
      provider_completion_journal_updated: input.hooks?.provider_completion_journal_updated ?? noopAsync,
      recovery_child_manifest_updated: input.hooks?.recovery_child_manifest_updated ?? noopAsync,
      context_overflow_child_committed: input.hooks?.context_overflow_child_committed ?? noopAsync,
      recovery_epoch_initialized: input.hooks?.recovery_epoch_initialized ?? noopAsync,
      automatic_recovery_boundary: input.hooks?.automatic_recovery_boundary ?? noopAsync,
      automatic_recovery_completed: input.hooks?.automatic_recovery_completed ?? noopAsync,
      get_canonical_obligation: input.hooks?.get_canonical_obligation ?? noopLookup,
    }),
  });
}

export function extendMemorizeExecutionContext(context, overrides = {}) {
  return createMemorizeExecutionContext({
    controller: { ...context?.controller, ...overrides.controller },
    provider: { ...context?.provider, ...overrides.provider },
    recovery: { ...context?.recovery, ...overrides.recovery },
    hooks: { ...context?.hooks, ...overrides.hooks },
  });
}

/** Resolve one stable view. Legacy underscore protocols are intentionally unsupported. */
export function resolveMemorizeExecutionContext(options = {}) {
  return options.executionContext?.schema_version === 1
    ? options.executionContext : createMemorizeExecutionContext();
}

