import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessSourceFragment, buildRecoverySourceUnits, classifyOwnerApplicability } from '../owner-applicability.js';

const fixture = JSON.parse(fs.readFileSync(new URL(
  './fixtures/v0966-lillian-owner-applicability.json', import.meta.url), 'utf8'));
const messages = fixture.units.map((item) => ({
  name: item.speaker, is_user: item.is_user, mes: item.text, __sme_original_index: item.index,
}));

test('live Lillian 170-174 shape separates other-addressee messages and a fragment', () => {
  const units = buildRecoverySourceUnits(messages, 170, () => 'fingerprint');
  for (const unit of units) assert.equal(
    classifyOwnerApplicability(unit, { owner: fixture.owner }).classification,
    fixture.expected[unit.unit_key], unit.unit_key);
  const fragment = classifyOwnerApplicability(units[4], { owner: 'Lillian Kraft' });
  assert.equal(fragment.classification, 'non_substantive_fragment');
  assert.equal(fragment.local_no_update_validated, true);
  assert.deepEqual(fragment.evidence.context_source_units_inspected, ['172', '173']);
  assert.equal(fixture.raw_provider_output_included, false);
});

test('name-absent resolved pronouns and direct address retain owner recall', () => {
  const pronoun = {
    unit_key: '11', speaker: 'user', is_user: true, raw_text: 'She promised to return next week.',
    context_units: [{ unit_key: '10', speaker: 'Narrator', is_user: false,
      raw_text: 'Lillian Kraft closes the door after making a promise.' }],
  };
  assert.equal(classifyOwnerApplicability(pronoun, { owner: 'Lillian Kraft' }).classification, 'owner_relevant');
  const address = {
    unit_key: '21', speaker: 'user', is_user: true, raw_text: 'You said you would help me tomorrow.',
    context_units: [
      { unit_key: '20', speaker: 'Lillian Kraft', is_user: false, raw_text: 'Lillian waits.' },
      { unit_key: '22', speaker: 'Lillian Kraft', is_user: false, raw_text: 'Lillian confirms the promise.' },
    ],
  };
  assert.equal(classifyOwnerApplicability(address, { owner: 'Lillian Kraft' }).classification, 'owner_relevant');
});

test('ambiguous pronouns never become an automatic local NONE', () => {
  const result = classifyOwnerApplicability({
    unit_key: '31', speaker: 'user', is_user: true, raw_text: 'She said it was important.',
    context_units: [{ unit_key: '30', speaker: 'Narrator', is_user: false,
      raw_text: 'Lillian and Aster sit together.', multiple_people_mentioned: true }],
  }, { owner: 'Lillian Kraft' });
  assert.equal(result.classification, 'owner_relevance_ambiguous');
  assert.equal(result.local_no_update_validated, false);
});

test('fragment assessment rejects filler but preserves durable state changes', () => {
  assert.equal(assessSourceFragment('"But..." I pause, nervously.').classification, 'non_substantive_fragment');
  assert.equal(assessSourceFragment('I decide to leave the city tomorrow.').classification,
    'substantive_or_context_dependent');
});
