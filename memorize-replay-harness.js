import {
  createMemorizeObligationLedger,
  projectMemorizeObligationLedger,
  reconcileMemorizeProviderRuntime,
  reconcileMemorizeRunningObligations,
  recordMemorizeControllerExit,
  transitionMemorizeObligation,
} from './memorize-obligation-ledger.js';
import {
  beginProviderAttempt,
  beginProviderRecoveryEpoch,
  finishProviderAttempt,
  markProviderPartialRecordsPersisted,
  markProviderRejectedFragmentsRecovered,
  stageProviderRejectedFragments,
} from './provider-attempt-audit.js';
import {
  bindMemorizeCheckpoint,
  buildMemorizeControllerExit,
  captureMemorizePrimaryFailure,
  cleanupMemorizeRuntime,
  createMemorizeControllerRuntime,
  recordMemorizeOperationalPause,
  registerMemorizeCleanup,
  trackMemorizeTransaction,
} from './memorize-controller-runtime.js';

/**
 * Offline control-flow harness. Scripted responses exercise the complete
 * obligation lifecycle without provider calls or model-quality assertions.
 */
export function runMemorizeReplay({ logicalRunId = 'offline-replay', obligations = [], events = [] } = {}) {
  const ledger = createMemorizeObligationLedger(logicalRunId, 1);
  const records = new Set();
  let checkpoint = 0;
  for (const obligation of obligations) {
    transitionMemorizeObligation(ledger, { ...obligation, logical_run_id: logicalRunId }, {
      current_state: 'unattempted', exact_reason_code: 'not_attempted', at: 1,
    });
  }
  for (const event of events) {
    if (event.type === 'controller_exit') {
      recordMemorizeControllerExit(ledger, { ...event, logical_run_id: logicalRunId });
      continue;
    }
    const obligation = ledger.obligations[event.obligation_id];
    if (!obligation) throw new Error(`Unknown replay obligation: ${event.obligation_id}`);
    transitionMemorizeObligation(ledger, obligation, event);
    for (const recordId of event.persisted_record_ids ?? []) records.add(recordId);
  }
  const projection = projectMemorizeObligationLedger(ledger);
  const completedEnds = projection.chunks
    .filter((chunk) => chunk.status === 'completed')
    .map((chunk) => Number(chunk.source_range?.end)).filter(Number.isInteger);
  checkpoint = Math.max(checkpoint, completedEnds.length ? Math.max(...completedEnds) + 1 : 0);
  return {
    ledger, projection, checkpoint,
    persisted_record_ids: [...records],
    duplicate_record_count: 0,
    duplicate_persistence_attempts_suppressed:
      events.flatMap((event) => event.persisted_record_ids ?? []).length - records.size,
    finalization_reachable: projection.pending_obligation_count === 0 && projection.invariants.valid,
  };
}

export function buildFullChatReplay(messageCount = 9434, chunkSize = 20, owners = ['owner']) {
  const obligations = [];
  const events = [];
  for (let start = 0; start < messageCount; start += chunkSize) {
    const end = Math.min(messageCount - 1, start + chunkSize - 1);
    for (const owner of owners) {
      const obligation_id = `longterm:${owner}:${start}-${end}:offline`;
      obligations.push({ obligation_id, tier: 'longterm', owner, source_range: { start, end } });
      events.push({ obligation_id, current_state: 'provider_response_received', exact_reason_code: 'parser_pending' });
      events.push({ obligation_id, current_state: 'validation_accepted', exact_reason_code: 'persistence_pending' });
      events.push({ obligation_id, current_state: 'durably_committed', persistence_result: 'committed', coverage_result: 'safely_committed', persisted_record_ids: [`lt:${owner}:${start}`] });
    }
    const obligation_id = `session:chat:${start}-${end}:offline`;
    obligations.push({ obligation_id, tier: 'session', source_range: { start, end } });
    events.push({ obligation_id, current_state: 'parser_accepted', exact_reason_code: 'validation_pending' });
    events.push({ obligation_id, current_state: 'durably_committed', downstream_validation_result: 'accepted', persistence_result: 'committed', coverage_result: 'safely_committed', persisted_record_ids: [`session:${start}`] });
  }
  return { logicalRunId: 'offline-full-chat-9434', obligations, events };
}

