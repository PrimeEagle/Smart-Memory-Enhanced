/** Shared identity, reducer-result, and journal-acknowledgement contract. */

export const MEMORIZE_LIFECYCLE_COORDINATOR_VERSION = 2;

export const PROVIDER_EVIDENCE_INGRESS_OPERATIONS = Object.freeze([
  'register_new_attempt',
  'record_new_response',
  'adopt_exact_prior_run_evidence',
  'continue_pending_downstream_processing',
  'settle_terminal_malformed_attempt',
  'dispatch_exact_recovery_attempt',
  'reconcile_terminal_attempt_evidence',
  'record_provider_transport_failure',
  'record_parser_disposition',
  'record_validation_disposition',
  'record_records_staged',
  'record_durable_persistence',
  'record_explicit_no_update',
  'record_recovery_required',
  'record_obligation_blocked',
  'settle_recovery_exhaustion',
]);

export const PROVIDER_EVIDENCE_INGRESS_STATUSES = Object.freeze([
  'applied', 'idempotent_duplicate_verified', 'pending_downstream_processing',
  'pending_reconciliation', 'operationally_paused', 'blocked', 'rejected',
]);

const TERMINAL_STATES = new Set(['durably_committed', 'explicit_no_update']);
const VERIFIED_RESULT_STATUSES = new Set(['applied', 'idempotent_duplicate_verified']);

function normalizedRange(value = {}) {
  const start = Number(value.start ?? value.source_start_index ?? value.start_offset);
  const end = Number(value.end ?? value.source_end_index ?? value.end_offset);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
  return Object.freeze({ start, end,
    message_count: Math.max(1, Number(value.message_count) || end - start + 1) });
}

export function createMemorizeLifecycleIdentity(input = {}) {
  const range = normalizedRange(input.source_range);
  const root = String(input.root_obligation_id ?? input.logical_obligation_id ?? '').trim();
  const leaf = String(input.leaf_obligation_id ?? input.child_obligation_id
    ?? input.obligation_id ?? root).trim();
  const tier = String(input.tier ?? '').trim();
  const fingerprint = String(input.source_fingerprint ?? '').trim();
  if (!root || !leaf || !tier || !range || !fingerprint) {
    const error = new Error('Memorize lifecycle identity is incomplete.');
    error.code = 'SME_INVALID_LIFECYCLE_IDENTITY';
    error.identity_fields = { root_obligation_id: root || null, leaf_obligation_id: leaf || null,
      tier: tier || null, source_range: range, source_fingerprint: fingerprint || null };
    throw error;
  }
  return Object.freeze({
    schema_version: 1,
    logical_run_id: input.logical_run_id ?? null,
    root_obligation_id: root,
    leaf_obligation_id: leaf,
    parent_obligation_id: input.parent_obligation_id ?? (leaf !== root ? root : null),
    provider_attempt_id: input.provider_attempt_id ?? null,
    tier,
    owner: input.owner ?? null,
    source_range: range,
    source_fingerprint: fingerprint,
    recovery_stage: input.recovery_stage ?? null,
    source_unit_identity: input.source_unit_identity ?? input.source_unit_key ?? null,
  });
}

export function classifyMemorizeLifecycleResult(result, expectedStates = []) {
  const state = result?.obligation?.current_state ?? null;
  const expected = Array.isArray(expectedStates) ? expectedStates : [expectedStates];
  const stateVerified = expected.length === 0 || expected.includes(state);
  if (result?.applied === true && stateVerified) return 'applied';
  if (result?.duplicate === true && stateVerified) return 'idempotent_duplicate_verified';
  return 'rejected';
}

export function requireAppliedLifecycleResult(result, expectedStates = [], context = {}) {
  const status = classifyMemorizeLifecycleResult(result, expectedStates);
  if (VERIFIED_RESULT_STATUSES.has(status)) return Object.freeze({
    status,
    obligation_id: result.obligation?.obligation_id ?? context.obligation_id ?? null,
    resulting_state: result.obligation?.current_state ?? null,
    checkpoint_eligible: result.obligation?.checkpoint_eligible === true,
    semantic_event_id: result.event_id ?? null,
    applied_evidence_fingerprint: context.evidence_fingerprint ?? null,
    reducer_result: result,
  });
  const error = new Error(`Memorize lifecycle transition was rejected${context.stage ? ` at ${context.stage}` : ''}.`);
  error.code = 'SME_LIFECYCLE_TRANSITION_REJECTED';
  error.sme_recovery_blocked = true;
  error.sme_reason_code = result?.violation?.code ?? 'lifecycle_transition_rejected';
  error.sme_obligation_id = context.obligation_id ?? result?.obligation?.obligation_id ?? null;
  error.lifecycle_receipt = {
    status: 'rejected', prior_state: context.prior_state ?? null,
    attempted_event: context.event_type ?? null,
    violation_code: result?.violation?.code ?? null,
    missing_evidence: result?.violation?.missing_evidence ?? [],
    safe_repair_action: result?.violation?.safe_repair_action
      ?? 'reconcile_durable_lifecycle_evidence',
  };
  throw error;
}

