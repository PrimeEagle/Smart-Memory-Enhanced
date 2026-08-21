import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceSceneBufferAtBoundary, classifyTemporalReference, coalesceSceneBoundary, deriveSceneCandidateStateDelta, deriveSceneContinuitySignals, evaluateDeterministicSceneGate, shouldDeferSceneBoundaryToNextMessage } from '../scene-gate-utils.js';

test('a farewell proposal aligns to the following explicit scene opening', () => {
  assert.equal(
    shouldDeferSceneBoundaryToNextMessage('Good night. The call ended.', 'The next morning, she arrived at the garden.'),
    true,
  );
  assert.equal(
    shouldDeferSceneBoundaryToNextMessage('Good night. The call ended.', '"I love you," she whispered.'),
    false,
  );
});

test('a before-message boundary does not summarize the opening of the next scene', () => {
  const closingScene = [{ mes: 'First scene.' }, { mes: 'The call ends.' }];
  const opening = { mes: 'The next morning, a new scene begins.' };
  const partition = advanceSceneBufferAtBoundary(closingScene, opening, true);
  assert.deepEqual(partition.completed_messages, closingScene);
  assert.deepEqual(partition.next_buffer, [opening]);
  assert.notEqual(partition.completed_messages, closingScene);
});

test('before-message partitioning preserves source ranges for both resulting scenes', () => {
  const messages = [{ __sme_original_index: 10 }, { __sme_original_index: 11 }, { __sme_original_index: 12 }, { __sme_original_index: 13 }];
  const first = advanceSceneBufferAtBoundary(messages.slice(0, 2), messages[2], true);
  const second = advanceSceneBufferAtBoundary(first.next_buffer, messages[3], false);
  assert.deepEqual(first.completed_messages.map((message) => message.__sme_original_index), [10, 11]);
  assert.deepEqual(second.next_buffer.map((message) => message.__sme_original_index), [12, 13]);
});

test('deterministic scene gate is invariant to request lineage and repeated evaluation', () => {
  const stableInput = {
    aiRequestedBreak: true,
    heuristicBreak: true,
    sceneLength: 8,
    minimumSceneLength: 3,
    messageIndex: 148,
    previousBoundaryIndex: 72,
    continuity: deriveSceneContinuitySignals('They were still together.', 'The next morning, they resumed their conversation.'),
  };
  const direct = evaluateDeterministicSceneGate(stableInput);
  const fromPartialRetry = evaluateDeterministicSceneGate({ ...stableInput, request_lineage: 'partial_retry', confidence: null });
  const fromSingleRetry = evaluateDeterministicSceneGate({ ...stableInput, request_lineage: 'single_candidate_retry', confidence: 0.1 });
  assert.deepEqual(fromPartialRetry, direct);
  assert.deepEqual(fromSingleRetry, direct);
  assert.deepEqual(evaluateDeterministicSceneGate(stableInput), direct);
  assert.match(direct.gate_input_hash, /^scene-gate-/);
  assert.match(direct.gate_output_hash, /^scene-gate-/);
});

test('deterministic scene gate emits stable evidence for each rejection class', () => {
  const insufficient = evaluateDeterministicSceneGate({ aiRequestedBreak: true, heuristicBreak: false, sceneLength: 8, minimumSceneLength: 3, messageIndex: 50, previousBoundaryIndex: 40 });
  const tooShort = evaluateDeterministicSceneGate({ aiRequestedBreak: true, heuristicBreak: true, sceneLength: 2, minimumSceneLength: 3, messageIndex: 50, previousBoundaryIndex: 40 });
  assert.equal(insufficient.gate_reason_code, 'missing_independent_transition_evidence');
  assert.equal(insufficient.gate_evidence.continuity_overlap_score, 1);
  assert.equal(insufficient.gate_evidence.same_continuous_interaction, true);
  assert.equal(tooShort.gate_reason_code, 'minimum_scene_length');
  assert.equal(tooShort.gate_evidence.time_change_detected, false);
  assert.deepEqual(tooShort.gate_evidence.transition_evidence_groups.map((group) => group.evidence_group_id), ['heuristic_transition']);
  assert.equal(tooShort.gate_evidence.minimum_scene_length_satisfied, false);
});

