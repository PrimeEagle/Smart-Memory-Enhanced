import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSceneStabilityHistory, canonicalizeGateOutput, compareSceneBoundaryRuns } from '../scene-stability-utils.js';

test('scene comparison classifies exact, shifted, added, and removed boundaries', () => {
  const common = { prompt_shape_hash: 'prompt', model_identifier: 'model', connection_profile_identifier: 'profile', task_sampling_settings: { temperature: 0 } };
  const previous = { ...common, generated: 11, final_break_indices: [48, 72, 148, 168, 184, 206, 228, 238, 258, 276] };
  const current = { ...common, generated: 9, final_break_indices: [48, 72, 148, 168, 184, 228, 238, 258] };
  const comparison = compareSceneBoundaryRuns(previous, current, 2);
  assert.equal(comparison.unchanged_breaks, 8);
  assert.equal(comparison.breaks_removed, 2);
  assert.equal(comparison.breaks_added, 0);
  assert.equal(comparison.breaks_shifted, 0);
  assert.equal(comparison.scene_count_stable, false);
  assert.equal(comparison.decision_pipeline_stable, true);
  assert.deepEqual(comparison.removed_boundaries, [206, 276]);
});

test('scene comparison matches nearest unmatched boundary within tolerance', () => {
  const base = { generated: 3, prompt_shape_hash: 'p', model_identifier: 'm', connection_profile_identifier: 'c', task_sampling_settings: {} };
  const comparison = compareSceneBoundaryRuns({ ...base, final_break_indices: [100] }, { ...base, final_break_indices: [101] }, 2);
  assert.equal(comparison.breaks_shifted, 1);
  assert.equal(comparison.boundary_positions_materially_stable, true);
  assert.equal(comparison.decision_pipeline_stable, true);
  assert.equal(comparison.marginal_boundary_comparison[0].classification, 'shifted');
  assert.equal(comparison.marginal_boundary_comparison[0].cross_candidate_context_equal, false);
  assert.equal(comparison.marginal_boundary_comparison[0].previous_candidate_context_stable_across_runs, false);
});

test('multi-run stability reports consensus, marginal boundaries, and shifts', () => {
  const shared = { scene_detection_run_signature: 'sig', prompt_shape_hash: 'prompt', model_identifier: 'model', connection_profile_identifier: 'profile', task_sampling_settings: { temperature: 0 }, malformed_batches: 0, fallback_boundaries: 0 };
  const current = { ...shared, run_id: 'three', generated: 10, final_break_indices: [20, 50, 80] };
  const result = analyzeSceneStabilityHistory([
    { ...shared, run_id: 'one', generated: 9, final_break_indices: [20, 48, 90] },
    { ...shared, run_id: 'two', generated: 10, final_break_indices: [20, 50, 92] },
  ], current, 2);
  assert.equal(result.comparable_run_count, 3);
  assert.deepEqual(result.stable_consensus_boundaries, [20]);
  assert.deepEqual(result.majority_boundaries, [20, 50]);
  assert.deepEqual(result.one_off_boundaries, [48, 80, 90, 92]);
  assert.deepEqual(result.exact_consensus_boundary_details, [{ boundary_index: 20, runs_present: ['one', 'two', 'three'], distinct_run_count: 3, exact_observation_count: 3 }]);
  assert.equal(result.scene_count_range, 1);
  assert.equal(result.scene_count_materially_stable, true);
  assert.ok(result.shifted_boundary_clusters.some((cluster) => cluster.member_indices.includes(48) && cluster.member_indices.includes(50)));
});

test('scene-count ties are reported as ties instead of choosing the smallest count', () => {
  const shared = { scene_detection_run_signature: 'sig', prompt_shape_hash: 'prompt', model_identifier: 'model', connection_profile_identifier: 'profile', task_sampling_settings: {} };
  const result = analyzeSceneStabilityHistory([
    { ...shared, run_id: 'one', generated: 7, final_break_indices: [] },
    { ...shared, run_id: 'two', generated: 13, final_break_indices: [] },
    { ...shared, run_id: 'three', generated: 10, final_break_indices: [] },
  ], { ...shared, run_id: 'four', generated: 9, final_break_indices: [] });
  assert.deepEqual(result.scene_count_modes, [7, 9, 10, 13]);
  assert.equal(result.scene_count_mode, null);
  assert.equal(result.scene_count_mode_frequency, 1);
  assert.equal(result.scene_count_mode_is_unique, false);
});

