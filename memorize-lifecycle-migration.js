import {
  ensureMemorizeObligationLedger,
  normalizeMemorizeLifecycleIdentity,
  transitionMemorizeObligation,
} from './memorize-obligation-ledger.js';
import { recordProviderCompletion } from './provider-completion-journal.js';
import { settleOrphanedProviderAttempts } from './provider-attempt-audit.js';
import { deriveRecoveryStageEligibility } from './recovery-stage-eligibility.js';
import { deriveMemorizeRecoveryAuthority } from './memorize-recovery-authority.js';

export const MEMORIZE_LIFECYCLE_MIGRATION_VERSION = 1;
export const SAME_RUN_EVIDENCE_MIGRATION_VERSION = 1;
export const RETAINED_EVIDENCE_RACE_MIGRATION_VERSION = 1;
export const CONTROLLER_LEASE_RECOVERY_MIGRATION_VERSION = 1;

const success = new Set(['completed', 'completed_no_candidates', 'completed_repartitioned']);
const malformed = (attempt) => attempt?.terminal_outcome === 'provider_response_malformed'
  || Boolean(attempt?.malformed_reason);
const rangeKey = (range) => `${Number(range?.start)}-${Number(range?.end)}`;
const inside = (child, root) => Number(child?.start) >= Number(root?.start)
  && Number(child?.end) <= Number(root?.end);

function leafId(rootId, range, fingerprint) {
  return `${rootId}:leaf:${range.start}-${range.end}:${fingerprint ?? 'migrated'}`;
}

function uncoveredRanges(root, covered) {
  const sorted = covered.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const gaps = [];
  let cursor = root.start;
  for (const item of sorted) {
    if (item.end < cursor) continue;
    if (item.start > cursor) gaps.push({ start: cursor, end: item.start - 1,
      message_count: item.start - cursor });
    cursor = Math.max(cursor, item.end + 1);
  }
  if (cursor <= root.end) gaps.push({ start: cursor, end: root.end,
    message_count: root.end - cursor + 1 });
  return gaps;
}

/**
 * Normalizes the v0.9.74 shape where one parent represented record
 * persistence, child coverage, and provider execution simultaneously.
 * Evidence is restricted to the most recent root recovery epoch so older
 * superseded attempts cannot manufacture coverage.
 */
