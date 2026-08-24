import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTaskMap, makePromptPresetExport, resolveProfileAssignment, validatePromptPresetImport } from '../prompt-profile-utils.js';

const TASKS = ['longterm_extraction', 'session_extraction', 'canon'];

test('prompt profiles: every task receives a string value', () => {
  assert.deepEqual(createTaskMap(TASKS, { canon: 'Write concise canon.' }), {
    longterm_extraction: '', session_extraction: '', canon: 'Write concise canon.',
  });
});

test('prompt profiles: assignment inherits chat then character then global', () => {
  const known = new Set(['builtin:default', 'custom:global', 'custom:character', 'custom:chat']);
  assert.equal(resolveProfileAssignment({ global: 'custom:global', character: 'custom:character', chat: 'custom:chat' }, known), 'custom:chat');
  assert.equal(resolveProfileAssignment({ global: 'custom:global', character: 'custom:character' }, known), 'custom:character');
  assert.equal(resolveProfileAssignment({ global: 'custom:global' }, known), 'custom:global');
});

test('prompt profiles: stale assignments fall back safely to Default', () => {
  assert.equal(resolveProfileAssignment({ global: 'custom:removed' }, new Set(['builtin:default'])), 'builtin:default');
});

test('prompt profiles: export/import preserves every task and rejects invalid files', () => {
  const exported = makePromptPresetExport('Investigative', createTaskMap(TASKS, { canon: 'Focus on clues.' }));
  assert.deepEqual(validatePromptPresetImport(exported, TASKS), { name: 'Investigative', tasks: createTaskMap(TASKS, { canon: 'Focus on clues.' }) });
  assert.throws(() => validatePromptPresetImport({ format: 'wrong', version: 2 }, TASKS));
});

test('character memory policy change refreshes its descriptive UI', () => {
  const settingsSource = readFileSync(new URL('../settings.js', import.meta.url), 'utf8');
  const handler = settingsSource.slice(settingsSource.indexOf("$('#sme_character_memory_policy').on('change'"));
  assert.ok(handler.indexOf('updateLongTermUI(characterName);') < handler.indexOf('updateTokenDisplay();'));
});

test('bulk character policy control applies one confirmed policy to current group members only', () => {
  const settingsSource = readFileSync(new URL('../settings.js', import.meta.url), 'utf8');
  const htmlSource = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
  assert.match(htmlSource, /id="sme_bulk_character_memory_policy"/);
  assert.match(htmlSource, /id="sme_apply_bulk_character_memory_policy"/);
  const handler = settingsSource.slice(settingsSource.indexOf("$('#sme_apply_bulk_character_memory_policy').on('click'"));
  assert.match(handler, /#sme_group_char_select option/);
  assert.match(handler, /characterNames\.length < 2/);
  assert.match(handler, /callGenericPopup/);
  assert.match(handler, /Existing memories stay in their current stores/);
  assert.match(handler, /for \(const characterName of characterNames\) setCharacterMemoryPolicy/);
});
