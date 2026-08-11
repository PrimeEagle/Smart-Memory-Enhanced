import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeDurableIdempotenceState,
  compareDurableSemanticStates,
  deriveIdempotenceResult,
  deriveAutomaticStabilizationResult,
  durableStateHash,
  summarizeDurableStateChanges,
  summarizeSessionMemoryChanges,
  summarizeStoryArcChanges,
  normalizeIdempotenceResult,
} from '../idempotence-utils.js';

const stableSecondPass = {
  second_pass_logical_mutations: 0,
  second_pass_physical_mutations: 0,
  stale_references_after_second_pass: 0,
  recreated_after_prior_repair: 0,
  unsafe_merge_candidates_after_second_pass: 0,
  unresolved_integrity_failures_after_second_pass: 0,
};

test('metadata-only hash differences remain idempotent', () => {
  const result = deriveIdempotenceResult({ ...stableSecondPass, diagnostic_metadata_changed: true, revision_metadata_changed: true });
  assert.equal(result.idempotent, true);
  assert.equal(result.attention_required, false);
  assert.equal(result.metadata_only_changes, true);
});

test('bounded stabilization parent verdict follows the final verification pass', () => {
  const result = deriveAutomaticStabilizationResult([
    { pass_number: 1, input_semantic_hash: 'a', output_semantic_hash: 'b', logical_mutations: 2, physical_mutations: 2, stale_references: 0, recreated_links: 0 },
    { pass_number: 2, input_semantic_hash: 'b', output_semantic_hash: 'b', logical_mutations: 0, physical_mutations: 0, stale_references: 0, recreated_links: 0 },
  ], 4);
  assert.equal(result.converged, true);
  assert.equal(result.attention_required, false);
  assert.equal(result.converged_on_pass, 2);
});

test('bounded stabilization requires a clean final integrity audit', () => {
  const result = deriveAutomaticStabilizationResult([
    { pass_number: 1, input_semantic_hash: 'a', output_semantic_hash: 'a', logical_mutations: 0, physical_mutations: 0, stale_references: 0, recreated_links: 0, unsafe_merge_candidates: 1, unresolved_integrity_failures: 0 },
  ], 4);
  assert.equal(result.converged, false);
  assert.equal(result.attention_required, true);
  assert.deepEqual(result.attention_reasons, ['final_verification_not_stable']);
});

test('second-pass durable changes require attention', () => {
  const result = deriveIdempotenceResult({ ...stableSecondPass, second_pass_logical_mutations: 1, durable_state_changed: true });
  assert.equal(result.idempotent, false);
  assert.deepEqual(result.attention_reasons, ['second_pass_logical_mutations_nonzero']);
});

test('an unaccounted durable hash change requires attention', () => {
  const result = deriveIdempotenceResult({ ...stableSecondPass, durable_state_changed: true });
  assert.equal(result.idempotent, false);
  assert.ok(result.attention_reasons.includes('durable_state_hash_changed_without_accounted_mutation'));
});

test('matching durable hashes override a stale compatibility change flag', () => {
  const result = normalizeIdempotenceResult({
    ...stableSecondPass,
    idempotence_result_schema_version: 2,
    idempotent: false,
    durable_state_changed: true,
    durable_state_hash_after_first_pass: 'same',
    durable_state_hash_after_second_pass: 'same',
  });
  assert.equal(result.durable_state_changed, false);
  assert.equal(result.idempotent, true);
  assert.equal(result.attention_required, false);
  assert.equal(result.idempotence_false_negative_detected, true);
});

test('first-pass maintenance followed by a stable second pass is idempotent', () => {
  const result = deriveIdempotenceResult({ ...stableSecondPass, first_pass_logical_mutations: 3, first_pass_physical_mutations: 5 });
  assert.equal(result.idempotent, true);
  assert.equal(result.maintenance_needed_on_first_pass, true);
  assert.equal(result.interpretation, 'passed_after_maintenance');
});

test('stale references and recreated links require attention', () => {
  assert.equal(deriveIdempotenceResult({ ...stableSecondPass, stale_references_after_second_pass: 1 }).idempotent, false);
  assert.equal(deriveIdempotenceResult({ ...stableSecondPass, recreated_after_prior_repair: 1 }).idempotent, false);
});

test('legacy strict full-hash false negatives migrate to the durable result', () => {
  const result = normalizeIdempotenceResult({ ...stableSecondPass, idempotent: false, first_pass_input_hash: 'a', first_pass_output_hash: 'b' });
  assert.equal(result.idempotent, true);
  assert.equal(result.legacy_idempotent_result, false);
  assert.equal(result.migrated_from_full_hash_semantics, true);
  assert.equal(result.idempotence_false_negative_detected, true);
});

