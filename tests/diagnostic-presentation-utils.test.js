import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDiagnosticIdentifier, runNonfatalPresentation } from '../diagnostic-presentation-utils.js';

test('diagnostic identifier formatting is total for persisted and malformed values', () => {
  assert.equal(formatDiagnosticIdentifier(null, 'pending recovery'), 'pending recovery');
  assert.equal(formatDiagnosticIdentifier(undefined, 'pending recovery'), 'pending recovery');
  assert.equal(formatDiagnosticIdentifier('', 'pending recovery'), 'pending recovery');
  assert.equal(formatDiagnosticIdentifier('fragment_decision_regeneration'), 'fragment decision regeneration');
  assert.equal(formatDiagnosticIdentifier(17), '17');
  assert.equal(formatDiagnosticIdentifier(false), 'false');
  assert.equal(formatDiagnosticIdentifier({ bad: true }, 'legacy value unavailable'), 'legacy value unavailable');
});

test('presentation failures are diagnosed and cannot escape into controller flow', () => {
  const observed = [];
  const result = runNonfatalPresentation('resume_status', () => {
    throw new TypeError('simulated renderer failure');
  }, (failure) => observed.push(failure));
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.equal(result.failure.category, 'nonfatal_presentation_failure');
  assert.equal(result.failure.normalized_exception_class, 'TypeError');
  assert.equal(observed.length, 1);
});
