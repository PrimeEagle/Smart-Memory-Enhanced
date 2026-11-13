/** Durable write-ahead journal for the provider -> canonical-state boundary. */

export const PROVIDER_COMPLETION_JOURNAL_SCHEMA_VERSION = 6;

const terminalSuccess = new Set(['completed', 'completed_no_candidates', 'completed_repartitioned']);
const clone = (value) => value == null ? value : structuredClone(value);
const now = (value) => Number.isFinite(Number(value)) ? Number(value) : Date.now();
function deriveCurrentCompletionCursor(entry = {}) {
  if (entry.logical_completed_at != null) return 'fully_terminal';
  if (verifiedTransition(entry.ledger_transition)
    && verifiedTransition(entry.manifest_transition)) return 'canonical_state_applied';
  if (['committed', 'verified_existing', 'not_needed', 'not_applicable']
    .includes(entry.persistence?.status)) return 'persistence_committed';
  if (['accepted', 'partial', 'rejected', 'validated_no_update']
    .includes(entry.validation?.status)) return 'validation_recorded';
  if (entry.parser_result?.status) return 'parser_recorded';
  if (entry.response_text != null) return 'response_journaled';
  return entry.terminal_outcome === 'running' ? 'attempt_registered' : 'attempt_settled';
}
const verifiedTransition = (value) => ['applied_verified', 'idempotent_duplicate_verified',
  'not_applicable'].includes(value?.status);
function mergeUnverifiedCallerTransition(priorValue, patchValue) {
  const prior = clone(priorValue) ?? { status: 'pending' };
  if (!patchValue) return prior.status === 'applied' ? {
    ...prior,
    status: 'pending_reconciliation',
    requested_disposition: prior.disposition ?? prior.requested_disposition ?? null,
    caller_assertion_rejected: 'applied',
  } : prior;
  if (verifiedTransition(prior)) return prior;
  const patch = clone(patchValue);
  if (patch.status === 'applied') return {
    ...prior,
    status: 'pending_reconciliation',
    requested_disposition: patch.disposition ?? prior.requested_disposition ?? null,
    caller_assertion_rejected: 'applied',
  };
  return { ...prior, ...patch };
}

function container(metadata) {
  if (!metadata) return null;
  if (!metadata.provider_completion_journal) {
    metadata.provider_completion_journal = {
      schema_version: PROVIDER_COMPLETION_JOURNAL_SCHEMA_VERSION,
      entries: {}, order: [], reconciliation: null,
    };
  } else if (metadata.provider_completion_journal.schema_version
    !== PROVIDER_COMPLETION_JOURNAL_SCHEMA_VERSION) {
    const error = new Error('Provider completion journal does not use the current schema.');
    error.code = 'SME_MEMORIZE_SCHEMA_UNSUPPORTED';
    error.sme_recovery_blocked = true;
    error.sme_reason_code = 'fresh_start_required';
    throw error;
  }
  if (!metadata.provider_completion_journal.entries
    || !Array.isArray(metadata.provider_completion_journal.order)) {
    const error = new Error('Provider completion journal is incomplete.');
    error.code = 'SME_MEMORIZE_SCHEMA_UNSUPPORTED';
    error.sme_recovery_blocked = true;
    error.sme_reason_code = 'fresh_start_required';
    throw error;
  }
  return metadata.provider_completion_journal;
}

function currentContainerForRead(metadata) {
  const journal = metadata?.provider_completion_journal;
  if (!journal) return null;
  if (journal.schema_version !== PROVIDER_COMPLETION_JOURNAL_SCHEMA_VERSION
    || !journal.entries || !Array.isArray(journal.order)) return null;
  return journal;
}