test('strong conversational continuity vetoes an otherwise weak transition signal', () => {
  const continuity = deriveSceneContinuitySignals('She called him on the phone.', '"Yes," he replied on the call.');
  const result = evaluateDeterministicSceneGate({ aiRequestedBreak: true, heuristicBreak: true, sceneLength: 8, minimumSceneLength: 3, messageIndex: 50, previousBoundaryIndex: 40, continuity });
  assert.equal(continuity.strong_continuity, true);
  assert.equal(result.accepted, false);
  assert.equal(result.gate_reason_code, 'strong_continuity_veto');
});

test('an explicit time transition overrides conversational continuity', () => {
  const continuity = deriveSceneContinuitySignals('They were texting.', 'The next morning, she texted him again.');
  const result = evaluateDeterministicSceneGate({ aiRequestedBreak: true, heuristicBreak: true, sceneLength: 8, minimumSceneLength: 3, messageIndex: 50, previousBoundaryIndex: 40, continuity });
  assert.equal(continuity.explicit_transition, true);
  assert.equal(result.accepted, true);
});

test('one heuristic observation is exported as one evidence group, not four correlated signals', () => {
  const gate = evaluateDeterministicSceneGate({ aiRequestedBreak: true, heuristicBreak: true, sceneLength: 6, minimumSceneLength: 3, messageIndex: 9, previousBoundaryIndex: 1, continuity: { explicit_transition: false, strong_continuity: false, transition_evidence_groups: [] } });
  assert.deepEqual(gate.gate_evidence.transition_evidence_groups.map((group) => group.evidence_group_id), ['heuristic_transition']);
  assert.equal(gate.gate_evidence.activity_change_detected, false);
  assert.equal(gate.gate_evidence.narrative_phase_change_detected, false);
});

test('a provider break without credible transition support is rejected', () => {
  const continuity = deriveSceneContinuitySignals('They were discussing dinner.', 'She changed the subject and smiled.');
  const result = evaluateDeterministicSceneGate({ aiRequestedBreak: true, heuristicBreak: true, sceneLength: 8, minimumSceneLength: 3, messageIndex: 50, previousBoundaryIndex: 40, continuity });
  assert.equal(result.accepted, false);
  assert.equal(result.gate_reason_code, 'strong_continuity_veto');
});

test('a strongly implied narrative context reset is eligible without a literal time marker', () => {
  const continuity = deriveSceneContinuitySignals('They said goodbye and drove away.', 'Inside the restaurant, the room was quiet and nearly empty.');
  const result = evaluateDeterministicSceneGate({ aiRequestedBreak: true, heuristicBreak: true, sceneLength: 8, minimumSceneLength: 3, messageIndex: 50, previousBoundaryIndex: 40, continuity });
  assert.equal(continuity.strongly_implied_transition, true);
  assert.equal(result.accepted, true);
});

test('a new-setting narrative opening remains eligible after a completed interaction', () => {
  const continuity = deriveSceneContinuitySignals('They went home and did not speak for a week.', 'The porch light was on as he pulled into the driveway for dinner.');
  const result = evaluateDeterministicSceneGate({ aiRequestedBreak: true, heuristicBreak: false, sceneLength: 8, minimumSceneLength: 3, messageIndex: 22, previousBoundaryIndex: 4, continuity });
  assert.equal(continuity.strongly_implied_transition, true);
  assert.equal(result.accepted, true);
});

test('a narrative next-few-days jump is explicit support but quoted speculation is not', () => {
  assert.equal(deriveSceneContinuitySignals('He said thanks.', 'The next few days passed quietly.').explicit_transition, true);
  assert.equal(deriveSceneContinuitySignals('"What will happen?"', '"Maybe the next few days will help."').explicit_transition, false);
});

