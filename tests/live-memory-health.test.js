import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_MEMORY_HEALTH_MAX_EVENTS,
  beginLiveExtractionEvent,
  updateLiveExtractionEvent,
  finishLiveExtractionEvent,
  reconcileInterruptedExtractionEvents,
  interruptRunningExtractionEvents,
  recordLiveInjectionEvent,
  CONTINUITY_HEALTH_MAX_EVENTS,
  beginContinuityEvent,
  finishContinuityEvent,
  exportLiveMemoryHealth,
} from '../live-memory-health.js';

test('restart reconciliation distinguishes committed work from uncertain interrupted work', () => {
  const metadata = {};
  const committed = beginLiveExtractionEvent(metadata, { tier: 'longterm', source_start: 0, source_end: 9, message_count: 10 });
  const pending = beginLiveExtractionEvent(metadata, { tier: 'session', source_start: 0, source_end: 9, message_count: 10 });
  updateLiveExtractionEvent(committed, { response_received: true, parser_outcome: 'parsed' });
  const checkpoint = { run_manifest: { tier_coverage: { longterm: { committed_ranges: [{ source_start_index: 0, source_end_index: 9 }] } } } };
  const result = reconcileInterruptedExtractionEvents(metadata, checkpoint, { now: committed.timestamp + 1000 });
  assert.deepEqual(result, { reconciled: 2, recovered: 1, uncertain: 1 });
  assert.equal(committed.terminal_health, 'recovered_completed');
  assert.equal(pending.terminal_health, 'completion_uncertain_after_restart');

  const replay = beginLiveExtractionEvent(metadata, { tier: 'session', source_start: 0, source_end: 9, message_count: 10 });
  assert.equal(replay.replay_of_event_id, pending.event_id);
  finishLiveExtractionEvent(metadata, replay, { terminal_health: 'completed' });
  const summary = exportLiveMemoryHealth(metadata).extraction_outcome_summary;
  assert.equal(summary.interruptions, 1);
  assert.equal(summary.successful_replays, 1);
  assert.equal(summary.provider_quality.malformed_responses, 0);
  assert.equal(summary.provider_quality.empty_responses, 0);
});

test('manual cancellation remains an interruption even if an empty provider result arrives afterward', () => {
  const metadata = {};
  const event = beginLiveExtractionEvent(metadata, { tier: 'session', source_start: 20, source_end: 29 });
  assert.equal(interruptRunningExtractionEvents(metadata, 'interrupted_by_manual_cancel'), 1);
  finishLiveExtractionEvent(metadata, event, { terminal_health: 'provider_response_empty', response_received: true });
  assert.equal(event.terminal_health, 'interrupted_by_manual_cancel');
  assert.equal(exportLiveMemoryHealth(metadata).extraction_outcome_summary.provider_quality.empty_responses, 0);
});

test('genuine provider empty and malformed responses remain quality outcomes', () => {
  const metadata = {};
  const empty = beginLiveExtractionEvent(metadata, { tier: 'longterm', source_start: 30, source_end: 39 });
  finishLiveExtractionEvent(metadata, empty, { terminal_health: 'provider_response_empty', response_received: true, parser_outcome: 'not_applicable_empty_response' });
  const malformed = beginLiveExtractionEvent(metadata, { tier: 'session', source_start: 30, source_end: 39 });
  finishLiveExtractionEvent(metadata, malformed, { terminal_health: 'provider_response_malformed', response_received: true, parser_outcome: 'parsed_no_records' });
  const summary = exportLiveMemoryHealth(metadata).extraction_outcome_summary;
  assert.equal(summary.provider_quality.empty_responses, 1);
  assert.equal(summary.provider_quality.malformed_responses, 1);
});

test('legacy events without lifecycle evidence are reported as unknown, not provider defects', () => {
  const metadata = { live_memory_health: { recent_extraction_events: [{ event_id: 'old', tier: 'session', terminal_health: 'malformed_response' }], recent_injection_events: [], aggregate: { extraction: {}, injection: {} } } };
  const summary = exportLiveMemoryHealth(metadata).extraction_outcome_summary;
  assert.equal(summary.deduplicated_logical_request_counts.legacy_outcome_unknown, 1);
  assert.equal(summary.provider_quality.malformed_responses, 0);
});