export function recordProviderCompletion(metadata, attempt, patch = {}) {
  if (!metadata || !attempt?.attempt_id) return null;
  const journal = container(metadata);
  const prior = journal.entries[attempt.attempt_id] ?? {};
  const entry = journal.entries[attempt.attempt_id] = {
    schema_version: PROVIDER_COMPLETION_JOURNAL_SCHEMA_VERSION,
    attempt_id: attempt.attempt_id,
    command_id: patch.command_id ?? prior.command_id ?? null,
    logical_run_id: attempt.logical_run_id ?? attempt.run_id ?? prior.logical_run_id ?? null,
    controller_instance_id: attempt.controller_instance_id
      ?? prior.controller_instance_id ?? null,
    transaction_id: attempt.transaction_id ?? prior.transaction_id ?? null,
    transaction_revision: attempt.transaction_revision
      ?? prior.transaction_revision ?? null,
    transaction_generation: attempt.transaction_generation
      ?? prior.transaction_generation ?? null,
    root_obligation_id: attempt.root_obligation_id ?? attempt.logical_obligation_id
      ?? prior.root_obligation_id ?? null,
    child_key: patch.child_key ?? prior.child_key ?? null,
    child_obligation_id: patch.child_obligation_id ?? prior.child_obligation_id
      ?? attempt.child_obligation_id ?? attempt.source_unit_key ?? null,
    obligation_leaf_id: patch.obligation_leaf_id ?? prior.obligation_leaf_id
      ?? attempt.child_obligation_id ?? attempt.source_unit_key
      ?? attempt.logical_obligation_id ?? null,
    tier: attempt.tier ?? prior.tier ?? null,
    owner: attempt.owner ?? prior.owner ?? null,
    source_range: clone(attempt.source_range ?? prior.source_range ?? null),
    source_fingerprint: attempt.source_fingerprint ?? prior.source_fingerprint ?? null,
    request_kind: patch.request_kind ?? attempt.request_kind ?? prior.request_kind ?? null,
    recovery_stage: patch.recovery_stage ?? attempt.recovery_stage ?? prior.recovery_stage ?? null,
    provider_disposition: patch.provider_disposition ?? attempt.terminal_outcome
      ?? prior.provider_disposition ?? 'running',
    terminal_outcome: attempt.terminal_outcome ?? prior.terminal_outcome ?? 'running',
    physical_terminal_outcome: patch.physical_terminal_outcome
      ?? (attempt.terminal_outcome && attempt.terminal_outcome !== 'running'
        ? attempt.terminal_outcome : prior.physical_terminal_outcome ?? null),
    physical_completed_at: patch.physical_completed_at
      ?? prior.physical_completed_at
      ?? (attempt.terminal_outcome && attempt.terminal_outcome !== 'running'
        ? Number(attempt.at ?? now(patch.at)) + Number(attempt.duration_ms ?? 0) : null),
    response_text: patch.response_text ?? prior.response_text ?? null,
    parser_result: clone(patch.parser_result ?? prior.parser_result ?? null),
    validation: { status: 'pending', ...(prior.validation ?? {}),
      ...(clone(patch.validation) ?? {}) },
    validated_record_identities: clone(patch.validated_record_identities
      ?? prior.validated_record_identities ?? []),
    persistence: { status: 'not_started', durable_record_ids: [],
      ...(prior.persistence ?? {}), ...(clone(patch.persistence) ?? {}) },
    manifest_transition: mergeUnverifiedCallerTransition(
      prior.manifest_transition, patch.manifest_transition),
    ledger_transition: mergeUnverifiedCallerTransition(
      prior.ledger_transition, patch.ledger_transition),
    live_health_event_id: patch.live_health_event_id ?? prior.live_health_event_id ?? null,
    live_health_transition: mergeUnverifiedCallerTransition(
      prior.live_health_transition, patch.live_health_transition),
    started_at: prior.started_at ?? attempt.at ?? now(patch.at),
    updated_at: now(patch.at),
    completed_at: patch.completed_at ?? prior.completed_at
      ?? (attempt.terminal_outcome && attempt.terminal_outcome !== 'running'
        ? Number(attempt.at ?? now(patch.at)) + Number(attempt.duration_ms ?? 0) : null),
    logical_completed_at: patch.logical_completed_at ?? prior.logical_completed_at ?? null,
    downstream_cursor: patch.downstream_cursor ?? prior.downstream_cursor ?? null,
    logical_disposition: patch.logical_disposition ?? prior.logical_disposition ?? null,
    replay_count: Number(prior.replay_count ?? 0),
  };
  if (['committed', 'verified_existing', 'not_needed', 'not_applicable', 'rejected'].includes(entry.persistence.status)
    && verifiedTransition(entry.manifest_transition)
    && verifiedTransition(entry.ledger_transition)) {
    entry.completed_at ??= entry.physical_completed_at ?? entry.updated_at;
    entry.logical_completed_at ??= entry.updated_at;
  }
  entry.downstream_cursor = deriveCurrentCompletionCursor(entry);
  entry.logical_disposition ??= entry.downstream_cursor;
  journal.order = [...journal.order.filter((id) => id !== attempt.attempt_id), attempt.attempt_id].slice(-256);
  return entry;
}

