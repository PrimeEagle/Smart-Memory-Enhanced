/** Shared identity, reducer-result, and journal-acknowledgement contract. */

export const MEMORIZE_LIFECYCLE_COORDINATOR_VERSION = 1;

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
