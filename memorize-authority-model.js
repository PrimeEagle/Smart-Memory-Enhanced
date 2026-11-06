import {
  deriveMemorizeSafeResumeOffset,
  ensureMemorizeObligationLedger,
  getMemorizeActionContract,
  projectMemorizeObligationLedger,
} from './memorize-obligation-ledger.js';
import { PROVIDER_EVIDENCE_PROVENANCE, planRetainedProviderEvidence }
  from './retained-evidence-plan.js';

export const MEMORIZE_AUTHORITY_MODEL_VERSION = 1;
const TIERS = Object.freeze(['longterm', 'session']);
const LOCAL_RECONCILIATION_ACTIONS = new Set([
  'continue_pending_downstream_processing',
  'replay_terminal_provider_downstream_lifecycle',
  'settle_terminal_malformed_attempt',
  'reconcile_terminal_attempt_evidence',
]);

const clone = (value) => typeof structuredClone === 'function'
  ? structuredClone(value) : JSON.parse(JSON.stringify(value));

function rangeOf(value = {}) {
  const start = Number(value.start ?? value.start_offset ?? value.source_start_index);
  const end = Number(value.end ?? value.end_offset ?? value.source_end_index);
  const sourceStart = Number(value.source_start_index ?? value.start ?? start);
  const sourceEnd = Number(value.source_end_index ?? value.end ?? end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
  return {
    start_offset: start,
    end_offset: end,
    source_start_index: Number.isInteger(sourceStart) ? sourceStart : start,
    source_end_index: Number.isInteger(sourceEnd) ? sourceEnd : end,
    message_count: end - start + 1,
  };
}

function mergeRanges(values = []) {
  const ranges = values.map(rangeOf).filter(Boolean)
    .sort((left, right) => left.start_offset - right.start_offset
      || left.end_offset - right.end_offset);
  const merged = [];
  for (const range of ranges) {
    const prior = merged.at(-1);
    if (prior && range.start_offset <= prior.end_offset + 1) {
      prior.end_offset = Math.max(prior.end_offset, range.end_offset);
      prior.source_end_index = Math.max(prior.source_end_index, range.source_end_index);
      prior.message_count = prior.end_offset - prior.start_offset + 1;
    } else merged.push({ ...range });
  }
  return merged;
}

function intersection(leftValues, rightValues) {
  const left = mergeRanges(leftValues);
  const right = mergeRanges(rightValues);
  const result = [];
  for (const a of left) for (const b of right) {
    const start = Math.max(a.start_offset, b.start_offset);
    const end = Math.min(a.end_offset, b.end_offset);
    if (end >= start) result.push({
      start_offset: start,
      end_offset: end,
      source_start_index: a.source_start_index + (start - a.start_offset),
      source_end_index: a.source_start_index + (end - a.start_offset),
    });
  }
  return mergeRanges(result);
}

function rootObligations(ledgerValue, tier = null) {
  const ledger = ensureMemorizeObligationLedger(ledgerValue);
  return Object.values(ledger.obligations ?? {}).filter((item) =>
    !item.parent_obligation_id && item.source_range
    && (tier == null || item.tier === tier));
}

function groupTierRoots(ledgerValue, tier) {
  const groups = new Map();
  for (const obligation of rootObligations(ledgerValue, tier)) {
    const range = rangeOf(obligation.source_range);
    if (!range) continue;
    const key = `${range.start_offset}-${range.end_offset}`;
    const group = groups.get(key) ?? { key: `${tier}:${key}`, tier, range, obligations: [] };
    group.obligations.push(obligation);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) =>
    left.range.start_offset - right.range.start_offset
    || left.range.end_offset - right.range.end_offset);
}