test('shift clusters count distinct contributing runs, not duplicate observations', () => {
  const shared = { scene_detection_run_signature: 'sig', prompt_shape_hash: 'prompt', model_identifier: 'model', connection_profile_identifier: 'profile', task_sampling_settings: {} };
  const result = analyzeSceneStabilityHistory([
    { ...shared, run_id: 'one', generated: 2, final_break_indices: [48, 49] },
    { ...shared, run_id: 'two', generated: 2, final_break_indices: [50] },
  ], { ...shared, run_id: 'three', generated: 2, final_break_indices: [50] }, 2);
  const cluster = result.shifted_boundary_clusters.find((item) => item.member_indices.includes(48));
  assert.equal(cluster.observation_count, 4);
  assert.equal(cluster.distinct_run_count, 3);
  assert.deepEqual(cluster.runs_present, ['one', 'two', 'three']);
  assert.deepEqual(cluster.duplicate_observations_in_run, ['one']);
  assert.equal(result.clustered_stable_consensus_boundaries.length, 1);
  assert.equal(cluster.minimum_index, 48);
  assert.equal(cluster.maximum_index, 50);
  assert.deepEqual(result.clustered_consensus_transitions, result.clustered_stable_consensus_boundaries);
});

test('scene-count mode reports a unique winner and current-run accounting is explicit', () => {
  const shared = { scene_detection_run_signature: 'sig', prompt_shape_hash: 'prompt', model_identifier: 'model', connection_profile_identifier: 'profile', task_sampling_settings: {} };
  const result = analyzeSceneStabilityHistory([
    { ...shared, run_id: 'one', generated: 9, final_break_indices: Array(8).fill(0).map((_, index) => index) },
    { ...shared, run_id: 'two', generated: 10, final_break_indices: Array(9).fill(0).map((_, index) => index) },
    { ...shared, run_id: 'three', generated: 10, final_break_indices: Array(9).fill(0).map((_, index) => index) },
  ], { ...shared, run_id: 'four', generated: 11, final_break_indices: Array(10).fill(0).map((_, index) => index) });
  assert.deepEqual(result.scene_count_modes, [10]);
  assert.equal(result.scene_count_mode, 10);
  assert.equal(result.scene_count_mode_frequency, 2);
  assert.equal(result.scene_count_mode_is_unique, true);
  assert.equal(result.prior_comparable_run_count, 3);
  assert.equal(result.total_comparable_run_count, 4);
  assert.equal(result.current_run_included, true);
  assert.equal(result.current_run_id, 'four');
});

test('all-run candidate analysis separates AI, gate, and final-assembly variance', () => {
  const shared = { scene_detection_run_signature: 'sig', prompt_shape_hash: 'prompt', model_identifier: 'model', connection_profile_identifier: 'profile', task_sampling_settings: {}, final_break_indices: [] };
  const run = (run_id, candidates) => ({ ...shared, run_id, candidate_context_hashes: candidates.map((candidate) => ({ candidate_id: candidate.candidate_id, context_hash: 'same-context' })), candidate_dispositions: candidates });
  const result = analyzeSceneStabilityHistory([
    run('one', [
      { candidate_id: 10, decision: true, gate_result: 'accepted', terminal_break_disposition: 'accepted_final_break', gate_input_hash: 'a', gate_output_hash: 'a1' },
      { candidate_id: 20, decision: true, gate_result: 'rejected', terminal_break_disposition: 'rejected_deterministic_gate', gate_input_hash: 'b', gate_output_hash: 'b1' },
      { candidate_id: 30, decision: true, gate_result: 'accepted', terminal_break_disposition: 'accepted_final_break', gate_input_hash: 'c', gate_output_hash: 'c1' },
    ]),
  ], run('two', [
    { candidate_id: 10, decision: false, gate_result: 'not_requested', terminal_break_disposition: null, gate_input_hash: 'a2', gate_output_hash: 'a21' },
    { candidate_id: 20, decision: true, gate_result: 'accepted', terminal_break_disposition: 'accepted_final_break', gate_input_hash: 'b2', gate_output_hash: 'b21' },
    { candidate_id: 30, decision: true, gate_result: 'accepted', terminal_break_disposition: 'coalesced_with_nearby_boundary', gate_input_hash: 'c', gate_output_hash: 'c1' },
  ]));
  const byId = new Map(result.all_run_candidate_stability.map((candidate) => [candidate.candidate_id, candidate]));
  assert.equal(byId.get('10').classification, 'ai_marginal');
  assert.equal(byId.get('20').classification, 'gate_marginal');
  assert.equal(byId.get('30').classification, 'final_assembly_marginal');
  assert.equal(byId.get('30').gate_determinism_violation, false);
  assert.equal(result.gate_determinism_violation_count, 0);
  assert.deepEqual(result.gate_determinism_violations, []);
});

