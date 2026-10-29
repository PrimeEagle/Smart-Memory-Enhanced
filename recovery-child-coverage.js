/** Authoritative, content-free coverage for repartitioned recovery roots. */

export const RECOVERY_CHILD_MANIFEST_SCHEMA_VERSION = 1;

const COMPLETE_STATES = new Set(['completed', 'validated_no_update']);

const normalizeRange = (range = {}) => ({
  start: Number(range.start ?? range.source_start_index),
  end: Number(range.end ?? range.source_end_index),
  message_count: Number(range.message_count ?? (Number(range.end ?? range.source_end_index)
    - Number(range.start ?? range.source_start_index) + 1)),
});

const validRange = (range) => Number.isInteger(range?.start)
  && Number.isInteger(range?.end) && range.end >= range.start;

function recompute(manifest) {
  const nodes = Object.values(manifest.children ?? {});
  const leaves = nodes.filter((node) => !(node.child_keys ?? []).length);
  const completed = leaves.filter((node) => COMPLETE_STATES.has(node.state));
  const blocked = leaves.filter((node) => node.state === 'blocked');
  const unattempted = leaves.filter((node) => node.state === 'unattempted');
  const pending = leaves.filter((node) => !COMPLETE_STATES.has(node.state)
    && node.state !== 'blocked' && node.state !== 'unattempted');
  const ranges = leaves.map((node) => normalizeRange(node.source_range))
    .filter(validRange).sort((a, b) => a.start - b.start || a.end - b.end);
  const root = normalizeRange(manifest.root_source_range);
  let cursor = root.start;
  let exact = validRange(root) && ranges.length > 0;
  for (const range of ranges) {
    if (range.start !== cursor) { exact = false; break; }
    cursor = range.end + 1;
  }
  if (cursor !== root.end + 1) exact = false;
  manifest.coverage = {
    expected_leaf_count: leaves.length,
    completed_leaf_count: completed.length,
    pending_leaf_count: pending.length,
    blocked_leaf_count: blocked.length,
    unattempted_leaf_count: unattempted.length,
    completed_child_keys: completed.map((node) => node.key),
    pending_child_keys: pending.map((node) => node.key),
    blocked_child_keys: blocked.map((node) => node.key),
    unattempted_child_keys: unattempted.map((node) => node.key),
    every_required_index_covered_exactly_once: exact,
    complete: exact && leaves.length > 0 && completed.length === leaves.length,
  };
  manifest.parent_closure_state = manifest.coverage.complete ? 'complete'
    : blocked.length ? 'blocked'
      : manifest.operational_pause?.active ? 'paused_resumable' : 'incomplete';
  manifest.updated_at = Date.now();
  return manifest;
}

export function createRecoveryChildManifest(input = {}, prior = null) {
  const manifest = prior ? structuredClone(prior) : {
    schema_version: RECOVERY_CHILD_MANIFEST_SCHEMA_VERSION,
    root_obligation_id: input.root_obligation_id ?? null,
    tier: input.tier ?? null,
    owner: input.owner ?? null,
    root_source_range: normalizeRange(input.root_source_range),
    root_source_fingerprint: input.root_source_fingerprint ?? null,
    children: {},
    budget_epochs: [],
    operational_pause: null,
    parent_closure_state: 'incomplete',
    created_at: Date.now(),
  };
  manifest.schema_version = RECOVERY_CHILD_MANIFEST_SCHEMA_VERSION;
  manifest.children ??= {};
  manifest.budget_epochs ??= [];
  return recompute(manifest);
}

export function registerRecoveryChildPlan(manifest, {
  parent_child_key = null, children = [], completed_child_keys = [], budget = null,
} = {}) {
  const completed = new Set(completed_child_keys ?? []);
  if (parent_child_key && manifest.children[parent_child_key]) {
    manifest.children[parent_child_key].state = 'repartitioned';
    manifest.children[parent_child_key].child_keys = children.map((child) => child.key);
  }
  for (const child of children) {
    const prior = manifest.children[child.key] ?? {};
    manifest.children[child.key] = {
      ...prior,
      key: child.key,
      parent_child_key,
      source_range: normalizeRange(child.source_range ?? child),
      source_fingerprint: child.source_fingerprint ?? prior.source_fingerprint ?? null,
      child_keys: prior.child_keys ?? [],
      state: completed.has(child.key) || COMPLETE_STATES.has(prior.state)
        ? prior.state === 'validated_no_update' ? 'validated_no_update' : 'completed'
        : prior.state ?? 'unattempted',
      staged_record_count: Number(prior.staged_record_count ?? 0),
      recovery_requests_consumed: Number(prior.recovery_requests_consumed ?? 0),
    };
  }
  if (budget) recordRecoveryBudgetSnapshot(manifest, budget);
  return recompute(manifest);
}

