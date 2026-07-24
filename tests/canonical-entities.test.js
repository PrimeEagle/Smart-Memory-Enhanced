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
  snapshotCanonicalRuntimeContext,
  setCanonicalRuntimeContextSnapshot,
  clearCanonicalRuntimeContextSnapshot,
  validateExactCanonicalProposal,
} from '../canonical-entities.js';
import { isEntityRolePlaceholder, isPlausibleEntityName } from '../parsers.js';

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

test('canonical roster: family members sharing a surname remain distinct exact identities', () => {
  const familyRoster = buildCanonicalCharacterRoster({
    characters: [
      { id: 'taylor-card', name: 'Taylor Covington', description: '' },
      { id: 'kyler-card', name: 'Kyler Covington', description: '' },
      { id: 'margaret-card', name: 'Margaret Covington', description: '' },
      { id: 'richard-card', name: 'Richard Covington', description: '' },
    ],
  });
  for (const [name, id] of [
    ['Taylor Covington', 'taylor-card'],
    ['Kyler Covington', 'kyler-card'],
    ['Margaret Covington', 'margaret-card'],
    ['Richard Covington', 'richard-card'],
  ]) {
    const result = resolveEntityCandidate(name, familyRoster);
    assert.equal(result.status, 'resolved');
    assert.equal(result.canonicalId, id);
    assert.equal(result.exact_name_equal, true);
    assert.equal(result.candidate_normalized_name, result.authoritative_card_normalized_name);
  }
  const shortened = resolveEntityCandidate('Taylor', familyRoster);
  assert.equal(shortened.canonicalId, 'taylor-card');
  assert.notEqual(shortened.canonicalId, 'margaret-card');
  assert.equal(shortened.exact_name_equal, false);
});

test('exact role placeholder entity labels are rejected without rejecting proper names', () => {
  for (const placeholder of ['supporting_character', 'supporting character', 'side_character', 'side character', 'character', 'person', 'NPC', 'unknown character', 'minor character']) {
    assert.equal(isEntityRolePlaceholder(placeholder), true);
    assert.equal(isPlausibleEntityName(placeholder), false);
  }
  assert.equal(isEntityRolePlaceholder('Supporting Character Smith'), false);
  assert.equal(isPlausibleEntityName('Supporting Character Smith'), true);
});

test('exact canonical proposals cannot cross different family-card names or IDs', () => {
  const taylorToKyler = validateExactCanonicalProposal({
    sourceName: 'Taylor Covington', targetName: 'Kyler Covington',
    sourceCardId: 'taylor-card', targetCardId: 'kyler-card',
    matchingRule: 'Exact canonical character-card name.',
  });
  assert.equal(taylorToKyler.source_target_name_equal, false);
  assert.equal(taylorToKyler.card_ids_compatible, false);
  assert.equal(taylorToKyler.allowed, false);

  const sameIdentity = validateExactCanonicalProposal({
    sourceName: 'Taylor Covington', targetName: 'Taylor Covington',
    sourceCardId: 'taylor-card', targetCardId: 'taylor-card',
    matchingRule: 'Exact canonical character-card name.',
  });
  assert.equal(sameIdentity.allowed, true);
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
  const preservedForScene = canonicalizeNarrativeNames('Adam Lawson discussed the plan.', personaRoster, { preserveHistoricalPersonaNames: true });
  assert.equal(preservedForScene.text, 'Adam Lawson discussed the plan.');
  assert.deepEqual(preservedForScene.replacements, []);
  const resolution = resolveCanonicalCharacterName('Adam Lawson', personaRoster);
  assert.equal(resolution.canonicalId, 'persona:kyle holland');
  assert.equal(resolution.reason, 'Historical active persona name.');
});

test('runtime persona snapshot survives imported placeholder headers and carries a persona identity', () => {
  const snapshot = snapshotCanonicalRuntimeContext({
    name2: 'Kyle Holland',
    persona: { id: 'persona-kyle', name: 'Kyle Holland', aliases: ['Kyle'], previous_names: ['Adam Lawson'] },
    chat: [{ is_user: true, name: 'unused', mes: 'Imported header placeholder' }],
  });
  setCanonicalRuntimeContextSnapshot(snapshot);
  try {
    const runtimeRoster = buildCanonicalCharacterRoster({ name2: 'unused', chat: [], characters: [] });
    const kyle = resolveCanonicalCharacterName('kyle', runtimeRoster);
    const adam = resolveCanonicalCharacterName('Adam Lawson', runtimeRoster);
    assert.equal(runtimeRoster.characters[0].canonical_persona_id, 'persona-kyle');
    assert.equal(kyle.canonicalName, 'Kyle Holland');
    assert.equal(kyle.canonicalIdentityType, 'persona');
    assert.equal(kyle.canonicalCardId, null);
    assert.equal(kyle.canonicalPersonaId, 'persona-kyle');
    assert.equal(adam.canonicalName, 'Kyle Holland');
  } finally {
    clearCanonicalRuntimeContextSnapshot();
  }
});

