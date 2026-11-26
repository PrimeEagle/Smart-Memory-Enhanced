import { cloneSerializableDomain, immutableSerializableDomain }
  from './serializable-domain.js';

function requiredIdentifier(value, field, operationType) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized) return normalized;
  const error = new TypeError(`${field} is required for ${operationType}.`);
  error.code = 'SME_INVALID_DOMAIN_DTO';
  error.sme_reason_code = 'missing_required_domain_identifier';
  error.sme_failure_stage = 'domain_dto_construction';
  error.sme_serialization_path = `$.${field}`;
  throw error;
}

const nullable = (value) => value == null ? null : value;
const nullableFiniteNumber = (value) => value == null ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;
const stringArray = (value) => Array.isArray(value)
  ? [...new Set(value.filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim()))] : [];
const plainArray = (value) => Array.isArray(value) ? value : [];

function canonicalErrorFields(input = {}) {
  const source = input instanceof Error ? input : input ?? {};
  return {
    code: nullable(source.code ?? source.reason_code),
    normalized_exception_class: nullable(source.normalized_exception_class
      ?? source.name),
    bounded_message: nullable(source.bounded_message
      ?? (source.message == null ? null
        : String(source.message).replace(/\s+/g, ' ').slice(0, 300))),
    failure_stage: nullable(source.failure_stage ?? source.sme_failure_stage),
    serialization_path: nullable(source.serialization_path
      ?? source.sme_serialization_path),
    serialization_type: nullable(source.serialization_type
      ?? source.sme_serialization_type),
    operation_type: nullable(source.operation_type ?? source.sme_operation_type),
  };
}

/** Canonical bounded error used by exits, diagnostics, and recovery summaries. */
export function createDiagnosticError(input = {}) {
  const fields = canonicalErrorFields(input);
  return immutableSerializableDomain({ schema_version: 1,
    ...fields, message: fields.bounded_message }, {
    path: '$.diagnostic_error', operation_type: 'diagnostic_error',
    stage: 'domain_dto_construction',
  });
}

/** Canonical immutable transaction state published to a checkpoint. */
export function createTransactionSnapshot(input = {}, at = Date.now()) {
  const transactionId = requiredIdentifier(input.transaction_id,
    'transaction_id', 'transaction_snapshot');
  const state = requiredIdentifier(input.state, 'state', 'transaction_snapshot');
  return immutableSerializableDomain({
    schema_version: 2,
    transaction_id: transactionId,
    state,
    terminal_disposition: nullable(input.terminal_disposition ?? state),
    owner: input.owner ?? {},
    revision: nullableFiniteNumber(input.revision),
    generation: nullableFiniteNumber(input.generation),
    started_at: nullableFiniteNumber(input.started_at),
    settled_at: nullableFiniteNumber(input.settled_at ?? at),
    updated_at: Number.isFinite(Number(at)) ? Number(at) : Date.now(),
    exact_reason_code: nullable(input.exact_reason_code),
    durable_checkpoint_count: Math.max(0,
      nullableFiniteNumber(input.durable_checkpoint_count) ?? 0),
    saga_disposition: nullable(input.saga_disposition
      ?? input.terminal_disposition ?? state),
    durable_subwrites_preserved: input.durable_subwrites_preserved === true,
  }, {
    path: '$.transaction_snapshot', operation_type: 'memorize_transaction_settlement',
    stage: 'domain_dto_construction',
  });
}

