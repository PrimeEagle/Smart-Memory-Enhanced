import { projectMemorizeObligationLedger } from './memorize-obligation-ledger.js';

const freeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
};

export function snapshotMemorizeResumeProgress({ checkpoint = null, ledger = null,
  provider_audit: providerAudit = null, retained_evidence_plan: retainedPlan = null,
  at = Date.now() } = {}) {
  const canonicalLedger = ledger ?? checkpoint?.run_manifest?.obligation_ledger ?? null;
  const projection = projectMemorizeObligationLedger(canonicalLedger);
  const pending = projection.next_eligible_obligation
    ?? projection.pending_obligations?.[0] ?? null;
  const snapshot = {
    canonical_obligation_id: pending?.obligation_id ?? null,
    canonical_revision: Number(pending?.revision ?? 0),
    current_state: pending?.current_state ?? null,
    exact_action: retainedPlan?.exact_next_action
      ?? pending?.next_eligible_action ?? null,
    downstream_cursor: retainedPlan?.downstream_cursor ?? null,
    provider_attempt_count: Number(providerAudit?.attempted
      ?? providerAudit?.recent_attempts?.length ?? 0),
    next_source_offset: Number(checkpoint?.next_source_offset ?? 0),
    committed_chunk_count: Number(checkpoint?.committed_chunks ?? 0),
    pending_obligation_count: Number(projection.pending_obligation_count ?? 0),
    captured_at: at,
  };
  return freeze(snapshot);
}

function sameCanonicalState(left, right) {
  return left?.canonical_obligation_id === right?.canonical_obligation_id
    && Number(left?.canonical_revision ?? 0) === Number(right?.canonical_revision ?? 0)
    && left?.current_state === right?.current_state
    && left?.exact_action === right?.exact_action
    && (left?.downstream_cursor ?? null) === (right?.downstream_cursor ?? null)
    && Number(left?.provider_attempt_count ?? 0) === Number(right?.provider_attempt_count ?? 0)
    && Number(left?.next_source_offset ?? 0) === Number(right?.next_source_offset ?? 0)
    && Number(left?.committed_chunk_count ?? 0) === Number(right?.committed_chunk_count ?? 0)
    && Number(left?.pending_obligation_count ?? 0)
      === Number(right?.pending_obligation_count ?? 0);
}

export function deriveMemorizeResumeProgress(before, after, input = {}) {
  const reasons = [];
  if (before?.canonical_obligation_id !== after?.canonical_obligation_id) {
    reasons.push('canonical_obligation_advanced');
  }
  if (Number(after?.canonical_revision ?? 0) > Number(before?.canonical_revision ?? 0)) {
    reasons.push('canonical_obligation_revision_advanced');
  }
  if (before?.exact_action !== after?.exact_action) reasons.push('exact_recovery_action_changed');
  if (before?.downstream_cursor !== after?.downstream_cursor) reasons.push('downstream_cursor_advanced');
  if (Number(after?.provider_attempt_count ?? 0) > Number(before?.provider_attempt_count ?? 0)) {
    reasons.push('provider_attempt_durably_registered');
  }
  if (Number(after?.next_source_offset ?? 0) > Number(before?.next_source_offset ?? 0)) {
    reasons.push('additional_source_coverage_committed');
  }
  if (Number(after?.committed_chunk_count ?? 0) > Number(before?.committed_chunk_count ?? 0)) {
    reasons.push('committed_chunk_count_advanced');
  }
  if (Number(after?.pending_obligation_count ?? 0)
    < Number(before?.pending_obligation_count ?? 0)) reasons.push('pending_obligation_count_decreased');
  const progress = reasons.length > 0;
  return freeze({
    schema_version: 1,
    invocation_id: input.invocation_id ?? null,
    before,
    planned_exact_action: input.planned_exact_action ?? before?.exact_action ?? null,
    action_actually_executed: input.action_actually_executed ?? null,
    provider_request_started: Number(after?.provider_attempt_count ?? 0)
      > Number(before?.provider_attempt_count ?? 0),
    after,
    progress,
    progress_reasons: reasons,
    no_progress_reason: progress ? null : 'resume_no_progress_same_action',
    exact_blocker: progress ? null : input.exact_blocker
      ?? 'canonical_state_and_exact_action_unchanged',
    evaluated_at: input.at ?? Date.now(),
  });
}

export function resumeNoProgressBlockIsCurrent(record, currentSnapshot) {
  return record?.progress === false && record?.no_progress_reason
    === 'resume_no_progress_same_action'
    && sameCanonicalState(record.after, currentSnapshot);
}
