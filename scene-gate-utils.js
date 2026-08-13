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
  // A timing phrase in dialogue ("what happens the next day?") is not a
  // scene reset. Evaluate the candidate message itself and ignore quoted
  // dialogue, while retaining ordinary narrative/action openings.
  const narrativeActionOpening = /^\s*\*\s*(?:(?:i\s+)?(?:go|went|head|headed|walk|walked|arriv|return|left|leave|wake|woke|fell|drift|doz)|i\s+(?:make|schedule|spend|stay|work|start))/i.test(current);
  const markedDialogue = /^\s*\*\s*(?:[\u201c\u201d\u2018\u2019"']\s*)?(?:you(?:'re| are|\b)|i(?:'m| am|\b)|we(?:'re| are|\b)|he(?:'s| is|\b)|she(?:'s| is|\b)|they(?:'re| are|\b)|yes\b|no\b|okay\b|ok\b|but\b|and\b|because\b)/i.test(current);
  const dialogueLikeCurrent = (/^[\s\u201c\u201d\u2018\u2019"']/.test(current) && !/^\s*\*/.test(current)) || (markedDialogue && !narrativeActionOpening);
  const narrativeTimeOpening = /^\s*(?:\*\s*)?(?:the next (?:morning|day|evening|few days)|hours? later|days? later|meanwhile|elsewhere|after (?:a|several) hours?|the following day)\b/i.test(current);
  const narrativeTravelOrWakeOpening = /^\s*(?:\*\s*)?(?:(?:[A-Z][a-z]+\s+)?(?:arrived at|returned to|left for|woke up)|(?:[A-Z][a-z]+\s+)?woke\b)/.test(current);
  const priorSleepClosure = /\b(?:go(?:es|ing)? to sleep|went to sleep|fell asleep|drifted off|dozed off|go(?:es|ing)? to bed|went to bed)\b/i.test(previous);
  const currentSleepClosure = /\b(?:go(?:es|ing)? to sleep|went to sleep|fell asleep|drifted off|dozed off|go(?:es|ing)? to bed|went to bed)\b/i.test(current);
  const narrativeEmbeddedTime = !dialogueLikeCurrent && (narrativeActionOpening || (!/^\s*\*/.test(current) && !/[\u201c\u201d\u2018\u2019"']/.test(current)))
    && /\b(?:the next (?:morning|day|evening|few days)|hours? later|days? later|some time later|that night|the following day)\b/i.test(current);
  const explicitTransition = !dialogueLikeCurrent && (narrativeTimeOpening || narrativeEmbeddedTime || narrativeTravelOrWakeOpening || priorSleepClosure || currentSleepClosure);
  // A bounded narrative opening can establish a fresh setting without a
  // literal "later" marker. It must be anchored at the current message and
  // name a concrete environment, so ordinary topic/action changes never
  // become transition support by themselves.
  const narrativeContextOpening = /^\s*(?:\*\s*)?(?:(?:inside|outside|back at|across town|at|in)\s+(?:the|a|an)\s+(?:house|home|apartment|room|bedroom|office|bar|restaurant|cafe|street|park|hospital|hotel|car|kitchen|garden|porch|driveway|store|supermarket|library|school|gym|lobby|hallway|beach)\b|(?:the|a|an)\s+(?:house|home|apartment|room|bedroom|office|bar|restaurant|cafe|street|park|hospital|hotel|car|kitchen|garden|porch|driveway|store|supermarket|library|school|gym|lobby|hallway|beach)(?:\s+\w+){0,2}\s+(?:was|is|felt|looked|lay|stood)\b)/i.test(current);
  const completedPriorInteraction = /\b(?:said goodbye|said goodnight|ended (?:the )?(?:call|conversation|text exchange)|hung up|parted ways)\b/i.test(previous);
  const sameChannel = /\b(?:phone|call|text(?:ing|ed)?|message(?:d)?|chat(?:ting)?|on the line)\b/.test(previous)
    && /\b(?:phone|call|text(?:ing|ed)?|message(?:d)?|chat(?:ting)?|on the line|he said|she said|they said)\b/.test(current);
  const directResponse = /^(?:["'“”‘’\-–—\s]*(?:yes|no|okay|ok|but|and|because|i|you|we|he|she|they|that|this|then)\b)/i.test(current);
  const directTextReply = /^\s*(?:text|message)(?:\s+(?:him|her|them|back))?\s*:/i.test(current);
  const markupWrappedReply = /^\s*\*\s*(?:yes|no|okay|ok|but|and|because|i|you|we|he|she|they|that|this|then)\b/i.test(current);
  // Dialogue often starts with a speaker attribution rather than the reply
  // itself (for example, "Ava replied, \"No.\"").  Treat that immediate
  // form as continuity too, while an explicit reset still wins below.
  const attributedReply = /^\s*(?:\*\s*)?(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s+)?(?:said|replied|answered|texted|messaged|whispered)\b/i.test(current);
  const emotionalOrReactive = /\b(?:smiled|laughed|cried|sighed|nodded|shook|hugged|kissed|flinched|stared|whispered|replied|answered)\b/i.test(current);
  const strongContinuity = !explicitTransition && !narrativeContextOpening && (sameChannel || directResponse || directTextReply || markupWrappedReply || attributedReply || emotionalOrReactive);
  const stronglyImpliedTransition = !strongContinuity && narrativeContextOpening;
  return {
    explicit_transition: explicitTransition,
    same_channel: sameChannel,
    direct_response: directResponse,
    attributed_reply: attributedReply,
    emotional_or_reactive: emotionalOrReactive,
    strong_continuity: strongContinuity,
    strongly_implied_transition: stronglyImpliedTransition,
    transition_evidence_groups: [
      ...(explicitTransition ? [{
      evidence_group_id: 'explicit_transition',
      source_fingerprint: 'message_explicit_transition',
      detector_codes: ['explicit_scene_transition_detected'],
      strength: 'strong',
      independent: true,
      }] : []),
      ...(stronglyImpliedTransition ? [{
        evidence_group_id: 'narrative_context_reset',
        source_fingerprint: completedPriorInteraction ? 'completed_interaction_then_new_context' : 'anchored_new_context_opening',
        detector_codes: ['narrative_context_reset'],
        strength: 'strong',
        independent: true,
      }] : []),
    ],
  };
}

/**
 * Deterministically coalesce only a genuinely nearby continuation after a
 * retained boundary.  This is intentionally narrower than clustering for
 * diagnostics: independent rapid transitions and any explicit transition
 * remain separate final boundaries.
 */
/**
 * A closing line can be proposed as a boundary while the following message
 * actually opens the new scene. Preserve the proposal, but align
 * `before_message` to the first grounded transition-opening message.
 */
export function shouldDeferSceneBoundaryToNextMessage(currentMessage = '', nextMessage = '') {
  const closingInteraction = /\b(?:good ?night|goodbye|call ended|hung up|ended (?:the )?(?:call|conversation|text exchange)|parted ways)\b/i.test(String(currentMessage ?? ''));
  const nextSignals = deriveSceneContinuitySignals(currentMessage, nextMessage);
  return closingInteraction && nextSignals.explicit_transition === true && nextSignals.strong_continuity !== true;
}

/**
 * Applies the catch-up boundary contract without mutating the buffer. A
 * boundary is always "before_message": the accumulated messages complete
 * the old scene and `currentMessage` becomes the first message of the new
 * one. Keeping this tiny operation pure makes the source-index contract
 * independently testable.
 */
export function advanceSceneBufferAtBoundary(sceneBuffer = [], currentMessage, isBoundary = false) {
  const accumulated = Array.isArray(sceneBuffer) ? sceneBuffer : [];
  if (!isBoundary) return { completed_messages: null, next_buffer: [...accumulated, currentMessage] };
  return { completed_messages: [...accumulated], next_buffer: [currentMessage] };
}

/**
 * Create a privacy-safe, deterministic state delta for a candidate boundary.
 * It is diagnostic evidence only: the gate remains the sole decision-maker.
 * Raw prose, names, and locations are deliberately not retained.
 */
export function deriveSceneCandidateStateDelta(previousMessage = '', currentMessage = '') {
  const previous = String(previousMessage ?? '').trim();
  const current = String(currentMessage ?? '').trim();
  const signals = deriveSceneContinuitySignals(previous, current);
  const hash = (value) => {
    let valueHash = 2166136261;
    for (const character of String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()) valueHash = Math.imul(valueHash ^ character.charCodeAt(0), 16777619);
    return `scene-state-${(valueHash >>> 0).toString(16)}`;
  };
  const locationCategory = (text) => {
    const match = String(text ?? '').match(/\b(?:at|in|inside|outside|back at|across town|to)\s+(?:the|a|an|my|his|her|their)?\s*([a-z]+(?:\s+[a-z]+)?)/i);
    return match ? hash(match[1]) : null;
  };
  const channelCategory = (text) => /\b(?:text(?:ing|ed)?|message(?:d)?|phone|call|on the line)\b/i.test(text)
    ? (/\b(?:phone|call|on the line)\b/i.test(text) ? 'call' : 'text')
    : 'in_person_or_narration';
  const participantFingerprint = (text) => {
    const names = [...new Set((String(text ?? '').match(/\b[A-Z][a-z]{2,}\b/g) ?? [])
      .filter((word) => !['The', 'Then', 'That', 'This', 'When', 'But', 'And'].includes(word))
      .map((word) => word.toLowerCase()))].sort();
    return names.length ? hash(names.join('|')) : null;
  };
  const previousLocation = locationCategory(previous);
  const currentLocation = locationCategory(current);
  const previousParticipants = participantFingerprint(previous);
  const currentParticipants = participantFingerprint(current);
  const locationChanged = Boolean(previousLocation && currentLocation && previousLocation !== currentLocation)
    || Boolean(signals.strongly_implied_transition && currentLocation);
  const channelChanged = channelCategory(previous) !== channelCategory(current);
  const participantSetChanged = Boolean(previousParticipants && currentParticipants && previousParticipants !== currentParticipants);
  const interactionReset = /\b(?:said goodbye|said goodnight|ended (?:the )?(?:call|conversation|text exchange)|hung up|parted ways|went home|go(?:es|ing)? home)\b/i.test(previous);
  const transitionSupportType = signals.explicit_transition ? 'explicit'
    : signals.strongly_implied_transition ? 'strongly_implied'
      : 'none';
  return {
    prior_state_fingerprint: hash(previous),
    next_state_fingerprint: hash(current),
    location_changed: locationChanged,
    channel_changed: channelChanged,
    participant_set_changed: participantSetChanged,
    meaningful_time_changed: signals.explicit_transition,
    interaction_reset: interactionReset,
    new_setting_opening: signals.strongly_implied_transition,
    continuity_strength: signals.strong_continuity ? 'strong' : 'none',
    transition_support_type: transitionSupportType,
  };
}

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
  const evidenceGroups = [
    ...(continuity?.transition_evidence_groups ?? []),
    ...(heuristicBreak && !continuity?.explicit_transition ? [{
      evidence_group_id: 'heuristic_transition',
      source_fingerprint: 'heuristic_candidate',
      detector_codes: ['heuristic_transition'],
      strength: 'weak',
      independent: false,
    }] : []),
  ];
  const uniqueEvidenceGroups = evidenceGroups.filter((group, index, all) =>
    all.findIndex((candidate) => candidate.evidence_group_id === group.evidence_group_id && candidate.source_fingerprint === group.source_fingerprint) === index);
  const credibleIndependentTransitionSupport = uniqueEvidenceGroups
    .some((group) => group?.independent === true && group?.strength === 'strong');
  const signals = {
    time_change_detected: Boolean(continuity?.explicit_transition),
    location_change_detected: false,
    participant_change_detected: false,
    activity_change_detected: false,
    channel_change_detected: false,
    narrative_phase_change_detected: false,
    explicit_scene_transition_detected: Boolean(continuity?.explicit_transition),
    transition_evidence_groups: uniqueEvidenceGroups,
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
  if (continuity?.strong_continuity && !continuity?.explicit_transition) return finish({ accepted: false, terminal_break_disposition: 'rejected_deterministic_gate', gate_result: 'rejected', gate_reason_code: 'strong_continuity_veto', detected_change_types: [], distance_from_previous_accepted_boundary: distance, gate_evidence: signals });
  if (sceneLength < minimumSceneLength) return finish({ accepted: false, terminal_break_disposition: 'rejected_minimum_scene_length', gate_result: 'rejected', gate_reason_code: 'minimum_scene_length', detected_change_types: ['heuristic_transition'], distance_from_previous_accepted_boundary: distance, gate_evidence: signals });
  if (!credibleIndependentTransitionSupport) return finish({ accepted: false, terminal_break_disposition: 'rejected_deterministic_gate', gate_result: 'rejected', gate_reason_code: 'missing_independent_transition_evidence', detected_change_types: [], distance_from_previous_accepted_boundary: distance, gate_evidence: signals });
  return finish({ accepted: true, terminal_break_disposition: 'accepted_final_break', gate_result: 'accepted', gate_reason_code: 'accepted_combined_change', detected_change_types: uniqueEvidenceGroups.map((group) => group.evidence_group_id), distance_from_previous_accepted_boundary: distance, gate_evidence: signals });
}