export function migrateAmbiguousRecoveryParents({ ledger: ledgerValue, metadata,
  provider_audit: providerAudit } = {}) {
  const ledger = ensureMemorizeObligationLedger(ledgerValue);
  ledger.migrations ??= {};
  if (ledger.migrations.ambiguous_recovery_parent_v1?.completed === true) {
    return { ledger, migrated: false,
      detail: ledger.migrations.ambiguous_recovery_parent_v1 };
  }
  const attempts = providerAudit?.recent_attempts ?? [];
  const migratedParents = [];
  for (const parent of Object.values(ledger.obligations)) {
    const root = parent.source_range;
    const recordIds = parent.lifecycle?.durably_persisted_record_ids ?? [];
    const ambiguous = parent.tier === 'session' && root && recordIds.length > 0
      && parent.checkpoint_eligible !== true
      && parent.coverage_result === 'safely_committed';
    if (!ambiguous) continue;
    const lineage = attempts.filter((attempt) => attempt.logical_obligation_id === parent.obligation_id
      && attempt.source_range && inside(attempt.source_range, root));
    const rootEpochStart = [...lineage].reverse().find((attempt) =>
      Number(attempt.source_range.start) === root.start
      && Number(attempt.source_range.end) === root.end
      && !success.has(attempt.terminal_outcome))?.sequence ?? -Infinity;
    const epoch = lineage.filter((attempt) => Number(attempt.sequence) > rootEpochStart);
    const committed = [...epoch].reverse().find((attempt) => success.has(attempt.terminal_outcome)
      && (attempt.persistence_result === 'committed' || attempt.checkpoint_eligible === true)
      && (attempt.source_range.start !== root.start || attempt.source_range.end !== root.end));
    const failed = [...epoch].reverse().find((attempt) => malformed(attempt)
      && (!committed || rangeKey(attempt.source_range) !== rangeKey(committed.source_range)));
    if (!committed || !failed) continue;

    const committedId = leafId(parent.obligation_id, committed.source_range,
      committed.source_fingerprint);
    const failedId = leafId(parent.obligation_id, failed.source_range,
      failed.source_fingerprint);
    const migratedLifecycle = normalizeMemorizeLifecycleIdentity({ lifecycle: {
      ...parent.lifecycle,
      migrated_from_ambiguous_counts: parent.lifecycle?.migrated_from_ambiguous_counts === true,
    } });
    ledger.obligations[committedId] = {
      ...parent, obligation_id: committedId, parent_obligation_id: parent.obligation_id,
      expected_child_obligation_ids: [], source_range: { ...committed.source_range },
      source_fingerprint: committed.source_fingerprint ?? parent.source_fingerprint,
      provider_attempt_lineage: [committed.attempt_id], current_state: 'durably_committed',
      checkpoint_eligible: true, exact_reason_code: null, next_eligible_action: null,
      recovery_intent: null, recovery_stage: null, coverage_result: 'safely_committed',
      persistence_result: 'committed', lifecycle: migratedLifecycle,
      metrics: { ...(parent.metrics ?? {}), producing_provider_attempt_id: committed.attempt_id,
        persisted_records: recordIds.length },
      timestamps: { ...(parent.timestamps ?? {}), migrated_at: Date.now() },
    };
    ledger.obligations[failedId] = {
      ...parent, obligation_id: failedId, parent_obligation_id: parent.obligation_id,
      expected_child_obligation_ids: [], source_range: { ...failed.source_range },
      source_fingerprint: failed.source_fingerprint ?? parent.source_fingerprint,
      provider_attempt_lineage: [failed.attempt_id], current_state: 'operationally_paused',
      checkpoint_eligible: false, exact_reason_code: 'malformed_recovery_exhausted',
      next_eligible_action: 'resume_changed_dimension_or_single_source_recovery',
      recovery_intent: 'recover_exact_uncovered_leaf', recovery_stage: 'bounded_recovery_exhausted',
      coverage_result: 'pending', persistence_result: 'not_applicable',
      lifecycle: normalizeMemorizeLifecycleIdentity({}),
      metrics: { producing_provider_attempt_id: failed.attempt_id, persisted_records: 0 },
      timestamps: { created_at: failed.at, updated_at: Date.now(), migrated_at: Date.now() },
    };
    const children = [committedId, failedId];
    for (const gap of uncoveredRanges(root, [committed.source_range, failed.source_range])) {
      const id = leafId(parent.obligation_id, gap, parent.source_fingerprint);
      ledger.obligations[id] = {
        obligation_id: id, logical_run_id: parent.logical_run_id, tier: parent.tier,
        owner: parent.owner, source_range: gap, source_fingerprint: parent.source_fingerprint,
        parent_obligation_id: parent.obligation_id, expected_child_obligation_ids: [],
        provider_attempt_lineage: [], parser_result: null, downstream_validation_result: null,
        persistence_result: 'not_started', coverage_result: 'unattempted',
        current_state: 'unattempted', checkpoint_eligible: false,
        exact_reason_code: 'not_yet_attempted_after_recovery_pause',
        next_eligible_action: 'dispatch_after_prior_leaf_coverage',
        recovery_intent: 'cover_unattempted_leaf', recovery_stage: null,
        timestamps: { created_at: Date.now(), updated_at: Date.now(), migrated_at: Date.now() },
        transition_history: [], implementation_version: parent.implementation_version,
        schema_version: parent.schema_version, metrics: {},
        lifecycle: normalizeMemorizeLifecycleIdentity({}),
      };
      children.push(id);
    }
    parent.expected_child_obligation_ids = children;
    parent.current_state = 'pending_recovery';
    parent.checkpoint_eligible = false;
    parent.exact_reason_code = 'recovery_child_coverage_incomplete';
    parent.next_eligible_action = 'resume_first_actionable_recovery_leaf';
    parent.recovery_intent = 'complete_recovery_child_coverage';
    parent.recovery_stage = 'child_coverage';
    parent.coverage_result = 'pending_child_coverage';
    parent.persistence_result = 'child_records_preserved';
    parent.lifecycle = normalizeMemorizeLifecycleIdentity({});
    parent.metrics = { ...(parent.metrics ?? {}), persisted_records: 0,
      preserved_child_record_count: recordIds.length };
    parent.timestamps = { ...(parent.timestamps ?? {}), migrated_at: Date.now(),
      updated_at: Date.now() };

    recordProviderCompletion(metadata, committed, {
      child_obligation_id: committedId,
      persistence: { status: 'verified_existing', durable_record_ids: recordIds },
      validation: { status: 'accepted', migrated: true },
      manifest_transition: { status: 'applied', disposition: 'leaf_covered' },
      ledger_transition: { status: 'applied', disposition: 'durably_committed' },
      live_health_transition: { status: 'applied', disposition: 'completed' },
      completed_at: committed.at + Number(committed.duration_ms ?? 0),
      migration: { source: 'v0.9.74_ambiguous_parent', evidence: 'durable_record_ids' },
    });
    recordProviderCompletion(metadata, failed, {
      child_obligation_id: failedId,
      persistence: { status: 'not_applicable', durable_record_ids: [],
        reason_code: 'malformed_recovery_exhausted' },
      validation: { status: 'not_applicable' },
      manifest_transition: { status: 'rejected', reason_code: 'malformed_recovery_exhausted' },
      ledger_transition: { status: 'applied', disposition: 'operationally_paused' },
      live_health_transition: { status: 'applied', disposition: 'operationally_paused' },
      completed_at: failed.at + Number(failed.duration_ms ?? 0),
      migration: { source: 'v0.9.74_ambiguous_parent', evidence: 'terminal_attempt' },
    });
    migratedParents.push({ parent_obligation_id: parent.obligation_id,
      committed_leaf_id: committedId, failed_leaf_id: failedId,
      unattempted_leaf_ids: children.slice(2), preserved_record_ids: [...recordIds],
      first_actionable_leaf_id: failedId });
  }
  const detail = ledger.migrations.ambiguous_recovery_parent_v1 = {
    version: MEMORIZE_LIFECYCLE_MIGRATION_VERSION, completed: true,
    migrated_parent_count: migratedParents.length, migrated_parents: migratedParents,
    completed_at: Date.now(), provider_requests: 0,
  };
  ledger.updated_at = detail.completed_at;
  return { ledger, migrated: migratedParents.length > 0, detail };
}

