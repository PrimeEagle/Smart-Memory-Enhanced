const boundedMessage = (error) => String(error?.message ?? error ?? 'Unknown diagnostic observer failure')
  .replace(/\s+/g, ' ').slice(0, 240);

/** Diagnostics are optional observers: their failure can never escape this boundary. */
export function observeMemorizeDiagnostics(projector, at = Date.now()) {
  try {
    return Object.freeze({ ok: true, value: projector(), failure: null });
  } catch (error) {
    return Object.freeze({
      ok: false,
      value: null,
      failure: Object.freeze({
        category: 'diagnostic_observer_failure',
        origin: 'diagnostic_observer',
        code: error?.code ?? 'SME_DIAGNOSTIC_OBSERVER_FAILURE',
        normalized_exception_class: error?.name ?? 'Error',
        message: boundedMessage(error),
        provider_fault_attribution: false,
        execution_result_preserved: true,
        recorded_at: at,
      }),
    });
  }
}