/** Canonical status for one tier/range. Compatibility manifests are never read. */
export function getAuthoritativeTierRangeStatus(ledgerValue, tier, rangeValue) {
  if (!TIERS.includes(tier)) return null;
  const range = rangeOf(rangeValue);
  if (!range) return null;
  const group = groupTierRoots(ledgerValue, tier).find((item) =>
    item.range.start_offset === range.start_offset && item.range.end_offset === range.end_offset);
  if (!group) return null;
  const pending = group.obligations.filter((item) => !item.checkpoint_eligible);
  const actionable = pending.find((item) => item.next_eligible_action) ?? null;
  return {
    key: group.key,
    tier,
    ...range,
    enabled: true,
    applicable: true,
    safely_committed: pending.length === 0,
    terminal_outcome: pending.length === 0 ? 'safely_committed' : 'pending',
    current_state: actionable?.current_state ?? pending[0]?.current_state
      ?? group.obligations[0]?.current_state ?? null,
    reason_code: actionable?.exact_reason_code ?? pending[0]?.exact_reason_code ?? null,
    next_eligible_action: actionable?.next_eligible_action ?? null,
    root_obligation_ids: group.obligations.map((item) => item.obligation_id).sort(),
    pending_obligation_ids: pending.map((item) => item.obligation_id).sort(),
    projection_source: 'authoritative_obligation_ledger',
  };
}

export function isAuthoritativeTierRangeSafelyCovered(ledgerValue, tier, range) {
  return getAuthoritativeTierRangeStatus(ledgerValue, tier, range)?.safely_committed === true;
}

/** Canonical status for one Long-Term owner/range. */
export function getAuthoritativeOwnerRangeStatus(ledgerValue, owner, rangeValue) {
  const range = rangeOf(rangeValue);
  if (!range || !String(owner ?? '').trim()) return null;
  const normalizedOwner = String(owner).trim().toLowerCase();
  const obligation = rootObligations(ledgerValue, 'longterm').find((item) =>
    String(item.owner ?? '').trim().toLowerCase() === normalizedOwner
    && Number(item.source_range?.start) === range.start_offset
    && Number(item.source_range?.end) === range.end_offset);
  if (!obligation) return null;
  return {
    obligation_id: obligation.obligation_id,
    tier: 'longterm',
    owner: obligation.owner,
    ...range,
    safely_committed: obligation.checkpoint_eligible === true,
    current_state: obligation.current_state,
    exact_reason_code: obligation.exact_reason_code ?? null,
    next_eligible_action: obligation.next_eligible_action ?? null,
    projection_source: 'authoritative_obligation_ledger',
  };
}

export function getFirstActionableObligation(ledgerValue) {
  return projectMemorizeObligationLedger(ledgerValue).next_eligible_obligation ?? null;
}

/**
 * Derives Resume eligibility from current authoritative state. Historical
 * transition observations may remain for diagnostics, but they can authorize
 * only a local reconciliation step; they can never authorize another provider
 * transmission. This keeps recovery fail-closed without making exact retained
 * terminal evidence impossible to finish.
 */
