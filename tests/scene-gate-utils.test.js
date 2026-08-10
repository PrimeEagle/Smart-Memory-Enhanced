import test from 'node:test';
import assert from 'node:assert/strict';
import { coalesceSceneBoundary, deriveSceneContinuitySignals, evaluateDeterministicSceneGate } from '../scene-gate-utils.js';

test('deterministic scene gate is invariant to request lineage and repeated evaluation', () => {
  const stableInput = {
    aiRequestedBreak: true,
    heuristicBreak: true,
    sceneLength: 8,
    minimumSceneLength: 3,
    messageIndex: 148,
    previousBoundaryIndex: 72,
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
  assert.equal(insufficient.gate_reason_code, 'same_continuous_interaction');
  assert.equal(insufficient.gate_evidence.continuity_overlap_score, 1);
  assert.equal(insufficient.gate_evidence.same_continuous_interaction, true);
  assert.equal(tooShort.gate_reason_code, 'minimum_scene_length');
  assert.equal(tooShort.gate_evidence.time_change_detected, false);
  assert.deepEqual(tooShort.gate_evidence.transition_evidence_groups, ['heuristic_transition']);
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
  assert.deepEqual(gate.gate_evidence.transition_evidence_groups, ['heuristic_transition']);
  assert.equal(gate.gate_evidence.activity_change_detected, false);
  assert.equal(gate.gate_evidence.narrative_phase_change_detected, false);
});

test('text and markup-wrapped replies remain continuous while sleep is a transition', () => {
  assert.equal(deriveSceneContinuitySignals('Okay. Good.', 'Text: "Thanks"').strong_continuity, true);
  assert.equal(deriveSceneContinuitySignals('What do you mean?', '*But?*').strong_continuity, true);
  const sleep = deriveSceneContinuitySignals('The conversation continued late into the night.', '*I go to sleep*');
  assert.equal(sleep.explicit_transition, true);
  assert.equal(sleep.strong_continuity, false);
});

test('same-run coalescing suppresses only a nearby direct continuation', () => {
  const continuity = deriveSceneContinuitySignals('They were still on the phone.', '"I understand," she replied on the call.');
  const directContinuation = coalesceSceneBoundary({ previousBoundaryIndex: 100, messageIndex: 104, minimumSceneLength: 3, continuity });
  const explicitTransition = coalesceSceneBoundary({ previousBoundaryIndex: 100, messageIndex: 104, minimumSceneLength: 3, continuity: { ...continuity, explicit_transition: true } });
  assert.deepEqual({ suppress: directContinuation.suppress, outcome: directContinuation.outcome }, { suppress: true, outcome: 'direct_continuation' });
  assert.equal(explicitTransition.suppress, false);
});
