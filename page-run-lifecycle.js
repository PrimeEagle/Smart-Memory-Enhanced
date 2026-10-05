/** Bounded, content-free evidence about Memorize Chat page lifetimes. */
export const PAGE_RUN_LIFECYCLE_SCHEMA_VERSION = 2;
export const PAGE_RUN_LIFECYCLE_MAX_TRANSITIONS = 24;
export const RUNTIME_LIFECYCLE_MAX_EVENTS = 48;
export const PAGE_INSTANCE_LINEAGE_LIMIT = 24;

export function captureBrowserStartupEvidence(documentLike, performanceLike, pageInstanceId, priorMarker = null) {
  let navigationType = null;
  try { navigationType = performanceLike?.getEntriesByType?.('navigation')?.[0]?.type ?? null; } catch { /* unavailable */ }
  return {
    captured_at: Date.now(),
    page_instance_id: pageInstanceId ?? null,
    prior_page_instance_id: priorMarker?.page_instance_id ?? null,
    prior_page_instance_id_source: priorMarker?.page_instance_id ? 'local_storage_marker' : 'unavailable_at_capture',
    document_was_discarded: documentLike?.wasDiscarded === true,
    visibility_state: documentLike?.visibilityState ?? null,
    navigation_type: navigationType,
    classification: documentLike?.wasDiscarded === true ? 'confirmed_browser_tab_discard' : 'cause_unavailable',
  };
}

/** Classifies only causes established by retained evidence; it never guesses. */
export function classifyPageReplacement(priorMarker, startupEvidence = {}) {
  if (startupEvidence?.document_was_discarded === true) {
    return { cause: 'browser_discard_restoration', outcome: 'confirmed_browser_tab_discard', cause_available: true };
  }
  if (priorMarker?.navigation_intent?.initiator === 'smart_memory_enhanced') {
    return { cause: 'extension_requested_navigation', outcome: 'extension_requested_navigation', cause_available: true };
  }
  if (priorMarker?.navigation_intent?.initiator === 'sillytavern') {
    return { cause: 'sillytavern_requested_navigation', outcome: 'sillytavern_requested_navigation', cause_available: true };
  }
  return {
    cause: 'cause_unavailable', outcome: 'page_instance_replaced_cause_unavailable', cause_available: false,
    limitation: 'browser_navigation_timing_does_not_identify_user_refresh_renderer_failure_or_host_navigation',
  };
}

export function pageRunStorageKey(scope) {
  return `smart-memory-enhanced:page-run:${String(scope ?? 'unknown')}`;
}

export function readPageRunMarker(storage, scope) {
  try {
    const marker = JSON.parse(storage?.getItem(pageRunStorageKey(scope)) ?? 'null');
    return [1, PAGE_RUN_LIFECYCLE_SCHEMA_VERSION].includes(marker?.schema_version) ? marker : null;
  } catch { return null; }
}

export function writePageRunMarker(storage, scope, data) {
  const marker = {
    schema_version: PAGE_RUN_LIFECYCLE_SCHEMA_VERSION,
    run_id: data.run_id,
    page_instance_id: data.page_instance_id,
    phase: data.phase ?? 'source_extraction',
    checkpoint_offset: Number.isInteger(data.checkpoint_offset) ? data.checkpoint_offset : null,
    request_state: data.request_state ?? 'unknown',
    request_attempt: Number.isInteger(data.request_attempt) ? data.request_attempt : null,
    observed_empty_response_count: Number.isInteger(data.observed_empty_response_count) ? data.observed_empty_response_count : 0,
    updated_at: data.updated_at ?? Date.now(),
    status: data.status ?? 'active',
    navigation_intent: data.navigation_intent ?? null,
    lifecycle_snapshot: data.lifecycle_snapshot ?? null,
  };
  try { storage?.setItem(pageRunStorageKey(scope), JSON.stringify(marker)); return marker; }
  catch { return null; }
}

export function clearPageRunMarker(storage, scope, runId) {
  try {
    const marker = readPageRunMarker(storage, scope);
    if (marker?.run_id === runId) storage?.removeItem(pageRunStorageKey(scope));
  } catch { /* Diagnostic sidecar cleanup is best effort. */ }
}

