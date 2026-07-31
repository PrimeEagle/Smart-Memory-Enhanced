/**
 * Pure helpers for the local-only canonical reconciliation idempotence check.
 *
 * Durable state includes memory/graph stores whose reconciliation may change
 * meaning.  It deliberately excludes diagnostics, UI state, run IDs, audit
 * timestamps, revision counters, and the developer result itself.
 */

const DURABLE_KEYS = new Set([
  'sessionMemories', 'sessionEntities', 'sceneHistory', 'storyArcs',
  'arcSummaries', 'state_ledger', 'profiles', 'card_local_relationships',
  'card_local_entities', 'card_local_memories', 'card_local_epistemic',
  'summary', 'summaryEnd', 'entityRegistry', 'entity_registry', 'redirects',
  'relationshipHistory', 'relationship_history', 'epistemic', 'canon',
  // Character-card stores live in extension settings rather than chat
  // metadata. The runner supplies this key as a durable snapshot.
  'characters',
]);

const VOLATILE_KEYS = new Set([
  'lastActive', 'catch_up_diagnostics', 'developer_idempotence_check',
  'repair_history', 'request_efficiency_history', 'last_catchup_run_id',
  'scene_stability_history', 'scene_stability_analysis', 'run_id',
  'created_at', 'completed_at', 'written_at', 'repaired_at', 'last_checked_at',
  'revision', 'reference_rewrite_revision', 'index_rebuild_revision',
  'final_audit_revision', 'developer_summary', 'status_card',
]);

