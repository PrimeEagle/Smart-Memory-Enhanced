const freeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
};

const text = (value) => String(value ?? '').trim() || null;

/** Immutable identity carried through every extraction action and failure boundary. */
export function createMemorizeOperationContext(input = {}) {
  const sourceRange = input.source_range && Number.isInteger(input.source_range.start)
    && Number.isInteger(input.source_range.end)
    ? { start: input.source_range.start, end: input.source_range.end,
      message_count: Number(input.source_range.message_count)
        || input.source_range.end - input.source_range.start + 1 }
    : null;
  const context = {
    schema_version: 1,
    logical_run_id: text(input.logical_run_id),
    controller_invocation_id: text(input.controller_invocation_id),
    transaction_id: text(input.transaction_id),
    transaction_generation: Number.isInteger(input.transaction_generation)
      ? input.transaction_generation : null,
    chunk_id: text(input.chunk_id),
    root_obligation_id: text(input.root_obligation_id),
    leaf_obligation_id: text(input.leaf_obligation_id),
    parent_obligation_id: text(input.parent_obligation_id),
    tier: text(input.tier),
    owner: text(input.owner),
    owners: [...new Set((input.owners ?? []).map(text).filter(Boolean))],
    source_range: sourceRange,
    source_fingerprint: text(input.source_fingerprint),
    selected_action: text(input.selected_action),
    attempt_id: text(input.attempt_id),
    action_handler_revision: Number(input.action_handler_revision) || null,
    provider_policy_revision: Number(input.provider_policy_revision) || null,
  };
  return freeze(context);
}

export function attachMemorizeOperationContext(error, context) {
  if (!error || typeof error !== 'object') return error;
  error.sme_operation_context ??= context;
  error.sme_obligation_id ??= context?.leaf_obligation_id
    ?? context?.root_obligation_id ?? null;
  return error;
}