export function ensurePageRunLifecycle(metadata, runId) {
  const prior = metadata?.page_run_lifecycle;
  if (prior?.run_id === runId) {
    prior.schema_version = PAGE_RUN_LIFECYCLE_SCHEMA_VERSION;
    prior.runtime_events ??= [];
    prior.runtime_event_count ??= prior.runtime_events.length;
    prior.page_instance_lineage ??= [];
    prior.controller_mount_count ??= 0;
    prior.controller_unmount_count ??= 0;
    return prior;
  }
  const ledger = {
    schema_version: PAGE_RUN_LIFECYCLE_SCHEMA_VERSION,
    run_id: runId,
    page_instances_observed: 0,
    page_interruption_count: 0,
    unclassified_page_interruption_count: 0,
    retained_transitions: [],
    retained_transition_limit: PAGE_RUN_LIFECYCLE_MAX_TRANSITIONS,
    lineage_complete: true,
    runtime_events: [],
    runtime_event_count: 0,
    page_instance_lineage: [],
    controller_mount_count: 0,
    controller_unmount_count: 0,
  };
  if (metadata) metadata.page_run_lifecycle = ledger;
  return ledger;
}

/** Records privacy-safe evidence for UI/runtime resets that do not replace the page. */
export function recordRuntimeLifecycleEvent(metadata, runId, input = {}) {
  if (!metadata || !runId) return null;
  const ledger = ensurePageRunLifecycle(metadata, runId);
  const allowed = new Set([
    'document_load', 'pageshow', 'pagehide', 'beforeunload', 'visibility_changed',
    'extension_runtime_reinitialized', 'extension_runtime_disposed', 'run_controller_created',
    'run_controller_destroyed', 'ui_remounted', 'service_connection_restarted',
    'route_or_chat_reloaded', 'settings_or_extension_reloaded', 'resume_handler_entered',
    'resume_handler_exited', 'unhandled_exception', 'unhandled_rejection', 'unknown_ui_reset',
    'document_frozen', 'document_resumed', 'page_hidden', 'page_visible',
    'extension_navigation_requested', 'host_navigation_observed',
  ]);
  const event = {
    at: Number(input.at ?? Date.now()),
    classification: allowed.has(input.classification) ? input.classification : 'unknown_ui_reset',
    page_instance_id: input.page_instance_id ?? ledger.current_page_instance_id ?? null,
    subsystem: input.subsystem ?? null,
    phase: input.phase ?? null,
    request_state: input.request_state ?? null,
    normalized_error_type: input.normalized_error_type ?? null,
    stack_fingerprint: input.stack_fingerprint ?? null,
    visibility_state: input.visibility_state ?? null,
    last_durable_phase_transition: input.last_durable_phase_transition ?? null,
    event_origin: input.event_origin ?? 'extension_observer',
    pagehide_persisted: input.pagehide_persisted ?? null,
    navigation_type: input.navigation_type ?? null,
    workload: input.workload ?? null,
  };
  ledger.runtime_event_count++;
  if (event.classification === 'run_controller_created') ledger.controller_mount_count++;
  if (event.classification === 'run_controller_destroyed') ledger.controller_unmount_count++;
  const prior = ledger.runtime_events.at(-1);
  if (prior?.classification === event.classification
    && prior?.request_state === event.request_state
    && prior?.page_instance_id === event.page_instance_id) {
    prior.repeat_count = Number(prior.repeat_count ?? 1) + 1;
    prior.last_at = event.at;
  } else {
    event.repeat_count = 1;
    ledger.runtime_events = [...ledger.runtime_events, event].slice(-RUNTIME_LIFECYCLE_MAX_EVENTS);
  }
  return event;
}

