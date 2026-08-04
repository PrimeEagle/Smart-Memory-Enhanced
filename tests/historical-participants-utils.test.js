import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHistoricalGroupParticipants } from '../historical-participants-utils.js';

const group = {
  members: ['alissa.png', 'paul.png', 'side.png'],
  disabled_members: ['paul.png', 'side.png'],
};
const characters = [
  { avatar: 'alissa.png', name: 'Alissa Kawaguchi' },
  { avatar: 'paul.png', name: 'Paul Schmidt' },
  { avatar: 'side.png', name: 'Side Character' },
];

test('historical rebuild includes every group card, including disabled members', () => {
  const scope = resolveHistoricalGroupParticipants({
    group,
    characters,
    messages: [
      { is_user: false, name: 'Alissa Kawaguchi', mes: 'Hello.' },
      { is_user: false, name: 'Paul Schmidt', mes: 'I was here earlier.' },
      { is_user: true, name: 'User', mes: 'Okay.' },
    ],
    fallbackCharacterName: 'Alissa Kawaguchi',
  });
  assert.deepEqual(scope.participant_names, ['Alissa Kawaguchi', 'Paul Schmidt', 'Side Character']);
  assert.deepEqual(scope.semantic_participant_names, ['Alissa Kawaguchi', 'Paul Schmidt']);
  assert.deepEqual(scope.generic_container_names, ['Side Character']);
  assert.deepEqual(scope.currently_disabled_included, ['Paul Schmidt', 'Side Character']);
  assert.deepEqual(scope.members_with_authored_messages, ['Alissa Kawaguchi', 'Paul Schmidt']);
});

test('historical rebuild keeps the full group roster even when no member has authored messages', () => {
  const scope = resolveHistoricalGroupParticipants({ group, characters, messages: [{ is_user: true, name: 'User', mes: 'Only me.' }], fallbackCharacterName: 'Alissa Kawaguchi' });
  assert.deepEqual(scope.participant_names, ['Alissa Kawaguchi', 'Paul Schmidt', 'Side Character']);
  assert.deepEqual(scope.semantic_participant_names, ['Alissa Kawaguchi', 'Paul Schmidt']);
  assert.equal(scope.fallback_used, false);
});

test('ambiguous aliases are diagnostics-only and never suppress a group target', () => {
  const scope = resolveHistoricalGroupParticipants({
    group: { members: ['a.png', 'b.png'] },
    characters: [{ avatar: 'a.png', name: 'Taylor One', aliases: ['Taylor'] }, { avatar: 'b.png', name: 'Taylor Two', aliases: ['Taylor'] }],
    messages: [{ is_user: false, name: 'Taylor', mes: 'Ambiguous.' }],
    fallbackCharacterName: 'Taylor One',
  });
  assert.deepEqual(scope.participant_names, ['Taylor One', 'Taylor Two']);
  assert.deepEqual(scope.members_with_authored_messages, []);
});
