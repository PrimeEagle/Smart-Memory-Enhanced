import test from 'node:test';
import assert from 'node:assert/strict';
import { extractExplicitNamedFamilyCandidates, mergeRelationshipPairEvidence, migrateProfileRoleDescriptorSeparation, relationshipTypeForProfileTarget } from '../profile-role-utils.js';

test('profile role migration persists canonical roles separately from descriptors', () => {
  const migrated = migrateProfileRoleDescriptorSeparation({
    relationship_matrix_structured: [{
      target: 'Morgan Lee',
      canonical_relationship_type: 'Wife',
      relationship_descriptors: ['wife', 'protective', 'open', 'protective'],
    }],
  });
  assert.deepEqual(migrated.profile.relationship_matrix_structured, [{
    target: 'Morgan Lee',
    canonical_relationship_type: 'wife',
    relationship_descriptors: ['protective', 'open'],
  }]);
  assert.equal(migrated.profile.relationship_matrix, 'Morgan Lee [wife]: protective, open');
  assert.equal(migrated.profile_role_tokens_removed, 1);
  assert.equal(migrated.profile_fields_migrated_for_role_separation, 1);
});

test('profile role migration is idempotent and preserves role-free descriptors', () => {
  const first = migrateProfileRoleDescriptorSeparation({
    relationship_matrix_structured: [{
      target: 'Jamie Rivera', canonical_relationship_type: 'sister', descriptors: ['loyal'],
    }],
  });
  const second = migrateProfileRoleDescriptorSeparation(first.profile);
  assert.deepEqual(second.profile, first.profile);
  assert.equal(second.profile_role_tokens_removed, 0);
  assert.equal(second.profile_fields_migrated_for_role_separation, 0);
});

test('relationship type selection uses target-relative direction without unsafe family inversion', () => {
  assert.equal(relationshipTypeForProfileTarget(
    { subject: 'morgan lee', target: 'alex rivera', relationship_type: 'wife' },
    'alex rivera', 'morgan lee',
  ), 'wife');
  assert.equal(relationshipTypeForProfileTarget(
    { subject: 'morgan lee', target: 'alex rivera', relationship_type: 'mother' },
    'alex rivera', 'morgan lee',
  ), 'mother');
  assert.equal(relationshipTypeForProfileTarget(
    { subject: 'alex rivera', target: 'morgan lee', relationship_type: 'mother' },
    'alex rivera', 'morgan lee',
  ), 'mother');
});

test('typed relationship evidence wins over descriptor-only history', () => {
  const merged = mergeRelationshipPairEvidence(
    { subject: 'alex rivera', target: 'morgan lee', descriptors: ['wife', 'protective'] },
    { subject: 'alex rivera', target: 'morgan lee', relationship_type: 'wife', relationship_type_source: 'grounded_raw_chat_evidence', relationship_type_source_ids: ['chat-message:4'], descriptors: ['open'] },
  );
  assert.equal(merged.relationship_type, 'wife');
  assert.equal(merged.relationship_type_source, 'grounded_raw_chat_evidence');
  assert.deepEqual(merged.descriptors, ['protective', 'open']);
});

test('named family parser accepts explicit participants and rejects pronoun-only claims', () => {
  const candidates = extractExplicitNamedFamilyCandidates([
    { mes: 'Morgan Lee is the mother of Alex Rivera and Jamie Rivera.', __sme_original_index: 17 },
    { mes: "Casey Park is Alex Rivera's sister." },
    { mes: 'Alex Rivera was staring at her mother.' },
  ]);
  assert.deepEqual(candidates, [
    { subject: 'Morgan Lee', target: 'Alex Rivera', relationship_type: 'mother', source_index: 17 },
    { subject: 'Morgan Lee', target: 'Jamie Rivera', relationship_type: 'mother', source_index: 17 },
    { subject: 'Casey Park', target: 'Alex Rivera', relationship_type: 'sister', source_index: 1 },
  ]);
});

test('named family parser preserves direction for possessive and reverse-possessive forms', () => {
  const candidates = extractExplicitNamedFamilyCandidates([
    { mes: "Alex Rivera and Jamie Rivera's father is Morgan Lee." },
    { mes: "Casey Park's sister is Alex Rivera." },
    { mes: "Jamie Rivera is Alex Rivera's brother." },
    { mes: 'Alex Rivera and Jamie Rivera arrived together.' },
  ]);
  assert.deepEqual(candidates, [
    { subject: 'Morgan Lee', target: 'Alex Rivera', relationship_type: 'father', source_index: 0 },
    { subject: 'Morgan Lee', target: 'Jamie Rivera', relationship_type: 'father', source_index: 0 },
    { subject: 'Alex Rivera', target: 'Casey Park', relationship_type: 'sister', source_index: 1 },
    { subject: 'Jamie Rivera', target: 'Alex Rivera', relationship_type: 'brother', source_index: 2 },
  ]);
});
