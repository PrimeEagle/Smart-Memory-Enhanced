/** Adaptive protocol and bounded physical-attempt policy for Memorize Chat. */

export const MEMORIZE_PROVIDER_POLICY_VERSION = 1;
export const DEFAULT_MAX_PROVIDER_TRANSMISSIONS_PER_OBLIGATION = 3;
export const DEFAULT_MAX_REQUEST_AMPLIFICATION = 2;

export function createMemorizeProviderProfile(input = {}) {
  return {
    schema_version: MEMORIZE_PROVIDER_POLICY_VERSION,
    signature: input.signature ?? 'unknown-provider-profile',
    native_json_schema_observed: input.native_json_schema_observed === true,
    selected_protocol: input.native_json_schema_observed === true
      ? 'structured_json_schema_v1' : 'simple_json_records_v1',
    structural_failure_count: Number(input.structural_failure_count) || 0,
    transport_failure_count: Number(input.transport_failure_count) || 0,
    logical_obligation_count: Number(input.logical_obligation_count) || 0,
    physical_attempt_count: Number(input.physical_attempt_count) || 0,
    disabled_recovery_stages: [...new Set(input.disabled_recovery_stages ?? [])],
    recovery_stage_results: { ...(input.recovery_stage_results ?? {}) },
  };
}

export function selectMemorizeProviderProtocol(profileValue = {}, input = {}) {
  const profile = createMemorizeProviderProfile(profileValue);
  if (profile.native_json_schema_observed) return Object.freeze({
    protocol: 'structured_json_schema_v1', reason_code: 'native_json_schema_observed',
  });
  if (profile.structural_failure_count >= 2) return Object.freeze({
    protocol: 'simple_json_records_v1', reason_code: 'repeated_structural_contract_failure',
  });
  return Object.freeze({ protocol: input.fallback_protocol ?? 'tagged_lines_v1',
    reason_code: 'fallback_protocol_initial_attempt' });
}

export function recordMemorizeProviderOutcome(profileValue, outcome = {}) {
  const profile = createMemorizeProviderProfile(profileValue);
  profile.physical_attempt_count += outcome.provider_request_sent === false ? 0 : 1;
  if (outcome.new_logical_obligation === true) profile.logical_obligation_count += 1;
  if (outcome.classification === 'structural_failure') profile.structural_failure_count += 1;
  if (outcome.classification === 'transport_failure') profile.transport_failure_count += 1;
  const stage = outcome.recovery_stage;
  if (stage) {
    const stats = profile.recovery_stage_results[stage] ?? { attempted: 0, succeeded: 0 };
    stats.attempted += 1;
    if (outcome.succeeded === true) stats.succeeded += 1;
    profile.recovery_stage_results[stage] = stats;
    if (stats.attempted >= 5 && stats.succeeded / stats.attempted < 0.1) {
      profile.disabled_recovery_stages = [...new Set([...profile.disabled_recovery_stages, stage])];
    }
  }
  profile.selected_protocol = selectMemorizeProviderProtocol(profile).protocol;
  return profile;
}

export function assessMemorizeProviderDispatch(profileValue, input = {}) {
  const profile = createMemorizeProviderProfile(profileValue);
  const leafAttemptCount = Number(input.leaf_attempt_count) || 0;
  const maximum = Number(input.maximum_transmissions)
    || DEFAULT_MAX_PROVIDER_TRANSMISSIONS_PER_OBLIGATION;
  const amplification = profile.logical_obligation_count > 0
    ? profile.physical_attempt_count / profile.logical_obligation_count : 0;
  if (leafAttemptCount >= maximum) return Object.freeze({ allowed: false,
    reason_code: 'logical_obligation_attempt_budget_exhausted', maximum_transmissions: maximum,
    amplification });
  if (profile.logical_obligation_count >= 2
    && amplification >= Number(input.maximum_amplification ?? DEFAULT_MAX_REQUEST_AMPLIFICATION)) {
    return Object.freeze({ allowed: false, reason_code: 'run_request_amplification_guard',
      maximum_transmissions: maximum, amplification });
  }
  return Object.freeze({ allowed: true, reason_code: 'bounded_dispatch_allowed',
    maximum_transmissions: maximum, amplification,
    protocol: selectMemorizeProviderProtocol(profile, input).protocol });
}

export function shouldRepartitionMemorizeSource(outcome = {}) {
  return ['context_pressure', 'source_range_complexity', 'output_size_pressure']
    .includes(outcome.classification);
}