function completionEntries(journal) {
  if (Array.isArray(journal?.entries)) return journal.entries;
  if (journal?.entries && journal?.order) {
    return journal.order.map((id) => journal.entries[id]).filter(Boolean);
  }
  return Object.values(journal?.entries ?? {});
}

/**
 * Repairs the v0.9.80 projection that adopted a physically completed attempt
 * from the active logical run as prior-run evidence. Durable accepted records
 * remain untouched; only the downstream cursor/action and stale observations
 * are normalized. No provider or memory-persistence callback is accepted.
 */
export function migrateV0980SameRunEvidenceState({ ledger: ledgerValue,
  journal, logical_run_id: logicalRunId, provider_attempts: providerAttempts } = {}) {
  const ledger = ensureMemorizeObligationLedger(ledgerValue, logicalRunId);
  ledger.migrations ??= {};
  const key = 'same_run_evidence_provenance_v0981';
  if (ledger.migrations[key]?.completed === true) {
    return { ledger, migrated: false, detail: ledger.migrations[key],
      provider_calls: 0, persistence_calls: 0 };
  }
  const before = JSON.stringify(ledger);
  const repaired = [];
  const entries = completionEntries(journal);
  const attempts = providerAttempts?.recent_attempts
    ?? providerAttempts?.retained_attempts
    ?? (Array.isArray(providerAttempts) ? providerAttempts : []);
  const attemptById = new Map(attempts.filter((item) => item?.attempt_id)
    .map((item) => [item.attempt_id, item]));
  for (const entry of entries) {
    const sameRunAdoption = entry?.logical_run_id === logicalRunId
      && entry.adopted_from_logical_run_id === logicalRunId
      && entry.adopted_from_attempt_id === entry.attempt_id;
    if (!sameRunAdoption) continue;
    const obligationId = entry.child_obligation_id ?? entry.root_obligation_id;
    const obligation = ledger.obligations[obligationId];
    if (!obligation) continue;
    const durableIds = [...new Set(entry.persistence?.durable_record_ids
      ?? obligation.lifecycle?.durably_persisted_record_ids ?? [])];
    const unresolvedIds = [...new Set(obligation.lifecycle?.unresolved_fragment_ids ?? [])];
    if (!durableIds.length || !unresolvedIds.length) continue;
    const candidateMap = Object.fromEntries((entry.validated_record_identities ?? [])
      .filter((item) => item?.id && item?.candidate_id && durableIds.includes(String(item.id)))
      .map((item) => [String(item.id), String(item.candidate_id)]));
    const physicalAttempt = attemptById.get(entry.attempt_id);
    transitionMemorizeObligation(ledger, obligation, {
      current_state: 'pending_recovery',
      provider_attempt_id: entry.attempt_id,
      parser_result: entry.parser_result?.status ?? obligation.parser_result ?? 'partial',
      downstream_validation_result: entry.validation?.status === 'accepted'
        ? 'accepted_partial_records' : obligation.downstream_validation_result,
      persistence_result: 'partial_records_committed', coverage_result: 'pending',
      exact_reason_code: 'partial_records_committed_unresolved_fragments_pending',
      next_eligible_action: 'recover_exact_unresolved_fragments',
      recovery_intent: 'recover_unresolved_partial_output_fragments',
      recovery_stage: 'persisted_partial_fragment_recovery',
      lifecycle: {
        durably_persisted_record_ids: durableIds,
        durable_record_candidate_map: candidateMap,
        parser_accepted_candidate_ids: Object.values(candidateMap),
        downstream_accepted_candidate_ids: Object.values(candidateMap),
        unresolved_fragment_ids: unresolvedIds,
      },
      metrics: { persisted_records: durableIds.length,
        producing_provider_attempt_id: entry.attempt_id,
        physical_terminal_outcome: entry.terminal_outcome,
        physical_completed_at: physicalAttempt?.completed_at ?? entry.updated_at },
    });
    entry.physical_terminal_outcome = entry.terminal_outcome;
    entry.physical_completed_at ??= physicalAttempt?.completed_at
      ?? (physicalAttempt?.at && physicalAttempt?.duration_ms
        ? Number(physicalAttempt.at) + Number(physicalAttempt.duration_ms) : entry.updated_at);
    entry.completed_at ??= entry.physical_completed_at;
    entry.logical_disposition = 'unresolved_fragments_pending';
    entry.downstream_cursor = 'unresolved_fragments_pending';
    entry.logical_completed_at = null;
    entry.migration = { ...(entry.migration ?? {}),
      same_run_adoption_superseded: true,
      original_adopted_from_logical_run_id: entry.adopted_from_logical_run_id,
      migrated_at: Date.now() };
    entry.adopted_from_logical_run_id = null;
    entry.adopted_from_attempt_id = null;
    entry.evidence_adoption_reason = null;
    ledger.historical_transition_observations = [
      ...(ledger.historical_transition_observations ?? []), {
        code: 'same_run_prior_evidence_adoption_superseded',
        obligation_id: obligationId, provider_attempt_id: entry.attempt_id,
        classification: 'repaired_by_current_run_downstream_cursor',
      },
    ].slice(-256);
    repaired.push({ obligation_id: obligationId, attempt_id: entry.attempt_id,
      durable_record_ids: durableIds, unresolved_fragment_ids: unresolvedIds });
  }
  const retired = [];
  ledger.transition_violations = (ledger.transition_violations ?? []).filter((violation) => {
    const obligation = ledger.obligations[violation.obligation_id];
    const retireTerminalEvidence = violation.code === 'terminal_attempt_reconciliation_missing_evidence'
      && obligation?.checkpoint_eligible === true;
    const retireMalformed = violation.code === 'terminal_malformed_settlement_cannot_regress_terminal_state'
      && obligation?.checkpoint_eligible === true;
    if (!retireTerminalEvidence && !retireMalformed) return true;
    retired.push({ ...violation, original_classification: violation.classification,
      classification: retireMalformed ? 'superseded_by_later_attempt'
        : 'repaired_by_later_verified_downstream_evidence', migrated_at: Date.now() });
    return false;
  });
  if (retired.length) ledger.historical_transition_observations = [
    ...(ledger.historical_transition_observations ?? []), ...retired,
  ].slice(-256);
  const detail = {
    version: SAME_RUN_EVIDENCE_MIGRATION_VERSION, completed: true,
    repaired_leaf_count: repaired.length, repaired_leaves: repaired,
    retired_violation_count: retired.length,
    provider_calls: 0, persistence_calls: 0, completed_at: Date.now(),
  };
  ledger.migrations[key] = detail;
  ledger.updated_at = detail.completed_at;
  return { ledger, migrated: before !== JSON.stringify(ledger), detail,
    provider_calls: 0, persistence_calls: 0 };
}

