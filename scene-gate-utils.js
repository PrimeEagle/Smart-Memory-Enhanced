/**
 * Pure deterministic scene-boundary gate.
 *
 * It receives only stable, message-derived inputs. Provider confidence,
 * request lineage, and mutable extension state are deliberately excluded so
 * identical terminal decisions always receive identical gate outcomes.
 */
export function evaluateDeterministicSceneGate({ aiRequestedBreak, heuristicBreak, sceneLength, minimumSceneLength, messageIndex, previousBoundaryIndex }) {
  const distance = Number.isInteger(previousBoundaryIndex) ? messageIndex - previousBoundaryIndex : null;
  const signals = {
    time_change_detected: Boolean(heuristicBreak),
    location_change_detected: false,
    participant_change_detected: false,
    activity_change_detected: Boolean(heuristicBreak),
    channel_change_detected: false,
    narrative_phase_change_detected: Boolean(heuristicBreak),
    continuity_overlap_score: heuristicBreak ? 0 : 1,
  };
  if (!aiRequestedBreak) return { accepted: false, terminal_break_disposition: null, gate_result: 'not_requested', gate_reason_code: null, detected_change_types: [], distance_from_previous_accepted_boundary: distance, gate_evidence: signals };
  if (!heuristicBreak) return { accepted: false, terminal_break_disposition: 'rejected_deterministic_gate', gate_result: 'rejected', gate_reason_code: 'insufficient_change_evidence', detected_change_types: [], distance_from_previous_accepted_boundary: distance, gate_evidence: signals };
  if (sceneLength < minimumSceneLength) return { accepted: false, terminal_break_disposition: 'rejected_minimum_scene_length', gate_result: 'rejected', gate_reason_code: 'minimum_scene_length', detected_change_types: ['heuristic_transition'], distance_from_previous_accepted_boundary: distance, gate_evidence: signals };
  return { accepted: true, terminal_break_disposition: 'accepted_final_break', gate_result: 'accepted', gate_reason_code: null, detected_change_types: ['heuristic_transition'], distance_from_previous_accepted_boundary: distance, gate_evidence: signals };
}