test('an explicit provider-supported transition does not require a matching heuristic', () => {
  const continuity = deriveSceneContinuitySignals('The call ended.', '*The next morning, she arrived at the garden.*');
  const result = evaluateDeterministicSceneGate({ aiRequestedBreak: true, heuristicBreak: false, sceneLength: 8, minimumSceneLength: 3, messageIndex: 20, previousBoundaryIndex: 4, continuity });
  assert.equal(result.accepted, true);
  assert.equal(result.gate_reason_code, 'accepted_combined_change');
});

test('a quoted discussion of a future day is not an explicit scene transition', () => {
  const continuity = deriveSceneContinuitySignals('"Would you do it?"', '"But what happens the next day?"');
  const result = evaluateDeterministicSceneGate({ aiRequestedBreak: true, heuristicBreak: true, sceneLength: 8, minimumSceneLength: 3, messageIndex: 21, previousBoundaryIndex: 4, continuity });
  assert.equal(continuity.explicit_transition, false);
  assert.equal(result.accepted, false);
  assert.equal(result.gate_reason_code, 'strong_continuity_veto');
});

test('quoted wake and next-day language inside an immediate reply is not scene narration', () => {
  const reply = deriveSceneContinuitySignals('"I checked on you."', 'Avery smiled. "You woke up to check on me? What about the next day?"');
  const textReply = deriveSceneContinuitySignals('Focus on him today.', '*You\'re right. I\'ll text you tonight after he goes to sleep.*');
  assert.equal(reply.explicit_transition, false);
  assert.equal(reply.strong_continuity, true);
  assert.equal(textReply.explicit_transition, false);
  assert.equal(textReply.strong_continuity, true);
});

test('a post-sleep narrative handoff remains explicit even when the opening has no time keyword', () => {
  const continuity = deriveSceneContinuitySignals('*I go to sleep.*', 'There were two messages waiting when the day began.');
  assert.equal(continuity.explicit_transition, true);
  assert.equal(continuity.strong_continuity, false);
});

test('an ambiguous implied change with direct continuity remains rejected', () => {
  const continuity = deriveSceneContinuitySignals('Do you agree?', 'Avery replied, "I do."');
  const result = evaluateDeterministicSceneGate({ aiRequestedBreak: true, heuristicBreak: true, sceneLength: 8, minimumSceneLength: 3, messageIndex: 50, previousBoundaryIndex: 40, continuity });
  assert.equal(result.accepted, false);
  assert.equal(result.gate_reason_code, 'strong_continuity_veto');
});

test('text and markup-wrapped replies remain continuous while sleep is a transition', () => {
  assert.equal(deriveSceneContinuitySignals('Okay. Good.', 'Text: "Thanks"').strong_continuity, true);
  assert.equal(deriveSceneContinuitySignals('What do you mean?', '*But?*').strong_continuity, true);
  const sleep = deriveSceneContinuitySignals('The conversation continued late into the night.', '*I go to sleep*');
  assert.equal(sleep.explicit_transition, true);
  assert.equal(sleep.strong_continuity, false);
});

test('an attributed direct reply remains continuous unless the text declares a reset', () => {
  assert.equal(deriveSceneContinuitySignals('He asked whether she agreed.', 'Avery replied, "I do."').strong_continuity, true);
  assert.equal(deriveSceneContinuitySignals('He asked whether she agreed.', 'The next morning, Avery replied, "I do."').strong_continuity, false);
});