export function isTerminalLifecycleReceipt(receipt) {
  return VERIFIED_RESULT_STATUSES.has(receipt?.status)
    && TERMINAL_STATES.has(receipt?.resulting_state)
    && receipt?.checkpoint_eligible === true;
}

export function acknowledgeJournalTransition(entry, component, receipt, details = {}) {
  if (!entry || !['ledger_transition', 'manifest_transition', 'live_health_transition'].includes(component)) {
    throw new Error('Unknown provider-completion journal acknowledgement component.');
  }
  const status = receipt?.status;
  if (!VERIFIED_RESULT_STATUSES.has(status)) {
    entry[component] = {
      status: 'rejected', target_obligation_id: details.target_obligation_id ?? receipt?.obligation_id ?? null,
      requested_disposition: details.disposition ?? null,
      rejection_reason: details.rejection_reason ?? 'unverified_reducer_result',
      acknowledged_at: Date.now(),
    };
    return entry[component];
  }
  const existing = entry[component];
  const targetObligationId = details.target_obligation_id ?? receipt.obligation_id;
  const requestedDisposition = details.disposition ?? null;
  const evidenceFingerprint = details.evidence_fingerprint
    ?? receipt.applied_evidence_fingerprint ?? null;
  if (['applied_verified', 'idempotent_duplicate_verified'].includes(existing?.status)
    && existing.target_obligation_id === targetObligationId
    && existing.requested_disposition === requestedDisposition
    && (existing.evidence_fingerprint ?? null) === evidenceFingerprint) return existing;
  entry[component] = {
    status: status === 'applied' ? 'applied_verified' : 'idempotent_duplicate_verified',
    target_obligation_id: targetObligationId,
    requested_disposition: requestedDisposition,
    reducer_result: status,
    resulting_state: receipt.resulting_state,
    checkpoint_eligible: receipt.checkpoint_eligible,
    semantic_event_id: receipt.semantic_event_id,
    evidence_fingerprint: evidenceFingerprint,
    acknowledged_at: Date.now(),
  };
  return entry[component];
}

export function lifecycleResultStatus(result, expectedStates = []) {
  const status = classifyMemorizeLifecycleResult(result, expectedStates);
  return { ...result, status, resulting_state: result?.obligation?.current_state ?? null,
    checkpoint_eligible: result?.obligation?.checkpoint_eligible === true };
}

function sameOwner(left, right) {
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase();
}

function ingressResult(status, input, patch = {}) {
  return Object.freeze({
    status,
    operation: input.operation,
    obligation_id: input.identity?.leaf_obligation_id ?? null,
    physical_attempt_id: patch.physical_attempt_id ?? input.attempt?.attempt_id
      ?? input.evidence?.attempt_id ?? null,
    prior_state: patch.prior_state ?? input.prior_state ?? null,
    resulting_state: patch.resulting_state ?? null,
    reason_code: patch.reason_code ?? null,
    next_action: patch.next_action ?? null,
    checkpoint_eligible: patch.checkpoint_eligible === true,
    provider_call_required: patch.provider_call_required === true,
    persistence_required: patch.persistence_required === true,
    evidence_fingerprint: patch.evidence_fingerprint ?? null,
    ...patch,
  });
}

function rejectedIngress(input, reasonCode, details = {}) {
  return ingressResult(details.status ?? 'rejected', input, {
    reason_code: reasonCode,
    next_action: details.next_action ?? 'reconcile_terminal_attempt_evidence',
    provider_call_required: details.provider_call_required === true,
    persistence_required: details.persistence_required === true,
    missing_evidence: details.missing_evidence ?? [],
  });
}

/**
 * One explicit ingress for every physical-provider evidence path. This API
 * never infers replay/dispatch from booleans: each operation either produces
 * a verified typed result or returns a fail-closed local action.
 */