export function markRecoveryChildState(manifest, childKey, state, details = {}) {
  const child = manifest.children?.[childKey];
  if (!child) return recompute(manifest);
  child.state = state;
  child.staged_record_count = Math.max(Number(child.staged_record_count ?? 0),
    Number(details.staged_record_count ?? 0));
  child.recovery_requests_consumed = Math.max(Number(child.recovery_requests_consumed ?? 0),
    Number(details.recovery_requests_consumed ?? 0));
  child.terminal_reason_code = details.reason_code ?? child.terminal_reason_code ?? null;
  child.updated_at = Date.now();
  return recompute(manifest);
}

export function recordRecoveryBudgetSnapshot(manifest, budget = {}, details = {}) {
  const initial = Number(details.initial_budget ?? budget.maximum_additional_provider_requests ?? 20);
  const consumed = Number(budget.additional_provider_requests ?? 0);
  const epochId = Number(budget.resume_epoch ?? 1);
  const snapshot = {
    resume_epoch: epochId,
    budget_type: details.budget_type ?? 'additional_provider_requests_per_root_resume_epoch',
    initial_budget: initial,
    consumed_requests: consumed,
    remaining_requests: Math.max(0, initial - consumed),
    requests_by_stage: { ...(budget.requests_by_stage ?? {}) },
    requests_by_child: { ...(budget.requests_by_child ?? {}) },
    fresh_budget_on_resume: true,
    updated_at: Date.now(),
  };
  manifest.budget_epochs = [
    ...(manifest.budget_epochs ?? []).filter((entry) => entry.resume_epoch !== epochId), snapshot,
  ].slice(-8);
  return recompute(manifest);
}

export function pauseRecoveryChildManifest(manifest, details = {}) {
  const childKey = details.next_child_key ?? null;
  if (childKey && manifest.children?.[childKey]
    && !COMPLETE_STATES.has(manifest.children[childKey].state)) {
    manifest.children[childKey].state = 'unattempted';
  }
  manifest.operational_pause = {
    active: true,
    reason_code: details.reason_code ?? 'recovery_request_budget_reached_with_pending_children',
    budget_type: details.budget_type ?? 'additional_provider_requests_per_root_resume_epoch',
    child_active_when_budget_ended: details.child_active_when_budget_ended ?? null,
    next_resumable_child: childKey,
    unattempted_siblings: details.unattempted_siblings ?? [],
    progress_made: details.progress_made === true,
    fresh_budget_on_resume: true,
    immediate_resume_expected_to_progress: childKey != null,
    paused_at: Date.now(),
  };
  return recompute(manifest);
}

export function resumeRecoveryChildManifest(manifest) {
  if (manifest.operational_pause) manifest.operational_pause.active = false;
  return recompute(manifest);
}

export function summarizeRecoveryChildManifest(manifest) {
  if (!manifest) return null;
  const current = recompute(structuredClone(manifest));
  return {
    ...current,
    expected_children: Object.values(current.children),
    reconciliation: {
      root_recovered_implies_complete_coverage: current.parent_closure_state !== 'complete'
        || current.coverage.complete === true,
      safely_checkpointed_implies_complete_coverage: current.safely_checkpointed !== true
        || current.coverage.complete === true,
      valid_generation_implies_no_unattempted_children: current.valid_generation !== true
        || current.coverage.unattempted_leaf_count === 0,
      consistent: current.parent_closure_state !== 'complete' || current.coverage.complete === true,
    },
  };
}

export function recoveryChildManifestComplete(manifest) {
  return summarizeRecoveryChildManifest(manifest)?.coverage?.complete === true;
}
