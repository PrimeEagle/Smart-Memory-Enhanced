export const MEMORIZE_FAULT_STAGES = Object.freeze([
  'pre_run_metadata_validation',
  'transaction_snapshot',
  'attempt_plan_construction',
  'attempt_aggregate_validation',
  'registration_persistence',
  'registration_publication',
  'provider_dispatch',
  'provider_response',
  'parser',
  'validation',
  'persistence_plan_construction',
  'storage_execution',
  'receipt_creation',
  'checkpoint_commit',
  'controller_exit',
  'transaction_rollback',
  'diagnostics_projection',
  'compact_diagnostics_export',
]);

/** Reusable deterministic fault hook for release tests and offline harnesses. */
export function createMemorizeFaultInjector({ fail_at: failAt = null,
  code = 'SME_INJECTED_FAULT' } = {}) {
  if (failAt != null && !MEMORIZE_FAULT_STAGES.includes(failAt)) {
    throw new TypeError(`Unknown Memorize fault stage: ${failAt}`);
  }
  const trace = [];
  return Object.freeze({
    fail_at: failAt,
    trace,
    hit(stage, detail = {}) {
      if (!MEMORIZE_FAULT_STAGES.includes(stage)) {
        throw new TypeError(`Unknown Memorize fault stage: ${stage}`);
      }
      trace.push(Object.freeze({ stage,
        obligation_id: detail.obligation_id ?? null,
        attempt_id: detail.attempt_id ?? null }));
      if (stage !== failAt) return Object.freeze({ status: 'passed', stage });
      const error = new Error(`Injected Memorize fault at ${stage}.`);
      error.code = code;
      error.sme_origin = 'injected_test_fault';
      error.sme_reason_code = 'injected_fault';
      error.sme_failure_stage = stage;
      error.sme_obligation_id = detail.obligation_id ?? null;
      error.sme_request_diagnostics = {
        provider_call_required: false,
        retry_eligible: false,
        failure_origin: 'injected_test_fault',
        failure_stage: stage,
        obligation_id: detail.obligation_id ?? null,
      };
      throw error;
    },
  });
}
