/**
 * Authoritative Memorize Chat extraction-obligation lifecycle.
 *
 * Provider attempts, parsers, validators, persistence, coverage, checkpoints,
 * diagnostics, and the UI are projections of this ledger.  A provider response
 * is evidence, never completion: only `durably_committed` and
 * `explicit_no_update` make an obligation checkpoint eligible.
 */

export const MEMORIZE_OBLIGATION_LEDGER_SCHEMA_VERSION = 2;
export const MEMORIZE_OBLIGATION_IMPLEMENTATION_VERSION = 4;

export const MEMORIZE_LIFECYCLE_IDENTITY_FIELDS = Object.freeze([
  'parser_accepted_candidate_ids',
  'parser_rejected_fragment_ids',
  'downstream_accepted_candidate_ids',
  'downstream_rejected_candidate_ids',
  'durably_persisted_record_ids',
  'duplicate_candidate_ids',
  'unresolved_fragment_ids',
  'recovered_fragment_ids',
  'explicit_no_update_fragment_ids',
]);

export const MEMORIZE_OBLIGATION_STATES = Object.freeze([
  'unattempted', 'provider_running', 'provider_response_received',
  'parser_accepted', 'parser_partial', 'parser_rejected',
  'validation_accepted', 'validation_partial', 'validation_rejected', 'staged',
  'partial_records_committed', 'explicit_no_update', 'pending_recovery', 'operationally_paused',
  'blocked', 'terminal_failed', 'durably_committed',
]);

const SAFE_STATES = new Set(['durably_committed', 'explicit_no_update']);
const ACTIONABLE_STATES = new Set(['unattempted', 'pending_recovery', 'operationally_paused', 'blocked']);
const nowValue = (value) => Number.isFinite(Number(value)) ? Number(value) : Date.now();

// This table is intentionally exported: tests, migrations, and diagnostics use
// the same lifecycle contract instead of maintaining parallel interpretations.
export const MEMORIZE_OBLIGATION_TRANSITIONS = Object.freeze({
  unattempted: ['provider_running', 'provider_response_received', 'parser_accepted', 'parser_partial',
    'pending_recovery', 'blocked', 'explicit_no_update', 'durably_committed'],
  provider_running: ['provider_response_received', 'operationally_paused', 'pending_recovery', 'blocked', 'terminal_failed', 'durably_committed', 'explicit_no_update'],
  provider_response_received: ['parser_accepted', 'parser_partial', 'parser_rejected', 'validation_accepted', 'validation_partial', 'validation_rejected', 'pending_recovery', 'blocked'],
  parser_accepted: ['validation_accepted', 'validation_partial', 'validation_rejected', 'explicit_no_update', 'pending_recovery', 'durably_committed'],
  parser_partial: ['validation_accepted', 'validation_partial', 'validation_rejected', 'partial_records_committed', 'pending_recovery'],
  parser_rejected: ['pending_recovery', 'operationally_paused', 'blocked', 'terminal_failed'],
  validation_accepted: ['staged', 'durably_committed', 'explicit_no_update', 'pending_recovery'],
  validation_partial: ['staged', 'partial_records_committed', 'pending_recovery'],
  validation_rejected: ['pending_recovery', 'blocked', 'terminal_failed'],
  staged: ['partial_records_committed', 'durably_committed', 'pending_recovery'],
  partial_records_committed: ['provider_running', 'pending_recovery', 'operationally_paused', 'durably_committed', 'explicit_no_update', 'blocked'],
  pending_recovery: ['provider_running', 'provider_response_received', 'parser_accepted', 'parser_partial', 'validation_accepted', 'validation_partial', 'partial_records_committed', 'operationally_paused', 'durably_committed', 'explicit_no_update', 'blocked', 'terminal_failed'],
  operationally_paused: ['provider_running', 'pending_recovery', 'blocked', 'terminal_failed'],
  blocked: ['pending_recovery', 'provider_running', 'terminal_failed'],
  terminal_failed: ['pending_recovery'],
  explicit_no_update: [],
  durably_committed: [],
});

const normalizeIds = (values = []) => [...new Set((Array.isArray(values) ? values : [])
  .filter((value) => value !== null && value !== undefined && String(value).trim())
  .map((value) => String(value)))];

function legacyIds(prefix, count) {
  return Array.from({ length: Math.max(0, Number(count) || 0) }, (_, index) => `${prefix}:${index + 1}`);
}

export function normalizeMemorizeLifecycleIdentity(raw = {}) {
  const metrics = raw.metrics ?? {};
  const verificationIds = metrics.partial_record_verification?.record_ids ?? [];
  const lifecycle = { schema_version: 1, ...(raw.lifecycle ?? {}) };
  const fallbacks = {
    parser_accepted_candidate_ids: legacyIds('legacy-parser-accepted', metrics.parser_accepted_records),
    parser_rejected_fragment_ids: metrics.unresolved_fragment_ids
      ?? legacyIds('legacy-parser-rejected', metrics.parser_rejected_fragments),
    downstream_accepted_candidate_ids: legacyIds('legacy-downstream-accepted', metrics.downstream_valid_records),
    downstream_rejected_candidate_ids: legacyIds('legacy-downstream-rejected', metrics.downstream_rejected_records),
    durably_persisted_record_ids: verificationIds.length ? verificationIds
      : legacyIds('legacy-durable-record', metrics.persisted_records),
    duplicate_candidate_ids: legacyIds('legacy-duplicate', metrics.rejected_duplicates),
    unresolved_fragment_ids: metrics.unresolved_fragment_ids
      ?? legacyIds('legacy-unresolved-fragment', metrics.unresolved_parser_fragments),
    recovered_fragment_ids: [],
    explicit_no_update_fragment_ids: [],
  };
  for (const field of MEMORIZE_LIFECYCLE_IDENTITY_FIELDS) {
    lifecycle[field] = normalizeIds(lifecycle[field]?.length ? lifecycle[field] : fallbacks[field]);
  }
  lifecycle.durable_record_candidate_map = { ...(lifecycle.durable_record_candidate_map ?? {}) };
  lifecycle.counts = Object.fromEntries(MEMORIZE_LIFECYCLE_IDENTITY_FIELDS
    .map((field) => [field.replace(/_ids$/, '_count'), lifecycle[field].length]));
  lifecycle.migrated_from_ambiguous_counts = lifecycle.migrated_from_ambiguous_counts === true
    || (raw.lifecycle == null && Object.values(metrics).some(Number.isFinite));
  return lifecycle;
}

