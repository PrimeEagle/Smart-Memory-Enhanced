import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCanonicalCharacterRoster,
  buildCanonicalRoster,
  canonicalizeNarrativeNames,
  resolveCanonicalCharacterName,
  deduplicateIdentityDecisions,
  normalizeSyntheticIdentityQualifier,
  sanitizeSyntheticIdentityLabels,
  canonicalizeStructuredParticipants,
  findCanonicalParticipantsInText,
  validateArcParticipants,
  buildIdentityReviewCandidate,
  buildStableLedgerKey,
  buildStableEntityReference,
  buildStableRelationshipPair,
  canonicalizeRelationshipPair,
  getCanonicalCardEntries,
  getCanonicalPersonaEntries,
  getCanonicalRosterPeople,
  reconcileCanonicalLedger,
  remapEntityIdInMemories,
  resolveEntityCandidate,
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

test('canonical roster: explicit active persona scope survives contexts without name1', () => {
  const scopedRoster = buildCanonicalRoster({ characters: [] }, {
    activePersona: { id: 'persona-kyle', name: 'Kyle Holland', aliases: ['Kyle'] },
  });
  assert.equal(scopedRoster.characters[0].canonical_id, 'persona:persona-kyle');
  assert.equal(scopedRoster.characters[0].source_type, 'persona');
  assert.equal(resolveCanonicalCharacterName('Kyle', scopedRoster).canonicalName, 'Kyle Holland');
  assert.equal(resolveCanonicalCharacterName('Kyle Holland', scopedRoster).canonicalName, 'Kyle Holland');
});

test('canonical roster rewrites a former persona label before prompt construction', () => {
  const personaRoster = buildCanonicalCharacterRoster({
    name1: 'Kyle Holland',
    persona: { name: 'Kyle Holland', previous_names: ['Adam Lawson'] },
    characters: [],
  });
  const rewritten = canonicalizeNarrativeNames('Adam Lawson discussed the plan.', personaRoster);
  assert.equal(rewritten.text, 'Kyle Holland discussed the plan.');
  const resolution = resolveCanonicalCharacterName('Adam Lawson', personaRoster);
  assert.equal(resolution.canonicalId, 'persona:kyle holland');
  assert.equal(resolution.reason, 'Historical active persona name.');
});

test('identity decision metadata deduplicates while retaining evidence', () => {
  const decisions = deduplicateIdentityDecisions([
    { from: 'Alissa', to: 'Alissa Kawaguchi', reason: 'Approved character-card alias.', source_message_indices: [4] },
    { from: 'Alissa', to: 'Alissa Kawaguchi', reason: 'Approved character-card alias.', source_message_indices: [8] },
  ], 'profile');
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0].source_message_indices, [4, 8]);
  assert.equal(decisions[0].occurrences, 2);
});

test('synthetic parenthetical identity labels normalize while legitimate numeric titles remain', () => {
  assert.equal(normalizeSyntheticIdentityQualifier('Sophie (Alissa Kawaguchi)', [{ name: 'Alissa Kawaguchi' }]).normalized_name, 'Sophie');
  assert.equal(normalizeSyntheticIdentityQualifier('Unit 01 (Prototype)', []).normalized_name, 'Unit 01 (Prototype)');
});

test('canonical roster: generated prose uses deterministic card-name replacements only', () => {
  const result = canonicalizeNarrativeNames('Paul Kawaguchi asks Kyle to wait for Sophie.', buildCanonicalCharacterRoster({
    name1: 'Kyle Holland',
    characters: [{ id: 'paul', name: 'Paul Schmidt', description: '' }],
  }));
  assert.equal(result.text, 'Paul Schmidt asks Kyle Holland to wait for Sophie.');
  assert.deepEqual(result.replacements.map((entry) => entry.to), ['Paul Schmidt', 'Kyle Holland']);
});

test('contradictory card-like names do not receive a canonical storage ID', () => {
  const reference = buildStableEntityReference('Paul Kawaguchi', roster);
  assert.equal(reference.displayName, 'Paul Kawaguchi');
  assert.equal(reference.canonicalId, null);
  assert.equal(reference.storageId, 'name:paul kawaguchi');
});

