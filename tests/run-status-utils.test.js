import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveRunErrorAccounting, deriveRunPerformanceDiagnostics, deriveRunStatus, normalizeRunStatusReport } from '../run-status-utils.js';

const completed = (overrides = {}) => ({
  status: 'partial', operational_status: 'partial',
  logical_run: {
    source_window: { message_count: 9434 }, cumulative_committed_count: 9434,
    remaining_gap_count: 0, all_original_source_messages_covered: true,
    full_cumulative_coverage_confirmed: true, terminal_status: 'completed',
    terminal_reason_code: 'finalization_committed', cumulative_request_counters: { provider_failure_count: 0 },
  },
  provider_attempt_audit: {
    unique_malformed_obligations: 0, recovered_malformed_obligations: 0,
    terminally_unresolved_malformed_obligations: 0, terminal_unresolved_obligations: [],
  },
  quality: { final_integrity_status: 'clean', notices: [] },
  ...overrides,
});

test('full coverage and committed finalization classify as green completed', () => {
  const result = deriveRunStatus(completed());
  assert.equal(result.lifecycle_status, 'completed');
  assert.equal(result.outcome_status, 'completed_clean');
  assert.equal(result.severity, 'success');
  assert.equal(result.label, 'Completed');
});

test('recovered provider errors remain completed and render warning severity', () => {
  const result = deriveRunStatus(completed({ provider_attempt_audit: {
    unique_malformed_obligations: 8, recovered_malformed_obligations: 8,
    terminally_unresolved_malformed_obligations: 0, terminal_unresolved_obligations: [],
  } }));
  assert.equal(result.lifecycle_status, 'completed');
  assert.equal(result.outcome_status, 'completed_recovered_errors');
  assert.equal(result.label, 'Completed — recovered errors');
  assert.equal(result.unresolved_error_count, 0);
});

test('recovered transient observations produce warning even without malformed obligations', () => {
  const report = completed();
  report.logical_run.cumulative_request_counters.provider_failure_count = 3;
  const result = deriveRunStatus(report);
  assert.equal(result.lifecycle_status, 'completed');
  assert.equal(result.outcome_status, 'completed_recovered_errors');
  assert.equal(result.historical_failure_observation_count, 3);
  assert.equal(result.recovered_error_count, 0);
});

test('supplied-run shape is completed with six errors rather than partial', () => {
  const report = completed({
    errors: 5, error_details: Array.from({ length: 5 }, () => ({ fatal: false })),
    logical_run: { ...completed().logical_run, cumulative_request_counters: { provider_failure_count: 8 } },
    provider_attempt_audit: {
      malformed_physical_responses: 108, unique_malformed_obligations: 100,
      recovered_malformed_obligations: 94, terminally_unresolved_malformed_obligations: 6,
      terminal_unresolved_obligations: Array.from({ length: 6 }, (_, index) => ({ root_obligation_id: `failed-${index}` })),
      terminal_unresolved_obligation_detail_limit: 64,
    },
    quality: { final_integrity_status: 'clean', notices: [{ code: 'safe_notice' }] },
  });
  const accounting = deriveRunErrorAccounting(report);
  assert.equal(accounting.current_attempt_error_records.count, 5);
  assert.equal(accounting.historical_failure_observations.count, 100);
  assert.equal(accounting.terminal_unresolved_obligations.count, 6);
  assert.equal(accounting.reconciliation.consistent, true);
  const normalized = normalizeRunStatusReport(report);
  assert.equal(normalized.lifecycle_status, 'completed');
  assert.equal(normalized.outcome_status, 'completed_with_errors');
  assert.equal(normalized.severity, 'error');
  assert.equal(normalized.run_status.label, 'Completed with 6 errors');
  assert.equal(normalized.legacy_status_compatibility.original_status, 'partial');
});

test('incomplete resumable, blocked, fatal, and notice-only states have deterministic precedence', () => {
  const incomplete = deriveRunStatus({ catch_up_recovery: { available: true, resumable: true } });
  assert.equal(incomplete.outcome_status, 'incomplete_resumable');
  const blocked = deriveRunStatus({ catch_up_recovery: { available: true, resumable: false, reason_code: 'blocked' } });
  assert.equal(blocked.lifecycle_status, 'blocked');
  assert.equal(blocked.recovery_reason_code, 'blocked');
  const failed = deriveRunStatus({ status: 'failed', fatal_run_error_count: 1 });
  assert.equal(failed.lifecycle_status, 'failed');
  const notices = deriveRunStatus(completed({ quality: { final_integrity_status: 'clean', notices: [{ code: 'safe' }] } }));
  assert.equal(notices.outcome_status, 'completed_with_notices');
  const providerNotices = deriveRunStatus(completed({ provider_attempt_audit: {
    unique_malformed_obligations: 0, recovered_malformed_obligations: 0,
    terminally_unresolved_malformed_obligations: 0, terminal_unresolved_obligations: [],
    notice_reason_counts: { partial_valid_output: 12 },
  } }));
  assert.equal(providerNotices.outcome_status, 'completed_with_notices');
});

