/** Durable write-ahead journal for the provider -> canonical-state boundary. */

export const PROVIDER_COMPLETION_JOURNAL_SCHEMA_VERSION = 3;

const terminalSuccess = new Set(['completed', 'completed_no_candidates', 'completed_repartitioned']);
const clone = (value) => value == null ? value : structuredClone(value);
const now = (value) => Number.isFinite(Number(value)) ? Number(value) : Date.now();
const verifiedTransition = (value) => ['applied_verified', 'idempotent_duplicate_verified',
  'not_applicable'].includes(value?.status);

function mergeUnverifiedCallerTransition(priorValue, patchValue) {
  const prior = clone(priorValue) ?? { status: 'pending' };
  if (!patchValue) return prior.status === 'applied' ? {
    ...prior,
    status: 'pending_reconciliation',
    requested_disposition: prior.disposition ?? prior.requested_disposition ?? null,
    legacy_caller_assertion: 'applied',
  } : prior;
  if (verifiedTransition(prior)) return prior;
  const patch = clone(patchValue);
  if (patch.status === 'applied') return {
    ...prior,
    status: 'pending_reconciliation',
    requested_disposition: patch.disposition ?? prior.requested_disposition ?? null,
    legacy_caller_assertion: 'applied',
  };
  return { ...prior, ...patch };
}

function container(metadata) {
  if (!metadata) return null;
  const created = !metadata.provider_completion_journal;
  const priorSchema = Number(metadata.provider_completion_journal?.schema_version ?? 0);
  metadata.provider_completion_journal ??= {
    schema_version: PROVIDER_COMPLETION_JOURNAL_SCHEMA_VERSION,
    entries: {}, order: [], reconciliation: null, runtime_epoch_started_at: Date.now(),
    historical_cutoff_enabled: false,
  };
  if (created || priorSchema < PROVIDER_COMPLETION_JOURNAL_SCHEMA_VERSION) {
    metadata.provider_completion_journal.runtime_epoch_started_at ??= Date.now();
    if (!created && priorSchema < PROVIDER_COMPLETION_JOURNAL_SCHEMA_VERSION) {
      metadata.provider_completion_journal.historical_cutoff_enabled = true;
    }
  }
  metadata.provider_completion_journal.schema_version = PROVIDER_COMPLETION_JOURNAL_SCHEMA_VERSION;
  metadata.provider_completion_journal.entries ??= {};
  metadata.provider_completion_journal.order ??= [];
  return metadata.provider_completion_journal;
}

export function recordProviderCompletion(metadata, attempt, patch = {}) {
  if (!metadata || !attempt?.attempt_id) return null;
  const journal = container(metadata);
  const prior = journal.entries[attempt.attempt_id] ?? {};
  const entry = journal.entries[attempt.attempt_id] = {
    schema_version: PROVIDER_COMPLETION_JOURNAL_SCHEMA_VERSION,
    attempt_id: attempt.attempt_id,
    logical_run_id: attempt.logical_run_id ?? attempt.run_id ?? prior.logical_run_id ?? null,
    root_obligation_id: attempt.root_obligation_id ?? attempt.logical_obligation_id
      ?? prior.root_obligation_id ?? null,
    child_key: patch.child_key ?? prior.child_key ?? null,
    child_obligation_id: patch.child_obligation_id ?? prior.child_obligation_id
      ?? attempt.child_obligation_id ?? attempt.source_unit_key ?? null,
    tier: attempt.tier ?? prior.tier ?? null,
    owner: attempt.owner ?? prior.owner ?? null,
    source_range: clone(attempt.source_range ?? prior.source_range ?? null),
    source_fingerprint: attempt.source_fingerprint ?? prior.source_fingerprint ?? null,
    request_kind: patch.request_kind ?? attempt.request_kind ?? prior.request_kind ?? null,
    recovery_stage: patch.recovery_stage ?? attempt.recovery_stage ?? prior.recovery_stage ?? null,
    provider_disposition: patch.provider_disposition ?? attempt.terminal_outcome
      ?? prior.provider_disposition ?? 'running',
    terminal_outcome: attempt.terminal_outcome ?? prior.terminal_outcome ?? 'running',
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
    completed_at: patch.completed_at ?? prior.completed_at ?? null,
    replay_count: Number(prior.replay_count ?? 0),
    migration: clone(patch.migration ?? prior.migration ?? null),
    adopted_from_logical_run_id: patch.adopted_from_logical_run_id
      ?? prior.adopted_from_logical_run_id ?? null,
    adopted_from_attempt_id: patch.adopted_from_attempt_id
      ?? prior.adopted_from_attempt_id ?? null,
    evidence_adoption_reason: patch.evidence_adoption_reason
      ?? prior.evidence_adoption_reason ?? null,
  };
  if (['committed', 'verified_existing', 'not_needed', 'not_applicable', 'rejected'].includes(entry.persistence.status)
    && verifiedTransition(entry.manifest_transition)
    && verifiedTransition(entry.ledger_transition)) entry.completed_at ??= entry.updated_at;
  journal.order = [...journal.order.filter((id) => id !== attempt.attempt_id), attempt.attempt_id].slice(-256);
  return entry;
}