test('duplicate runtime records are removed before scene statistics and clustering', () => {
  const shared = { scene_detection_run_signature: 'sig', prompt_shape_hash: 'prompt', model_identifier: 'model', connection_profile_identifier: 'profile', task_sampling_settings: {}, candidate_dispositions: [], candidate_detail_available: false };
  const repeated = { ...shared, run_id: 'one', generated: 3, final_break_indices: [10, 20] };
  const result = analyzeSceneStabilityHistory([
    repeated,
    { ...repeated },
    { ...shared, run_id: 'two', generated: 3, final_break_indices: [10, 22] },
  ], { ...shared, run_id: 'three', generated: 3, final_break_indices: [10, 22] }, 2);
  assert.equal(result.scene_run_input_accounting.duplicate_run_records_removed, 1);
  assert.equal(result.scene_run_input_accounting.distinct_total_run_count, 3);
  assert.deepEqual(result.scene_run_input_accounting.duplicate_runtime_run_ids, ['one']);
  assert.equal(result.comparable_prior_run_count, 2);
  assert.deepEqual(result.retained_prior_run_ids, ['one', 'two']);
  assert.equal(result.exact_boundary_frequency_by_index[10], 3);
  assert.equal(result.shifted_boundary_clusters.find((cluster) => cluster.member_indices.includes(20)).distinct_run_count, 3);
  assert.equal(result.prior_summary_invalidated_by_duplicate_runs, false);
  assert.equal(result.input_maintenance_performed, true);
  assert.equal(result.scene_stability_summary_complete, false);
});

test('canonical comparable runs drive all retained IDs and candidate coverage after duplicate maintenance', () => {
  const shared = { scene_detection_run_signature: 'sig', prompt_shape_hash: 'prompt', model_identifier: 'model', connection_profile_identifier: 'profile', task_sampling_settings: {}, candidate_detail_available: true, final_break_indices: [10] };
  const candidates = Array.from({ length: 3 }, (_, index) => ({ candidate_id: index + 1, decision: false, gate_input_hash: `gate-${index}`, gate_result: 'rejected' }));
  const run = (run_id) => ({ ...shared, run_id, generated: 2, candidate_dispositions: candidates });
  const result = analyzeSceneStabilityHistory([run('run-a'), run('run-b'), run('run-c'), run('run-c')], run('current'));
  assert.equal(result.prior_comparable_run_count, 3);
  assert.equal(result.total_comparable_run_count, 4);
  assert.deepEqual(result.retained_prior_run_ids, ['run-a', 'run-b', 'run-c']);
  assert.equal(new Set(result.retained_prior_run_ids).size, 3);
  assert.equal(result.comparable_runs.filter((entry) => !entry.current_run).length, result.prior_comparable_run_count);
  assert.equal(result.candidate_history_coverage.candidate_records_expected, 12);
  assert.equal(result.candidate_history_coverage.candidate_records_available, 12);
  assert.equal(result.candidate_history_coverage.candidate_records_missing, 0);
  assert.equal(result.candidate_history_coverage.coverage_ratio, 1);
  assert.equal(result.input_maintenance_performed, true);
  assert.equal(result.scene_stability_summary_complete, true);
});

test('gate determinism terminal skip reasons are exclusive while secondary observations can overlap', () => {
  const shared = { scene_detection_run_signature: 'sig', prompt_shape_hash: 'prompt', model_identifier: 'model', connection_profile_identifier: 'profile', task_sampling_settings: {}, final_break_indices: [], candidate_detail_available: true };
  const result = analyzeSceneStabilityHistory([
    { ...shared, run_id: 'one', candidate_dispositions: [{ candidate_id: 1, decision: true }, { candidate_id: 2, decision: true, gate_input_hash: 'same' }, { candidate_id: 3, decision: true, gate_input_hash: 'a' }] },
  ], { ...shared, run_id: 'two', candidate_dispositions: [{ candidate_id: 1, decision: true }, { candidate_id: 2, decision: false, gate_input_hash: 'same' }, { candidate_id: 3, decision: true, gate_input_hash: 'b' }] });
  const coverage = result.gate_determinism_coverage;
  const skippedByReason = Object.values(coverage.terminal_skip_reasons).reduce((sum, count) => sum + count, 0);
  assert.equal(coverage.skip_reason_counts_are_exclusive, true);
  assert.equal(coverage.comparisons_attempted, coverage.comparisons_completed + coverage.comparisons_skipped);
  assert.equal(coverage.comparisons_skipped, skippedByReason);
  assert.ok(coverage.secondary_ineligibility_observations.ai_decision_mismatch >= 1);
});

test('exact duplicate boundaries are normalized while nearby boundaries remain distinct', () => {
  const shared = { scene_detection_run_signature: 'sig', prompt_shape_hash: 'prompt', model_identifier: 'model', connection_profile_identifier: 'profile', task_sampling_settings: {}, candidate_dispositions: [], candidate_detail_available: false };
  const result = analyzeSceneStabilityHistory([
    { ...shared, run_id: 'one', generated: 4, final_break_indices: [10, 20, 20, 48] },
  ], { ...shared, run_id: 'two', generated: 4, final_break_indices: [10, 20, 48] });
  const normalized = result.run_boundary_normalization.find((run) => run.run_id === 'one');
  assert.equal(normalized.raw_boundary_count, 4);
  assert.equal(normalized.normalized_boundary_count, 3);
  assert.deepEqual(normalized.duplicate_boundary_indices_removed, [20]);
  assert.equal(result.exact_boundary_frequency_by_index[20], 2);
});

