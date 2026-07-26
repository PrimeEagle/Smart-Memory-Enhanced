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
      context_hash_equal: previousIndex !== null && currentIndex !== null && previousContextHashes.get(previousIndex) === currentContextHashes.get(currentIndex),
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
