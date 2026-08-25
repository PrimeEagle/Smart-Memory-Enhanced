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