/**
 * Repairs v0.9.81 checkpoints where prior-run evidence was selected for one
 * child, reconciliation made that child terminal, and a sibling was declared
 * without its initial action contract. This is local metadata normalization:
 * durable memories, provider requests, and persistence callbacks are untouched.
 */
export function migrateV0981RetainedEvidenceRaceState({ ledger: ledgerValue,
  journal, logical_run_id: logicalRunId } = {}) {
  const ledger = ensureMemorizeObligationLedger(ledgerValue, logicalRunId);
  ledger.migrations ??= {};
  const key = 'retained_evidence_race_v0982';
  if (ledger.migrations[key]?.completed === true) return {
    ledger, migrated: false, detail: ledger.migrations[key],
    provider_calls: 0, persistence_calls: 0,
  };
  const before = JSON.stringify({ ledger, journal });
  const repairedChildren = [];
  const synchronizedEntries = [];
  const retiredViolations = [];
  for (const obligation of Object.values(ledger.obligations ?? {})) {
    if (obligation.parent_obligation_id && obligation.current_state === 'unattempted'
      && (!obligation.exact_reason_code || !obligation.next_eligible_action
        || !obligation.recovery_stage)) {
      obligation.exact_reason_code = 'recovery_child_not_attempted';
      obligation.next_eligible_action = 'dispatch_provider_request';
      obligation.recovery_intent = 'complete_recovery_child_coverage';
      obligation.recovery_stage = 'initial_child_dispatch';
      obligation.revision = Number(obligation.revision ?? 0) + 1;
      obligation.timestamps ??= {};
      obligation.timestamps.updated_at = Date.now();
      repairedChildren.push({
        obligation_id: obligation.obligation_id,
        exact_reason_code: obligation.exact_reason_code,
        next_eligible_action: obligation.next_eligible_action,
        recovery_stage: obligation.recovery_stage,
      });
    }
    if (!obligation.checkpoint_eligible) continue;
    for (const entry of completionEntries(journal)) {
      const leafId = entry.child_obligation_id ?? entry.root_obligation_id;
      if (leafId !== obligation.obligation_id) continue;
      const disposition = obligation.current_state === 'explicit_no_update'
        ? 'explicit_no_update' : 'durably_committed';
      entry.logical_disposition = disposition;
      entry.downstream_cursor = 'fully_terminal';
      entry.completed_at ??= entry.physical_completed_at ?? entry.updated_at ?? Date.now();
      entry.logical_completed_at ??= obligation.timestamps?.updated_at
        ?? entry.completed_at ?? entry.updated_at ?? Date.now();
      entry.validation = ['accepted', 'not_needed'].includes(entry.validation?.status)
        ? entry.validation : { ...(entry.validation ?? {}), status: 'accepted',
          reconciliation_source: 'canonical_terminal_obligation' };
      entry.persistence = ['committed', 'verified_existing', 'not_needed']
        .includes(entry.persistence?.status) ? entry.persistence : {
          ...(entry.persistence ?? {}),
          status: disposition === 'explicit_no_update' ? 'not_needed' : 'verified_existing',
          durable_record_ids: [...(obligation.lifecycle?.durably_persisted_record_ids ?? [])],
          reconciliation_source: 'canonical_terminal_obligation',
        };
      entry.ledger_transition = {
        ...(entry.ledger_transition ?? {}), status: 'applied_verified',
        target_obligation_id: obligation.obligation_id,
        requested_disposition: disposition,
        resulting_state: obligation.current_state,
        checkpoint_eligible: true,
      };
      entry.manifest_transition = {
        ...(entry.manifest_transition ?? {}), status: 'applied_verified',
        target_obligation_id: obligation.obligation_id,
        requested_disposition: disposition === 'explicit_no_update'
          ? 'explicit_no_update' : 'leaf_covered',
        resulting_state: obligation.current_state,
        checkpoint_eligible: true,
      };
      synchronizedEntries.push({ attempt_id: entry.attempt_id,
        obligation_id: obligation.obligation_id, disposition });
    }
  }
  ledger.transition_violations = (ledger.transition_violations ?? []).filter((violation) => {
    const terminal = ledger.obligations?.[violation.obligation_id]?.checkpoint_eligible === true;
    const staleAdoption = violation.code
      === 'terminal_provider_evidence_adoption_cannot_regress_terminal_state' && terminal;
    if (!staleAdoption) return true;
    retiredViolations.push({ ...violation,
      classification: 'superseded_by_terminal_coverage', migrated_at: Date.now() });
    return false;
  });
  if (retiredViolations.length) ledger.historical_transition_observations = [
    ...(ledger.historical_transition_observations ?? []), ...retiredViolations,
  ].slice(-256);
  ledger.historical_transition_observations = (ledger.historical_transition_observations ?? [])
    .map((observation) => {
      const terminal = ledger.obligations?.[observation.obligation_id]
        ?.checkpoint_eligible === true;
      if (observation.code !== 'terminal_provider_evidence_adoption_cannot_regress_terminal_state'
        || !terminal) return observation;
      return { ...observation, classification: 'superseded_by_terminal_coverage',
        migrated_at: observation.migrated_at ?? Date.now() };
    }).slice(-256);
  const nextLeaf = Object.values(ledger.obligations ?? {}).find((item) =>
    item.parent_obligation_id && !item.checkpoint_eligible
    && item.exact_reason_code && item.next_eligible_action);
  if (nextLeaf) {
    const latestExit = ledger.controller_exits?.at(-1);
    if (latestExit && /adoption|lifecycle_transition|provider_evidence/i.test(
      `${latestExit.reason_code ?? ''} ${latestExit.normalized_exception_class ?? ''}`)) {
      latestExit.reason_code = 'recovery_child_not_attempted';
      latestExit.classification = 'retained_evidence_race_repaired';
      latestExit.resumable = true;
      latestExit.obligation_id = nextLeaf.obligation_id;
      latestExit.next_eligible_action = nextLeaf.next_eligible_action;
    }
  }
  const detail = ledger.migrations[key] = {
    version: RETAINED_EVIDENCE_RACE_MIGRATION_VERSION,
    completed: true,
    repaired_child_count: repairedChildren.length,
    repaired_children: repairedChildren,
    synchronized_journal_entry_count: synchronizedEntries.length,
    synchronized_journal_entries: synchronizedEntries,
    retired_violation_count: retiredViolations.length,
    provider_calls: 0, persistence_calls: 0, completed_at: Date.now(),
  };
  ledger.updated_at = detail.completed_at;
  return { ledger, migrated: before !== JSON.stringify({ ledger, journal }), detail,
    provider_calls: 0, persistence_calls: 0 };
}