export function deriveMemorizeLifecycleCounts(lifecycleValue = {}) {
  const lifecycle = normalizeMemorizeLifecycleIdentity({ lifecycle: lifecycleValue });
  return { ...lifecycle.counts };
}

function mergeLifecycleIdentity(priorValue, patch = {}) {
  const prior = normalizeMemorizeLifecycleIdentity({ lifecycle: priorValue });
  const next = { ...prior };
  for (const field of MEMORIZE_LIFECYCLE_IDENTITY_FIELDS) {
    next[field] = normalizeIds([...(prior[field] ?? []), ...(patch[field] ?? [])]);
  }
  next.durable_record_candidate_map = {
    ...(prior.durable_record_candidate_map ?? {}),
    ...(patch.durable_record_candidate_map ?? {}),
  };
  next.migrated_from_ambiguous_counts = prior.migrated_from_ambiguous_counts === true
    || patch.migrated_from_ambiguous_counts === true;
  next.counts = Object.fromEntries(MEMORIZE_LIFECYCLE_IDENTITY_FIELDS
    .map((field) => [field.replace(/_ids$/, '_count'), next[field].length]));
  return next;
}

function lifecycleViolations(lifecycle) {
  const violations = [];
  const unresolved = new Set(lifecycle.unresolved_fragment_ids);
  for (const id of lifecycle.recovered_fragment_ids) unresolved.delete(id);
  for (const id of lifecycle.explicit_no_update_fragment_ids) unresolved.delete(id);
  const durable = new Set(lifecycle.durably_persisted_record_ids);
  if (durable.size !== lifecycle.counts.durably_persisted_record_count) {
    violations.push({ code: 'durable_count_not_identity_derived' });
  }
  const parserAccepted = new Set(lifecycle.parser_accepted_candidate_ids);
  const downstreamAccepted = new Set(lifecycle.downstream_accepted_candidate_ids);
  const downstreamRejected = new Set(lifecycle.downstream_rejected_candidate_ids);
  const parserRejected = new Set(lifecycle.parser_rejected_fragment_ids);
  const migrated = lifecycle.migrated_from_ambiguous_counts === true;
  if (!migrated) {
    for (const id of downstreamAccepted) if (!parserAccepted.has(id)) {
      violations.push({ code: 'downstream_acceptance_without_parser_acceptance', candidate_id: id });
    }
    for (const id of downstreamRejected) if (!parserAccepted.has(id)) {
      violations.push({ code: 'downstream_rejection_without_parser_acceptance', candidate_id: id });
    }
    for (const [recordId, candidateId] of Object.entries(lifecycle.durable_record_candidate_map ?? {})) {
      if (!durable.has(recordId)) violations.push({ code: 'durable_mapping_without_record', record_id: recordId });
      if (!downstreamAccepted.has(candidateId)) violations.push({
        code: 'durable_record_without_downstream_acceptance', record_id: recordId, candidate_id: candidateId,
      });
    }
    for (const recordId of durable) if (!lifecycle.durable_record_candidate_map?.[recordId]) {
      violations.push({ code: 'durable_record_missing_candidate_mapping', record_id: recordId });
    }
  }
  for (const id of lifecycle.duplicate_candidate_ids) if (!downstreamRejected.has(id)) {
    violations.push({ code: 'duplicate_without_downstream_rejection', candidate_id: id });
  }
  for (const id of downstreamAccepted) if (downstreamRejected.has(id)) {
    violations.push({ code: 'candidate_has_incompatible_terminal_dispositions', candidate_id: id });
  }
  for (const id of lifecycle.duplicate_candidate_ids) if (downstreamAccepted.has(id)) {
    violations.push({ code: 'accepted_candidate_also_marked_duplicate', candidate_id: id });
  }
  for (const id of lifecycle.recovered_fragment_ids) if (!parserRejected.has(id)) {
    violations.push({ code: 'recovered_unknown_fragment', fragment_id: id });
  }
  for (const id of lifecycle.explicit_no_update_fragment_ids) if (!parserRejected.has(id)) {
    violations.push({ code: 'no_update_unknown_fragment', fragment_id: id });
  }
  for (const id of lifecycle.recovered_fragment_ids) if (lifecycle.explicit_no_update_fragment_ids.includes(id)) {
    violations.push({ code: 'fragment_has_incompatible_terminal_dispositions', fragment_id: id });
  }
  return { violations, unresolved_fragment_ids: [...unresolved] };
}

