import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDiagnosticsProjection, selectRecoveryPresentation, selectRunOutcomePresentation } from '../memorize-projections.js';

test('run outcome projection is pure and deterministic', () => {
  const report = { run_status: { lifecycle_status: 'completed', outcome_status: 'completed_clean', severity: 'success', label: 'Completed', icon: 'check', notice_count: 0, recovered_error_count: 0, unresolved_error_count: 0, status_reason_codes: [], completion_evidence: { committed_message_count: 20 } } };
  const before = structuredClone(report);
  const first = selectRunOutcomePresentation(report);
  const second = selectRunOutcomePresentation(report);
  assert.deepEqual(first, second);
  assert.deepEqual(report, before);
  assert.match(first.detail, /20 source messages/);
});

test('recovery projection distinguishes absent, blocked, and resumable states', () => {
  assert.equal(selectRecoveryPresentation({}).disabled, true);
  const blocked = selectRecoveryPresentation({ checkpoint: {}, recovery: { blocked: true, unresolved_obligation_count: 1, blocked_obligations: [] } });
  assert.equal(blocked.label, 'Recovery Change Required');
  const ready = selectRecoveryPresentation({ checkpoint: { status: 'awaiting_manual_resume', source_message_count: 20, next_source_offset: 10 }, recovery: {}, manifest: {}, resumeEligibility: { eligible: true } });
  assert.equal(ready.disabled, false);
});

test('diagnostics projection returns a new read model without mutating sources', () => {
  const completed = { status: 'completed', nested: { value: 1 },
    authoritative_recovery: { base_resume_eligibility: {
      retained_evidence_plan: { selected_entry: {
        attempt_id: 'attempt-1', response_text: 'private provider response',
        parser_result: { status: 'accepted', accepted_count: 1,
          records: [{ id: 'private-record', content: 'private record' }] },
      } },
    } } };
  const result = selectDiagnosticsProjection({ completedRun: completed, current: { live_memory_health: { status: 'idle' } } });
  assert.notEqual(result, completed);
  assert.equal(result.status, 'completed');
  assert.equal(result.live_memory_health.status, 'idle');
  result.nested.value = 2;
  assert.equal(completed.nested.value, 1);
  const selected = result.authoritative_recovery.base_resume_eligibility
    .retained_evidence_plan.selected_entry;
  assert.equal(Object.hasOwn(selected, 'response_text'), false);
  assert.deepEqual(selected.parser_result, { status: 'accepted', accepted_count: 1,
    record_count: 1, private_records_retained: true });
  assert.equal(completed.authoritative_recovery.base_resume_eligibility
    .retained_evidence_plan.selected_entry.response_text, 'private provider response');
});

