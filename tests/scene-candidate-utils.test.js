import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSceneCandidateAdmission, summarizeSceneCandidateSources } from '../scene-candidate-utils.js';

test('group speaker churn and a legacy heuristic cannot nominate a provider candidate alone', () => {
  const result = evaluateSceneCandidateAdmission({ isGroupChat: true, heuristic: true, speakerChanged: true });
  assert.equal(result.admitted, false);
  assert.equal(result.rejection_reason, 'group_heuristic_without_grounded_transition');
  assert.deepEqual(result.source_categories, ['heuristic', 'speaker_churn']);
});

test('participant or state churn cannot nominate a group candidate without grounded prose', () => {
  const result = evaluateSceneCandidateAdmission({ isGroupChat: true, speakerChanged: true, currentWeakSignal: true });
  assert.equal(result.admitted, false);
  assert.equal(result.rejection_reason, 'no_independent_transition_support');
});

test('explicit time, sleep/wake, and grounded relocation remain group candidates', () => {
  for (const input of [{ strongTransition: true }, { deterministicStrongAdmission: true }, { moderateTransition: true, heuristic: true }]) {
    const result = evaluateSceneCandidateAdmission({ isGroupChat: true, ...input });
    assert.equal(result.admitted, true);
    assert.equal(result.grounded_transition_support, true);
  }
});

test('a legacy heuristic remains available for non-group compatibility', () => {
  assert.equal(evaluateSceneCandidateAdmission({ isGroupChat: false, heuristic: true }).admitted, true);
});

test('source outcome audit distinguishes provider, gate, and final results without prose', () => {
  const audit = summarizeSceneCandidateSources([
    { candidate_id: 20, message_index: 20, decision: true, gate_reason_code: 'accepted_combined_change', selection_provenance: { source_categories: ['strong_deterministic'], composite_source: 'strong_deterministic' } },
    { candidate_id: 30, message_index: 30, decision: true, gate_reason_code: 'strong_continuity_veto', selection_provenance: { source_categories: ['heuristic', 'speaker_churn'], composite_source: 'combined' } },
  ], [20]);
  assert.equal(audit.sources.strong_deterministic.provider_break, 1);
  assert.equal(audit.sources.strong_deterministic.final_accepted, 1);
  assert.equal(audit.sources.heuristic.continuity_veto, 1);
  assert.equal(audit.sources.combined.final_rejected, 1);
});