function normalizeRange(range = {}) {
  const start = Number(range.start ?? range.source_start_index ?? range.start_offset);
  const end = Number(range.end ?? range.source_end_index ?? range.end_offset);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
  return { start, end, message_count: end - start + 1 };
}

function stableId(input = {}) {
  if (input.obligation_id || input.logical_obligation_id) {
    return String(input.obligation_id ?? input.logical_obligation_id);
  }
  const range = normalizeRange(input.source_range ?? input);
  return `${input.tier ?? 'unknown'}:${input.owner ?? 'chat'}:${range?.start ?? 'none'}-${range?.end ?? 'none'}:${input.source_fingerprint ?? 'unknown'}`;
}

function defaultNextAction(state, reasonCode) {
  if (state === 'unattempted') return 'dispatch_provider_request';
  if (state === 'operationally_paused') return 'resume_exact_obligation';
  if (state === 'blocked') return 'change_provider_configuration_or_install_updated_build';
  if (state !== 'pending_recovery') return null;
  if (reasonCode === 'invalid_candidate_shape') return 'session_validation_repair_or_bounded_regeneration';
  if (reasonCode === 'partial_valid_output_has_unresolved_fragments') return 'recover_unresolved_partial_output_fragments';
  if (reasonCode === 'missing_provenance') return 'citation_repair_or_bounded_regeneration';
  return 'resume_exact_obligation';
}

export function createMemorizeObligationLedger(logicalRunId = null, now = Date.now()) {
  return {
    schema_version: MEMORIZE_OBLIGATION_LEDGER_SCHEMA_VERSION,
    implementation_version: MEMORIZE_OBLIGATION_IMPLEMENTATION_VERSION,
    normalization_complete: true,
    logical_run_id: logicalRunId,
    obligations: {},
    recovery_backlog: [],
    transition_violations: [],
    controller_exits: [],
    created_at: now,
    updated_at: now,
  };
}

