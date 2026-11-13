import {
  applyMemorizeLifecycleEvent,
  ensureMemorizeObligationLedger,
  getCanonicalMemorizeObligation,
  projectMemorizeObligationLedger,
} from './memorize-obligation-ledger.js';
import {
  assessMemorizeRecoveryCapsule,
  createMemorizeRecoveryCapsule,
} from './memorize-recovery-capsule.js';

export const MEMORIZE_EXECUTION_KERNEL_VERSION = 1;
const TERMINAL_STATES = new Set(['durably_committed', 'explicit_no_update']);
const bounded = (items = [], maximum = 512) => items.slice(-maximum);
const unique = (items = []) => [...new Set((Array.isArray(items) ? items : [])
  .map((item) => String(item ?? '').trim()).filter(Boolean))];

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function ensureKernelState(ledger, now = Date.now()) {
  ledger.execution_kernel ??= {
    schema_version: MEMORIZE_EXECUTION_KERNEL_VERSION,
    revision: 0,
    applied_commands: {},
    attempts: {},
    recovery_capsules: {},
    semantic_events: [],
    stale_callbacks: [],
    created_at: now,
    updated_at: now,
  };
  const kernel = ledger.execution_kernel;
  kernel.schema_version = MEMORIZE_EXECUTION_KERNEL_VERSION;
  kernel.revision = Number(kernel.revision) || 0;
  kernel.applied_commands ??= {};
  kernel.attempts ??= {};
  kernel.recovery_capsules ??= {};
  kernel.semantic_events ??= [];
  kernel.stale_callbacks ??= [];
  return kernel;
}

export function createMemorizeExecutionAggregate(logicalRunId, now = Date.now()) {
  const ledger = ensureMemorizeObligationLedger(null, logicalRunId);
  ensureKernelState(ledger, now);
  return ledger;
}

export function ensureMemorizeExecutionAggregate(value, logicalRunId = null) {
  if (value == null) return createMemorizeExecutionAggregate(logicalRunId);
  const ledger = ensureMemorizeObligationLedger(value, logicalRunId);
  if (!ledger.execution_kernel) {
    const error = new Error('Memorize Chat checkpoint is missing the execution kernel.');
    error.code = 'SME_MEMORIZE_SCHEMA_UNSUPPORTED';
    error.sme_recovery_blocked = true;
    error.sme_reason_code = 'fresh_start_required';
    throw error;
  }
  ensureKernelState(ledger);
  return ledger;
}

function commandIdentity(command = {}) {
  const commandId = String(command.command_id ?? command.commandId ?? '').trim();
  const logicalRunId = String(command.logical_run_id ?? command.logicalRunId ?? '').trim();
  const leafId = String(command.obligation_leaf_id ?? command.obligationLeafId ?? '').trim();
  const attemptId = String(command.attempt_id ?? command.attemptId ?? '').trim();
  if (!commandId || !logicalRunId || !leafId || !attemptId) {
    throw Object.assign(new Error('Atomic provider completion requires command, run, leaf, and attempt identity.'), {
      code: 'SME_INVALID_PROVIDER_COMPLETION_COMMAND',
    });
  }
  return { commandId, logicalRunId, leafId, attemptId };
}

function semanticEvent(kernel, commandId, type, detail = {}) {
  kernel.semantic_events = bounded([...kernel.semantic_events, {
    sequence: kernel.revision + 1,
    command_id: commandId,
    type,
    ...detail,
  }]);
}

function applyRequiredEvent(ledger, identity, event, expectedState = null) {
  const result = applyMemorizeLifecycleEvent(ledger, identity, event);
  const state = result.obligation?.current_state ?? result.resulting_state ?? null;
  if ((result.applied !== true && result.duplicate !== true)
    || (expectedState && state !== expectedState)) {
    const error = new Error(`Atomic completion could not apply ${event.type}.`);
    error.code = 'SME_ATOMIC_PROVIDER_COMPLETION_REJECTED';
    error.sme_reason_code = result.violation?.code ?? 'canonical_transition_rejected';
    error.sme_kernel_result = result;
    throw error;
  }
  return result;
}

