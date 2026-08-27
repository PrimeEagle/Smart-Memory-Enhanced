import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCatchUpCheckpoint, validateCatchUpResumeSource } from '../catchup-recovery-utils.js';

const checkpoint = {
  schema_version: 1,
  status: 'in_progress',
  run_id: 'run-1',
  source_message_count: 3,
  source_last_original_index: 8,
  next_source_offset: 2,
};

test('a valid incomplete checkpoint resumes at its committed source offset', () => {
  assert.deepEqual(normalizeCatchUpCheckpoint(checkpoint), checkpoint);
  assert.deepEqual(validateCatchUpResumeSource(checkpoint, [
    { __sme_original_index: 2 }, { __sme_original_index: 5 }, { __sme_original_index: 8 }, { __sme_original_index: 10 },
  ]), {
    valid: true,
    source_message_count: 3,
    resume_offset: 2,
  });
});

test('completed, malformed, shortened, and changed source windows cannot resume', () => {
  assert.equal(normalizeCatchUpCheckpoint({ ...checkpoint, status: 'awaiting_manual_resume' })?.run_id, 'run-1');
  assert.equal(normalizeCatchUpCheckpoint({ ...checkpoint, status: 'completed' }), null);
  assert.equal(normalizeCatchUpCheckpoint({ ...checkpoint, next_source_offset: 4 }), null);
  assert.equal(validateCatchUpResumeSource(checkpoint, [{ __sme_original_index: 2 }]).reason, 'source_window_shorter_than_checkpoint');
  assert.equal(validateCatchUpResumeSource(checkpoint, [
    { __sme_original_index: 2 }, { __sme_original_index: 5 }, { __sme_original_index: 9 },
  ]).reason, 'source_window_boundary_changed');
});