/** Exact current-run lookup. This never ranks, adopts, or scans prior-run evidence. */
export function findCurrentRunProviderCompletion(metadata, input = {}) {
  if (!input.logical_run_id || !input.attempt_id || !input.obligation_leaf_id) return null;
  const journal = currentContainerForRead(metadata);
  if (!journal) return null;
  const entries = journal.order.map((id) => journal.entries[id]).filter(Boolean).reverse();
  return entries.find((entry) => entry.logical_run_id === input.logical_run_id
    && entry.attempt_id === input.attempt_id
    && (entry.obligation_leaf_id ?? entry.child_obligation_id ?? entry.root_obligation_id)
      === input.obligation_leaf_id
    && (!input.command_id || entry.command_id === input.command_id)
    && (!input.controller_generation
      || Number(entry.transaction_generation) === Number(input.controller_generation))
    && (!input.source_fingerprint || entry.source_fingerprint === input.source_fingerprint)) ?? null;
}

export function assessCurrentRunCompletionReplay(metadata, input = {}) {
  const entry = findCurrentRunProviderCompletion(metadata, input);
  if (!entry) return Object.freeze({ replayable: false, reason_code: 'exact_completion_not_found' });
  if (entry.response_text == null) return Object.freeze({
    replayable: false, reason_code: 'provider_response_not_journaled', entry: clone(entry),
  });
  if (entry.logical_completed_at != null || verifiedTransition(entry.ledger_transition)) {
    return Object.freeze({ replayable: false, reason_code: 'completion_command_already_applied',
      already_applied: true, entry: clone(entry) });
  }
  return Object.freeze({ replayable: true, reason_code: 'exact_current_run_completion_available',
    already_applied: false, entry: clone(entry) });
}

export function reconcileImpossibleLiveHealth(metadata, providerAudit, at = Date.now()) {
  const health = metadata?.live_memory_health;
  if (!health) return [];
  const running = providerAudit?.recent_attempts?.filter((item) => item?.terminal_outcome === 'running') ?? [];
  const repairs = [];
  const completionEntries = journalEntriesForHealth(metadata);
  for (const event of health.recent_extraction_events ?? []) {
    if (event?.terminal_health !== 'running') continue;
    const active = running.some((attempt) => attempt.tier === event.tier
      && (attempt.owner ?? null) === (event.owner ?? null));
    if (active) continue;
    const terminal = [...completionEntries].reverse().find((entry) =>
      (entry.live_health_event_id && entry.live_health_event_id === event.event_id)
      || (entry.tier === event.tier && (entry.owner ?? null) === (event.owner ?? null)
        && terminalSuccess.has(entry.terminal_outcome)
        && ['committed', 'verified_existing', 'not_needed'].includes(entry.persistence?.status)));
    if (terminal) {
      event.provider_outcome = terminal.terminal_outcome;
      event.parser_outcome = terminal.parser_result?.status ?? event.parser_outcome ?? 'accepted';
      event.persistence = terminal.persistence?.status ?? 'not_needed';
      event.terminal_health = 'completed';
      event.finished_at = terminal.completed_at ?? terminal.updated_at ?? at;
      event.attention_reason_codes = (event.attention_reason_codes ?? [])
        .filter((code) => code !== 'stale_live_health_reconciled');
      terminal.live_health_transition = {
        status: 'applied_verified', requested_disposition: 'completed', acknowledged_at: at,
      };
      repairs.push({ event_id: event.event_id ?? null,
        attempt_id: terminal.attempt_id, reason_code: 'terminal_journal_completion_applied' });
      continue;
    }
    event.provider_outcome = event.response_received === true
      ? 'terminal_response_pending_downstream_reconciliation'
      : 'interrupted_without_active_provider';
    event.parser_outcome = event.response_received === true
      ? 'downstream_reconciliation_pending' : event.parser_outcome;
    event.persistence = event.persistence === 'not_attempted' ? 'reconciliation_pending' : event.persistence;
    event.terminal_health = 'pending_child_coverage';
    event.finished_at = at;
    event.attention_reason_codes = [...new Set([
      ...(event.attention_reason_codes ?? []), 'stale_live_health_reconciled',
    ])];
    repairs.push({ event_id: event.event_id ?? null, reason_code: 'running_health_without_active_provider' });
  }
  return repairs;
}

function journalEntriesForHealth(metadata) {
  const journal = currentContainerForRead(metadata);
  return (journal?.order ?? []).map((id) => journal.entries?.[id]).filter(Boolean);
}

