/** Pure retained-provider-evidence planning. Physical origin and adoption are distinct facts. */

export const PROVIDER_EVIDENCE_PROVENANCE = Object.freeze({
  PRIOR_RUN_ADOPTABLE: 'prior_run_adoptable',
  CURRENT_RUN_CONTINUE_DOWNSTREAM: 'current_run_continue_downstream',
  CURRENT_RUN_RECOVER_FRAGMENTS: 'current_run_recover_fragments',
  ALREADY_TERMINAL: 'already_terminal',
  SUPERSEDED: 'superseded_by_verified_later_attempt',
  MISSING_PRIVATE_EVIDENCE: 'unusable_missing_private_evidence',
  INCOMPLETE_RECONCILIATION: 'incomplete_reconciliation_evidence',
  IDENTITY_MISMATCH: 'identity_mismatch',
});

const TERMINAL_SUCCESS = new Set(['completed', 'completed_no_candidates', 'completed_repartitioned']);
const VERIFIED_PERSISTENCE = new Set([
  'committed', 'verified_existing', 'not_needed', 'not_required',
  'not_required_validated_no_update', 'not_applicable',
]);
const VERIFIED_TRANSITION = new Set([
  'applied_verified', 'idempotent_duplicate_verified', 'not_applicable', 'applied',
]);

const clone = (value) => value == null ? value : structuredClone(value);
const freeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
};
const sameOwner = (left, right) => String(left ?? '').trim().toLowerCase()
  === String(right ?? '').trim().toLowerCase();

export function exactRetainedEvidenceIdentity(entry, input = {}) {
  const leaf = entry?.child_obligation_id ?? entry?.root_obligation_id;
  return entry?.root_obligation_id === input.root_obligation_id
    && (!input.child_obligation_id || leaf === input.child_obligation_id)
    && (!input.tier || entry.tier === input.tier)
    && (input.owner === undefined || sameOwner(entry.owner, input.owner))
    && (!input.source_range || (Number(entry.source_range?.start) === Number(input.source_range.start)
      && Number(entry.source_range?.end) === Number(input.source_range.end)))
    && entry.source_fingerprint === input.source_fingerprint;
}

export function deriveRetainedEvidenceDownstreamCursor(entry = {}, obligation = null) {
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
  if (['not_needed', 'not_required', 'not_required_validated_no_update']
    .includes(entry.persistence?.status)) return 'explicit_no_update';
  if (entry.validation?.status && entry.validation.status !== 'pending') return 'validation_complete';
  if (entry.parser_result?.status === 'partial') return 'parser_partial';
  if (entry.parser_result?.status) return 'parser_complete';
  if (entry.response_text != null || entry.provider_disposition === 'response_received') {
    return 'response_recorded';
  }
  return null;
}

export function retainedEvidenceAdoption(entry, obligation, currentLogicalRunId) {
  const attemptId = entry?.attempt_id ?? null;
  const relationships = obligation?.evidence_adoptions ?? [];
  const relationship = relationships.find((item) => item?.origin_attempt_id === attemptId
    && item?.adopted_into_logical_run_id === currentLogicalRunId
    && item?.canonical_obligation_id === obligation?.obligation_id) ?? null;
  const metricsMatch = obligation?.metrics?.adopted_from_attempt_id === attemptId
    && (!currentLogicalRunId || obligation?.logical_run_id === currentLogicalRunId);
  const semanticMatch = (obligation?.semantic_event_history ?? []).some((event) =>
    event?.type === 'terminal_provider_evidence_adopted'
      && event?.provider_attempt_id === attemptId);
  const fingerprintMatch = String(obligation?.metrics?.adopted_evidence_fingerprint ?? '')
    .includes(`|${attemptId}|`);
  const adopted = Boolean(relationship || metricsMatch || semanticMatch || fingerprintMatch);
  return freeze({
    adopted,
    relationship: clone(relationship),
    adopted_into_logical_run_id: adopted
      ? currentLogicalRunId ?? obligation?.logical_run_id ?? null : null,
    canonical_obligation_id: adopted ? obligation?.obligation_id ?? null : null,
    obligation_revision_at_adoption: relationship?.obligation_revision_at_adoption ?? null,
    adoption_evidence: {
      durable_relationship: Boolean(relationship), metrics_match: metricsMatch,
      semantic_event_match: semanticMatch, fingerprint_match: fingerprintMatch,
    },
  });
}