test('lifecycle disagreement is an explicit internal inconsistency', () => {
  const result = normalizeIdempotenceResult({
    ...stableSecondPass,
    idempotence_result_schema_version: 2,
    idempotence_result_lifecycle: { runner_result: true, persisted_result: false, values_consistent: false },
  });
  assert.equal(result.idempotent, false);
  assert.ok(result.attention_reasons.includes('result_internally_inconsistent'));
  assert.equal(result.idempotence_result_lifecycle_mismatch, true);
});

test('durable canonicalizer ignores diagnostics and canonicalizes collection order', () => {
  const first = {
    sessionMemories: [{ id: 'b', content: 'B' }, { id: 'a', content: 'A' }],
    catch_up_diagnostics: { run_id: 'one' },
    developer_idempotence_check: { idempotent: false },
  };
  const second = {
    sessionMemories: [{ content: 'A', id: 'a' }, { content: 'B', id: 'b' }],
    catch_up_diagnostics: { run_id: 'two' },
    developer_idempotence_check: { idempotent: true },
  };
  assert.deepEqual(canonicalizeDurableIdempotenceState(first), canonicalizeDurableIdempotenceState(second));
  assert.equal(durableStateHash(first), durableStateHash(second));
});

test('durable hash and structural diff share exactly one canonical projection', () => {
  const first = { sessionMemories: [{ id: 'one', content: 'A', source_message_indices: [3, 1] }] };
  const same = { sessionMemories: [{ content: 'A', id: 'one', source_message_indices: [1, 3] }] };
  const changed = { sessionMemories: [{ content: 'B', id: 'one', source_message_indices: [1, 3] }] };
  const equal = compareDurableSemanticStates(first, same);
  assert.equal(equal.changed, false);
  assert.equal(equal.first_hash, equal.second_hash);
  assert.equal(equal.hash_diff_without_canonical_diff, false);
  const different = compareDurableSemanticStates(first, changed);
  assert.equal(different.changed, true);
  assert.notEqual(different.first_hash, different.second_hash);
  assert.ok(different.changed_components.some((entry) => entry.component === 'sessionMemories'));
});

test('durable canonical projection is pure and does not sort or backfill live state', () => {
  const state = { sessionMemories: [{ id: 'b', content: 'B' }, { id: 'a', content: 'A' }], storyArcs: [{ id: 'arc', content: 'Open thread' }] };
  const before = structuredClone(state);
  canonicalizeDurableIdempotenceState(state);
  assert.deepEqual(state, before);
});

test('durable canonicalizer includes per-character durable stores', () => {
  assert.notEqual(
    durableStateHash({ characters: { Taylor: { memories: [{ id: 'one' }] } } }),
    durableStateHash({ characters: { Taylor: { memories: [{ id: 'two' }] } } }),
  );
});

test('durable canonicalizer includes persistent entity merge redirects', () => {
  assert.notEqual(
    durableStateHash({ entity_redirects: { old: { replacement_canonical_id: 'first' } } }),
    durableStateHash({ entity_redirects: { old: { replacement_canonical_id: 'second' } } }),
  );
});

test('durable-state diagnostics expose changed store paths without content', () => {
  const summary = summarizeDurableStateChanges(
    { sessionMemories: [{ id: 'one', content: 'private before' }] },
    { sessionMemories: [{ id: 'one', content: 'private after' }] },
  );
  assert.equal(summary.changed, true);
  assert.deepEqual(summary.changed_top_level_stores, ['sessionMemories']);
  assert.equal(JSON.stringify(summary).includes('private before'), false);
  assert.equal(JSON.stringify(summary).includes('private after'), false);
});

test('session-memory canonicalization is stable across legacy default backfill', () => {
  const legacy = { sessionMemories: [{ type: 'fact', content: 'Private claim', ts: 4, source_message_indices: [2, 1] }] };
  const normalized = { sessionMemories: [{
    type: 'fact', content: 'Private claim', ts: 4, source_message_indices: [1, 2],
    id: 'sme-session-fnv1a-94f5c4bf', consolidated: true, importance: 2, expiration: 'session',
    confidence: 0.7, persona_relevance: 1, intimacy_relevance: 1, retrieval_count: 0,
    last_confirmed_ts: 4, source_messages: [], source_chat_id: null, entities: [], time_scope: 'global',
    valid_from: null, valid_to: null, supersedes: [], superseded_by: null, contradicts: [], unconfirmed_since: 0,
  }] };
  // An existing deterministic legacy ID must agree with the pre-backfill
  // semantic representation.  Use the canonicalizer rather than live state.
  const canonical = canonicalizeDurableIdempotenceState(legacy).sessionMemories[0];
  normalized.sessionMemories[0].id = canonical.id;
  assert.equal(durableStateHash(legacy), durableStateHash(normalized));
});