test('live extraction health records preflight, repairs, and one reconciled terminal outcome', () => {
  const metadata = {};
  const event = beginLiveExtractionEvent(metadata, { tier: 'session', chat_turn_id: 12, source_start: 8, source_end: 11, message_count: 4 });
  assert.equal(metadata.live_memory_health.last_extraction.terminal_health, 'running');
  updateLiveExtractionEvent(event, {
    preflight: { configured_context_limit: 8192, estimated_input_tokens: 1200, reserved_output_tokens: 500, safety_margin_tokens: 1000, usable_input_tokens: 6692, fits: true },
    provider_outcome: 'completed',
    candidates: { emitted: 3, accepted: 1, accepted_after_citation_repair: 1, rejected_missing_provenance: 1 },
  });
  finishLiveExtractionEvent(metadata, event, { terminal_health: 'completed', persistence: 'saved' });
  assert.equal(event.candidate_totals_reconciled, true);
  assert.equal(event.candidates.unresolved, 1);
  assert.equal(event.preflight.usable_input_budget, 6692);
  assert.equal(exportLiveMemoryHealth(metadata).recent_extraction_events[0].provider_outcome, 'completed');
});

test('live health exposes an active catch-up extraction before it reaches a terminal result', async () => {
  const { getLiveMemoryHealthSummary } = await import('../live-memory-health.js');
  const metadata = {};
  const event = beginLiveExtractionEvent(metadata, {
    tier: 'longterm', trigger_reason: 'memorize_chat_catch_up', source_start: 2400, source_end: 2599, message_count: 200,
  });
  const summary = getLiveMemoryHealthSummary(metadata);
  assert.equal(summary.last_extraction.terminal_health, 'running');
  assert.equal(summary.last_extraction_event.event_id, event.event_id);
  assert.deepEqual(summary.last_extraction_event.source_range, { start: 2400, end: 2599, message_count: 200 });
});

test('live health retains only bounded events while aggregate counters remain accurate', () => {
  const metadata = {};
  for (let index = 0; index < LIVE_MEMORY_HEALTH_MAX_EVENTS + 5; index++) {
    const event = beginLiveExtractionEvent(metadata, { tier: 'longterm' });
    finishLiveExtractionEvent(metadata, event, { terminal_health: 'completed', persistence: 'saved' });
  }
  const health = exportLiveMemoryHealth(metadata);
  assert.equal(health.recent_extraction_events.length, LIVE_MEMORY_HEALTH_MAX_EVENTS);
  assert.equal(health.aggregate.extraction.completed, LIVE_MEMORY_HEALTH_MAX_EVENTS + 5);
});

test('injection health distinguishes empty, failed attention, and unified stale-slot cleanup', () => {
  const metadata = {};
  const empty = recordLiveInjectionEvent(metadata, { terminal_health: 'empty', mode: 'individual', tiers: [] });
  const attention = recordLiveInjectionEvent(metadata, {
    terminal_health: 'completed', mode: 'unified', attention_reason_codes: ['stale_individual_slots_remaining'],
    integrity: { stale_tier_slots_remaining: 1, token_budget_respected: true },
  });
  assert.equal(empty.terminal_health, 'empty');
  assert.equal(attention.integrity.stale_tier_slots_remaining, 1);
  assert.equal(exportLiveMemoryHealth(metadata).aggregate.injection.empty, 1);
});

test('live health export is a read-only privacy-safe clone', () => {
  const metadata = {};
  const event = beginLiveExtractionEvent(metadata, { tier: 'session' });
  finishLiveExtractionEvent(metadata, event, { terminal_health: 'completed' });
  const exported = exportLiveMemoryHealth(metadata);
  exported.recent_extraction_events[0].tier = 'changed';
  assert.equal(metadata.live_memory_health.recent_extraction_events[0].tier, 'session');
  assert.doesNotMatch(JSON.stringify(exported), /chat text|provider response|api key/i);
});

test('continuity diagnostics are bounded and exclude prompt, response, and repair prose', () => {
  const metadata = {};
  for (let index = 0; index < CONTINUITY_HEALTH_MAX_EVENTS + 2; index++) {
    const event = beginContinuityEvent(metadata, { trigger: 'manual', fact_sources: { summary: 1 }, input_tokens: { summary: 12 } });
    finishContinuityEvent(metadata, event, { terminal_outcome: 'clean', parser_outcome: 'clean' });
  }
  const exported = exportLiveMemoryHealth(metadata);
  assert.equal(exported.recent_continuity_events.length, CONTINUITY_HEALTH_MAX_EVENTS);
  assert.doesNotMatch(JSON.stringify(exported), /secret prompt|provider response|repair prose/i);
});