export function deriveMemorizeResumeEligibility({
  ledger = null,
  projection: suppliedProjection = null,
  provider_audit: providerAudit = null,
  provider_completion_journal: providerCompletionJournal = null,
  active_transaction = null,
} = {}) {
  const projection = suppliedProjection ?? projectMemorizeObligationLedger(ledger);
  const pending = projection.next_eligible_obligation ?? null;
  const action = pending?.next_eligible_action ?? null;
  const journalEntries = Array.isArray(providerCompletionJournal?.entries)
    ? providerCompletionJournal.entries
    : Object.values(providerCompletionJournal?.entries ?? {});
  const retainedPlan = pending ? planRetainedProviderEvidence({
    current_logical_run_id: projection.logical_run_id ?? ledger?.logical_run_id ?? null,
    root_obligation_id: pending.parent_obligation_id ?? pending.obligation_id,
    child_obligation_id: pending.obligation_id,
    tier: pending.tier, owner: pending.owner,
    source_range: pending.source_range,
    source_fingerprint: pending.source_fingerprint,
    obligation: pending,
    candidates: journalEntries,
  }) : null;
  const exactRetainedCompletion = retainedPlan?.selected_entry ?? null;
  const retainedClassification = retainedPlan?.evidence_classification ? {
    classification: retainedPlan.evidence_classification,
    downstream_cursor: retainedPlan.downstream_cursor,
    next_action: retainedPlan.exact_next_action,
    provider_call_required: retainedPlan.provider_call_required,
    persistence_required: retainedPlan.persistence_required,
  } : null;
  const physicalRunning = (providerAudit?.recent_attempts ?? [])
    .filter((attempt) => attempt?.terminal_outcome === 'running');
  const currentRunningCount = Math.max(
    Number(projection.running_obligation_count ?? 0), physicalRunning.length);
  if (active_transaction) return {
    eligible: false, mode: 'blocked', reason_code: 'active_transaction_not_settled',
    next_eligible_action: action, obligation_id: pending?.obligation_id ?? null,
    provider_call_required: false,
  };
  if (currentRunningCount > 0) return {
    eligible: false, mode: 'blocked', reason_code: 'provider_runtime_not_reconciled',
    next_eligible_action: action, obligation_id: pending?.obligation_id ?? null,
    provider_call_required: false, running_count: currentRunningCount,
  };
  if (!pending || !action) return {
    eligible: false, mode: 'blocked', reason_code: projection.pending_obligation_count > 0
      ? 'pending_obligation_has_no_exact_action' : 'no_pending_resume_obligation',
    next_eligible_action: null, obligation_id: null, provider_call_required: false,
  };
  if (retainedClassification?.classification
    === PROVIDER_EVIDENCE_PROVENANCE.PRIOR_RUN_ADOPTABLE) return {
    eligible: true, mode: 'local_reconciliation_only',
    reason_code: 'exact_retained_terminal_evidence_available',
    next_eligible_action: 'adopt_exact_prior_run_evidence',
    obligation_id: pending.obligation_id,
    physical_attempt_id: exactRetainedCompletion.attempt_id,
    provider_call_required: false,
    retained_evidence_plan: retainedPlan,
  };
  if (retainedClassification?.classification
    === PROVIDER_EVIDENCE_PROVENANCE.CURRENT_RUN_CONTINUE_DOWNSTREAM) return {
    eligible: true, mode: 'local_reconciliation_only',
    reason_code: 'current_run_downstream_continuation_available',
    next_eligible_action: retainedClassification.next_action,
    obligation_id: pending.obligation_id,
    physical_attempt_id: exactRetainedCompletion.attempt_id,
    provider_call_required: false,
    retained_evidence_plan: retainedPlan,
  };
  if (retainedClassification?.classification
    === PROVIDER_EVIDENCE_PROVENANCE.CURRENT_RUN_RECOVER_FRAGMENTS) return {
    eligible: true, mode: 'provider_resume',
    reason_code: 'exact_unresolved_fragment_recovery_available',
    next_eligible_action: retainedPlan.exact_next_action,
    obligation_id: pending.obligation_id,
    physical_attempt_id: exactRetainedCompletion.attempt_id,
    provider_call_required: true,
    retained_evidence_plan: retainedPlan,
  };
  if (retainedClassification?.classification
    === PROVIDER_EVIDENCE_PROVENANCE.MISSING_PRIVATE_EVIDENCE) return {
    eligible: false, mode: 'blocked',
    reason_code: 'required_private_evidence_unavailable',
    next_eligible_action: retainedClassification.next_action,
    obligation_id: pending.obligation_id,
    physical_attempt_id: exactRetainedCompletion.attempt_id,
    provider_call_required: false,
    retained_evidence_plan: retainedPlan,
  };
  if (retainedClassification?.classification
    === PROVIDER_EVIDENCE_PROVENANCE.INCOMPLETE_RECONCILIATION
    && ['completed', 'completed_no_candidates', 'completed_repartitioned']
      .includes(exactRetainedCompletion?.terminal_outcome)) return {
    eligible: false, mode: 'blocked',
    reason_code: retainedPlan.exact_blockers?.[0]
      ?? 'retained_evidence_reconciliation_incomplete',
    next_eligible_action: retainedPlan.exact_next_action,
    obligation_id: pending.obligation_id,
    physical_attempt_id: exactRetainedCompletion?.attempt_id ?? null,
    provider_call_required: false,
    retained_evidence_plan: retainedPlan,
  };
  if (LOCAL_RECONCILIATION_ACTIONS.has(action)) return {
    eligible: true, mode: 'local_reconciliation_only',
    reason_code: 'exact_terminal_evidence_requires_local_reconciliation',
    next_eligible_action: action, obligation_id: pending.obligation_id,
    provider_call_required: false,
  };
  if (projection.invariants?.valid !== true) return {
    eligible: false, mode: 'blocked', reason_code: 'lifecycle_invariants_invalid_for_provider_resume',
    next_eligible_action: action, obligation_id: pending.obligation_id,
    provider_call_required: false,
    invariant_violations: projection.invariants?.violations ?? [],
  };
  return {
    eligible: getMemorizeActionContract(action)?.provider_call_required === true,
    mode: getMemorizeActionContract(action)?.provider_call_required === true
      ? 'provider_resume' : 'blocked',
    reason_code: getMemorizeActionContract(action)?.provider_call_required === true
      ? 'exact_resume_action_available' : 'unknown_or_non_provider_action_contract',
    next_eligible_action: action, obligation_id: pending.obligation_id,
    provider_call_required: getMemorizeActionContract(action)?.provider_call_required === true,
  };
}

