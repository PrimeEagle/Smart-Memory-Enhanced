import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveProfileCoverageOutcome, describeProfileFormatCorrection, summarizeProfileTerminalCoverage } from '../profile-recovery-utils.js';

test('profile format correction coverage distinguishes recovered, prior, and safe pending outcomes', () => {
  assert.equal(deriveProfileCoverageOutcome({ parsedInitial: true }), 'saved_initial');
  assert.equal(deriveProfileCoverageOutcome({ parsedCorrection: true }), 'saved_after_format_correction');
  assert.equal(deriveProfileCoverageOutcome({ hasPriorProfile: true }), 'preserved_prior');
  assert.equal(deriveProfileCoverageOutcome({ hasSafePendingState: true }), 'safe_pending_or_fallback');
  assert.equal(deriveProfileCoverageOutcome({}), 'unresolved');
});

test('profile terminal accounting gives every attempt exactly one terminal coverage outcome', () => {
  const summary = summarizeProfileTerminalCoverage([
    { profile_coverage_outcome: 'saved_initial', usable_profile_after_run: true },
    { profile_coverage_outcome: 'saved_after_format_correction', usable_profile_after_run: true },
    { profile_coverage_outcome: 'preserved_prior', usable_profile_after_run: true },
    { profile_coverage_outcome: 'safe_pending_or_fallback', usable_profile_after_run: false },
  ]);
  assert.equal(summary.attempted, 4);
  assert.equal(summary.terminal_count, 4);
  assert.equal(summary.terminal_reconciled, true);
  assert.equal(summary.usable_profiles, 3);
  assert.equal(summary.pending_profiles, 1);
  assert.equal(summary.unresolved_profiles, 0);
});

test('format correction diagnostics distinguish provider failures, omissions, malformed output, and strict recovery', () => {
  assert.deepEqual(describeProfileFormatCorrection({ attempted: true, providerError: 'Bad Gateway' }), {
    format_correction_attempted: true,
    format_correction_request_count: 1,
    format_correction_provider_outcome: 'provider_error',
    format_correction_parser_outcome: 'unparseable_required_sections',
  });
  assert.equal(describeProfileFormatCorrection({ attempted: true }).format_correction_provider_outcome, 'returned_none');
  assert.equal(describeProfileFormatCorrection({ attempted: true, response: '<character_state>broken' }).format_correction_parser_outcome, 'unparseable_required_sections');
  assert.equal(describeProfileFormatCorrection({ attempted: true, response: '<character_state>x</character_state>', strictParsed: true }).format_correction_parser_outcome, 'strict_parsed');
});

test('unresolved profile coverage remains visible rather than being silently counted as pending', () => {
  const summary = summarizeProfileTerminalCoverage([{ profile_coverage_outcome: 'unresolved' }]);
  assert.equal(summary.unresolved_profiles, 1);
  assert.equal(summary.pending_profiles, 0);
  assert.equal(summary.terminal_reconciled, true);
});