export async function coordinateProviderEvidenceIngress(input = {}) {
  if (!PROVIDER_EVIDENCE_INGRESS_OPERATIONS.includes(input.operation)) {
    return rejectedIngress(input, 'unknown_provider_evidence_ingress_operation', {
      next_action: 'inspect_provider_evidence_ingress_operation',
    });
  }
  let identity;
  try {
    identity = createMemorizeLifecycleIdentity(input.identity ?? {});
  } catch (error) {
    return rejectedIngress(input, error.code ?? 'invalid_lifecycle_identity', {
      missing_evidence: Object.entries(error.identity_fields ?? {})
        .filter(([, value]) => value == null).map(([key]) => key),
    });
  }
  const emit = input.emit_lifecycle_event;
  if (typeof emit !== 'function') return rejectedIngress(input,
    'provider_evidence_ingress_missing_lifecycle_reducer');
  const invokeLifecycle = async (type, details) => {
    try {
      return await emit(type, details);
    } catch (error) {
      return {
        status: 'rejected', resulting_state: null, checkpoint_eligible: false,
        error_code: error?.code ?? 'lifecycle_reducer_exception',
        reason_code: error?.sme_reason_code ?? error?.code ?? 'lifecycle_reducer_exception',
        lifecycle_receipt: error?.lifecycle_receipt ?? null,
      };
    }
  };

  if (['register_new_attempt', 'dispatch_exact_recovery_attempt'].includes(input.operation)) {
    if (input.attempt?.attempt_id) {
      const receipt = await invokeLifecycle('provider_attempt_started', {
        provider_attempt_id: input.attempt.attempt_id,
        exact_reason_code: 'provider_request_in_progress',
        recovery_intent: input.attempt.recovery_intent,
        recovery_stage: input.attempt.recovery_stage,
      });
      if (!['applied', 'idempotent_duplicate_verified'].includes(receipt?.status)) {
        return rejectedIngress(input, 'provider_attempt_registration_transition_rejected', {
          next_action: 'reconcile_provider_attempt_registration',
        });
      }
      return ingressResult(receipt.status, { ...input, identity }, {
        attempt: input.attempt, receipt, physical_attempt_id: input.attempt.attempt_id,
        resulting_state: receipt.resulting_state,
        reason_code: 'provider_attempt_registered',
        next_action: 'dispatch_registered_provider_attempt', provider_call_required: true,
      });
    }
    if (typeof input.begin_registered_attempt !== 'function') return rejectedIngress(input,
      'registered_attempt_factory_required', { provider_call_required: false });
    let attempt;
    try {
      attempt = await input.begin_registered_attempt(...(input.begin_args ?? []));
    } catch (error) {
      return rejectedIngress(input, error?.sme_reason_code ?? error?.code
        ?? 'provider_attempt_registration_failed', {
        next_action: 'reconcile_provider_attempt_registration', provider_call_required: false,
      });
    }
    if (!attempt?.attempt_id) return rejectedIngress(input, 'provider_attempt_registration_failed', {
      next_action: 'reconcile_provider_attempt_registration', provider_call_required: false,
    });
    return ingressResult('applied', { ...input, identity, attempt }, {
      attempt, physical_attempt_id: attempt.attempt_id, resulting_state: 'provider_running',
      reason_code: 'provider_attempt_registered', next_action: 'dispatch_registered_provider_attempt',
      provider_call_required: true,
    });
  }

  if (input.operation === 'record_new_response') {
    if (!input.attempt?.attempt_id) return rejectedIngress(input, 'provider_response_missing_registered_attempt', {
      missing_evidence: ['provider_attempt_id'], provider_call_required: false,
    });
    const receipt = await invokeLifecycle('provider_response_received', {
      provider_attempt_id: input.attempt.attempt_id,
      exact_reason_code: 'downstream_parser_pending',
    });
    return ingressResult(receipt?.status ?? 'rejected', { ...input, identity }, {
      receipt, physical_attempt_id: input.attempt.attempt_id,
      resulting_state: receipt?.resulting_state ?? null,
      checkpoint_eligible: receipt?.checkpoint_eligible === true,
      reason_code: receipt?.status === 'rejected' ? 'provider_response_transition_rejected'
        : 'provider_response_recorded',
      next_action: receipt?.status === 'rejected' ? 'reconcile_terminal_attempt_evidence'
        : 'continue_pending_downstream_processing',
      persistence_required: true,
    });
  }

  const downstreamOperation = {
    reconcile_terminal_attempt_evidence: 'terminal_attempt_evidence_reconciled',
    record_provider_transport_failure: 'provider_transport_failed',
    record_records_staged: 'records_staged',
    record_durable_persistence: 'records_durably_persisted',
    record_explicit_no_update: 'explicit_no_update_accepted',
    record_recovery_required: 'recovery_required',
    record_obligation_blocked: 'obligation_blocked',
    settle_recovery_exhaustion: 'recovery_budget_exhausted',
  }[input.operation];
  const dispositionOperation = input.operation === 'record_parser_disposition'
    ? new Set(['parser_accepted', 'parser_partially_accepted', 'parser_rejected'])
    : input.operation === 'record_validation_disposition'
      ? new Set(['validation_accepted', 'validation_partially_accepted', 'validation_rejected'])
      : null;
  if (downstreamOperation || dispositionOperation) {
    const semanticEventType = downstreamOperation ?? input.semantic_event_type;
    if (dispositionOperation && !dispositionOperation.has(semanticEventType)) {
      return rejectedIngress(input, 'invalid_downstream_disposition', {
        next_action: 'inspect_downstream_lifecycle_disposition',
      });
    }
    const receipt = await invokeLifecycle(semanticEventType, input.details ?? {});
    if (!['applied', 'idempotent_duplicate_verified'].includes(receipt?.status)) {
      return rejectedIngress(input, `${semanticEventType}_transition_rejected`, {
        next_action: 'reconcile_downstream_lifecycle_evidence',
        persistence_required: ['records_staged', 'records_durably_persisted']
          .includes(semanticEventType),
      });
    }
    const checkpointEligible = receipt.checkpoint_eligible === true;
    return ingressResult(semanticEventType === 'recovery_budget_exhausted'
      ? 'operationally_paused' : receipt.status, { ...input, identity }, {
      receipt,
      physical_attempt_id: input.details?.provider_attempt_id ?? null,
      resulting_state: receipt.resulting_state,
      checkpoint_eligible: checkpointEligible,
      reason_code: input.details?.exact_reason_code ?? `${semanticEventType}_recorded`,
      next_action: checkpointEligible ? null
        : input.details?.next_eligible_action ?? input.details?.next_action
          ?? (semanticEventType === 'records_staged'
            ? 'persist_staged_records' : 'continue_pending_downstream_processing'),
      provider_call_required: false,
      persistence_required: semanticEventType === 'records_staged',
    });
  }

  if (input.operation === 'adopt_exact_prior_run_evidence') {
    const evidence = input.evidence ?? {};
    const evidenceRange = normalizedRange(evidence.source_range);
    const expectedRange = identity.source_range;
    const evidenceLeaf = evidence.child_obligation_id ?? evidence.leaf_obligation_id
      ?? evidence.root_obligation_id;
    const missing = [];
    if (!evidence.attempt_id) missing.push('physical_attempt_id');
    if (!['completed', 'completed_no_candidates', 'completed_repartitioned']
      .includes(evidence.terminal_outcome)) missing.push('terminal_provider_success');
    if (evidence.root_obligation_id !== identity.root_obligation_id) missing.push('root_obligation_id');
    if (evidenceLeaf !== identity.leaf_obligation_id) missing.push('leaf_obligation_id');
    if (evidence.tier !== identity.tier) missing.push('tier');
    if (!sameOwner(evidence.owner, identity.owner)) missing.push('owner');
    if (!evidenceRange || evidenceRange.start !== expectedRange.start
      || evidenceRange.end !== expectedRange.end) missing.push('source_range');
    if (evidence.source_fingerprint !== identity.source_fingerprint) missing.push('source_fingerprint');
    if (evidence.response_text == null) missing.push('private_terminal_response');
    if (missing.length) return rejectedIngress(input,
      missing.includes('private_terminal_response')
        ? 'exact_prior_run_private_evidence_unavailable' : 'exact_prior_run_evidence_mismatch', {
        status: missing.includes('private_terminal_response') ? 'blocked' : 'rejected',
        missing_evidence: missing,
        next_action: missing.includes('private_terminal_response')
          ? 'inspect_or_restore_private_terminal_evidence' : 'reconcile_exact_prior_run_identity',
      });
    const evidenceFingerprint = input.evidence_fingerprint
      ?? [evidence.logical_run_id, evidence.attempt_id, evidence.source_fingerprint,
        evidence.updated_at ?? evidence.completed_at ?? evidence.started_at ?? ''].join('|');
    const receipt = await invokeLifecycle('terminal_provider_evidence_adopted', {
      provider_attempt_id: evidence.attempt_id,
      evidence_fingerprint: evidenceFingerprint,
      adopted_terminal_evidence: {
        original_logical_run_id: evidence.logical_run_id ?? null,
        original_root_obligation_id: evidence.root_obligation_id,
        original_leaf_obligation_id: evidenceLeaf,
        tier: evidence.tier, owner: evidence.owner ?? null,
        source_range: evidenceRange,
        source_fingerprint: evidence.source_fingerprint,
        request_kind: evidence.request_kind ?? null,
        terminal_outcome: evidence.terminal_outcome,
        private_response_retained: true,
      },
      adopted_from_logical_run_id: evidence.logical_run_id ?? null,
      adopted_from_attempt_id: evidence.attempt_id,
      evidence_adoption_reason: input.evidence_adoption_reason
        ?? 'exact_prior_run_terminal_response_reuse',
    });
    if (!['applied', 'idempotent_duplicate_verified'].includes(receipt?.status)) {
      return rejectedIngress(input, 'terminal_evidence_adoption_rejected', {
        status: 'pending_reconciliation', next_action: 'reconcile_terminal_attempt_evidence',
      });
    }
    return ingressResult('pending_downstream_processing', { ...input, identity }, {
      receipt, physical_attempt_id: evidence.attempt_id,
      prior_state: input.prior_state ?? null,
      resulting_state: receipt.resulting_state,
      checkpoint_eligible: receipt.checkpoint_eligible,
      reason_code: 'exact_prior_run_terminal_evidence_adopted',
      next_action: 'continue_pending_downstream_processing',
      provider_call_required: false, persistence_required: true,
      evidence_fingerprint: evidenceFingerprint,
      response_text: evidence.response_text,
      provenance: {
        adopted_from_logical_run_id: evidence.logical_run_id ?? null,
        adopted_from_attempt_id: evidence.attempt_id,
        evidence_adoption_reason: input.evidence_adoption_reason
          ?? 'exact_prior_run_terminal_response_reuse',
      },
    });
  }

  if (input.operation === 'continue_pending_downstream_processing') {
    const evidence = input.evidence ?? {};
    if (evidence.response_text == null && !(evidence.parser_result?.records?.length)) {
      return rejectedIngress(input, 'accepted_output_private_evidence_unavailable', {
        status: 'blocked', next_action: 'inspect_or_restore_private_terminal_evidence',
        missing_evidence: ['response_text_or_parser_records'],
      });
    }
    return ingressResult('pending_downstream_processing', { ...input, identity }, {
      physical_attempt_id: evidence.attempt_id ?? null,
      resulting_state: input.prior_state ?? 'provider_response_received',
      reason_code: 'accepted_output_pending_downstream_processing',
      next_action: 'continue_pending_downstream_processing',
      provider_call_required: false, persistence_required: true,
      response_text: evidence.response_text ?? null,
      parser_records: evidence.parser_result?.records ?? [],
    });
  }

  const evidence = input.evidence ?? {};
  if (!evidence.attempt_id || evidence.terminal_outcome === 'running') {
    return rejectedIngress(input, 'terminal_malformed_attempt_evidence_required', {
      missing_evidence: ['terminal_physical_attempt'],
    });
  }
  const receipt = await invokeLifecycle('terminal_malformed_attempt_settled', {
    provider_attempt_id: evidence.attempt_id,
    terminal_outcome: evidence.terminal_outcome,
    malformed_reason: evidence.malformed_reason ?? evidence.failure_classification ?? null,
    exact_reason_code: input.reason_code ?? evidence.malformed_reason
      ?? 'terminal_malformed_provider_output',
    next_eligible_action: input.next_action ?? 'dispatch_bounded_recovery_attempt',
    recovery_stage: input.recovery_stage ?? evidence.recovery_stage ?? null,
    operationally_paused: input.operationally_paused === true,
  });
  if (!['applied', 'idempotent_duplicate_verified'].includes(receipt?.status)) {
    return rejectedIngress(input, 'terminal_malformed_settlement_rejected', {
      status: 'pending_reconciliation', next_action: 'settle_terminal_malformed_attempt',
    });
  }
  return ingressResult(input.operationally_paused === true ? 'operationally_paused' : 'pending_reconciliation',
    { ...input, identity }, {
      receipt, physical_attempt_id: evidence.attempt_id,
      resulting_state: receipt.resulting_state,
      reason_code: input.reason_code ?? evidence.malformed_reason
        ?? 'terminal_malformed_provider_output',
      next_action: input.next_action ?? 'dispatch_bounded_recovery_attempt',
      provider_call_required: false, persistence_required: false,
    });
}