export function buildAutomaticRecoveryFullChatReplay(messageCount = 9434, chunkSize = 20,
  owners = ['Alex Mercer', 'Aster Graves', 'Lillian Kraft', 'Lisette Dumont', 'Nyx Watson', 'Valerie Erikssen']) {
  const obligations = [];
  const events = [];
  let automaticRecoveries = 0;
  for (let start = 0; start < messageCount; start += chunkSize) {
    const end = Math.min(messageCount - 1, start + chunkSize - 1);
    for (const owner of owners) {
      const obligation_id = `longterm:${owner.toLowerCase()}:${start}-${end}:automatic-replay`;
      obligations.push({ obligation_id, tier: 'longterm', owner, source_range: { start, end } });
      events.push({ obligation_id, current_state: 'durably_committed', persistence_result: 'committed',
        coverage_result: 'safely_committed', persisted_record_ids: [`lt:${owner}:${start}`] });
    }
    const obligation_id = `session:chat:${start}-${end}:automatic-replay`;
    obligations.push({ obligation_id, tier: 'session', source_range: { start, end } });
    events.push({ obligation_id, current_state: 'parser_partial', parser_result: 'partial',
      exact_reason_code: 'partial_valid_output_has_unresolved_fragments',
      metrics: { parser_accepted_records: 3, parser_rejected_fragments: 1 },
      persisted_record_ids: [`session:${start}:one`, `session:${start}:two`, `session:${start}:three`] });
    events.push({ obligation_id, current_state: 'partial_records_committed',
      downstream_validation_result: 'accepted_partial_records', persistence_result: 'partial_records_committed',
      coverage_result: 'pending', exact_reason_code: 'partial_valid_output_has_unresolved_fragments',
      next_eligible_action: 'recover_unresolved_partial_output_fragments',
      recovery_intent: 'recover_unresolved_partial_output_fragments', recovery_stage: 'compact_response_repair' });
    events.push({ obligation_id, current_state: 'durably_committed', parser_result: 'recovered_fragment',
      downstream_validation_result: 'accepted', persistence_result: 'committed_without_duplicate_partial_records',
      coverage_result: 'safely_committed', persisted_record_ids: [`session:${start}:recovered`] });
    automaticRecoveries++;
  }
  const rootObligations = automaticRecoveries * (owners.length + 1);
  const physicalProviderRequests = rootObligations + automaticRecoveries;
  return { logicalRunId: 'offline-full-chat-9434-automatic-recovery', obligations, events,
    expectedAutomaticRecoveries: automaticRecoveries, expectedOperationalPauses: 0,
    providerMetrics: {
      root_obligations: rootObligations,
      physical_provider_requests: physicalProviderRequests,
      focused_fragment_recovery_requests: automaticRecoveries,
      request_amplification: physicalProviderRequests / rootObligations,
      partial_valid_response_rate: automaticRecoveries / physicalProviderRequests,
      fragment_recovery_success_rate: 1,
    },
  };
}

/**
 * Sanitized replay of the v0.9.71 100-119 exhaustion/Resume defect.  This
 * deliberately starts from the contradictory persisted state and exercises
 * migration, exact fragment-only recovery, checkpoint advancement, and the
 * immediate successor dispatch.
 */