export function findReplayableProviderCompletion(metadata, input = {}) {
  const journal = container(metadata);
  if (!journal) return null;
  const entries = journal.order.map((id) => journal.entries[id]).filter(Boolean).reverse();
  return entries.find((entry) => terminalSuccess.has(entry.terminal_outcome)
    && entry.root_obligation_id === input.root_obligation_id
    && (!input.child_obligation_id || (entry.child_obligation_id ?? entry.root_obligation_id)
      === input.child_obligation_id)
    && (!input.tier || entry.tier === input.tier)
    && (input.owner === undefined || String(entry.owner ?? '').trim().toLowerCase()
      === String(input.owner ?? '').trim().toLowerCase())
    && (!input.source_range || (Number(entry.source_range?.start) === Number(input.source_range.start)
      && Number(entry.source_range?.end) === Number(input.source_range.end)))
    && entry.source_fingerprint === input.source_fingerprint
    && entry.response_text != null
    && entry.completed_at == null) ?? null;
}

export function migrateTerminalProviderCompletions(metadata, providerAudit, eligibleAttemptIds = null) {
  if (!metadata) return [];
  const journal = container(metadata);
  const migrated = [];
  const eligible = eligibleAttemptIds ? new Set(eligibleAttemptIds) : null;
  for (const attempt of providerAudit?.recent_attempts ?? []) {
    if (!terminalSuccess.has(attempt?.terminal_outcome) || journal.entries[attempt.attempt_id]
      || (eligible && !eligible.has(attempt.attempt_id))) continue;
    const entry = recordProviderCompletion(metadata, attempt, {
      child_key: null,
      persistence: { status: 'unverified', durable_record_ids: [] },
      migration: {
        source: 'legacy_terminal_provider_attempt',
        provider_output_available: false,
        exact_reason_code: 'legacy_terminal_output_not_durably_retained',
      },
    });
    migrated.push(entry);
  }
  return migrated;
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
  const journal = container(metadata);
  return (journal?.order ?? []).map((id) => journal.entries?.[id]).filter(Boolean);
}

export function inspectProviderCompletionConsistency({ metadata, provider_audit, ledger,
  child_manifests, live_health } = {}) {
  const journal = container(metadata) ?? { entries: {}, order: [] };
  const attempts = provider_audit?.recent_attempts ?? [];
  const obligations = ledger?.obligations ?? {};
  const manifests = child_manifests?.roots ?? child_manifests ?? {};
  const runningAttemptIds = new Set(attempts.filter((item) => item?.terminal_outcome === 'running')
    .map((item) => item.attempt_id));
  const violations = [];
  const historicalObservations = [];
  const recordViolation = (violation, attempt = null) => {
    const historical = journal.historical_cutoff_enabled === true
      && attempt && Number(attempt.at ?? 0) > 0
      && Number(attempt.at) < Number(journal.runtime_epoch_started_at ?? 0);
    (historical ? historicalObservations : violations).push({
      ...violation,
      classification: historical ? 'historical_normalized' : 'current_runtime',
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
    unresolved_migration_violations: [],
    historical_observations: historicalObservations,
    informational_compatibility_notices: historicalObservations.length ? [{
      code: 'legacy_completion_journal_observations_normalized',
      count: historicalObservations.length,
    }] : [],
    checked_at: Date.now(),
  };
  if (metadata) journal.reconciliation = result;
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
    && verifiedTransition(entry.ledger_transition)) entry.completed_at ??= Date.now();
  entry.updated_at = Date.now();
  return { replayed: true, entry };
}

export function exportProviderCompletionJournal(metadata) {
  const journal = container(metadata);
  if (!journal) return null;
  return {
    schema_version: journal.schema_version,
    runtime_epoch_started_at: journal.runtime_epoch_started_at ?? null,
    reconciliation: clone(journal.reconciliation),
    entries: journal.order.map((id) => journal.entries[id]).filter(Boolean).map((entry) => ({
      attempt_id: entry.attempt_id, logical_run_id: entry.logical_run_id,
      root_obligation_id: entry.root_obligation_id, child_key: entry.child_key,
      child_obligation_id: entry.child_obligation_id,
      tier: entry.tier, owner: entry.owner, source_range: clone(entry.source_range),
      source_fingerprint: entry.source_fingerprint, terminal_outcome: entry.terminal_outcome,
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
      migration: clone(entry.migration),
      adopted_from_logical_run_id: entry.adopted_from_logical_run_id ?? null,
      adopted_from_attempt_id: entry.adopted_from_attempt_id ?? null,
      evidence_adoption_reason: entry.evidence_adoption_reason ?? null,
    })),
  };
}

