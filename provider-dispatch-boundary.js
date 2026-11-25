/**
 * Marks a failure that occurred before the provider transport was invoked.
 * The original Error object and code are retained so controller settlement,
 * recovery selection, UI, and diagnostics observe one root failure.
 *
 * @param {unknown} value
 * @param {{ fallback_stage?: string }} options
 * @returns {Error & Record<string, any>}
 */
export function annotatePreTransmissionFailure(value, options = {}) {
  const error = value instanceof Error ? value
    : Object.assign(new Error(String(value ?? 'Local provider-dispatch preparation failed.')), {
      code: 'SME_LOCAL_DISPATCH_PREPARATION_FAILED', cause: value,
    });
  error.sme_origin ??= 'local_execution';
  error.sme_provider_request_sent = false;
  error.sme_failure_stage ??= options.fallback_stage
    ?? 'provider_dispatch_publication';
  error.sme_request_diagnostics ??= {};
  error.sme_request_diagnostics.transport_started = false;
  error.sme_request_diagnostics.transport_completed = false;
  error.sme_request_diagnostics.provider_call_required = false;
  error.sme_request_diagnostics.retry_eligible = false;
  return error;
}