export function inspectProviderCompletionConsistency({ metadata, provider_audit, ledger,
  child_manifests, live_health, controller_heartbeat: controllerHeartbeat } = {}) {
  const journal = currentContainerForRead(metadata) ?? { entries: {}, order: [] };
  const attempts = provider_audit?.recent_attempts ?? [];
  const obligations = ledger?.obligations ?? {};
  const manifests = child_manifests?.roots ?? child_manifests ?? {};
  const runningAttemptIds = new Set(attempts.filter((item) => item?.terminal_outcome === 'running')
    .map((item) => item.attempt_id));
  const violations = [];
  if (metadata?.provider_completion_journal && !currentContainerForRead(metadata)) {
    violations.push({
      code: 'active_provider_completion_journal_schema_unsupported',
      next_action: 'fresh_start_required',
      provider_call_required: false,
      classification: 'current_runtime',
    });
  }
  if (controllerHeartbeat?.terminal === true && runningAttemptIds.size > 0) {
    violations.push({
      code: 'closed_controller_retains_running_provider_attempt',
      controller_invocation_id: controllerHeartbeat.controller_invocation_id ?? null,
      active_attempt_ids: [...runningAttemptIds],
      next_action: 'settle_orphaned_provider_attempt',
      provider_call_required: false,
    });
  }
  const recordViolation = (violation, attempt = null) => {
    violations.push({
      ...violation,
      classification: 'current_runtime',
    });
  };
  for (const obligation of Object.values(obligations)) {
    if (obligation?.current_state !== 'provider_running') continue;
    const active = (obligation.provider_attempt_lineage ?? []).filter((id) => runningAttemptIds.has(id));
    if (active.length !== 1) violations.push({ code: 'provider_running_without_exactly_one_physical_attempt',
      obligation_id: obligation.obligation_id, active_attempt_ids: active });
  }
  for (const attempt of attempts.filter((item) => item?.terminal_outcome
    && item.terminal_outcome !== 'running')) {
    const obligation = obligations[attempt.logical_obligation_id]
      ?? Object.values(obligations).find((item) => item?.obligation_id === attempt.logical_obligation_id);
    const entry = journal.entries[attempt.attempt_id];
    const matchingChildren = Object.values(manifests).flatMap((manifest) =>
      Object.values(manifest?.children ?? {}).map((child) => ({ manifest, child })))
      .filter(({ manifest, child }) => manifest.root_obligation_id === attempt.logical_obligation_id
        && child.source_fingerprint === attempt.source_fingerprint);
    if (obligation?.current_state === 'provider_running') recordViolation({
      code: 'terminal_attempt_left_obligation_provider_running', attempt_id: attempt.attempt_id,
      obligation_id: attempt.logical_obligation_id, source_range: attempt.source_range,
    }, attempt);
    for (const { child } of matchingChildren.filter(({ child }) => child.state === 'unattempted')) {
      recordViolation({ code: 'completed_attempt_has_unattempted_manifest_child',
        attempt_id: attempt.attempt_id, obligation_id: attempt.logical_obligation_id,
        child_key: child.key, source_range: child.source_range }, attempt);
    }
    if (!entry) recordViolation({ code: 'terminal_attempt_missing_completion_journal',
      attempt_id: attempt.attempt_id, obligation_id: attempt.logical_obligation_id,
      source_range: attempt.source_range }, attempt);
    else if (!['committed', 'not_needed', 'verified_existing', 'not_applicable',
      'discarded', 'rejected'].includes(entry.persistence?.status)) {
      recordViolation({ code: 'terminal_attempt_missing_persistence_disposition',
        attempt_id: attempt.attempt_id, obligation_id: attempt.logical_obligation_id,
        persistence_status: entry.persistence?.status ?? null,
        next_action: 'reconcile_terminal_attempt_evidence',
        provider_call_required: false }, attempt);
    } else if (!verifiedTransition(entry.ledger_transition)) {
      recordViolation({ code: 'terminal_attempt_missing_verified_ledger_acknowledgement',
        attempt_id: attempt.attempt_id, obligation_id: entry.child_obligation_id
          ?? attempt.child_obligation_id ?? attempt.logical_obligation_id,
        ledger_transition_status: entry.ledger_transition?.status ?? null,
        next_action: 'reconcile_terminal_attempt_evidence',
        provider_call_required: false }, attempt);
    }
  }
  for (const event of live_health?.recent_extraction_events ?? []) {
    if (event?.terminal_health !== 'running') continue;
    if (event.response_received === true && event.provider_outcome === 'not_started') violations.push({
      code: 'live_health_response_received_with_provider_not_started', event_id: event.event_id ?? null,
    });
    if (!attempts.some((item) => item.terminal_outcome === 'running'
      && item.tier === event.tier && (item.owner ?? null) === (event.owner ?? null))) violations.push({
      code: 'live_health_running_without_active_provider', event_id: event.event_id ?? null,
      tier: event.tier, owner: event.owner ?? null,
    });
  }
  const result = {
    consistent: violations.length === 0,
    violations,
    current_runtime_violations: violations,
    historical_observations: [],
    checked_at: Date.now(),
  };
  return result;
}