test('session link-provenance legacy backfill does not change durable state', () => {
  const base = { sessionMemories: [{ id: 'memory-1', type: 'fact', content: 'A fact', entities: ['entity-1'] }] };
  const backfilled = { sessionMemories: [{
    ...base.sessionMemories[0],
    entity_link_provenance: {
      'entity-1': {
        link_id: 'legacy:memory-1:entity-1', link_created_run_id: null, link_created_at: null,
        link_created_stage: null, link_created_store: null, underlying_record_id: 'memory-1',
        source_candidate_id: null, source_chunk_number: null, source_message_indices: [],
        source_extraction_type: null, creation_method: 'unknown_legacy', canonical_identity_at_creation: null,
        entity_registry_id_at_creation: 'entity-1',
      },
    },
  }] };
  assert.equal(durableStateHash(base), durableStateHash(backfilled));
});

test('story-arc canonicalization is stable across empty legacy bookkeeping backfill', () => {
  const legacy = { storyArcs: [{ id: 'arc-1', content: 'A decision remains unresolved.', ts: 4 }] };
  const normalized = { storyArcs: [{
    id: 'arc-1', content: 'A decision remains unresolved.', ts: 4,
    character_participants: [], synthetic_identity_labels_removed: [], identity_rejections: [],
  }] };
  assert.equal(durableStateHash(legacy), durableStateHash(normalized));
});

test('story-arc reconciliation annotations do not alter durable state', () => {
  const base = { storyArcs: [{
    id: 'arc-1', content: 'A decision remains unresolved.', ts: 4,
    status: 'open', character_participants: ['Taylor Covington'],
    verification: { outcome: 'supported', reason_code: 'provenance_and_participants_attached', verified_at: 1 },
  }] };
  const annotated = { storyArcs: [{
    ...base.storyArcs[0],
    participant_additions: [{ name: 'Taylor Covington', reason: 'Named directly in arc content.' }],
    identity_replacements: [{ from: 'Taylor', to: 'Taylor Covington', reason: 'Approved alias.' }],
    arc_status_trace: { continuation_evidence_count: 7, final_status: 'open' },
    verification: { outcome: 'supported', reason_code: 'provenance_and_participants_attached', verified_at: 999 },
  }] };
  assert.equal(durableStateHash(base), durableStateHash(annotated));
});

test('story-arc semantic status and content changes alter durable state', () => {
  const base = { storyArcs: [{ id: 'arc-1', content: 'A decision remains unresolved.', status: 'open' }] };
  assert.notEqual(durableStateHash(base), durableStateHash({ storyArcs: [{ ...base.storyArcs[0], status: 'resolved', resolved: true }] }));
  assert.notEqual(durableStateHash(base), durableStateHash({ storyArcs: [{ ...base.storyArcs[0], content: 'A different unresolved decision remains.' }] }));
});

test('story-arc diff identifies field paths without exposing arc content', () => {
  const summary = summarizeStoryArcChanges(
    { storyArcs: [{ id: 'arc-1', content: 'private before', ts: 4 }] },
    { storyArcs: [{ id: 'arc-1', content: 'private after', ts: 4 }] },
  );
  assert.equal(summary.changed, true);
  assert.deepEqual(summary.changed_record_ids, ['arc-1']);
  assert.equal(JSON.stringify(summary).includes('private before'), false);
  assert.equal(JSON.stringify(summary).includes('private after'), false);
});

test('session-memory diff is privacy-safe and identifies changed record fields', () => {
  const summary = summarizeSessionMemoryChanges(
    { sessionMemories: [{ id: 'one', type: 'fact', content: 'private before', source_message_indices: [1] }] },
    { sessionMemories: [{ id: 'one', type: 'fact', content: 'private after', source_message_indices: [1] }] },
  );
  assert.equal(summary.changed, true);
  assert.deepEqual(summary.changed_record_ids, ['one']);
  assert.equal(JSON.stringify(summary).includes('private before'), false);
  assert.equal(JSON.stringify(summary).includes('private after'), false);
});
