/**
 * Authoritative Memorize Chat extraction-obligation lifecycle.
 *
 * Provider attempts, parsers, validators, persistence, coverage, checkpoints,
 * diagnostics, and the UI are projections of this ledger.  A provider response
 * is evidence, never completion: only `durably_committed` and
 * `explicit_no_update` make an obligation checkpoint eligible.
 */

export const MEMORIZE_OBLIGATION_LEDGER_SCHEMA_VERSION = 1;
export const MEMORIZE_OBLIGATION_IMPLEMENTATION_VERSION = 1;

export const MEMORIZE_OBLIGATION_STATES = Object.freeze([
  'unattempted', 'provider_running', 'provider_response_received',
  'parser_accepted', 'parser_partial', 'parser_rejected',
  'validation_accepted', 'validation_rejected', 'staged',
  'explicit_no_update', 'pending_recovery', 'operationally_paused',
  'blocked', 'durably_committed',
]);

const SAFE_STATES = new Set(['durably_committed', 'explicit_no_update']);
const ACTIONABLE_STATES = new Set(['unattempted', 'pending_recovery', 'operationally_paused', 'blocked']);
const nowValue = (value) => Number.isFinite(Number(value)) ? Number(value) : Date.now();

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
  ledger.controller_exits = Array.isArray(ledger.controller_exits) ? ledger.controller_exits.slice(-32) : [];
  for (const [key, raw] of Object.entries(ledger.obligations)) {
    const id = stableId({ ...raw, obligation_id: raw?.obligation_id ?? key });
    const state = MEMORIZE_OBLIGATION_STATES.includes(raw?.current_state) ? raw.current_state : 'unattempted';
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
      coverage_result: raw?.coverage_result ?? null,
      checkpoint_eligible: SAFE_STATES.has(state),
      current_state: state,
      exact_reason_code: raw?.exact_reason_code ?? null,
      next_eligible_action: raw?.next_eligible_action ?? defaultNextAction(state, raw?.exact_reason_code),
      timestamps: { ...(raw?.timestamps ?? {}) },
      implementation_version: MEMORIZE_OBLIGATION_IMPLEMENTATION_VERSION,
      schema_version: MEMORIZE_OBLIGATION_LEDGER_SCHEMA_VERSION,
      metrics: { ...(raw?.metrics ?? {}) },
    };
    if (id !== key) delete ledger.obligations[key];
  }
  ledger.normalization_complete = true;
  return ledger;
}

export function transitionMemorizeObligation(ledgerValue, input = {}, transition = {}) {
  const ledger = ensureMemorizeObligationLedger(ledgerValue, input.logical_run_id);
  const id = stableId(input);
  const prior = ledger.obligations[id] ?? {};
  const state = transition.current_state ?? input.current_state ?? prior.current_state ?? 'unattempted';
  if (!MEMORIZE_OBLIGATION_STATES.includes(state)) throw new Error(`Unknown Memorize obligation state: ${state}`);
  const at = nowValue(transition.at);
  const reason = transition.exact_reason_code ?? transition.reason_code ?? prior.exact_reason_code ?? null;
  const range = normalizeRange(input.source_range ?? prior.source_range ?? input);
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
    persistence_result: transition.persistence_result ?? prior.persistence_result ?? null,
    coverage_result: transition.coverage_result ?? prior.coverage_result ?? null,
    current_state: state,
    checkpoint_eligible: SAFE_STATES.has(state),
    exact_reason_code: SAFE_STATES.has(state) ? null : reason,
    next_eligible_action: SAFE_STATES.has(state) ? null
      : transition.next_eligible_action ?? defaultNextAction(state, reason),
    timestamps: {
      ...(prior.timestamps ?? {}),
      created_at: prior.timestamps?.created_at ?? at,
      updated_at: at,
      [`entered_${state}_at`]: at,
    },
    implementation_version: MEMORIZE_OBLIGATION_IMPLEMENTATION_VERSION,
    schema_version: MEMORIZE_OBLIGATION_LEDGER_SCHEMA_VERSION,
    metrics: { ...(prior.metrics ?? {}), ...(transition.metrics ?? {}) },
  };
  ledger.obligations[id] = next;
  ledger.updated_at = at;
  return next;
}

export function recordMemorizeControllerExit(ledgerValue, input = {}) {
  const ledger = ensureMemorizeObligationLedger(ledgerValue, input.logical_run_id);
  const reasonCode = input.reason_code ?? 'unknown_interruption';
  const record = {
    at: nowValue(input.at), reason_code: reasonCode,
    classification: input.classification ?? reasonCode,
    resumable: input.resumable !== false,
    obligation_id: input.obligation_id ?? null,
    next_eligible_action: input.next_eligible_action ?? null,
    detail: input.detail ?? null,
  };
  ledger.controller_exits = [...ledger.controller_exits, record].slice(-32);
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
  return {
    schema_version: ledger.schema_version,
    implementation_version: ledger.implementation_version,
    logical_run_id: ledger.logical_run_id,
    obligation_count: obligations.length,
    safely_committed_obligation_count: safe.length,
    pending_obligation_count: pending.length,
    actionable_pending_obligation_count: actionable.length,
    pending_obligations: pending,
    next_eligible_obligation: actionable[0] ?? null,
    tier_coverage: byTier,
    chunks: Object.values(chunks),
    controller_exits: ledger.controller_exits,
    last_controller_exit: ledger.controller_exits.at(-1) ?? null,
    invariants: { valid: violations.length === 0, violations },
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

