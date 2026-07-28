/** Compare bounded, text-free scene-boundary diagnostics from two equivalent runs. */
export function compareSceneBoundaryRuns(previous, currentAudit = {}, tolerance = 2) {
  const currentIndices = currentAudit.final_break_indices ?? [];
  const currentSceneCount = currentAudit.generated ?? null;
  if (!previous) return { compared_to_prior: false, comparison_tolerance_messages: tolerance, breaks_added: currentIndices.length, breaks_removed: 0, breaks_shifted: 0, unchanged_breaks: 0, unchanged_boundaries: [], shifted_boundaries: [], added_boundaries: currentIndices, removed_boundaries: [], scene_count_stable: null, boundary_positions_exactly_stable: false, boundary_positions_materially_stable: false, decision_pipeline_stable: null, marginal_boundary_comparison: [] };
  const remainingPrevious = new Set(previous.final_break_indices ?? []);
  const unchanged = [];
  const added = [];
  for (const index of currentIndices) {
    if (remainingPrevious.delete(index)) unchanged.push(index);
    else added.push(index);
  }
  const shifted = [];
  const unmatchedAdded = [];
  for (const index of added) {
    const nearby = [...remainingPrevious].filter((prior) => Math.abs(prior - index) <= tolerance).sort((a, b) => Math.abs(a - index) - Math.abs(b - index) || a - b)[0];
    if (nearby === undefined) unmatchedAdded.push(index);
    else { remainingPrevious.delete(nearby); shifted.push({ previous_index: nearby, current_index: index, offset: index - nearby }); }
  }
  const previousDispositions = new Map((previous.candidate_dispositions ?? []).map((item) => [item.message_index ?? item.candidate_id, item]));
  const currentDispositions = new Map((currentAudit.candidate_dispositions ?? []).map((item) => [item.message_index ?? item.candidate_id, item]));
  const previousContextHashes = new Map((previous.candidate_context_hashes ?? []).map((item) => [item.candidate_id, item.context_hash]));
  const currentContextHashes = new Map((currentAudit.candidate_context_hashes ?? []).map((item) => [item.candidate_id, item.context_hash]));
  const marginalRecord = (previousIndex, currentIndex, classification) => {
    const prior = previousDispositions.get(previousIndex);
    const current = currentDispositions.get(currentIndex);
    return {
      classification,
      candidate_id: current?.candidate_id ?? prior?.candidate_id ?? currentIndex ?? previousIndex,
      message_index: currentIndex ?? previousIndex,
      previous_message_index: previousIndex,
      current_message_index: currentIndex,
      previous_ai_decision: prior?.decision ?? null,
      current_ai_decision: current?.decision ?? null,
      previous_ai_confidence: prior?.ai_confidence ?? null,
      current_ai_confidence: current?.ai_confidence ?? null,
      previous_gate_result: prior?.gate_result ?? null,
      current_gate_result: current?.gate_result ?? null,
      previous_gate_reason: prior?.gate_reason_code ?? null,
      current_gate_reason: current?.gate_reason_code ?? null,
      previous_terminal_break_disposition: prior?.terminal_break_disposition ?? null,
      current_terminal_break_disposition: current?.terminal_break_disposition ?? null,
      // For shifted boundaries, compare each candidate to itself across runs;
      // comparing previous index 70 directly to current index 72 is not a
      // stability signal because they represent different candidate windows.
      previous_candidate_context_stable_across_runs: previousIndex !== null
        && previousContextHashes.has(previousIndex)
        && currentContextHashes.has(previousIndex)
        && previousContextHashes.get(previousIndex) === currentContextHashes.get(previousIndex),
      current_candidate_context_stable_across_runs: currentIndex !== null
        && previousContextHashes.has(currentIndex)
        && currentContextHashes.has(currentIndex)
        && previousContextHashes.get(currentIndex) === currentContextHashes.get(currentIndex),
      previous_candidate_prompt_stable_across_runs: previousIndex !== null && previous.prompt_shape_hash === currentAudit.prompt_shape_hash,
      current_candidate_prompt_stable_across_runs: currentIndex !== null && previous.prompt_shape_hash === currentAudit.prompt_shape_hash,
      cross_candidate_context_equal: previousIndex !== null && currentIndex !== null
        && previousContextHashes.has(previousIndex) && currentContextHashes.has(currentIndex)
        && previousContextHashes.get(previousIndex) === currentContextHashes.get(currentIndex),
      prompt_hash_equal: previous.prompt_shape_hash === currentAudit.prompt_shape_hash,
      model_equal: previous.model_identifier === currentAudit.model_identifier && previous.connection_profile_identifier === currentAudit.connection_profile_identifier,
      settings_equal: JSON.stringify(previous.task_sampling_settings ?? {}) === JSON.stringify(currentAudit.task_sampling_settings ?? {}),
    };
  };
  return {
    compared_to_prior: true,
    comparison_tolerance_messages: tolerance,
    breaks_added: unmatchedAdded.length,
    breaks_removed: remainingPrevious.size,
    breaks_shifted: shifted.length,
    unchanged_breaks: unchanged.length,
    unchanged_boundaries: unchanged,
    shifted_boundaries: shifted,
    added_boundaries: unmatchedAdded,
    removed_boundaries: [...remainingPrevious],
    scene_count_stable: Number.isInteger(currentSceneCount) && Number.isInteger(previous.generated) ? currentSceneCount === previous.generated : null,
    boundary_positions_exactly_stable: !shifted.length && !unmatchedAdded.length && !remainingPrevious.size,
    boundary_positions_materially_stable: !unmatchedAdded.length && !remainingPrevious.size,
    decision_pipeline_stable: (previous.malformed_batches ?? 0) === 0
      && (previous.fallback_boundaries ?? previous.heuristic_fallback_candidates ?? 0) === 0
      && (currentAudit.malformed_batches ?? 0) === 0
      && (currentAudit.fallback_boundaries ?? currentAudit.heuristic_fallback_candidates ?? 0) === 0
      && previous.prompt_shape_hash === currentAudit.prompt_shape_hash
      && previous.model_identifier === currentAudit.model_identifier
      && previous.connection_profile_identifier === currentAudit.connection_profile_identifier
      && JSON.stringify(previous.task_sampling_settings ?? {}) === JSON.stringify(currentAudit.task_sampling_settings ?? {}),
    marginal_boundary_comparison: [
      ...shifted.map((shift) => ({ ...marginalRecord(shift.previous_index, shift.current_index, 'shifted'), offset: shift.offset })),
      ...unmatchedAdded.map((index) => marginalRecord(null, index, 'added')),
      ...[...remainingPrevious].map((index) => marginalRecord(index, null, 'removed')),
    ],
  };
}