test('same-run coalescing suppresses only a nearby direct continuation', () => {
  const continuity = deriveSceneContinuitySignals('They were still on the phone.', '"I understand," she replied on the call.');
  const directContinuation = coalesceSceneBoundary({ previousBoundaryIndex: 100, messageIndex: 104, minimumSceneLength: 3, continuity });
  const explicitTransition = coalesceSceneBoundary({ previousBoundaryIndex: 100, messageIndex: 104, minimumSceneLength: 3, continuity: { ...continuity, explicit_transition: true } });
  assert.deepEqual({ suppress: directContinuation.suppress, outcome: directContinuation.outcome }, { suppress: true, outcome: 'direct_continuation' });
  assert.equal(explicitTransition.suppress, false);
});

test('candidate state deltas remain privacy-safe while distinguishing reset from direct continuity', () => {
  const reset = deriveSceneCandidateStateDelta('The call ended. They went home.', 'The next morning, Avery arrived at the garden.');
  const reply = deriveSceneCandidateStateDelta('Do you agree?', 'Avery replied, "I do."');
  assert.equal(reset.meaningful_time_changed, true);
  assert.equal(reset.interaction_reset, true);
  assert.equal(reset.continuity_strength, 'none');
  assert.equal(reply.continuity_strength, 'strong');
  assert.match(reset.prior_state_fingerprint, /^scene-state-/);
  assert.equal(JSON.stringify(reset).includes('Avery'), false);
});

test('strong narrator transitions are rescued when the provider returns no-break', () => {
  const cases = [
    ['They finished the call.', 'The next morning, Avery arrived at the garden.'],
    ['He said thanks.', 'The next few days passed quietly.'],
    ['*I go to sleep.*', 'There were two messages waiting when the day began.'],
    ['They said goodbye and drove away.', 'Inside the restaurant, the room was quiet and nearly empty.'],
  ];
  for (const [previous, current] of cases) {
    const result = evaluateDeterministicSceneGate({
      aiRequestedBreak: false,
      heuristicBreak: false,
      sceneLength: 8,
      minimumSceneLength: 3,
      messageIndex: 80,
      previousBoundaryIndex: 10,
      continuity: deriveSceneContinuitySignals(previous, current),
    });
    assert.equal(result.accepted, true);
    assert.equal(result.deterministic_positive_rescue_used, true);
    assert.deepEqual(result.proposal_sources, ['deterministic_strong_evidence']);
  }
});

test('state differences and weak conversational shifts cannot trigger deterministic rescue', () => {
  const cases = [
    ['They discussed dinner.', 'She changed the subject and smiled.'],
    ['Avery was in the room.', 'Blake entered and answered the question.'],
    ['They were texting.', 'She mentioned the phone while replying.'],
  ];
  for (const [previous, current] of cases) {
    const result = evaluateDeterministicSceneGate({ aiRequestedBreak: false, heuristicBreak: false, sceneLength: 8, minimumSceneLength: 3, messageIndex: 80, previousBoundaryIndex: 10, continuity: deriveSceneContinuitySignals(previous, current) });
    assert.equal(result.accepted, false);
    assert.equal(result.deterministic_positive_rescue_eligible, false);
  }
});

test('dialogue and recalled temporal wording cannot become narrator transition support', () => {
  const cases = [
    ['They were speaking by phone.', 'Sophie was quiet. "Six years. You were depressed for six years because of me."'],
    ['They were speaking by phone.', '"Tomorrow I will call you."'],
    ['They were speaking by phone.', '"The next morning would be worse."'],
    ['They were speaking by phone.', '"Years ago, I made a mistake."'],
  ];
  for (const [previous, current] of cases) {
    const continuity = deriveSceneContinuitySignals(previous, current);
    assert.equal(continuity.explicit_transition, false);
    const result = evaluateDeterministicSceneGate({ aiRequestedBreak: true, heuristicBreak: false, sceneLength: 8, minimumSceneLength: 3, messageIndex: 80, previousBoundaryIndex: 10, continuity });
    assert.equal(result.accepted, false);
  }
});

