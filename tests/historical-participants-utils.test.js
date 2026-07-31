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

test('historical rebuild includes disabled group members who authored messages', () => {
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
  assert.deepEqual(scope.participant_names, ['Alissa Kawaguchi', 'Paul Schmidt']);
  assert.deepEqual(scope.currently_disabled_included, ['Paul Schmidt']);
  assert.deepEqual(scope.current_members_without_authored_messages, ['Side Character']);
});

test('historical rebuild does not create personal stores for members with no authored messages', () => {
  const scope = resolveHistoricalGroupParticipants({ group, characters, messages: [{ is_user: true, name: 'User', mes: 'Only me.' }], fallbackCharacterName: 'Alissa Kawaguchi' });
  assert.deepEqual(scope.participant_names, ['Alissa Kawaguchi']);
  assert.equal(scope.fallback_used, true);
});

test('ambiguous aliases do not cause a historical participant match', () => {
  const scope = resolveHistoricalGroupParticipants({
    group: { members: ['a.png', 'b.png'] },
    characters: [{ avatar: 'a.png', name: 'Taylor One', aliases: ['Taylor'] }, { avatar: 'b.png', name: 'Taylor Two', aliases: ['Taylor'] }],
    messages: [{ is_user: false, name: 'Taylor', mes: 'Ambiguous.' }],
    fallbackCharacterName: 'Taylor One',
  });
  assert.deepEqual(scope.participant_names, ['Taylor One']);
  assert.equal(scope.fallback_used, true);
});
