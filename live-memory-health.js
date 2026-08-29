/**
 * Privacy-safe, bounded diagnostics for the incremental memory path.
 *
 * This module intentionally stores counts, ranges, reason codes, and token
 * estimates only. It never receives or serializes chat text, memory content,
 * provider responses, credentials, or unapproved identity labels.
 */

export const LIVE_MEMORY_HEALTH_SCHEMA_VERSION = 1;
export const LIVE_MEMORY_HEALTH_MAX_EVENTS = 75;

const extractionTerminalStates = new Set([
  'completed', 'completed_with_repairs', 'completed_repartitioned', 'empty',
  'prevented', 'provider_failure', 'malformed_response', 'persistence_failure',
  'unresolved', 'skipped',
]);

function number(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function boundedReasonCodes(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))].slice(0, 12);
}

function nextId(health, kind) {
  health.sequence = number(health.sequence) + 1;
  return `${kind}-${Date.now().toString(36)}-${health.sequence}`;
}

function trimEvents(health) {
  health.recent_extraction_events = (health.recent_extraction_events ?? []).slice(-LIVE_MEMORY_HEALTH_MAX_EVENTS);
  health.recent_injection_events = (health.recent_injection_events ?? []).slice(-LIVE_MEMORY_HEALTH_MAX_EVENTS);
}

function increment(object, key, amount = 1) {
  object[key] = number(object[key]) + amount;
}

export function ensureLiveMemoryHealth(metadata) {
  if (!metadata) return null;
  const health = metadata.live_memory_health ??= {};
  health.schema_version = LIVE_MEMORY_HEALTH_SCHEMA_VERSION;
  health.sequence = number(health.sequence);
  health.recent_extraction_events ??= [];
  health.recent_injection_events ??= [];
  health.aggregate ??= { extraction: {}, injection: {}, attention_count: 0 };
  health.aggregate.extraction ??= {};
  health.aggregate.injection ??= {};
  trimEvents(health);
  return health;
}

export function beginLiveExtractionEvent(metadata, input = {}) {
  const health = ensureLiveMemoryHealth(metadata);
  if (!health) return null;
  const now = Date.now();
  const event = {
    event_id: nextId(health, 'extract'),
    timestamp: now,
    chat_turn_id: input.chat_turn_id ?? null,
    tier: input.tier ?? 'unknown',
    trigger_reason: input.trigger_reason ?? 'periodic_cadence',
    source_range: {
      start: Number.isInteger(input.source_start) ? input.source_start : null,
      end: Number.isInteger(input.source_end) ? input.source_end : null,
      message_count: number(input.message_count),
    },
    window_selection_reason: input.window_selection_reason ?? 'stable_window',
    preflight: null,
    provider_outcome: 'not_started',
    candidates: { emitted: 0, accepted: 0, accepted_after_citation_repair: 0, rejected_duplicate: 0, rejected_missing_provenance: 0, rejected_validation: 0, unresolved: 0 },
    citation_mapping_valid: null,
    persistence: 'not_attempted',
    canonical: { accepted_reference_count: 0, suppressed_invalid_reference_count: 0, reason_codes: [] },
    terminal_health: 'running',
    attention_reason_codes: [],
  };
  health.recent_extraction_events.push(event);
  // Surface a running event immediately. The health card must describe the
  // current extraction rather than continuing to show an older completed one
  // until this request reaches its terminal path.
  health.last_extraction = {
    event_id: event.event_id,
    timestamp: event.timestamp,
    tier: event.tier,
    terminal_health: event.terminal_health,
    attention_reason_codes: event.attention_reason_codes,
  };
  increment(health.aggregate.extraction, 'attempted');
  trimEvents(health);
  return event;
}

export function updateLiveExtractionEvent(event, patch = {}) {
  if (!event) return;
  if (patch.preflight) {
    const preflight = patch.preflight;
    event.preflight = {
      configured_context_limit: number(preflight.configured_context_limit ?? preflight.configuredContextLimit),
      estimated_input_tokens: number(preflight.estimated_input_tokens ?? preflight.estimatedInputTokens),
      reserved_output_tokens: number(preflight.reserved_output_tokens ?? preflight.reservedOutputTokens),
      safety_margin: number(preflight.safety_margin ?? preflight.safety_margin_tokens ?? preflight.safetyMargin),
      usable_input_budget: number(preflight.usable_input_budget ?? preflight.usable_input_tokens ?? preflight.usableInputBudget),
      fits: Boolean(preflight.fits),
      resized_or_repartitioned: Boolean(preflight.resized_or_repartitioned),
      prevented: Boolean(preflight.prevented),
    };
  }
  if (patch.provider_outcome) event.provider_outcome = patch.provider_outcome;
  if (patch.candidates) Object.assign(event.candidates, Object.fromEntries(Object.entries(patch.candidates).map(([key, value]) => [key, number(value)])));
  if ('citation_mapping_valid' in patch) event.citation_mapping_valid = Boolean(patch.citation_mapping_valid);
  if (patch.persistence) event.persistence = patch.persistence;
  if (patch.canonical) {
    Object.assign(event.canonical, patch.canonical);
    event.canonical.reason_codes = boundedReasonCodes(event.canonical.reason_codes);
  }
  if (patch.attention_reason_codes) event.attention_reason_codes = boundedReasonCodes(patch.attention_reason_codes);
}

