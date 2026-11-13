import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemorizeExecutionAggregate,
  recordMemorizeActionReceipt,
} from '../memorize-execution-kernel.js';
import { applyMemorizeLifecycleEvent } from '../memorize-obligation-ledger.js';
import {
  deriveMemorizeResumeProgress,
  snapshotMemorizeResumeProgress,
} from '../memorize-resume-progress.js';

function pendingAggregate() {
  const aggregate = createMemorizeExecutionAggregate('run-1');
  applyMemorizeLifecycleEvent(aggregate, {
    obligation_id: 'session:160-179:fp', root_obligation_id: 'session:160-179:fp',
    leaf_obligation_id: 'session:160-179:fp', logical_run_id: 'run-1', tier: 'session',
    source_range: { start: 160, end: 179, message_count: 20 }, source_fingerprint: 'fp',
  }, { type: 'obligation_registered', event_id: 'register' });
  return aggregate;
}

test('Resume reports an action only when a durable action receipt was added', () => {
  const aggregate = pendingAggregate();
  const before = snapshotMemorizeResumeProgress({ ledger: aggregate,
    checkpoint: { next_source_offset: 160, committed_chunks: 8 } });
  const recorded = recordMemorizeActionReceipt(aggregate, {
    logical_run_id: 'run-1', obligation_id: 'session:160-179:fp',
    action: 'dispatch_provider_request', phase: 'provider_request_started',
    attempt_id: 'attempt-1', controller_generation: 2,
  });
  const after = snapshotMemorizeResumeProgress({ ledger: recorded.aggregate,
    checkpoint: { next_source_offset: 160, committed_chunks: 8 } });
  const progress = deriveMemorizeResumeProgress(before, after);
  assert.equal(progress.action_actually_executed, 'dispatch_provider_request');
  assert.equal(progress.provider_request_started, true);
  assert.equal(progress.progress, true);

  const unchanged = deriveMemorizeResumeProgress(after, after);
  assert.equal(unchanged.action_actually_executed, null);
  assert.equal(unchanged.progress, false);
  assert.equal(unchanged.no_progress_reason, 'resume_no_progress_same_action');
});
