import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceSceneBufferAtBoundary, coalesceSceneBoundary, deriveSceneCandidateStateDelta, deriveSceneContinuitySignals, evaluateDeterministicSceneGate, shouldDeferSceneBoundaryToNextMessage } from '../scene-gate-utils.js';

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
