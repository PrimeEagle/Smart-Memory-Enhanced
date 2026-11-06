/** Durable write-ahead journal for the provider -> canonical-state boundary. */

import { memorizeObligationStateFingerprint } from './memorize-obligation-ledger.js';

export const PROVIDER_COMPLETION_JOURNAL_SCHEMA_VERSION = 3;

export const PROVIDER_EVIDENCE_PROVENANCE = Object.freeze({
  PRIOR_RUN_ADOPTABLE: 'prior_run_adoptable',
  CURRENT_RUN_CONTINUE_DOWNSTREAM: 'current_run_continue_downstream',
  CURRENT_RUN_RECOVER_FRAGMENTS: 'current_run_recover_fragments',
  ALREADY_TERMINAL: 'already_terminal',
  SUPERSEDED: 'superseded_by_later_attempt',
  MISSING_PRIVATE_EVIDENCE: 'unusable_missing_private_evidence',
  IDENTITY_MISMATCH: 'identity_mismatch',
});

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
    // Compatibility `completed_at` now means physical attempt completion.
    // Logical completion is independently represented below.
    completed_at: patch.completed_at ?? prior.completed_at
      ?? (attempt.terminal_outcome && attempt.terminal_outcome !== 'running'
        ? Number(attempt.at ?? now(patch.at)) + Number(attempt.duration_ms ?? 0) : null),
    logical_completed_at: patch.logical_completed_at ?? prior.logical_completed_at ?? null,
    downstream_cursor: patch.downstream_cursor ?? prior.downstream_cursor ?? null,
    logical_disposition: patch.logical_disposition ?? prior.logical_disposition ?? null,
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
    && verifiedTransition(entry.ledger_transition)) {
    entry.completed_at ??= entry.physical_completed_at ?? entry.updated_at;
    entry.logical_completed_at ??= entry.updated_at;
  }
  entry.downstream_cursor = deriveProviderDownstreamCursor(entry);
  entry.logical_disposition ??= entry.downstream_cursor;
  journal.order = [...journal.order.filter((id) => id !== attempt.attempt_id), attempt.attempt_id].slice(-256);
  return entry;
}

export function findReplayableProviderCompletion(metadata, input = {}) {
  const journal = container(metadata);
  if (!journal) return null;
  const entries = journal.order.map((id) => journal.entries[id]).filter(Boolean).reverse();
  return entries.find((entry) => terminalSuccess.has(entry.terminal_outcome)
    && (!input.current_logical_run_id
      || entry.logical_run_id !== input.current_logical_run_id)
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
    && entry.logical_completed_at == null
    && (entry.completed_at == null || entry.physical_completed_at != null)) ?? null;
}

function exactCompletionIdentity(entry, input = {}) {
  const leaf = entry?.child_obligation_id ?? entry?.root_obligation_id;
  return entry?.root_obligation_id === input.root_obligation_id
    && (!input.child_obligation_id || leaf === input.child_obligation_id)
    && (!input.tier || entry.tier === input.tier)
    && (input.owner === undefined || String(entry.owner ?? '').trim().toLowerCase()
      === String(input.owner ?? '').trim().toLowerCase())
    && (!input.source_range || (Number(entry.source_range?.start) === Number(input.source_range.start)
      && Number(entry.source_range?.end) === Number(input.source_range.end)))
    && entry.source_fingerprint === input.source_fingerprint;
}

