import { createMemorizeTierOutcome } from './memorize-tier-outcome.js';

/**
 * Typed boundary around Session's extraction worker. The worker may still
 * throw unexpected implementation or transport faults, but expected
 * cancellation, blocking, and bounded-recovery pauses cross the controller
 * boundary as data for the canonical recovery scheduler.
 */
export async function executeSessionTier(messages, abortCheck = null, options = {},
  extract) {
  if (typeof extract !== 'function') {
    throw new TypeError('Session tier runtime requires an extraction worker.');
  }
  try {
    const added = await extract(messages, abortCheck, options);
    return createMemorizeTierOutcome({
      kind: Number(added ?? 0) > 0 ? 'complete' : 'complete_no_update',
      reason_code: Number(added ?? 0) > 0
        ? 'completed_and_persisted' : 'completed_no_update',
      value: { added: Number(added ?? 0) || 0 },
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'SME_CANCELLED') {
      return createMemorizeTierOutcome({ kind: 'cancelled',
        reason_code: error?.code ?? 'cancelled', evidence: error?.sme_request_diagnostics });
    }
    if (error?.sme_recovery_blocked === true || error?.code === 'SME_RECOVERY_CHANGE_REQUIRED') {
      return createMemorizeTierOutcome({ kind: 'blocked',
        reason_code: error?.sme_reason_code ?? error?.code ?? 'recovery_change_required',
        next_action: error?.sme_request_diagnostics?.next_eligible_recovery_action
          ?? 'change_provider_configuration_or_install_updated_build',
        provider_call_required: false, evidence: error?.sme_request_diagnostics,
        value: { obligation_id: error?.sme_obligation_id ?? null },
      });
    }
    if (error?.sme_operational_pause === true
      || error?.code === 'SME_DOWNSTREAM_VALIDATION_PENDING') {
      const evidence = error?.sme_request_diagnostics ?? {};
      return createMemorizeTierOutcome({ kind: 'policy_paused',
        reason_code: error?.sme_reason_code ?? evidence.pause_reason
          ?? error?.code ?? 'session_recovery_paused',
        next_action: evidence.next_eligible_recovery_action
          ?? evidence.recovery_intent ?? 'resume_exact_obligation',
        provider_call_required: evidence.provider_call_required === true,
        evidence, value: { obligation_id: error?.sme_obligation_id ?? null,
          partial_records_persisted: error?.sme_partial_records_persisted === true },
      });
    }
    throw error;
  }
}