test('missing candidate snapshots leave variance and gate determinism explicitly incomplete', () => {
  const shared = { scene_detection_run_signature: 'sig', prompt_shape_hash: 'prompt', model_identifier: 'model', connection_profile_identifier: 'profile', task_sampling_settings: {}, final_break_indices: [] };
  const result = analyzeSceneStabilityHistory([
    { ...shared, run_id: 'legacy', candidate_detail_available: false },
  ], { ...shared, run_id: 'current', candidate_detail_available: true, candidate_dispositions: [{ candidate_id: 1, decision: false }] });
  assert.equal(result.candidate_variance_analysis_complete, false);
  assert.equal(result.scene_variance_sources, null);
  assert.equal(result.gate_determinism_coverage.result_conclusive, false);
  assert.deepEqual(result.scene_stability_incomplete_reasons, ['missing_candidate_history']);
});

test('compact snapshots verify gate determinism from retained result fields', () => {
  const shared = { scene_detection_run_signature: 'sig', prompt_shape_hash: 'prompt', model_identifier: 'model', connection_profile_identifier: 'profile', task_sampling_settings: {}, final_break_indices: [], candidate_detail_available: true };
  const result = analyzeSceneStabilityHistory([
    { ...shared, run_id: 'one', candidate_dispositions: [{ candidate_id: 1, decision: true, gate_input_hash: 'same', gate_result: 'accepted', gate_reason_code: 'accepted_combined_change', terminal_break_disposition: 'accepted_final_break' }] },
  ], { ...shared, run_id: 'two', candidate_dispositions: [{ candidate_id: 1, decision: true, gate_input_hash: 'same', gate_result: 'rejected', gate_reason_code: 'same_continuous_interaction', terminal_break_disposition: 'rejected_deterministic_gate' }] });
  assert.equal(result.gate_determinism_coverage.comparisons_completed, 1);
  assert.equal(result.gate_determinism_coverage.result_conclusive, true);
  assert.equal(result.gate_determinism_violation_count, 1);
});

test('gate output migration excludes incomplete legacy values from impossible violations', () => {
  const shared = { scene_detection_run_signature: 'sig', prompt_shape_hash: 'prompt', model_identifier: 'model', connection_profile_identifier: 'profile', task_sampling_settings: {}, final_break_indices: [], candidate_detail_available: true };
  const incomplete = Array.from({ length: 41 }, (_, index) => ({ candidate_id: index, decision: true, gate_input_hash: `legacy-${index}`, gate_output_hash: `opaque-${index}` }));
  const complete = [{ candidate_id: 99, decision: true, gate_input_hash: 'same', gate_result: 'accepted', gate_reason_code: 'accepted_combined_change', terminal_break_disposition: 'accepted_final_break' }];
  const result = analyzeSceneStabilityHistory([{ ...shared, run_id: 'one', candidate_dispositions: [...incomplete, ...complete] }], { ...shared, run_id: 'two', candidate_dispositions: [...incomplete, ...complete] });
  const coverage = result.gate_determinism_coverage;
  assert.equal(coverage.comparisons_attempted, coverage.comparisons_completed + coverage.comparisons_skipped);
  assert.ok(coverage.violations_found <= coverage.comparisons_completed);
  assert.equal(coverage.violations_found, 0);
  assert.equal(coverage.terminal_skip_reasons.skipped_incompatible_legacy_gate_output, 41);
  assert.equal(coverage.result_broadly_representative, false);
});

test('canonical gate migration normalizes structured records and refuses opaque legacy hashes', () => {
  const current = canonicalizeGateOutput({ gate_output_schema_version: 1, gate_result: 'accepted', gate_reason_code: 'accepted_combined_change', terminal_break_disposition: 'accepted_final_break' });
  const migrated = canonicalizeGateOutput({ gate_result: 'accepted', gate_reason_code: 'accepted_combined_change', terminal_break_disposition: 'accepted_final_break' });
  const opaque = canonicalizeGateOutput({ gate_output_hash: 'legacy-hash' });
  assert.equal(current.classification, 'comparable_canonical_output');
  assert.equal(migrated.classification, 'migrated_legacy_output');
  assert.equal(current.canonical_gate_output_hash, migrated.canonical_gate_output_hash);
  assert.equal(opaque.classification, 'legacy_output_incomplete');
  assert.equal(opaque.canonical_gate_output_hash, null);
});