test('structured scene and arc participants use canonical cards but retain unknown NPCs', () => {
  const result = canonicalizeStructuredParticipants(['Paul', 'Sophie', 'Paul Kawaguchi'], roster);
  assert.deepEqual(result.names, ['Paul Schmidt', 'Sophie']);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].name, 'Paul Kawaguchi');
});

test('synthetic parenthetical labels are removed from generated arc prose only when known synthetic', () => {
  const roster = buildCanonicalCharacterRoster({
    characters: [{ id: 'sophie', name: 'Sophie', description: '' }, { id: 'alissa', name: 'Alissa Kawaguchi', description: '' }],
  });
  const result = sanitizeSyntheticIdentityLabels('Sophie (Alissa Kawaguchi) still needs to answer the letter. Unit 01 (Prototype) remains offline.', roster);
  assert.equal(result.text, 'Sophie still needs to answer the letter. Unit 01 (Prototype) remains offline.');
  assert.deepEqual(result.removals, [{ from: 'Sophie (Alissa Kawaguchi)', to: 'Sophie', qualifier_type: 'known_entity_context' }]);
});

test('arc participants require support in the arc content or source evidence', () => {
  const result = validateArcParticipants(['Paul', 'Sophie'], roster, {
    content: 'Paul must decide whether to expose the forged treaty.',
    evidenceText: 'Paul discussed the risk with the council.',
  });
  assert.deepEqual(result.names, ['Paul Schmidt']);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].name, 'Sophie');
  assert.match(result.rejected[0].reason, /not named/i);
});

test('arc participants add canonical people explicitly named in arc content', () => {
  const result = validateArcParticipants(['Alissa Kawaguchi'], roster, {
    content: 'Kyle Holland and Paul Schmidt need to discuss long-term travel rules.',
    evidenceText: '',
  });
  assert.deepEqual(result.names, ['Paul Schmidt']);
  assert.deepEqual(result.added, [{ name: 'Paul Schmidt', reason: 'Named directly in arc content.' }]);
  assert.equal(result.rejected[0].name, 'Alissa Kawaguchi');
});

test('entity resolver uses the active persona identity and keeps its stable scoped key', () => {
  const personaRoster = buildCanonicalCharacterRoster({
    name1: 'Kyle Holland',
    persona: { id: 'persona-kyle', name: 'Kyle Holland' },
    characters: [],
  });
  const result = resolveEntityCandidate('Kyle', personaRoster, [], { source_message_indices: [41] });
  assert.equal(personaRoster.characters[0].id, 'persona:persona-kyle');
  assert.equal(result.canonicalName, 'Kyle Holland');
  assert.equal(result.promotion.allowed, false);
});

test('entity resolver permits a grounded unknown NPC but never promotes an unsupported canonical variant', () => {
  const npc = resolveEntityCandidate('Sophie', roster, [], {
    grounding_status: 'direct', source_record_ids: ['scene-4'], source_message_indices: [20, 21],
  });
  assert.equal(npc.promotion.allowed, true);
  assert.equal(npc.promotion.creation_reason, 'grounded-record');
  const variant = resolveEntityCandidate('Paul Kawaguchi', roster, [], {
    grounding_status: 'direct', source_message_indices: [20],
  });
  assert.equal(variant.status, 'rejected');
  assert.equal(variant.promotion.allowed, false);
});

test('integration: registry candidates collapse to the canonical card identity', () => {
  const candidates = ['Paul', 'Paul Kawaguchi', 'Sophie'].map((name) => resolveCanonicalCharacterName(name, roster));
  assert.deepEqual(candidates.map((entry) => entry.canonicalName ?? entry.candidateName), ['Paul Schmidt', 'Paul Schmidt', 'Sophie']);
  assert.equal(candidates[1].shouldAddAlias, false);
});

test('integration: ledger variants merge without overwriting canonical fields', () => {
  const ledger = reconcileCanonicalLedger({
    'paul|character': { mood: 'concerned', location: 'home', _canonical_card_id: 'legacy-paul' },
    'paul kawaguchi|character': { mood: 'worried' },
    'paul schmidt|character': { mood: 'calm', _canonical_card_id: 'stale-card-id' },
  }, roster);
  assert.deepEqual(ledger['paul schmidt|character'], {
    mood: 'calm',
    location: 'home',
    _name: 'Paul Schmidt',
    _canonical_card_id: 'paul',
  });
  assert.equal(ledger['paul|character'], undefined);
  assert.deepEqual(ledger['paul kawaguchi|character'], { mood: 'worried' });
  // Reconciliation may run at the end of every catch-up pass.  Once the
  // deterministic repair has completed, running it again must be a no-op so
  // it cannot create ongoing metadata churn or unnecessary chat saves.
  assert.deepEqual(reconcileCanonicalLedger(ledger, roster), ledger);
});

