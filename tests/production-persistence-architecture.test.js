import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8');

const durableWriterModules = [
  'longterm.js', 'session.js', 'scenes.js', 'arcs.js', 'profiles.js',
  'epistemic.js', 'state-ledger.js', 'canon.js', 'graph-migration.js',
  'compaction.js',
];

test('every production durable writer enters the shared persistence command boundary', () => {
  for (const file of durableWriterModules) {
    const source = read(file);
    assert.match(source, /prepareFeaturePersistenceCommand/,
      `${file} does not prepare the shared command`);
    assert.match(source, /executeFeaturePersistence|recordFeaturePersistenceReceipt/,
      `${file} bypasses the shared executor or receipt boundary`);
  }
});

test('domain result constructors contain no JSON cloning fallback', () => {
  const boundaryModules = [
    'memorize-tier-outcome.js', 'memorize-outcome.js', 'persistence-command.js',
    'provider-completion-journal.js', 'memorize-action-dispatcher.js',
    'memorize-diagnostic-observer.js', 'memorize-diagnostic-snapshot.js',
    'memorize-authority-model.js', 'live-memory-health.js', 'ui.js', 'settings.js',
  ];
  for (const file of boundaryModules) {
    assert.doesNotMatch(read(file), /JSON\.parse\(JSON\.stringify/,
      `${file} can silently discard runtime values`);
  }
});

test('authoritative Memorize state boundaries use the explicit serializable-domain contract', () => {
  const boundaryModules = [
    'memorize-action-engine.js', 'memorize-execution-kernel.js',
    'memorize-obligation-ledger.js', 'memorize-tier-pipeline.js',
    'memorize-transaction-settlement.js', 'memorize-replay-harness.js',
    'catchup-recovery-utils.js', 'catchup-transaction.js',
    'provider-attempt-audit.js', 'provider-completion-journal.js',
  ];
  for (const file of boundaryModules) {
    const source = read(file);
    assert.match(source, /serializable-domain\.js/,
      `${file} does not import the explicit domain boundary`);
    assert.doesNotMatch(source, /structuredClone\(/,
      `${file} can discover runtime effects only after an unclassified clone failure`);
  }
});

test('multi-owner production path retains evidence and has no callback result path', () => {
  const source = read('multi-owner-longterm-runtime.js');
  assert.match(source, /findCurrentRunProviderCompletion/);
  assert.match(source, /journalReplayMode/);
  assert.match(source, /physicalProviderRequests = journalReplayMode \? 0 : 1/);
  assert.match(source, /prepared_effect_plans: effectPlans/);
  assert.match(source, /next_action: 'apply_journaled_provider_completion'/);
  assert.doesNotMatch(source, /\.commit\?\.|defer_commit/);
});

test('controller records one Long-Term root failure without a derivative recovery error', () => {
  const source = read('settings.js');
  assert.match(source, /root_error_recorded: true/);
  assert.match(source, /longtermSchedule\.root_error_recorded !== true/);
});
