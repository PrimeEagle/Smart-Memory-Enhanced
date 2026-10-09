/** Bounded, content-free accounting for actual Long-Term/Session provider calls. */
export const PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION = 1;
export const PROVIDER_ATTEMPT_EVENT_LIMIT = 160;
// Large enough to retain every root obligation in the supplied 9,434-message
// replay while remaining explicitly bounded for arbitrarily large chats.
export const PROVIDER_OBLIGATION_LIMIT = 4096;

const count = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

function fingerprint(value) {
  let hash = 2166136261;
  for (const character of String(value ?? '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}

export function providerConfigurationSignature(input = {}) {
  return fingerprint(JSON.stringify({
    connection_profile_id: input.connection_profile_id ?? null,
    model: input.model ?? null,
    source: input.source ?? null,
    response_length: input.response_length ?? null,
    context_length: input.context_length ?? null,
  }));
}

function ensure(metadata, runId = null) {
  metadata.live_memory_health ??= {};
  const health = metadata.live_memory_health;
  const prior = health.provider_attempt_audit;
  if (!prior || (runId && prior.run_id !== runId)) {
    health.provider_attempt_audit = {
      schema_version: PROVIDER_ATTEMPT_AUDIT_SCHEMA_VERSION,
      run_id: runId,
      sequence: 0,
      attempted: 0,
      terminal_counts: {},
      malformed_reason_counts: {},
      request_kind_counts: {},
      repair_reason_counts: {},
      changed_recovery_dimension_counts: {},
      runtime_context_lookup_counts: {},
      overflow_despite_valid_learned_limit_count: 0,
      local_preflight_underestimate_count: 0,
      equivalent_retry_count: 0,
      logical_obligation_count: 0,
      obligations: {},
      recent_attempts: [],
      running_count: 0,
    };
  }
  return health.provider_attempt_audit;
}

export function classifyMalformedProviderOutput(response, {
  expectedFormat = 'tagged_records',
  shapeFailure = null,
  expectedOwnerCount = null,
  observedOwnerCount = null,
} = {}) {
  const normalizedShapeFailure = String(shapeFailure ?? '').trim().toLowerCase();
  const supportedShapeFailures = new Set([
    'wrong_field_types', 'partial_owner_result', 'unsupported_schema_fields',
    'structured_provider_error_mistaken_for_generated_content',
  ]);
  if (supportedShapeFailures.has(normalizedShapeFailure)) return normalizedShapeFailure;
  if (Number.isFinite(expectedOwnerCount) && Number.isFinite(observedOwnerCount)
    && observedOwnerCount < expectedOwnerCount) return 'partial_owner_result';
  const text = typeof response === 'string' ? response.trim() : '';
  if (!text) return 'empty_or_whitespace_response';
  if (/^(?:<analysis>|<think>)[\s\S]*?(?:<\/analysis>|<\/think>)?$/i.test(text)) return 'reasoning_only_response';
  if (/^\s*\{[\s\S]*"error"\s*:\s*\{/i.test(text)) return 'structured_provider_error_mistaken_for_generated_content';
  if (/^\s*\{[\s\S]*"(?:choices|usage)"\s*:/i.test(text)) return 'transport_envelope_mistaken_for_model_content';
  if (expectedFormat === 'json') {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return 'missing_required_top_level_structure';
      return 'unsupported_schema_fields';
    } catch {
      if (/^[^{]*\{[\s\S]*\}[^}]*$/.test(text)) return 'prose_around_json';
      if (/^[\[{]/.test(text) && !/[\]}]\s*$/.test(text)) return 'truncated_json';
      return 'invalid_json';
    }
  }
  if (/^[\[{]/.test(text)) {
    try { JSON.parse(text); return 'wrong_top_level_structure'; }
    catch { return /[\]}]\s*$/.test(text) ? 'invalid_json' : 'truncated_json'; }
  }
  if (!/^\s*\[[^\]\r\n:]+(?::[^\]\r\n]*)?\]/m.test(text)) {
    return /\b(?:here(?:'s| is)|result|response|memory|summary)\b/i.test(text)
      ? 'prose_around_structured_output' : 'missing_required_top_level_structure';
  }
  return 'wrong_field_types_or_unsupported_schema';
}

export function beginProviderAttempt(metadata, input = {}) {
  if (!metadata) return null;
  const audit = ensure(metadata, input.run_id ?? metadata.active_catchup_run_id ?? null);
  audit.sequence++;
  audit.attempted++;
  audit.running_count++;
  const obligationId = input.logical_obligation_id ?? fingerprint([
    input.tier, input.owner, input.root_source_fingerprint ?? input.source_fingerprint,
    input.root_source_start, input.root_source_end,
  ].join('|'));
  const signature = input.request_signature ?? fingerprint([
    obligationId, input.source_fingerprint, input.request_kind, input.effective_context_limit,
    input.reserved_output_tokens, input.schema_version,
  ].join('|'));
  const priorEquivalent = [...audit.recent_attempts].reverse().find((item) =>
    item.logical_obligation_id === obligationId && item.request_signature === signature);
  const isNewObligation = !audit.obligations[obligationId];
  const obligation = audit.obligations[obligationId] ?? {
    logical_obligation_id: obligationId,
    tier: input.tier ?? 'unknown', owner: input.owner ?? null,
    root_source_range: input.root_source_range ?? input.source_range ?? null,
    root_source_fingerprint: input.root_source_fingerprint ?? input.source_fingerprint ?? null,
    chat_id: input.chat_id ?? null,
    configuration_signature: input.configuration_signature ?? null,
    physical_attempt_count: 0, malformed_count: 0, terminal_outcome: 'running',
  };
  obligation.configuration_signature ??= input.configuration_signature ?? null;
  obligation.chat_id ??= input.chat_id ?? null;
  if (isNewObligation) audit.logical_obligation_count = count(audit.logical_obligation_count) + 1;
  obligation.physical_attempt_count++;
  obligation.last_attempt_at = Date.now();
  audit.obligations[obligationId] = obligation;
  const keys = Object.keys(audit.obligations);
  if (keys.length > PROVIDER_OBLIGATION_LIMIT) delete audit.obligations[keys[0]];
  const event = {
    attempt_id: `provider-${Date.now().toString(36)}-${audit.sequence}`,
    at: Date.now(), run_id: audit.run_id, logical_obligation_id: obligationId,
    tier: input.tier ?? 'unknown', owner: input.owner ?? null,
    request_kind: input.request_kind ?? 'original',
    parent_attempt_id: input.parent_attempt_id ?? null,
    repartition_parent_id: input.repartition_parent_id ?? null,
    source_range: input.source_range ?? null,
    source_fingerprint: input.source_fingerprint ?? null,
    request_signature: signature,
    equivalent_prior_attempt: Boolean(priorEquivalent),
    changed_recovery_dimensions: [...new Set(input.changed_recovery_dimensions ?? [])].slice(0, 8),
    recovery_of_attempt_id: input.recovery_of_attempt_id ?? null,
    repair_reason: input.repair_reason ?? null,
    configured_context_limit: input.configured_context_limit ?? null,
    effective_context_limit: input.effective_context_limit ?? null,
    context_limit_source: input.context_limit_source ?? null,
    runtime_context_lookup_status: input.runtime_context_lookup_status ?? null,
    reserved_output_tokens: input.reserved_output_tokens ?? null,
    safety_margin: input.safety_margin ?? null,
    protocol_overhead: input.protocol_overhead ?? null,
    estimated_input_tokens: input.estimated_input_tokens ?? null,
    estimated_final_request_tokens: input.estimated_final_request_tokens ?? null,
    terminal_outcome: 'running',
  };
  if (!obligation.original_attempt_id && event.request_kind === 'original') obligation.original_attempt_id = event.attempt_id;
  if (event.request_kind === 'format_repair') obligation.repair_attempt_id = event.attempt_id;
  audit.request_kind_counts[event.request_kind] = count(audit.request_kind_counts[event.request_kind]) + 1;
  if (event.runtime_context_lookup_status) {
    audit.runtime_context_lookup_counts[event.runtime_context_lookup_status] = count(audit.runtime_context_lookup_counts[event.runtime_context_lookup_status]) + 1;
  }
  if (event.repair_reason) audit.repair_reason_counts[event.repair_reason] = count(audit.repair_reason_counts[event.repair_reason]) + 1;
  if (event.equivalent_prior_attempt && event.changed_recovery_dimensions.length === 0) audit.equivalent_retry_count++;
  for (const dimension of event.changed_recovery_dimensions) {
    audit.changed_recovery_dimension_counts[dimension] = count(audit.changed_recovery_dimension_counts[dimension]) + 1;
  }
  audit.recent_attempts.push(event);
  audit.recent_attempts = audit.recent_attempts.slice(-PROVIDER_ATTEMPT_EVENT_LIMIT);
  return event;
}

export function finishProviderAttempt(metadata, event, patch = {}) {
  if (!metadata || !event || event.terminal_outcome !== 'running') return event;
  const audit = ensure(metadata, event.run_id ?? metadata.active_catchup_run_id ?? null);
  event.terminal_outcome = patch.terminal_outcome ?? 'internal_failure';
  event.malformed_reason = patch.malformed_reason ?? null;
  event.provider_reported_prompt_tokens = patch.provider_reported_prompt_tokens ?? null;
  event.provider_reported_context_tokens = patch.provider_reported_context_tokens ?? null;
  event.local_preflight_underestimated_provider_prompt_total = Number.isFinite(Number(event.provider_reported_prompt_tokens))
    && Number.isFinite(Number(event.estimated_final_request_tokens))
    ? Number(event.provider_reported_prompt_tokens) > Number(event.estimated_final_request_tokens) : null;
  event.overflow_despite_valid_learned_limit = event.terminal_outcome === 'context_overflow_repartitioned'
    && event.runtime_context_lookup_status === 'hit';
  if (event.local_preflight_underestimated_provider_prompt_total === true) audit.local_preflight_underestimate_count++;
  if (event.overflow_despite_valid_learned_limit === true) audit.overflow_despite_valid_learned_limit_count++;
  event.recoverable = patch.recoverable ?? null;
  event.duration_ms = Math.max(0, Date.now() - event.at);
  audit.running_count = Math.max(0, count(audit.running_count) - 1);
  audit.terminal_counts[event.terminal_outcome] = count(audit.terminal_counts[event.terminal_outcome]) + 1;
  const obligation = audit.obligations[event.logical_obligation_id];
  if (obligation) {
    obligation.terminal_outcome = event.terminal_outcome;
    obligation.last_attempt_id = event.attempt_id;
    obligation.last_source_range = event.source_range ?? obligation.root_source_range ?? null;
    obligation.last_source_fingerprint = event.source_fingerprint ?? obligation.root_source_fingerprint ?? null;
    obligation.prior_authoritative_memory_preserved = patch.prior_authoritative_memory_preserved ?? true;
    obligation.produced_no_update = patch.produced_no_update
      ?? !['completed', 'completed_repartitioned'].includes(event.terminal_outcome);
    obligation.targeted_replay_eligible = patch.targeted_replay_eligible
      ?? Boolean(event.malformed_reason || String(event.terminal_outcome).includes('malformed'));
    obligation.final_disposition = patch.final_disposition ?? event.terminal_outcome;
    if (event.malformed_reason) {
      obligation.malformed_count++;
      obligation.last_malformed_reason = event.malformed_reason;
    }
  }
  if (event.malformed_reason) {
    audit.malformed_reason_counts[event.malformed_reason] = count(audit.malformed_reason_counts[event.malformed_reason]) + 1;
  }
  if (['completed', 'completed_no_candidates', 'completed_repartitioned'].includes(event.terminal_outcome)) {
    for (const prior of audit.recent_attempts) {
      if (prior === event || prior.logical_obligation_id !== event.logical_obligation_id || !prior.malformed_reason || prior.recovered_by_attempt_id) continue;
      prior.recovered_by_attempt_id = event.attempt_id;
      prior.recovery_same_source_fingerprint = prior.source_fingerprint === event.source_fingerprint;
    }
  }
  return event;
}

export function summarizeProviderAttemptAudit(metadata) {
  const audit = metadata?.live_memory_health?.provider_attempt_audit;
  if (!audit) return null;
  const obligations = Object.values(audit.obligations ?? {});
  const malformed = obligations.filter((item) => item.malformed_count > 0);
  const recovered = malformed.filter((item) => ['completed', 'completed_no_candidates', 'completed_repartitioned'].includes(item.terminal_outcome));
  const unresolved = malformed.filter((item) => !['completed', 'completed_no_candidates', 'completed_repartitioned'].includes(item.terminal_outcome));
  const terminalTotal = Object.values(audit.terminal_counts ?? {}).reduce((sum, value) => sum + count(value), 0);
  const planned = count(audit.logical_obligation_count) || obligations.length;
  return {
    schema_version: audit.schema_version,
    scope: 'longterm_and_session_extraction_provider_calls',
    definitions: {
      logical_obligation: 'one tier-owner-root-source requirement',
      physical_attempt: 'one request sent to the provider',
      repartition_child: 'a smaller source window linked to one root obligation',
      repair_request: 'a request that changes format/schema instructions without repeating extraction intent',
    },
    physical_attempts: audit.attempted,
    terminal_attempts: terminalTotal,
    running_attempts: audit.running_count,
    accounting_reconciled: terminalTotal + count(audit.running_count) === count(audit.attempted),
    terminal_counts: { ...audit.terminal_counts },
    request_kind_counts: { ...audit.request_kind_counts },
    repair_reason_counts: { ...audit.repair_reason_counts },
    unique_logical_obligations: planned,
    malformed_physical_responses: Object.values(audit.malformed_reason_counts ?? {}).reduce((sum, value) => sum + count(value), 0),
    malformed_reason_counts: { ...audit.malformed_reason_counts },
    unique_malformed_obligations: malformed.length,
    recovered_malformed_obligations: recovered.length,
    terminally_unresolved_malformed_obligations: malformed.length - recovered.length,
    terminal_unresolved_obligations: unresolved.slice(-64).map((item) => {
      const retainedAttempts = audit.recent_attempts.filter((attempt) => attempt.logical_obligation_id === item.logical_obligation_id);
      return {
        tier: item.tier ?? 'unknown', owner: item.owner ?? null,
        source_range: item.last_source_range ?? item.root_source_range ?? null,
        source_fingerprint: item.last_source_fingerprint ?? item.root_source_fingerprint ?? null,
        root_obligation_id: item.logical_obligation_id,
        chat_id: item.chat_id ?? null,
        configuration_signature: item.configuration_signature ?? null,
        original_attempt_id: item.original_attempt_id
          ?? retainedAttempts.find((attempt) => attempt.request_kind === 'original')?.attempt_id ?? null,
        repair_attempt_id: item.repair_attempt_id
          ?? retainedAttempts.findLast((attempt) => attempt.request_kind === 'format_repair')?.attempt_id ?? null,
        malformed_reason: item.last_malformed_reason ?? null,
        prior_authoritative_memory_preserved: item.prior_authoritative_memory_preserved !== false,
        produced_no_update: item.produced_no_update !== false,
        targeted_replay_eligible: item.targeted_replay_eligible !== false,
        final_disposition: item.final_disposition ?? item.terminal_outcome ?? 'terminal_malformed_unresolved',
        attempt_lineage_available: Boolean(item.original_attempt_id || retainedAttempts.length),
      };
    }),
    terminal_unresolved_obligation_detail_limit: 64,
    recovery_success_rate: malformed.length ? recovered.length / malformed.length : 1,
    equivalent_retries_without_changed_dimension: audit.equivalent_retry_count,
    changed_recovery_dimension_counts: { ...audit.changed_recovery_dimension_counts },
    runtime_context_lookup_counts: { ...audit.runtime_context_lookup_counts },
    local_preflight_underestimated_provider_prompt_total: count(audit.local_preflight_underestimate_count),
    overflow_despite_valid_learned_limit: count(audit.overflow_despite_valid_learned_limit_count),
    extra_requests_caused_by_recovery: Math.max(0, count(audit.attempted) - planned),
    request_amplification: planned ? count(audit.attempted) / planned : 0,
    retained_attempt_scope: `last_${PROVIDER_ATTEMPT_EVENT_LIMIT}_attempts`,
    retained_attempts: audit.recent_attempts,
    retained_obligation_count: obligations.length,
    obligation_history_truncated: planned > obligations.length,
    reconciliation: {
      every_provider_attempt_has_one_terminal_category: terminalTotal === count(audit.attempted) && count(audit.running_count) === 0,
      running_attempts: count(audit.running_count),
      repartition_children_without_parent_lineage: audit.recent_attempts.filter((item) => item.request_kind === 'repartition_child'
        && !item.parent_attempt_id && !item.repartition_parent_id).length,
      accepted_outputs_without_known_obligation: audit.recent_attempts.filter((item) =>
        ['completed', 'completed_no_candidates'].includes(item.terminal_outcome)
        && !item.logical_obligation_id).length,
      equivalent_requests_without_changed_recovery_dimension: count(audit.equivalent_retry_count),
      malformed_obligations_reconcile: malformed.length === recovered.length + unresolved.length,
      repair_attempts_with_failed_attempt_link: audit.recent_attempts.filter((item) => item.request_kind === 'format_repair'
        && !item.recovery_of_attempt_id && !item.parent_attempt_id).length === 0,
      source_traversal_coverage_scope: 'checkpointed_source_ranges',
      valid_generation_coverage_scope: 'logical_obligations_with_valid_terminal_output',
      limitation: planned > obligations.length
        ? 'obligation_detail_retention_is_bounded; cumulative counters remain authoritative'
        : null,
    },
    coverage: {
      source_traversal_obligations: planned,
      safely_checkpointed_obligations: obligations.filter((item) => item.terminal_outcome !== 'running').length,
      valid_generation_obligations: obligations.filter((item) => ['completed', 'completed_repartitioned'].includes(item.terminal_outcome)).length,
      intentionally_accepted_no_update_obligations: obligations.filter((item) => item.terminal_outcome === 'completed_no_candidates').length,
      terminal_failed_obligations: obligations.filter((item) => !['running', 'completed', 'completed_no_candidates', 'completed_repartitioned'].includes(item.terminal_outcome)).length,
      source_traversal_and_generation_are_distinct: true,
    },
  };
}