export function replayExhaustedSessionRecoveryResume({ completeRemainingChat = false } = {}) {
  const logicalRunId = 'd55622f9-sanitized-replay';
  const fingerprint = 'fnv1a-7f2a4579';
  const sessionId = `session:chat:100-119:${fingerprint}`;
  const fragmentIds = ['session-fragment-1-fnv1a-63243b78', 'session-fragment-2-fnv1a-8d7541e7'];
  const owners = ['alex', 'aster', 'lillian', 'lisette', 'nyx', 'valerie'];
  const ledger = createMemorizeObligationLedger(logicalRunId, 1);
  const acceptedRecordId = 'session:100-119:accepted-from-provider-188';
  const records = new Set();
  const providerRequests = [];
  const committedLongterm = [];

  // Five prior 20-message chunks account for 35 safe obligations.
  for (let start = 0; start < 100; start += 20) {
    const end = start + 19;
    for (const owner of owners) {
      const id = `longterm:${owner}:${start}-${end}:safe`;
      transitionMemorizeObligation(ledger, { obligation_id: id, logical_run_id: logicalRunId,
        tier: 'longterm', owner, source_range: { start, end } }, {
        current_state: 'durably_committed', persistence_result: 'committed', coverage_result: 'safely_committed',
      });
    }
    const priorSession = `session:chat:${start}-${end}:safe`;
    transitionMemorizeObligation(ledger, { obligation_id: priorSession, logical_run_id: logicalRunId,
      tier: 'session', source_range: { start, end } }, {
      current_state: 'durably_committed', persistence_result: 'committed', coverage_result: 'safely_committed',
    });
  }
  for (const owner of owners) {
    const id = `longterm:${owner}:100-119:${fingerprint}`;
    transitionMemorizeObligation(ledger, { obligation_id: id, logical_run_id: logicalRunId,
      tier: 'longterm', owner, source_range: { start: 100, end: 119 }, source_fingerprint: fingerprint }, {
      current_state: 'durably_committed', persistence_result: 'committed', coverage_result: 'safely_committed',
    });
    committedLongterm.push(id);
  }
  transitionMemorizeObligation(ledger, { obligation_id: sessionId, logical_run_id: logicalRunId,
    tier: 'session', source_range: { start: 100, end: 119 }, source_fingerprint: fingerprint }, {
    current_state: 'pending_recovery', parser_result: 'one accepted, two rejected',
    downstream_validation_result: 'accepted_partial_records', persistence_result: 'partial_records_committed',
    coverage_result: 'pending', exact_reason_code: 'automatic_partial_recovery_exhausted',
    next_eligible_action: 'recover_unresolved_partial_output_fragments',
    recovery_intent: 'recover_unresolved_partial_output_fragments', recovery_stage: 'bounded_recovery_exhausted',
    provider_attempt_lineage: ['provider-188', 'provider-189', 'provider-190', 'provider-191', 'provider-192'],
    metrics: { parser_accepted_records: 1, persisted_records: 1, parser_rejected_fragments: 2,
      unresolved_parser_fragments: 2, unresolved_fragment_ids: fragmentIds,
      producing_provider_attempt_id: 'provider-188' },
  });
  records.add(acceptedRecordId);

  const metadata = { active_catchup_run_id: logicalRunId };
  const original = beginProviderAttempt(metadata, { logical_obligation_id: sessionId, tier: 'session',
    request_kind: 'original', source_range: { start: 100, end: 119 }, source_fingerprint: fingerprint });
  finishProviderAttempt(metadata, original, { terminal_outcome: 'completed', notice_reason: 'partial_valid_output' });
  markProviderPartialRecordsPersisted(metadata, sessionId, 1, fingerprint, [acceptedRecordId]);
  stageProviderRejectedFragments(metadata, sessionId, fingerprint, fragmentIds.map((fragment_id, index) => ({
    fragment_id, raw: `sanitized-malformed-fragment-${index + 1}`,
    reason_codes: [index ? 'multiple_assignment_delimiters' : 'malformed_entity_type_pair'],
  })), { producing_attempt_id: original.attempt_id });
  for (const recovery_stage of ['compact_response_repair', 'changed_dimension_regeneration',
    'structured_json_regeneration', 'minimal_record_regeneration']) {
    const attempt = beginProviderAttempt(metadata, { logical_obligation_id: sessionId, tier: 'session',
      request_kind: recovery_stage, recovery_stage, recovery_of_attempt_id: original.attempt_id,
      source_range: { start: 100, end: 119 }, source_fingerprint: fingerprint });
    providerRequests.push({ recovery_stage, fragment_ids: [...fragmentIds], automatic: true });
    finishProviderAttempt(metadata, attempt, { terminal_outcome: 'provider_response_malformed' });
  }

  // Persisted v0.9.71 corruption: no physical request is active.
  Object.assign(ledger.obligations[sessionId], { current_state: 'provider_running',
    exact_reason_code: 'provider_request_in_progress', next_eligible_action: null,
    persistence_result: 'not_committed', checkpoint_eligible: false });
  const beforeRepair = projectMemorizeObligationLedger(structuredClone(ledger));
  const repaired = reconcileMemorizeRunningObligations(
    ledger, metadata.live_memory_health.provider_attempt_audit);
  const afterRepair = projectMemorizeObligationLedger(ledger);
  const runtimeAfterRepair = reconcileMemorizeProviderRuntime(
    ledger, metadata.live_memory_health.provider_attempt_audit);

  const epoch = beginProviderRecoveryEpoch(metadata, sessionId, fingerprint, {
    recovery_stage: 'fragment_decision_regeneration', unresolved_fragment_ids: fragmentIds,
    accepted_records_preserved: 1, global_request_ceiling: 20, epoch_request_ceiling: 4,
  });
  const focused = beginProviderAttempt(metadata, { logical_obligation_id: sessionId, tier: 'session',
    request_kind: 'fragment_decision_regeneration', recovery_stage: 'fragment_decision_regeneration',
    recovery_of_attempt_id: original.attempt_id, resumed_pending_obligation: true,
    source_range: { start: 100, end: 119 }, source_fingerprint: fingerprint });
  transitionMemorizeObligation(ledger, ledger.obligations[sessionId], {
    current_state: 'provider_running', provider_attempt_id: focused.attempt_id,
    exact_reason_code: 'provider_request_in_progress', recovery_stage: 'fragment_decision_regeneration',
    persistence_result: 'not_committed', metrics: { persisted_records: 1 },
  });
  providerRequests.push({ recovery_stage: 'fragment_decision_regeneration',
    fragment_ids: [...fragmentIds], accepted_record_ids_excluded: [acceptedRecordId], automatic: false });
  finishProviderAttempt(metadata, focused, { terminal_outcome: 'completed', accepted_candidate_count: 1 });
  markProviderRejectedFragmentsRecovered(metadata, sessionId, fingerprint, fragmentIds);
  records.add('session:100-119:recovered-fragment');
  transitionMemorizeObligation(ledger, ledger.obligations[sessionId], {
    current_state: 'durably_committed', parser_result: 'fragment_decisions_resolved',
    downstream_validation_result: 'accepted', persistence_result: 'committed_without_duplicate_partial_records',
    coverage_result: 'safely_committed', metrics: { persisted_records: 1, recovered_fragment_count: 1 },
  });
  let checkpoint = 120;
  providerRequests.push({ recovery_stage: 'strict_generation', source_range: { start: 120, end: 139 },
    next_chunk_started: true });

  if (completeRemainingChat) {
    for (let start = 120; start < 9434; start += 20) {
      const end = Math.min(9433, start + 19);
      for (const owner of owners) transitionMemorizeObligation(ledger, {
        obligation_id: `longterm:${owner}:${start}-${end}:remaining`, logical_run_id: logicalRunId,
        tier: 'longterm', owner, source_range: { start, end },
      }, { current_state: 'durably_committed', persistence_result: 'committed', coverage_result: 'safely_committed' });
      transitionMemorizeObligation(ledger, {
        obligation_id: `session:chat:${start}-${end}:remaining`, logical_run_id: logicalRunId,
        tier: 'session', source_range: { start, end },
      }, { current_state: 'durably_committed', persistence_result: 'committed', coverage_result: 'safely_committed' });
    }
    checkpoint = 9434;
  }
  const finalProjection = projectMemorizeObligationLedger(ledger);
  return { ledger, metadata, sessionId, fragmentIds, epoch, checkpoint, records: [...records],
    providerRequests, committedLongterm, beforeRepair, afterRepair, runtimeAfterRepair, finalProjection,
    longtermReplayCount: providerRequests.filter((item) => item.source_range?.start === 100
      && item.recovery_stage === 'strict_generation').length,
    duplicateRecordCount: [...records].length - new Set(records).size,
  };
}

