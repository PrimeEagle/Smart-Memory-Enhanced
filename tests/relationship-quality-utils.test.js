import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRelationshipPairIdentity, summarizeRelationshipQuality } from '../relationship-quality-utils.js';

test('same character and card filename/name equivalents are rejected as self pairs', () => {
  assert.equal(classifyRelationshipPairIdentity({ subjectLabel: 'Aster Graves', targetLabel: 'Aster Graves' }).reason, 'apparent_self_pair');
  assert.equal(classifyRelationshipPairIdentity({ subjectLabel: 'card:Aster Graves.png', targetLabel: 'Aster Graves' }).reason, 'apparent_self_pair');
});

test('two distinct labels collapsing to one canonical identity are quarantined', () => {
  const result = classifyRelationshipPairIdentity({
    subjectLabel: 'Aster', targetLabel: 'A. Graves', resolutionAttempted: true,
    subjectCanonicalId: 'card:Aster Graves.png', targetCanonicalId: 'card:Aster Graves.png',
  });
  assert.deepEqual(result, { safe: false, reason: 'participants_collapse_to_same_canonical_identity' });
});

test('unresolved participants remain retained but unsafe for propagation without guessing', () => {
  const result = classifyRelationshipPairIdentity({
    subjectLabel: 'Aster', targetLabel: 'Unknown', resolutionAttempted: true,
    subjectCanonicalId: 'card:Aster Graves.png', targetCanonicalId: null,
  });
  assert.equal(result.reason, 'participant_not_safely_resolved');
});

test('relationship quality accounts for every quarantined final-audit pair', () => {
  const summary = summarizeRelationshipQuality({
    profileUnresolved: 2,
    unresolvedPairs: [{ excluded_from_injection: true }, { excluded_from_injection: false }],
    deterministicDebt: 1,
  });
  assert.equal(summary.unresolved_but_safe_records.count, 4);
  assert.equal(summary.unresolved_but_safe_records.ambiguous_noncanonical_pair_keys, 2);
  assert.equal(summary.ambiguous_noncanonical_pair_keys.quarantined_from_injection, 1);
  assert.equal(summary.accounting_invariant.reconciled, true);
});