/** Canonical controller terminal record; execution handles never enter it. */
export function createControllerExit(input = {}) {
  const controllerInvocationId = requiredIdentifier(input.controller_invocation_id,
    'controller_invocation_id', 'controller_exit');
  const error = canonicalErrorFields(input);
  return immutableSerializableDomain({
    schema_version: 1,
    controller_invocation_id: controllerInvocationId,
    logical_run_id: nullable(input.logical_run_id),
    attempt_number: nullableFiniteNumber(input.attempt_number),
    page_instance_id: nullable(input.page_instance_id),
    phase: nullable(input.phase),
    tier: nullable(input.tier),
    owner: nullable(input.owner),
    source_range: nullable(input.source_range),
    obligation_id: nullable(input.obligation_id),
    active_transaction_id: nullable(input.active_transaction_id),
    active_transaction_state: nullable(input.active_transaction_state),
    checkpoint_before: Math.max(0, nullableFiniteNumber(input.checkpoint_before) ?? 0),
    checkpoint_after: Math.max(0, nullableFiniteNumber(input.checkpoint_after) ?? 0),
    reason_code: requiredIdentifier(input.reason_code, 'reason_code', 'controller_exit'),
    classification: requiredIdentifier(input.classification,
      'classification', 'controller_exit'),
    ...error,
    stack_fingerprint: nullable(input.stack_fingerprint),
    resumable: input.resumable === true,
    next_eligible_action: nullable(input.next_eligible_action),
    at: Number.isFinite(Number(input.at)) ? Number(input.at) : Date.now(),
    finalize_transaction_evidence: input.finalize_transaction_evidence === true,
    transaction_evidence_finalized: input.transaction_evidence_finalized === true,
  }, {
    path: '$.controller_exit', operation_type: 'memorize_controller_exit',
    stage: 'domain_dto_construction', obligation_id: input.obligation_id ?? null,
  });
}

/** Durable evidence that registration, but not necessarily transmission, committed. */
export function createProviderRegistrationReceipt(input = {}) {
  const attemptId = requiredIdentifier(input.attempt_id, 'attempt_id',
    'provider_registration_receipt');
  return immutableSerializableDomain({
    schema_version: 1,
    attempt_id: attemptId,
    logical_run_id: nullable(input.logical_run_id ?? input.run_id),
    obligation_id: requiredIdentifier(input.obligation_id
      ?? input.child_obligation_id ?? input.logical_obligation_id,
    'obligation_id', 'provider_registration_receipt'),
    controller_instance_id: nullable(input.controller_instance_id),
    transaction_id: nullable(input.transaction_id),
    transaction_revision: nullableFiniteNumber(input.transaction_revision),
    registration_state: 'durably_committed',
    transmission_started: input.transmission_started === true,
    registered_at: nullableFiniteNumber(input.registered_at ?? input.at),
  }, {
    path: '$.provider_registration_receipt',
    operation_type: 'provider_attempt_registration',
    stage: 'domain_dto_construction',
  });
}

/** Canonical persisted stale-controller classification. */
export function createStaleControllerAudit(input = {}) {
  const ageAvailable = Number.isFinite(input.age_ms);
  const dto = {
    schema_version: 1,
    stale: input.stale === true,
    age_available: ageAvailable,
    age_status: ageAvailable ? 'available' : 'unavailable_no_heartbeat',
    age_ms: ageAvailable ? Math.max(0, Number(input.age_ms)) : null,
    threshold_ms: Math.max(1, Number.isFinite(Number(input.threshold_ms))
      ? Number(input.threshold_ms) : 300000),
    blockers: stringArray(input.blockers),
    await_point: nullable(input.await_point),
  };
  return immutableSerializableDomain(dto, {
    path: '$.stale_controller_audit', operation_type: 'stale_controller_audit',
    stage: 'domain_dto_construction',
  });
}

/**
 * One stable diagnostic shape for either a canonical-ledger obligation or a
 * provider-audit obligation. Optional source properties never leak through.
 */