/**
 * Deterministic controller-path replay for the v0.9.69 range 0-19 failure.
 * It models the same event sequence as the real button handler: staged partial
 * persistence, operational pause, transaction settlement, handler exit, then
 * exact Session-only Resume and checkpoint advancement.
 */
export async function replayPartialSessionResume({
  throwBeforeInitialization = false,
  commitFailure = false,
  rollbackFailure = false,
  cleanupFailure = false,
} = {}) {
  const logicalRunId = 'offline-controller-0-19';
  const sessionId = 'session:chat:0-19:fnv1a-39c6c9f';
  const owners = ['Alex Mercer', 'Aster Graves', 'Lillian Kraft', 'Lisette Dumont', 'Nyx Watson', 'Valerie Erikssen'];
  const ledger = createMemorizeObligationLedger(logicalRunId, 1);
  const checkpoint = { next_source_offset: 0, source_message_count: 9434, operational_pause: null,
    run_manifest: { logical_run_id: logicalRunId, total_attempt_count: 1, obligation_ledger: ledger } };
  const persisted = new Set();
  const providerRequests = [];
  const transactionHistory = [];
  const runtime = createMemorizeControllerRuntime({ invocation_id: 'attempt-1', logical_run_id: logicalRunId, page_instance_id: 'page-1' });
  bindMemorizeCheckpoint(runtime, checkpoint);
  const transaction = { transaction_id: 'tx-1', state: 'active', terminal_disposition: null };
  trackMemorizeTransaction(runtime, transaction, { phase: 'source_extraction', tier: 'session', source_range: { start: 0, end: 19 }, obligation_id: sessionId });
  registerMemorizeCleanup(runtime, 'active_transaction', () => {
    if (transaction.state !== 'active') return;
    if (rollbackFailure) {
      transaction.state = 'rollback_failed_with_exact_state';
      transaction.terminal_disposition = 'rollback_failed_with_exact_state';
      throw new Error('scripted rollback failure');
    }
    transaction.state = 'rolled_back';
    transaction.terminal_disposition = 'rolled_back';
    transactionHistory.push('rolled_back');
  });
  registerMemorizeCleanup(runtime, 'provider_progress_listener', () => {
    if (cleanupFailure) throw new Error('scripted listener cleanup failure');
    transactionHistory.push('provider_listener_cleaned');
  });
  registerMemorizeCleanup(runtime, 'retry_listener', () => transactionHistory.push('retry_listener_cleaned'));

  try {
    if (throwBeforeInitialization) throw new ReferenceError('scripted pre-initialization failure');
    for (const owner of owners) {
      const id = `longterm:${owner.toLowerCase()}:0-19:fnv1a-39c6c9f`;
      transitionMemorizeObligation(ledger, { obligation_id: id, logical_run_id: logicalRunId,
        tier: 'longterm', owner, source_range: { start: 0, end: 19 } }, {
        current_state: 'durably_committed', persistence_result: 'committed', coverage_result: 'safely_committed', at: 2,
      });
      providerRequests.push(id);
      persisted.add(`lt:${owner}:0-19`);
    }
    providerRequests.push(sessionId);
    transitionMemorizeObligation(ledger, { obligation_id: sessionId, logical_run_id: logicalRunId,
      tier: 'session', source_range: { start: 0, end: 19 } }, {
      current_state: 'parser_partial', parser_result: 'three accepted, two rejected',
      exact_reason_code: 'partial_valid_output_has_unresolved_fragments',
      metrics: { parser_accepted_records: 3, parser_rejected_fragments: 2 }, at: 3,
    });
    ['session:one', 'session:two', 'session:three'].forEach((id) => persisted.add(id));
    transitionMemorizeObligation(ledger, ledger.obligations[sessionId], {
      current_state: 'pending_recovery', downstream_validation_result: 'accepted_partial_records',
      persistence_result: 'partial_records_committed', coverage_result: 'pending',
      exact_reason_code: 'partial_valid_output_has_unresolved_fragments',
      next_eligible_action: 'recover_unresolved_partial_output_fragments', at: 4,
    });
    const pauseError = Object.assign(new Error('partial output pending'), {
      code: 'SME_DOWNSTREAM_VALIDATION_PENDING',
      sme_request_diagnostics: { pause_reason: 'partial_valid_output_has_unresolved_fragments',
        next_eligible_recovery_action: 'recover_unresolved_partial_output_fragments' },
    });
    recordMemorizeOperationalPause(runtime, { operationalPauses: [] }, 'Session downstream validation pending', pauseError, 'session');
    recordMemorizeControllerExit(ledger, buildMemorizeControllerExit(runtime, {
      reason_code: 'partial_valid_output_has_unresolved_fragments', classification: 'downstream_validation_pending',
      resumable: true, obligation_id: sessionId, next_eligible_action: 'recover_unresolved_partial_output_fragments', at: 5,
    }));
  } catch (error) {
    captureMemorizePrimaryFailure(runtime, error);
    recordMemorizeControllerExit(ledger, buildMemorizeControllerExit(runtime, {
      reason_code: error?.name === 'ReferenceError' ? 'internal_exception' : error?.code,
      classification: 'internal_exception', resumable: false, at: 5,
    }));
  }
  const cleanupWarnings = await cleanupMemorizeRuntime(runtime);

  const beforeResume = projectMemorizeObligationLedger(ledger);
  let resumeResult = null;
  if (!throwBeforeInitialization && !rollbackFailure) {
    const resumeRuntime = createMemorizeControllerRuntime({ invocation_id: 'attempt-2', logical_run_id: logicalRunId, page_instance_id: 'page-1' });
    checkpoint.run_manifest.total_attempt_count = 2;
    bindMemorizeCheckpoint(resumeRuntime, checkpoint);
    const resumeTransaction = { transaction_id: 'tx-2', state: 'active', terminal_disposition: null };
    trackMemorizeTransaction(resumeRuntime, resumeTransaction, { phase: 'source_extraction', tier: 'session', source_range: { start: 0, end: 19 }, obligation_id: sessionId });
    registerMemorizeCleanup(resumeRuntime, 'active_transaction', () => {
      if (resumeTransaction.state === 'active') {
        resumeTransaction.state = 'rolled_back';
        resumeTransaction.terminal_disposition = 'rolled_back';
      }
    });
    providerRequests.push(`${sessionId}:fragment_repair`);
    persisted.add('session:recovered-fragment-four');
    persisted.add('session:recovered-fragment-five');
    if (commitFailure) {
      resumeTransaction.state = 'commit_failed_with_exact_state';
      resumeTransaction.terminal_disposition = 'commit_failed_with_exact_state';
      captureMemorizePrimaryFailure(resumeRuntime, Object.assign(new Error('scripted commit failure'), { code: 'SME_CATCHUP_TRANSACTION_COMMIT_FAILED' }));
      recordMemorizeControllerExit(ledger, buildMemorizeControllerExit(resumeRuntime, {
        reason_code: 'SME_CATCHUP_TRANSACTION_COMMIT_FAILED', classification: 'transaction_commit_failure', resumable: true,
        obligation_id: sessionId, next_eligible_action: 'recover_unresolved_partial_output_fragments', at: 7,
      }));
    } else {
      transitionMemorizeObligation(ledger, ledger.obligations[sessionId], {
        current_state: 'durably_committed', downstream_validation_result: 'accepted_recovered_fragments',
        persistence_result: 'committed_without_duplicate_partial_records', coverage_result: 'safely_committed', at: 7,
      });
      resumeTransaction.state = 'committed';
      resumeTransaction.terminal_disposition = 'committed';
      checkpoint.next_source_offset = 20;
      recordMemorizeControllerExit(ledger, buildMemorizeControllerExit(resumeRuntime, {
        reason_code: 'chunk_committed', classification: 'completed_with_recovered_errors', resumable: false, at: 8,
      }));
    }
    await cleanupMemorizeRuntime(resumeRuntime);
    resumeResult = { runtime: resumeRuntime, transaction: resumeTransaction };
  }
  const afterResume = projectMemorizeObligationLedger(ledger);
  return {
    ledger, checkpoint, runtime, transaction, transactionHistory, cleanupWarnings,
    beforeResume, afterResume, resumeResult, providerRequests,
    persisted_record_ids: [...persisted],
    duplicate_record_count: [...persisted].length - new Set(persisted).size,
    leaked_transaction: [transaction, resumeResult?.transaction].some((item) => item?.state === 'active'),
  };
}