export function verifiedNoUpdateEvidence(entry = {}) {
  const parserStatus = entry.parser_result?.status ?? entry.parser_status ?? null;
  const validationStatus = entry.validation?.status ?? null;
  const persistenceStatus = entry.persistence?.status ?? null;
  const parserAcceptedNone = ['accepted_no_candidates', 'no_candidates', 'accepted']
    .includes(parserStatus) && Number(entry.parser_result?.accepted_count
      ?? entry.parser_accepted_count ?? 0) === 0;
  const validationAcceptedNone = ['accepted', 'accepted_no_candidates', 'not_needed']
    .includes(validationStatus) && Number(entry.validation?.accepted_count ?? 0) === 0;
  const persistenceSettled = ['not_needed', 'not_required',
    'not_required_validated_no_update', 'verified_existing'].includes(persistenceStatus);
  const ledgerSettled = VERIFIED_TRANSITION.has(entry.ledger_transition?.status)
    && entry.ledger_transition?.checkpoint_eligible !== false;
  return entry.terminal_outcome === 'completed_no_candidates'
    && parserAcceptedNone && validationAcceptedNone && persistenceSettled && ledgerSettled;
}

function evidenceFitness(entry, input, adoption) {
  const terminal = TERMINAL_SUCCESS.has(entry?.terminal_outcome);
  const privateResponse = entry?.response_text != null || entry?.private_response_retained === true;
  const parserRecords = Number(entry?.parser_result?.records?.length
    ?? entry?.parser_accepted_count ?? 0) > 0;
  const validationSettled = entry?.validation?.status
    && entry.validation.status !== 'pending';
  const persistenceSettled = VERIFIED_PERSISTENCE.has(entry?.persistence?.status);
  const durableIds = [...new Set(entry?.persistence?.durable_record_ids ?? [])];
  const mappings = (entry?.validated_record_identities ?? [])
    .filter((item) => item?.id && item?.candidate_id).length;
  const verifiedNoUpdate = verifiedNoUpdateEvidence(entry);
  const usable = terminal && (privateResponse || parserRecords || verifiedNoUpdate
    || (persistenceSettled && durableIds.length > 0));
  const cursor = deriveRetainedEvidenceDownstreamCursor(entry,
    adoption.adopted || entry.logical_run_id === input.current_logical_run_id
      ? input.obligation : null);
  const cursorRank = ({ fully_terminal: 80, unresolved_fragments_pending: 70,
    accepted_records_persisted: 60, explicit_no_update: 60, validation_complete: 40,
    parser_partial: 30, parser_complete: 30, response_recorded: 20 }[cursor] ?? 0);
  const score = (adoption.adopted ? 1000 : 0) + (usable ? 500 : 0)
    + (verifiedNoUpdate ? 250 : 0) + (privateResponse ? 160 : 0)
    + (parserRecords ? 120 : 0) + (validationSettled ? 80 : 0)
    + (persistenceSettled ? 80 : 0) + Math.min(50, durableIds.length * 10)
    + Math.min(30, mappings * 5) + cursorRank;
  return { terminal, private_response_retained: privateResponse,
    parser_records_retained: parserRecords, validation_settled: Boolean(validationSettled),
    persistence_settled: persistenceSettled, durable_record_count: durableIds.length,
    durable_candidate_mapping_count: mappings, verified_no_update: verifiedNoUpdate,
    usable, downstream_cursor: cursor, score };
}

function classificationFor(entry, input, adoption, fitness) {
  if (!fitness.terminal) return {
    classification: PROVIDER_EVIDENCE_PROVENANCE.INCOMPLETE_RECONCILIATION,
    next_action: null, blockers: ['physical_attempt_not_terminal_success'],
  };
  if (!fitness.usable) return {
    classification: entry.terminal_outcome === 'completed_no_candidates'
      ? PROVIDER_EVIDENCE_PROVENANCE.INCOMPLETE_RECONCILIATION
      : PROVIDER_EVIDENCE_PROVENANCE.MISSING_PRIVATE_EVIDENCE,
    next_action: 'reconcile_incomplete_retained_evidence',
    blockers: entry.terminal_outcome === 'completed_no_candidates'
      ? ['completed_no_candidates_missing_verified_no_update_evidence']
      : ['retained_private_or_parsed_evidence_unavailable'],
  };
  const cursor = fitness.downstream_cursor;
  if (cursor === 'fully_terminal') return {
    classification: PROVIDER_EVIDENCE_PROVENANCE.ALREADY_TERMINAL,
    next_action: null, blockers: [],
  };
  const current = adoption.adopted
    || entry.logical_run_id === input.current_logical_run_id;
  if (current && cursor === 'unresolved_fragments_pending') return {
    classification: PROVIDER_EVIDENCE_PROVENANCE.CURRENT_RUN_RECOVER_FRAGMENTS,
    next_action: ['recover_exact_unresolved_fragments',
      'recover_unresolved_partial_output_fragments']
      .includes(input.obligation?.next_eligible_action)
      ? input.obligation.next_eligible_action
      : 'recover_exact_unresolved_fragments',
    lifecycle_operation: 'continue_partial_fragment_recovery', blockers: [],
  };
  if (current) return {
    classification: PROVIDER_EVIDENCE_PROVENANCE.CURRENT_RUN_CONTINUE_DOWNSTREAM,
    next_action: cursor === 'response_recorded' ? 'parse_retained_response'
      : ['parser_complete', 'parser_partial'].includes(cursor) ? 'continue_validation'
        : cursor === 'validation_complete' ? 'persist_validated_records'
          : 'continue_pending_downstream_processing',
    lifecycle_operation: 'continue_current_run_downstream', blockers: [],
  };
  return {
    classification: PROVIDER_EVIDENCE_PROVENANCE.PRIOR_RUN_ADOPTABLE,
    next_action: 'adopt_exact_prior_run_evidence',
    lifecycle_operation: 'adopt_exact_prior_run_evidence', blockers: [],
  };
}

