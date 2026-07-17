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
