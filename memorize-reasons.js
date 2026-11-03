/**
 * Canonical reason vocabulary for Memorize Chat lifecycle outcomes.
 *
 * Durable state stores the stable `code`; UI copy and legacy exception names
 * are projections. New recovery paths must register a reason here instead of
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
  ['recovery_request_budget_reached_with_pending_children', 'recovery', true, 'resume_exact_obligation'],
  ['recovery_stage_ladder_exhausted', 'recovery', true, 'resume_exact_obligation'],
  ['recovery_path_exhausted', 'recovery', false, 'change_provider_or_configuration'],
  ['all_recovery_stages_exhausted_for_unchanged_inputs', 'recovery', false, 'change_provider_or_configuration'],
  ['partial_valid_output_has_unresolved_fragments', 'recovery', true, 'resume_exact_obligation'],
  ['downstream_validation_pending', 'validation', true, 'replay_terminal_provider_downstream_lifecycle'],
  ['tier_coverage_incomplete', 'validation', true, 'resume_exact_obligation'],
  ['persistence_failure', 'persistence', true, 'resume_exact_obligation'],
  ['checkpoint_persistence_failure', 'persistence', true, 'resume_exact_obligation'],
  ['catchup_transaction_commit_failed', 'persistence', true, 'resume_exact_obligation'],
  ['catchup_transaction_rollback_failed', 'persistence', false, null],
  ['provider_failure', 'provider', true, 'retry_provider_attempt'],
  ['malformed_provider_output', 'provider', true, 'repair_or_split_source_range'],
  ['internal_exception', 'internal', false, null],
].map(([code, category, resumable, next_action]) => Object.freeze({
  code, category, resumable, next_action,
}));

export const MEMORIZE_REASONS = Object.freeze(Object.fromEntries(
  DEFINITIONS.map((definition) => [definition.code, definition]),
));

const LEGACY_CODE_ALIASES = Object.freeze({
  SME_RECOVERY_BUDGET_PAUSE: 'recovery_request_budget_reached_with_pending_children',
  SME_MALFORMED_PROVIDER_OUTPUT: 'malformed_provider_output',
  SME_RECOVERY_PATH_EXHAUSTED: 'recovery_path_exhausted',
  SME_DOWNSTREAM_VALIDATION_PENDING: 'downstream_validation_pending',
  SME_CATCHUP_TRANSACTION_COMMIT_FAILED: 'catchup_transaction_commit_failed',
  SME_CATCHUP_TRANSACTION_ROLLBACK_FAILED: 'catchup_transaction_rollback_failed',
});

export function normalizeMemorizeReasonCode(value, fallback = 'internal_exception') {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  if (LEGACY_CODE_ALIASES[raw]) return LEGACY_CODE_ALIASES[raw];
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

