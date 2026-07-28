import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDeterministicSceneGate } from '../scene-gate-utils.js';

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
  assert.equal(tooShort.gate_evidence.time_change_detected, true);
  assert.equal(tooShort.gate_evidence.minimum_scene_length_satisfied, false);
});
