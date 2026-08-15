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
  // Durable merge redirects are semantic graph state: a redirect-only repair
  // must be visible to the local idempotence check.
  'entity_redirects',
  // Character-card stores live in extension settings rather than chat
  // metadata. The runner supplies this key as a durable snapshot.
  'characters',
]);

export const DURABLE_SEMANTIC_PROJECTION_VERSION = 1;

const VOLATILE_KEYS = new Set([
  'lastActive', 'catch_up_diagnostics', 'developer_idempotence_check',
  'repair_history', 'request_efficiency_history', 'last_catchup_run_id',
  'scene_stability_history', 'scene_stability_analysis', 'run_id',
  'created_at', 'completed_at', 'written_at', 'repaired_at', 'last_checked_at',
  'revision', 'reference_rewrite_revision', 'index_rebuild_revision',
  'final_audit_revision', 'developer_summary', 'status_card',
]);

// These scene fields drive memory retrieval, provenance, canonical identity,
// and validation. Everything else on a scene record is presentation,
// detector/diagnostic provenance, or reproducible metadata and is deliberately
// hashed separately. This keeps the semantic idempotence contract focused on
// behavior rather than on a refreshed diagnostic timestamp or comparison card.
const SCENE_SEMANTIC_FIELDS = new Set([
  'id', 'summary', 'source_memory_ids', 'source_message_indices',
  'source_start_index', 'source_end_index', 'source_messages',
  'character_participants', 'participant_references', 'parent_memory_ids',
  'grounding_status', 'validation_status', 'validation_issues',
]);

