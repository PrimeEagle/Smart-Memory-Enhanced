import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFinalizedEntityRedirects } from '../entity-redirect-utils.js';

const registry = [{ id: 'canonical-a' }, { id: 'canonical-b' }];

test('final redirect validation removes a target removed before finalization', () => {
  const result = validateFinalizedEntityRedirects({ old: { replacement_canonical_id: 'removed' } }, registry, { live_reference_counts: { old: 2 } });
  assert.deepEqual(result.validated_redirects, {});
  assert.equal(result.diagnostics[0].invalid_reason, 'missing_finalized_registry_target');
  assert.equal(result.diagnostics[0].repair_status, 'blocked');
});

test('self redirects are removed and never accepted as terminals', () => {
  const result = validateFinalizedEntityRedirects({ old: { replacement_canonical_id: 'old' } }, registry, { live_reference_counts: { old: 1 } });
  assert.equal(result.diagnostics[0].self_redirect, true);
  assert.equal(result.diagnostics[0].terminal_target_exists, false);
  assert.deepEqual(result.validated_redirects, {});
});

test('missing redirect-chain terminals and cycles are rejected safely', () => {
  const missing = validateFinalizedEntityRedirects({ first: { replacement_canonical_id: 'second' }, second: { replacement_canonical_id: 'gone' } }, registry);
  assert.equal(missing.diagnostics.find((item) => item.redirect_source_id_fingerprint)?.missing_target, true);
  const cyclic = validateFinalizedEntityRedirects({ first: { replacement_canonical_id: 'second' }, second: { replacement_canonical_id: 'first' } }, registry);
  assert.equal(cyclic.diagnostics.every((item) => item.cycle), true);
  assert.deepEqual(cyclic.validated_redirects, {});
});

test('valid redirect chains flatten only to a final materialized registry record', () => {
  const result = validateFinalizedEntityRedirects({ first: { replacement_canonical_id: 'second' }, second: { replacement_canonical_id: 'canonical-a' } }, registry);
  assert.equal(result.validated_redirects.first.replacement_canonical_id, 'canonical-a');
  assert.equal(result.validated_redirects.second.replacement_canonical_id, 'canonical-a');
  assert.equal(result.diagnostics.every((item) => item.terminal_target_exists), true);
});

test('automatic and manual validation share the exact finalized registry result', () => {
  const redirects = { old: { replacement_canonical_id: 'canonical-a' } };
  const automatic = validateFinalizedEntityRedirects(redirects, registry);
  const manual = validateFinalizedEntityRedirects(redirects, registry);
  assert.deepEqual(automatic.validated_redirects, manual.validated_redirects);
  assert.deepEqual(automatic.diagnostics, manual.diagnostics);
});

test('ambiguous orphan remains blocked while an authoritative terminal is recoverable', () => {
  const blocked = validateFinalizedEntityRedirects({ orphan: { replacement_canonical_id: 'gone' } }, registry, { live_reference_counts: { orphan: 3 } });
  assert.equal(blocked.diagnostics[0].repair_status, 'blocked');
  assert.equal(blocked.diagnostics[0].live_reference_count_before_repair, 3);
  const recoverable = validateFinalizedEntityRedirects({ old: { replacement_canonical_id: 'canonical-b' } }, registry, { live_reference_counts: { old: 2 } });
  assert.equal(recoverable.validated_redirects.old.replacement_canonical_id, 'canonical-b');
  assert.equal(recoverable.diagnostics[0].repair_status, 'safe');
});
