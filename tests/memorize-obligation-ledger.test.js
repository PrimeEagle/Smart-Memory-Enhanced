import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createMemorizeObligationLedger,
  migrateLegacyMemorizeObligations,
  projectMemorizeObligationLedger,
  recordMemorizeControllerExit,
  transitionMemorizeObligation,
} from '../memorize-obligation-ledger.js';
import { buildFullChatReplay, runMemorizeReplay } from '../memorize-replay-harness.js';
import { repairSessionCandidateShapes } from '../session-candidate-utils.js';
import {
  beginProviderAttempt,
  finishProviderAttempt,
  markProviderDownstreamOutcome,
  summarizeProviderAttemptAudit,
} from '../provider-attempt-audit.js';

const sessionId = 'session:chat:640-659:fnv1a-4ee9852e';
const sessionInput = { obligation_id: sessionId, logical_run_id: 'run', tier: 'session', source_range: { start: 640, end: 659 }, source_fingerprint: 'fnv1a-4ee9852e' };

test('Session 640-659 downstream rejection remains exact pending recovery', () => {
  const ledger = createMemorizeObligationLedger('run');
  transitionMemorizeObligation(ledger, sessionInput, { current_state: 'parser_partial', parser_result: 'one accepted, two rejected', exact_reason_code: 'partial_valid_output_has_unresolved_fragments', metrics: { parser_accepted_records: 1, parser_rejected_fragments: 2 } });
  transitionMemorizeObligation(ledger, sessionInput, { current_state: 'pending_recovery', downstream_validation_result: 'rejected_invalid_candidate_shape', persistence_result: 'not_committed', coverage_result: 'pending', exact_reason_code: 'invalid_candidate_shape', next_eligible_action: 'session_validation_repair_or_bounded_regeneration' });
  const result = projectMemorizeObligationLedger(ledger);
  assert.equal(result.pending_obligation_count, 1);
  assert.equal(result.next_eligible_obligation.obligation_id, sessionId);
  assert.equal(result.next_eligible_obligation.checkpoint_eligible, false);
  assert.equal(result.tier_coverage.session.coverage_complete, false);
  assert.equal(result.chunks[0].status, 'pending_session_recovery');
  assert.equal(result.invariants.valid, true);
});

test('provider response completion cannot bypass downstream validation', () => {
  const metadata = { active_catchup_run_id: 'run' };
  const attempt = beginProviderAttempt(metadata, {
    logical_obligation_id: sessionId, tier: 'session', source_range: { start: 640, end: 659 },
    source_fingerprint: 'fnv1a-4ee9852e', root_source_range: { start: 640, end: 659 },
  });
  finishProviderAttempt(metadata, attempt, { terminal_outcome: 'completed', notice_reason: 'partial_valid_output' });
  markProviderDownstreamOutcome(metadata, sessionId, {
    validation_accepted: false, persistence_committed: false,
    rejected_count: 1, reason_code: 'invalid_candidate_shape',
    unresolved_semantic_requirements: true,
  });
  const obligation = metadata.live_memory_health.provider_attempt_audit.obligations[sessionId];
  assert.equal(attempt.terminal_outcome, 'completed');
  assert.equal(attempt.checkpoint_eligible, false);
  assert.equal(obligation.terminal_outcome, 'pending_recovery');
  assert.equal(obligation.checkpoint_eligible, false);
  assert.equal(summarizeProviderAttemptAudit(metadata).terminal_unresolved_obligations[0].root_obligation_id, sessionId);
});

test('v0.9.68 contradiction migrates to the exact Session obligation only', () => {
  const ledger = migrateLegacyMemorizeObligations(null, {
    logical_run_id: 'run',
    tier_obligations: [
      { tier: 'longterm', start_offset: 640, end_offset: 659, source_start_index: 640, source_end_index: 659, safely_committed: true },
      { tier: 'session', start_offset: 640, end_offset: 659, source_start_index: 640, source_end_index: 659, safely_committed: false, reason_code: 'session_range_not_safely_committed' },
    ],
    owner_obligations: [
      { tier: 'longterm', owner: 'Aster Graves', start_offset: 640, end_offset: 659, source_start_index: 640, source_end_index: 659, source_fingerprint: 'fnv1a-4ee9852e', safely_committed: true },
    ],
    provider_obligations: {
      [sessionId]: { logical_obligation_id: sessionId, tier: 'session', root_source_range: { start: 640, end: 659 }, root_source_fingerprint: 'fnv1a-4ee9852e', terminal_outcome: 'completed', last_notice_reason: 'partial_valid_output', last_attempt_id: 'provider-815' },
    },
    session_diagnostics: { session_citation_pipeline: { final_malformed: 1 } },
  });
  const result = projectMemorizeObligationLedger(ledger);
  assert.equal(result.pending_obligation_count, 1);
  assert.equal(result.pending_obligations[0].tier, 'session');
  assert.equal(result.pending_obligations[0].exact_reason_code, 'invalid_candidate_shape');
  assert.equal(result.pending_obligations[0].provider_attempt_lineage[0], 'provider-815');
  assert.equal(result.tier_coverage.longterm.coverage_complete, true);
  assert.equal(result.pending_obligations.some((item) => item.owner === 'Aster Graves'), false);
  assert.equal(result.next_eligible_obligation.tier, 'session');
});

