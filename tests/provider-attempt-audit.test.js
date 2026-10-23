import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginProviderAttempt,
  classifyMalformedProviderOutput,
  finishProviderAttempt,
  migrateProviderAttemptAuditReport,
  PROVIDER_OBLIGATION_LIMIT,
  summarizeProviderAttemptAudit,
} from '../provider-attempt-audit.js';

test('persisted schema-three summaries reclassify strict partial inflation without losing true failures', () => {
  const migrated = migrateProviderAttemptAuditReport({
    schema_version: 3, malformed_physical_responses: 1579,
    malformed_reason_counts: { partial_valid_output: 1341, invalid_modifier_syntax: 140, repair_failure_sentinel: 98 },
    unique_malformed_obligations: 1409, recovered_malformed_obligations: 1409,
    terminally_unresolved_malformed_obligations: 0,
    recoveries_by_stage: { strict_partial_valid_preserved: 1341, changed_dimension_regeneration: 105 },
    malformed_recovery_performance: {
      obligations_recovered_by_stage: { strict_partial_valid_preserved: 1239, changed_dimension_regeneration: 101 },
      successful_physical_attempts_by_stage: { strict_partial_valid_preserved: 1341, changed_dimension_regeneration: 105 },
    },
  });
  assert.equal(migrated.schema_version, 5);
  assert.equal(migrated.malformed_physical_responses, 238);
  assert.equal(migrated.unique_malformed_obligations, 170);
  assert.equal(migrated.recovered_malformed_obligations, 170);
  assert.equal(migrated.notice_reason_counts.partial_valid_output, 1341);
  assert.equal(migrated.malformed_reason_counts.partial_valid_output, undefined);
});

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
  assert.equal(summary.recovery_effectiveness[0].attempts, 1);
  assert.equal(summary.recovery_effectiveness[0].successes, 1);
  assert.equal(summary.recovery_effectiveness[0].unique_obligations_recovered, 1);
});

test('accepted partial fragments are notices, not recovered failed obligations', () => {
  const metadata = { active_catchup_run_id: 'run-notice' };
  const attempt = beginProviderAttempt(metadata, {
    tier: 'longterm', logical_obligation_id: 'lt:notice', request_kind: 'original',
  });
  finishProviderAttempt(metadata, attempt, {
    terminal_outcome: 'completed', notice_reason: 'partial_valid_output',
    recovery_stage: 'strict_partial_valid_preserved', parser_count_consistent: true,
    response_shape: { parser_accepted_record_count: 1, structurally_rejected_record_count: 2 },
  });
  const summary = summarizeProviderAttemptAudit(metadata);
  assert.equal(summary.unique_malformed_obligations, 0);
  assert.equal(summary.recovered_malformed_obligations, 0);
  assert.equal(summary.notice_reason_counts.partial_valid_output, 1);
  assert.equal(summary.obligation_outcome_counts.partial_output_obligations, 1);
  assert.equal(summary.obligation_outcome_counts.partial_output_rejected_fragments, 2);
  assert.equal(summary.reconciliation.parser_and_structural_counts_agree, true);
});

test('safe modifier normalization is a notice with subtype effectiveness, not a failed obligation', () => {
  const metadata = { active_catchup_run_id: 'run-modifier-normalization' };
  const attempt = beginProviderAttempt(metadata, {
    tier: 'longterm', logical_obligation_id: 'lt:normalized', request_kind: 'original',
    configuration_signature: 'config-signature',
  });
  finishProviderAttempt(metadata, attempt, {
    terminal_outcome: 'completed', notice_reason: 'local_normalization:canonical_modifiers',
    recovery_stage: 'local_normalization', response_shape: {
      modifier_normalization_subtype_counts: { canonicalize_modifier_key: 2 },
      modifier_locally_normalizable_count: 2,
    },
  });
  const summary = summarizeProviderAttemptAudit(metadata);
  const stats = summary.modifier_failure_subtype_statistics.canonicalize_modifier_key;
  assert.equal(summary.failure_accounting.unique_failed_obligation_count, 0);
  assert.equal(summary.failure_accounting.local_normalization_notice_count, 1);
  assert.equal(stats.observed_count, 2);
  assert.equal(stats.locally_normalizable_count, 2);
  assert.equal(stats.local_normalization_success_count, 2);
  assert.deepEqual(stats.provider_configuration_signatures, ['config-signature']);
});