export function planRetainedProviderEvidence(input = {}) {
  const candidates = [...new Map((input.candidates ?? []).filter((entry) =>
    exactRetainedEvidenceIdentity(entry, input)
      && (!input.exclude_attempt_id || entry.attempt_id !== input.exclude_attempt_id))
    .map((entry) => [entry.attempt_id ?? JSON.stringify(entry), entry])).values()];
  const evaluated = candidates.map((entry, candidateIndex) => {
    const adoption = retainedEvidenceAdoption(entry, input.obligation,
      input.current_logical_run_id);
    const fitness = evidenceFitness(entry, input, adoption);
    const decision = classificationFor(entry, input, adoption, fitness);
    return { entry, candidate_index: candidateIndex, adoption, fitness, ...decision,
      started_at: Number(entry.started_at ?? entry.at ?? 0) };
  }).sort((left, right) => right.fitness.score - left.fitness.score
    || right.started_at - left.started_at
    || String(left.entry.attempt_id).localeCompare(String(right.entry.attempt_id)));
  const selected = evaluated.find((item) => item.fitness.usable)
    ?? evaluated[0] ?? null;
  const candidateDecisions = evaluated.map((item, order) => ({
    order: order + 1, attempt_id: item.entry.attempt_id,
    physical_origin_logical_run_id: item.entry.logical_run_id ?? null,
    classification: item === selected ? item.classification
      : item.fitness.usable ? PROVIDER_EVIDENCE_PROVENANCE.SUPERSEDED
        : item.classification,
    disposition: item === selected ? 'selected' : item.fitness.usable
      ? 'superseded_by_fitter_evidence' : 'rejected_unusable_evidence',
    evidence_fitness: item.fitness,
    adoption: item.adoption,
    blockers: item.blockers,
  }));
  const obligation = input.obligation ?? null;
  const contract = selected ? {
    provider_call_required: selected.classification
      === PROVIDER_EVIDENCE_PROVENANCE.CURRENT_RUN_RECOVER_FRAGMENTS,
    persistence_required: selected.classification
      === PROVIDER_EVIDENCE_PROVENANCE.PRIOR_RUN_ADOPTABLE
      || selected.classification === PROVIDER_EVIDENCE_PROVENANCE.CURRENT_RUN_CONTINUE_DOWNSTREAM,
  } : { provider_call_required: false, persistence_required: false };
  return freeze({
    schema_version: 1,
    canonical_obligation_id: obligation?.obligation_id
      ?? input.child_obligation_id ?? input.root_obligation_id ?? null,
    canonical_obligation_revision: Number(obligation?.revision ?? 0),
    evidence_origin_attempt_id: selected?.entry.attempt_id ?? null,
    evidence_origin_logical_run_id: selected?.entry.logical_run_id ?? null,
    adoption_state: selected?.adoption ?? null,
    evidence_classification: selected?.classification ?? null,
    downstream_cursor: selected?.fitness.downstream_cursor ?? null,
    lifecycle_operation: selected?.lifecycle_operation ?? null,
    exact_next_action: selected?.next_action ?? null,
    provider_call_required: contract.provider_call_required,
    persistence_required: contract.persistence_required,
    exact_blockers: selected?.blockers ?? ['no_exact_retained_evidence_candidate'],
    selection_rationale: selected ? 'highest_verified_evidence_fitness'
      : 'no_exact_identity_candidate',
    candidate_precedence_rationale: 'verified usable evidence outranks timestamp; recency breaks equal fitness only',
    selected_entry: clone(selected?.entry ?? null),
    candidate_decisions: candidateDecisions,
  });
}
