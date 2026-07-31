import test from 'node:test';
import assert from 'node:assert/strict';
import { isCanonicalProfileSelfTarget } from '../profile-self-target-utils.js';

const owner = { ownerCanonicalId: 'card:taylor.png', ownerCanonicalName: 'Taylor Covington' };

test('canonical self-target aliases are rejected', () => {
  assert.equal(isCanonicalProfileSelfTarget({ ...owner, targetLabel: 'Taylor', targetResolution: { status: 'resolved', canonicalId: 'card:taylor.png', canonicalName: 'Taylor Covington' } }), true);
  assert.equal(isCanonicalProfileSelfTarget({ ...owner, targetLabel: 'Taylor Covington', targetResolution: { status: 'resolved', canonicalId: 'card:taylor.png', canonicalName: 'Taylor Covington' } }), true);
});

test('ambiguous same-first-name labels are not treated as self', () => {
  assert.equal(isCanonicalProfileSelfTarget({ ...owner, targetLabel: 'Taylor', targetResolution: { status: 'ambiguous' } }), false);
});

test('an exact unambiguous owner name is still rejected without roster data', () => {
  assert.equal(isCanonicalProfileSelfTarget({ ...owner, targetLabel: 'Taylor Covington', targetResolution: { status: 'unresolved' } }), true);
});
