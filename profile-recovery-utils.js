/**
 * Privacy-safe terminal policy for one profile-generation attempt. This does
 * not inspect model text: callers provide only parser/provider outcomes.
 */
export const PROFILE_COVERAGE_OUTCOMES = Object.freeze([
  'saved_initial',
  'saved_after_format_correction',
  'preserved_prior',
  'safe_pending_or_fallback',
  'unresolved',
]);

export function deriveProfileCoverageOutcome({
  parsedInitial = false,
  parsedCorrection = false,
  hasPriorProfile = false,
  hasSafePendingState = false,
} = {}) {
  if (parsedInitial) return 'saved_initial';
  if (parsedCorrection) return 'saved_after_format_correction';
  if (hasPriorProfile) return 'preserved_prior';
  if (hasSafePendingState) return 'safe_pending_or_fallback';
  return 'unresolved';
}

export function describeProfileFormatCorrection({
  attempted = false,
  response = null,
  providerError = null,
  strictParsed = false,
} = {}) {
  const hasResponse = Boolean(String(response ?? '').trim());
  return {
    format_correction_attempted: attempted,
    format_correction_request_count: attempted ? 1 : 0,
    format_correction_provider_outcome: !attempted
      ? 'not_attempted'
      : providerError ? 'provider_error'
        : hasResponse ? 'non_empty_response'
          : 'returned_none',
    format_correction_parser_outcome: !attempted
      ? 'not_attempted'
      : strictParsed ? 'strict_parsed'
        : 'unparseable_required_sections',
  };
}

export function summarizeProfileTerminalCoverage(attempts = []) {
  const coverage = Object.fromEntries(PROFILE_COVERAGE_OUTCOMES.map((outcome) => [outcome, 0]));
  let usableProfiles = 0;
  for (const attempt of attempts) {
    const outcome = String(attempt?.profile_coverage_outcome ?? attempt?.terminal_outcome ?? 'unresolved');
    if (outcome in coverage) coverage[outcome]++;
    else coverage.unresolved++;
    if (attempt?.usable_profile_after_run) usableProfiles++;
  }
  const terminalCount = Object.values(coverage).reduce((total, count) => total + count, 0);
  return {
    ...coverage,
    attempted: attempts.length,
    terminal_count: terminalCount,
    terminal_reconciled: terminalCount === attempts.length,
    usable_profiles: usableProfiles,
    pending_profiles: coverage.safe_pending_or_fallback,
    unresolved_profiles: coverage.unresolved,
  };
}


/**
 * Converts terminal attempt records into the single, privacy-safe completion
 * view used by status, export, and the pending-profile UI.  A safe pending
 * record is deliberately not an integrity error, but it is not a clean
 * generation result when no usable profile exists.
 */
export function summarizeProfileCompletion(attempts = [], { enabledProfileCount = null } = {}) {
  const coverage = summarizeProfileTerminalCoverage(attempts);
  const terminalOutcomeCounts = {};
  let savedProfileCount = 0;
  let preservedPriorProfileCount = 0;
  let skippedDueToCancellationCount = 0;
  let providerFailureCount = 0;
  let malformedOutputCount = 0;
  for (const attempt of attempts) {
    const outcome = String(attempt?.profile_coverage_outcome ?? attempt?.terminal_outcome ?? 'unresolved');
    terminalOutcomeCounts[outcome] = (terminalOutcomeCounts[outcome] ?? 0) + 1;
    if (['saved_initial', 'saved_after_format_correction'].includes(outcome)) savedProfileCount++;
    if (outcome === 'preserved_prior' || attempt?.prior_profile_preserved) preservedPriorProfileCount++;
    if (attempt?.terminal_outcome === 'skipped_due_to_cancellation' || attempt?.error_stage === 'cancelled') skippedDueToCancellationCount++;
    if (attempt?.error_stage === 'provider_or_persistence') providerFailureCount++;
    if (['format_correction', 'profile_grounding_validation'].includes(attempt?.error_stage)) malformedOutputCount++;
  }
  const pendingProfileCount = attempts.filter((attempt) => Boolean(attempt?.pending_generation_state) && !attempt?.usable_profile_after_run).length;
  const unresolvedProfileCount = attempts.filter((attempt) => !attempt?.usable_profile_after_run
    && !attempt?.pending_generation_state
    && attempt?.terminal_outcome !== 'skipped_due_to_cancellation').length;
  const attentionReasonCodes = [];
  if (pendingProfileCount) attentionReasonCodes.push('profile_pending_regeneration');
  if (unresolvedProfileCount) attentionReasonCodes.push('profile_no_usable_result');
  if (providerFailureCount) attentionReasonCodes.push('profile_provider_failure');
  if (malformedOutputCount) attentionReasonCodes.push('profile_malformed_output');
  return {
    ...coverage,
    enabled_profile_count: enabledProfileCount ?? attempts.length,
    attempted_profile_count: attempts.length,
    usable_profile_count: coverage.usable_profiles,
    saved_profile_count: savedProfileCount,
    preserved_prior_profile_count: preservedPriorProfileCount,
    pending_profile_count: pendingProfileCount,
    unresolved_profile_count: unresolvedProfileCount,
    skipped_due_to_cancellation_count: skippedDueToCancellationCount,
    provider_failure_count: providerFailureCount,
    malformed_output_count: malformedOutputCount,
    terminal_outcome_counts: terminalOutcomeCounts,
    quality_attention_reason_codes: attentionReasonCodes,
    attention_required: attentionReasonCodes.length > 0,
    user_action_available: pendingProfileCount > 0,
  };
}