export function createUnresolvedObligationSummary(item = {}) {
  const obligationId = requiredIdentifier(item.obligation_id
    ?? item.logical_obligation_id ?? item.root_obligation_id,
  'obligation_id', 'unresolved_obligation_summary');
  const rootObligationId = requiredIdentifier(item.root_obligation_id
    ?? item.logical_obligation_id ?? obligationId,
  'root_obligation_id', 'unresolved_obligation_summary');
  const currentState = nullable(item.current_state ?? item.terminal_outcome);
  const dto = {
    schema_version: 1,
    obligation_id: obligationId,
    root_obligation_id: rootObligationId,
    tier: nullable(item.tier),
    owner: nullable(item.owner),
    source_range: nullable(item.source_range),
    source_fingerprint: nullable(item.source_fingerprint
      ?? item.root_source_fingerprint),
    configuration_signature: nullable(item.configuration_signature),
    stages_attempted: stringArray(item.stages_attempted
      ?? item.recovery_stages_attempted),
    exhausted_stages: stringArray(item.exhausted_stages
      ?? item.exhausted_recovery_stages),
    parser_accepted_candidate_count: nullableFiniteNumber(item.parser_accepted_candidate_count),
    durable_partial_record_count: nullableFiniteNumber(item.durable_partial_record_count),
    staged_partial_record_count: nullableFiniteNumber(item.staged_partial_record_count),
    missing_semantic_unit_count: nullableFiniteNumber(item.missing_semantic_unit_count),
    rejected_fragment_count: nullableFiniteNumber(item.rejected_fragment_count),
    candidate_rejections: plainArray(item.candidate_rejections),
    response_contract: nullable(item.response_contract ?? item.last_response_contract),
    repeated_failure_signature: nullable(item.repeated_failure_signature
      ?? item.last_terminal_signature),
    terminal_signature_repeat_count:
      nullableFiniteNumber(item.terminal_signature_repeat_count),
    replay_count: nullableFiniteNumber(item.replay_count ?? item.retry_replay_count),
    blocked: item.blocked === true || item.recovery_blocked === true
      || ['blocked', 'terminal_failed'].includes(currentState),
    current_state: currentState,
    exact_reason_code: nullable(item.exact_reason_code),
    next_eligible_recovery_action: nullable(item.next_eligible_action
      ?? item.next_eligible_recovery_action),
    recovery_eligibility: nullable(item.recovery_eligibility),
  };
  return immutableSerializableDomain(dto, {
    path: '$.unresolved_obligation_summary',
    operation_type: 'unresolved_obligation_summary', stage: 'domain_dto_construction',
    obligation_id: obligationId,
  });
}

