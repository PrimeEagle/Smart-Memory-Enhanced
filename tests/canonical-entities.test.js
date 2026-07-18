import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCanonicalCharacterRoster,
  buildIdentityReviewCandidate,
  buildStableLedgerKey,
  buildStableRelationshipPair,
  canonicalizeRelationshipPair,
  reconcileCanonicalLedger,
  remapEntityIdInMemories,
  resolveCanonicalCharacterName,
} from '../canonical-entities.js';

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

test('canonical roster: group chat includes only active member cards', () => {
  const result = buildCanonicalCharacterRoster({
    groupId: 'g1',
    groups: [{ id: 'g1', members: ['paul.png'] }],
    characters: [{ name: 'Paul Schmidt', avatar: 'paul.png' }, { name: 'Unrelated Card', avatar: 'other.png' }],
  });
  assert.deepEqual(result.characters.map((entry) => entry.canonicalName), ['Paul Schmidt']);
});

test('canonical roster: active user persona is included alongside group members', () => {
  const result = buildCanonicalCharacterRoster({
    name1: 'Aaron Holland',
    groupId: 'g1',
    groups: [{ id: 'g1', members: ['paul.png'] }],
    characters: [{ name: 'Paul Schmidt', avatar: 'paul.png' }],
  });
  assert.deepEqual(result.characters.map((entry) => entry.canonicalName), ['Paul Schmidt', 'Aaron Holland']);
  assert.equal(resolveCanonicalCharacterName('Aaron Holland', result).status, 'resolved');
});

test('canonical roster: a unique persona first name resolves without creating a duplicate entity', () => {
  const personaRoster = buildCanonicalCharacterRoster({ name1: 'Kyle Holland', characters: [] });
  const result = resolveCanonicalCharacterName('Kyle', personaRoster);
  assert.equal(result.status, 'resolved');
  assert.equal(result.canonicalName, 'Kyle Holland');
  assert.equal(result.shouldCreateEntity, false);
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

test('phase 2: review candidates retain evidence and repeated-review identity', () => {
  const result = resolveCanonicalCharacterName('Paul Kawaguchi', roster);
  const item = buildIdentityReviewCandidate(result, { memoryId: 'memory-7', entityType: 'character', createdAt: 1 }, 'review-1');
  assert.equal(item.id, 'review-1');
  assert.equal(item.candidateKey, 'paul kawaguchi');
  assert.deepEqual(item.memoryIds, ['memory-7']);
  assert.equal(item.canonicalName, 'Paul Schmidt');
});

test('phase 2: duplicate merge redirects every memory reference without duplicates', () => {
  const memories = [{ id: 'a', entities: ['duplicate', 'target'] }, { id: 'b', entities: ['duplicate'] }, { id: 'c', entities: [] }];
  assert.equal(remapEntityIdInMemories(memories, 'duplicate', 'target'), true);
  assert.deepEqual(memories.map((memory) => memory.entities), [['target'], ['target'], []]);
});

test('phase 2: relationship and ledger keys use immutable card IDs but retain labels', () => {
  const pair = buildStableRelationshipPair('Paul', 'Alissa Kawaguchi', roster);
  assert.equal(pair.key, 'card:paul→card:alissa');
  assert.equal(pair.subject.displayName, 'Paul Schmidt');
  assert.equal(buildStableLedgerKey('Paul Kawaguchi', 'character', roster), 'card:paul|character');
});