export function getContiguousSafeSourceOffset(ledgerValue, startingOffset = 0) {
  return deriveMemorizeSafeResumeOffset(ledgerValue, startingOffset);
}

export function getNextSourceTraversalRange(ledgerValue, {
  source_message_count = 0,
  chunk_size = 20,
  starting_offset = 0,
} = {}) {
  const projection = projectMemorizeObligationLedger(ledgerValue);
  const actionable = projection.next_eligible_obligation;
  if (actionable) return {
    action: actionable.next_eligible_action,
    kind: 'recovery_obligation',
    obligation_id: actionable.obligation_id,
    source_range: rangeOf(actionable.source_range),
  };
  if (projection.pending_obligation_count > 0) return {
    action: null,
    kind: 'blocked_unactionable_obligation',
    obligation_id: projection.pending_obligations[0]?.obligation_id ?? null,
    source_range: rangeOf(projection.pending_obligations[0]?.source_range),
  };
  const total = Math.max(0, Number(source_message_count) || 0);
  const start = Math.min(total, getContiguousSafeSourceOffset(ledgerValue, starting_offset));
  if (start < total) return {
    action: 'continue_source_traversal',
    kind: 'source_traversal',
    obligation_id: null,
    source_range: rangeOf({ start, end: Math.min(total - 1, start + Math.max(1, Number(chunk_size) || 20) - 1) }),
  };
  return {
    action: 'continue_finalization', kind: 'finalization', obligation_id: null, source_range: null,
  };
}

function enabledTiers(manifest, ledger, options = {}) {
  if (Array.isArray(options.enabled_tiers)) {
    return TIERS.filter((tier) => options.enabled_tiers.includes(tier));
  }
  return TIERS.filter((tier) => {
    const roots = rootObligations(ledger, tier);
    return roots.length > 0 || manifest?.tier_coverage?.[tier]?.enabled === true;
  });
}

function projectionFields(manifest = {}) {
  return {
    attempts: manifest.attempts ?? [],
    committed_ranges: manifest.committed_ranges ?? [],
    committed_chunks: manifest.committed_chunks ?? [],
    cumulative_chunk_count: manifest.cumulative_chunk_count ?? null,
    cumulative_chunk_count_available: manifest.cumulative_chunk_count_available ?? null,
    cumulative_chunk_count_reason: manifest.cumulative_chunk_count_reason ?? null,
    tier_coverage: manifest.tier_coverage ?? {},
    tier_obligations: manifest.tier_obligations ?? [],
    owner_obligations: manifest.owner_obligations ?? [],
    authoritative_resume_selection: manifest.authoritative_resume_selection ?? null,
  };
}

/**
 * Rebuilds every mutable compatibility coverage field from the canonical ledger.
 * This function has no provider or persistence dependency and is idempotent.
 */