function normalizedParserOutcome(value = {}) {
  const status = value.status ?? 'rejected';
  return {
    status: ['accepted', 'partial', 'rejected', 'explicit_none'].includes(status)
      ? status : 'rejected',
    accepted_candidate_ids: unique(value.accepted_candidate_ids),
    rejected_fragment_ids: unique(value.rejected_fragment_ids),
    reason_code: value.reason_code ?? null,
  };
}

function normalizedValidationOutcome(value = {}) {
  const status = value.status ?? 'not_applicable';
  return {
    status: ['accepted', 'partial', 'rejected', 'not_applicable', 'validated_no_update']
      .includes(status) ? status : 'rejected',
    accepted_candidate_ids: unique(value.accepted_candidate_ids),
    rejected_candidate_ids: unique(value.rejected_candidate_ids),
    reason_code: value.reason_code ?? null,
  };
}

function normalizedPersistence(value = {}) {
  return {
    status: value.status ?? 'not_required',
    durable_record_ids: unique(value.durable_record_ids),
    durable_record_candidate_map: { ...(value.durable_record_candidate_map ?? {}) },
    source_provenance: { ...(value.source_provenance ?? {}) },
  };
}

function validateDurableMappings(parser, persistence) {
  if (!persistence.durable_record_ids.length) return;
  for (const recordId of persistence.durable_record_ids) {
    const candidateId = String(persistence.durable_record_candidate_map[recordId] ?? '').trim();
    if (!candidateId || !parser.accepted_candidate_ids.includes(candidateId)) {
      throw Object.assign(new Error('Every durable record must map to a parser-accepted candidate.'), {
        code: 'SME_DURABLE_RECORD_MAPPING_REQUIRED', record_id: recordId,
      });
    }
  }
  if (!Object.keys(persistence.source_provenance).length) {
    throw Object.assign(new Error('Durable records require source provenance.'), {
      code: 'SME_DURABLE_RECORD_PROVENANCE_REQUIRED',
    });
  }
}

/**
 * Pure atomic ingestion for one exact provider leaf and physical attempt.
 * The returned aggregate is a new value; callers persist it once.
 */
