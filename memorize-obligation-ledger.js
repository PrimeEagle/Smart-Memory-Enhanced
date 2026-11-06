import { acknowledgeJournalTransition, requireAppliedLifecycleResult } from './memorize-lifecycle-coordinator.js';

/**
 * Authoritative Memorize Chat extraction-obligation lifecycle.
 *
 * Provider attempts, parsers, validators, persistence, coverage, checkpoints,
 * diagnostics, and the UI are projections of this ledger.  A provider response
 * is evidence, never completion: only `durably_committed` and
 * `explicit_no_update` make an obligation checkpoint eligible.
 */

export const MEMORIZE_OBLIGATION_LEDGER_SCHEMA_VERSION = 7;
export const MEMORIZE_OBLIGATION_IMPLEMENTATION_VERSION = 9;

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

// One action contract is shared by the reducer, scheduler, diagnostics, and
// Resume projection. Unknown actions fail closed instead of being guessed from
// the obligation state by each consumer.
export const MEMORIZE_ACTION_CONTRACTS = Object.freeze({
  dispatch_provider_request: Object.freeze({ provider_call_required: true, persistence_required: false }),
  dispatch_registered_provider_attempt: Object.freeze({ provider_call_required: true, persistence_required: false }),
  dispatch_bounded_recovery_attempt: Object.freeze({ provider_call_required: true, persistence_required: false }),
  compact_response_repair: Object.freeze({ provider_call_required: true, persistence_required: false }),
  changed_dimension_regeneration: Object.freeze({ provider_call_required: true, persistence_required: false }),
  malformed_source_repartition: Object.freeze({ provider_call_required: true, persistence_required: false }),
  structured_json_regeneration: Object.freeze({ provider_call_required: true, persistence_required: false }),
  minimal_record_regeneration: Object.freeze({ provider_call_required: true, persistence_required: false }),
  single_source_unit_regeneration: Object.freeze({ provider_call_required: true, persistence_required: false }),
  retry_provider_with_backoff: Object.freeze({ provider_call_required: true, persistence_required: false }),
  recover_exact_unresolved_fragments: Object.freeze({ provider_call_required: true, persistence_required: false }),
  recover_unresolved_partial_output_fragments: Object.freeze({ provider_call_required: true, persistence_required: false }),
  resume_changed_dimension_or_single_source_recovery: Object.freeze({ provider_call_required: true, persistence_required: false }),
  fragment_decision_regeneration: Object.freeze({ provider_call_required: true, persistence_required: false }),
  resume_exact_obligation: Object.freeze({ provider_call_required: true, persistence_required: false }),
  session_validation_repair_or_bounded_regeneration: Object.freeze({ provider_call_required: true, persistence_required: false }),
  citation_repair_or_bounded_regeneration: Object.freeze({ provider_call_required: true, persistence_required: false }),
  dispatch_after_prior_leaf_coverage: Object.freeze({ provider_call_required: true, persistence_required: false }),
  retry: Object.freeze({ provider_call_required: true, persistence_required: false }),
  continue_unattempted_recovery_child: Object.freeze({ provider_call_required: false, persistence_required: false }),
  resume_first_actionable_recovery_leaf: Object.freeze({ provider_call_required: false, persistence_required: false }),
  derive_parent_child_coverage: Object.freeze({ provider_call_required: false, persistence_required: false }),
  aggregate_completed_children: Object.freeze({ provider_call_required: false, persistence_required: false }),
  continue_next_incomplete_sibling: Object.freeze({ provider_call_required: false, persistence_required: false }),
  continue_pending_downstream_processing: Object.freeze({ provider_call_required: false, persistence_required: true }),
  continue_current_run_downstream: Object.freeze({ provider_call_required: false, persistence_required: true }),
  parse_retained_response: Object.freeze({ provider_call_required: false, persistence_required: false }),
  continue_validation: Object.freeze({ provider_call_required: false, persistence_required: false }),
  persist_validated_records: Object.freeze({ provider_call_required: false, persistence_required: true }),
  reconcile_terminal_attempt_evidence: Object.freeze({ provider_call_required: false, persistence_required: false }),
  reconcile_provider_attempt_registration: Object.freeze({ provider_call_required: false, persistence_required: false }),
  reconcile_downstream_lifecycle_evidence: Object.freeze({ provider_call_required: false, persistence_required: false }),
  settle_terminal_malformed_attempt: Object.freeze({ provider_call_required: false, persistence_required: false }),
  adopt_exact_prior_run_evidence: Object.freeze({ provider_call_required: false, persistence_required: false }),
  inspect_or_restore_private_terminal_evidence: Object.freeze({ provider_call_required: false, persistence_required: false }),
  inspect_or_restore_unresolved_fragment_payload: Object.freeze({ provider_call_required: false, persistence_required: false }),
  inspect_or_restore_committed_partial_record: Object.freeze({ provider_call_required: false, persistence_required: false }),
  inspect_or_restore_partial_fragment_recovery_evidence: Object.freeze({ provider_call_required: false, persistence_required: false }),
  change_provider_configuration_or_install_updated_build: Object.freeze({ provider_call_required: false, persistence_required: false }),
});

export function getMemorizeActionContract(action) {
  return action ? MEMORIZE_ACTION_CONTRACTS[action] ?? null : null;
}

export function getCanonicalMemorizeObligation(ledgerValue, obligationId, logicalRunId = null) {
  const ledger = ensureMemorizeObligationLedger(ledgerValue, logicalRunId);
  const obligation = ledger.obligations?.[String(obligationId ?? '')] ?? null;
  if (!obligation) return null;
  if (logicalRunId && obligation.logical_run_id && obligation.logical_run_id !== logicalRunId) return null;
  return obligation;
}