test('future continuation inside the current event is not a scene transition', () => {
  const continuity = deriveSceneContinuitySignals('They continue talking at the party.', '*I would rather spend the rest of this party with you.*');
  assert.equal(continuity.explicit_transition, false);
  const result = evaluateDeterministicSceneGate({ aiRequestedBreak: true, heuristicBreak: false, sceneLength: 8, minimumSceneLength: 3, messageIndex: 80, previousBoundaryIndex: 10, continuity });
  assert.equal(result.accepted, false);
});

test('quoted future-continuation dialogue cannot be stripped into a time-jump rescue', () => {
  const continuity = deriveSceneContinuitySignals(
    'Nancy offers Adam another drink at the party.',
    '"Actually, I would rather spend the rest of this party with you."',
  );
  const result = evaluateDeterministicSceneGate({
    aiRequestedBreak: false,
    heuristicBreak: true,
    sceneLength: 20,
    minimumSceneLength: 3,
    messageIndex: 32,
    previousBoundaryIndex: 1,
    continuity,
  });
  assert.equal(continuity.explicit_transition, false);
  assert.equal(result.accepted, false);
  assert.equal(result.deterministic_positive_rescue_used, false);
});

test('habitual, preference, schedule, and future sleep wording is not a narrative transition', () => {
  const cases = [
    ['I like going to bed early.', 'preference'],
    ['I usually wake up at six.', 'schedule'],
    ['I tend to sleep late on weekends.', 'habitual'],
    ['She prefers mornings.', 'preference'],
    ['My bedtime is midnight.', 'schedule'],
    ["He says, 'I always go to bed early.'", 'habitual'],
    ["I'll go to bed early tonight.", 'future_plan'],
  ];
  for (const [message, type] of cases) {
    const classification = classifyTemporalReference(message);
    assert.equal(classification.type, type);
    assert.equal(classification.final_transition_eligible, false);
    assert.equal(deriveSceneContinuitySignals('They continue talking at the party.', message).explicit_transition, false);
  }
});

test('actual sleep and wake events retain narrative temporal support', () => {
  assert.equal(classifyTemporalReference('She goes to bed.').final_transition_eligible, true);
  assert.equal(classifyTemporalReference('The next morning she wakes.').final_transition_eligible, true);
  const handoff = deriveSceneContinuitySignals(
    '*They fall asleep together and sleep late into the morning.*',
    'Sunlight filters through the curtains as she stirs awake.',
  );
  assert.equal(handoff.explicit_transition, true);
  assert.equal(handoff.temporal_reference_classification.type, 'narrative_event');
});

test('a reply after future continuation wording cannot inherit a time-jump rescue', () => {
  const continuity = deriveSceneContinuitySignals(
    'I would rather spend the rest of this party with you.',
    'She smiles and replies immediately.',
  );
  assert.equal(continuity.explicit_transition, false);
});

test('next-night arrival after a closed exchange is eligible for deterministic rescue', () => {
  const continuity = deriveSceneContinuitySignals('Their late-night text exchange ended until morning.', '*I show up the next night, five minutes early, with flowers, and knock.*');
  assert.equal(continuity.explicit_transition, true);
  const result = evaluateDeterministicSceneGate({ aiRequestedBreak: false, heuristicBreak: false, sceneLength: 8, minimumSceneLength: 3, messageIndex: 80, previousBoundaryIndex: 10, continuity });
  assert.equal(result.accepted, true);
  assert.equal(result.deterministic_positive_rescue_used, true);
});

test('a paused-until-morning closure defers before_message to the next grounded arrival', () => {
  assert.equal(
    shouldDeferSceneBoundaryToNextMessage(
      'Their late-night text exchange was paused until morning.',
      'I show up the next night, five minutes early, with flowers, and knock.',
    ),
    true,
  );
  assert.equal(
    shouldDeferSceneBoundaryToNextMessage(
      'The conversation was paused until morning.',
      '"I miss you," she texted immediately.',
    ),
    false,
  );
});