test('recovered failures canonically supply a missing historical observation count', () => {
  const corrected = deriveRunErrorAccounting(completed({ provider_attempt_audit: {
    unique_malformed_obligations: 2, recovered_malformed_obligations: 2,
    terminally_unresolved_malformed_obligations: 0, terminal_unresolved_obligations: [],
  }, logical_run: { ...completed().logical_run, cumulative_request_counters: { provider_failure_count: 0 } } }));
  assert.equal(corrected.historical_failure_observations.count, 2);
  assert.equal(corrected.reconciliation.recovered_failures_have_historical_observation, true);
  assert.equal(corrected.reconciliation.consistent, true);
});

test('bounded detail never replaces exact authoritative unresolved totals', () => {
  const report = completed({ provider_attempt_audit: {
    unique_malformed_obligations: 100, recovered_malformed_obligations: 20,
    terminally_unresolved_malformed_obligations: 80,
    terminal_unresolved_obligations: Array.from({ length: 64 }, (_, index) => ({ root_obligation_id: `u-${index}` })),
    terminal_unresolved_obligation_detail_limit: 64,
  } });
  const accounting = deriveRunErrorAccounting(report);
  assert.equal(accounting.terminal_unresolved_obligations.count, 80);
  assert.equal(accounting.terminal_unresolved_obligations.retained_detail_count, 64);
  assert.equal(accounting.terminal_unresolved_obligations.detail_truncated, true);
});

test('a manual repair missed by automatic finalization prevents clean certification', () => {
  const result = deriveRunStatus(completed({ manual_idempotence: {
    post_automatic_manual_dependency_trace: { automatic_missed_mutation: true },
  } }));
  assert.equal(result.outcome_status, 'completed_with_notices');
  assert.equal(result.severity, 'warning');
  assert.equal(result.attention_required, true);
  assert.ok(result.status_reason_codes.includes('automatic_finalization_missed_mutation'));
});

test('performance diagnostics exclude between-attempt downtime from provider time', () => {
  const performance = deriveRunPerformanceDiagnostics({
    logical_run: { cumulative_attempt_elapsed_ms: 3000, attempts: [
      { attempt_number: 1, started_at: 1000, duration_ms: 1000 },
      { attempt_number: 2, started_at: 5000, duration_ms: 2000 },
    ] },
    provider_attempt_audit: { physical_attempts: 2, unique_logical_obligations: 2,
      retained_attempt_scope: 'last_160_attempts', retained_attempts: [
        { attempt_id: 'a', duration_ms: 400, request_kind: 'original' },
        { attempt_id: 'b', duration_ms: 500, request_kind: 'original' },
      ] },
  });
  assert.equal(performance.cumulative_attempt_wall_time_ms, 3000);
  assert.equal(performance.provider_elapsed_time.total_ms, 900);
  assert.equal(performance.provider_elapsed_time.exact_cumulative, false);
  assert.equal(performance.between_attempt_wait_time.total_ms, 3000);
  assert.equal(performance.between_attempt_wait_time.excluded_from_provider_elapsed_time, true);
});

test('all-success and partial targeted repair preserve completed lifecycle with correct severity transitions', () => {
  const allRepaired = normalizeRunStatusReport(completed({ provider_attempt_audit: {
    unique_malformed_obligations: 100, recovered_malformed_obligations: 100,
    terminally_unresolved_malformed_obligations: 0, terminal_unresolved_obligations: [],
  } }));
  assert.equal(allRepaired.lifecycle_status, 'completed');
  assert.equal(allRepaired.outcome_status, 'completed_recovered_errors');
  assert.equal(allRepaired.run_status.label, 'Completed — recovered errors');
  const partialRepair = normalizeRunStatusReport(completed({ provider_attempt_audit: {
    unique_malformed_obligations: 100, recovered_malformed_obligations: 97,
    terminally_unresolved_malformed_obligations: 3,
    terminal_unresolved_obligations: Array.from({ length: 3 }, (_, index) => ({ root_obligation_id: `left-${index}` })),
  } }));
  assert.equal(partialRepair.lifecycle_status, 'completed');
  assert.equal(partialRepair.outcome_status, 'completed_with_errors');
  assert.equal(partialRepair.run_status.label, 'Completed with 3 errors');
});

test('legacy partial, degraded, and quality-debt labels migrate from durable evidence deterministically', () => {
  for (const legacy of [
    { status: 'partial', operational_status: 'partial', completion_quality_status: 'partial_state' },
    { status: 'degraded', operational_status: 'degraded', completion_quality_status: 'completed_with_quality_debt' },
    { status: 'completed', operational_status: 'completed', completion_quality_status: 'completed' },
  ]) {
    const report = completed({ status: legacy.status, operational_status: legacy.operational_status,
      quality: { final_integrity_status: 'clean', notices: [], completion_quality_status: legacy.completion_quality_status } });
    const once = normalizeRunStatusReport(report);
    const twice = normalizeRunStatusReport(once);
    assert.equal(once.lifecycle_status, 'completed');
    assert.deepEqual(twice.run_status, once.run_status);
    assert.equal(twice.legacy_status_compatibility.original_status, legacy.status);
  }
});
