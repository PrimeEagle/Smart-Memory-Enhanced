/** Authoritative, content-free selection for malformed-output recovery. */

export const RECOVERY_STAGE_ORDER = Object.freeze([
  'compact_response_repair',
  'changed_dimension_regeneration',
  'malformed_source_repartition',
  'structured_json_regeneration',
  'minimal_record_regeneration',
  'single_source_unit_regeneration',
]);

export const RECOVERY_IMPLEMENTATION_VERSION = 4;

const unique = (values = []) => [...new Set(values.filter(Boolean))];

/**
 * Selects a recovery action from the durable state of one exact source window.
 * Root-obligation history from sibling windows must not be supplied here.
 */
export function deriveRecoveryStageEligibility(state = {}) {
  const attemptedStages = unique(state.attempted_stages ?? state.recovery_stages_attempted ?? []);
  const exhaustedStages = unique(state.exhausted_stages ?? attemptedStages);
  const unresolvedUnits = unique(state.unresolved_semantic_units ?? []);
  const unitOutcomes = Array.isArray(state.unit_outcomes) ? state.unit_outcomes : [];
  const unitOutcomeByKey = new Map(unitOutcomes.map((item) => [String(item?.source_unit_key), item]));
  const unitsRequiringImplementationUpgrade = unresolvedUnits.filter((unitKey) => {
    const outcome = unitOutcomeByKey.get(String(unitKey));
    return outcome && String(outcome.disposition ?? '').startsWith('blocked_')
      && Number(outcome.recovery_implementation_version ?? 3) < RECOVERY_IMPLEMENTATION_VERSION;
  });
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
  if ((state.implementation_version_changed === true || unitsRequiringImplementationUpgrade.length > 0)
    && exhaustedStages.includes('single_source_unit_regeneration')
    && unresolvedUnits.length > 0) {
    return {
      schema_version: 2,
      blocked: false,
      eligible_action: 'single_source_unit_regeneration',
      reason_code: 'updated_recovery_implementation_available',
      changed_dimensions: ['recovery_implementation_version', 'single_source_pipe_contract',
        'owner_applicability_gate', 'fragment_validation', 'provider_role_separation',
        'native_structured_output_when_supported', 'bounded_contract_enforcement_retry'],
      expected_progress: `resolve_${unresolvedUnits.length}_remaining_source_units`,
      replay_permission: 'updated_implementation_changed_recovery_dimension',
      attempted_stages: attemptedStages,
      exhausted_stages: exhaustedStages,
      accepted_partial_record_count: acceptedPartialCount,
      unresolved_semantic_units: unresolvedUnits,
      implementation_upgrade_source_units: unitsRequiringImplementationUpgrade.length
        ? unitsRequiringImplementationUpgrade : unresolvedUnits,
    };
  }
  const terminalUnitKeys = new Set(unitOutcomes
    .filter((item) => ['record_staged', 'validated_no_update', 'blocked_provider_failure', 'blocked_validation']
      .includes(item?.disposition))
    .map((item) => String(item.source_unit_key)));
  const unattemptedUnits = unresolvedUnits.filter((unitKey) => !terminalUnitKeys.has(String(unitKey)));
  if (exhaustedStages.includes('single_source_unit_regeneration') && unattemptedUnits.length > 0) {
    return {
      schema_version: 2,
      blocked: false,
      eligible_action: 'single_source_unit_regeneration',
      reason_code: 'unattempted_source_units_remain',
      changed_dimensions: ['source_unit'],
      expected_progress: `attempt_${unattemptedUnits.length}_remaining_source_units`,
      replay_permission: 'per_unit_obligation_not_attempted',
      attempted_stages: attemptedStages,
      exhausted_stages: exhaustedStages,
      accepted_partial_record_count: acceptedPartialCount,
      unresolved_semantic_units: unresolvedUnits,
      unattempted_semantic_units: unattemptedUnits,
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