test('overnight alignment keeps the closing text in the old scene and gates the arrival with its full length', () => {
  const closing = 'The late-night text conversation was paused until morning.';
  const arrival = '*I show up the next night. Five minutes early. With flowers. I knock.*';
  assert.equal(deriveSceneContinuitySignals('', closing).explicit_transition, true);
  assert.equal(shouldDeferSceneBoundaryToNextMessage(closing, arrival), true);
  const correctlyAligned = evaluateDeterministicSceneGate({
    aiRequestedBreak: true,
    heuristicBreak: false,
    sceneLength: 24,
    minimumSceneLength: 3,
    messageIndex: 166,
    previousBoundaryIndex: 100,
    continuity: deriveSceneContinuitySignals(closing, arrival),
  });
  assert.equal(correctlyAligned.accepted, true);
  const stalePreAlignment = evaluateDeterministicSceneGate({
    aiRequestedBreak: true,
    heuristicBreak: false,
    sceneLength: 1,
    minimumSceneLength: 3,
    messageIndex: 166,
    previousBoundaryIndex: 165,
    continuity: deriveSceneContinuitySignals(closing, arrival),
  });
  assert.equal(stalePreAlignment.gate_reason_code, 'minimum_scene_length');
});

test('same-message completed relocation and established setting begins the new scene', () => {
  const continuity = deriveSceneContinuitySignals(
    'They finish their walk through town.',
    '*We finish walking and go back to her place. On the couch, eating scones and talking.*',
  );
  assert.equal(continuity.strongly_implied_transition, true);
  const accepted = evaluateDeterministicSceneGate({
    aiRequestedBreak: false,
    heuristicBreak: false,
    sceneLength: 20,
    minimumSceneLength: 3,
    messageIndex: 287,
    previousBoundaryIndex: 172,
    continuity,
  });
  assert.equal(accepted.accepted, true);
});

