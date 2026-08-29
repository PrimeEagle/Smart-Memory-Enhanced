import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_MEMORY_HEALTH_MAX_EVENTS,
  beginLiveExtractionEvent,
  updateLiveExtractionEvent,
  finishLiveExtractionEvent,
  recordLiveInjectionEvent,
  exportLiveMemoryHealth,
} from '../live-memory-health.js';

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
