import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createRecoveryChildManifest,
  markRecoveryChildState,
  pauseRecoveryChildManifest,
  recoveryChildManifestComplete,
  recordRecoveryBudgetSnapshot,
  registerRecoveryChildPlan,
  resumeRecoveryChildManifest,
  summarizeRecoveryChildManifest,
} from '../recovery-child-coverage.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/v0967-aster-budget-pause.json', import.meta.url)));
const child = (key, start, end) => ({ key, source_range: { start, end, message_count: end - start + 1 } });

function asterManifest() {
  const manifest = createRecoveryChildManifest({
    root_obligation_id: fixture.root_obligation_id,
    tier: 'longterm', owner: 'Aster Graves',
    root_source_range: fixture.root_source_range,
    root_source_fingerprint: fixture.root_source_fingerprint,
  });
  const left = 'longterm:aster graves:600-609:left';
  const right = 'longterm:aster graves:610-619:right';
  registerRecoveryChildPlan(manifest, { children: [child(left, 600, 609), child(right, 610, 619)] });
  registerRecoveryChildPlan(manifest, { parent_child_key: left, children: [
    child(fixture.completed_children[0].key, 600, 604),
    child(fixture.completed_children[1].key, 605, 609),
  ] });
  registerRecoveryChildPlan(manifest, { parent_child_key: right, children: [
    child(fixture.completed_children[2].key, 610, 614),
    child(fixture.pending_child.key, 615, 619),
  ] });
  for (const completed of fixture.completed_children) markRecoveryChildState(manifest, completed.key, 'completed');
  return manifest;
}

test('v0.9.67 Aster shape keeps 615-619 explicitly unattempted and root incomplete', () => {
  const summary = summarizeRecoveryChildManifest(asterManifest());
  assert.equal(summary.coverage.complete, false);
  assert.deepEqual(summary.coverage.unattempted_child_keys, [fixture.pending_child.key]);
  assert.equal(summary.parent_closure_state, 'incomplete');
  assert.equal(summary.coverage.every_required_index_covered_exactly_once, true);
});

test('request budget boundary is a resumable operational pause with exact next child', () => {
  const manifest = asterManifest();
  const budget = { maximum_additional_provider_requests: 20, additional_provider_requests: 20,
    resume_epoch: 1, requests_by_stage: { malformed_source_repartition: 4, single_source_unit_regeneration: 5 },
    requests_by_child: { [fixture.completed_children[2].key]: 5 } };
  recordRecoveryBudgetSnapshot(manifest, budget);
  pauseRecoveryChildManifest(manifest, {
    next_child_key: fixture.pending_child.key,
    unattempted_siblings: [fixture.pending_child.key], progress_made: true,
  });
  const summary = summarizeRecoveryChildManifest(manifest);
  assert.equal(summary.parent_closure_state, 'paused_resumable');
  assert.equal(summary.operational_pause.reason_code, 'recovery_request_budget_reached_with_pending_children');
  assert.equal(summary.operational_pause.next_resumable_child, fixture.pending_child.key);
  assert.equal(summary.budget_epochs[0].remaining_requests, 0);
  assert.equal(summary.budget_epochs[0].fresh_budget_on_resume, true);
});

test('resume preserves completed children and closes parent only after 615-619 completes', () => {
  const manifest = asterManifest();
  pauseRecoveryChildManifest(manifest, { next_child_key: fixture.pending_child.key, progress_made: true });
  resumeRecoveryChildManifest(manifest);
  assert.equal(recoveryChildManifestComplete(manifest), false);
  assert.deepEqual(manifest.coverage.completed_child_keys.sort(), fixture.completed_children.map((item) => item.key).sort());
  markRecoveryChildState(manifest, fixture.pending_child.key, 'completed', { staged_record_count: 2 });
  assert.equal(recoveryChildManifestComplete(manifest), true);
  assert.equal(manifest.parent_closure_state, 'complete');
});

test('missing or overlapping leaf coverage fails reconciliation conservatively', () => {
  const manifest = createRecoveryChildManifest({ root_obligation_id: 'root',
    root_source_range: { start: 600, end: 619 } });
  registerRecoveryChildPlan(manifest, { children: [child('a', 600, 610), child('b', 610, 619)] });
  markRecoveryChildState(manifest, 'a', 'completed');
  markRecoveryChildState(manifest, 'b', 'completed');
  const summary = summarizeRecoveryChildManifest(manifest);
  assert.equal(summary.coverage.every_required_index_covered_exactly_once, false);
  assert.equal(summary.coverage.complete, false);
  assert.equal(summary.parent_closure_state, 'incomplete');
});

test('validated no-update is terminal coverage but blocked child is not', () => {
  const manifest = createRecoveryChildManifest({ root_obligation_id: 'root',
    root_source_range: { start: 0, end: 1 } });
  registerRecoveryChildPlan(manifest, { children: [child('a', 0, 0), child('b', 1, 1)] });
  markRecoveryChildState(manifest, 'a', 'validated_no_update');
  markRecoveryChildState(manifest, 'b', 'blocked');
  assert.equal(manifest.coverage.complete, false);
  assert.equal(manifest.coverage.blocked_leaf_count, 1);
  markRecoveryChildState(manifest, 'b', 'completed');
  assert.equal(manifest.coverage.complete, true);
});
