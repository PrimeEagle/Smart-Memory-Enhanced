/**
 * Pure deterministic scene-boundary gate.
 *
 * It receives only stable, message-derived inputs. Provider confidence,
 * request lineage, and mutable extension state are deliberately excluded so
 * identical terminal decisions always receive identical gate outcomes.
 */
export function evaluateDeterministicSceneGate({ aiRequestedBreak, heuristicBreak, sceneLength, minimumSceneLength, messageIndex, previousBoundaryIndex }) {
  // Fingerprints intentionally include only the deterministic, text-free gate
  // inputs. They let diagnostics prove repeatability without persisting chat
  // content, provider data, or request lineage.
  const fingerprint = (value) => {
    const serialized = JSON.stringify(value);
    let hash = 2166136261;
    for (let index = 0; index < serialized.length; index++) hash = Math.imul(hash ^ serialized.charCodeAt(index), 16777619);
    return `scene-gate-${(hash >>> 0).toString(16)}`;
  };
  const distance = Number.isInteger(previousBoundaryIndex) ? messageIndex - previousBoundaryIndex : null;
  const signals = {
    time_change_detected: Boolean(heuristicBreak),
    location_change_detected: false,
    participant_change_detected: false,
    activity_change_detected: Boolean(heuristicBreak),
    channel_change_detected: false,
    narrative_phase_change_detected: Boolean(heuristicBreak),
    explicit_scene_transition_detected: Boolean(heuristicBreak),
    same_continuous_interaction: !heuristicBreak,
    emotional_shift_only: false,
    continuity_overlap_score: heuristicBreak ? 0 : 1,
    estimated_left_scene_length: sceneLength,
    estimated_right_scene_length: null,
    minimum_scene_length_satisfied: sceneLength >= minimumSceneLength,
  };
  const gateInputHash = fingerprint({ aiRequestedBreak: Boolean(aiRequestedBreak), heuristicBreak: Boolean(heuristicBreak), sceneLength, minimumSceneLength, messageIndex, previousBoundaryIndex: previousBoundaryIndex ?? null });
  const finish = (result) => ({ ...result, gate_input_hash: gateInputHash, gate_output_hash: fingerprint({ accepted: result.accepted, terminal_break_disposition: result.terminal_break_disposition, gate_result: result.gate_result, gate_reason_code: result.gate_reason_code, detected_change_types: result.detected_change_types, distance_from_previous_accepted_boundary: result.distance_from_previous_accepted_boundary, gate_evidence: result.gate_evidence }) });
  if (!aiRequestedBreak) return finish({ accepted: false, terminal_break_disposition: null, gate_result: 'not_requested', gate_reason_code: null, detected_change_types: [], distance_from_previous_accepted_boundary: distance, gate_evidence: signals });
  if (!heuristicBreak) return finish({ accepted: false, terminal_break_disposition: 'rejected_deterministic_gate', gate_result: 'rejected', gate_reason_code: 'same_continuous_interaction', detected_change_types: [], distance_from_previous_accepted_boundary: distance, gate_evidence: signals });
  if (sceneLength < minimumSceneLength) return finish({ accepted: false, terminal_break_disposition: 'rejected_minimum_scene_length', gate_result: 'rejected', gate_reason_code: 'minimum_scene_length', detected_change_types: ['heuristic_transition'], distance_from_previous_accepted_boundary: distance, gate_evidence: signals });
  return finish({ accepted: true, terminal_break_disposition: 'accepted_final_break', gate_result: 'accepted', gate_reason_code: 'accepted_combined_change', detected_change_types: ['time_change', 'activity_change', 'narrative_phase_change'], distance_from_previous_accepted_boundary: distance, gate_evidence: signals });
}
