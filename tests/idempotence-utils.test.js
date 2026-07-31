import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeDurableIdempotenceState,
  deriveIdempotenceResult,
  durableStateHash,
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

test('durable canonicalizer includes per-character durable stores', () => {
  assert.notEqual(
    durableStateHash({ characters: { Taylor: { memories: [{ id: 'one' }] } } }),
    durableStateHash({ characters: { Taylor: { memories: [{ id: 'two' }] } } }),
  );
});