/** Analyze every retained run that is comparable to the current scene pass. */
export function analyzeSceneStabilityHistory(runs = [], currentAudit = {}, tolerance = 2) {
 const compatible = [...runs, currentAudit].filter((run) => run
 && (run.run_signature ?? run.scene_detection_run_signature) === currentAudit.scene_detection_run_signature
 && run.prompt_shape_hash === currentAudit.prompt_shape_hash
 && run.model_identifier === currentAudit.model_identifier
 && run.connection_profile_identifier === currentAudit.connection_profile_identifier
 && JSON.stringify(run.task_sampling_settings ?? {}) === JSON.stringify(currentAudit.task_sampling_settings ?? {}));
 const counts = compatible.map((run) => Number(run.scene_count ?? run.generated ?? 0));
 const frequency = new Map();
 for (const run of compatible) for (const index of new Set(run.final_break_indices ?? [])) frequency.set(index, (frequency.get(index) ?? 0) + 1);
 const entries = [...frequency.entries()].sort((a, b) => a[0] - b[0]);
 const runCount = compatible.length;
 const boundaries = (predicate) => entries.filter(([, count]) => predicate(count)).map(([index]) => index);
 const clusters = [];
 for (const [index, count] of entries) {
 const cluster = clusters.find((item) => index - item.member_indices.at(-1) <= tolerance);
 if (cluster) { cluster.member_indices.push(index); cluster.frequency += count; cluster.maximum_offset = cluster.member_indices.at(-1) - cluster.member_indices[0]; }
 else clusters.push({ cluster_id: `shift-${clusters.length + 1}`, member_indices: [index], representative_index: index, frequency: count, run_presence: count, maximum_offset: 0 });
 }
 const mode = counts.length ? [...new Set(counts)].sort((a, b) => counts.filter((x) => x === b).length - counts.filter((x) => x === a).length || a - b)[0] : null;
 const pipelinesStable = compatible.every((run) => !(run.malformed_batches ?? 0) && !(run.fallback_boundaries ?? run.heuristic_fallback_candidates ?? 0));
 return {
 comparable_run_count: runCount,
 retained_run_ids: compatible.map((run) => run.run_id ?? null), retained_created_at: compatible.map((run) => run.created_at ?? run.completed_at ?? null),
 scene_counts: counts, boundary_counts: compatible.map((run) => (run.final_break_indices ?? []).length), scene_count_mode: mode,
 scene_count_min: counts.length ? Math.min(...counts) : null, scene_count_max: counts.length ? Math.max(...counts) : null,
 scene_count_range: counts.length ? Math.max(...counts) - Math.min(...counts) : null,
 boundary_frequency_by_index: Object.fromEntries(entries), stable_consensus_boundaries: boundaries((count) => count === runCount),
 majority_boundaries: boundaries((count) => count > runCount / 2), marginal_boundaries: boundaries((count) => count > 0 && count <= runCount / 2),
 one_off_boundaries: boundaries((count) => count === 1), shifted_boundary_clusters: clusters.filter((cluster) => cluster.member_indices.length > 1),
 pipeline_stable: pipelinesStable, scene_count_exactly_stable: new Set(counts).size <= 1,
 scene_count_materially_stable: counts.length ? Math.max(...counts) - Math.min(...counts) <= 1 : false,
 boundary_positions_exactly_stable: entries.every(([, count]) => count === runCount),
  boundary_positions_materially_stable: entries.every(([index, count]) => count === runCount
    || clusters.some((cluster) => cluster.member_indices.length > 1 && cluster.member_indices.includes(index))),
 decision_pipeline_stable: pipelinesStable,
 };
}
