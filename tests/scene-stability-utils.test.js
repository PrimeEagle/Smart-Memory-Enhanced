import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSceneBoundaryRuns } from '../scene-stability-utils.js';

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
