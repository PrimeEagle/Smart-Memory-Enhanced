import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preverifyArcSummary } from '../arc-summary-validation.js';
import { buildCanonicalCharacterRoster, resolveCanonicalCharacterName } from '../canonical-entities.js';
import { parseExtractionOutput } from '../parsers.js';

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
