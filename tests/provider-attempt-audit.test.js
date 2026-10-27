import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginProviderAttempt,
  classifyMalformedProviderOutput,
  finishProviderAttempt,
  markProviderPartialRecordsPersisted,
  markProviderStagedRecoveryCompleted,
  migrateProviderAttemptAuditReport,
  PROVIDER_OBLIGATION_LIMIT,
  readProviderRecoveryWindowState,
  stageProviderPartialRecovery,
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
  assert.equal(migrated.schema_version, 8);
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

test('bounded malformed retries classify a pending-obligation replay explicitly', () => {
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
  assert.equal(summary.equivalent_retries_without_changed_dimension, 0);
  assert.equal(summary.equivalent_request_accounting.reason_counts.checkpoint_pending_obligation_retry, 1);
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
  assert.equal(summary.schema_version, 8);
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

test('same-signature transport and pending-obligation replays are both explicitly permitted', () => {
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
  assert.equal(summary.equivalent_request_accounting.unexplained_equivalent_requests, 0);
  assert.equal(summary.equivalent_request_accounting.reason_counts.checkpoint_pending_obligation_retry, 1);
  assert.equal(summary.equivalent_request_accounting.consistent, true);
  assert.equal(summary.reconciliation.consistent, true);
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
  assert.equal(resumed.recovery_replay_count, 1);
});

test('an exhausted minimal stage selects the new unit fallback, whose exhaustion becomes blocked', () => {
  const metadata = { active_catchup_run_id: 'run-loop' };
  const input = {
    tier: 'session', logical_obligation_id: 'session:chat:20-39:source',
    request_kind: 'minimal_record_regeneration', source_fingerprint: 'source',
    configuration_signature: 'config', changed_recovery_dimensions: ['single_record_contract'],
  };
  const minimal = beginProviderAttempt(metadata, input);
  finishProviderAttempt(metadata, minimal, {
      terminal_outcome: 'provider_response_malformed', malformed_reason: 'malformed_tag',
      recovery_stage: 'minimal_record_regeneration', recovery_ladder_terminal: true,
      requested_output_format: 'session_minimal_tagged_record_v1', actual_output_format: 'tagged_lines',
      parser_selected: 'strict_tagged', output_contract_followed: true,
      strict_parse_result: 'rejected', total_candidate_count: 2,
      accepted_candidate_count: 1, rejected_candidate_count: 1,
      rejection_reasons: ['unsupported_modifier_key'], missing_required_results: true,
      accepted_partial_output_persisted: true,
  });
  let unresolved = summarizeProviderAttemptAudit(metadata).terminal_unresolved_obligations[0];
  assert.equal(unresolved.recovery_blocked, false);
  assert.equal(unresolved.next_eligible_recovery_action, 'single_source_unit_regeneration');

  const unit = beginProviderAttempt(metadata, {
    ...input, request_kind: 'single_source_unit_regeneration',
    recovery_stage: 'single_source_unit_regeneration', source_unit_key: '20',
    expected_output_format: 'session_single_source_unit_v1',
    changed_recovery_dimensions: ['source_unit', 'single_record_contract'],
  });
  finishProviderAttempt(metadata, unit, {
    terminal_outcome: 'provider_response_malformed', malformed_reason: 'malformed_tag',
    recovery_stage: 'single_source_unit_regeneration', recovery_ladder_terminal: true,
    accepted_candidate_count: 0, rejected_candidate_count: 1,
    rejection_reasons: ['malformed_tag'], missing_required_results: true,
  });
  unresolved = summarizeProviderAttemptAudit(metadata).terminal_unresolved_obligations[0];
  assert.equal(unresolved.terminal_signature_repeat_count, 1);
  assert.equal(unresolved.recovery_blocked, true);
  assert.equal(unresolved.next_eligible_recovery_action, 'change_provider_configuration_or_install_updated_build');
  assert.equal(unresolved.retry_replay_count, 0);
  assert.equal(unresolved.last_response_contract.requested_output_format, 'session_single_source_unit_v1');
  assert.deepEqual(unresolved.last_response_contract.rejection_reasons, ['malformed_tag']);

  const changed = beginProviderAttempt(metadata, {
    ...input, configuration_signature: 'changed-config', resumed_pending_obligation: true,
  });
  finishProviderAttempt(metadata, changed, {
    terminal_outcome: 'provider_response_malformed', malformed_reason: 'malformed_tag',
    recovery_stage: 'minimal_record_regeneration', recovery_ladder_terminal: true,
    accepted_candidate_count: 0, rejected_candidate_count: 1,
  });
  const afterChange = summarizeProviderAttemptAudit(metadata).terminal_unresolved_obligations[0];
  assert.equal(afterChange.terminal_signature_repeat_count, 1);
  assert.equal(afterChange.recovery_blocked, false);
});

test('valid partial records can be marked durable without falsely closing coverage', () => {
  const metadata = { active_catchup_run_id: 'run-partial-persist' };
  const attempt = beginProviderAttempt(metadata, {
    tier: 'session', logical_obligation_id: 'session:partial', request_kind: 'structured_json_regeneration',
  });
  finishProviderAttempt(metadata, attempt, {
    terminal_outcome: 'partial_output_pending', malformed_reason: 'partial_valid_output',
    total_candidate_count: 2, accepted_candidate_count: 1, rejected_candidate_count: 1,
    missing_required_results: true,
  });
  assert.equal(markProviderPartialRecordsPersisted(metadata, 'session:partial', 3), true);
  const unresolved = summarizeProviderAttemptAudit(metadata).terminal_unresolved_obligations[0];
  assert.equal(unresolved.accepted_partial_record_count, 1);
  assert.equal(unresolved.last_response_contract.accepted_partial_output_persisted, true);
  assert.equal(unresolved.last_response_contract.total_candidate_count, 2);
  assert.equal(unresolved.last_response_contract.accepted_candidate_count, 1);
  assert.equal(unresolved.last_response_contract.rejected_candidate_count, 1);
  assert.equal(unresolved.last_response_contract.durable_partial_record_count, 3);
  assert.equal(unresolved.final_disposition, 'partial_output_pending');
});

test('single-source partial records survive restore, deduplicate, and close only after canonical persistence', () => {
  const metadata = { active_catchup_run_id: 'run-durable-unit' };
  const obligationId = 'longterm:nyx watson:60-79:fnv1a-11a50c71';
  const sourceFingerprint = 'fnv1a-5fba3507';
  const attempt = beginProviderAttempt(metadata, {
    tier: 'longterm', owner: 'Nyx Watson', logical_obligation_id: obligationId,
    request_kind: 'single_source_unit_regeneration', recovery_stage: 'single_source_unit_regeneration',
    source_fingerprint: sourceFingerprint, source_unit_key: '65', configuration_signature: 'fnv1a-e735d208',
  });
  finishProviderAttempt(metadata, attempt, {
    terminal_outcome: 'partial_output_pending', source_unit_completed: true,
    recovery_stage: 'single_source_unit_regeneration', accepted_candidate_count: 1,
  });
  const record = { type: 'fact', content: 'A supported unit.', source_message_indices: [5] };
  assert.equal(stageProviderPartialRecovery(metadata, obligationId, sourceFingerprint, [record], {
    source_unit_key: '65', producing_attempt_id: attempt.attempt_id,
    recovery_stage: 'single_source_unit_regeneration', owner: 'Nyx Watson', tier: 'longterm',
  }), true);
  stageProviderPartialRecovery(metadata, obligationId, sourceFingerprint, [record], {
    source_unit_key: '65', producing_attempt_id: attempt.attempt_id,
    recovery_stage: 'single_source_unit_regeneration', owner: 'Nyx Watson', tier: 'longterm',
  });
  const restored = readProviderRecoveryWindowState(metadata, obligationId, sourceFingerprint);
  assert.equal(restored.resume_unresolved_obligation, true);
  assert.equal(restored.staged_partial_records.length, 1);
  assert.deepEqual(restored.completed_source_units, ['65']);
  assert.equal(summarizeProviderAttemptAudit(metadata).terminal_unresolved_obligations.length, 1);
  assert.equal(markProviderStagedRecoveryCompleted(metadata, obligationId, sourceFingerprint, 1), true);
  assert.equal(summarizeProviderAttemptAudit(metadata).terminal_unresolved_obligations.length, 0);
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

test('schema-eight migration reopens an exhausted v0.9.63 unit window exactly once', () => {
  const metadata = { active_catchup_run_id: 'run-v063', live_memory_health: {
    provider_attempt_audit: {
      schema_version: 7, run_id: 'run-v063', sequence: 1, attempted: 1, running_count: 0,
      logical_obligation_count: 1, terminal_counts: { provider_response_malformed: 1 },
      malformed_reason_counts: { invalid_modifier_syntax: 1 }, request_kind_counts: {},
      repair_reason_counts: {}, changed_recovery_dimension_counts: {}, runtime_context_lookup_counts: {},
      obligations: { root: {
        logical_obligation_id: 'root', tier: 'longterm', owner: 'Lillian Kraft',
        terminal_outcome: 'provider_response_malformed', malformed_count: 1,
        root_source_fingerprint: 'root-fingerprint', last_source_fingerprint: 'root-fingerprint',
        recovery_windows: { 'root-fingerprint': {
          source_fingerprint: 'root-fingerprint',
          recovery_stages_attempted: ['minimal_record_regeneration', 'single_source_unit_regeneration'],
          exhausted_stages: ['minimal_record_regeneration', 'single_source_unit_regeneration'],
          unresolved_semantic_units: ['80', '81', '82', '83', '84'], completed_source_units: [],
          staged_partial_records: [], candidate_rejections: [],
        } },
      } }, recent_attempts: [],
    },
  } };
  const restored = readProviderRecoveryWindowState(metadata, 'root', 'root-fingerprint');
  assert.equal(restored.implementation_version_changed, true);
  let unresolved = summarizeProviderAttemptAudit(metadata).terminal_unresolved_obligations[0];
  assert.equal(unresolved.recovery_blocked, false);
  assert.equal(unresolved.next_eligible_recovery_action, 'single_source_unit_regeneration');

  const attempt = beginProviderAttempt(metadata, {
    tier: 'longterm', logical_obligation_id: 'root', source_fingerprint: 'root-fingerprint',
    request_kind: 'single_source_unit_regeneration', recovery_stage: 'single_source_unit_regeneration',
    source_unit_key: '80', target_source_unit: '80', target_source_fingerprint: 'unit-80',
    context_source_range: { start: 80, end: 84, message_count: 5 }, context_message_count: 5,
    permitted_citation_indexes: [0], context_only_messages_eligible: false,
  });
  finishProviderAttempt(metadata, attempt, {
    terminal_outcome: 'provider_response_malformed', malformed_reason: 'invalid_modifier_syntax',
    recovery_stage: 'single_source_unit_regeneration', recovery_ladder_terminal: true,
    total_candidate_count: 1, accepted_candidate_count: 0, rejected_candidate_count: 1,
    cardinality_followed: true, citation_requirement_followed: true,
    target_source_unit: '80', target_source_fingerprint: 'unit-80',
    actual_citation_indexes: [0], accepted_record_cites_target: false,
    unresolved_semantic_units: ['80', '81', '82', '83', '84'], source_unit_key: '80',
  });
  const window = readProviderRecoveryWindowState(metadata, 'root', 'root-fingerprint');
  assert.equal(window.recovery_implementation_version, 3);
  assert.equal(window.unit_obligations['80'].disposition, 'blocked_validation');
  assert.equal(window.unit_obligations['80'].candidate_accounting_consistent, true);
  unresolved = summarizeProviderAttemptAudit(metadata).terminal_unresolved_obligations[0];
  assert.equal(unresolved.recovery_blocked, false);
  assert.deepEqual(unresolved.recovery_eligibility.unattempted_semantic_units, ['81', '82', '83', '84']);
  const comparison = summarizeProviderAttemptAudit(metadata).malformed_output_amplification_comparison;
  assert.deepEqual(comparison.pre_v2, {
    physical_requests: 1, malformed_responses: 1, malformed_response_rate: 1,
    extra_requests: 0,
  });
  assert.equal(comparison.v2_and_later.physical_requests, 1);
  assert.equal(comparison.v2_and_later.malformed_responses, 1);
  assert.equal(comparison.v2_and_later.malformed_response_rate, 1);
});