export function applyProviderCompletion(aggregateValue, command, now = Date.now()) {
  const { commandId, logicalRunId, leafId, attemptId } = commandIdentity(command);
  const aggregate = clone(ensureMemorizeExecutionAggregate(aggregateValue, logicalRunId));
  const kernel = ensureKernelState(aggregate, now);
  if (kernel.applied_commands[commandId]) return Object.freeze({
    status: 'idempotent_duplicate', mutated: false,
    aggregate: aggregateValue, receipt: clone(kernel.applied_commands[commandId]),
  });
  if (aggregate.logical_run_id && aggregate.logical_run_id !== logicalRunId) return Object.freeze({
    status: 'rejected', mutated: false, aggregate: aggregateValue,
    reason_code: 'logical_run_identity_mismatch',
  });

  const obligation = getCanonicalMemorizeObligation(aggregate, leafId, logicalRunId);
  if (!obligation) return Object.freeze({ status: 'rejected', mutated: false,
    aggregate: aggregateValue, reason_code: 'unknown_obligation_leaf' });
  if (obligation.expected_child_obligation_ids?.length) return Object.freeze({
    status: 'rejected', mutated: false, aggregate: aggregateValue,
    reason_code: 'split_parent_is_not_dispatchable',
  });
  if (TERMINAL_STATES.has(obligation.current_state)) {
    kernel.stale_callbacks = bounded([...kernel.stale_callbacks, {
      command_id: commandId, obligation_leaf_id: leafId, attempt_id: attemptId,
      reason_code: 'late_completion_for_terminal_leaf', observed_at: now,
    }], 128);
    const receipt = {
      command_id: commandId, aggregate_revision: kernel.revision + 1,
      obligation_leaf_id: leafId, attempt_id: attemptId,
      resulting_state: obligation.current_state,
      checkpoint_eligible: obligation.checkpoint_eligible === true,
      ignored: true, reason_code: 'late_completion_for_terminal_leaf', applied_at: now,
    };
    kernel.revision += 1;
    kernel.updated_at = now;
    kernel.applied_commands[commandId] = receipt;
    semanticEvent(kernel, commandId, 'late_provider_completion_ignored', receipt);
    aggregate.updated_at = now;
    return Object.freeze({ status: 'late_callback_ignored', mutated: true,
      aggregate, receipt, reason_code: 'late_completion_for_terminal_leaf' });
  }

  const sourceRange = command.source_range ?? obligation.source_range;
  const sourceFingerprint = command.source_fingerprint ?? obligation.source_fingerprint;
  const identity = {
    obligation_id: leafId,
    root_obligation_id: command.root_obligation_id
      ?? obligation.parent_obligation_id ?? leafId,
    leaf_obligation_id: leafId,
    parent_obligation_id: obligation.parent_obligation_id ?? null,
    logical_run_id: logicalRunId,
    tier: command.tier ?? obligation.tier,
    owner: command.owner ?? obligation.owner,
    source_range: sourceRange,
    source_fingerprint: sourceFingerprint,
  };
  const existingAttempt = kernel.attempts[attemptId];
  if (existingAttempt && existingAttempt.obligation_leaf_id !== leafId) return Object.freeze({
    status: 'rejected', mutated: false, aggregate: aggregateValue,
    reason_code: 'attempt_belongs_to_different_leaf',
  });

  const parser = normalizedParserOutcome(command.parser_outcome);
  const validation = normalizedValidationOutcome(command.validation_outcome);
  const persistence = normalizedPersistence(command.persistence_outcome);
  validateDurableMappings(parser, persistence);
  const attempt = kernel.attempts[attemptId] = {
    ...(existingAttempt ?? {}), attempt_id: attemptId, obligation_leaf_id: leafId,
    root_obligation_id: identity.root_obligation_id, logical_run_id: logicalRunId,
    source_range: clone(sourceRange), source_fingerprint: sourceFingerprint,
    provider_result_reference: clone(command.raw_response_reference ?? null),
    terminal_transport_status: command.transport_status ?? 'completed',
    completion_command_id: commandId, updated_at: now,
  };

  // A complete command is allowed to reconcile absent projections locally,
  // but every generated transition still uses the exact leaf and attempt.
  let current = getCanonicalMemorizeObligation(aggregate, leafId, logicalRunId);
  if (!current.provider_attempt_lineage?.includes(attemptId)) {
    applyRequiredEvent(aggregate, identity, {
      type: 'provider_attempt_started', provider_attempt_id: attemptId,
      event_id: `${commandId}:attempt`, at: now,
    }, 'provider_running');
  }
  if (command.transport_status === 'failed') {
    applyRequiredEvent(aggregate, identity, {
      type: 'provider_transport_failed', provider_attempt_id: attemptId,
      reason_code: command.reason_code ?? 'provider_transport_failure',
      next_action: command.next_action ?? 'retry_provider_with_backoff',
      event_id: `${commandId}:transport`, at: now,
    }, 'pending_recovery');
  } else {
    applyRequiredEvent(aggregate, identity, {
      type: 'provider_response_received', provider_attempt_id: attemptId,
      event_id: `${commandId}:response`, at: now,
    }, 'provider_response_received');
    const parserEvent = parser.status === 'partial' ? 'parser_partially_accepted'
      : parser.status === 'rejected' ? 'parser_rejected' : 'parser_accepted';
    const parserState = parser.status === 'partial' ? 'parser_partial'
      : parser.status === 'rejected' ? 'parser_rejected' : 'parser_accepted';
    applyRequiredEvent(aggregate, identity, {
      type: parserEvent, provider_attempt_id: attemptId,
      parser_result: parser.status,
      lifecycle: {
        parser_accepted_candidate_ids: parser.accepted_candidate_ids,
        parser_rejected_fragment_ids: parser.rejected_fragment_ids,
        unresolved_fragment_ids: parser.rejected_fragment_ids,
      }, event_id: `${commandId}:parser`, at: now,
    }, parserState);

    if (parser.status === 'rejected') {
      applyRequiredEvent(aggregate, identity, {
        type: 'recovery_required', provider_attempt_id: attemptId,
        reason_code: parser.reason_code ?? 'malformed_provider_output',
        next_action: command.next_action ?? 'dispatch_bounded_recovery_attempt',
        event_id: `${commandId}:recovery`, at: now,
      }, 'pending_recovery');
    } else {
      const validationEvent = validation.status === 'partial' ? 'validation_partially_accepted'
        : validation.status === 'rejected' ? 'validation_rejected' : 'validation_accepted';
      const validationState = validation.status === 'partial' ? 'validation_partial'
        : validation.status === 'rejected' ? 'validation_rejected' : 'validation_accepted';
      const downstreamAcceptedCandidateIds = ['accepted', 'validated_no_update']
        .includes(validation.status) && !validation.accepted_candidate_ids.length
        ? parser.accepted_candidate_ids : validation.accepted_candidate_ids;
      applyRequiredEvent(aggregate, identity, {
        type: validationEvent, provider_attempt_id: attemptId,
        downstream_validation_result: validation.status,
        lifecycle: {
          downstream_accepted_candidate_ids: downstreamAcceptedCandidateIds,
          downstream_rejected_candidate_ids: validation.rejected_candidate_ids,
        }, event_id: `${commandId}:validation`, at: now,
      }, validationState);

      if (validation.status === 'rejected') {
        applyRequiredEvent(aggregate, identity, {
          type: 'recovery_required', provider_attempt_id: attemptId,
          reason_code: validation.reason_code ?? 'provider_output_validation_rejected',
          next_action: command.next_action ?? 'dispatch_bounded_recovery_attempt',
          event_id: `${commandId}:recovery`, at: now,
        }, 'pending_recovery');
      } else if (persistence.durable_record_ids.length) {
        applyRequiredEvent(aggregate, identity, {
          type: 'records_staged', provider_attempt_id: attemptId,
          persistence_result: 'staged', event_id: `${commandId}:staged`, at: now,
        }, 'staged');
        if (parser.rejected_fragment_ids.length || command.terminal === false) {
          applyRequiredEvent(aggregate, identity, {
            type: 'recovery_required', provider_attempt_id: attemptId,
            reason_code: command.reason_code ?? 'partial_valid_output_has_unresolved_fragments',
            next_action: command.next_action ?? 'regenerate_unresolved_from_verified_source',
            lifecycle: {
              durably_persisted_record_ids: persistence.durable_record_ids,
              durable_record_candidate_map: persistence.durable_record_candidate_map,
              unresolved_fragment_ids: parser.rejected_fragment_ids,
            }, persistence_result: 'partial_records_committed',
            event_id: `${commandId}:recovery`, at: now,
          }, 'pending_recovery');
        } else {
          applyRequiredEvent(aggregate, identity, {
            type: 'records_durably_persisted', provider_attempt_id: attemptId,
            durable_record_ids: persistence.durable_record_ids,
            lifecycle: {
              durably_persisted_record_ids: persistence.durable_record_ids,
              durable_record_candidate_map: persistence.durable_record_candidate_map,
            }, persistence_result: persistence.status,
            coverage_result: 'safely_committed',
            event_id: `${commandId}:persistence`, at: now,
          }, 'durably_committed');
        }
      } else if (parser.rejected_fragment_ids.length || command.terminal === false) {
        applyRequiredEvent(aggregate, identity, {
          type: 'recovery_required', provider_attempt_id: attemptId,
          reason_code: command.reason_code ?? 'partial_output_pending',
          next_action: command.next_action ?? 'regenerate_unresolved_from_verified_source',
          lifecycle: { unresolved_fragment_ids: parser.rejected_fragment_ids },
          event_id: `${commandId}:recovery`, at: now,
        }, 'pending_recovery');
      } else {
        applyRequiredEvent(aggregate, identity, {
          type: 'explicit_no_update_accepted', provider_attempt_id: attemptId,
          parser_result: parser.status, downstream_validation_result: validation.status,
          event_id: `${commandId}:persistence`, at: now,
        }, 'explicit_no_update');
      }
    }
  }

  if (command.recovery_capsule) {
    kernel.recovery_capsules[leafId] = createMemorizeRecoveryCapsule({
      ...command.recovery_capsule,
      logical_run_id: logicalRunId,
      obligation_leaf_id: leafId,
      root_obligation_id: identity.root_obligation_id,
      tier: identity.tier, owner: identity.owner,
      source_range: sourceRange, source_fingerprint: sourceFingerprint,
      producing_attempt_id: attemptId,
      accepted_candidate_fingerprints: command.recovery_capsule.accepted_candidate_fingerprints
        ?? parser.accepted_candidate_ids,
      durable_record_ids: command.recovery_capsule.durable_record_ids
        ?? persistence.durable_record_ids,
      durable_record_candidate_map: command.recovery_capsule.durable_record_candidate_map
        ?? persistence.durable_record_candidate_map,
      rejected_fragment_ids: command.recovery_capsule.rejected_fragment_ids
        ?? parser.rejected_fragment_ids,
      created_at: now,
    });
  }
  const finalObligation = getCanonicalMemorizeObligation(aggregate, leafId, logicalRunId);
  const transportFailed = command.transport_status === 'failed';
  attempt.parser_outcome = transportFailed ? null : parser;
  attempt.validation_outcome = transportFailed ? null : validation;
  attempt.persistence_outcome = transportFailed ? null : persistence;
  attempt.terminal_disposition = finalObligation.current_state;
  const receipt = {
    command_id: commandId, aggregate_revision: kernel.revision + 1,
    obligation_leaf_id: leafId, attempt_id: attemptId,
    resulting_state: finalObligation.current_state,
    checkpoint_eligible: finalObligation.checkpoint_eligible === true,
    applied_at: now,
  };
  kernel.revision += 1;
  kernel.updated_at = now;
  kernel.applied_commands[commandId] = receipt;
  const commandIds = Object.keys(kernel.applied_commands);
  if (commandIds.length > 512) delete kernel.applied_commands[commandIds[0]];
  semanticEvent(kernel, commandId, 'provider_completion_applied', receipt);
  aggregate.updated_at = now;
  return Object.freeze({ status: 'applied', mutated: true, aggregate, receipt });
}