export function rebuildMemorizeCompatibilityProjection(manifestValue = {}, options = {}) {
  const manifest = clone(manifestValue ?? {});
  const ledger = ensureMemorizeObligationLedger(
    manifest.obligation_ledger, manifest.logical_run_id);
  manifest.obligation_ledger = ledger;
  const tiers = enabledTiers(manifest, ledger, options);
  // Processing offsets are derived from canonical root ranges in source order.
  // A source range may span skipped chat indices, so its durable message_count
  // (not sourceEnd-sourceStart+1) determines the next processing offset.
  const sourceGroups = new Map();
  for (const obligation of rootObligations(ledger)) {
    const sourceStart = Number(obligation.source_range?.start);
    const sourceEnd = Number(obligation.source_range?.end);
    if (!Number.isInteger(sourceStart) || !Number.isInteger(sourceEnd) || sourceEnd < sourceStart) continue;
    const key = `${sourceStart}-${sourceEnd}`;
    const messageCount = Math.max(1, Number(obligation.source_range?.message_count) || sourceEnd - sourceStart + 1);
    const prior = sourceGroups.get(key);
    sourceGroups.set(key, { source_start_index: sourceStart, source_end_index: sourceEnd,
      message_count: Math.max(messageCount, Number(prior?.message_count ?? 0)) });
  }
  let canonicalOffset = Math.max(0, Number(options.coordinate_start_offset ?? 0) || 0);
  const canonicalCoordinateRanges = [...sourceGroups.values()]
    .sort((left, right) => left.source_start_index - right.source_start_index
      || left.source_end_index - right.source_end_index)
    .map((item) => {
      const mapped = { ...item, start_offset: canonicalOffset,
        end_offset: canonicalOffset + item.message_count - 1 };
      canonicalOffset = mapped.end_offset + 1;
      return mapped;
    });
  // Explicit coordinate ranges are accepted only as a migration fallback for
  // a root whose canonical message-count identity is unavailable. Persisted
  // compatibility projections are deliberately not read here.
  const migrationCoordinateRanges = (options.coordinate_ranges ?? []).map((item) => ({
    start_offset: Number(item.start_offset ?? item.start),
    end_offset: Number(item.end_offset ?? item.end),
    source_start_index: Number(item.source_start_index ?? item.start),
    source_end_index: Number(item.source_end_index ?? item.end),
  })).filter((item) => Object.values(item).every(Number.isInteger));
  const projectCoordinates = (sourceRange) => {
    if (!sourceRange) return null;
    const matched = canonicalCoordinateRanges.find((item) =>
      item.source_start_index === sourceRange.source_start_index
      && item.source_end_index === sourceRange.source_end_index)
      ?? migrationCoordinateRanges.find((item) =>
        item.source_start_index === sourceRange.source_start_index
        && item.source_end_index === sourceRange.source_end_index);
    return matched ? rangeOf(matched) : sourceRange;
  };
  const tierGroups = Object.fromEntries(TIERS.map((tier) => [tier,
    groupTierRoots(ledger, tier).map((group) => ({
      ...group, range: projectCoordinates(group.range),
    }))]));
  const tierRanges = Object.fromEntries(TIERS.map((tier) => [tier,
    tierGroups[tier].filter((group) => group.obligations.every((item) => item.checkpoint_eligible))
      .map((group) => group.range)]));
  let generalRanges = tiers.length ? tierRanges[tiers[0]] : [];
  for (const tier of tiers.slice(1)) generalRanges = intersection(generalRanges, tierRanges[tier]);
  generalRanges = mergeRanges(generalRanges);

  manifest.tier_coverage = Object.fromEntries(TIERS.map((tier) => [tier, {
    enabled: tiers.includes(tier),
    committed_ranges: mergeRanges(tierRanges[tier]),
    projection_source: 'authoritative_obligation_ledger',
  }]));
  manifest.tier_obligations = TIERS.flatMap((tier) => tierGroups[tier].map((group) => {
    const pending = group.obligations.filter((item) => !item.checkpoint_eligible);
    const actionable = pending.find((item) => item.next_eligible_action) ?? pending[0] ?? null;
    return {
      key: group.key, tier, ...group.range,
      enabled: tiers.includes(tier), applicable: true,
      safely_committed: pending.length === 0,
      terminal_outcome: pending.length === 0 ? 'safely_committed' : 'pending',
      reason_code: actionable?.exact_reason_code ?? null,
      next_eligible_action: actionable?.next_eligible_action ?? null,
      root_obligation_ids: group.obligations.map((item) => item.obligation_id).sort(),
      projection_source: 'authoritative_obligation_ledger',
    };
  })).slice(-1024);
  manifest.owner_obligations = rootObligations(ledger, 'longterm')
    .filter((item) => item.owner).map((item) => ({
      key: `longterm:${String(item.owner).toLowerCase()}:${item.source_range.start}-${item.source_range.end}`,
      tier: 'longterm', owner: item.owner, ...projectCoordinates(rangeOf(item.source_range)),
      source_fingerprint: item.source_fingerprint ?? null,
      safely_committed: item.checkpoint_eligible === true,
      terminal_outcome: item.checkpoint_eligible ? 'safely_committed' : 'pending',
      reason_code: item.exact_reason_code ?? null,
      updated_at: item.timestamps?.updated_at ?? null,
      projection_source: 'authoritative_obligation_ledger',
    })).slice(-4096);
  manifest.committed_ranges = generalRanges;

  const chunkCandidates = [...new Map(TIERS.flatMap((tier) => tierGroups[tier])
    .map((group) => [`${group.range.start_offset}-${group.range.end_offset}`, group.range])).values()];
  manifest.committed_chunks = chunkCandidates.filter((range) => tiers.every((tier) =>
    mergeRanges(tierRanges[tier]).some((covered) => covered.start_offset <= range.start_offset
      && covered.end_offset >= range.end_offset)))
    .sort((left, right) => left.start_offset - right.start_offset).slice(-512);
  manifest.cumulative_chunk_count = manifest.committed_chunks.length;
  manifest.cumulative_chunk_count_available = true;
  manifest.cumulative_chunk_count_reason = null;
  const currentAttempt = manifest.attempts?.at(-1);
  if (currentAttempt?.status === 'in_progress') {
    const resumeOffset = Math.max(0, Number(currentAttempt.resume_checkpoint_offset ?? 0));
    const currentRanges = generalRanges.filter((range) => range.end_offset >= resumeOffset)
      .map((range) => {
        const startOffset = Math.max(range.start_offset, resumeOffset);
        const coordinate = canonicalCoordinateRanges.find((item) => item.start_offset === startOffset)
          ?? migrationCoordinateRanges.find((item) => item.start_offset === startOffset);
        return { ...range, start_offset: startOffset,
          source_start_index: coordinate?.source_start_index
            ?? (startOffset === range.start_offset ? range.source_start_index : startOffset),
          message_count: range.end_offset - startOffset + 1 };
      });
    currentAttempt.current_attempt_ranges = mergeRanges(currentRanges);
    currentAttempt.current_attempt_range_count = currentAttempt.current_attempt_ranges.length;
    currentAttempt.current_attempt_chunks = manifest.committed_chunks
      .filter((range) => range.end_offset >= resumeOffset);
    currentAttempt.current_attempt_chunk_count = currentAttempt.current_attempt_chunks.length;
    currentAttempt.current_attempt_chunk_count_available = true;
    currentAttempt.current_attempt_chunk_count_reason = null;
  }

  const sourceCount = Number(options.source_message_count
    ?? manifest.source_window?.message_count ?? 0);
  const projectedSafeResumeOffset = generalRanges.length
    && generalRanges[0].start_offset === 0 ? generalRanges[0].end_offset + 1 : 0;
  const obligationProjection = projectMemorizeObligationLedger(ledger);
  const actionable = obligationProjection.next_eligible_obligation;
  const selection = actionable ? {
    action: actionable.next_eligible_action,
    kind: 'recovery_obligation',
    obligation_id: actionable.obligation_id,
    source_range: projectCoordinates(rangeOf(actionable.source_range)),
  } : obligationProjection.pending_obligation_count > 0 ? {
    action: null,
    kind: 'blocked_unactionable_obligation',
    obligation_id: obligationProjection.pending_obligations[0]?.obligation_id ?? null,
    source_range: projectCoordinates(rangeOf(
      obligationProjection.pending_obligations[0]?.source_range)),
  } : projectedSafeResumeOffset < sourceCount ? {
      action: 'continue_source_traversal',
      kind: 'source_traversal',
      obligation_id: null,
      source_range: rangeOf({
        start_offset: projectedSafeResumeOffset,
        end_offset: Math.min(sourceCount - 1, projectedSafeResumeOffset
          + Math.max(1, Number(options.chunk_size) || 20) - 1),
      }),
    } : {
      action: 'continue_finalization', kind: 'finalization', obligation_id: null, source_range: null,
    };
  manifest.authoritative_resume_selection = {
    schema_version: 1,
    ...selection,
    projection_source: 'authoritative_obligation_ledger',
  };
  const before = JSON.stringify(projectionFields(manifestValue));
  const after = JSON.stringify(projectionFields(manifest));
  return {
    manifest,
    mutations: before === after ? 0 : 1,
    provider_calls: 0,
    persistence_calls: 0,
    committed_message_count: generalRanges.reduce((sum, range) => sum + range.message_count, 0),
    safe_resume_offset: projectedSafeResumeOffset,
    selection,
    tier_ranges: clone(tierRanges),
  };
}

