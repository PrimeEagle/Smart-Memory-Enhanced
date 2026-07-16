import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCanonicalCharacterRoster, canonicalizeRelationshipPair, reconcileCanonicalLedger, resolveCanonicalCharacterName } from '../canonical-entities.js';

const roster = buildCanonicalCharacterRoster({
  characters: [
    { id: 'paul', name: 'Paul Schmidt', description: '' },
    { id: 'alissa', name: 'Alissa Kawaguchi', description: '' },
  ],
});

test('canonical roster: unique first names resolve to card names', () => {
  const result = resolveCanonicalCharacterName('Paul', roster);
  assert.equal(result.status, 'resolved');
  assert.equal(result.canonicalName, 'Paul Schmidt');
});

test('canonical roster: unsupported married surname is rejected but resolved', () => {
  const result = resolveCanonicalCharacterName('Paul Kawaguchi', roster);
  assert.equal(result.status, 'rejected');
  assert.equal(result.canonicalName, 'Paul Schmidt');
  assert.equal(result.shouldAddAlias, false);
});

test('canonical roster: unknown NPC remains creatable', () => {
  const result = resolveCanonicalCharacterName('Sophie', roster);
  assert.equal(result.status, 'unresolved');
  assert.equal(result.shouldCreateEntity, true);
});

test('canonical roster: ambiguous first name is not guessed', () => {
  const ambiguousRoster = buildCanonicalCharacterRoster({ characters: [{ name: 'Alex Morgan' }, { name: 'Alex Chen' }] });
  assert.equal(resolveCanonicalCharacterName('Alex', ambiguousRoster).status, 'ambiguous');
});

test('integration: registry candidates collapse to the canonical card identity', () => {
  const candidates = ['Paul', 'Paul Kawaguchi', 'Sophie'].map((name) => resolveCanonicalCharacterName(name, roster));
  assert.deepEqual(candidates.map((entry) => entry.canonicalName ?? entry.candidateName), ['Paul Schmidt', 'Paul Schmidt', 'Sophie']);
  assert.equal(candidates[1].shouldAddAlias, false);
});

test('integration: ledger variants merge without overwriting canonical fields', () => {
  const ledger = reconcileCanonicalLedger({
    'paul|character': { mood: 'concerned', location: 'home' },
    'paul kawaguchi|character': { mood: 'worried' },
    'paul schmidt|character': { mood: 'calm' },
  }, roster);
  assert.deepEqual(ledger['paul schmidt|character'], { mood: 'calm', location: 'home' });
  assert.equal(ledger['paul|character'], undefined);
  assert.equal(ledger['paul kawaguchi|character'], undefined);
});

test('integration: relationship pair uses canonical card names', () => {
  assert.deepEqual(canonicalizeRelationshipPair('Paul Kawaguchi', 'Alissa', roster), ['Paul Schmidt', 'Alissa Kawaguchi']);
});