test('representation-only candidate repair requires no provider call', () => {
  const first = 'A'.repeat(120) + '.';
  const second = 'B'.repeat(120) + '.';
  const repaired = repairSessionCandidateShapes([{ type: 'detail', content: `${first} ${second}`, source_message_indices: [2] }]);
  assert.equal(repaired.repaired_count, 1);
  assert.equal(repaired.records.length, 2);
  assert.equal(repaired.rejected.length, 0);
  assert.deepEqual(repaired.records.map((item) => item.source_message_indices), [[2], [2]]);
});

test('genuinely invalid single claim remains bounded recovery work', () => {
  const repaired = repairSessionCandidateShapes([{ type: 'detail', content: 'X'.repeat(300), source_message_indices: [2] }]);
  assert.equal(repaired.records.length, 0);
  assert.equal(repaired.rejected[0].reason_code, 'invalid_candidate_shape');
});

test('validated no-update explicitly closes a Session range', () => {
  const ledger = createMemorizeObligationLedger('run');
  transitionMemorizeObligation(ledger, sessionInput, { current_state: 'explicit_no_update', downstream_validation_result: 'validated_duplicate_only_no_update', persistence_result: 'not_required' });
  const result = projectMemorizeObligationLedger(ledger);
  assert.equal(result.pending_obligation_count, 0);
  assert.equal(result.safely_committed_obligation_count, 1);
});

test('every resumable exit retains exact reason and next action', () => {
  const ledger = createMemorizeObligationLedger('run');
  transitionMemorizeObligation(ledger, sessionInput, { current_state: 'pending_recovery', exact_reason_code: 'invalid_candidate_shape', next_eligible_action: 'session_validation_repair_or_bounded_regeneration' });
  recordMemorizeControllerExit(ledger, { reason_code: 'invalid_candidate_shape', classification: 'downstream_validation_pending', obligation_id: sessionId, next_eligible_action: 'session_validation_repair_or_bounded_regeneration' });
  const result = projectMemorizeObligationLedger(ledger);
  assert.equal(result.last_controller_exit.reason_code, 'invalid_candidate_shape');
  assert.equal(result.last_controller_exit.next_eligible_action, 'session_validation_repair_or_bounded_regeneration');
  assert.equal(result.invariants.valid, true);
});

test('crash/reload retains exact obligation and deduplicates record identity', () => {
  const first = runMemorizeReplay({ logicalRunId: 'run', obligations: [sessionInput], events: [
    { obligation_id: sessionId, current_state: 'pending_recovery', exact_reason_code: 'invalid_candidate_shape', next_eligible_action: 'session_validation_repair_or_bounded_regeneration' },
    { type: 'controller_exit', reason_code: 'page_interruption', obligation_id: sessionId, next_eligible_action: 'session_validation_repair_or_bounded_regeneration' },
  ] });
  const restored = structuredClone(first.ledger);
  transitionMemorizeObligation(restored, sessionInput, { current_state: 'durably_committed', downstream_validation_result: 'accepted', persistence_result: 'committed', coverage_result: 'safely_committed' });
  assert.equal(projectMemorizeObligationLedger(restored).pending_obligation_count, 0);
  const replay = runMemorizeReplay({ logicalRunId: 'run', obligations: [sessionInput], events: [
    { obligation_id: sessionId, current_state: 'durably_committed', persisted_record_ids: ['record-1'] },
    { obligation_id: sessionId, current_state: 'durably_committed', persisted_record_ids: ['record-1'] },
  ] });
  assert.equal(replay.persisted_record_ids.length, 1);
  assert.equal(replay.duplicate_record_count, 0);
  assert.equal(replay.duplicate_persistence_attempts_suppressed, 1);
});

test('canary corpus is routed through actionable terminal states', () => {
  const corpus = JSON.parse(fs.readFileSync(new URL('./fixtures/memorize-recovery-canary-corpus.json', import.meta.url)));
  assert.equal(corpus.cases.length, 10);
  for (const [index, name] of corpus.cases.entries()) {
    const id = `session:chat:${index}-${index}:canary`;
    const replay = runMemorizeReplay({ obligations: [{ obligation_id: id, tier: 'session', source_range: { start: index, end: index } }], events: [
      { obligation_id: id, current_state: 'pending_recovery', exact_reason_code: name, next_eligible_action: 'resume_exact_obligation' },
      { obligation_id: id, current_state: 'durably_committed', persistence_result: 'committed', coverage_result: 'safely_committed' },
    ] });
    assert.equal(replay.finalization_reachable, true, name);
  }
});

test('9,434-message offline replay finalizes monotonically and is idempotent', () => {
  const script = buildFullChatReplay(9434, 20, ['alex', 'aster', 'lillian', 'lisette', 'nyx', 'valerie']);
  const first = runMemorizeReplay(script);
  const second = runMemorizeReplay(script);
  assert.equal(first.finalization_reachable, true);
  assert.equal(first.checkpoint, 9434);
  assert.equal(first.duplicate_record_count, 0);
  assert.deepEqual(first.projection.tier_coverage, second.projection.tier_coverage);
  assert.deepEqual(first.persisted_record_ids, second.persisted_record_ids);
});