test('runtime persona snapshot prefers an explicit selected persona over placeholder chat headers', () => {
  const snapshot = snapshotCanonicalRuntimeContext({
    name1: 'unused',
    name2: 'Alissa Kawaguchi',
    userName: 'unused',
    activePersonaKey: 'kyle-holland.png',
    activePersona: {
      id: 'kyle-holland.png',
      avatar: 'kyle-holland.png',
      name: 'Kyle Holland',
      aliases: ['Kyle'],
      previous_names: ['Adam Lawson'],
    },
    chat: [{ is_user: true, name: 'unused', mes: 'Imported header placeholder' }],
  });
  assert.equal(snapshot.active_persona.canonical_name, 'Kyle Holland');
  assert.equal(snapshot.active_persona.active_display_name, 'Kyle Holland');
  assert.equal(snapshot.active_persona.stable_persona_id, 'kyle-holland.png');
  assert.equal(snapshot.active_persona.runtime_source, 'active_persona');
  assert.equal(snapshot.active_persona.stable_id_source, 'runtime_key');
  assert.deepEqual(snapshot.active_persona.approved_aliases, ['Kyle', 'kyle']);
  assert.deepEqual(snapshot.active_persona.historical_aliases, ['Adam Lawson']);
});

test('runtime persona snapshot rejects placeholder-only inputs instead of fabricating an empty identity', () => {
  const snapshot = snapshotCanonicalRuntimeContext({
    name1: 'unused', userName: 'User', name2: 'user-default.png', chat: [{ is_user: true, name: 'unused' }],
  });
  assert.equal(snapshot.active_persona.canonical_name, '');
  assert.equal(snapshot.active_persona.stable_persona_id, null);
  assert.equal(snapshot.active_persona.runtime_source, 'unavailable');
  assert.equal(snapshot.active_persona.stable_id_source, 'unavailable');
});

test('stable relationship keys distinguish persona identities from card identities', () => {
  const personaRoster = buildCanonicalCharacterRoster({
    name2: 'Kyle Holland',
    persona: { id: 'persona-kyle', name: 'Kyle Holland' },
    characters: [{ id: 'alissa-card', name: 'Alissa Kawaguchi' }],
  });
  const pair = buildStableRelationshipPair('Kyle', 'Alissa Kawaguchi', personaRoster);
  assert.equal(pair.key, 'persona:persona-kyle→card:alissa-card');
  assert.equal(pair.subject.canonicalPersonaId, 'persona-kyle');
  assert.equal(pair.target.canonicalCardId, 'alissa-card');
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
  assert.deepEqual(ledger['card:paul|character'], {
    mood: 'calm',
    location: 'home',
    _name: 'Paul Schmidt',
    _canonical_card_id: 'paul',
    _canonical_identity_type: 'character_card',
    _canonical_persona_id: null,
  });
  assert.equal(ledger['paul|character'], undefined);
  assert.equal(ledger['paul schmidt|character'], undefined);
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

test('relationship pairs reject collective labels and accidental self-pairs', () => {
  assert.equal(canonicalizeRelationshipPair('Paul and Alissa', 'Alissa', roster), null);
  assert.equal(canonicalizeRelationshipPair('Paul', 'Paul Schmidt', roster), null);
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

test('scene participant repair retains every explicitly named active family member', () => {
  const familyRoster = buildCanonicalCharacterRoster({
    name2: 'Aaron Holland',
    characters: [
      { id: 'taylor', name: 'Taylor Covington' },
      { id: 'richard', name: 'Richard Covington' },
      { id: 'margaret', name: 'Margaret Covington' },
    ],
  });
  const repaired = findCanonicalParticipantsInText(
    'Taylor Covington revealed to her parents, Richard Covington and Margaret Covington, that she and Aaron Holland were still legally married.',
    familyRoster,
  );
  assert.deepEqual(repaired.names, ['Taylor Covington', 'Richard Covington', 'Margaret Covington', 'Aaron Holland']);
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
