import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('provider failures: transient server and network failures are retried, while bad requests are not', () => {
  const source = read('generate.js');
  const transient = source.slice(source.indexOf('function isTransientProviderError'), source.indexOf('function retryAfterMs'));
  assert.match(transient, /status === 429 \|\| status === 502 \|\| status === 503 \|\| status === 504/);
  assert.doesNotMatch(transient, /status === 400/);
  assert.match(source, /attempt >= maxRetries/);
  assert.match(source, /retryListeners\.forEach/);
});

test('chat-save failures: catch-up persistence is staged and rolls back failed commits', () => {
  const source = read('catchup-transaction.js');
  assert.match(source, /metadataDirty: false/);
  assert.match(source, /activeTransaction\.metadataDirty = true/);
  assert.match(source, /await saveGroupChatDirect\(transaction\.context\)/);
  assert.match(source, /await saveChat\(\)/);
  assert.match(source, /rollbackCatchUpTransaction\(transaction\)/);
});

test('scene archive: retention, injection, provenance, audit, and legacy settings use separate semantics', () => {
  const settings = read('settings.js');
  const scenes = read('scenes.js');
  const ui = read('ui.js');
  assert.match(settings, /scene_archive_max: 100/);
  assert.match(settings, /scene_inject_count: 5/);
  assert.match(settings, /const hadSceneInjectCount/);
  assert.match(settings, /scene_inject_count = extension_settings\[MODULE_NAME\]\.scene_max_history/);
  assert.match(settings, /Scenes: \$\{sceneAudit\.candidates\} detected/);
  assert.match(scenes, /trimSceneArchive/);
  assert.match(scenes, /selectScenesForInjection\(history, settings\.scene_inject_count/);
  assert.match(scenes, /metadata\.sceneHistory = previous/);
  assert.match(ui, /sme_jump_scene/);
  assert.match(ui, /sme_resummarize_scene/);
  assert.match(ui, /source_start_index/);
});

test('entity safeguards: reconciliation reports decisions, retains review candidates, and preserves aliases on rename', () => {
  const graph = read('graph-migration.js');
  assert.match(graph, /const report = \{ changed: false, matched: \[\], merged: \[\], skipped: \[\], unmatched: \[\] \}/);
  assert.match(graph, /identity_review_queue/);
  const rename = graph.slice(graph.indexOf('export function renameEntityById'), graph.indexOf('export function deleteEntityById'));
  assert.match(rename, /aliases = \[\.\.\.new Set\(\[\.\.\.\(entity\.aliases \?\? \[\]\), oldName\]\)\]/);
  assert.match(rename, /if \(conflict\) return \{ renamed: false/);
  assert.match(rename, /Use Merge instead/);
});

test('review UI: grounding and identity reviews use dialogs that clean up without closing the extensions panel', () => {
  const ui = read('ui.js');
  assert.match(ui, /sme_open_review_queue/);
  assert.match(ui, /dialog\.showModal\(\)/);
  assert.match(ui, /dialog\.addEventListener\('close', \(\) => dialog\.remove\(\)/);
  assert.match(ui, /event\.stopPropagation\(\)/);
  assert.match(ui, /Review identity candidates/);
});

test('per-character policies: full, chat-local, read-only, and disabled policies remain available', () => {
  const settings = read('settings.html');
  for (const policy of ['full', 'chat_local', 'read_only', 'disabled']) {
    assert.match(settings, new RegExp(`value="${policy}"`));
  }
  const longterm = read('longterm.js');
  assert.match(longterm, /CHARACTER_MEMORY_POLICIES\.READ_ONLY, CHARACTER_MEMORY_POLICIES\.DISABLED/);
  assert.match(longterm, /CHARACTER_MEMORY_POLICIES\.CHAT_LOCAL/);
});

test('Prompt Studio assignment labels stay beside their matching dropdowns and identify the selected character', () => {
  const html = read('settings.html');
  const assignments = html.slice(html.indexOf('Preset assignments'), html.indexOf('Prompt Preset'));
  assert.ok(assignments.indexOf('sme_prompt_global_profile') < assignments.indexOf('sme_prompt_chat_profile'));
  assert.ok(assignments.indexOf('sme_prompt_chat_profile') < assignments.indexOf('sme_prompt_character_profile'));
  assert.match(assignments, /sme_prompt_character_profile_label/);
  const settings = read('settings.js');
  assert.match(settings, /#sme_prompt_character_profile_label'\)\.text\(characterName \? `Character: \$\{characterName\}`/);
  const css = read('style.css');
  assert.match(css, /\.sme_prompt_assignment_row \{[\s\S]*grid-template-columns/);
});

test('lower navigation sections have distinct theme-neutral header icons', () => {
  const html = read('settings.html');
  for (const [section, icon] of [
    ['Entity Registry', 'fa-diagram-project'],
    ['Continuity Checker', 'fa-shield-halved'],
    ['Prompt Studio', 'fa-wand-magic-sparkles'],
    ['Configuration', 'fa-sliders'],
    ['Developer', 'fa-code'],
  ]) {
    const sectionIndex = html.lastIndexOf(section);
    const nearby = html.slice(Math.max(0, sectionIndex - 250), sectionIndex);
    assert.match(nearby, new RegExp(`${icon} sme_section_icon`));
  }
  const css = read('style.css');
  assert.match(css, /\.sme_section_icon \{[\s\S]*opacity: 0\.72/);
});