export function ensureMemorizeObligationLedger(value, logicalRunId = null) {
  const ledger = value && typeof value === 'object'
    ? value : createMemorizeObligationLedger(logicalRunId);
  if (ledger.schema_version === MEMORIZE_OBLIGATION_LEDGER_SCHEMA_VERSION
    && ledger.implementation_version === MEMORIZE_OBLIGATION_IMPLEMENTATION_VERSION
    && ledger.normalization_complete === true
    && ledger.obligations && typeof ledger.obligations === 'object') {
    ledger.logical_run_id ??= logicalRunId;
    return ledger;
  }
  ledger.schema_version = MEMORIZE_OBLIGATION_LEDGER_SCHEMA_VERSION;
  ledger.implementation_version = MEMORIZE_OBLIGATION_IMPLEMENTATION_VERSION;
  ledger.logical_run_id ??= logicalRunId;
  ledger.obligations ??= {};
  ledger.recovery_backlog = Array.isArray(ledger.recovery_backlog) ? ledger.recovery_backlog : [];
  ledger.transition_violations = Array.isArray(ledger.transition_violations) ? ledger.transition_violations.slice(-64) : [];
  ledger.controller_exits = Array.isArray(ledger.controller_exits) ? ledger.controller_exits.slice(-32) : [];
  for (const [key, raw] of Object.entries(ledger.obligations)) {
    const id = stableId({ ...raw, obligation_id: raw?.obligation_id ?? key });
    const lifecycle = normalizeMemorizeLifecycleIdentity(raw);
    const verification = raw?.metrics?.partial_record_verification;
    const falseNegativeV0972 = raw?.exact_reason_code === 'committed_partial_record_verification_failed'
      && lifecycle.durably_persisted_record_ids.length > 0
      && Number(verification?.verified_count ?? 0) === lifecycle.durably_persisted_record_ids.length
      && lifecycle.unresolved_fragment_ids.length > 0;
    if (falseNegativeV0972) {
      lifecycle.downstream_accepted_candidate_ids = legacyIds(
        `migrated-downstream-accepted:${id}`, lifecycle.durably_persisted_record_ids.length);
      lifecycle.counts.downstream_accepted_candidate_count = lifecycle.downstream_accepted_candidate_ids.length;
    }
    const state = falseNegativeV0972 ? 'pending_recovery'
      : MEMORIZE_OBLIGATION_STATES.includes(raw?.current_state) ? raw.current_state : 'unattempted';
    ledger.obligations[id] = {
      obligation_id: id,
      logical_run_id: raw?.logical_run_id ?? ledger.logical_run_id,
      tier: raw?.tier ?? 'unknown', owner: raw?.owner ?? null,
      source_range: normalizeRange(raw?.source_range ?? raw) ?? null,
      source_fingerprint: raw?.source_fingerprint ?? null,
      parent_obligation_id: raw?.parent_obligation_id ?? null,
      expected_child_obligation_ids: [...new Set(raw?.expected_child_obligation_ids ?? [])],
      provider_attempt_lineage: [...new Set(raw?.provider_attempt_lineage ?? [])].slice(-64),
      parser_result: raw?.parser_result ?? null,
      downstream_validation_result: raw?.downstream_validation_result ?? null,
      persistence_result: raw?.persistence_result ?? null,
      partial_record_persistence: raw?.partial_record_persistence ?? (Number(raw?.metrics?.persisted_records ?? 0) > 0 ? {
        status: 'committed', persisted_record_count: Number(raw.metrics.persisted_records),
        producing_provider_attempt_id: raw.metrics?.producing_provider_attempt_id ?? null,
      } : null),
      recovery_attempt_persistence_result: raw?.recovery_attempt_persistence_result ?? null,
      coverage_result: raw?.coverage_result ?? null,
      checkpoint_eligible: SAFE_STATES.has(state),
      current_state: state,
      exact_reason_code: falseNegativeV0972
        ? 'partial_valid_output_has_unresolved_fragments' : raw?.exact_reason_code ?? null,
      next_eligible_action: falseNegativeV0972
        ? 'recover_unresolved_partial_output_fragments'
        : raw?.next_eligible_action ?? defaultNextAction(state, raw?.exact_reason_code),
      recovery_intent: falseNegativeV0972
        ? 'recover_unresolved_partial_output_fragments'
        : raw?.recovery_intent ?? raw?.next_eligible_action
          ?? defaultNextAction(state, raw?.exact_reason_code),
      recovery_stage: falseNegativeV0972 ? 'fragment_decision_regeneration'
        : raw?.recovery_stage ?? null,
      timestamps: { ...(raw?.timestamps ?? {}) },
      transition_history: Array.isArray(raw?.transition_history) ? raw.transition_history.slice(-64) : [],
      implementation_version: MEMORIZE_OBLIGATION_IMPLEMENTATION_VERSION,
      schema_version: MEMORIZE_OBLIGATION_LEDGER_SCHEMA_VERSION,
      metrics: { ...(raw?.metrics ?? {}) },
      lifecycle,
      recovery_epochs: falseNegativeV0972 ? [...(raw?.recovery_epochs ?? []), {
        schema_version: 1,
        reason_code: 'v0.9.72_parser_count_persistence_count_migration',
        status: 'pending',
        unresolved_fragment_ids: [...lifecycle.unresolved_fragment_ids],
        durably_persisted_record_ids: [...lifecycle.durably_persisted_record_ids],
        migrated_at: Date.now(),
      }].slice(-16) : [...(raw?.recovery_epochs ?? [])],
    };
    const normalized = ledger.obligations[id];
    normalized.metrics.parser_accepted_records = lifecycle.counts.parser_accepted_candidate_count;
    normalized.metrics.parser_rejected_fragments = lifecycle.counts.parser_rejected_fragment_count;
    normalized.metrics.downstream_valid_records = lifecycle.counts.downstream_accepted_candidate_count;
    normalized.metrics.downstream_rejected_records = lifecycle.counts.downstream_rejected_candidate_count;
    normalized.metrics.persisted_records = lifecycle.counts.durably_persisted_record_count;
    normalized.metrics.unresolved_parser_fragments = lifecycle.counts.unresolved_fragment_count;
    normalized.metrics.unresolved_fragment_ids = [...lifecycle.unresolved_fragment_ids];
    if (falseNegativeV0972) normalized.metrics.partial_record_verification = {
      ...(verification ?? {}),
      verified: true,
      expected_count: lifecycle.durably_persisted_record_ids.length,
      verified_count: lifecycle.durably_persisted_record_ids.length,
      record_ids: [...lifecycle.durably_persisted_record_ids],
      reconstruction: 'durable_record_ids_migrated_from_v0.9.72',
    };
    if (falseNegativeV0972) {
      ledger.recovery_backlog.push({
        obligation_id: id, tier: raw?.tier ?? 'unknown', owner: raw?.owner ?? null,
        source_range: normalizeRange(raw?.source_range ?? raw),
        source_fingerprint: raw?.source_fingerprint ?? null,
        unresolved_fragment_ids: [...lifecycle.unresolved_fragment_ids],
        next_eligible_action: 'recover_unresolved_partial_output_fragments',
      });
    }
    if (id !== key) delete ledger.obligations[key];
  }
  ledger.recovery_backlog = [...new Map(ledger.recovery_backlog
    .map((item) => [item.obligation_id, item])).values()];
  ledger.normalization_complete = true;
  return ledger;
}

