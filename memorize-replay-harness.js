import {
  createMemorizeObligationLedger,
  projectMemorizeObligationLedger,
  recordMemorizeControllerExit,
  transitionMemorizeObligation,
} from './memorize-obligation-ledger.js';
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

