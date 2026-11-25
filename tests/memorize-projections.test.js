import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemorizeDiagnosticsDownload } from '../memorize-diagnostics-download.js';
import { selectMemorizeResumePreflight } from '../memorize-recovery-authority.js';
import { deriveShortTermMissingPlanResumeEligibility } from '../shortterm-recovery-utils.js';
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

test('source-tier Resume does not require a Short-Term recovery plan', () => {
  const checkpoint = { status: 'awaiting_manual_resume' };
  const missingPlan = () => deriveShortTermMissingPlanResumeEligibility({ checkpointStatus: checkpoint.status });
  const authority = {
    pending_obligation: { tier: 'longterm', exact_reason_code: 'provider_transport_failure' },
    resume_eligible: true, next_executable_action: 'dispatch_provider_request', resume_blockers: [],
  };
  const resumeEligibility = selectMemorizeResumePreflight(authority,
    () => assert.fail('must not validate Short-Term while source work is pending'));
  assert.equal(resumeEligibility.eligible, true);
  assert.equal(resumeEligibility.decision, 'dispatch_provider_request');
  const presentation = selectRecoveryPresentation({ checkpoint, resumeEligibility,
    manifest: { source_window: { message_count: 9434 } }, recovery: { safely_committed_offset: 0 } });
  assert.equal(presentation.disabled, false);
  assert.match(presentation.status_text, /contiguous checkpoint 0\/9434/);
  const blocked = selectMemorizeResumePreflight({
    ...authority, resume_eligible: false, resume_blockers: [{ reason_code: 'resume_no_progress_same_action' }],
  }, () => assert.fail('must not override the authority blocker'));
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.reason, 'resume_no_progress_same_action');
  assert.equal(selectMemorizeResumePreflight(null, missingPlan).reason, 'shortterm_recovery_plan_missing');
});

test('diagnostics projection returns a new read model without mutating sources', () => {
  const completed = { status: 'completed', nested: { value: 1 },
    provider_completion_journal: { entries: [{ attempt_id: 'attempt-1',
      response_text: 'private provider response', parser_result: { status: 'accepted' } }] } };
  const result = selectDiagnosticsProjection({ completedRun: completed, current: { live_memory_health: { status: 'idle' } } });
  assert.notEqual(result, completed);
  assert.equal(result.status, 'completed');
  assert.equal(result.live_memory_health.status, 'idle');
  result.nested.value = 2;
  assert.equal(completed.nested.value, 1);
  const selected = result.provider_completion_journal.entries[0];
  assert.equal(Object.hasOwn(selected, 'response_text'), false);
  assert.deepEqual(selected.parser_result, { status: 'accepted' });
  assert.equal(completed.provider_completion_journal.entries[0].response_text,
    'private provider response');
});

test('export projection preserves the original run failure when full publication fails', () => {
  const report = {
    status: 'incomplete',
    logical_run: { logical_run_id: 'run-1' },
    controller_exit: { code: 'SME_HOST_SAVE_FAILED', failure_stage: 'checkpoint' },
    provider_completion_journal: { response_body: 'private response' },
  };
  const full = selectDiagnosticsProjection({ completedRun: report, createdAt: 1 });
  assert.equal(full.root_error.code, 'SME_HOST_SAVE_FAILED');
  const compact = selectDiagnosticsProjection({
    completedRun: { ...report, broken_section: { value: Infinity } }, createdAt: 1,
  });
  assert.equal(compact.diagnostic_type, 'incomplete_catchup_recovery');
  assert.equal(compact.root_error.code, full.root_error.code);
  assert.equal(compact.root_error.failure_stage, 'checkpoint');
  assert.equal(compact.logical_run_identity.logical_run_id, 'run-1');
  assert.doesNotMatch(JSON.stringify(compact), /private response|broken_section/);
});

test('Export Diagnostics downloads the current compact report and revokes its URL', async () => {
  let completedRun;
  let blob;
  const events = [];
  const link = { click() { events.push(['download', this.href, this.download]); } };
  const download = createMemorizeDiagnosticsDownload({
    readReport: () => selectDiagnosticsProjection({ completedRun, createdAt: 1 }),
    onUnavailable: () => events.push(['unavailable']),
    document: { createElement: (tag) => { assert.equal(tag, 'a'); return link; } },
    url: {
      createObjectURL(value) { blob = value; return 'blob:diagnostics'; },
      revokeObjectURL(href) { events.push(['revoke', href]); },
    },
  });
  download();
  completedRun = {
    status: 'incomplete', controller_exit: { code: 'SME_HOST_SAVE_FAILED' },
    broken_section: Infinity, provider_completion_journal: { response_body: 'private response' },
  };
  download();
  assert.deepEqual(events, [
    ['unavailable'],
    ['download', 'blob:diagnostics', 'smart-memory-enhanced-diagnostics.json'],
    ['revoke', 'blob:diagnostics'],
  ]);
  assert.equal(blob.type, 'application/json');
  const body = await blob.text();
  const parsed = JSON.parse(body);
  assert.equal(parsed.diagnostic_type, 'incomplete_catchup_recovery');
  assert.equal(parsed.root_error.code, 'SME_HOST_SAVE_FAILED');
  assert.doesNotMatch(body, /private response|broken_section/);
  link.click = () => { throw new Error('download failure'); };
  assert.throws(download, /download failure/);
  assert.deepEqual(events.at(-1), ['revoke', 'blob:diagnostics']);
  assert.equal(events.filter(([type]) => type === 'revoke').length, 2);
});