test('completed travel to a coffee shop plus a new activity is grounded at the same message', () => {
  const current = 'After dinner, Kyler and I walk down to the coffee shop in the hospital lobby. I buy her coffee, then we sit at a table.';
  const continuity = deriveSceneContinuitySignals('They finish eating in the hospital room.', current);
  const delta = deriveSceneCandidateStateDelta('They finish eating in the hospital room.', current);
  assert.equal(continuity.grounded_relocation_detected, true);
  assert.equal(continuity.new_setting_activity_detected, true);
  assert.equal(continuity.strongly_implied_transition, true);
  assert.equal(delta.grounded.location_reset_evidence, true);
  assert.equal(delta.grounded.new_setting_activity_evidence, true);
  const accepted = evaluateDeterministicSceneGate({
    aiRequestedBreak: true,
    heuristicBreak: false,
    sceneLength: 12,
    minimumSceneLength: 3,
    messageIndex: 243,
    previousBoundaryIndex: 203,
    continuity,
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.gate_evidence.location_change_detected, true);
  assert.equal(accepted.gate_evidence.activity_change_detected, true);
});

test('a named person possessive room plus a new discussion is a same-message boundary', () => {
  const continuity = deriveSceneContinuitySignals(
    'They finish their conversation in the coffee shop.',
    'We go back to Taylor\'s room, where we begin discussing the decision.',
  );
  assert.equal(continuity.grounded_relocation_detected, true);
  assert.equal(continuity.new_setting_activity_detected, true);
  assert.equal(continuity.strongly_implied_transition, true);
});

test('returning to a room and beginning care there is a grounded relocation boundary', () => {
  const continuity = deriveSceneContinuitySignals(
    'They continue their conversation in the hallway.',
    '*We get back to the room and help Taylor back into the bed. Kyler sits down. I start massaging her shoulders.*',
    { candidate_seam_index: 281 },
  );
  assert.equal(continuity.grounded_relocation_detected, true);
  assert.equal(continuity.new_setting_activity_detected, true);
  assert.equal(continuity.strongly_implied_transition, true);
  assert.deepEqual(continuity.relocation_evidence_provenance, {
    candidate_seam_index: 281,
    evidence_source_message_index: 281,
    evidence_origin: 'candidate_message',
    alignment: 'same_message',
    completed_relocation_signal: true,
    new_setting_activity_signal: true,
    continuity_veto: false,
  });
});

test('later massage conversation cannot inherit an earlier return-to-room relocation', () => {
  const continuity = deriveSceneContinuitySignals(
    'Taylor watches the continuing massage from the bed and responds to Aaron.',
    'Kyler lets Aaron keep working along her shoulders. She says she is trying to accept his support.',
    { candidate_seam_index: 285 },
  );
  const result = evaluateDeterministicSceneGate({
    aiRequestedBreak: false,
    heuristicBreak: true,
    sceneLength: 15,
    minimumSceneLength: 3,
    messageIndex: 285,
    previousBoundaryIndex: 258,
    continuity,
  });
  assert.equal(continuity.grounded_relocation_detected, false);
  assert.equal(continuity.new_setting_activity_detected, false);
  assert.equal(continuity.relocation_evidence_provenance, null);
  assert.equal(result.accepted, false);
  assert.notEqual(result.gate_reason_code, 'accepted_deterministic_positive_rescue');
});

test('a completed return without a new activity aligns only when the following message opens the setting', () => {
  const returnOnly = '*We go back to Taylor\'s room.*';
  const roomOpening = '*Taylor was sitting up in bed when we walked through the door. We begin talking.*';
  assert.equal(deriveSceneContinuitySignals('', returnOnly).pending_relocation_opening, true);
  assert.equal(shouldDeferSceneBoundaryToNextMessage(returnOnly, roomOpening), true);
});

test('travel that has not established the destination remains in the current scene', () => {
  const continuity = deriveSceneContinuitySignals('They finish dinner.', '*We head toward her apartment, still walking and talking.*');
  assert.equal(continuity.strongly_implied_transition, false);
});

test('future travel discussion is not a grounded relocation', () => {
  const continuity = deriveSceneContinuitySignals(
    'They continue their conversation.',
    'Kyler and I discuss going to the coffee shop tomorrow.',
  );
  assert.equal(continuity.grounded_relocation_detected, false);
  assert.equal(continuity.strongly_implied_transition, false);
});

test('a temporal mention followed by a direct reply cannot be aligned into a new scene', () => {
  assert.equal(
    shouldDeferSceneBoundaryToNextMessage(
      'The conversation was paused until morning.',
      '"I miss you," she texted immediately.',
    ),
    false,
  );
});

test('returning from a continuous activity is not a grounded new-scene opening', () => {
  const continuity = deriveSceneContinuitySignals('"You look beautiful. Come on." They go for a run and return together.', 'They returned to the house breathless and laughing.');
  const result = evaluateDeterministicSceneGate({ aiRequestedBreak: true, heuristicBreak: false, sceneLength: 8, minimumSceneLength: 3, messageIndex: 80, previousBoundaryIndex: 10, continuity });
  assert.equal(continuity.explicit_transition, false);
  assert.equal(continuity.strongly_implied_transition, false);
  assert.equal(result.accepted, false);
});

test('state-delta diagnostics distinguish observed change from grounded reset', () => {
  const continuous = deriveSceneCandidateStateDelta('Avery is in the office and asks a question.', 'Blake enters the office and answers immediately.');
  assert.equal(continuous.observed.participant_set_changed, true);
  assert.equal(continuous.grounded.participant_context_reset_evidence, false);
  assert.equal(continuous.grounded.time_jump_evidence, false);
  const reset = deriveSceneCandidateStateDelta('They said goodbye and drove away.', 'Inside the restaurant, the room was quiet and nearly empty.');
  assert.equal(reset.grounded.location_reset_evidence, true);
  assert.equal(reset.grounded.new_setting_opening, true);
});
