/**
 * Explicit ownership for one Memorize Chat controller invocation.
 *
 * This object deliberately outlives the controller's main try block, so the
 * outer catch/finally can always reach the checkpoint, active transaction and
 * cleanup resources that were initialized before a failure.
 */
export function createMemorizeControllerRuntime(input = {}) {
  return {
    invocation_id: input.invocation_id ?? `memorize-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    logical_run_id: input.logical_run_id ?? null,
    attempt_number: input.attempt_number ?? null,
    page_instance_id: input.page_instance_id ?? null,
    checkpoint: input.checkpoint ?? null,
    checkpoint_before: Number(input.checkpoint_before ?? 0) || 0,
    phase: input.phase ?? 'initializing',
    tier: null,
    owner: null,
    source_range: null,
    obligation_id: null,
    active_transaction: null,
    primary_failure: null,
    controller_exit: null,
    cleanup_resources: new Map(),
    cleanup_warnings: [],
  };
}

export function bindMemorizeCheckpoint(runtime, checkpoint) {
  runtime.checkpoint = checkpoint ?? null;
  runtime.logical_run_id = checkpoint?.run_manifest?.logical_run_id
    ?? checkpoint?.run_id ?? runtime.logical_run_id;
  runtime.attempt_number = checkpoint?.run_manifest?.total_attempt_count
    ?? runtime.attempt_number;
  runtime.checkpoint_before = Number(checkpoint?.next_source_offset ?? runtime.checkpoint_before) || 0;
  return runtime;
}

export function trackMemorizeTransaction(runtime, transaction, detail = {}) {
  runtime.active_transaction = transaction ?? null;
  runtime.phase = detail.phase ?? runtime.phase;
  runtime.tier = detail.tier ?? null;
  runtime.owner = detail.owner ?? null;
  runtime.source_range = detail.source_range ?? runtime.source_range;
  runtime.obligation_id = detail.obligation_id ?? runtime.obligation_id;
  return transaction;
}

export function recordMemorizeOperationalPause(runtime, runResult, label, error, tier = null) {
  const checkpoint = runtime?.checkpoint;
  if (!checkpoint) {
    const missing = new Error('Cannot record a Memorize Chat operational pause before its checkpoint is bound.');
    missing.code = 'SME_MEMORIZE_CHECKPOINT_UNBOUND';
    throw missing;
  }
  const pause = {
    label,
    tier,
    reason_code: error?.sme_request_diagnostics?.pause_reason
      ?? error?.sme_request_diagnostics?.reason_code
      ?? error?.code
      ?? 'recovery_request_budget_reached_with_pending_children',
    ...(error?.sme_request_diagnostics ?? {}),
    recorded_at: Date.now(),
  };
  runResult.operationalPauses = [
    ...(runResult.operationalPauses ?? []).filter((item) => item.reason_code !== pause.reason_code
      || item.next_resumable_child !== pause.next_resumable_child),
    pause,
  ].slice(-16);
  checkpoint.operational_pause = pause;
  runtime.phase = 'operational_pause';
  runtime.tier = tier;
  return pause;
}

export function registerMemorizeCleanup(runtime, name, cleanup) {
  runtime.cleanup_resources.set(name, { cleanup, settled: false });
}

export async function cleanupMemorizeRuntime(runtime, onWarning = () => {}) {
  const warnings = [];
  for (const [name, resource] of runtime.cleanup_resources.entries()) {
    if (resource.settled) continue;
    resource.settled = true;
    try {
      await resource.cleanup?.();
    } catch (error) {
      const warning = {
        resource_name: name,
        classification: error?.name ?? 'Error',
        message: String(error?.message ?? error ?? 'Unknown cleanup failure').replace(/\s+/g, ' ').slice(0, 240),
      };
      warnings.push(warning);
      try { onWarning(warning, error); } catch { /* reporting cannot stop cleanup */ }
    }
  }
  runtime.cleanup_warnings.push(...warnings);
  return warnings;
}

export function captureMemorizePrimaryFailure(runtime, error) {
  if (runtime.primary_failure) return runtime.primary_failure;
  runtime.primary_failure = {
    normalized_exception_class: error?.name ?? 'Error',
    code: error?.code ?? null,
    bounded_message: String(error?.message ?? error ?? 'Unknown controller failure').replace(/\s+/g, ' ').slice(0, 300),
    stack_fingerprint_input: String(error?.stack ?? error?.message ?? error ?? 'unknown'),
  };
  return runtime.primary_failure;
}

export function buildMemorizeControllerExit(runtime, input = {}) {
  if (runtime.controller_exit) return runtime.controller_exit;
  const transaction = runtime.active_transaction;
  const failure = runtime.primary_failure;
  runtime.controller_exit = {
    controller_invocation_id: runtime.invocation_id,
    logical_run_id: runtime.logical_run_id,
    attempt_number: runtime.attempt_number,
    page_instance_id: runtime.page_instance_id,
    phase: input.phase ?? runtime.phase,
    tier: input.tier ?? runtime.tier,
    owner: input.owner ?? runtime.owner,
    source_range: input.source_range ?? runtime.source_range,
    obligation_id: input.obligation_id ?? runtime.obligation_id,
    active_transaction_id: transaction?.transaction_id ?? null,
    active_transaction_state: transaction?.state ?? null,
    checkpoint_before: runtime.checkpoint_before,
    checkpoint_after: Number(runtime.checkpoint?.next_source_offset ?? runtime.checkpoint_before) || 0,
    reason_code: input.reason_code ?? failure?.code ?? 'unknown_interruption',
    classification: input.classification ?? (failure ? 'internal_exception' : 'completed'),
    normalized_exception_class: failure?.normalized_exception_class ?? null,
    bounded_message: failure?.bounded_message ?? null,
    stack_fingerprint_input: failure?.stack_fingerprint_input ?? null,
    resumable: input.resumable === true,
    next_eligible_action: input.next_eligible_action ?? null,
    at: input.at ?? Date.now(),
  };
  return runtime.controller_exit;
}

/** Small event adapter used by the real button and deterministic tests. */
export function bindMemorizeChatHandler(button, handler) {
  button.on('click', handler);
  return handler;
}