export function transitionMemorizeObligation(ledgerValue, input = {}, transition = {}) {
  const ledger = ensureMemorizeObligationLedger(ledgerValue, input.logical_run_id);
  const id = stableId(input);
  const prior = ledger.obligations[id] ?? {};
  let state = transition.current_state ?? input.current_state ?? prior.current_state ?? 'unattempted';
  if (!MEMORIZE_OBLIGATION_STATES.includes(state)) throw new Error(`Unknown Memorize obligation state: ${state}`);
  const providerAttemptRegistered = Boolean(transition.provider_attempt_id);
  if (state === 'provider_running' && !providerAttemptRegistered) {
    state = prior.current_state === 'provider_running' ? 'pending_recovery'
      : prior.current_state ?? 'pending_recovery';
  }
  const at = nowValue(transition.at);
  const priorState = prior.current_state ?? 'unattempted';
  if (prior.current_state && state !== priorState
    && !(MEMORIZE_OBLIGATION_TRANSITIONS[priorState] ?? []).includes(state)) {
    ledger.transition_violations.push({
      code: 'illegal_obligation_state_transition', obligation_id: id,
      from: priorState, to: state, at,
    });
    ledger.transition_violations = ledger.transition_violations.slice(-64);
  }
  const reason = transition.exact_reason_code ?? transition.reason_code ?? prior.exact_reason_code ?? null;
  const range = normalizeRange(input.source_range ?? prior.source_range ?? input);
  const durablePartialCount = Math.max(Number(prior.metrics?.persisted_records ?? 0),
    Number(transition.metrics?.persisted_records ?? 0));
  const requestedPersistence = transition.persistence_result ?? prior.persistence_result ?? null;
  const persistenceResult = durablePartialCount > 0
    && (!requestedPersistence || requestedPersistence === 'not_committed')
    ? 'partial_records_committed' : requestedPersistence;
  const lifecyclePatch = { ...(transition.lifecycle ?? {}) };
  const transitionPersistedCount = Number(transition.metrics?.persisted_records ?? 0);
  if (transitionPersistedCount > 0 && !(lifecyclePatch.durably_persisted_record_ids?.length)) {
    lifecyclePatch.durably_persisted_record_ids = legacyIds(`legacy-durable-record:${id}`, transitionPersistedCount);
    lifecyclePatch.migrated_from_ambiguous_counts = true;
  }
  if (Number(transition.metrics?.parser_accepted_records ?? 0) > 0
    && !(lifecyclePatch.parser_accepted_candidate_ids?.length)) {
    lifecyclePatch.parser_accepted_candidate_ids = legacyIds(`legacy-parser-accepted:${id}`,
      transition.metrics.parser_accepted_records);
    lifecyclePatch.migrated_from_ambiguous_counts = true;
  }
  if (Number(transition.metrics?.parser_rejected_fragments ?? 0) > 0
    && !(lifecyclePatch.parser_rejected_fragment_ids?.length)) {
    lifecyclePatch.parser_rejected_fragment_ids = transition.metrics.unresolved_fragment_ids
      ?? legacyIds(`legacy-parser-rejected:${id}`, transition.metrics.parser_rejected_fragments);
    lifecyclePatch.unresolved_fragment_ids ??= [...lifecyclePatch.parser_rejected_fragment_ids];
    lifecyclePatch.migrated_from_ambiguous_counts = true;
  }
  const next = {
    ...prior,
    obligation_id: id,
    logical_run_id: input.logical_run_id ?? prior.logical_run_id ?? ledger.logical_run_id,
    tier: input.tier ?? prior.tier ?? 'unknown',
    owner: input.owner ?? prior.owner ?? null,
    source_range: range,
    source_fingerprint: input.source_fingerprint ?? prior.source_fingerprint ?? null,
    parent_obligation_id: input.parent_obligation_id ?? prior.parent_obligation_id ?? null,
    expected_child_obligation_ids: [...new Set(input.expected_child_obligation_ids ?? prior.expected_child_obligation_ids ?? [])],
    provider_attempt_lineage: [...new Set([
      ...(prior.provider_attempt_lineage ?? []),
      ...(transition.provider_attempt_id ? [transition.provider_attempt_id] : []),
      ...(transition.provider_attempt_lineage ?? []),
    ])].slice(-64),
    parser_result: transition.parser_result ?? prior.parser_result ?? null,
    downstream_validation_result: transition.downstream_validation_result ?? prior.downstream_validation_result ?? null,
    persistence_result: persistenceResult,
    partial_record_persistence: durablePartialCount > 0 ? {
      status: 'committed', persisted_record_count: durablePartialCount,
      producing_provider_attempt_id: transition.metrics?.producing_provider_attempt_id
        ?? prior.metrics?.producing_provider_attempt_id ?? null,
    } : prior.partial_record_persistence ?? null,
    recovery_attempt_persistence_result: transition.persistence_result ?? null,
    coverage_result: transition.coverage_result ?? prior.coverage_result ?? null,
    current_state: state,
    checkpoint_eligible: SAFE_STATES.has(state),
    exact_reason_code: SAFE_STATES.has(state) ? null
      : transition.current_state === 'provider_running' && !providerAttemptRegistered
        ? 'provider_attempt_registration_required' : reason,
    next_eligible_action: SAFE_STATES.has(state) ? null
      : transition.next_eligible_action ?? defaultNextAction(state, reason),
    recovery_intent: SAFE_STATES.has(state) ? null
      : transition.recovery_intent ?? transition.next_eligible_action
        ?? prior.recovery_intent ?? defaultNextAction(state, reason),
    recovery_stage: SAFE_STATES.has(state) ? null
      : transition.recovery_stage ?? prior.recovery_stage ?? null,
    timestamps: {
      ...(prior.timestamps ?? {}),
      created_at: prior.timestamps?.created_at ?? at,
      updated_at: at,
      [`entered_${state}_at`]: at,
    },
    transition_history: [...(prior.transition_history ?? []), {
      from: priorState, to: state, at,
      permitted: !prior.current_state || state === priorState
        || (MEMORIZE_OBLIGATION_TRANSITIONS[priorState] ?? []).includes(state),
      evidence: {
        provider_attempt_id: transition.provider_attempt_id ?? null,
        parser_result: transition.parser_result ?? null,
        downstream_validation_result: transition.downstream_validation_result ?? null,
        persistence_result: transition.persistence_result ?? null,
        durable_record_ids_added: [...(lifecyclePatch.durably_persisted_record_ids ?? [])],
        fragment_ids_added: [...(lifecyclePatch.unresolved_fragment_ids ?? [])],
      },
      checkpoint_effect: SAFE_STATES.has(state) ? 'eligible' : 'ineligible',
      controller_exit_effect: ['blocked', 'terminal_failed', 'operationally_paused'].includes(state)
        ? 'controller_must_exit_or_select_safe_next_action' : 'none',
    }].slice(-64),
    implementation_version: MEMORIZE_OBLIGATION_IMPLEMENTATION_VERSION,
    schema_version: MEMORIZE_OBLIGATION_LEDGER_SCHEMA_VERSION,
    metrics: { ...(prior.metrics ?? {}), ...(transition.metrics ?? {}) },
    lifecycle: mergeLifecycleIdentity(prior.lifecycle, lifecyclePatch),
  };
  const lifecycleState = lifecycleViolations(next.lifecycle);
  next.lifecycle.unresolved_fragment_ids = lifecycleState.unresolved_fragment_ids;
  next.lifecycle.counts.unresolved_fragment_count = lifecycleState.unresolved_fragment_ids.length;
  next.lifecycle.invariants = {
    valid: lifecycleState.violations.length === 0,
    violations: lifecycleState.violations,
  };
  // Compatibility counters remain projections only. They can no longer be
  // used as persistence or recovery truth.
  next.metrics.parser_accepted_records = next.lifecycle.counts.parser_accepted_candidate_count;
  next.metrics.parser_rejected_fragments = next.lifecycle.counts.parser_rejected_fragment_count;
  next.metrics.downstream_valid_records = next.lifecycle.counts.downstream_accepted_candidate_count;
  next.metrics.downstream_rejected_records = next.lifecycle.counts.downstream_rejected_candidate_count;
  next.metrics.persisted_records = next.lifecycle.counts.durably_persisted_record_count;
  next.metrics.unresolved_parser_fragments = next.lifecycle.counts.unresolved_fragment_count;
  next.metrics.unresolved_fragment_ids = [...next.lifecycle.unresolved_fragment_ids];
  ledger.obligations[id] = next;
  const backlogEntry = {
    obligation_id: id, tier: next.tier, owner: next.owner,
    source_range: next.source_range, source_fingerprint: next.source_fingerprint,
    unresolved_fragment_ids: [...next.lifecycle.unresolved_fragment_ids],
    next_eligible_action: next.next_eligible_action,
  };
  ledger.recovery_backlog = [
    ...ledger.recovery_backlog.filter((item) => item.obligation_id !== id),
    ...(!next.checkpoint_eligible && next.lifecycle.unresolved_fragment_ids.length ? [backlogEntry] : []),
  ];
  ledger.updated_at = at;
  return next;
}