export async function replayProviderCompletion(entry, handlers = {}) {
  if (!entry || !terminalSuccess.has(entry.terminal_outcome)) return { replayed: false, reason: 'not_terminal_success' };
  entry.replay_count = Number(entry.replay_count ?? 0) + 1;
  if (!['committed', 'verified_existing', 'not_needed'].includes(entry.persistence?.status)) {
    const persistence = await handlers.persist?.(clone(entry.parser_result?.records ?? []), entry);
    if (!persistence?.verified) return { replayed: false, reason: 'persistence_unverified', entry };
    entry.persistence = { status: persistence.status ?? 'committed',
      durable_record_ids: [...new Set(persistence.durable_record_ids ?? [])] };
  }
  if (!verifiedTransition(entry.manifest_transition)) {
    const result = await handlers.applyManifest?.(entry);
    entry.manifest_transition = verifiedTransition(result) ? clone(result) : {
      status: 'pending_reconciliation', requested_disposition: 'leaf_covered',
      acknowledged_at: Date.now() };
  }
  if (!verifiedTransition(entry.ledger_transition)) {
    const result = await handlers.applyLedger?.(entry);
    entry.ledger_transition = verifiedTransition(result)
      ? clone(result) : { status: 'pending_reconciliation', acknowledged_at: Date.now() };
  }
  if (!verifiedTransition(entry.live_health_transition)) {
    const result = await handlers.closeHealth?.(entry);
    entry.live_health_transition = verifiedTransition(result)
      ? clone(result) : { status: 'pending_reconciliation',
        requested_disposition: 'completed', acknowledged_at: Date.now() };
  }
  if (verifiedTransition(entry.manifest_transition)
    && verifiedTransition(entry.ledger_transition)) {
    entry.completed_at ??= entry.physical_completed_at ?? Date.now();
    entry.logical_completed_at ??= Date.now();
  }
  entry.updated_at = Date.now();
  return { replayed: true, entry };
}

export function exportProviderCompletionJournal(metadata) {
  const journal = currentContainerForRead(metadata);
  if (!journal) return null;
  return {
    schema_version: journal.schema_version,
    runtime_epoch_started_at: journal.runtime_epoch_started_at ?? null,
    reconciliation: clone(journal.reconciliation),
    entries: journal.order.map((id) => journal.entries[id]).filter(Boolean).map((entry) => ({
      attempt_id: entry.attempt_id, logical_run_id: entry.logical_run_id,
      controller_instance_id: entry.controller_instance_id ?? null,
      transaction_id: entry.transaction_id ?? null,
      transaction_revision: entry.transaction_revision ?? null,
      transaction_generation: entry.transaction_generation ?? null,
      root_obligation_id: entry.root_obligation_id, child_key: entry.child_key,
      child_obligation_id: entry.child_obligation_id,
      tier: entry.tier, owner: entry.owner, source_range: clone(entry.source_range),
      source_fingerprint: entry.source_fingerprint, terminal_outcome: entry.terminal_outcome,
      physical_terminal_outcome: entry.physical_terminal_outcome ?? entry.terminal_outcome,
      physical_completed_at: entry.physical_completed_at ?? null,
      request_kind: entry.request_kind, recovery_stage: entry.recovery_stage,
      provider_disposition: entry.provider_disposition,
      private_response_retained: entry.response_text != null,
      parser_status: entry.parser_result?.status ?? null,
      parser_accepted_count: Number(entry.parser_result?.accepted_count
        ?? entry.parser_result?.records?.length ?? 0),
      validated_record_identities: clone(entry.validated_record_identities ?? []),
      validation: clone(entry.validation),
      persistence: clone(entry.persistence), manifest_transition: clone(entry.manifest_transition),
      ledger_transition: clone(entry.ledger_transition),
      live_health_event_id: entry.live_health_event_id,
      live_health_transition: clone(entry.live_health_transition),
      started_at: entry.started_at, updated_at: entry.updated_at,
      completed_at: entry.completed_at, replay_count: entry.replay_count,
      logical_completed_at: entry.logical_completed_at ?? null,
      downstream_cursor: entry.downstream_cursor
        ?? deriveCurrentCompletionCursor(entry),
      logical_disposition: entry.logical_disposition ?? null,
    })),
  };
}