function fingerprint(value) {
  let hash = 2166136261;
  for (const char of String(value ?? '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

// Session records predate several graph fields.  Their normalized form must
// be identical before and after a reconciliation pass, even when a later
// writer persists the one-time schema backfill.  This function is deliberately
// pure: hashing or auditing never edits the live chat metadata.
function deterministicLegacySessionId(record = {}) {
  const identity = {
    type: record.type ?? 'session',
    content: record.content ?? '',
    ts: record.ts ?? 0,
    source_message_indices: [...new Set((record.source_message_indices ?? []).map(Number).filter(Number.isInteger))].sort((a, b) => a - b),
    source_messages: [...new Set((record.source_messages ?? []).map(String))].sort(),
  };
  return `sme-session-${fingerprint(JSON.stringify(identity))}`;
}

function canonicalizeSessionMemory(record = {}) {
  const value = record && typeof record === 'object' ? record : {};
  const id = value.id ?? deterministicLegacySessionId(value);
  const entities = value.entities ?? [];
  // `applyGraphDefaults` backfills this exact stable legacy object during
  // ordinary reconciliation. Treat an omitted legacy entry and its later
  // deterministic backfill as the same durable state; otherwise an automatic
  // second pass can false-fail solely because it serialized default metadata.
  const existingLinkProvenance = value.entity_link_provenance ?? {};
  const entityLinkProvenance = Object.fromEntries(entities.map((entityId) => [entityId, {
    link_id: `legacy:${id}:${entityId}`,
    link_created_run_id: null,
    link_created_at: null,
    link_created_stage: null,
    link_created_store: null,
    underlying_record_id: id,
    source_candidate_id: null,
    source_chunk_number: null,
    source_message_indices: [],
    source_extraction_type: null,
    creation_method: 'unknown_legacy',
    canonical_identity_at_creation: null,
    entity_registry_id_at_creation: entityId,
    ...(existingLinkProvenance[entityId] ?? {}),
  }]));
  return {
    ...value,
    id,
    consolidated: value.consolidated ?? true,
    importance: value.importance ?? 2,
    expiration: value.expiration ?? 'session',
    confidence: value.confidence ?? 0.7,
    persona_relevance: value.persona_relevance ?? (value.type === 'development' ? 2 : 1),
    intimacy_relevance: value.intimacy_relevance ?? (value.type === 'development' ? 2 : 1),
    retrieval_count: value.retrieval_count ?? 0,
    last_confirmed_ts: value.last_confirmed_ts ?? value.ts ?? 0,
    source_messages: value.source_messages ?? [],
    source_chat_id: value.source_chat_id ?? null,
    entities,
    entity_link_provenance: entityLinkProvenance,
    time_scope: value.time_scope ?? 'global',
    valid_from: value.valid_from ?? null,
    valid_to: value.valid_to ?? null,
    supersedes: value.supersedes ?? [],
    superseded_by: value.superseded_by ?? null,
    contradicts: value.contradicts ?? [],
    unconfirmed_since: value.unconfirmed_since ?? 0,
  };
}

// Story Arc records contain both the actual open-thread state and an expanding
// set of reconciliation, review, and rendering annotations.  Only the former
// belongs in the durable-state hash.  In particular, a refreshed status trace,
// verification timestamp, or display-only participant explanation must not
// make an otherwise stable second reconciliation pass appear non-idempotent.
function canonicalizeStoryArc(record = {}) {
  const value = record && typeof record === 'object' ? record : {};
  return {
    id: value.id ?? null,
    content: value.content ?? '',
    ts: value.ts ?? 0,
    persistent: Boolean(value.persistent),
    resolved: Boolean(value.resolved),
    status: value.status ?? (value.resolved ? 'resolved' : 'open'),
    status_confidence_class: value.status_confidence_class ?? null,
    status_reason_code: value.status_reason_code ?? null,
    last_status_change_index: value.last_status_change_index ?? null,
    source_memory_ids: value.source_memory_ids ?? [],
    parent_memory_ids: value.parent_memory_ids ?? [],
    source_message_indices: value.source_message_indices ?? [],
    source_window_start_index: value.source_window_start_index ?? null,
    source_window_end_index: value.source_window_end_index ?? null,
    source_messages: value.source_messages ?? [],
    character_participants: value.character_participants ?? [],
    participant_references: value.participant_references ?? [],
    grounding_status: value.grounding_status ?? null,
    validation_status: value.validation_status ?? null,
    validation_issues: value.validation_issues ?? [],
    verification: {
      outcome: value.verification?.outcome ?? null,
      reason_code: value.verification?.reason_code ?? null,
    },
  };
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

function splitSceneHistory(sceneHistory = []) {
  const semantic = [];
  const metadata = [];
  for (const scene of Array.isArray(sceneHistory) ? sceneHistory : []) {
    if (!scene || typeof scene !== 'object') continue;
    const semanticRecord = {};
    const metadataRecord = {};
    for (const [key, value] of Object.entries(scene)) {
      if (SCENE_SEMANTIC_FIELDS.has(key)) semanticRecord[key] = value;
      else metadataRecord[key] = value;
    }
    semantic.push(semanticRecord);
    metadata.push(metadataRecord);
  }
  return { semantic, metadata };
}

/** Scene history has explicit semantic and diagnostic hash boundaries. */
export function sceneHistoryHashComponents(metadata = {}) {
  const history = metadata?.sceneHistory ?? [];
  const split = splitSceneHistory(history);
  const semanticHistoryHash = fingerprint(JSON.stringify(canonicalize(split.semantic)));
  const comparisonMetadataHash = fingerprint(JSON.stringify(canonicalize(split.metadata)));
  const fullStoreHash = fingerprint(JSON.stringify(canonicalize(history)));
  return {
    semantic_history_hash: semanticHistoryHash,
    comparison_metadata_hash: comparisonMetadataHash,
    volatile_metadata_hash: comparisonMetadataHash,
    full_store_hash: fullStoreHash,
    semantic_record_count: split.semantic.length,
  };
}

/** Return the reconciliation-relevant semantic subset of extension metadata. */
export function buildCanonicalDurableSemanticState(metadata = {}) {
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  const selected = Object.fromEntries(Object.keys(source)
    .filter((key) => DURABLE_KEYS.has(key))
    .map((key) => [key,
      key === 'sceneHistory' ? splitSceneHistory(source[key]).semantic
        : key === 'sessionMemories' ? (Array.isArray(source[key]) ? source[key].map(canonicalizeSessionMemory) : [])
          : key === 'storyArcs' ? (Array.isArray(source[key]) ? source[key].map(canonicalizeStoryArc) : [])
            : source[key],
    ]));
  return canonicalize(selected);
}

// Backward-compatible export name. All callers should use the named semantic
// projection above so automatic, manual, UI, and export hashes share one
// explicit contract.
export const canonicalizeDurableIdempotenceState = buildCanonicalDurableSemanticState;

export function durableStateHash(metadata = {}) {
  return fingerprint(JSON.stringify(buildCanonicalDurableSemanticState(metadata)));
}

function canonicalValueDiff(before, after, limit = 24) {
  const paths = [];
  const arrayRecordKey = (value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `index:${index}`;
    // Keep leaf traces actionable without leaking labels or memory content.
    // The durable projection has already normalized ordering, so this only
    // replaces an opaque collection-level diff with a stable record handle.
    const identity = value.id ?? value.key ?? value.canonical_card_id ?? value.canonical_persona_id ?? null;
    return identity == null ? `index:${index}` : `record:${fingerprint(String(identity))}`;
  };
  const visit = (left, right, path = '') => {
    if (paths.length >= limit || JSON.stringify(left) === JSON.stringify(right)) return;
    const leftObject = left && typeof left === 'object' && !Array.isArray(left);
    const rightObject = right && typeof right === 'object' && !Array.isArray(right);
    if (Array.isArray(left) && Array.isArray(right)) {
      const leftRecords = new Map(left.map((value, index) => [arrayRecordKey(value, index), value]));
      const rightRecords = new Map(right.map((value, index) => [arrayRecordKey(value, index), value]));
      for (const key of [...new Set([...leftRecords.keys(), ...rightRecords.keys()])].sort()) {
        visit(leftRecords.get(key), rightRecords.get(key), `${path}[${key}]`);
        if (paths.length >= limit) break;
      }
      return;
    }
    if (!leftObject || !rightObject) {
      paths.push({
        path: path || 'root',
        change: left === undefined ? 'added' : right === undefined ? 'removed' : 'changed',
        before_value_hash: fingerprint(JSON.stringify(left ?? null)),
        after_value_hash: fingerprint(JSON.stringify(right ?? null)),
      });
      return;
    }
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      visit(left[key], right[key], path ? `${path}.${key}` : key);
      if (paths.length >= limit) break;
    }
  };
  visit(before, after);
  return paths;
}

// Card-local stores are maps of independent character scopes whose values are
// memory collections.  A collection-level hash is useful for detecting a
// problem, but it is not enough to identify the responsible durable field.
// This bounded, text-free diff deliberately descends through normalized arrays
// and reports only stable record fingerprints, paths, and value hashes.
function cardLocalRecordFingerprint(record, index) {
  const value = record && typeof record === 'object' ? record : {};
  if (value.id) return `memory:${value.id}`;
  return `memory:${fingerprint(JSON.stringify({
    type: value.type ?? null,
    ts: value.ts ?? value.created_at ?? null,
    source_message_indices: value.source_message_indices ?? [],
    source_messages: value.source_messages ?? [],
    index,
  }))}`;
}

function recursiveFingerprintDiff(before, after, path = '', limit = 32, output = []) {
  if (output.length >= limit || JSON.stringify(before) === JSON.stringify(after)) return output;
  const beforeArray = Array.isArray(before);
  const afterArray = Array.isArray(after);
  const beforeObject = before && typeof before === 'object';
  const afterObject = after && typeof after === 'object';
  if ((!beforeObject && !afterObject) || beforeArray !== afterArray) {
    output.push({
      canonical_field_path: path || 'record',
      before_hash: fingerprint(JSON.stringify(before ?? null)),
      after_hash: fingerprint(JSON.stringify(after ?? null)),
      semantic_classification: 'durable_semantic',
      mutation_counted: false,
    });
    return output;
  }
  if (beforeArray && afterArray) {
    const max = Math.max(before.length, after.length);
    for (let index = 0; index < max && output.length < limit; index++) {
      recursiveFingerprintDiff(before[index], after[index], `${path}[${index}]`, limit, output);
    }
    return output;
  }
  for (const key of [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort()) {
    recursiveFingerprintDiff(before?.[key], after?.[key], path ? `${path}.${key}` : key, limit, output);
    if (output.length >= limit) break;
  }
  return output;
}

/**
 * Privacy-safe, leaf-level card-local-memory comparison for automatic
 * stabilization.  It never exports memory prose, only a record fingerprint
 * and canonical field paths/value hashes.
 */
export function summarizeCardLocalMemoryChanges(before = {}, after = {}, limit = 32) {
  const beforeStores = before?.card_local_memories ?? {};
  const afterStores = after?.card_local_memories ?? {};
  const records = [];
  for (const cardName of [...new Set([...Object.keys(beforeStores), ...Object.keys(afterStores)])].sort()) {
    const beforeRecords = new Map((beforeStores[cardName] ?? []).map((record, index) => [cardLocalRecordFingerprint(record, index), canonicalize(record)]));
    const afterRecords = new Map((afterStores[cardName] ?? []).map((record, index) => [cardLocalRecordFingerprint(record, index), canonicalize(record)]));
    for (const fingerprintValue of [...new Set([...beforeRecords.keys(), ...afterRecords.keys()])].sort()) {
      const left = beforeRecords.get(fingerprintValue);
      const right = afterRecords.get(fingerprintValue);
      if (JSON.stringify(left) === JSON.stringify(right)) continue;
      const changedFields = recursiveFingerprintDiff(left, right, '', Math.max(1, limit - records.length));
      records.push({
        store: 'card_local_memories',
        card_scope_fingerprint: fingerprint(cardName),
        logical_record_fingerprint: fingerprintValue,
        changed_field_count: changedFields.length,
        changed_fields: changedFields,
        reordered_only: false,
      });
      if (records.length >= limit) break;
    }
    if (records.length >= limit) break;
  }
  return {
    changed: records.length > 0,
    total: records.length,
    records,
    // An empty comparison has no uncovered write.  Reporting it as
    // unreconciled made clean manual idempotence cards contradict themselves.
    accounting_reconciled: records.length === 0,
    truncated: records.length >= limit,
  };
}

/**
 * Compare the exact canonical projection used for durable-state hashing.
 * This makes a hash difference without a canonical diff impossible to export.
 */
export function compareDurableSemanticStates(before = {}, after = {}, limit = 24) {
  const first = buildCanonicalDurableSemanticState(before);
  const second = buildCanonicalDurableSemanticState(after);
  const firstHash = fingerprint(JSON.stringify(first));
  const secondHash = fingerprint(JSON.stringify(second));
  const paths = canonicalValueDiff(first, second, limit);
  const components = [...new Set([...Object.keys(first), ...Object.keys(second)])].sort();
  const changedComponents = components.flatMap((component) => {
    const firstComponent = first[component];
    const secondComponent = second[component];
    if (JSON.stringify(firstComponent) === JSON.stringify(secondComponent)) return [];
    const componentPaths = canonicalValueDiff(firstComponent, secondComponent, limit);
    const recordCount = (value) => Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : value == null ? 0 : 1;
    return [{
      component,
      first_hash: fingerprint(JSON.stringify(firstComponent ?? null)),
      second_hash: fingerprint(JSON.stringify(secondComponent ?? null)),
      record_count_first: recordCount(firstComponent),
      record_count_second: recordCount(secondComponent),
      order_only_difference: false,
      field_diff_available: componentPaths.length > 0,
      changed_paths: componentPaths,
    }];
  });
  const unchangedComponents = components.filter((component) => !changedComponents.some((entry) => entry.component === component));
  return {
    projection_version: DURABLE_SEMANTIC_PROJECTION_VERSION,
    first_hash: firstHash,
    second_hash: secondHash,
    changed: paths.length > 0,
    changed_top_level_stores: [...new Set(paths.map((entry) => entry.path.split(/[.[]/, 1)[0]))],
    path_count: paths.length,
    paths,
    changed_components: changedComponents,
    unchanged_components: unchangedComponents,
    hash_diff_without_canonical_diff: firstHash !== secondHash && paths.length === 0,
  };
}

/**
 * Privacy-safe structural diff for an idempotence run. It reports only
 * durable store/path names and change kinds—never stored memory or model text.
 */
export function summarizeDurableStateChanges(before = {}, after = {}, limit = 24) {
  const comparison = compareDurableSemanticStates(before, after, limit);
  const paths = comparison.paths;
  const changesByCategory = paths.reduce((summary, entry) => {
    const category = entry.path.startsWith('sceneHistory') ? 'scene_history_semantic'
      : entry.path.startsWith('characters') ? 'character_store'
        : 'other_durable_store';
    summary[category] = (summary[category] ?? 0) + 1;
    return summary;
  }, {});
  return {
    changed: comparison.changed,
    changed_top_level_stores: comparison.changed_top_level_stores,
    path_count: comparison.path_count,
    paths,
    changed_path_count: paths.length,
    changed_paths: paths,
    changes_by_category: changesByCategory,
    accounted_mutation_count: 0,
    unaccounted_mutation_count: paths.length,
    truncated: paths.length >= limit,
    projection_version: comparison.projection_version,
    first_hash: comparison.first_hash,
    second_hash: comparison.second_hash,
    changed_components: comparison.changed_components,
    unchanged_components: comparison.unchanged_components,
    hash_diff_without_canonical_diff: comparison.hash_diff_without_canonical_diff,
  };
}

/**
 * Reconcile mutation counters with the exact durable semantic projection.
 * Writers may mutate nested records in place, so this is the last accounting
 * boundary before a reconciliation pass is allowed to report itself stable.
 */
export function deriveDurableWriteAccounting(before = {}, after = {}, counts = {}, limit = 24) {
  const comparison = compareDurableSemanticStates(before, after, limit);
  const logical = numeric(counts.logical_mutations);
  const physical = numeric(counts.physical_mutations);
  // A writer counts one durable-record mutation even when it updates several
  // leaf fields.  Group leaves by the record handle emitted by the canonical
  // diff so accounting remains consistent with those parent mutations.
  const semanticUnits = comparison.changed ? Math.max(1, new Set(comparison.paths.map((entry) => {
    const match = String(entry.path ?? 'root').match(/^[^.]+(?:\[record:[^\]]+\])?/);
    return match?.[0] ?? String(entry.path ?? 'root').split('.')[0];
  })).size) : 0;
  const countedUnits = Math.max(logical, physical);
  const accountingBackfill = Math.max(0, semanticUnits - countedUnits);
  const traces = comparison.paths.map((path) => ({
    store: String(path.path ?? 'root').split('.')[0] || 'root',
    changed_field_paths: [path.path ?? 'root'],
    canonical_before_hash: path.before_value_hash ?? null,
    canonical_after_hash: path.after_value_hash ?? null,
    source_operation: accountingBackfill ? 'reconciliation_semantic_diff_backstop' : 'writer_accounted',
    logical_mutation_counted: !accountingBackfill,
    physical_mutation_counted: !accountingBackfill,
    covered_by_parent_mutation: !accountingBackfill,
    semantic_classification: 'durable_semantic_write',
  }));
  return {
    comparison,
    semantic_mutation_units: semanticUnits,
    counted_mutation_units: countedUnits,
    accounting_backfill_count: accountingBackfill,
    unaccounted_semantic_changes: accountingBackfill,
    accounting_reconciled: !comparison.changed || accountingBackfill === 0,
    invariant_failure: !comparison.changed ? countedUnits > 0 : false,
    traces,
  };
}

/**
 * Privacy-safe session-memory diff.  It exposes IDs, paths, categories, and
 * value fingerprints only; claim text is never included in diagnostics.
 */
export function summarizeSessionMemoryChanges(before = {}, after = {}, limit = 32) {
  const beforeRecords = new Map((before?.sessionMemories ?? []).map((record) => {
    const normalized = canonicalizeSessionMemory(record);
    return [normalized.id, canonicalize(normalized)];
  }));
  const afterRecords = new Map((after?.sessionMemories ?? []).map((record) => {
    const normalized = canonicalizeSessionMemory(record);
    return [normalized.id, canonicalize(normalized)];
  }));
  const added = [...afterRecords.keys()].filter((id) => !beforeRecords.has(id)).sort();
  const removed = [...beforeRecords.keys()].filter((id) => !afterRecords.has(id)).sort();
  const changedRecordIds = [];
  const changedPaths = [];
  const categories = {};
  const visit = (left, right, path, id) => {
    if (changedPaths.length >= limit || JSON.stringify(left) === JSON.stringify(right)) return;
    const leftObject = left && typeof left === 'object' && !Array.isArray(left);
    const rightObject = right && typeof right === 'object' && !Array.isArray(right);
    if (!leftObject || !rightObject) {
      const field = path || 'record';
      const category = /(?:source|citation|provenance)/i.test(field) ? 'provenance_semantic'
        : /(?:id|type|content|valid|supersed|contradict|entity)/i.test(field) ? 'semantic_durable'
          : /(?:terminal|disposition|validation)/i.test(field) ? 'deterministic_derived' : 'other_durable';
      categories[category] = (categories[category] ?? 0) + 1;
      changedPaths.push({ record_id: id, field_path: field, change_category: category,
        before_value_hash: fingerprint(JSON.stringify(left)), after_value_hash: fingerprint(JSON.stringify(right)),
        semantic: true, mutation_counted: false, lifecycle_stage: 'comparison' });
      return;
    }
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) visit(left[key], right[key], path ? `${path}.${key}` : key, id);
  };
  for (const id of [...beforeRecords.keys()].filter((key) => afterRecords.has(key)).sort()) {
    const start = changedPaths.length;
    visit(beforeRecords.get(id), afterRecords.get(id), '', id);
    if (changedPaths.length > start) changedRecordIds.push(id);
  }
  return {
    changed: Boolean(added.length || removed.length || changedRecordIds.length),
    record_count_before: beforeRecords.size,
    record_count_after: afterRecords.size,
    added_record_ids: added.slice(0, limit), removed_record_ids: removed.slice(0, limit),
    changed_record_ids: changedRecordIds.slice(0, limit),
    reordered_only: !added.length && !removed.length && !changedRecordIds.length
      && JSON.stringify((before?.sessionMemories ?? []).map((record) => canonicalizeSessionMemory(record).id)) !== JSON.stringify((after?.sessionMemories ?? []).map((record) => canonicalizeSessionMemory(record).id)),
    changed_path_count: changedPaths.length, changed_paths: changedPaths, changes_by_category: categories,
    accounted_mutation_count: 0, unaccounted_mutation_count: changedPaths.length,
    truncated: changedPaths.length >= limit || added.length > limit || removed.length > limit || changedRecordIds.length > limit,
  };
}

/**
 * Privacy-safe Story Arc diff for automatic-stabilization diagnostics. Arc
 * content is deliberately never exported; only stable record labels and field
 * paths are retained so a legacy normalizer can be diagnosed precisely.
 */
export function summarizeStoryArcChanges(before = {}, after = {}, limit = 32) {
  const recordId = (record, index) => String(record?.id ?? `legacy-arc:${record?.ts ?? 0}:${fingerprint(record?.content ?? '').slice(-8)}:${index}`);
  const beforeRecords = new Map((before?.storyArcs ?? []).map((record, index) => [recordId(record, index), canonicalize(canonicalizeStoryArc(record))]));
  const afterRecords = new Map((after?.storyArcs ?? []).map((record, index) => [recordId(record, index), canonicalize(canonicalizeStoryArc(record))]));
  const added = [...afterRecords.keys()].filter((id) => !beforeRecords.has(id)).sort();
  const removed = [...beforeRecords.keys()].filter((id) => !afterRecords.has(id)).sort();
  const changedRecordIds = [];
  const changedPaths = [];
  for (const [id, beforeRecord] of beforeRecords) {
    const afterRecord = afterRecords.get(id);
    if (!afterRecord || JSON.stringify(beforeRecord) === JSON.stringify(afterRecord)) continue;
    changedRecordIds.push(id);
    for (const fieldPath of [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort()) {
      if (JSON.stringify(beforeRecord[fieldPath]) === JSON.stringify(afterRecord[fieldPath])) continue;
      changedPaths.push({
        record_id: id,
        field_path: fieldPath,
        change_category: /(?:provenance|created|stage|store)/.test(fieldPath) ? 'provenance_or_lifecycle' : 'semantic_or_unknown',
        before_value_hash: fingerprint(JSON.stringify(beforeRecord[fieldPath] ?? null)),
        after_value_hash: fingerprint(JSON.stringify(afterRecord[fieldPath] ?? null)),
      });
      if (changedPaths.length >= limit) break;
    }
    if (changedPaths.length >= limit) break;
  }
  return {
    changed: Boolean(added.length || removed.length || changedRecordIds.length),
    record_count_before: beforeRecords.size,
    record_count_after: afterRecords.size,
    added_record_ids: added.slice(0, limit),
    removed_record_ids: removed.slice(0, limit),
    changed_record_ids: changedRecordIds.slice(0, limit),
    changed_path_count: changedPaths.length,
    changed_paths: changedPaths,
    truncated: added.length > limit || removed.length > limit || changedRecordIds.length > limit || changedPaths.length >= limit,
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

/** Derive the bounded automatic-stabilization verdict from its final pass. */
export function deriveAutomaticStabilizationResult(passes = [], maxPasses = 0) {
  const history = Array.isArray(passes) ? passes : [];
  const finalPass = history.at(-1) ?? null;
  const stable = Boolean(finalPass)
    && finalPass.input_semantic_hash === finalPass.output_semantic_hash
    && numeric(finalPass.logical_mutations) === 0
    && numeric(finalPass.physical_mutations) === 0
    && numeric(finalPass.stale_references) === 0
    && numeric(finalPass.recreated_links) === 0
    && numeric(finalPass.unsafe_merge_candidates) === 0
    && numeric(finalPass.unresolved_integrity_failures) === 0
    && numeric(finalPass.unaccounted_mutations) === 0;
  const maxPassesReached = Boolean(maxPasses && history.length >= maxPasses && !stable);
  const attentionReasons = maxPassesReached ? ['max_passes_reached'] : stable ? [] : ['final_verification_not_stable'];
  return {
    converged: stable,
    idempotent: stable,
    attention_required: !stable,
    attention_reasons: attentionReasons,
    converged_on_pass: stable ? finalPass.pass_number : null,
    max_passes_reached: maxPassesReached,
    final_input_semantic_hash: finalPass?.input_semantic_hash ?? null,
    final_output_semantic_hash: finalPass?.output_semantic_hash ?? null,
    final_verification_pass: finalPass?.pass_number ?? null,
  };
}

/** The one authoritative pass/fail derivation for runner, persistence, UI, and export. */
export function deriveIdempotenceResult(data = {}) {
  const secondLogical = numeric(data.second_pass_logical_mutations);
  const secondPhysical = numeric(data.second_pass_physical_mutations);
  const stale = numeric(data.stale_references_after_second_pass);
  const recreated = numeric(data.recreated_after_prior_repair);
  const unsafe = numeric(data.unsafe_merge_candidates_after_second_pass);
  const unresolved = numeric(data.unresolved_integrity_failures_after_second_pass);
  const unaccounted = numeric(data.unaccounted_mutations_after_second_pass);
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
  if (unaccounted) attentionReasons.push('unaccounted_durable_mutation');
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
    unaccounted_mutations_after_second_pass: unaccounted,
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