/** Repairs persisted running states when no physical provider attempt is active. */
export function reconcileMemorizeRunningObligations(ledgerValue, providerAudit = null) {
  const ledger = ensureMemorizeObligationLedger(ledgerValue);
  const runningAttempts = new Map((providerAudit?.recent_attempts ?? [])
    .filter((attempt) => attempt?.terminal_outcome === 'running' && attempt?.logical_obligation_id)
    .map((attempt) => [attempt.logical_obligation_id, attempt]));
  const repairs = [];
  for (const obligation of Object.values(ledger.obligations)) {
    if (obligation.current_state !== 'provider_running') continue;
    const running = runningAttempts.get(obligation.obligation_id);
    if (running) {
      if (!obligation.provider_attempt_lineage.includes(running.attempt_id)) {
        obligation.provider_attempt_lineage.push(running.attempt_id);
      }
      continue;
    }
    const persisted = Number(obligation.metrics?.persisted_records ?? 0);
    obligation.current_state = 'pending_recovery';
    obligation.checkpoint_eligible = false;
    obligation.exact_reason_code = 'stale_provider_running_without_physical_attempt';
    obligation.next_eligible_action = Number(obligation.metrics?.unresolved_parser_fragments ?? 0) > 0
      ? 'recover_unresolved_partial_output_fragments'
      : obligation.recovery_intent ?? 'resume_exact_obligation';
    obligation.recovery_intent = obligation.next_eligible_action;
    obligation.recovery_stage = 'resume_epoch_initialization';
    if (persisted > 0) {
      obligation.persistence_result = 'partial_records_committed';
      obligation.partial_record_persistence = {
        status: 'committed', persisted_record_count: persisted,
        producing_provider_attempt_id: obligation.metrics?.producing_provider_attempt_id ?? null,
      };
    }
    obligation.timestamps ??= {};
    obligation.timestamps.reconciled_stale_provider_running_at = Date.now();
    repairs.push({ obligation_id: obligation.obligation_id,
      reason_code: obligation.exact_reason_code, persisted_records_preserved: persisted });
  }
  if (repairs.length) ledger.updated_at = Date.now();
  return { ledger, repairs };
}

export function recordMemorizeControllerExit(ledgerValue, input = {}) {
  const ledger = ensureMemorizeObligationLedger(ledgerValue, input.logical_run_id);
  const invocationId = input.controller_invocation_id ?? null;
  const existing = invocationId
    ? ledger.controller_exits.find((item) => item.controller_invocation_id === invocationId)
    : null;
  const exitPriority = (classification) => ({
    completed: 10, awaiting_actionable_recovery: 20, downstream_validation_pending: 30,
    operationally_paused: 30, manually_cancelled: 40,
    transaction_commit_failure: 80, transaction_rollback_failure: 90, internal_exception: 100,
  }[classification] ?? 50);
  if (existing && exitPriority(input.classification) <= exitPriority(existing.classification)) return existing;
  const reasonCode = input.reason_code ?? 'unknown_interruption';
  const record = {
    at: nowValue(input.at), reason_code: reasonCode,
    classification: input.classification ?? reasonCode,
    resumable: input.resumable !== false,
    controller_invocation_id: invocationId,
    logical_run_id: input.logical_run_id ?? ledger.logical_run_id,
    attempt_number: input.attempt_number ?? null,
    page_instance_id: input.page_instance_id ?? null,
    phase: input.phase ?? null,
    tier: input.tier ?? null,
    owner: input.owner ?? null,
    source_range: normalizeRange(input.source_range ?? {}) ?? null,
    obligation_id: input.obligation_id ?? null,
    active_transaction_id: input.active_transaction_id ?? null,
    active_transaction_state: input.active_transaction_state ?? null,
    checkpoint_before: Number.isFinite(Number(input.checkpoint_before)) ? Number(input.checkpoint_before) : null,
    checkpoint_after: Number.isFinite(Number(input.checkpoint_after)) ? Number(input.checkpoint_after) : null,
    normalized_exception_class: input.normalized_exception_class ?? null,
    bounded_message: input.bounded_message ?? null,
    stack_fingerprint: input.stack_fingerprint ?? null,
    next_eligible_action: input.next_eligible_action ?? null,
    detail: input.detail ?? null,
  };
  ledger.controller_exits = [
    ...ledger.controller_exits.filter((item) => item.controller_invocation_id !== invocationId),
    record,
  ].slice(-32);
  ledger.updated_at = record.at;
  return record;
}