/** Minimal independent export used when the normal diagnostic graph is unavailable. */
export function createCompactFailureDiagnostics(current = {}, createdAt = Date.now()) {
  const recovery = current.catch_up_recovery ?? {};
  const ledger = current.authoritative_obligation_ledger ?? {};
  const controllerExit = current.controller_exit ?? ledger.last_controller_exit ?? null;
  const pending = ledger.pending_obligations?.[0]
    ?? recovery.exact_pending_obligation ?? recovery.unresolved_obligations?.[0] ?? null;
  const attempts = current.provider_attempt_audit?.retained_attempts ?? [];
  const attempt = attempts.at(-1) ?? null;
  const journalEntries = plainArray(current.provider_completion_journal?.entries);
  const transportFailure = journalEntries.findLast((entry) => entry.transport_failure
    && (!pending || entry.child_obligation_id === pending.obligation_id
      || entry.root_obligation_id === pending.obligation_id))?.transport_failure ?? null;
  const rootCode = controllerExit?.code ?? controllerExit?.reason_code ?? recovery.reason_code
    ?? recovery.blocked_reason_code ?? 'incomplete_run';
  const invariantViolations = [
    ...(current.provider_attempt_audit?.reconciliation_violations ?? []),
    ...(current.provider_completion_journal?.reconciliation?.violations ?? []),
    ...(ledger.invariant_violations ?? []),
  ].map((item) => typeof item === 'string' ? { code: item }
    : { code: item?.code ?? item?.invariant_id ?? 'unknown_invariant_violation',
      obligation_id: item?.obligation_id ?? null });
  const rootError = createDiagnosticError({
    code: controllerExit?.bounded_message ? rootCode : transportFailure?.code ?? rootCode,
    bounded_message: controllerExit?.bounded_message ?? transportFailure?.bounded_message,
    failure_stage: controllerExit?.failure_stage ?? transportFailure?.failure_stage,
    serialization_path: controllerExit?.serialization_path,
    serialization_type: controllerExit?.serialization_type,
    operation_type: controllerExit?.operation_type,
    normalized_exception_class: controllerExit?.normalized_exception_class ?? transportFailure?.normalized_exception_class,
  });
  let obligationState = null;
  let obligationProjectionFailure = null;
  if (pending) {
    try {
      obligationState = createUnresolvedObligationSummary(pending);
    } catch (error) {
      obligationProjectionFailure = {
        code: error?.code ?? 'SME_INVALID_OBLIGATION_DIAGNOSTIC_SOURCE',
        serialization_path: nullable(error?.sme_serialization_path),
      };
      obligationState = {
        schema_version: 1,
        obligation_id: nullable(pending?.obligation_id
          ?? pending?.logical_obligation_id ?? pending?.root_obligation_id),
        root_obligation_id: nullable(pending?.root_obligation_id
          ?? pending?.logical_obligation_id ?? pending?.obligation_id),
        tier: nullable(pending?.tier), owner: nullable(pending?.owner),
        current_state: nullable(pending?.current_state ?? pending?.terminal_outcome),
        exact_reason_code: 'diagnostic_source_invalid',
        next_eligible_recovery_action: null,
        blocked: true,
      };
    }
  }
  const coreWorkflowCompleted = current.core_workflow_completed === true;
  const dto = {
    version: 2,
    diagnostic_type: coreWorkflowCompleted
      ? 'diagnostics_projection_failure' : 'incomplete_catchup_recovery',
    created_at: Number.isFinite(Number(createdAt)) ? Number(createdAt) : Date.now(),
    status: coreWorkflowCompleted ? 'completed' : 'incomplete',
    operational_status: coreWorkflowCompleted ? 'completed' : 'incomplete',
    severity: recovery.blocked === true ? 'error' : 'warning',
    build_identity: nullable(current.build_identity),
    logical_run_identity: {
      logical_run_id: nullable(recovery.logical_run?.logical_run_id
        ?? recovery.logical_run_id ?? current.provider_attempt_audit?.run_id),
      attempt_count: nullableFiniteNumber(recovery.logical_run?.attempt_count),
    },
    current_attempt_identity: {
      provider_attempt_id: nullable(attempt?.attempt_id),
      obligation_id: nullable(attempt?.child_obligation_id
        ?? attempt?.logical_obligation_id ?? pending?.obligation_id),
    },
    root_error: rootError,
    transaction_state: nullable(recovery.transaction_state),
    controller_state: {
      controller_invocation_id: nullable(current.controller_heartbeat?.controller_invocation_id
        ?? controllerExit?.controller_invocation_id),
      phase: nullable(current.controller_heartbeat?.phase ?? controllerExit?.phase),
      terminal: current.controller_heartbeat?.terminal === true,
      exit_classification: nullable(controllerExit?.classification),
    },
    obligation_state: obligationState,
    provider_transmission: {
      evidence_available: Boolean(attempt),
      attempt_allocated: Boolean(attempt?.attempt_id),
      attempt_id: nullable(attempt?.attempt_id),
      occurred: attempt?.transmission_started === true,
      lifecycle_state: nullable(attempt?.lifecycle_state
        ?? attempt?.state_history?.at(-1)?.state),
    },
    provider_attempt_evidence: {
      physical_attempt_count: nullableFiniteNumber(current.provider_attempt_audit?.physical_attempts),
      transport_failure: transportFailure,
      recent: attempts.slice(-8).map((item) => ({
        attempt_id: nullable(item.attempt_id),
        obligation_id: nullable(item.logical_obligation_id),
        tier: nullable(item.tier),
        transmission_started: item.transmission_started === true,
        terminal_outcome: nullable(item.terminal_outcome),
        malformed_reason: nullable(item.malformed_reason),
      })),
    },
    committed_coverage: {
      safely_committed_offset: nullableFiniteNumber(recovery.safely_committed_offset
        ?? recovery.logical_run?.cumulative_committed_count),
      source_message_count: nullableFiniteNumber(recovery.source_message_count
        ?? recovery.logical_run?.source_window?.message_count),
    },
    resume: {
      eligible: !coreWorkflowCompleted
        && recovery.resumable === true && recovery.resume_can_make_progress === true,
      blocker: nullable(recovery.blocked_reason_code
        ?? recovery.transaction_resume_block_reason
        ?? (recovery.resumable === true ? null : recovery.reason_code)),
      next_action: coreWorkflowCompleted ? null
        : nullable(recovery.next_eligible_recovery_action),
      provider_call_required: recovery.provider_call_required_on_resume === true,
    },
    invariant_violations: obligationProjectionFailure
      ? [...invariantViolations, obligationProjectionFailure]
      : invariantViolations,
    omitted_sections: [
      { section: 'full_run_diagnostics', reason: 'no_completed_run_projection' },
      { section: 'provider_response_bodies', reason: 'privacy_and_failure_export_boundary' },
    ],
  };
  return immutableSerializableDomain(dto, {
    path: '$.compact_failure_diagnostics', operation_type: 'diagnostics_export',
    stage: 'compact_failure_diagnostics_construction',
  });
}

