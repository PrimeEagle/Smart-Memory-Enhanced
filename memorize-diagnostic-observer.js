import { projectMemorizeKernelStatus, validateMemorizeExecutionAggregate }
  from './memorize-execution-kernel.js';

/** Compact read-only export. It never retains provider response or record bodies. */
export function projectMemorizeKernelDiagnostics(aggregateValue, input = {}) {
  if (!aggregateValue?.execution_kernel) return null;
  const aggregate = structuredClone(aggregateValue);
  const kernel = aggregate.execution_kernel;
  const status = projectMemorizeKernelStatus(aggregate, {
    controller_active: input.controller_active === true,
    recovered_error_count: input.recovered_error_count,
  });
  const validation = validateMemorizeExecutionAggregate(aggregate);
  const attempts = Object.values(kernel.attempts ?? {}).map((attempt) => ({
    attempt_id: attempt.attempt_id,
    obligation_leaf_id: attempt.obligation_leaf_id,
    root_obligation_id: attempt.root_obligation_id,
    source_range: attempt.source_range,
    source_fingerprint: attempt.source_fingerprint,
    terminal_transport_status: attempt.terminal_transport_status,
    parser_status: attempt.parser_outcome?.status ?? null,
    validation_status: attempt.validation_outcome?.status ?? null,
    persistence_status: attempt.persistence_outcome?.status ?? null,
    durable_record_count: attempt.persistence_outcome?.durable_record_ids?.length ?? 0,
    private_response_retained: false,
    completion_command_id: attempt.completion_command_id,
  }));
  const obligations = Object.values(aggregate.obligations ?? {}).map((obligation) => ({
    obligation_id: obligation.obligation_id,
    parent_obligation_id: obligation.parent_obligation_id ?? null,
    child_obligation_ids: obligation.expected_child_obligation_ids ?? [],
    tier: obligation.tier,
    owner: obligation.owner,
    source_range: obligation.source_range,
    source_fingerprint: obligation.source_fingerprint,
    current_state: obligation.current_state,
    checkpoint_eligible: obligation.checkpoint_eligible === true,
    exact_reason_code: obligation.exact_reason_code,
    next_eligible_action: obligation.next_eligible_action,
    provider_attempt_ids: obligation.provider_attempt_lineage ?? [],
    durable_record_count: obligation.lifecycle?.durably_persisted_record_ids?.length ?? 0,
    unresolved_fragment_count: obligation.lifecycle?.unresolved_fragment_ids?.length ?? 0,
  }));
  const capsules = Object.values(kernel.recovery_capsules ?? {}).map((capsule) => ({
    obligation_leaf_id: capsule.obligation_leaf_id,
    source_range: capsule.source_range,
    source_fingerprint: capsule.source_fingerprint,
    producing_attempt_id: capsule.producing_attempt_id,
    recovery_stage: capsule.recovery_stage,
    protocol: capsule.protocol,
    rejected_fragment_count: capsule.rejected_fragment_ids?.length ?? 0,
    durable_record_count: capsule.durable_record_ids?.length ?? 0,
    private_fragment_payload_available: capsule.private_fragment_payload_available === true,
    source_backed_regeneration_available: capsule.source_backed_regeneration_available === true,
  }));
  const actionReceipts = (kernel.action_receipts ?? []).slice(-256).map((receipt) => ({
    receipt_id: receipt.receipt_id,
    logical_run_id: receipt.logical_run_id,
    obligation_id: receipt.obligation_id,
    action: receipt.action,
    action_handler_revision: receipt.action_handler_revision,
    phase: receipt.phase,
    attempt_id: receipt.attempt_id,
    controller_instance_id: receipt.controller_instance_id,
    controller_generation: receipt.controller_generation,
    reason_code: receipt.reason_code,
    checkpoint: receipt.checkpoint,
    at: receipt.at,
  }));
  return Object.freeze({
    schema_version: 1,
    logical_run_id: aggregate.logical_run_id,
    aggregate_revision: kernel.revision,
    current: status,
    tables: { obligations, attempts, recovery_capsules: capsules,
      action_receipts: actionReceipts },
    semantic_events: structuredClone((kernel.semantic_events ?? []).slice(-256)),
    stale_callbacks: structuredClone((kernel.stale_callbacks ?? []).slice(-64)),
    invariants: { valid: validation.valid, violations: validation.violations },
    privacy: {
      provider_response_bodies_exported: false,
      memory_record_bodies_exported: false,
      private_payload_availability_reported_structurally: true,
    },
  });
}

