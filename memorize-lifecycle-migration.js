import {
  ensureMemorizeObligationLedger,
  normalizeMemorizeLifecycleIdentity,
} from './memorize-obligation-ledger.js';
import { recordProviderCompletion } from './provider-completion-journal.js';

export const MEMORIZE_LIFECYCLE_MIGRATION_VERSION = 1;

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
