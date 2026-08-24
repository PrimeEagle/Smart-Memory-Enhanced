import test from 'node:test';
import assert from 'node:assert/strict';
import { describePartialProviderOmission, describeTargetedProviderRecovery } from '../scene-batch-recovery-utils.js';

test('a partial provider batch records a single targeted recovery rather than silently defaulting the omitted ID', () => {
  const omission = describePartialProviderOmission({ rootBatchId: 1, requestAttemptId: 1, missingCandidateIds: [127], truncationSuspected: true, parserNormalized: true });
  const recovery = describeTargetedProviderRecovery({ rootBatchId: 1, parentRequestAttemptId: 1, requestedCandidateIds: omission.omitted_candidate_ids, unresolvedCandidateIds: [] });
  assert.equal(omission.cause, 'provider_omitted_candidate_decisions');
  assert.deepEqual(omission.omitted_candidate_ids, [127]);
  assert.equal(recovery.retry_type, 'single_candidate_retry');
  assert.deepEqual(recovery.requested_candidate_ids, [127]);
  assert.equal(recovery.recovered_candidate_count, 1);
  assert.deepEqual(recovery.unresolved_candidate_ids, []);
  assert.equal(recovery.final_boundary_effect, 'determined_during_scene_assembly');
});
