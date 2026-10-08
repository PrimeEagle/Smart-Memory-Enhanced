import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginProviderAttempt,
  classifyMalformedProviderOutput,
  finishProviderAttempt,
  summarizeProviderAttemptAudit,
} from '../provider-attempt-audit.js';

test('malformed output is reason-coded and a changed format repair closes the same obligation', () => {
  const metadata = { active_catchup_run_id: 'run-a' };
  const original = beginProviderAttempt(metadata, {
    tier: 'longterm', owner: 'A', logical_obligation_id: 'lt:a:0-19', request_kind: 'original',
    source_range: { start: 0, end: 19 }, source_fingerprint: 'source-a', request_signature: 'request-a',
  });
  finishProviderAttempt(metadata, original, {
    terminal_outcome: 'provider_response_malformed',
    malformed_reason: classifyMalformedProviderOutput('Here are the memories in prose.'), recoverable: true,
  });
  const repair = beginProviderAttempt(metadata, {
    tier: 'longterm', owner: 'A', logical_obligation_id: 'lt:a:0-19', request_kind: 'format_repair',
    source_range: { start: 0, end: 19 }, source_fingerprint: 'source-a', request_signature: 'request-b',
    changed_recovery_dimensions: ['prompt_schema'],
    recovery_of_attempt_id: original.attempt_id,
    repair_reason: 'prose_around_structured_output',
  });
  finishProviderAttempt(metadata, repair, { terminal_outcome: 'completed' });
  const summary = summarizeProviderAttemptAudit(metadata);
  assert.equal(summary.physical_attempts, 2);
  assert.equal(summary.unique_logical_obligations, 1);
  assert.equal(summary.recovered_malformed_obligations, 1);
  assert.equal(summary.terminally_unresolved_malformed_obligations, 0);
  assert.equal(summary.changed_recovery_dimension_counts.prompt_schema, 1);
  assert.equal(summary.repair_reason_counts.prose_around_structured_output, 1);
  assert.equal(summary.reconciliation.every_provider_attempt_has_one_terminal_category, true);
  assert.equal(summary.retained_attempts[0].recovered_by_attempt_id, repair.attempt_id);
});

test('bounded malformed retries expose unresolved churn and identical retry loops', () => {
  const metadata = { active_catchup_run_id: 'run-b' };
  for (let index = 0; index < 2; index++) {
    const attempt = beginProviderAttempt(metadata, {
      tier: 'session', logical_obligation_id: 'session:0-19', source_fingerprint: 'same', request_signature: 'same-request',
    });
    finishProviderAttempt(metadata, attempt, { terminal_outcome: 'provider_response_malformed', malformed_reason: 'truncated_json', recoverable: index === 0 });
  }
  const summary = summarizeProviderAttemptAudit(metadata);
  assert.equal(summary.malformed_physical_responses, 2);
  assert.equal(summary.terminally_unresolved_malformed_obligations, 1);
  assert.equal(summary.terminal_unresolved_obligations.length, 1);
  assert.equal(summary.terminal_unresolved_obligations[0].root_obligation_id, 'session:0-19');
  assert.equal(summary.terminal_unresolved_obligations[0].produced_no_update, true);
  assert.equal(summary.terminal_unresolved_obligations[0].targeted_replay_eligible, true);
  assert.equal(summary.coverage.source_traversal_and_generation_are_distinct, true);
  assert.equal(summary.coverage.terminal_failed_obligations, 1);
  assert.equal(summary.reconciliation.malformed_obligations_reconcile, true);
  assert.equal(summary.equivalent_retries_without_changed_dimension, 1);
  assert.equal(summary.accounting_reconciled, true);
});

test('malformed classifier distinguishes privacy-safe response-shape failures', () => {
  assert.equal(classifyMalformedProviderOutput('   '), 'empty_or_whitespace_response');
  assert.equal(classifyMalformedProviderOutput('<think>only reasoning</think>'), 'reasoning_only_response');
  assert.equal(classifyMalformedProviderOutput('{"error":{"code":"bad"}}'), 'structured_provider_error_mistaken_for_generated_content');
  assert.equal(classifyMalformedProviderOutput('{"choices":[],"usage":{}}'), 'transport_envelope_mistaken_for_model_content');
  assert.equal(classifyMalformedProviderOutput('{"items":[', { expectedFormat: 'json' }), 'truncated_json');
  assert.equal(classifyMalformedProviderOutput('Here is the result.'), 'prose_around_structured_output');
  assert.equal(classifyMalformedProviderOutput('x', { shapeFailure: 'wrong_field_types' }), 'wrong_field_types');
  assert.equal(classifyMalformedProviderOutput('x', { expectedOwnerCount: 3, observedOwnerCount: 2 }), 'partial_owner_result');
  assert.equal(classifyMalformedProviderOutput('x', { shapeFailure: 'unsupported_schema_fields' }), 'unsupported_schema_fields');
});