/** Repairs the v0.9.82 closed-controller/orphaned-attempt checkpoint shape. */
export function migrateV0982ControllerLeaseRecoveryState({ checkpoint, metadata,
  at = Date.now() } = {}) {
  const ledger = checkpoint?.run_manifest?.obligation_ledger;
  const logicalRunId = checkpoint?.run_manifest?.logical_run_id;
  if (!checkpoint || !ledger || !logicalRunId || !metadata) return {
    migrated: false, detail: null, provider_calls: 0, persistence_calls: 0,
  };
  ledger.migrations ??= {};
  const key = 'controller_lease_recovery_v0983';
  if (ledger.migrations[key]?.completed === true) return {
    migrated: false, detail: ledger.migrations[key], provider_calls: 0, persistence_calls: 0,
  };
  const heartbeat = checkpoint.controller_heartbeat ?? null;
  const transaction = checkpoint.transaction_lifecycle ?? null;
  const providerAudit = metadata.live_memory_health?.provider_attempt_audit;
  const pending = Object.values(ledger.obligations ?? {}).find((item) =>
    item.logical_run_id === logicalRunId && !item.checkpoint_eligible
    && ['provider_running', 'pending_recovery', 'operationally_paused'].includes(item.current_state));
  const running = (providerAudit?.recent_attempts ?? []).filter((attempt) =>
    attempt?.logical_run_id === logicalRunId && attempt?.terminal_outcome === 'running'
    && (!pending || pending.provider_attempt_lineage?.includes(attempt.attempt_id)));
  const closedController = heartbeat?.terminal === true
    || checkpoint.controller_failure != null
    || ['rolled_back', 'committed', 'commit_failed_with_exact_state',
      'rollback_failed_with_exact_state'].includes(transaction?.state);
  const contradictoryCheckpoint = checkpoint.status === 'in_progress' && closedController;
  if (!pending || (!running.length && !contradictoryCheckpoint)) return {
    migrated: false, detail: null, provider_calls: 0, persistence_calls: 0,
  };
  const preservedTerminalIds = Object.values(ledger.obligations ?? {})
    .filter((item) => item.checkpoint_eligible).map((item) => item.obligation_id);
  const settlement = settleOrphanedProviderAttempts(metadata, {
    logical_run_id: logicalRunId,
    obligation_id: pending.obligation_id,
    provider_attempt_lineage: pending.provider_attempt_lineage,
    controller_instance_id: heartbeat?.controller_invocation_id ?? null,
    transaction_id: transaction?.transaction_id ?? null,
    transaction_revision: transaction?.revision ?? null,
    reason_code: 'controller_closed_before_provider_completion',
  });
  const auditObligation = providerAudit?.obligations?.[pending.parent_obligation_id
    ?? pending.obligation_id];
  const recoveryWindow = auditObligation?.recovery_windows?.[pending.source_fingerprint];
  const eligibility = recoveryWindow ? deriveRecoveryStageEligibility(recoveryWindow) : null;
  const exactAction = eligibility?.blocked === false
    ? eligibility.eligible_action : pending.next_eligible_action;
  if (pending.current_state === 'provider_running') pending.current_state = 'pending_recovery';
  pending.exact_reason_code = pending.exact_reason_code ?? 'interrupted_completion_unknown';
  pending.next_eligible_action = exactAction;
  pending.recovery_intent = 'recover_malformed_provider_output';
  pending.recovery_stage = exactAction;
  pending.physical_terminal_outcome = 'interrupted_completion_unknown';
  pending.revision = Number(pending.revision ?? 0) + 1;
  pending.timestamps ??= {};
  pending.timestamps.updated_at = at;
  checkpoint.status = exactAction ? 'awaiting_manual_resume' : 'blocked_reconciliation_required';
  checkpoint.updated_at = at;
  const latestExit = ledger.controller_exits?.at(-1) ?? null;
  if (!checkpoint.controller_failure && latestExit) checkpoint.controller_failure = {
    schema_version: 1,
    code: latestExit.reason_code ?? 'controller_closed_before_provider_completion',
    normalized_exception_class: latestExit.normalized_exception_class ?? null,
    bounded_message: latestExit.bounded_message ?? null,
    stack_fingerprint: latestExit.stack_fingerprint ?? null,
    recorded_at: latestExit.closed_at ?? latestExit.at ?? at,
    recovered_by_migration: true,
  };
  const authority = deriveMemorizeRecoveryAuthority({
    checkpoint,
    ledger, provider_audit: providerAudit,
    provider_completion_journal: metadata.provider_completion_journal,
    controller_heartbeat: heartbeat,
    transaction_lifecycle: transaction,
    checkpoint_status: checkpoint.status,
  });
  checkpoint.authoritative_recovery = authority;
  checkpoint.resume_eligibility = {
    schema_version: 2,
    eligible: authority.resume_eligible,
    mode: authority.resume_eligible ? 'provider_resume' : 'blocked',
    reason_code: authority.resume_eligible
      ? 'exact_malformed_recovery_stage_available'
      : authority.resume_blockers[0]?.reason_code ?? 'no_executable_recovery_action',
    next_eligible_action: authority.next_executable_action,
    obligation_id: pending.obligation_id,
    provider_call_required: authority.provider_call_permitted,
    evaluated_at: at,
  };
  const detail = ledger.migrations[key] = {
    version: CONTROLLER_LEASE_RECOVERY_MIGRATION_VERSION,
    completed: true,
    logical_run_id: logicalRunId,
    repaired_obligation_id: pending.obligation_id,
    settled_orphan_attempt_ids: settlement.settled_attempt_ids,
    exact_recovery_stage: exactAction,
    preserved_terminal_obligation_ids: preservedTerminalIds,
    preserved_terminal_obligation_count: preservedTerminalIds.length,
    checkpoint_status: checkpoint.status,
    provider_calls: 0,
    persistence_calls: 0,
    completed_at: at,
  };
  return { migrated: true, detail, provider_calls: 0, persistence_calls: 0 };
}