/** A new page is observable; its browser-level cause is not. Never guess one. */
export function reconcilePageRunInstance(metadata, checkpoint, priorMarker, pageInstanceId, now = Date.now(), { freshRun = false, expectedManualResume = false, startupEvidence = null } = {}) {
  if (!metadata || !checkpoint?.run_id) return { interrupted: false, reason: 'no_checkpoint' };
  const ledger = ensurePageRunLifecycle(metadata, checkpoint.run_id);
  const priorId = priorMarker?.run_id === checkpoint.run_id ? priorMarker.page_instance_id : null;
  if (ledger.current_page_instance_id === pageInstanceId) return { interrupted: false, reason: 'same_page_instance' };
  const previousPage = priorId ?? (ledger.current_page_instance_id && ledger.current_page_instance_id !== pageInstanceId ? ledger.current_page_instance_id : null);
  const interrupted = checkpoint.status === 'in_progress' && !expectedManualResume && Boolean(previousPage && previousPage !== pageInstanceId);
  ledger.page_instances_observed++;
  ledger.current_page_instance_id = pageInstanceId;
  ledger.page_instance_lineage = [...(ledger.page_instance_lineage ?? []), {
    page_instance_id: pageInstanceId, observed_at: now, prior_page_instance_id: previousPage,
    prior_page_instance_id_source: priorId ? 'local_storage_marker'
      : previousPage ? 'persisted_page_run_ledger' : 'unavailable',
  }].slice(-PAGE_INSTANCE_LINEAGE_LIMIT);
  const reconciledStartupEvidence = startupEvidence && !startupEvidence.prior_page_instance_id && previousPage
    ? { ...startupEvidence, prior_page_instance_id: previousPage,
      prior_page_instance_id_source: 'persisted_page_run_ledger' }
    : startupEvidence;
  if (!previousPage && checkpoint.status === 'in_progress' && !freshRun) {
    ledger.lineage_complete = false;
    ledger.lineage_gap_reason = 'prior_page_marker_unavailable';
  }
  if (interrupted) {
    const replacement = classifyPageReplacement(priorMarker, startupEvidence);
    ledger.page_interruption_count++;
    if (!replacement.cause_available) ledger.unclassified_page_interruption_count++;
    else if (replacement.cause === 'browser_discard_restoration') {
      ledger.confirmed_browser_tab_discard_count = Number(ledger.confirmed_browser_tab_discard_count ?? 0) + 1;
    } else if (replacement.cause === 'extension_requested_navigation') {
      ledger.extension_requested_navigation_count = Number(ledger.extension_requested_navigation_count ?? 0) + 1;
    } else if (replacement.cause === 'sillytavern_requested_navigation') {
      ledger.sillytavern_requested_navigation_count = Number(ledger.sillytavern_requested_navigation_count ?? 0) + 1;
    }
    const phaseBefore = priorMarker?.phase ?? checkpoint.finalization?.active_phase ?? 'source_extraction';
    const phaseCommitted = Boolean(checkpoint.finalization?.completed_phases?.[phaseBefore]?.completed_at);
    const sourceAdvanced = phaseBefore === 'source_extraction'
      && Number.isInteger(priorMarker?.checkpoint_offset)
      && Number.isInteger(checkpoint.next_source_offset)
      && checkpoint.next_source_offset > priorMarker.checkpoint_offset;
    const transition = {
      at: now, from_page_instance_id: previousPage, to_page_instance_id: pageInstanceId,
      cause: replacement.cause,
      outcome: replacement.outcome,
      cause_available: replacement.cause_available,
      cause_limitation: replacement.limitation ?? null,
      browser_startup_evidence: reconciledStartupEvidence,
      phase_before: phaseBefore,
      phase_after: checkpoint.finalization?.active_phase ?? 'source_extraction',
      checkpoint_offset_before: Number.isInteger(priorMarker?.checkpoint_offset) ? priorMarker.checkpoint_offset : null,
      checkpoint_offset_after: Number.isInteger(checkpoint.next_source_offset) ? checkpoint.next_source_offset : null,
      committed_phase_recovered: phaseCommitted,
      committed_source_advanced: sourceAdvanced,
      request_state_before: priorMarker?.request_state ?? 'unknown',
      request_attempt_before: Number.isInteger(priorMarker?.request_attempt) ? priorMarker.request_attempt : null,
      observed_empty_responses_before: Number(priorMarker?.observed_empty_response_count ?? 0),
      request_outcome: priorMarker?.request_state !== 'in_flight' ? 'no_in_flight_request_observed'
        : phaseCommitted ? 'recovered_from_durable_phase_commit'
          : sourceAdvanced ? 'recovered_from_durable_source_commit'
            : 'completion_uncertain_after_page_interruption',
      prior_lifecycle_snapshot: priorMarker?.lifecycle_snapshot ?? null,
      navigation_intent: priorMarker?.navigation_intent ?? null,
    };
    ledger.retained_transitions = [...ledger.retained_transitions, transition].slice(-PAGE_RUN_LIFECYCLE_MAX_TRANSITIONS);
  }
  return { interrupted, reason: interrupted
    ? classifyPageReplacement(priorMarker, startupEvidence).outcome
    : 'first_observed_page_instance' };
}

export function summarizePageRunLifecycle(metadata, attemptCount = null) {
  const ledger = metadata?.page_run_lifecycle;
  if (!ledger) return null;
  return {
    ...ledger,
    transition_history_scope: 'bounded_retained_events',
    interruption_counts_scope: 'cumulative_logical_run',
    retained_transition_count: ledger.retained_transitions?.length ?? 0,
    retained_history_truncated: ledger.page_interruption_count > (ledger.retained_transitions?.length ?? 0),
    runtime_event_history_scope: 'bounded_privacy_safe_events',
    retained_runtime_event_count: ledger.runtime_events?.length ?? 0,
    runtime_event_history_truncated: Number(ledger.runtime_event_count ?? 0) > (ledger.runtime_events?.length ?? 0),
    interruption_history_available: ledger.lineage_complete !== false,
    manifest_attempt_count: attemptCount,
    attempts_account_for_observed_page_transitions: attemptCount === null ? null : attemptCount >= ledger.page_interruption_count + 1,
  };
}
