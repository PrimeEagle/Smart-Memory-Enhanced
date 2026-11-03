/** Durable controller heartbeat and multi-signal stale classification. */
export const MEMORIZE_CONTROLLER_HEARTBEAT_SCHEMA_VERSION = 1;
export const MEMORIZE_AWAIT_POINTS = new Set([
  'provider_request', 'response_parse', 'downstream_validation', 'canonical_persistence',
  'metadata_save', 'transaction_checkpoint', 'child_manifest_update', 'obligation_update',
  'consolidation', 'injection_refresh', 'controller_cleanup',
]);

export function updateMemorizeControllerHeartbeat(checkpoint, runtime, patch = {}, at = Date.now()) {
  if (!checkpoint) return null;
  const prior = checkpoint.controller_heartbeat ?? {};
  const awaitPoint = patch.await_point ?? prior.await_point ?? null;
  checkpoint.controller_heartbeat = {
    schema_version: MEMORIZE_CONTROLLER_HEARTBEAT_SCHEMA_VERSION,
    controller_invocation_id: runtime?.invocation_id ?? prior.controller_invocation_id ?? null,
    page_instance_id: runtime?.page_instance_id ?? prior.page_instance_id ?? null,
    attempt_number: runtime?.attempt_number ?? prior.attempt_number ?? null,
    phase: patch.phase ?? runtime?.phase ?? prior.phase ?? null,
    tier: patch.tier ?? runtime?.tier ?? prior.tier ?? null,
    owner: patch.owner ?? runtime?.owner ?? prior.owner ?? null,
    root_obligation_id: patch.root_obligation_id ?? runtime?.obligation_id ?? prior.root_obligation_id ?? null,
    child_obligation_id: patch.child_obligation_id ?? prior.child_obligation_id ?? null,
    source_range: patch.source_range ?? runtime?.source_range ?? prior.source_range ?? null,
    active_transaction_id: patch.active_transaction_id ?? runtime?.active_transaction?.transaction_id
      ?? prior.active_transaction_id ?? null,
    active_provider_attempt_id: patch.active_provider_attempt_id ?? prior.active_provider_attempt_id ?? null,
    await_point: MEMORIZE_AWAIT_POINTS.has(awaitPoint) ? awaitPoint : null,
    await_started_at: awaitPoint !== prior.await_point ? at : prior.await_started_at ?? at,
    last_progress_at: patch.progress === false ? prior.last_progress_at ?? at : at,
    last_durable_transition: patch.last_durable_transition ?? prior.last_durable_transition ?? null,
    cancellation_pending: patch.cancellation_pending ?? prior.cancellation_pending ?? false,
    updated_at: at,
  };
  return checkpoint.controller_heartbeat;
}

export function closeMemorizeControllerHeartbeat(checkpoint, runtime, exit = {}, at = Date.now()) {
  if (!checkpoint) return null;
  const prior = checkpoint.controller_heartbeat ?? {};
  checkpoint.controller_heartbeat = {
    ...prior,
    schema_version: MEMORIZE_CONTROLLER_HEARTBEAT_SCHEMA_VERSION,
    controller_invocation_id: runtime?.invocation_id ?? prior.controller_invocation_id ?? null,
    page_instance_id: runtime?.page_instance_id ?? prior.page_instance_id ?? null,
    attempt_number: runtime?.attempt_number ?? prior.attempt_number ?? null,
    phase: 'closed',
    active_transaction_id: null,
    active_provider_attempt_id: null,
    await_point: null,
    await_started_at: null,
    cancellation_pending: false,
    terminal: true,
    exit_classification: exit.classification ?? 'completed',
    exit_reason_code: exit.reason_code ?? null,
    next_eligible_action: exit.next_eligible_action ?? null,
    last_progress_at: at,
    closed_at: at,
    updated_at: at,
  };
  return checkpoint.controller_heartbeat;
}

export function classifyStaleMemorizeController(heartbeat, evidence = {}, at = Date.now()) {
  const threshold = Math.max(1, Number(evidence.stale_threshold_ms ?? 300000));
  const age = heartbeat?.last_progress_at == null ? Infinity : Math.max(0, at - heartbeat.last_progress_at);
  const blockers = [];
  if (age <= threshold) blockers.push('recent_heartbeat');
  if (evidence.provider_running) blockers.push('provider_request_running');
  if (evidence.persistence_running) blockers.push('persistence_running');
  if (evidence.save_running) blockers.push('metadata_save_running');
  if (evidence.background_operation_running) blockers.push('background_operation_running');
  if (evidence.controller_executing) blockers.push('current_controller_executing');
  if (!evidence.transaction_inspectable) blockers.push('transaction_not_inspectable');
  return { stale: blockers.length === 0, age_ms: age, threshold_ms: threshold,
    blockers, await_point: heartbeat?.await_point ?? null };
}