/** Furthest verified local stage; physical completion is intentionally separate. */
export function deriveProviderDownstreamCursor(entry = {}, obligation = null) {
  if (obligation?.checkpoint_eligible === true
    || ['durably_committed', 'explicit_no_update'].includes(obligation?.current_state)) {
    return 'fully_terminal';
  }
  const unresolved = obligation?.lifecycle?.unresolved_fragment_ids?.length
    ?? entry.unresolved_fragment_ids?.length ?? 0;
  const durable = obligation?.lifecycle?.durably_persisted_record_ids?.length
    ?? entry.persistence?.durable_record_ids?.length ?? 0;
  if (unresolved > 0 && durable > 0) return 'unresolved_fragments_pending';
  if (['committed', 'verified_existing'].includes(entry.persistence?.status) || durable > 0) {
    return 'accepted_records_persisted';
  }
  if (entry.persistence?.status === 'not_needed') return 'explicit_no_update';
  if (entry.validation?.status && entry.validation.status !== 'pending') return 'validation_complete';
  if (entry.parser_result?.status === 'partial') return 'parser_partial';
  if (entry.parser_result?.status) return 'parser_complete';
  if (entry.response_text != null || entry.provider_disposition === 'response_received') {
    return 'response_recorded';
  }
  return null;
}

/**
 * Pure retained-evidence selector. Same-run continuation can never be routed
 * through prior-run adoption, and persisted partial work selects only its
 * unresolved fragments.
 */
export function classifyRetainedProviderEvidence(entry, input = {}) {
  if (!entry || !exactCompletionIdentity(entry, input)) return {
    classification: PROVIDER_EVIDENCE_PROVENANCE.IDENTITY_MISMATCH,
    downstream_cursor: null, next_action: null,
  };
  const cursor = deriveProviderDownstreamCursor(entry, input.obligation ?? null);
  const laterCompatible = (input.later_attempts ?? []).some((attempt) =>
    attempt?.attempt_id !== entry.attempt_id && exactCompletionIdentity(attempt, input)
    && Number(attempt.started_at ?? attempt.at ?? 0) > Number(entry.started_at ?? 0));
  if (laterCompatible) return {
    classification: PROVIDER_EVIDENCE_PROVENANCE.SUPERSEDED,
    downstream_cursor: cursor, next_action: null,
  };
  if (cursor === 'fully_terminal') return {
    classification: PROVIDER_EVIDENCE_PROVENANCE.ALREADY_TERMINAL,
    downstream_cursor: cursor, next_action: null,
  };
  if (!terminalSuccess.has(entry.terminal_outcome)) return {
    classification: PROVIDER_EVIDENCE_PROVENANCE.IDENTITY_MISMATCH,
    downstream_cursor: cursor, next_action: null,
  };
  const currentRun = Boolean(input.current_logical_run_id)
    && entry.logical_run_id === input.current_logical_run_id;
  if (currentRun && cursor === 'unresolved_fragments_pending') return {
    classification: PROVIDER_EVIDENCE_PROVENANCE.CURRENT_RUN_RECOVER_FRAGMENTS,
    downstream_cursor: cursor, next_action: 'recover_exact_unresolved_fragments',
    provider_call_required: true, persistence_required: false,
  };
  if (entry.response_text == null && !entry.parser_result?.records?.length) return {
    classification: PROVIDER_EVIDENCE_PROVENANCE.MISSING_PRIVATE_EVIDENCE,
    downstream_cursor: cursor, next_action: 'inspect_or_restore_private_terminal_evidence',
  };
  if (currentRun) return {
    classification: PROVIDER_EVIDENCE_PROVENANCE.CURRENT_RUN_CONTINUE_DOWNSTREAM,
    downstream_cursor: cursor, next_action: cursor === 'response_recorded'
      ? 'parse_retained_response' : cursor === 'parser_complete' || cursor === 'parser_partial'
        ? 'continue_validation' : cursor === 'validation_complete'
          ? 'persist_validated_records' : 'continue_pending_downstream_processing',
    provider_call_required: false,
    persistence_required: !['accepted_records_persisted', 'unresolved_fragments_pending']
      .includes(cursor),
  };
  return {
    classification: PROVIDER_EVIDENCE_PROVENANCE.PRIOR_RUN_ADOPTABLE,
    downstream_cursor: cursor, next_action: 'adopt_exact_prior_run_evidence',
    provider_call_required: false, persistence_required: true,
  };
}

