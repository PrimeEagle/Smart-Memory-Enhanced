/** Authoritative, content-free selection for malformed-output recovery. */

export const RECOVERY_STAGE_ORDER = Object.freeze([
  'compact_response_repair',
  'changed_dimension_regeneration',
  'malformed_source_repartition',
  'structured_json_regeneration',
  'minimal_record_regeneration',
  'single_source_unit_regeneration',
]);

const unique = (values = []) => [...new Set(values.filter(Boolean))];

/**
 * Selects a recovery action from the durable state of one exact source window.
 * Root-obligation history from sibling windows must not be supplied here.
 */
export function deriveRecoveryStageEligibility(state = {}) {
  const attemptedStages = unique(state.attempted_stages ?? state.recovery_stages_attempted ?? []);
  const exhaustedStages = unique(state.exhausted_stages ?? attemptedStages);
  const unresolvedUnits = unique(state.unresolved_semantic_units ?? []);
  const acceptedPartialCount = Number(state.accepted_partial_record_count ?? 0) || 0;
  const availableStages = unique(state.available_stages ?? RECOVERY_STAGE_ORDER);
  const furthestAttemptedIndex = attemptedStages.reduce((maximum, stage) =>
    Math.max(maximum, availableStages.indexOf(stage)), -1);
  const nextUntried = availableStages.find((stage, index) =>
    index > furthestAttemptedIndex && !exhaustedStages.includes(stage));
  if (nextUntried) {
    return {
      schema_version: 1,
      blocked: false,
      eligible_action: nextUntried,
      reason_code: nextUntried === 'single_source_unit_regeneration'
        ? 'post_minimal_single_unit_fallback_available' : 'untried_recovery_stage_available',
      changed_dimensions: nextUntried === 'single_source_unit_regeneration'
        ? ['source_unit', 'single_record_contract', 'owner_tier_scope', 'mandatory_local_citation']
        : [nextUntried],
      expected_progress: unresolvedUnits.length
        ? `resolve_${unresolvedUnits.length}_remaining_source_units` : 'resolve_current_source_window',
      replay_permission: 'changed_recovery_dimension',
      attempted_stages: attemptedStages,
      exhausted_stages: exhaustedStages,
      accepted_partial_record_count: acceptedPartialCount,
      unresolved_semantic_units: unresolvedUnits,
    };
  }
  return {
    schema_version: 1,
    blocked: true,
    eligible_action: null,
    reason_code: 'all_recovery_stages_exhausted_for_unchanged_inputs',
    changed_dimensions: [],
    expected_progress: 'none_without_source_provider_configuration_or_parser_change',
    replay_permission: 'prohibited_duplicate',
    attempted_stages: attemptedStages,
    exhausted_stages: exhaustedStages,
    accepted_partial_record_count: acceptedPartialCount,
    unresolved_semantic_units: unresolvedUnits,
  };
}