export function projectMemorizeObligationLedger(ledgerValue) {
  const ledger = ensureMemorizeObligationLedger(ledgerValue);
  const obligations = Object.values(ledger.obligations);
  const safe = obligations.filter((item) => item.checkpoint_eligible);
  const pending = obligations.filter((item) => !item.checkpoint_eligible);
  const actionable = pending.filter((item) => ACTIONABLE_STATES.has(item.current_state)
    && item.exact_reason_code && item.next_eligible_action);
  const running = pending.filter((item) => item.current_state === 'provider_running');
  const paused = pending.filter((item) => item.current_state === 'operationally_paused');
  const blocked = pending.filter((item) => item.current_state === 'blocked');
  const terminalFailed = pending.filter((item) => item.current_state === 'terminal_failed');
  const byTier = Object.fromEntries([...new Set(obligations.map((item) => item.tier))].map((tier) => {
    const scoped = obligations.filter((item) => item.tier === tier);
    return [tier, {
      total_obligation_count: scoped.length,
      safely_committed_obligation_count: scoped.filter((item) => item.checkpoint_eligible).length,
      pending_obligations: scoped.filter((item) => !item.checkpoint_eligible),
      coverage_complete: scoped.length > 0 && scoped.every((item) => item.checkpoint_eligible),
    }];
  }));
  const chunks = {};
  for (const item of obligations) {
    const key = item.source_range ? `${item.source_range.start}-${item.source_range.end}` : `unknown:${item.obligation_id}`;
    const chunk = chunks[key] ??= { source_range: item.source_range, obligation_ids: [], pending_obligation_ids: [], status: 'completed' };
    chunk.obligation_ids.push(item.obligation_id);
    if (!item.checkpoint_eligible) {
      chunk.pending_obligation_ids.push(item.obligation_id);
      chunk.status = item.tier === 'session' ? 'pending_session_recovery' : 'pending_recovery';
    }
  }
  const violations = [];
  for (const item of pending) {
    if (!ACTIONABLE_STATES.has(item.current_state)) violations.push({ code: 'uncommitted_obligation_not_actionable', obligation_id: item.obligation_id });
    if (!item.exact_reason_code) violations.push({ code: 'uncommitted_obligation_missing_exact_reason', obligation_id: item.obligation_id });
    if (!item.next_eligible_action) violations.push({ code: 'uncommitted_obligation_missing_next_action', obligation_id: item.obligation_id });
  }
  for (const [key, chunk] of Object.entries(chunks)) {
    if (chunk.status === 'completed' && chunk.pending_obligation_ids.length) violations.push({ code: 'completed_chunk_has_pending_tier', chunk: key });
  }
  violations.push(...(ledger.transition_violations ?? []));
  for (const item of obligations) {
    for (const violation of item.lifecycle?.invariants?.violations ?? []) {
      violations.push({ ...violation, obligation_id: item.obligation_id });
    }
  }
  return {
    schema_version: ledger.schema_version,
    implementation_version: ledger.implementation_version,
    logical_run_id: ledger.logical_run_id,
    obligation_count: obligations.length,
    safely_committed_obligation_count: safe.length,
    pending_obligation_count: pending.length,
    actionable_pending_obligation_count: actionable.length,
    operationally_paused_obligation_count: paused.length,
    blocked_obligation_count: blocked.length,
    running_obligation_count: running.length,
    terminal_failed_obligation_count: terminalFailed.length,
    pending_obligations: pending,
    next_eligible_obligation: actionable[0] ?? null,
    tier_coverage: byTier,
    chunks: Object.values(chunks),
    controller_exits: ledger.controller_exits,
    last_controller_exit: ledger.controller_exits.at(-1) ?? null,
    recovery_backlog: structuredClone(ledger.recovery_backlog ?? []),
    recovery_backlog_count: (ledger.recovery_backlog ?? []).length,
    completion_gate_satisfied: pending.length === 0 && (ledger.recovery_backlog ?? []).length === 0,
    invariants: { valid: violations.length === 0, violations },
  };
}