export function validateMemorizeExecutionAggregate(aggregateValue) {
  const aggregate = ensureMemorizeExecutionAggregate(clone(aggregateValue));
  const kernel = ensureKernelState(aggregate);
  const violations = [];
  const obligations = Object.values(aggregate.obligations ?? {});
  for (const attempt of Object.values(kernel.attempts)) {
    const owner = aggregate.obligations?.[attempt.obligation_leaf_id];
    if (!owner) violations.push({ code: 'attempt_without_obligation_leaf', attempt_id: attempt.attempt_id });
    else if (owner.expected_child_obligation_ids?.length) violations.push({
      code: 'attempt_attached_to_split_parent', attempt_id: attempt.attempt_id,
      obligation_id: owner.obligation_id,
    });
    else if (!owner.provider_attempt_lineage?.includes(attempt.attempt_id)) violations.push({
      code: 'attempt_missing_exact_leaf_lineage', attempt_id: attempt.attempt_id,
      obligation_id: owner.obligation_id,
    });
  }
  for (const parent of obligations.filter((item) => item.expected_child_obligation_ids?.length)) {
    const children = parent.expected_child_obligation_ids
      .map((id) => aggregate.obligations[id]).filter(Boolean)
      .sort((a, b) => a.source_range.start - b.source_range.start);
    for (let index = 1; index < children.length; index++) {
      if (children[index].source_range.start <= children[index - 1].source_range.end) {
        violations.push({ code: 'overlapping_frontier_children', obligation_id: parent.obligation_id });
      }
    }
  }
  const projection = projectMemorizeObligationLedger(aggregate);
  violations.push(...projection.invariants.violations);
  return Object.freeze({ valid: violations.length === 0, violations,
    kernel_revision: kernel.revision, projection });
}

