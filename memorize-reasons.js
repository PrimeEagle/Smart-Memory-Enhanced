/**
 * Canonical reason vocabulary for Memorize Chat lifecycle outcomes.
 *
 * Durable state stores the stable `code`; UI copy is a projection. New
 * recovery paths must register a reason here instead of
 * inventing another flag on an Error object.
 */

export const MEMORIZE_REASON_CATEGORIES = Object.freeze({
  COMPLETION: 'completion',
  OPERATOR: 'operator',
  RECOVERY: 'recovery',
  PERSISTENCE: 'persistence',
  PROVIDER: 'provider',
  VALIDATION: 'validation',
  INTERNAL: 'internal',
});

const DEFINITIONS = [
  ['completed', 'completion', false, null],
  ['manual_cancel', 'operator', false, null],
  ['already_running', 'operator', false, null],
  ['recovery_request_budget_reached_with_pending_children', 'recovery', true, 'dispatch_provider_request'],
  ['recovery_stage_ladder_exhausted', 'recovery', true, 'dispatch_provider_request'],
  ['recovery_path_exhausted', 'recovery', false, 'stop_blocked'],
  ['all_recovery_stages_exhausted_for_unchanged_inputs', 'recovery', false, 'stop_blocked'],
  ['partial_valid_output_has_unresolved_fragments', 'recovery', true, 'dispatch_provider_request'],
  ['downstream_validation_pending', 'validation', true, 'apply_journaled_provider_completion'],
  ['tier_coverage_incomplete', 'validation', true, 'dispatch_provider_request'],
  ['persistence_failure', 'persistence', true, 'dispatch_provider_request'],
  ['local_persistence_replay_required', 'persistence', true,
    'apply_journaled_provider_completion'],
  ['checkpoint_persistence_failure', 'persistence', true, 'dispatch_provider_request'],
  ['catchup_transaction_commit_failed', 'persistence', true, 'dispatch_provider_request'],
  ['catchup_transaction_rollback_failed', 'persistence', false, null],
  ['provider_failure', 'provider', true, 'dispatch_provider_request'],
  ['malformed_provider_output', 'provider', true, 'dispatch_provider_request'],
  ['non_serializable_domain_data', 'internal', false, null],
  ['effect_handler_not_registered', 'internal', false, null],
  ['internal_exception', 'internal', false, null],
].map(([code, category, resumable, next_action]) => Object.freeze({
  code, category, resumable, next_action,
}));

export const MEMORIZE_REASONS = Object.freeze(Object.fromEntries(
  DEFINITIONS.map((definition) => [definition.code, definition]),
));

export function normalizeMemorizeReasonCode(value, fallback = 'internal_exception') {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  return raw.toLowerCase().replace(/^sme_/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
}

export function getMemorizeReason(value, fallback = 'internal_exception') {
  const code = normalizeMemorizeReasonCode(value, fallback);
  return MEMORIZE_REASONS[code] ?? Object.freeze({
    code,
    category: MEMORIZE_REASON_CATEGORIES.INTERNAL,
    resumable: false,
    next_action: null,
    unregistered: true,
  });
}