export function finishLiveExtractionEvent(metadata, event, patch = {}) {
  if (!event) return null;
  updateLiveExtractionEvent(event, patch);
  const health = ensureLiveMemoryHealth(metadata);
  event.terminal_health = extractionTerminalStates.has(patch.terminal_health) ? patch.terminal_health : 'unresolved';
  event.duration_ms = Math.max(0, Date.now() - number(event.timestamp, Date.now()));
  let totalTerminal = event.candidates.accepted + event.candidates.rejected_duplicate + event.candidates.rejected_missing_provenance + event.candidates.rejected_validation + event.candidates.unresolved;
  // Every emitted candidate needs one terminal account. A cap, safe abort, or
  // unknown parser disposition is explicitly unresolved instead of vanishing.
  if (event.candidates.emitted > totalTerminal) {
    event.candidates.unresolved += event.candidates.emitted - totalTerminal;
    totalTerminal = event.candidates.emitted;
    event.attention_reason_codes = boundedReasonCodes([...event.attention_reason_codes, 'candidate_terminal_outcome_unresolved']);
  }
  event.candidate_totals_reconciled = event.candidates.emitted === 0 || totalTerminal === event.candidates.emitted;
  increment(health.aggregate.extraction, event.terminal_health);
  increment(health.aggregate.extraction, 'accepted', event.candidates.accepted);
  if (event.attention_reason_codes.length || ['prevented', 'provider_failure', 'persistence_failure', 'unresolved'].includes(event.terminal_health)) {
    increment(health.aggregate, 'attention_count');
  }
  health.last_extraction = { event_id: event.event_id, timestamp: event.timestamp, tier: event.tier, terminal_health: event.terminal_health, attention_reason_codes: event.attention_reason_codes };
  trimEvents(health);
  return event;
}

export function recordLiveInjectionEvent(metadata, input = {}) {
  const health = ensureLiveMemoryHealth(metadata);
  if (!health) return null;
  const event = {
    event_id: nextId(health, 'inject'),
    timestamp: Date.now(),
    chat_turn_id: input.chat_turn_id ?? null,
    mode: input.mode ?? 'individual',
    placement: input.placement ?? null,
    configured_budgets: input.configured_budgets ?? {},
    tiers: (input.tiers ?? []).map((tier) => ({
      tier: tier.tier,
      available_eligible_count: number(tier.available_eligible_count),
      selected_count: number(tier.selected_count),
      injected_count: number(tier.injected_count),
      estimated_visible_tokens: number(tier.estimated_visible_tokens),
      injected_tokens: number(tier.injected_tokens),
      budget_remaining: number(tier.budget_remaining),
      exclusion_counts: tier.exclusion_counts ?? {},
    })).slice(0, 16),
    cache_invalidated: Boolean(input.cache_invalidated),
    cache_invalidation_reason: input.cache_invalidation_reason ?? null,
    integrity: {
      duplicate_record_fingerprints: number(input.integrity?.duplicate_record_fingerprints),
      dangling_canonical_references: number(input.integrity?.dangling_canonical_references),
      stale_tier_slots_remaining: number(input.integrity?.stale_tier_slots_remaining),
      token_budget_respected: input.integrity?.token_budget_respected !== false,
    },
    terminal_health: input.terminal_health ?? 'completed',
    attention_reason_codes: boundedReasonCodes(input.attention_reason_codes),
    duration_ms: number(input.duration_ms),
  };
  health.recent_injection_events.push(event);
  increment(health.aggregate.injection, event.terminal_health);
  if (event.attention_reason_codes.length || event.integrity.dangling_canonical_references || event.integrity.stale_tier_slots_remaining || !event.integrity.token_budget_respected) increment(health.aggregate, 'attention_count');
  health.last_injection = { event_id: event.event_id, timestamp: event.timestamp, mode: event.mode, terminal_health: event.terminal_health, attention_reason_codes: event.attention_reason_codes };
  trimEvents(health);
  return event;
}

export function getLiveMemoryHealthSummary(metadata) {
  const health = metadata?.live_memory_health;
  if (!health) return null;
  const lastExtractionEvent = (health.recent_extraction_events ?? []).findLast((event) => event.event_id === health.last_extraction?.event_id) ?? null;
  const lastInjectionEvent = (health.recent_injection_events ?? []).findLast((event) => event.event_id === health.last_injection?.event_id) ?? null;
  const attention = [health.last_extraction, health.last_injection].flatMap((event) => event?.attention_reason_codes ?? []);
  return {
    last_extraction: health.last_extraction ?? null,
    last_extraction_event: lastExtractionEvent,
    last_injection: health.last_injection ?? null,
    attention_reason_codes: boundedReasonCodes(attention),
    injected_tier_tokens: (lastInjectionEvent?.tiers ?? []).map((tier) => ({ tier: tier.tier, tokens: tier.injected_tokens })),
    aggregate: health.aggregate ?? {},
  };
}

export function exportLiveMemoryHealth(metadata) {
  const health = ensureLiveMemoryHealth(metadata);
  if (!health) return null;
  // Events are already privacy-safe. Clone them so diagnostics rendering/export
  // is strictly read-only and cannot mutate chat metadata.
  return JSON.parse(JSON.stringify({
    schema_version: health.schema_version,
    retention_limit: LIVE_MEMORY_HEALTH_MAX_EVENTS,
    aggregate: health.aggregate,
    last_extraction: health.last_extraction ?? null,
    last_injection: health.last_injection ?? null,
    recent_extraction_events: health.recent_extraction_events,
    recent_injection_events: health.recent_injection_events,
  }));
}