test('integration: relationship pair uses canonical card names', () => {
  assert.deepEqual(canonicalizeRelationshipPair('Paul', 'Alissa', roster), ['Paul Schmidt', 'Alissa Kawaguchi']);
  assert.equal(canonicalizeRelationshipPair('Paul Kawaguchi', 'Alissa', roster), null);
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
  assert.equal(buildStableLedgerKey('Paul Kawaguchi', 'character', roster), 'name:paul kawaguchi|character');
});

test('scene participant repair promotes only explicit historical card aliases', () => {
  const personaRoster = buildCanonicalCharacterRoster({
    name2: 'Kyle Holland',
    persona: { name: 'Kyle Holland', previous_names: ['Adam Lawson'] },
    characters: [{ id: 'alissa', name: 'Alissa Kawaguchi' }],
  });
  const repaired = findCanonicalParticipantsInText('Adam Lawson met an unknown bartender after the concert.', personaRoster);
  assert.deepEqual(repaired.names, ['Kyle Holland']);
  assert.deepEqual(repaired.references, [{
    entity_id: 'persona:kyle holland',
    canonical_name: 'Kyle Holland',
    display_name_at_time: 'Adam Lawson',
    alias_type: 'historical-alias',
  }]);
});

test('active persona uses SillyTavern name2 and roster helpers accept object, map, and legacy array shapes', () => {
  const personaRoster = buildCanonicalRoster({
    name1: 'Alissa Kawaguchi',
    name2: 'Kyle Holland',
    persona: { name: 'Kyle Holland', previous_names: ['Adam Lawson'] },
    characters: [{ id: 'alissa', name: 'Alissa Kawaguchi', description: '' }],
  });
  assert.equal(resolveCanonicalCharacterName('Kyle', personaRoster).canonicalName, 'Kyle Holland');
  assert.equal(resolveCanonicalCharacterName('kyle', personaRoster).canonicalId, 'persona:kyle holland');
  assert.equal(resolveCanonicalCharacterName('Adam Lawson', personaRoster).canonicalName, 'Kyle Holland');
  assert.equal(resolveCanonicalCharacterName('Adam', personaRoster).canonicalName, 'Kyle Holland');
  assert.equal(getCanonicalPersonaEntries(personaRoster).length, 1);
  assert.equal(getCanonicalCardEntries(personaRoster).length, 1);
  assert.equal(getCanonicalRosterPeople({ characters: new Map(personaRoster.characters.map((entry) => [entry.canonical_id, entry])) }).length, 2);
  assert.equal(getCanonicalRosterPeople(personaRoster.characters).length, 2);
});

test('active persona short name is not guessed when a competing Kyle exists', () => {
  const competingRoster = buildCanonicalCharacterRoster({
    name2: 'Kyle Holland',
    persona: { name: 'Kyle Holland', previous_names: ['Adam Lawson'] },
    characters: [{ id: 'other-kyle', name: 'Kyle Renner' }],
  });
  const ambiguous = resolveCanonicalCharacterName('Kyle', competingRoster);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.canonicalId, undefined);
  assert.ok(ambiguous.candidates.includes('Kyle Holland'));
  assert.ok(ambiguous.candidates.includes('Kyle Renner'));
});

test('historical persona short names are not added when a card uses that name', () => {
  const competingRoster = buildCanonicalCharacterRoster({
    name2: 'Kyle Holland',
    persona: { name: 'Kyle Holland', previous_names: ['Adam Lawson'] },
    characters: [{ id: 'adam-card', name: 'Adam Jones' }],
  });
  assert.equal(resolveCanonicalCharacterName('Adam', competingRoster).canonicalName, 'Adam Jones');
  assert.equal(resolveCanonicalCharacterName('Adam Lawson', competingRoster).canonicalName, 'Kyle Holland');
});
