import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preverifyArcSummary } from '../arc-summary-validation.js';
import { buildCanonicalCharacterRoster, canonicalizeRelationshipPair, resolveCanonicalCharacterName, validateArcParticipants } from '../canonical-entities.js';
import { parseArcOutput, parseExtractionOutput, parseSessionOutput } from '../parsers.js';

const fixtureDirectory = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'diagnostics');
const fixture = (name) => JSON.parse(readFileSync(join(fixtureDirectory, `${name}.json`), 'utf8'));
const source = (name) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

test('diagnostic fixtures: leakage and hallucination are rejected before storage', () => {
  const data = fixture('leakage-hallucination');
  const result = preverifyArcSummary(data.candidate, data.evidence);
  assert.equal(result.reason_code, data.expectedReason);
});

test('diagnostic fixtures: entity relevance respects the active roster', () => {
  const data = fixture('entity-relevance');
  const result = resolveCanonicalCharacterName(data.candidate, buildCanonicalCharacterRoster(data.roster));
  assert.equal(result.canonicalName, data.expectedCanonicalName);
});

test('diagnostic fixtures: provenance parser retains cited source indices', () => {
  const data = fixture('provenance');
  const [record] = parseExtractionOutput(data.input);
  assert.deepEqual(record.source_message_indices, data.expectedSources);
});

test('diagnostic fixture: policy isolation keeps all four character storage contracts', () => {
  const data = fixture('policy-isolation');
  const longterm = source('longterm.js');
  assert.equal(data.expectedContracts.length, 4);
  for (const policy of ['FULL', 'CHAT_LOCAL', 'READ_ONLY', 'DISABLED']) {
    assert.match(longterm, new RegExp(`CHARACTER_MEMORY_POLICIES\\.${policy}`));
  }
});

test('diagnostic fixture: provider and save failures remain retryable and transactional', () => {
  const data = fixture('provider-save-failure');
  const generate = source('generate.js');
  const transaction = source('catchup-transaction.js');
  assert.equal(data.expectedContracts.length, 3);
  assert.match(generate, /retryTransientMemoryOperation/);
  assert.match(transaction, /rollbackCatchUpTransaction/);
  assert.match(transaction, /commitCatchUpTransaction/);
});

test('diagnostic fixture: search stays independently namespaced and carries provenance', () => {
  const data = fixture('search');
  const index = source('index.js');
  const search = source('ui.js');
  assert.equal(data.expectedContracts.length, 2);
  assert.match(index, /name: 'sme-search'/);
  assert.match(search, /source_message_indices|source_record_ids/);
});

test('v0.8.14 regression fixture covers persona, provenance, arcs, relationships, and quality contracts', () => {
  const data = fixture('v0814-regression');
  const roster = buildCanonicalCharacterRoster({
    ...data.persona.context,
    characters: [
      { id: 'alissa', name: 'Alissa Kawaguchi', description: '' },
      { id: 'paul', name: 'Paul Schmidt', description: '' },
    ],
  });
  assert.equal(resolveCanonicalCharacterName(data.persona.short_name, roster).canonicalName, data.persona.canonical_name);
  assert.equal(resolveCanonicalCharacterName(data.persona.historical_name, roster).canonicalName, data.persona.canonical_name);
  assert.equal(resolveCanonicalCharacterName(data.persona.historical_short_name, roster).canonicalName, data.persona.canonical_name);
  assert.deepEqual(parseSessionOutput(data.session.input)[0].source_message_indices, data.session.expected_sources);
  assert.deepEqual(parseSessionOutput(data.session.alternate_input)[0].source_message_indices, data.session.expected_sources);
  assert.equal(parseArcOutput(data.arc.completed_confession, []).add.length, 0);
  assert.deepEqual(validateArcParticipants(data.arc.participant_output, roster, { content: data.arc.content }).names, data.arc.expected_participants);
  assert.deepEqual(canonicalizeRelationshipPair(data.relationship.subject, data.relationship.target, roster), data.relationship.expected);
  assert.deepEqual(canonicalizeRelationshipPair(data.relationship.reverse_subject, data.relationship.reverse_target, roster), data.relationship.reverse_expected);
  assert.equal(canonicalizeRelationshipPair(data.relationship.unsupported_variant_subject, data.relationship.target, roster), null);
  const historical = resolveCanonicalCharacterName(data.historical_participant.display_name_at_time, roster);
  assert.deepEqual({ entity_id: historical.canonicalId, canonical_name: historical.canonicalName, display_name_at_time: data.historical_participant.display_name_at_time }, data.historical_participant);

  const graph = source('graph-migration.js');
  const arcs = source('arcs.js');
  const profiles = source('profiles.js');
  const settings = source('settings.js');
  assert.equal(data.expected_contracts.length, 6);
  assert.match(graph, /mergeCanonicalEntityAcrossStores/);
  assert.match(arcs, /terminal_status/);
  assert.match(profiles, /exactStatus/);
  assert.match(settings, /quality: runResult\.quality/);
  assert.match(settings, new RegExp(data.quality.expected_reason));
  assert.match(settings, /participantListsRewritten/);
});