export function selectRetainedProviderEvidence(metadata, input = {}) {
  const journal = container(metadata);
  if (!journal) return null;
  const attempts = journal.order.map((id) => journal.entries[id]).filter(Boolean);
  const candidates = attempts.filter((entry) => exactCompletionIdentity(entry, input)).reverse();
  for (const entry of candidates) {
    if (input.exclude_attempt_id && entry.attempt_id === input.exclude_attempt_id) continue;
    const selection = classifyRetainedProviderEvidence(entry, {
      ...input, later_attempts: attempts,
    });
    if (![PROVIDER_EVIDENCE_PROVENANCE.IDENTITY_MISMATCH,
      PROVIDER_EVIDENCE_PROVENANCE.SUPERSEDED,
      PROVIDER_EVIDENCE_PROVENANCE.ALREADY_TERMINAL].includes(selection.classification)) {
      return {
        entry, ...selection,
        selected_obligation_id: input.child_obligation_id ?? input.root_obligation_id ?? null,
        selected_obligation_revision: Number(input.obligation?.revision ?? 0),
        selected_obligation_state_fingerprint:
          memorizeObligationStateFingerprint(input.obligation ?? null),
        selected_at: Date.now(),
      };
    }
  }
  return null;
}

/**
 * Revalidate a retained-evidence decision against the exact canonical leaf at
 * the instant it is applied. A changed leaf is reclassified; terminal coverage
 * is an idempotent success and can never be regressed to response processing.
 */
export function revalidateRetainedProviderEvidenceSelection(selection, input = {}) {
  if (!selection?.entry) return {
    classification: PROVIDER_EVIDENCE_PROVENANCE.IDENTITY_MISMATCH,
    reason_code: 'retained_evidence_selection_missing', changed_since_selection: false,
  };
  const obligation = input.obligation ?? null;
  const currentFingerprint = memorizeObligationStateFingerprint(obligation);
  const changed = Number(selection.selected_obligation_revision ?? 0)
      !== Number(obligation?.revision ?? 0)
    || (selection.selected_obligation_state_fingerprint ?? null) !== currentFingerprint;
  if (obligation?.checkpoint_eligible === true
    || ['durably_committed', 'explicit_no_update'].includes(obligation?.current_state)) {
    return {
      classification: PROVIDER_EVIDENCE_PROVENANCE.ALREADY_TERMINAL,
      downstream_cursor: 'fully_terminal', next_action: null,
      provider_call_required: false, persistence_required: false,
      changed_since_selection: changed,
      selected_obligation_revision: selection.selected_obligation_revision ?? 0,
      applied_obligation_revision: obligation?.revision ?? 0,
      selected_state_fingerprint: selection.selected_obligation_state_fingerprint ?? null,
      applied_state_fingerprint: currentFingerprint,
    };
  }
  return {
    ...classifyRetainedProviderEvidence(selection.entry, { ...input, obligation }),
    changed_since_selection: changed,
    selected_obligation_revision: selection.selected_obligation_revision ?? 0,
    applied_obligation_revision: obligation?.revision ?? 0,
    selected_state_fingerprint: selection.selected_obligation_state_fingerprint ?? null,
    applied_state_fingerprint: currentFingerprint,
  };
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
    && verifiedTransition(entry.ledger_transition)) {
    entry.completed_at ??= entry.physical_completed_at ?? Date.now();
    entry.logical_completed_at ??= Date.now();
  }
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
        ?? deriveProviderDownstreamCursor(entry),
      logical_disposition: entry.logical_disposition ?? null,
      migration: clone(entry.migration),
      adopted_from_logical_run_id: entry.adopted_from_logical_run_id ?? null,
      adopted_from_attempt_id: entry.adopted_from_attempt_id ?? null,
      evidence_adoption_reason: entry.evidence_adoption_reason ?? null,
    })),
  };
}