function fingerprint(value) {
  let hash = 2166136261;
  for (const char of String(value ?? '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function canonicalize(value, { excludeVolatile = true } = {}) {
  if (Array.isArray(value)) {
    // Reconciliation treats store collections as sets keyed by durable record
    // identity. Sorting their canonical representations avoids UI/order-only
    // differences affecting the durable-state hash.
    return value.map((item) => canonicalize(item, { excludeVolatile })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().flatMap((name) => {
    if (excludeVolatile && (VOLATILE_KEYS.has(name) || /(?:^|_)(?:run|audit|check)_(?:id|at)$/.test(name))) return [];
    const item = value[name];
    if (typeof item === 'undefined') return [];
    return [[name, canonicalize(item, { excludeVolatile })]];
  }));
}

/** Return the reconciliation-relevant semantic subset of extension metadata. */
export function canonicalizeDurableIdempotenceState(metadata = {}) {
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  const selected = Object.fromEntries(Object.keys(source)
    .filter((key) => DURABLE_KEYS.has(key))
    .map((key) => [key, source[key]]));
  return canonicalize(selected);
}

export function durableStateHash(metadata = {}) {
  return fingerprint(JSON.stringify(canonicalizeDurableIdempotenceState(metadata)));
}

/**
 * Privacy-safe structural diff for an idempotence run. It reports only
 * durable store/path names and change kinds—never stored memory or model text.
 */
export function summarizeDurableStateChanges(before = {}, after = {}, limit = 24) {
  const left = canonicalizeDurableIdempotenceState(before);
  const right = canonicalizeDurableIdempotenceState(after);
  const paths = [];
  const visit = (a, b, path = '') => {
    if (paths.length >= limit || JSON.stringify(a) === JSON.stringify(b)) return;
    const aObject = a && typeof a === 'object';
    const bObject = b && typeof b === 'object';
    if (!aObject || !bObject || Array.isArray(a) || Array.isArray(b)) {
      paths.push({ path: path || 'root', change: a === undefined ? 'added' : b === undefined ? 'removed' : 'changed' });
      return;
    }
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      visit(a[key], b[key], path ? `${path}.${key}` : key);
      if (paths.length >= limit) break;
    }
  };
  visit(left, right);
  return {
    changed: paths.length > 0,
    changed_top_level_stores: [...new Set(paths.map((entry) => entry.path.split('.')[0]))],
    path_count: paths.length,
    paths,
    truncated: paths.length >= limit,
  };
}

export function diagnosticMetadataHash(metadata = {}) {
  return fingerprint(JSON.stringify(metadata ?? {}));
}

export function revisionMetadataHash(metadata = {}) {
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  const revisions = Object.fromEntries(Object.entries(source)
    .filter(([key]) => VOLATILE_KEYS.has(key) || /(?:history|diagnostic|revision|run_id|lastActive)/i.test(key))
    .sort(([left], [right]) => left.localeCompare(right)));
  // Revision metadata is intentionally measured separately.  Do not apply
  // the durable-state exclusions here or every revision-only comparison
  // collapses to the same empty object.
  return fingerprint(JSON.stringify(canonicalize(revisions, { excludeVolatile: false })));
}

const numeric = (value) => Math.max(0, Number(value ?? 0) || 0);

/** The one authoritative pass/fail derivation for runner, persistence, UI, and export. */
export function deriveIdempotenceResult(data = {}) {
  const secondLogical = numeric(data.second_pass_logical_mutations);
  const secondPhysical = numeric(data.second_pass_physical_mutations);
  const stale = numeric(data.stale_references_after_second_pass);
  const recreated = numeric(data.recreated_after_prior_repair);
  const unsafe = numeric(data.unsafe_merge_candidates_after_second_pass);
  const unresolved = numeric(data.unresolved_integrity_failures_after_second_pass);
  // Persisted legacy/compatibility fields have previously disagreed with the
  // actual durable hashes.  Whenever both hashes are present, the hashes are
  // authoritative; only fall back to the older boolean for incomplete data.
  const durableHashesAvailable = typeof data.durable_state_hash_after_first_pass === 'string'
    && typeof data.durable_state_hash_after_second_pass === 'string';
  const durableChanged = durableHashesAvailable
    ? data.durable_state_hash_after_first_pass !== data.durable_state_hash_after_second_pass
    : data.durable_state_changed === true;
  const attentionReasons = [];
  if (data.check_failed) attentionReasons.push('check_failed');
  if (secondLogical) attentionReasons.push('second_pass_logical_mutations_nonzero');
  if (secondPhysical) attentionReasons.push('second_pass_physical_mutations_nonzero');
  if (stale) attentionReasons.push('stale_references_remaining');
  if (recreated) attentionReasons.push('recreated_links_detected');
  if (unsafe) attentionReasons.push('unsafe_merge_candidate_remaining');
  if (unresolved) attentionReasons.push('unresolved_integrity_failure');
  if (durableChanged && !secondLogical && !secondPhysical) attentionReasons.push('durable_state_hash_changed_without_accounted_mutation');
  if (data.result_internally_inconsistent) attentionReasons.push('result_internally_inconsistent');
  const idempotent = attentionReasons.length === 0;
  const firstPassMaintenance = numeric(data.first_pass_logical_mutations) > 0 || numeric(data.first_pass_physical_mutations) > 0;
  const metadataOnlyChanges = !durableChanged && (data.diagnostic_metadata_changed === true || data.revision_metadata_changed === true);
  return {
    ...data,
    idempotence_result_schema_version: 2,
    second_pass_logical_mutations: secondLogical,
    second_pass_physical_mutations: secondPhysical,
    stale_references_after_second_pass: stale,
    recreated_after_prior_repair: recreated,
    unsafe_merge_candidates_after_second_pass: unsafe,
    unresolved_integrity_failures_after_second_pass: unresolved,
    durable_state_changed: durableChanged,
    maintenance_needed_on_first_pass: firstPassMaintenance,
    stable_on_second_pass: idempotent,
    idempotent_final_state: idempotent,
    idempotent,
    attention_required: !idempotent,
    attention_reasons: attentionReasons,
    metadata_only_changes: metadataOnlyChanges,
    interpretation: idempotent ? (firstPassMaintenance ? 'passed_after_maintenance' : 'passed') : 'needs_attention',
    summary: idempotent
      ? `Idempotence check passed${firstPassMaintenance ? ' after maintenance' : ''}: ${secondLogical} second-pass mutations, ${stale} stale references, ${recreated} recreated links.${metadataOnlyChanges ? ' Diagnostic metadata changed only.' : ''}`
      : `Idempotence check needs attention: ${attentionReasons.join(', ')}.`,
  };
}

/** Normalize legacy strict-full-hash results without losing their original value. */
export function normalizeIdempotenceResult(result = {}) {
  const legacy = result.idempotence_result_schema_version !== 2;
  const initial = deriveIdempotenceResult(result);
  const lifecycle = result.idempotence_result_lifecycle;
  const lifecycleValues = lifecycle && typeof lifecycle === 'object'
    ? ['runner_result', 'persisted_result', 'restored_result', 'exported_result', 'renderer_result']
      .map((key) => lifecycle[key])
      .filter((value) => typeof value === 'boolean')
    : [];
  const lifecycleMismatch = lifecycleValues.some((value) => value !== initial.idempotent)
    || lifecycle?.values_consistent === false;
  const normalized = lifecycleMismatch
    ? deriveIdempotenceResult({ ...result, result_internally_inconsistent: true })
    : initial;
  const falseNegative = result.idempotent === false && normalized.idempotent === true;
  return {
    ...normalized,
    ...(legacy ? { legacy_idempotent_result: result.idempotent, migrated_from_full_hash_semantics: falseNegative } : {}),
    idempotence_false_negative_detected: falseNegative,
    idempotence_result_lifecycle_mismatch: lifecycleMismatch,
  };
}