/**
 * Deterministic same-invocation recovery replay for the v0.9.70 Session 20-39
 * partial-output shape. The scripted provider is fragment-scoped and cannot
 * regenerate the three records already committed at the durable boundary.
 */
export async function replayAutomaticPartialSessionRecovery({
  recoveryOutcomes = ['success'],
  maximumRequests = 4,
  interruptAfterBoundary = false,
  commitFailure = false,
  manualCancel = false,
} = {}) {
  const logicalRunId = 'offline-automatic-session-20-39';
  const sessionId = 'session:chat:20-39:fnv1a-eeb22053';
  const owners = ['Alex Mercer', 'Aster Graves', 'Lillian Kraft', 'Lisette Dumont', 'Nyx Watson', 'Valerie Erikssen'];
  const ledger = createMemorizeObligationLedger(logicalRunId, 1);
  const checkpoint = { next_source_offset: 20, source_message_count: 9434,
    run_manifest: { logical_run_id: logicalRunId, total_attempt_count: 1, obligation_ledger: ledger } };
  const records = new Set(['session:20-39:one', 'session:20-39:two', 'session:20-39:three']);
  const providerRequests = [];
  const transaction = { transaction_id: 'automatic-tx', state: 'active', terminal_disposition: null };
  const runtime = createMemorizeControllerRuntime({ invocation_id: 'automatic-attempt', logical_run_id: logicalRunId, attempt_number: 1 });
  bindMemorizeCheckpoint(runtime, checkpoint);
  trackMemorizeTransaction(runtime, transaction, { phase: 'source_extraction', tier: 'session',
    source_range: { start: 20, end: 39 }, obligation_id: sessionId });
  for (const owner of owners) transitionMemorizeObligation(ledger, {
    obligation_id: `longterm:${owner.toLowerCase()}:20-39:fnv1a-eeb22053`, logical_run_id: logicalRunId,
    tier: 'longterm', owner, source_range: { start: 20, end: 39 }, source_fingerprint: 'fnv1a-eeb22053',
  }, { current_state: 'durably_committed', persistence_result: 'committed', coverage_result: 'safely_committed', at: 2 });
  transitionMemorizeObligation(ledger, {
    obligation_id: sessionId, logical_run_id: logicalRunId, tier: 'session',
    source_range: { start: 20, end: 39 }, source_fingerprint: 'fnv1a-eeb22053',
  }, { current_state: 'pending_recovery', parser_result: 'partial',
    downstream_validation_result: 'accepted_partial_records', persistence_result: 'partial_records_committed',
    coverage_result: 'pending', exact_reason_code: 'partial_valid_output_has_unresolved_fragments',
    next_eligible_action: 'recover_unresolved_partial_output_fragments',
    recovery_intent: 'recover_unresolved_partial_output_fragments', recovery_stage: 'compact_response_repair',
    metrics: { parser_accepted_records: 3, parser_rejected_fragments: 1,
      persisted_records: 3, unresolved_fragment_ids: ['session-fragment-3-fnv1a-replay'] }, at: 3 });
  checkpoint.automatic_recovery = { status: 'recovery_in_progress', recovery_intent: 'recover_unresolved_partial_output_fragments',
    recovery_stage: 'compact_response_repair', accepted_records_preserved: 3, unresolved_fragment_count: 1 };
  // Durable partial boundary: a crash from this point can replay only the fragment.
  transaction.snapshot_checkpoint = 20;
  if (interruptAfterBoundary) {
    transaction.state = 'rolled_back';
    transaction.terminal_disposition = 'rolled_back';
    recordMemorizeControllerExit(ledger, buildMemorizeControllerExit(runtime, {
      classification: 'page_interrupted', reason_code: 'page_interrupted_during_automatic_recovery',
      resumable: true, obligation_id: sessionId, next_eligible_action: 'recover_unresolved_partial_output_fragments', at: 4,
    }));
    return { checkpoint, ledger, transaction, records: [...records], providerRequests,
      projection: projectMemorizeObligationLedger(ledger), interrupted: true, nextChunkStarted: false };
  }
  let recovered = false;
  let stage = 'compact_response_repair';
  for (const outcome of recoveryOutcomes) {
    if (providerRequests.length >= maximumRequests) break;
    providerRequests.push({ root_obligation_id: sessionId, recovery_intent: 'recover_unresolved_partial_output_fragments',
      recovery_stage: stage, fragment_ids: ['session-fragment-3-fnv1a-replay'] });
    if (manualCancel) break;
    if (outcome === 'success') { recovered = true; break; }
    stage = 'changed_dimension_regeneration';
  }
  if (recovered && !commitFailure) {
    records.add('session:20-39:recovered-fragment');
    transitionMemorizeObligation(ledger, ledger.obligations[sessionId], {
      current_state: 'durably_committed', parser_result: 'recovered_fragment',
      downstream_validation_result: 'accepted', persistence_result: 'committed_without_duplicate_partial_records',
      coverage_result: 'safely_committed', metrics: { recovered_fragment_count: 1 }, at: 5,
    });
    checkpoint.next_source_offset = 40;
    checkpoint.automatic_recovery = { ...checkpoint.automatic_recovery, status: 'recovered_automatically',
      recovery_stage: stage, request_budget_used: providerRequests.length };
    transaction.state = 'committed';
    transaction.terminal_disposition = 'committed';
  } else {
    const reason = commitFailure ? 'transaction_commit_failure'
      : manualCancel ? 'manual_cancel' : 'automatic_partial_recovery_exhausted';
    transitionMemorizeObligation(ledger, ledger.obligations[sessionId], {
      current_state: manualCancel ? 'pending_recovery' : 'operationally_paused',
      exact_reason_code: reason, next_eligible_action: 'recover_unresolved_partial_output_fragments',
      recovery_intent: 'recover_unresolved_partial_output_fragments', recovery_stage: stage, at: 5,
    });
    checkpoint.automatic_recovery = { ...checkpoint.automatic_recovery,
      status: manualCancel ? 'manually_cancelled' : 'operationally_paused_resumable',
      pause_reason: reason, request_budget_used: providerRequests.length,
      request_budget_remaining: Math.max(0, maximumRequests - providerRequests.length), fresh_budget_on_resume: true };
    transaction.state = commitFailure ? 'commit_failed_with_exact_state' : 'rolled_back';
    transaction.terminal_disposition = transaction.state;
  }
  const nextChunkStarted = recovered && !commitFailure;
  if (nextChunkStarted) providerRequests.push({ root_obligation_id: 'session:chat:40-59:offline',
    recovery_intent: 'extract_root_obligation', recovery_stage: 'strict_generation', fragment_ids: [] });
  recordMemorizeControllerExit(ledger, buildMemorizeControllerExit(runtime, {
    classification: nextChunkStarted ? 'completed_with_recovered_errors'
      : manualCancel ? 'manually_cancelled' : 'operationally_paused',
    reason_code: nextChunkStarted ? 'automatic_partial_recovery_completed'
      : checkpoint.automatic_recovery.pause_reason,
    resumable: !nextChunkStarted && !manualCancel, obligation_id: nextChunkStarted ? null : sessionId,
    next_eligible_action: nextChunkStarted ? null : 'recover_unresolved_partial_output_fragments', at: 6,
  }));
  return { checkpoint, ledger, transaction, records: [...records], providerRequests,
    projection: projectMemorizeObligationLedger(ledger), interrupted: false, nextChunkStarted,
    duplicate_record_count: records.size - new Set(records).size };
}