export function projectMemorizeKernelStatus(aggregateValue, input = {}) {
  const aggregate = ensureMemorizeExecutionAggregate(clone(aggregateValue));
  const kernel = ensureKernelState(aggregate);
  const projection = projectMemorizeObligationLedger(aggregate);
  const pending = projection.next_eligible_obligation;
  const capsule = pending ? kernel.recovery_capsules[pending.obligation_id] ?? null : null;
  const capsuleAssessment = capsule ? assessMemorizeRecoveryCapsule(capsule) : null;
  const durableBlocker = projection.pending_obligations.find((item) => item.current_state === 'blocked');
  const nextAction = durableBlocker?.next_eligible_action
    ?? capsuleAssessment?.next_action ?? pending?.next_eligible_action ?? null;
  const executable = !durableBlocker && Boolean(pending)
    && (capsuleAssessment?.executable ?? pending?.actionability_reason === 'canonical_exact_action_available');
  const complete = projection.completion_gate_satisfied;
  const internalViolations = validateMemorizeExecutionAggregate(aggregate).violations;
  return Object.freeze({
    schema_version: 1,
    lifecycle_status: complete ? 'completed' : durableBlocker ? 'blocked'
      : executable ? 'awaiting_safe_resume' : 'incomplete',
    outcome_status: complete ? 'completed' : durableBlocker ? 'blocked_non_resumable'
      : executable ? 'resumable' : 'incomplete_non_executable',
    severity: internalViolations.length ? 'error' : durableBlocker ? 'error'
      : complete ? 'success' : 'warning',
    exact_pending_obligation: pending ?? durableBlocker ?? null,
    exact_blocker: durableBlocker?.exact_reason_code
      ?? (!complete && !executable ? capsuleAssessment?.reason_code
        ?? 'no_executable_canonical_action' : null),
    next_action: nextAction,
    action_executable: executable,
    provider_call_required: executable && (capsuleAssessment?.provider_call_required
      ?? pending?.provider_call_required === true),
    resume_enabled: executable && input.controller_active !== true,
    unresolved_application_error_count: internalViolations.length,
    recovered_error_count: Number(input.recovered_error_count) || 0,
    operational_pause_count: projection.operationally_paused_obligation_count,
    committed_coverage: projection.safely_committed_obligation_count,
    total_obligations: projection.obligation_count,
    finalization_eligible: complete && internalViolations.length === 0,
    invariant_violations: internalViolations,
    kernel_revision: kernel.revision,
  });
}

/** Non-throwing post-commit observer boundary. */
export async function observeMemorizeKernelCommit(observer, event) {
  try {
    await observer?.(clone(event));
    return Object.freeze({ observed: true, error: null });
  } catch (error) {
    return Object.freeze({ observed: false, error: {
      classification: error?.name ?? 'Error',
      message: String(error?.message ?? error ?? 'Diagnostic observer failure').slice(0, 240),
    } });
  }
}

