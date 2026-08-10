/**
 * Pure deterministic scene-boundary gate.
 *
 * It receives only stable, message-derived inputs. Provider confidence,
 * request lineage, and mutable extension state are deliberately excluded so
 * identical terminal decisions always receive identical gate outcomes.
 */
export function deriveSceneContinuitySignals(previousMessage = '', currentMessage = '') {
  const previous = String(previousMessage ?? '').trim();
  const current = String(currentMessage ?? '').trim();
  const combined = `${previous}\n${current}`.toLowerCase();
  const explicitTransition = /\b(?:the next (?:morning|day|evening)|hours? later|days? later|meanwhile|elsewhere|after (?:a|several) hours?|the following day|arrived at|returned to|left for|woke up|fell asleep|go(?:es|ing)? to sleep|went to sleep)\b/.test(combined);
  const sameChannel = /\b(?:phone|call|text(?:ing|ed)?|message(?:d)?|chat(?:ting)?|on the line)\b/.test(previous)
    && /\b(?:phone|call|text(?:ing|ed)?|message(?:d)?|chat(?:ting)?|on the line|he said|she said|they said)\b/.test(current);
  const directResponse = /^(?:["'“”‘’\-–—\s]*(?:yes|no|okay|ok|but|and|because|i|you|we|he|she|they|that|this|then)\b)/i.test(current);
  const directTextReply = /^\s*(?:text|message)(?:\s+(?:him|her|them|back))?\s*:/i.test(current);
  const markupWrappedReply = /^\s*\*\s*(?:yes|no|okay|ok|but|and|because|i|you|we|he|she|they|that|this|then)\b/i.test(current);
  const emotionalOrReactive = /\b(?:smiled|laughed|cried|sighed|nodded|shook|hugged|kissed|flinched|stared|whispered|replied|answered)\b/i.test(current);
  const strongContinuity = !explicitTransition && (sameChannel || directResponse || directTextReply || markupWrappedReply || emotionalOrReactive);
  return {
    explicit_transition: explicitTransition,
    same_channel: sameChannel,
    direct_response: directResponse,
    emotional_or_reactive: emotionalOrReactive,
    strong_continuity: strongContinuity,
    transition_evidence_groups: explicitTransition ? ['explicit_transition'] : [],
  };
}

/**
 * Deterministically coalesce only a genuinely nearby continuation after a
 * retained boundary.  This is intentionally narrower than clustering for
 * diagnostics: independent rapid transitions and any explicit transition
 * remain separate final boundaries.
 */
export function coalesceSceneBoundary({ previousBoundaryIndex, messageIndex, minimumSceneLength, continuity = null }) {
  const distance = Number.isInteger(previousBoundaryIndex) && Number.isInteger(messageIndex)
    ? messageIndex - previousBoundaryIndex : null;
  const window = Math.max(2, Number(minimumSceneLength ?? 3) * 2);
  const suppress = Number.isInteger(distance)
    && distance > 0
    && distance <= window
    && continuity?.strong_continuity === true
    && continuity?.explicit_transition !== true;
  return {
    suppress,
    outcome: suppress ? 'direct_continuation' : 'independently_supported',
    distance_from_previous_boundary: distance,
    coalescing_window_messages: window,
  };
}

export function evaluateDeterministicSceneGate({ aiRequestedBreak, heuristicBreak, sceneLength, minimumSceneLength, messageIndex, previousBoundaryIndex, continuity = null }) {
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
  // A heuristic candidate is one observation, not four independent proofs.
  // Keep detector labels honest so diagnostics cannot inflate one phrase into
  // time, activity, narrative, and explicit-transition evidence at once.
  const evidenceGroups = [...new Set([
    ...(continuity?.transition_evidence_groups ?? []),
    ...(heuristicBreak && !continuity?.explicit_transition ? ['heuristic_transition'] : []),
  ])];
  const signals = {
    time_change_detected: Boolean(continuity?.explicit_transition),
    location_change_detected: false,
    participant_change_detected: false,
    activity_change_detected: false,
    channel_change_detected: false,
    narrative_phase_change_detected: false,
    explicit_scene_transition_detected: Boolean(continuity?.explicit_transition),
    transition_evidence_groups: evidenceGroups,
    same_continuous_interaction: continuity?.strong_continuity ?? !heuristicBreak,
    emotional_shift_only: Boolean(continuity?.emotional_or_reactive && !continuity?.explicit_transition),
    continuity_overlap_score: continuity?.strong_continuity ? 1 : heuristicBreak ? 0 : 1,
    estimated_left_scene_length: sceneLength,
    estimated_right_scene_length: null,
    minimum_scene_length_satisfied: sceneLength >= minimumSceneLength,
  };
  const gateInputHash = fingerprint({ aiRequestedBreak: Boolean(aiRequestedBreak), heuristicBreak: Boolean(heuristicBreak), sceneLength, minimumSceneLength, messageIndex, previousBoundaryIndex: previousBoundaryIndex ?? null, continuity });
  const finish = (result) => ({ ...result, gate_input_hash: gateInputHash, gate_output_hash: fingerprint({ accepted: result.accepted, terminal_break_disposition: result.terminal_break_disposition, gate_result: result.gate_result, gate_reason_code: result.gate_reason_code, detected_change_types: result.detected_change_types, distance_from_previous_accepted_boundary: result.distance_from_previous_accepted_boundary, gate_evidence: result.gate_evidence }) });
  if (!aiRequestedBreak) return finish({ accepted: false, terminal_break_disposition: null, gate_result: 'not_requested', gate_reason_code: null, detected_change_types: [], distance_from_previous_accepted_boundary: distance, gate_evidence: signals });
  if (!heuristicBreak) return finish({ accepted: false, terminal_break_disposition: 'rejected_deterministic_gate', gate_result: 'rejected', gate_reason_code: 'same_continuous_interaction', detected_change_types: [], distance_from_previous_accepted_boundary: distance, gate_evidence: signals });
  if (continuity?.strong_continuity && !continuity?.explicit_transition) return finish({ accepted: false, terminal_break_disposition: 'rejected_deterministic_gate', gate_result: 'rejected', gate_reason_code: 'strong_continuity_veto', detected_change_types: [], distance_from_previous_accepted_boundary: distance, gate_evidence: signals });
  if (sceneLength < minimumSceneLength) return finish({ accepted: false, terminal_break_disposition: 'rejected_minimum_scene_length', gate_result: 'rejected', gate_reason_code: 'minimum_scene_length', detected_change_types: ['heuristic_transition'], distance_from_previous_accepted_boundary: distance, gate_evidence: signals });
  return finish({ accepted: true, terminal_break_disposition: 'accepted_final_break', gate_result: 'accepted', gate_reason_code: 'accepted_combined_change', detected_change_types: evidenceGroups, distance_from_previous_accepted_boundary: distance, gate_evidence: signals });
}
