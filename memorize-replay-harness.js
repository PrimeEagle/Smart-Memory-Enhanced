import {
  createMemorizeObligationLedger,
  projectMemorizeObligationLedger,
  recordMemorizeControllerExit,
  transitionMemorizeObligation,
} from './memorize-obligation-ledger.js';

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