export function reconcileMemorizeProviderRuntime(ledgerValue, providerAudit = null) {
  const projection = projectMemorizeObligationLedger(ledgerValue);
  const runningAttempts = (providerAudit?.recent_attempts ?? [])
    .filter((attempt) => attempt?.terminal_outcome === 'running');
  const runningAttemptByObligation = new Map(runningAttempts
    .filter((attempt) => attempt.logical_obligation_id)
    .map((attempt) => [attempt.logical_obligation_id, attempt]));
  const runningObligations = projection.pending_obligations
    .filter((obligation) => obligation.current_state === 'provider_running');
  const violations = [];
  for (const obligation of runningObligations) {
    if (!runningAttemptByObligation.has(obligation.obligation_id)) violations.push({
      code: 'ledger_provider_running_without_physical_attempt', obligation_id: obligation.obligation_id,
    });
    else if (!obligation.provider_attempt_lineage?.includes(
      runningAttemptByObligation.get(obligation.obligation_id)?.attempt_id)) violations.push({
      code: 'ledger_provider_running_missing_attempt_lineage', obligation_id: obligation.obligation_id,
      attempt_id: runningAttemptByObligation.get(obligation.obligation_id)?.attempt_id ?? null,
    });
  }
  const normalizedLedger = ensureMemorizeObligationLedger(ledgerValue);
  const obligationIds = new Set(Object.keys(normalizedLedger.obligations));
  for (const attempt of runningAttempts) {
    if (!obligationIds.has(attempt.logical_obligation_id)) violations.push({
      code: 'running_physical_attempt_without_obligation', attempt_id: attempt.attempt_id,
      obligation_id: attempt.logical_obligation_id ?? null,
    });
    else if (normalizedLedger.obligations[attempt.logical_obligation_id]?.current_state !== 'provider_running') {
      violations.push({
        code: 'running_physical_attempt_without_running_obligation', attempt_id: attempt.attempt_id,
        obligation_id: attempt.logical_obligation_id,
      });
    }
  }
  if (runningObligations.length !== runningAttempts.length) violations.push({
    code: 'ledger_provider_running_count_mismatch', ledger_running: runningObligations.length,
    provider_running: runningAttempts.length,
  });
  return {
    ledger_running_obligation_count: runningObligations.length,
    provider_running_attempt_count: runningAttempts.length,
    counts_reconcile: runningObligations.length === runningAttempts.length,
    consistent: violations.length === 0,
    violations,
  };
}

/** Reconstructs exact pending work from v0.9.68 range/provider diagnostics. */
export function migrateLegacyMemorizeObligations(ledgerValue, input = {}) {
  const ledger = ensureMemorizeObligationLedger(ledgerValue, input.logical_run_id);
  const tierObligations = input.tier_obligations ?? [];
  const providerObligations = Object.values(input.provider_obligations ?? {});
  for (const legacy of tierObligations) {
    const range = normalizeRange(legacy);
    if (!range || !legacy.tier) continue;
    const matchingProvider = providerObligations.find((provider) => provider.tier === legacy.tier
      && Number(provider.root_source_range?.start) === Number(legacy.source_start_index ?? range.start)
      && Number(provider.root_source_range?.end) === Number(legacy.source_end_index ?? range.end));
    const id = matchingProvider?.logical_obligation_id
      ?? `${legacy.tier}:chat:${range.start}-${range.end}:${matchingProvider?.root_source_fingerprint ?? 'legacy'}`;
    const safe = legacy.safely_committed === true;
    const sessionRejected = legacy.tier === 'session' && !safe
      && Number(input.session_diagnostics?.session_citation_pipeline?.final_malformed ?? 0) > 0;
    const partial = Number(matchingProvider?.last_response_contract?.rejected_candidate_count
      ?? matchingProvider?.rejected_fragment_count ?? 0) > 0
      || matchingProvider?.last_notice_reason === 'partial_valid_output';
    transitionMemorizeObligation(ledger, {
      obligation_id: id, logical_run_id: input.logical_run_id, tier: legacy.tier,
      owner: matchingProvider?.owner ?? null, source_range: range,
      source_fingerprint: matchingProvider?.root_source_fingerprint ?? null,
    }, safe ? {
      current_state: 'durably_committed', persistence_result: 'legacy_safely_committed',
      coverage_result: 'safely_committed',
    } : {
      current_state: 'pending_recovery',
      exact_reason_code: sessionRejected ? 'invalid_candidate_shape'
        : partial ? 'partial_valid_output_has_unresolved_fragments'
          : legacy.reason_code ?? 'legacy_tier_range_not_safely_committed',
      next_eligible_action: sessionRejected ? 'session_validation_repair_or_bounded_regeneration'
        : 'resume_exact_obligation',
      parser_result: partial ? 'partial' : matchingProvider?.terminal_outcome ?? null,
      downstream_validation_result: sessionRejected ? 'rejected_invalid_candidate_shape' : null,
      persistence_result: 'not_committed', coverage_result: 'pending',
      provider_attempt_lineage: matchingProvider?.last_attempt_id ? [matchingProvider.last_attempt_id] : [],
    });
  }
  for (const legacy of input.owner_obligations ?? []) {
    const range = normalizeRange(legacy);
    if (!range || !String(legacy.owner ?? '').trim()) continue;
    const id = `longterm:${String(legacy.owner).trim().toLowerCase()}:${range.start}-${range.end}:${legacy.source_fingerprint ?? 'legacy'}`;
    transitionMemorizeObligation(ledger, {
      obligation_id: id, logical_run_id: input.logical_run_id,
      tier: 'longterm', owner: legacy.owner, source_range: range,
      source_fingerprint: legacy.source_fingerprint ?? null,
    }, legacy.safely_committed === true ? {
      current_state: 'durably_committed', downstream_validation_result: 'accepted',
      persistence_result: 'legacy_safely_committed', coverage_result: 'safely_committed',
    } : {
      current_state: 'pending_recovery',
      exact_reason_code: legacy.reason_code ?? 'legacy_owner_not_safely_committed',
      next_eligible_action: 'resume_exact_obligation', coverage_result: 'pending',
    });
  }
  return ledger;
}

