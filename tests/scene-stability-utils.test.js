import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSceneStabilityHistory, compareSceneBoundaryRuns } from '../scene-stability-utils.js';

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
  assert.equal(result.scene_count_range, 1);
  assert.equal(result.scene_count_materially_stable, true);
  assert.ok(result.shifted_boundary_clusters.some((cluster) => cluster.member_indices.includes(48) && cluster.member_indices.includes(50)));
});
