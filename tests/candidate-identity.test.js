import assert from 'node:assert/strict';
import test from 'node:test';

import { assignCandidateIdentity, candidateIdentityOf, copyCandidateIdentity,
  deriveCandidateIdentity }
  from '../candidate-identity.js';

test('candidate identity survives copies, normalization, and active-record merging', () => {
  const parsed = assignCandidateIdentity({ type: 'fact', content: '  A fact  ' }, 'candidate:1');
  parsed.content = parsed.content.trim();
  const copied = structuredClone(parsed);
  const merged = copyCandidateIdentity(copied, { ...copied, id: 'record:1' });
  assert.equal(candidateIdentityOf(parsed), 'candidate:1');
  assert.equal(candidateIdentityOf(copied), 'candidate:1');
  assert.equal(candidateIdentityOf(merged), 'candidate:1');
});

test('candidate identity is immutable without an explicit derived-candidate receipt', () => {
  const candidate = assignCandidateIdentity({ content: 'A fact' }, 'candidate:1');
  assert.throws(() => assignCandidateIdentity(candidate, 'candidate:2'),
    (error) => error.code === 'SME_CANDIDATE_IDENTITY_MUTATION_REJECTED');
});

test('identity survives citation repair, validation, deduplication, consolidation, and owner partitioning', () => {
  const parsed = assignCandidateIdentity({ content: 'fact', citations: [3], owner: 'Alex' },
    'candidate:pipeline');
  const citationRepaired = copyCandidateIdentity(parsed, { ...parsed, citations: [3, 4] });
  const validated = copyCandidateIdentity(citationRepaired, { ...citationRepaired,
    validation_status: 'accepted' });
  const deduplicated = [validated, structuredClone(validated)]
    .filter((item, index, items) => items.findIndex((other) =>
      candidateIdentityOf(other) === candidateIdentityOf(item)) === index);
  const consolidated = copyCandidateIdentity(deduplicated[0], {
    ...deduplicated[0], id: 'record:consolidated', retired: false,
  });
  const ownerPartitions = new Map();
  for (const item of [consolidated]) {
    ownerPartitions.set(item.owner, [...(ownerPartitions.get(item.owner) ?? []), item]);
  }
  assert.equal(candidateIdentityOf(ownerPartitions.get('Alex')[0]), 'candidate:pipeline');
});

test('legitimate derived candidates retain parent identity and a transformation receipt', () => {
  const parent = assignCandidateIdentity({ content: 'two supported facts' }, 'candidate:parent');
  const child = deriveCandidateIdentity(parent, { content: 'one supported fact' },
    'candidate:child', 'transform:split:1');
  assert.deepEqual(child.candidate_identity, {
    schema_version: 1, candidate_id: 'candidate:child',
    parent_candidate_id: 'candidate:parent',
    transformation_receipt_id: 'transform:split:1',
  });
  assert.throws(() => deriveCandidateIdentity(parent, {}, 'candidate:bad', ''),
    { code: 'SME_DERIVED_CANDIDATE_RECEIPT_REQUIRED' });
});