/**
 * Canonical publication boundary for a complete diagnostics report.
 * Feature-specific sections remain extensible, but the export identity and
 * failure identity are always present and the entire graph is validated and
 * cloned before it can be persisted or handed to the UI.
 */
export function createFullDiagnosticsExport(input = {}, createdAt = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const error = new TypeError('Full diagnostics require a report object.');
    error.code = 'SME_INVALID_DOMAIN_DTO';
    error.sme_failure_stage = 'full_diagnostics_construction';
    error.sme_serialization_path = '$.full_diagnostics';
    throw error;
  }
  const report = cloneSerializableDomain(input, {
    path: '$.full_diagnostics.feature_sections',
    stage: 'full_diagnostics_construction',
    operation_type: 'diagnostics_export',
  });
  const status = requiredIdentifier(report.lifecycle_status
    ?? report.status ?? report.operational_status,
  'status', 'full_diagnostics_export');
  const logicalRunId = report.logical_run?.logical_run_id
    ?? report.run_id ?? null;
  const providerAttempts = report.provider_attempt_audit?.retained_attempts ?? [];
  const latestAttempt = providerAttempts.at(-1) ?? null;
  const controllerExit = report.controller_exit
    ?? report.authoritative_obligation_ledger?.last_controller_exit ?? null;
  const firstError = report.error_details?.[0] ?? null;
  const rootErrorSource = controllerExit ?? report.root_error ?? firstError;

  report.schema_version = 1;
  report.version = 2;
  report.diagnostic_type = report.diagnostic_type ?? 'memorize_chat_run';
  report.created_at = Number.isFinite(Number(report.created_at))
    ? Number(report.created_at)
    : Number.isFinite(Number(createdAt)) ? Number(createdAt) : Date.now();
  report.status = status;
  report.operational_status = requiredIdentifier(
    report.operational_status ?? status,
    'operational_status', 'full_diagnostics_export');
  report.export_identity = {
    build_identity: nullable(report.build_identity),
    logical_run_id: nullable(logicalRunId),
    provider_attempt_id: nullable(latestAttempt?.attempt_id),
    controller_invocation_id: nullable(controllerExit?.controller_invocation_id),
  };
  report.root_error = rootErrorSource ? createDiagnosticError(rootErrorSource) : null;
  report.provider_transmission = {
    evidence_available: Boolean(latestAttempt),
    attempt_allocated: Boolean(latestAttempt?.attempt_id),
    attempt_id: nullable(latestAttempt?.attempt_id),
    occurred: latestAttempt?.transmission_started === true,
    lifecycle_state: nullable(latestAttempt?.lifecycle_state
      ?? latestAttempt?.state_history?.at(-1)?.state),
  };
  return cloneSerializableDomain(report, {
    path: '$.full_diagnostics',
    stage: 'full_diagnostics_publication',
    operation_type: 'diagnostics_export',
  });
}