test('context repartition remains separate from malformed-output recovery', () => {
  const metadata = { active_catchup_run_id: 'run-context-repartition' };
  const attempt = beginProviderAttempt(metadata, {
    tier: 'session', logical_obligation_id: 'session:child', request_kind: 'repartition_child',
    recovery_stage: 'repartition_child', parent_attempt_id: 'parent-overflow',
  });
  finishProviderAttempt(metadata, attempt, { terminal_outcome: 'completed', recovery_stage: 'repartition_child' });
  const summary = summarizeProviderAttemptAudit(metadata);
  assert.equal(summary.unique_malformed_obligations, 0);
  assert.equal(summary.obligation_outcome_counts.context_repartition_obligations, 1);
  assert.equal(summary.outcome_taxonomy.context_repartition_requests, 1);
});

test('schema-three strict partial accounting migrates to notices once', () => {
  const metadata = { active_catchup_run_id: 'legacy', live_memory_health: { provider_attempt_audit: {
    schema_version: 3, run_id: 'legacy', sequence: 1, attempted: 1, running_count: 0,
    terminal_counts: { completed: 1 }, malformed_reason_counts: { partial_valid_output: 1 },
    request_kind_counts: { original: 1 }, repair_reason_counts: {}, changed_recovery_dimension_counts: {},
    runtime_context_lookup_counts: {}, logical_obligation_count: 1, recent_attempts: [],
    obligations: { legacy: { logical_obligation_id: 'legacy', malformed_count: 1,
      last_malformed_reason: 'partial_valid_output', final_recovery_stage: 'strict_partial_valid_preserved',
      terminal_outcome: 'completed', physical_attempt_count: 1 } },
    archived_obligation_counts: { exact: true, total: 0, malformed: 0, recovered_malformed: 0,
      safely_checkpointed: 0, valid_generation: 0, intentionally_accepted_no_update: 0,
      terminal_failed: 0, recovered_by_stage: {} }, recoveries_by_stage: { strict_partial_valid_preserved: 1 },
  } } };
  const next = beginProviderAttempt(metadata, { tier: 'session', logical_obligation_id: 'new' });
  finishProviderAttempt(metadata, next, { terminal_outcome: 'completed_no_candidates' });
  const summary = summarizeProviderAttemptAudit(metadata);
  assert.equal(summary.unique_malformed_obligations, 0);
  assert.equal(summary.notice_reason_counts.partial_valid_output, 1);
  assert.equal(summary.legacy_accounting_migration.partial_obligations_reclassified_as_notices, 1);
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

test('provider performance keeps exact cumulative request and segment accounting', () => {
  const metadata = { active_catchup_run_id: 'run-performance' };
  const attempt = beginProviderAttempt(metadata, {
    tier: 'longterm', logical_obligation_id: 'lt:a:20-39', request_kind: 'original',
    source_range: { start: 20, end: 39, message_count: 20 }, source_fingerprint: 'source-b',
  });
  finishProviderAttempt(metadata, attempt, { terminal_outcome: 'completed' });
  const summary = summarizeProviderAttemptAudit(metadata);
  assert.equal(summary.schema_version, 5);
  assert.equal(summary.performance.exact_cumulative_timing, true);
  assert.equal(summary.performance.request_counts_by_extraction_category.longterm, 1);
  assert.equal(summary.performance.source_messages_attempted, 20);
  assert.equal(summary.performance.average_source_messages_per_request, 20);
  assert.equal(summary.performance.segment_size_distribution[20], 1);
  assert.equal(summary.performance.queue_wait_time_available, false);
});

test('bounded obligation detail preserves exact aggregate counts and unresolved repair records', () => {
  const metadata = { active_catchup_run_id: 'run-bounded-obligations' };
  for (let index = 0; index < PROVIDER_OBLIGATION_LIMIT + 2; index++) {
    const attempt = beginProviderAttempt(metadata, {
      tier: 'longterm', logical_obligation_id: `lt:${index}`, request_kind: 'original',
      source_range: { start: index, end: index, message_count: 1 }, source_fingerprint: `source-${index}`,
    });
    finishProviderAttempt(metadata, attempt, index === PROVIDER_OBLIGATION_LIMIT + 1
      ? { terminal_outcome: 'provider_response_malformed', malformed_reason: 'invalid_json' }
      : { terminal_outcome: 'completed' });
  }
  const summary = summarizeProviderAttemptAudit(metadata);
  assert.equal(summary.obligation_history_truncated, true);
  assert.equal(summary.obligation_aggregate_counts_exact, true);
  assert.equal(summary.unique_logical_obligations, PROVIDER_OBLIGATION_LIMIT + 2);
  assert.equal(summary.unique_malformed_obligations, 1);
  assert.equal(summary.terminally_unresolved_malformed_obligations, 1);
  assert.equal(summary.terminal_unresolved_obligations[0].root_obligation_id,
    `lt:${PROVIDER_OBLIGATION_LIMIT + 1}`);
  assert.equal(summary.coverage.safely_checkpointed_obligations, PROVIDER_OBLIGATION_LIMIT + 2);
  assert.match(summary.reconciliation.limitation, /archived cumulative counters remain authoritative/);
});

test('supplied-run accounting shape retains 88 failure observations while automatic recovery closes the final five', () => {
  const metadata = { active_catchup_run_id: 'run-supplied-shape' };
  const unresolved = [];
  for (let index = 0; index < 88; index++) {
    const root = `longterm:owner:${index * 20}-${index * 20 + 19}`;
    const original = beginProviderAttempt(metadata, {
      tier: 'longterm', owner: 'Owner', logical_obligation_id: root,
      source_range: { start: index * 20, end: index * 20 + 19, message_count: 20 },
      source_fingerprint: `source-${index}`, request_kind: 'original',
    });
    finishProviderAttempt(metadata, original, {
      terminal_outcome: 'provider_response_malformed', malformed_reason: 'missing_tagged_records',
      recovery_stage: 'strict_generation', recoverable: true,
    });
    if (index < 83) {
      const repair = beginProviderAttempt(metadata, {
        tier: 'longterm', owner: 'Owner', logical_obligation_id: root,
        source_range: original.source_range, source_fingerprint: `source-${index}`,
        request_kind: 'format_repair', recovery_stage: 'compact_response_repair',
        recovery_of_attempt_id: original.attempt_id,
        changed_recovery_dimensions: ['malformed_response_input', 'compact_repair_prompt'],
      });
      finishProviderAttempt(metadata, repair, { terminal_outcome: 'completed' });
    } else unresolved.push({ root, source_range: original.source_range, source_fingerprint: `source-${index}` });
  }
  const before = summarizeProviderAttemptAudit(metadata);
  assert.equal(before.unique_malformed_obligations, 88);
  assert.equal(before.recovered_malformed_obligations, 83);
  assert.equal(before.terminally_unresolved_malformed_obligations, 5);
  for (const item of unresolved) {
    const sweep = beginProviderAttempt(metadata, {
      tier: 'longterm', owner: 'Owner', logical_obligation_id: item.root,
      source_range: item.source_range, source_fingerprint: item.source_fingerprint,
      request_kind: 'automatic_recovery_sweep', recovery_stage: 'changed_dimension_regeneration',
      changed_recovery_dimensions: ['automatic_end_of_source_sweep', 'fresh_recovery_budget'],
    });
    finishProviderAttempt(metadata, sweep, { terminal_outcome: 'completed' });
  }
  const after = summarizeProviderAttemptAudit(metadata);
  assert.equal(after.unique_malformed_obligations, 88);
  assert.equal(after.recovered_malformed_obligations, 88);
  assert.equal(after.terminally_unresolved_malformed_obligations, 0);
  assert.equal(after.malformed_physical_responses, 88);
  assert.equal(after.reconciliation.recovered_and_terminal_unresolved_disjoint, true);
});

test('physical failures, unique failed obligations, and recovery reconcile at their proper scopes', () => {
  const metadata = { active_catchup_run_id: 'run-accounting-scopes' };
  const obligations = [];
  for (let index = 0; index < 120; index++) {
    const root = `session:${index}`;
    obligations.push(root);
    const attempt = beginProviderAttempt(metadata, {
      tier: 'session', logical_obligation_id: root, request_kind: 'original',
      request_signature: `malformed-${index}`,
    });
    finishProviderAttempt(metadata, attempt, {
      terminal_outcome: 'provider_response_malformed', malformed_reason: 'invalid_modifier_syntax',
      response_shape: { modifier_failure_subtype_counts: { duplicate_source_modifier: 1 } },
    });
  }
  for (let index = 0; index < 14; index++) {
    const repeat = beginProviderAttempt(metadata, {
      tier: 'session', logical_obligation_id: obligations[index], request_kind: 'changed_dimension_regeneration',
      request_signature: `malformed-repeat-${index}`, changed_recovery_dimensions: ['prompt_schema'],
    });
    finishProviderAttempt(metadata, repeat, {
      terminal_outcome: 'provider_response_malformed', malformed_reason: 'invalid_modifier_syntax',
    });
  }
  const transport = beginProviderAttempt(metadata, {
    tier: 'session', logical_obligation_id: obligations[0], request_kind: 'changed_dimension_regeneration',
    request_signature: 'transport', changed_recovery_dimensions: ['fresh_request'],
  });
  finishProviderAttempt(metadata, transport, {
    terminal_outcome: 'provider_failure', failure_classification: 'provider_http_503',
  });
  for (const [index, root] of obligations.entries()) {
    const success = beginProviderAttempt(metadata, {
      tier: 'session', logical_obligation_id: root, request_kind: 'changed_dimension_regeneration',
      request_signature: `success-${index}`, changed_recovery_dimensions: ['prompt_schema'],
    });
    finishProviderAttempt(metadata, success, { terminal_outcome: 'completed' });
  }
  const summary = summarizeProviderAttemptAudit(metadata);
  assert.equal(summary.failure_accounting.physical_failure_observation_count, 135);
  assert.equal(summary.failure_accounting.unique_failed_obligation_count, 120);
  assert.equal(summary.failure_accounting.recovered_failed_obligation_count, 120);
  assert.equal(summary.failure_accounting.terminal_unresolved_obligation_count, 0);
  assert.equal(summary.failure_accounting.provider_transport_failure_count, 1);
  assert.equal(summary.provider_failure_lineage.retained[0].failure_classification, 'provider_http_503');
  assert.equal(summary.provider_failure_lineage.retained[0].affected_final_obligation_status, false);
  assert.equal(summary.reconciliation.consistent, true);
});

test('same-signature transport retry is permitted while unchanged malformed repetition remains inconsistent', () => {
  const metadata = { active_catchup_run_id: 'run-equivalence' };
  const failed = beginProviderAttempt(metadata, {
    tier: 'longterm', logical_obligation_id: 'transport-root', request_kind: 'original', request_signature: 'same',
  });
  finishProviderAttempt(metadata, failed, { terminal_outcome: 'provider_failure' });
  const retry = beginProviderAttempt(metadata, {
    tier: 'longterm', logical_obligation_id: 'transport-root', request_kind: 'original', request_signature: 'same',
  });
  finishProviderAttempt(metadata, retry, { terminal_outcome: 'completed' });
  let summary = summarizeProviderAttemptAudit(metadata);
  assert.equal(summary.equivalent_request_accounting.total_equivalent_requests, 1);
  assert.equal(summary.equivalent_request_accounting.permitted_equivalent_requests, 1);
  assert.equal(summary.equivalent_request_accounting.unexplained_equivalent_requests, 0);
  assert.equal(summary.equivalent_request_accounting.consistent, true);

  const malformed = beginProviderAttempt(metadata, {
    tier: 'session', logical_obligation_id: 'malformed-root', request_kind: 'original', request_signature: 'unchanged',
  });
  finishProviderAttempt(metadata, malformed, {
    terminal_outcome: 'provider_response_malformed', malformed_reason: 'invalid_modifier_syntax',
  });
  const unchanged = beginProviderAttempt(metadata, {
    tier: 'session', logical_obligation_id: 'malformed-root', request_kind: 'original', request_signature: 'unchanged',
  });
  finishProviderAttempt(metadata, unchanged, { terminal_outcome: 'completed' });
  summary = summarizeProviderAttemptAudit(metadata);
  assert.equal(summary.equivalent_request_accounting.unexplained_equivalent_requests, 1);
  assert.equal(summary.equivalent_request_accounting.consistent, false);
  assert.equal(summary.reconciliation.consistent, false);
});

test('restored attempts and repartition children carry explicit permitted dimensions', () => {
  const metadata = { active_catchup_run_id: 'run-restored-child' };
  const original = beginProviderAttempt(metadata, {
    tier: 'session', logical_obligation_id: 'restored-root', request_kind: 'original', request_signature: 'restored',
  });
  finishProviderAttempt(metadata, original, { terminal_outcome: 'internal_failure' });
  const restored = beginProviderAttempt(metadata, {
    tier: 'session', logical_obligation_id: 'restored-root', request_kind: 'original',
    request_signature: 'restored', restored_in_flight: true,
  });
  finishProviderAttempt(metadata, restored, { terminal_outcome: 'completed' });
  const child = beginProviderAttempt(metadata, {
    tier: 'session', logical_obligation_id: 'child-root', request_kind: 'repartition_child',
    request_signature: 'child', parent_attempt_id: original.attempt_id,
    source_range: { start: 0, end: 9, message_count: 10 },
  });
  finishProviderAttempt(metadata, child, { terminal_outcome: 'completed' });
  const summary = summarizeProviderAttemptAudit(metadata);
  assert.equal(summary.equivalent_request_accounting.reason_counts.restored_in_flight_attempt, 1);
  assert.equal(summary.equivalent_request_accounting.unexplained_equivalent_requests, 0);
  assert.ok(child.changed_recovery_dimensions.includes('source_range_repartition'));
  assert.equal(summary.reconciliation.equivalent_request_accounting_consistent, true);
});

test('checkpoint resume explicitly permits retrying one still-pending obligation', () => {
  const metadata = { active_catchup_run_id: 'run-resume' };
  const input = {
    tier: 'longterm', owner: 'Lillian Kraft', logical_obligation_id: 'longterm:lillian:20-39',
    request_kind: 'repartition_child', source_fingerprint: 'child', effective_context_limit: 10240,
    reserved_output_tokens: 600, schema_version: 'longterm-tagged-v1',
  };
  const first = beginProviderAttempt(metadata, input);
  finishProviderAttempt(metadata, first, { terminal_outcome: 'provider_response_malformed', malformed_reason: 'malformed_tag' });
  const resumed = beginProviderAttempt(metadata, { ...input, resumed_pending_obligation: true });
  finishProviderAttempt(metadata, resumed, { terminal_outcome: 'completed' });
  const summary = summarizeProviderAttemptAudit(metadata);
  assert.equal(resumed.equivalent_prior_attempt, true);
  assert.equal(resumed.equivalent_retry_permitted, true);
  assert.equal(resumed.equivalent_retry_reason, 'checkpoint_pending_obligation_retry');
  assert.equal(summary.equivalent_request_accounting.unexplained_equivalent_requests, 0);
});

test('bounded provider-failure lineage never replaces its exact aggregate', () => {
  const metadata = { active_catchup_run_id: 'run-provider-lineage-bound' };
  for (let index = 0; index < 65; index++) {
    const attempt = beginProviderAttempt(metadata, {
      tier: 'longterm', logical_obligation_id: 'one-root', request_kind: 'changed_dimension_regeneration',
      request_signature: `failure-${index}`, changed_recovery_dimensions: ['fresh_transport_attempt'],
    });
    finishProviderAttempt(metadata, attempt, {
      terminal_outcome: 'provider_failure', failure_classification: 'provider_transport_failure',
    });
  }
  const success = beginProviderAttempt(metadata, {
    tier: 'longterm', logical_obligation_id: 'one-root', request_kind: 'changed_dimension_regeneration',
    request_signature: 'success', changed_recovery_dimensions: ['fresh_transport_attempt'],
  });
  finishProviderAttempt(metadata, success, { terminal_outcome: 'completed' });
  const summary = summarizeProviderAttemptAudit(metadata);
  assert.equal(summary.provider_failure_lineage.exact_count, 65);
  assert.equal(summary.provider_failure_lineage.retained.length, 64);
  assert.equal(summary.provider_failure_lineage.details_pruned_or_legacy, true);
  assert.equal(summary.failure_accounting.unique_failed_obligation_count, 1);
  assert.equal(summary.failure_accounting.recovered_failed_obligation_count, 1);
});