export function memorizeObligationStateFingerprint(obligation = null) {
  if (!obligation) return null;
  const value = JSON.stringify({
    obligation_id: obligation.obligation_id ?? null,
    logical_run_id: obligation.logical_run_id ?? null,
    current_state: obligation.current_state ?? null,
    checkpoint_eligible: obligation.checkpoint_eligible === true,
    exact_reason_code: obligation.exact_reason_code ?? null,
    next_eligible_action: obligation.next_eligible_action ?? null,
    provider_attempt_lineage: obligation.provider_attempt_lineage ?? [],
    durable_record_ids: obligation.lifecycle?.durably_persisted_record_ids ?? [],
    unresolved_fragment_ids: obligation.lifecycle?.unresolved_fragment_ids ?? [],
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

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
    historical_transition_observations: [],
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
  // Older builds recorded an illegal transition and then applied it. Preserve
  // that evidence, but do not let normalized history masquerade as a new
  // runtime invariant failure forever.
  ledger.historical_transition_observations = [
    ...(Array.isArray(ledger.historical_transition_observations)
      ? ledger.historical_transition_observations : []),
    ...(Array.isArray(ledger.transition_violations) ? ledger.transition_violations.map((item) => ({
      ...item, classification: 'historical_normalized',
    })) : []),
  ].slice(-64);
  ledger.transition_violations = [];
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
      semantic_event_ids: normalizeIds(raw?.semantic_event_ids).slice(-256),
      semantic_event_history: Array.isArray(raw?.semantic_event_history)
        ? raw.semantic_event_history.slice(-128) : [],
      evidence_adoptions: Array.isArray(raw?.evidence_adoptions)
        ? raw.evidence_adoptions.filter((item) => item?.origin_attempt_id)
          .slice(-64) : [],
      implementation_version: MEMORIZE_OBLIGATION_IMPLEMENTATION_VERSION,
      schema_version: MEMORIZE_OBLIGATION_LEDGER_SCHEMA_VERSION,
      revision: Number(raw?.revision ?? 0),
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
  const permitted = !prior.current_state || state === priorState
    || (MEMORIZE_OBLIGATION_TRANSITIONS[priorState] ?? []).includes(state);
  if (!permitted) {
    const rejection = {
      code: 'illegal_obligation_state_transition', obligation_id: id,
      from: priorState, to: state, at, classification: 'current_runtime',
      requested_evidence: {
        provider_attempt_id: transition.provider_attempt_id ?? null,
        exact_reason_code: transition.exact_reason_code ?? transition.reason_code ?? null,
      },
    };
    const duplicate = ledger.transition_violations.some((item) =>
      item.code === rejection.code && item.obligation_id === rejection.obligation_id
      && item.from === rejection.from && item.to === rejection.to
      && item.requested_evidence?.provider_attempt_id
        === rejection.requested_evidence.provider_attempt_id);
    if (!duplicate) {
      ledger.transition_violations.push(rejection);
      ledger.transition_violations = ledger.transition_violations.slice(-64);
      ledger.updated_at = at;
    }
    // The reducer is fail-closed: terminal coverage and all other durable
    // fields remain byte-for-byte unchanged when a transition is illegal.
    return prior;
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
      permitted: true,
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
    semantic_event_ids: normalizeIds(prior.semantic_event_ids).slice(-256),
    semantic_event_history: Array.isArray(prior.semantic_event_history)
      ? prior.semantic_event_history.slice(-128) : [],
    evidence_adoptions: [...new Map([
      ...(prior.evidence_adoptions ?? []),
      ...(transition.evidence_adoptions ?? []),
    ].filter((item) => item?.origin_attempt_id).map((item) => [
      [item.origin_attempt_id, item.adopted_into_logical_run_id,
        item.canonical_obligation_id].join('|'), item,
    ])).values()].slice(-64),
    implementation_version: MEMORIZE_OBLIGATION_IMPLEMENTATION_VERSION,
    schema_version: MEMORIZE_OBLIGATION_LEDGER_SCHEMA_VERSION,
    revision: Number(prior.revision ?? 0) + 1,
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

export const MEMORIZE_LIFECYCLE_EVENTS = Object.freeze([
  'obligation_registered', 'recovery_children_declared', 'provider_attempt_started',
  'provider_response_received', 'provider_transport_failed', 'parser_accepted',
  'parser_partially_accepted', 'parser_rejected', 'parser_evidence_enriched', 'validation_accepted',
  'validation_partially_accepted', 'validation_rejected', 'records_staged',
  'records_durably_persisted', 'explicit_no_update_accepted', 'recovery_required',
  'recovery_budget_exhausted', 'leaf_coverage_completed', 'parent_children_completed',
  'obligation_blocked', 'candidate_mapping_reconciled', 'terminal_provider_evidence_adopted',
  'terminal_malformed_attempt_settled', 'terminal_attempt_evidence_reconciled',
  'controller_relinquished_ownership',
]);

const SEMANTIC_EVENT_SET = new Set(MEMORIZE_LIFECYCLE_EVENTS);

function semanticEventId(identity, event) {
  if (event.event_id) return String(event.event_id);
  return [stableId(identity), event.type, event.provider_attempt_id ?? '',
    event.source_fingerprint ?? identity.source_fingerprint ?? '',
    ...(event.type === 'parser_evidence_enriched'
      ? normalizeIds(event.lifecycle?.parser_accepted_candidate_ids) : []),
    ...(normalizeIds(event.durable_record_ids))].join('|');
}

function recordHistoricalLifecycleNoop(ledger, identity, event, reasonCode) {
  const observation = {
    code: reasonCode, obligation_id: stableId(identity),
    lifecycle_event: event?.type ?? null,
    provider_attempt_id: event?.provider_attempt_id ?? null,
    classification: 'not_applicable_due_to_later_verified_state',
    observed_at: nowValue(event?.at),
  };
  const duplicate = (ledger.historical_transition_observations ?? []).some((item) =>
    item.code === observation.code && item.obligation_id === observation.obligation_id
    && item.lifecycle_event === observation.lifecycle_event
    && item.provider_attempt_id === observation.provider_attempt_id);
  if (!duplicate) ledger.historical_transition_observations = [
    ...(ledger.historical_transition_observations ?? []), observation,
  ].slice(-256);
  const obligation = ledger.obligations[observation.obligation_id] ?? null;
  return { applied: false, duplicate: true, status: 'idempotent_duplicate_verified',
    obligation };
}

function recordSemanticViolation(ledger, identity, event, code, detail = {}) {
  const violation = {
    code, obligation_id: stableId(identity), lifecycle_event: event?.type ?? null,
    provider_attempt_id: event?.provider_attempt_id ?? null,
    missing_evidence: detail.missing_evidence ?? [], safe_repair_action: detail.safe_repair_action
      ?? 'supply_complete_semantic_lifecycle_evidence', at: nowValue(event?.at),
    classification: 'current_runtime',
  };
  const duplicate = ledger.transition_violations.some((item) => item.code === violation.code
    && item.obligation_id === violation.obligation_id
    && item.lifecycle_event === violation.lifecycle_event
    && item.provider_attempt_id === violation.provider_attempt_id);
  if (!duplicate) ledger.transition_violations = [...ledger.transition_violations, violation].slice(-64);
  ledger.updated_at = violation.at;
  return { applied: false, duplicate: false, status: 'rejected', violation,
    resulting_state: ledger.obligations[violation.obligation_id]?.current_state ?? null,
    checkpoint_eligible: ledger.obligations[violation.obligation_id]?.checkpoint_eligible === true,
    obligation: ledger.obligations[violation.obligation_id] ?? null };
}

function validateChildTree(parent, children) {
  const parentRange = normalizeRange(parent.source_range ?? parent);
  const normalized = children.map((child) => ({ ...child,
    obligation_id: stableId(child), source_range: normalizeRange(child.source_range ?? child) }));
  if (!parentRange || normalized.some((child) => !child.source_range)) {
    return { valid: false, reason: 'missing_parent_or_child_range', children: normalized };
  }
  const sorted = [...normalized].sort((a, b) => a.source_range.start - b.source_range.start);
  let next = parentRange.start;
  for (const child of sorted) {
    if (child.source_range.start !== next || child.source_range.end > parentRange.end) {
      return { valid: false, reason: 'child_ranges_do_not_exactly_partition_parent', children: normalized };
    }
    next = child.source_range.end + 1;
  }
  return { valid: next === parentRange.end + 1,
    reason: next === parentRange.end + 1 ? null : 'child_ranges_do_not_cover_parent', children: normalized };
}

function appendSemanticEvent(obligation, eventId, event) {
  obligation.semantic_event_ids = normalizeIds([...(obligation.semantic_event_ids ?? []), eventId]).slice(-256);
  obligation.semantic_event_history = [...(obligation.semantic_event_history ?? []), {
    event_id: eventId, type: event.type, provider_attempt_id: event.provider_attempt_id ?? null,
    at: nowValue(event.at), derived: event.derived === true,
  }].slice(-128);
}

function transitionForSemanticEvent(ledger, identity, event, state, patch = {}) {
  const before = ledger.obligations[stableId(identity)];
  const next = transitionMemorizeObligation(ledger, identity, {
    ...patch, current_state: state, at: event.at,
    provider_attempt_id: event.provider_attempt_id ?? patch.provider_attempt_id,
  });
  if (next === before && before?.current_state !== state) {
    return recordSemanticViolation(ledger, identity, event,
      'semantic_event_rejected_by_canonical_transition', {
        safe_repair_action: 'reconcile_missing_prior_lifecycle_evidence',
      });
  }
  return { applied: true, obligation: next };
}

/**
 * Sole production mutation API for Memorize obligations. Callers report domain
 * evidence; this function chooses and validates canonical reducer states.
 */
export function applyMemorizeLifecycleEvent(ledgerValue, identity = {}, event = {}) {
  const ledger = ensureMemorizeObligationLedger(ledgerValue, identity.logical_run_id);
  if (!SEMANTIC_EVENT_SET.has(event.type)) {
    return recordSemanticViolation(ledger, identity, event, 'unknown_memorize_lifecycle_event');
  }
  const id = stableId(identity);
  const eventId = semanticEventId(identity, event);
  const existing = ledger.obligations[id];
  if (existing?.semantic_event_ids?.includes(eventId)) {
    return { applied: false, duplicate: true, status: 'idempotent_duplicate_verified',
      resulting_state: existing.current_state, checkpoint_eligible: existing.checkpoint_eligible === true,
      obligation: existing, event_id: eventId };
  }
  let result;
  const details = {
    parser_result: event.parser_result,
    downstream_validation_result: event.downstream_validation_result,
    persistence_result: event.persistence_result,
    coverage_result: event.coverage_result,
    exact_reason_code: event.reason_code ?? event.exact_reason_code,
    next_eligible_action: event.next_action ?? event.next_eligible_action,
    recovery_intent: event.recovery_intent,
    recovery_stage: event.recovery_stage,
    metrics: event.metrics,
    lifecycle: {
      ...(event.lifecycle ?? {}),
      ...(event.durable_record_ids?.length ? {
        durably_persisted_record_ids: event.durable_record_ids,
      } : {}),
    },
  };
  const priorState = existing?.current_state ?? 'unattempted';
  switch (event.type) {
    case 'obligation_registered':
      result = transitionForSemanticEvent(ledger, identity, event, priorState, details);
      break;
    case 'recovery_children_declared': { // Durable registration precedes dispatch.
      const children = Array.isArray(event.children) ? event.children : [];
      const check = validateChildTree(existing ?? identity, children);
      if (!check.valid) return recordSemanticViolation(ledger, identity, event,
        'invalid_recovery_child_partition', { missing_evidence: [check.reason] });
      const childIds = check.children.map((child) => child.obligation_id);
      const parent = transitionMemorizeObligation(ledger, {
        ...identity, expected_child_obligation_ids: childIds,
      }, {
        current_state: SAFE_STATES.has(priorState) ? priorState : 'pending_recovery',
        exact_reason_code: 'recovery_children_pending',
        next_eligible_action: 'continue_unattempted_recovery_child',
        recovery_intent: 'complete_recovery_child_coverage', at: event.at,
      });
      for (const child of check.children) {
        transitionMemorizeObligation(ledger, {
          ...child, logical_run_id: identity.logical_run_id ?? ledger.logical_run_id,
          tier: child.tier ?? identity.tier, owner: child.owner ?? identity.owner,
          parent_obligation_id: id,
        }, {
          current_state: ledger.obligations[child.obligation_id]?.current_state ?? 'unattempted',
          exact_reason_code: ledger.obligations[child.obligation_id]?.exact_reason_code
            ?? 'recovery_child_not_attempted',
          next_eligible_action: ledger.obligations[child.obligation_id]?.next_eligible_action
            ?? 'dispatch_provider_request',
          recovery_intent: ledger.obligations[child.obligation_id]?.recovery_intent
            ?? 'complete_recovery_child_coverage',
          recovery_stage: ledger.obligations[child.obligation_id]?.recovery_stage
            ?? 'initial_child_dispatch',
          at: event.at,
        });
      }
      result = { applied: true, obligation: parent };
      break;
    }
    case 'provider_attempt_started':
      if (!event.provider_attempt_id) return recordSemanticViolation(ledger, identity, event,
        'provider_attempt_started_without_attempt_id', { missing_evidence: ['provider_attempt_id'] });
      if (!['unattempted', 'pending_recovery', 'operationally_paused', 'blocked',
        'partial_records_committed', 'terminal_failed'].includes(priorState)) {
        return recordSemanticViolation(ledger, identity, event,
          'provider_retry_started_before_prior_attempt_disposition', {
            missing_evidence: ['parser_or_validation_disposition', 'recovery_required'],
            safe_repair_action: 'record_prior_attempt_disposition_then_recovery_required',
          });
      }
      result = transitionForSemanticEvent(ledger, identity, event, 'provider_running', {
        ...details, exact_reason_code: 'provider_request_in_progress',
      });
      break;
    case 'provider_response_received':
      if (!event.provider_attempt_id || !existing?.provider_attempt_lineage?.includes(event.provider_attempt_id)) {
        return recordSemanticViolation(ledger, identity, event,
          'provider_response_without_registered_attempt', { missing_evidence: ['registered_provider_attempt'] });
      }
      if (priorState !== 'provider_running' && priorState !== 'provider_response_received') {
        result = recordHistoricalLifecycleNoop(ledger, identity, event,
          'provider_response_not_applicable_due_to_later_verified_state');
        break;
      }
      result = transitionForSemanticEvent(ledger, identity, event, 'provider_response_received', {
        ...details, exact_reason_code: 'downstream_parser_pending',
      });
      break;
    case 'provider_transport_failed':
      result = transitionForSemanticEvent(ledger, identity, event, 'pending_recovery', {
        ...details, exact_reason_code: event.reason_code ?? 'provider_transport_failure',
        next_eligible_action: event.next_action ?? 'retry_provider_with_backoff',
      });
      break;
    case 'parser_accepted':
    case 'parser_partially_accepted':
    case 'parser_rejected': {
      const targetParserState = event.type === 'parser_accepted' ? 'parser_accepted'
        : event.type === 'parser_partially_accepted' ? 'parser_partial' : 'parser_rejected';
      if (priorState !== 'provider_response_received' && priorState !== targetParserState) {
        return recordSemanticViolation(ledger, identity, event,
        'parser_disposition_without_provider_response', { missing_evidence: ['provider_response_received'] });
      }
      result = transitionForSemanticEvent(ledger, identity, event, targetParserState, details);
      break;
    }
    case 'parser_evidence_enriched': {
      if (!existing || !['parser_accepted', 'parser_partial', 'validation_accepted',
        'validation_partial', 'staged', 'partial_records_committed', 'pending_recovery',
        'durably_committed', 'explicit_no_update'].includes(priorState)) {
        return recordSemanticViolation(ledger, identity, event,
          'parser_evidence_enrichment_without_parser_disposition', {
            missing_evidence: ['parser_disposition'],
          });
      }
      result = transitionForSemanticEvent(ledger, identity, event, priorState, details);
      break;
    }
    case 'validation_accepted':
    case 'validation_partially_accepted':
    case 'validation_rejected': {
      if (!['parser_accepted', 'parser_partial'].includes(priorState)) {
        return recordSemanticViolation(ledger, identity, event,
          'validation_disposition_without_parser_disposition', { missing_evidence: ['parser_disposition'] });
      }
      const state = event.type === 'validation_accepted' ? 'validation_accepted'
        : event.type === 'validation_partially_accepted' ? 'validation_partial' : 'validation_rejected';
      result = transitionForSemanticEvent(ledger, identity, event, state, details);
      break;
    }
    case 'records_staged':
      if (!['validation_accepted', 'validation_partial'].includes(priorState)) {
        return recordSemanticViolation(ledger, identity, event,
          'records_staged_without_validation_acceptance', { missing_evidence: ['validation_acceptance'] });
      }
      result = transitionForSemanticEvent(ledger, identity, event, 'staged', details);
      break;
    case 'leaf_coverage_completed': {
      if (event.verified_coverage !== true) return recordSemanticViolation(ledger, identity, event,
        'leaf_coverage_completion_missing_verified_coverage', {
          missing_evidence: ['verified_coverage'],
        });
      result = transitionForSemanticEvent(ledger, identity, event,
        event.explicit_no_update === true ? 'explicit_no_update' : 'durably_committed', {
          ...details,
          parser_result: event.parser_result ?? 'verified_by_authoritative_coverage_manifest',
          downstream_validation_result: event.downstream_validation_result ?? 'verified_existing',
          persistence_result: event.persistence_result
            ?? (event.explicit_no_update ? 'not_required' : 'verified_existing'),
          coverage_result: 'safely_committed',
        });
      break;
    }
    case 'terminal_provider_evidence_adopted': {
      const evidence = event.adopted_terminal_evidence ?? {};
      const evidenceRange = normalizeRange(evidence.source_range ?? {});
      const identityRange = normalizeRange(identity.source_range ?? existing?.source_range ?? {});
      const exactIdentity = evidence.original_root_obligation_id
          === (identity.root_obligation_id ?? existing?.parent_obligation_id ?? id)
        && evidence.original_leaf_obligation_id === id
        && evidence.tier === (identity.tier ?? existing?.tier)
        && String(evidence.owner ?? '').trim().toLowerCase()
          === String(identity.owner ?? existing?.owner ?? '').trim().toLowerCase()
        && evidenceRange?.start === identityRange?.start
        && evidenceRange?.end === identityRange?.end
        && evidence.source_fingerprint === (identity.source_fingerprint
          ?? existing?.source_fingerprint);
      const terminalSuccess = ['completed', 'completed_no_candidates', 'completed_repartitioned']
        .includes(evidence.terminal_outcome);
      const missingEvidence = [
        ...(!event.provider_attempt_id ? ['physical_attempt_id'] : []),
        ...(!exactIdentity ? ['exact_root_leaf_tier_owner_range_fingerprint_identity'] : []),
        ...(!terminalSuccess ? ['terminal_provider_success'] : []),
        ...(evidence.private_response_retained !== true ? ['private_terminal_response'] : []),
        ...(!event.adopted_from_logical_run_id ? ['original_logical_run_id'] : []),
        ...(!event.evidence_fingerprint ? ['evidence_fingerprint'] : []),
      ];
      if (event.adopted_from_logical_run_id
        && event.adopted_from_logical_run_id === (identity.logical_run_id
          ?? existing?.logical_run_id ?? ledger.logical_run_id)) {
        return recordSemanticViolation(ledger, identity, event,
          'same_run_evidence_cannot_use_prior_run_adoption', {
            safe_repair_action: 'continue_current_run_downstream',
          });
      }
      if (missingEvidence.length) return recordSemanticViolation(ledger, identity, event,
        'terminal_provider_evidence_adoption_missing_evidence', {
          missing_evidence: missingEvidence,
          safe_repair_action: 'inspect_or_restore_private_terminal_evidence',
        });
      const alreadyAdopted = (existing?.evidence_adoptions ?? []).some((item) =>
        item?.origin_attempt_id === event.provider_attempt_id
          && item?.adopted_into_logical_run_id === (identity.logical_run_id
            ?? existing?.logical_run_id ?? ledger.logical_run_id)
          && item?.canonical_obligation_id === id)
        || existing?.metrics?.adopted_from_attempt_id === event.provider_attempt_id
        || (existing?.semantic_event_history ?? []).some((item) =>
          item?.type === 'terminal_provider_evidence_adopted'
            && item?.provider_attempt_id === event.provider_attempt_id);
      if (alreadyAdopted) {
        result = recordHistoricalLifecycleNoop(ledger, identity, event,
          'terminal_provider_evidence_already_adopted_into_canonical_obligation');
        break;
      }
      if (existing?.checkpoint_eligible) {
        result = recordHistoricalLifecycleNoop(ledger, identity, event,
          'terminal_provider_evidence_adoption_superseded_by_terminal_coverage');
        break;
      }
      result = transitionForSemanticEvent(ledger, identity, event,
        'provider_response_received', {
          ...details,
          exact_reason_code: 'accepted_output_pending_downstream_processing',
          next_eligible_action: 'continue_pending_downstream_processing',
          recovery_intent: 'continue_pending_downstream_processing',
          recovery_stage: 'adopted_terminal_response_downstream_processing',
          evidence_adoptions: [{
            origin_attempt_id: event.provider_attempt_id,
            origin_logical_run_id: event.adopted_from_logical_run_id,
            adopted_into_logical_run_id: identity.logical_run_id
              ?? existing?.logical_run_id ?? ledger.logical_run_id,
            canonical_obligation_id: id,
            obligation_revision_at_adoption: Number(existing?.revision ?? 0) + 1,
            evidence_fingerprint: event.evidence_fingerprint,
            downstream_cursor: event.downstream_cursor ?? null,
            adopted_at: nowValue(event.at),
          }],
          metrics: {
            adopted_from_logical_run_id: event.adopted_from_logical_run_id,
            adopted_from_attempt_id: event.adopted_from_attempt_id,
            evidence_adoption_reason: event.evidence_adoption_reason,
            adopted_evidence_fingerprint: event.evidence_fingerprint,
          },
        });
      break;
    }
    case 'terminal_malformed_attempt_settled': {
      if (!event.provider_attempt_id
        || !existing?.provider_attempt_lineage?.includes(event.provider_attempt_id)) {
        return recordSemanticViolation(ledger, identity, event,
          'terminal_malformed_settlement_without_registered_attempt', {
            missing_evidence: ['registered_provider_attempt'],
            safe_repair_action: 'reconcile_exact_physical_attempt_identity',
          });
      }
      if (!event.terminal_outcome || event.terminal_outcome === 'running') {
        return recordSemanticViolation(ledger, identity, event,
          'terminal_malformed_settlement_without_terminal_outcome', {
            missing_evidence: ['terminal_physical_outcome'],
          });
      }
      if (existing.checkpoint_eligible) {
        result = recordHistoricalLifecycleNoop(ledger, identity, event,
          'terminal_malformed_attempt_superseded_by_later_terminal_coverage');
        break;
      }
      result = transitionForSemanticEvent(ledger, identity, event,
        event.operationally_paused === true ? 'operationally_paused' : 'pending_recovery', {
          ...details,
          parser_result: 'rejected_malformed_provider_output',
          downstream_validation_result: 'not_applicable_parser_rejected',
          persistence_result: 'not_applicable',
          exact_reason_code: event.exact_reason_code ?? event.malformed_reason
            ?? 'terminal_malformed_provider_output',
          next_eligible_action: event.next_eligible_action
            ?? 'dispatch_bounded_recovery_attempt',
          recovery_intent: 'recover_malformed_provider_output',
          recovery_stage: event.recovery_stage ?? 'bounded_malformed_recovery',
        });
      break;
    }
    case 'terminal_attempt_evidence_reconciled': {
      const evidence = event.terminal_evidence ?? {};
      const durableIds = normalizeIds(evidence.durable_record_ids);
      const candidateMap = evidence.durable_record_candidate_map ?? {};
      const explicitNoUpdate = evidence.explicit_no_update === true;
      const exactIdentity = evidence.root_obligation_id === (identity.root_obligation_id
        ?? existing?.parent_obligation_id ?? identity.obligation_id)
        && evidence.leaf_obligation_id === id
        && evidence.source_fingerprint === (identity.source_fingerprint ?? existing?.source_fingerprint)
        && evidence.source_range?.start === (identity.source_range ?? existing?.source_range)?.start
        && evidence.source_range?.end === (identity.source_range ?? existing?.source_range)?.end;
      const parserAccepted = ['accepted', 'partial', 'accepted_from_completion_journal',
        'validated_no_update', 'explicit_none', 'recovered_explicit_none'].includes(evidence.parser_status);
      const validationAccepted = ['accepted', 'partial', 'verified_existing', 'no_update',
        'validated_no_update', 'validated_duplicate_only_no_update',
        'not_required_validated_no_update'].includes(evidence.validation_status);
      const persistenceTerminal = explicitNoUpdate
        ? ['not_needed', 'not_required_validated_no_update', 'not_applicable'].includes(evidence.persistence_status)
        : ['committed', 'verified_existing'].includes(evidence.persistence_status);
      const mappingsComplete = explicitNoUpdate || durableIds.length > 0
        && durableIds.every((recordId) => String(candidateMap[recordId] ?? '').trim());
      const noLaterConflict = evidence.no_incompatible_later_attempt === true;
      const manifestCovered = evidence.manifest_leaf_covered === true;
      const terminalProvider = ['completed', 'completed_no_candidates', 'completed_repartitioned']
        .includes(evidence.terminal_outcome);
      const evidenceFingerprint = String(event.evidence_fingerprint ?? '').trim();
      if (existing?.checkpoint_eligible) {
        const expectedState = explicitNoUpdate ? 'explicit_no_update' : 'durably_committed';
        if (existing.current_state === expectedState) {
          const mappingsAlreadyPresent = explicitNoUpdate || durableIds.length === 0
            || durableIds.every((recordId) =>
              existing.lifecycle?.durable_record_candidate_map?.[recordId] === candidateMap[recordId]);
          if (mappingsAlreadyPresent) {
            result = recordHistoricalLifecycleNoop(ledger, identity, event,
              'terminal_attempt_evidence_superseded_by_later_verified_downstream_evidence');
            break;
          }
        }
      }
      const missingEvidence = [
        ...(!exactIdentity ? ['exact_root_leaf_range_fingerprint_identity'] : []),
        ...(!terminalProvider ? ['terminal_provider_success'] : []),
        ...(!parserAccepted ? ['parser_acceptance_or_validated_no_update'] : []),
        ...(!validationAccepted ? ['validation_acceptance_or_validated_no_update'] : []),
        ...(!persistenceTerminal ? ['terminal_persistence_disposition'] : []),
        ...(!mappingsComplete ? ['durable_record_candidate_mappings'] : []),
        ...(!manifestCovered ? ['manifest_leaf_coverage'] : []),
        ...(!noLaterConflict ? ['absence_of_incompatible_later_attempt'] : []),
        ...(!evidenceFingerprint ? ['evidence_fingerprint'] : []),
      ];
      if (missingEvidence.length) return recordSemanticViolation(ledger, identity, event,
        'terminal_attempt_reconciliation_missing_evidence', {
          missing_evidence: missingEvidence,
          safe_repair_action: 'inspect_or_restore_durable_evidence',
        });
      if (existing?.checkpoint_eligible) {
        const expectedState = explicitNoUpdate ? 'explicit_no_update' : 'durably_committed';
        if (existing.current_state !== expectedState) return recordSemanticViolation(ledger, identity, event,
          'terminal_attempt_reconciliation_conflicts_with_terminal_state', {
            safe_repair_action: 'inspect_incompatible_terminal_evidence',
          });
        const mappingsAlreadyPresent = explicitNoUpdate || durableIds.every((recordId) =>
          existing.lifecycle?.durable_record_candidate_map?.[recordId] === candidateMap[recordId]);
        if (!mappingsAlreadyPresent) {
          const candidateIds = normalizeIds(Object.values(candidateMap));
          result = transitionForSemanticEvent(ledger, identity, event, expectedState, {
            ...details,
            lifecycle: {
              parser_accepted_candidate_ids: candidateIds,
              downstream_accepted_candidate_ids: candidateIds,
              durably_persisted_record_ids: durableIds,
              durable_record_candidate_map: candidateMap,
            },
            metrics: { terminal_reconciliation_evidence_fingerprint: evidenceFingerprint },
          });
        } else result = { applied: false, duplicate: true, obligation: existing };
        break;
      }
      if (!['unattempted', 'pending_recovery', 'partial_records_committed'].includes(priorState)) {
        const reconciliable = transitionMemorizeObligation(ledger, identity, {
          current_state: 'pending_recovery',
          exact_reason_code: 'reconcile_terminal_attempt_evidence',
          next_eligible_action: 'reconcile_terminal_attempt_evidence',
          recovery_intent: 'apply_verified_local_terminal_evidence',
          provider_attempt_id: evidence.provider_attempt_id,
          at: event.at,
        });
        if (reconciliable.current_state !== 'pending_recovery') return recordSemanticViolation(
          ledger, identity, event, 'terminal_attempt_reconciliation_state_normalization_rejected', {
            safe_repair_action: 'inspect_incompatible_terminal_evidence',
          });
      }
      const candidateIds = normalizeIds(Object.values(candidateMap));
      result = transitionForSemanticEvent(ledger, identity, event,
        explicitNoUpdate ? 'explicit_no_update' : 'durably_committed', {
          ...details,
          parser_result: evidence.parser_status,
          downstream_validation_result: evidence.validation_status,
          persistence_result: evidence.persistence_status,
          coverage_result: 'safely_committed_from_terminal_evidence',
          provider_attempt_id: evidence.provider_attempt_id,
          lifecycle: explicitNoUpdate ? {} : {
            parser_accepted_candidate_ids: candidateIds,
            downstream_accepted_candidate_ids: candidateIds,
            durably_persisted_record_ids: durableIds,
            durable_record_candidate_map: candidateMap,
          },
          metrics: { terminal_reconciliation_evidence_fingerprint: evidenceFingerprint },
        });
      break;
    }
    case 'records_durably_persisted': {
      if (!['staged', 'partial_records_committed'].includes(priorState)) {
        return recordSemanticViolation(ledger, identity, event,
          'durable_persistence_without_accepted_staged_records', {
            missing_evidence: ['parser_acceptance', 'validation_acceptance', 'records_staged'],
          });
      }
      result = transitionForSemanticEvent(ledger, identity, event, 'durably_committed', {
        ...details, persistence_result: event.persistence_result ?? 'committed',
        coverage_result: event.coverage_result ?? 'safely_committed',
      });
      break;
    }
    case 'explicit_no_update_accepted':
      if (!['parser_accepted', 'parser_partial', 'validation_accepted', 'validation_partial'].includes(priorState)) {
        return recordSemanticViolation(ledger, identity, event,
          'no_update_without_parser_or_validation_evidence', { missing_evidence: ['validated_no_update'] });
      }
      result = transitionForSemanticEvent(ledger, identity, event, 'explicit_no_update', {
        ...details, persistence_result: 'not_required_validated_no_update',
        coverage_result: 'safely_committed',
      });
      break;
    case 'recovery_required':
    case 'recovery_budget_exhausted':
      if (!(event.reason_code ?? event.exact_reason_code)
        || !(event.next_action ?? event.next_eligible_action)) return recordSemanticViolation(ledger, identity, event,
        'recovery_event_missing_typed_action', { missing_evidence: ['reason_code', 'next_action'] });
      result = transitionForSemanticEvent(ledger, identity, event,
        event.type === 'recovery_budget_exhausted' ? 'operationally_paused' : 'pending_recovery', details);
      break;
    case 'parent_children_completed':
      if (!(existing?.expected_child_obligation_ids?.length)
        || existing.expected_child_obligation_ids.some((childId) =>
          !ledger.obligations[childId]?.checkpoint_eligible)) {
        return recordSemanticViolation(ledger, identity, event,
          'parent_completion_without_complete_registered_children', {
            missing_evidence: ['registered_terminal_child_coverage'],
          });
      }
      if (priorState !== 'pending_recovery') {
        const pending = transitionMemorizeObligation(ledger, identity, {
          current_state: 'pending_recovery', exact_reason_code: 'child_coverage_ready_for_aggregation',
          next_eligible_action: 'derive_parent_child_coverage', at: event.at,
        });
        if (pending.current_state !== 'pending_recovery') return recordSemanticViolation(
          ledger, identity, event, 'parent_aggregation_pending_transition_rejected');
      }
      result = transitionForSemanticEvent(ledger, identity, { ...event, derived: true },
        'durably_committed', { ...details, parser_result: 'derived_from_child_coverage',
          downstream_validation_result: 'not_applicable_parent_aggregation',
          persistence_result: 'committed_children', coverage_result: 'safely_committed' });
      break;
    case 'obligation_blocked':
      if (!(event.reason_code ?? event.exact_reason_code)
        || !(event.next_action ?? event.next_eligible_action)) return recordSemanticViolation(ledger, identity, event,
        'blocked_event_missing_typed_action', { missing_evidence: ['reason_code', 'next_action'] });
      result = transitionForSemanticEvent(ledger, identity, event, 'blocked', details);
      break;
    case 'candidate_mapping_reconciled': {
      const mapping = event.durable_record_candidate_map ?? {};
      const pairs = Object.entries(mapping).filter(([recordId, candidateId]) =>
        String(recordId).trim() && String(candidateId).trim());
      if (!existing || pairs.length === 0) return recordSemanticViolation(
        ledger, identity, event, 'candidate_mapping_reconciliation_missing_evidence', {
          missing_evidence: ['durable_record_candidate_map'],
        });
      const durableIds = new Set(existing.lifecycle?.durably_persisted_record_ids ?? []);
      if (pairs.some(([recordId]) => !durableIds.has(recordId))) return recordSemanticViolation(
        ledger, identity, event, 'candidate_mapping_reconciliation_unknown_record', {
          missing_evidence: ['matching_durable_record_identity'],
        });
      const candidateIds = normalizeIds(pairs.map(([, candidateId]) => candidateId));
      result = transitionForSemanticEvent(ledger, identity, event, priorState, {
        ...details,
        lifecycle: {
          parser_accepted_candidate_ids: candidateIds,
          downstream_accepted_candidate_ids: candidateIds,
          durable_record_candidate_map: Object.fromEntries(pairs),
        },
        metrics: {
          ...(event.metrics ?? {}),
          candidate_mapping_migration: event.migration ?? 'provider_completion_journal_v2',
        },
      });
      break;
    }
    case 'controller_relinquished_ownership':
      result = { applied: true, obligation: existing ?? null };
      break;
    default:
      result = recordSemanticViolation(ledger, identity, event, 'unhandled_memorize_lifecycle_event');
  }
  if (result.applied && result.obligation) appendSemanticEvent(result.obligation, eventId, event);
  const status = result.applied === true ? 'applied'
    : result.duplicate === true ? 'idempotent_duplicate_verified' : 'rejected';
  return { ...result, status, event_id: eventId,
    resulting_state: result.obligation?.current_state ?? null,
    checkpoint_eligible: result.obligation?.checkpoint_eligible === true };
}

/** Recursively derives terminal parent coverage without provider or persistence work. */
export function aggregateMemorizeObligationParents(ledgerValue, at = Date.now()) {
  const ledger = ensureMemorizeObligationLedger(ledgerValue);
  let mutations = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const parent of Object.values(ledger.obligations)) {
      const childIds = parent.expected_child_obligation_ids ?? [];
      if (!childIds.length || parent.checkpoint_eligible) continue;
      const children = childIds.map((id) => ledger.obligations[id]);
      if (children.some((child) => !child?.checkpoint_eligible)) continue;
      if (parent.current_state !== 'pending_recovery') {
        const pending = transitionMemorizeObligation(ledger, parent, {
          current_state: 'pending_recovery', exact_reason_code: 'child_coverage_ready_for_aggregation',
          next_eligible_action: 'derive_parent_child_coverage', at,
        });
        if (pending.current_state !== 'pending_recovery') continue;
      }
      const result = applyMemorizeLifecycleEvent(ledger, parent, {
        type: 'parent_children_completed', event_id: `aggregate:${parent.obligation_id}`,
        at, derived: true,
      });
      requireAppliedLifecycleResult(result, ['durably_committed'], {
        stage: 'parent_aggregation', obligation_id: parent.obligation_id,
        event_type: 'parent_children_completed',
      });
      if (result.applied) { mutations += 1; changed = true; }
    }
  }
  return { ledger, mutations };
}

function journalEntries(journal) {
  if (Array.isArray(journal)) return journal;
  if (Array.isArray(journal?.entries)) return journal.entries;
  return (journal?.order ?? []).map((id) => journal?.entries?.[id]).filter(Boolean);
}

function terminalEvidenceFingerprint(entry, candidateMap) {
  const value = [entry.attempt_id, entry.root_obligation_id, entry.child_obligation_id,
    entry.source_range?.start, entry.source_range?.end, entry.source_fingerprint,
    entry.terminal_outcome, entry.parser_result?.status ?? entry.parser_status, entry.validation?.status,
    entry.persistence?.status, ...Object.keys(candidateMap).sort()].join('|');
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function exactAttemptForEntry(entry, attempts) {
  return attempts.find((attempt) => attempt?.attempt_id === entry.attempt_id
    && (attempt.root_obligation_id ?? attempt.logical_obligation_id) === entry.root_obligation_id
    && attempt.source_range?.start === entry.source_range?.start
    && attempt.source_range?.end === entry.source_range?.end
    && attempt.source_fingerprint === entry.source_fingerprint) ?? null;
}

function manifestEvidenceForEntry(entry, coverage) {
  const record = coverage.find((item) => {
    const range = coverageRange(item);
    return item.tier === entry.tier && (item.owner ?? null) === (entry.owner ?? null)
      && range?.start === entry.source_range?.start && range?.end === entry.source_range?.end
      && (!item.source_fingerprint || item.source_fingerprint === entry.source_fingerprint);
  });
  if (record && ['completed', 'repartitioned_completed'].includes(record.coverage_terminal_state)) return true;
  if (entry.child_obligation_id === entry.root_obligation_id
    && entry.manifest_transition?.status === 'not_applicable') return true;
  return ['applied', 'applied_verified', 'idempotent_duplicate_verified'].includes(
    entry.manifest_transition?.status)
    && ['leaf_covered', 'explicit_no_update', 'durably_committed', undefined, null]
      .includes(entry.manifest_transition?.disposition ?? entry.manifest_transition?.requested_disposition);
}

function coverageRange(record) {
  return normalizeRange(record?.effective_range ?? record?.original_range ?? record?.source_range ?? record);
}

function findObligationForCoverage(ledger, record, rootId = null) {
  const range = coverageRange(record);
  const candidates = Object.values(ledger.obligations).filter((item) => item.tier === record.tier
    && (item.owner ?? null) === (record.owner ?? null)
    && item.source_range?.start === range?.start && item.source_range?.end === range?.end
    && (!record.source_fingerprint || item.source_fingerprint === record.source_fingerprint)
    && (!rootId || item.obligation_id === rootId || item.obligation_id.startsWith(`${rootId}:leaf:`)));
  return candidates[0] ?? null;
}

export function deriveMemorizeSafeResumeOffset(ledgerValue, startingOffset = 0) {
  const ledger = ensureMemorizeObligationLedger(ledgerValue);
  let offset = Math.max(0, Number(startingOffset) || 0);
  const roots = Object.values(ledger.obligations).filter((item) => !item.parent_obligation_id
    && item.source_range && item.source_range.end >= offset);
  while (true) {
    const candidates = roots.filter((item) => item.source_range.start === offset);
    if (!candidates.length || candidates.some((item) => !item.checkpoint_eligible)) break;
    const ends = new Set(candidates.map((item) => item.source_range.end));
    if (ends.size !== 1) break;
    offset = candidates[0].source_range.end + 1;
  }
  return offset;
}

/**
 * Repairs false-negative ledger projections from durable coverage and provider
 * completion evidence. It never invokes a provider or persistence callback.
 */
export function reconcileMemorizeLifecycleFromJournal(ledgerValue, input = {}) {
  const ledger = ensureMemorizeObligationLedger(ledgerValue, input.logical_run_id);
  const before = JSON.stringify(ledger);
  const coverage = (input.coverage_records ?? []).filter((item) => item?.tier);
  const byRangeId = new Map(coverage.filter((item) => item.range_id)
    .map((item) => [item.range_id, item]));
  const rootIds = new Set(journalEntries(input.journal).map((entry) => entry.root_obligation_id).filter(Boolean));
  for (const obligation of Object.values(ledger.obligations)) {
    if (!obligation.parent_obligation_id && coverage.some((record) =>
      findObligationForCoverage(ledger, record)?.obligation_id === obligation.obligation_id)) {
      rootIds.add(obligation.obligation_id);
    }
  }
  for (const rootId of rootIds) {
    const scoped = coverage.filter((record) => {
      const obligation = findObligationForCoverage(ledger, record, rootId);
      return Boolean(obligation);
    });
    const childrenByParent = new Map();
    for (const record of scoped) {
      if (!record.parent_range_id) continue;
      const parentRecord = byRangeId.get(record.parent_range_id);
      const parent = parentRecord ? findObligationForCoverage(ledger, parentRecord, rootId) : null;
      const child = findObligationForCoverage(ledger, record, rootId);
      if (!parent || !child || parent.obligation_id === child.obligation_id) continue;
      const list = childrenByParent.get(parent.obligation_id) ?? [];
      list.push(child);
      childrenByParent.set(parent.obligation_id, list);
    }
    for (const [parentId, children] of childrenByParent) {
      const priorParentState = ledger.obligations[parentId]?.current_state;
      const childResult = applyMemorizeLifecycleEvent(ledger, ledger.obligations[parentId], {
        type: 'recovery_children_declared', children,
        event_id: `coverage-tree:${parentId}:${children.map((child) => child.obligation_id).sort().join(',')}`,
        at: input.at,
      });
      requireAppliedLifecycleResult(childResult,
        [SAFE_STATES.has(priorParentState) ? priorParentState : 'pending_recovery'], {
          stage: 'recovery_child_registration', obligation_id: parentId,
          event_type: 'recovery_children_declared',
        });
    }
  }
  const reusedAttemptIds = [];
  const preservedRecordIds = [];
  const entries = journalEntries(input.journal);
  const attempts = input.provider_attempts?.recent_attempts ?? input.provider_attempts ?? [];
  for (const entry of entries) {
    const obligation = ledger.obligations[entry.child_obligation_id]
      ?? ledger.obligations[entry.root_obligation_id];
    if (!obligation) continue;
    const exactAttempt = exactAttemptForEntry(entry, attempts);
    const legacyExactEvidence = !entry.logical_run_id && Boolean(exactAttempt)
      && exactAttempt.attempt_id === entry.attempt_id
      && exactAttempt.source_fingerprint === entry.source_fingerprint
      && (exactAttempt.child_obligation_id === entry.child_obligation_id
        || exactAttempt.root_obligation_id === entry.root_obligation_id
        || exactAttempt.logical_obligation_id === entry.root_obligation_id);
    const sameLogicalRun = !input.logical_run_id
      || entry.logical_run_id === input.logical_run_id
      || legacyExactEvidence;
    const exactCurrentLineage = obligation.provider_attempt_lineage
      ?.includes(entry.attempt_id) === true;
    if (!sameLogicalRun && !exactCurrentLineage) {
      const observation = {
        code: 'historical_provider_evidence_outside_current_lineage',
        obligation_id: obligation.obligation_id,
        provider_attempt_id: entry.attempt_id,
        historical_logical_run_id: entry.logical_run_id ?? null,
        current_logical_run_id: input.logical_run_id ?? null,
        classification: 'informational_not_current_runtime_blocker',
        blocking: false,
      };
      if (!(ledger.historical_transition_observations ?? []).some((item) =>
        item.code === observation.code && item.provider_attempt_id === entry.attempt_id
        && item.current_logical_run_id === observation.current_logical_run_id)) {
        ledger.historical_transition_observations = [
          ...(ledger.historical_transition_observations ?? []), observation,
        ].slice(-256);
      }
      continue;
    }
    if (entry?.terminal_outcome === 'provider_response_malformed') {
      if (!obligation.provider_attempt_lineage?.includes(entry.attempt_id)) continue;
      if (obligation.checkpoint_eligible === true) {
        entry.ledger_transition = {
          status: 'not_applicable', requested_disposition: 'historical_superseded_attempt',
          resulting_state: obligation.current_state,
          reason_code: 'later_terminal_coverage_supersedes_malformed_attempt',
          acknowledged_at: nowValue(input.at),
        };
        entry.completed_at ??= nowValue(input.at);
        const observation = {
          code: 'terminal_malformed_attempt_superseded_by_later_terminal_coverage',
          obligation_id: obligation.obligation_id, provider_attempt_id: entry.attempt_id,
          classification: 'superseded_by_later_attempt',
        };
        if (!(ledger.historical_transition_observations ?? []).some((item) =>
          item.code === observation.code && item.provider_attempt_id === entry.attempt_id)) {
          ledger.historical_transition_observations = [
            ...(ledger.historical_transition_observations ?? []), observation,
          ].slice(-256);
        }
        continue;
      }
      const malformedResult = applyMemorizeLifecycleEvent(ledger, obligation, {
        type: 'terminal_malformed_attempt_settled',
        provider_attempt_id: entry.attempt_id,
        terminal_outcome: entry.terminal_outcome,
        malformed_reason: exactAttempt?.malformed_reason
          ?? entry.persistence?.reason_code ?? 'terminal_malformed_provider_output',
        exact_reason_code: exactAttempt?.malformed_reason
          ?? entry.persistence?.reason_code ?? 'terminal_malformed_provider_output',
        next_eligible_action: 'dispatch_bounded_recovery_attempt',
        recovery_stage: entry.recovery_stage ?? exactAttempt?.recovery_stage ?? null,
        event_id: `terminal-malformed-settlement:${entry.attempt_id}`,
        at: input.at,
      });
      try {
        const receipt = requireAppliedLifecycleResult(malformedResult, ['pending_recovery'], {
          stage: 'terminal_malformed_attempt_reconciliation',
          obligation_id: obligation.obligation_id,
          event_type: 'terminal_malformed_attempt_settled',
        });
        acknowledgeJournalTransition(entry, 'ledger_transition', receipt, {
          target_obligation_id: obligation.obligation_id,
          disposition: 'pending_recovery',
        });
        reusedAttemptIds.push(entry.attempt_id);
      } catch (error) {
        entry.ledger_transition = {
          status: 'pending_reconciliation',
          requested_disposition: 'pending_recovery',
          rejection_reason: error.sme_reason_code ?? error.code,
          next_action: 'settle_terminal_malformed_attempt',
          acknowledged_at: nowValue(input.at),
        };
      }
      continue;
    }
    if (!['completed', 'completed_no_candidates', 'completed_repartitioned']
      .includes(entry?.terminal_outcome)) continue;
    // Journal entries for a repartition parent describe the superseded
    // physical attempt, not terminal leaf coverage. Parents close only after
    // their registered children aggregate.
    if (obligation.expected_child_obligation_ids?.length) continue;
    if ((!entry.validation?.status || entry.validation.status === 'pending')
      && exactAttempt?.downstream_validation_result
      && ['committed', 'verified_existing'].includes(exactAttempt.persistence_result)
      && exactAttempt.unresolved_semantic_requirements !== true) {
      entry.validation = { ...entry.validation, status: 'accepted',
        repaired_from_attempt_audit: true,
        accepted_count: Number(exactAttempt.downstream_validation_result.accepted_count ?? 0) };
    }
    if (!entry.parser_result?.status && entry.parser_status
      && ['accepted', 'partial'].includes(entry.parser_status)) {
      entry.parser_result = { status: entry.parser_status, repaired_from_journal_export: true };
    }
    // v0.9.78 sometimes journaled a completed-no-candidates attempt before
    // copying its downstream no-update disposition. The exact audit record is
    // durable evidence for that missing boundary; no provider or persistence
    // callback is involved in this repair.
    if (entry.terminal_outcome === 'completed_no_candidates'
      && !['not_needed', 'not_required_validated_no_update', 'not_applicable']
        .includes(entry.persistence?.status)
      && exactAttempt?.downstream_terminal_outcome === 'completed_no_candidates'
      && exactAttempt?.persistence_result === 'not_required_validated_no_update'
      && Number(exactAttempt?.downstream_validation_result?.accepted_count ?? 0) === 0
      && Number(exactAttempt?.downstream_validation_result?.rejected_count ?? 0) === 0) {
      entry.parser_result = { ...(entry.parser_result ?? {}), status: 'validated_no_update',
        repaired_from_attempt_audit: true };
      entry.validation = { ...(entry.validation ?? {}), status: 'validated_no_update',
        repaired_from_attempt_audit: true };
      entry.persistence = { status: 'not_required_validated_no_update', durable_record_ids: [],
        repaired_from_attempt_audit: true };
      entry.manifest_transition = { ...(entry.manifest_transition ?? {}),
        status: 'pending_reconciliation', requested_disposition: 'explicit_no_update' };
      entry.ledger_transition = { ...(entry.ledger_transition ?? {}),
        status: 'pending_reconciliation', requested_disposition: 'explicit_no_update' };
    }
    const persistence = entry.persistence ?? {};
    const durableIds = normalizeIds(persistence.durable_record_ids);
    const explicitNoUpdate = entry.terminal_outcome === 'completed_no_candidates'
      && ['not_needed', 'not_required_validated_no_update', 'not_applicable'].includes(persistence.status);
    const terminallyCovered = (explicitNoUpdate
      || ['committed', 'verified_existing'].includes(persistence.status))
      && (manifestEvidenceForEntry(entry, coverage) || obligation.checkpoint_eligible === true);
    if (!terminallyCovered) continue;
    reusedAttemptIds.push(entry.attempt_id);
    preservedRecordIds.push(...durableIds);
    const candidateMap = Object.fromEntries((entry.validated_record_identities ?? [])
      .filter((item) => item?.id && item?.candidate_id && durableIds.includes(String(item.id)))
      .map((item) => [String(item.id), String(item.candidate_id)]));
    const laterAttempts = attempts.filter((attempt) => attempt?.at > (exactAttempt?.at ?? entry.started_at ?? 0)
      && (attempt.child_obligation_id === obligation.obligation_id
        || ((!attempt.child_obligation_id || attempt.child_obligation_id === attempt.root_obligation_id)
          && (attempt.root_obligation_id ?? attempt.logical_obligation_id) === entry.root_obligation_id
          && attempt.source_range?.start === entry.source_range?.start
          && attempt.source_range?.end === entry.source_range?.end
          && attempt.source_fingerprint === entry.source_fingerprint)));
    const noIncompatibleLaterAttempt = laterAttempts.every((attempt) =>
      ['completed', 'completed_no_candidates', 'completed_repartitioned'].includes(attempt.terminal_outcome)
      && attempt.persistence_result === persistence.status);
    const evidenceFingerprint = terminalEvidenceFingerprint(entry, candidateMap);
    const result = applyMemorizeLifecycleEvent(ledger, {
      ...obligation,
      obligation_id: obligation.obligation_id,
      root_obligation_id: entry.root_obligation_id,
    }, {
      type: 'terminal_attempt_evidence_reconciled',
      provider_attempt_id: entry.attempt_id,
      evidence_fingerprint: evidenceFingerprint,
      terminal_evidence: {
        provider_attempt_id: entry.attempt_id,
        root_obligation_id: entry.root_obligation_id,
        leaf_obligation_id: obligation.obligation_id,
        source_range: entry.source_range,
        source_fingerprint: entry.source_fingerprint,
        terminal_outcome: entry.terminal_outcome,
        parser_status: entry.parser_result?.status ?? entry.parser_status
          ?? (explicitNoUpdate ? 'validated_no_update' : null),
        validation_status: entry.validation?.status ?? (explicitNoUpdate ? 'validated_no_update' : null),
        persistence_status: persistence.status,
        durable_record_ids: durableIds,
        durable_record_candidate_map: candidateMap,
        explicit_no_update: explicitNoUpdate,
        manifest_leaf_covered: true,
        no_incompatible_later_attempt: noIncompatibleLaterAttempt,
      },
      event_id: `terminal-evidence:${entry.attempt_id}:${evidenceFingerprint}`,
      at: input.at,
    });
    try {
      const expectedState = explicitNoUpdate ? 'explicit_no_update' : 'durably_committed';
      const receipt = requireAppliedLifecycleResult(result, [expectedState], {
        stage: 'completion_journal_reconciliation', obligation_id: obligation.obligation_id,
        event_type: 'terminal_attempt_evidence_reconciled',
        evidence_fingerprint: evidenceFingerprint,
      });
      const acknowledgementBefore = JSON.stringify({ ledger: entry.ledger_transition,
        manifest: entry.manifest_transition, completed_at: entry.completed_at });
      acknowledgeJournalTransition(entry, 'ledger_transition', receipt, {
        target_obligation_id: obligation.obligation_id,
        disposition: expectedState, evidence_fingerprint: evidenceFingerprint,
      });
      acknowledgeJournalTransition(entry, 'manifest_transition', receipt, {
        target_obligation_id: obligation.obligation_id,
        disposition: explicitNoUpdate ? 'explicit_no_update' : 'leaf_covered',
        evidence_fingerprint: evidenceFingerprint,
      });
      entry.completed_at ??= nowValue(input.at);
      if (acknowledgementBefore !== JSON.stringify({ ledger: entry.ledger_transition,
        manifest: entry.manifest_transition, completed_at: entry.completed_at })) {
        entry.updated_at = nowValue(input.at);
      }
    } catch (error) {
      entry.ledger_transition = { status: 'rejected', target_obligation_id: obligation.obligation_id,
        requested_disposition: explicitNoUpdate ? 'explicit_no_update' : 'durably_committed',
        rejection_reason: result.violation?.code ?? 'terminal_evidence_reconciliation_rejected',
        reducer_result: result.status ?? null,
        resulting_state: result.obligation?.current_state ?? null,
        rejection_detail: error?.message ?? null,
        acknowledged_at: nowValue(input.at), evidence_fingerprint: evidenceFingerprint };
    }
  }
  const aggregation = aggregateMemorizeObligationParents(ledger, input.at);
  // A current-runtime violation remains active until durable journal evidence
  // proves the missing step. Once proven, retain it as reconciled history
  // instead of allowing it to keep a completed run inconsistent forever.
  const journalByAttempt = new Map(entries.filter((entry) => entry?.attempt_id)
    .map((entry) => [entry.attempt_id, entry]));
  const evidenceForViolation = (violation) => {
    const obligation = ledger.obligations[violation.obligation_id];
    if (!obligation?.checkpoint_eligible) return false;
    const scoped = entries.filter((entry) => entry.root_obligation_id === violation.obligation_id
      || entry.child_obligation_id === violation.obligation_id);
    const entry = journalByAttempt.get(violation.provider_attempt_id) ?? scoped.at(-1);
    if (!entry || entry.terminal_outcome === 'running') return false;
    const parser = Boolean(entry.parser_result?.status);
    const validation = Boolean(entry.validation?.status
      && entry.validation.status !== 'pending');
    const persisted = ['committed', 'verified_existing', 'not_needed']
      .includes(entry.persistence?.status);
    switch (violation.code) {
      case 'provider_response_without_registered_attempt':
        return Boolean(entry.provider_disposition || entry.private_response_retained);
      case 'parser_disposition_without_provider_response': return parser;
      case 'validation_disposition_without_parser_disposition': return parser && validation;
      case 'records_staged_without_validation_acceptance': return validation && persisted;
      case 'durable_persistence_without_accepted_staged_records': return parser && validation && persisted;
      case 'no_update_without_parser_or_validation_evidence': return parser && persisted;
      case 'provider_retry_started_before_prior_attempt_disposition':
        return scoped.length > 0 && scoped.every((item) => item.terminal_outcome !== 'running');
      case 'durable_record_missing_candidate_mapping':
        return Boolean(obligation.lifecycle?.durable_record_candidate_map?.[violation.record_id]);
      case 'parent_completion_without_complete_registered_children':
        return Boolean(obligation.expected_child_obligation_ids?.length)
          && obligation.expected_child_obligation_ids.every((childId) =>
            ledger.obligations[childId]?.checkpoint_eligible === true);
      case 'illegal_obligation_state_transition': return parser && persisted;
      case 'terminal_attempt_reconciliation_missing_evidence':
      case 'terminal_malformed_settlement_cannot_regress_terminal_state':
        return obligation.checkpoint_eligible === true;
      default: return false;
    }
  };
  const reconciledViolations = [];
  ledger.transition_violations = (ledger.transition_violations ?? []).filter((violation) => {
    if (!evidenceForViolation(violation)) return true;
    reconciledViolations.push({
      ...violation,
      original_classification: violation.classification ?? 'current_runtime',
      classification: 'reconciled_from_provider_completion_journal',
      reconciliation_version: 1,
      reconciled_at: nowValue(input.at),
    });
    return false;
  });
  if (reconciledViolations.length) ledger.historical_transition_observations = [
    ...(ledger.historical_transition_observations ?? []), ...reconciledViolations,
  ].slice(-256);
  const safeResumeOffset = deriveMemorizeSafeResumeOffset(
    ledger, input.checkpoint_before ?? input.starting_offset ?? 0);
  const chunkSize = Math.max(1, Number(input.chunk_size ?? 20) || 20);
  const sourceCount = Number.isFinite(Number(input.source_message_count))
    ? Number(input.source_message_count) : null;
  const after = JSON.stringify(ledger);
  return {
    ledger, mutations: before === after ? 0 : 1,
    parent_aggregation_mutations: aggregation.mutations,
    provider_calls: 0, persistence_calls: 0,
    reused_attempt_ids: normalizeIds(reusedAttemptIds),
    preserved_durable_record_ids: normalizeIds(preservedRecordIds),
    reconciled_transition_violation_count: reconciledViolations.length,
    safe_resume_offset: safeResumeOffset,
    next_source_range: sourceCount == null || safeResumeOffset >= sourceCount ? null : {
      start: safeResumeOffset, end: Math.min(sourceCount - 1, safeResumeOffset + chunkSize - 1),
    },
  };
}

/** Repairs persisted running states when no physical provider attempt is active. */
export function reconcileMemorizeRunningObligations(ledgerValue, providerAudit = null) {
  const ledger = ensureMemorizeObligationLedger(ledgerValue);
  const attemptObligationId = (attempt) => attempt?.child_obligation_id
    ?? attempt?.logical_obligation_id ?? attempt?.root_obligation_id ?? null;
  const runningAttempts = new Map((providerAudit?.recent_attempts ?? [])
    .filter((attempt) => attempt?.terminal_outcome === 'running' && attemptObligationId(attempt))
    .map((attempt) => [attemptObligationId(attempt), attempt]));
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
    const terminalAttempt = [...(providerAudit?.recent_attempts ?? [])].reverse()
      .find((attempt) => attemptObligationId(attempt) === obligation.obligation_id
        && attempt?.terminal_outcome && attempt.terminal_outcome !== 'running');
    const malformedTerminal = terminalAttempt && [
      'provider_response_malformed', 'malformed', 'invalid_output',
    ].includes(terminalAttempt.terminal_outcome);
    const successfulTerminal = terminalAttempt && [
      'completed', 'completed_no_candidates', 'completed_repartitioned',
    ].includes(terminalAttempt.terminal_outcome);
    const persisted = Number(obligation.metrics?.persisted_records ?? 0);
    obligation.current_state = 'pending_recovery';
    obligation.checkpoint_eligible = false;
    obligation.exact_reason_code = malformedTerminal
      ? 'terminal_malformed_attempt_pending_semantic_settlement'
      : successfulTerminal
        ? 'terminal_provider_attempt_pending_downstream_reconciliation'
      : 'stale_provider_running_without_physical_attempt';
    obligation.next_eligible_action = Number(obligation.metrics?.unresolved_parser_fragments ?? 0) > 0
      ? 'recover_unresolved_partial_output_fragments'
      : malformedTerminal ? 'settle_terminal_malformed_attempt'
        : successfulTerminal ? 'continue_pending_downstream_processing'
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
      reason_code: obligation.exact_reason_code, persisted_records_preserved: persisted,
      terminal_attempt_id: terminalAttempt?.attempt_id ?? null,
      terminal_outcome: terminalAttempt?.terminal_outcome ?? null,
      next_eligible_action: obligation.next_eligible_action,
      provider_request_must_not_repeat: Boolean(terminalAttempt) });
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
  if (existing && input.finalize_transaction_evidence === true) {
    Object.assign(existing, {
      active_transaction_id: input.active_transaction_id ?? existing.active_transaction_id,
      active_transaction_state: input.active_transaction_state ?? 'not_applicable',
      checkpoint_after: Number.isFinite(Number(input.checkpoint_after))
        ? Number(input.checkpoint_after) : existing.checkpoint_after,
      transaction_evidence_finalized: true,
      at: nowValue(input.at),
    });
    ledger.updated_at = existing.at;
    return existing;
  }
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
  const diagnosticForPending = (item) => {
    const durableCount = item.lifecycle?.durably_persisted_record_ids?.length ?? 0;
    const unresolvedCount = item.lifecycle?.unresolved_fragment_ids?.length ?? 0;
    const cursor = durableCount > 0 && unresolvedCount > 0
      ? 'unresolved_fragments_pending'
      : durableCount > 0 ? 'accepted_records_persisted'
        : item.current_state === 'partial_records_committed' ? 'accepted_records_persisted'
          : item.current_state === 'validation_accepted' || item.current_state === 'validation_partial'
            ? 'validation_complete'
            : item.current_state === 'parser_accepted' ? 'parser_complete'
              : item.current_state === 'parser_partial' ? 'parser_partial'
                : item.current_state === 'provider_response_received' ? 'response_recorded'
                  : null;
    const actionContract = getMemorizeActionContract(item.next_eligible_action);
    const actionable = ACTIONABLE_STATES.has(item.current_state)
      && Boolean(item.exact_reason_code && item.next_eligible_action && actionContract);
    const providerCallRequired = actionable && actionContract?.provider_call_required === true;
    return {
      ...item,
      physical_attempt_id: item.provider_attempt_lineage?.at(-1) ?? null,
      physical_terminal_outcome: item.metrics?.physical_terminal_outcome ?? null,
      furthest_verified_downstream_stage: cursor,
      accepted_durable_record_count: durableCount,
      unresolved_fragment_count: unresolvedCount,
      exact_next_action: item.next_eligible_action ?? null,
      provider_call_required: providerCallRequired,
      persistence_required: actionable && actionContract?.persistence_required === true,
      actionability_reason: actionable ? 'canonical_exact_action_available'
        : !ACTIONABLE_STATES.has(item.current_state) ? 'current_state_not_actionable'
          : !item.exact_reason_code ? 'missing_exact_reason'
            : !item.next_eligible_action ? 'missing_next_action' : 'unknown_action_contract',
      replay_adoption_classification: cursor === 'unresolved_fragments_pending'
        ? 'current_run_recover_fragments' : null,
      earlier_failure_superseded: (ledger.historical_transition_observations ?? [])
        .some((observation) => observation.obligation_id === item.obligation_id
          && /superseded|repaired_by_later/.test(String(observation.classification ?? ''))),
    };
  };
  const pendingDiagnostics = pending.map(diagnosticForPending);
  // Parents summarize child coverage; only leaves may be dispatched. This
  // prevents Resume from selecting the ambiguous root and repeating a child
  // whose durable work is already complete.
  const actionable = pending.filter((item) => !(item.expected_child_obligation_ids?.length)
    && ACTIONABLE_STATES.has(item.current_state)
    && item.exact_reason_code && item.next_eligible_action
    && getMemorizeActionContract(item.next_eligible_action));
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
    else if (!getMemorizeActionContract(item.next_eligible_action)) violations.push({
      code: 'uncommitted_obligation_unknown_action_contract', obligation_id: item.obligation_id,
      next_eligible_action: item.next_eligible_action,
    });
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
    pending_obligations: pendingDiagnostics,
    pending_obligation_diagnostics: pendingDiagnostics,
    next_eligible_obligation: actionable[0]
      ? diagnosticForPending(actionable[0]) : null,
    tier_coverage: byTier,
    chunks: Object.values(chunks),
    controller_exits: ledger.controller_exits,
    last_controller_exit: ledger.controller_exits.at(-1) ?? null,
    recovery_backlog: structuredClone(ledger.recovery_backlog ?? []),
    recovery_backlog_count: (ledger.recovery_backlog ?? []).length,
    completion_gate_satisfied: pending.length === 0 && (ledger.recovery_backlog ?? []).length === 0,
    historical_transition_observations: structuredClone(
      ledger.historical_transition_observations ?? []),
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
    const existingCanonical = Object.values(ledger.obligations ?? {}).find((item) =>
      item.tier === legacy.tier && item.parent_obligation_id == null
        && Number(item.source_range?.start) === Number(range.start)
        && Number(item.source_range?.end) === Number(range.end)
        && item.source_fingerprint);
    // The canonical fingerprinted obligation supersedes compatibility range
    // records. Replaying the legacy projection must never create a parallel
    // `:legacy` authority path or overwrite the canonical action contract.
    if (existingCanonical && !matchingProvider) continue;
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

