import test from 'node:test';
import assert from 'node:assert/strict';
import { readPageRunMarker, writePageRunMarker, clearPageRunMarker, reconcilePageRunInstance, summarizePageRunLifecycle, recordRuntimeLifecycleEvent, PAGE_RUN_LIFECYCLE_MAX_TRANSITIONS } from '../page-run-lifecycle.js';

const storage = () => {
  const items = new Map();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: (key) => items.delete(key) };
};
const checkpoint = () => ({ run_id: 'run-a', status: 'in_progress', next_source_offset: 260,
  finalization: { active_phase: null, completed_phases: {} }, run_manifest: { total_attempt_count: 1 } });

test('four page replacements preserve unknown cause, requests, and source/finalization checkpoints', () => {
  const local = storage(), metadata = {}, cp = checkpoint(), scope = 'chat-a';
  assert.equal(reconcilePageRunInstance(metadata, cp, null, 'page-1', 100, { freshRun: true }).interrupted, false);
  let marker = writePageRunMarker(local, scope, { run_id: cp.run_id, page_instance_id: 'page-1', phase: 'source_extraction', checkpoint_offset: 260, request_state: 'in_flight' });
  for (const [index, phase] of ['source_extraction', 'scene_detection', 'shortterm_extraction', 'profile_generation'].entries()) {
    cp.finalization.active_phase = phase === 'source_extraction' ? null : phase;
    if (phase !== 'source_extraction') cp.next_source_offset = 9434;
    const next = `page-${index + 2}`;
    assert.equal(reconcilePageRunInstance(metadata, cp, marker, next, 200 + index).reason, 'unclassified_page_interruption');
    marker = writePageRunMarker(local, scope, { run_id: cp.run_id, page_instance_id: next, phase, checkpoint_offset: cp.next_source_offset, request_state: 'in_flight' });
  }
  const result = summarizePageRunLifecycle(metadata, 5);
  assert.equal(result.page_interruption_count, 4);
  assert.equal(result.page_instances_observed, 5);
  assert.equal(result.attempts_account_for_observed_page_transitions, true);
  assert.ok(result.retained_transitions.every((event) => event.cause === 'unknown'));
  assert.equal(result.retained_transitions[0].checkpoint_offset_after, 260);
  assert.equal(result.retained_transitions[1].checkpoint_offset_after, 9434);
  assert.equal(result.retained_transitions[2].request_outcome, 'completion_uncertain_after_page_interruption');
  assert.equal(readPageRunMarker(local, scope).page_instance_id, 'page-5');
});

test('completed run reopening does not count as interruption', () => {
  const local = storage(), metadata = {}, cp = checkpoint();
  reconcilePageRunInstance(metadata, cp, null, 'page-1', 1, { freshRun: true });
  writePageRunMarker(local, 'chat-a', { run_id: cp.run_id, page_instance_id: 'page-1' });
  clearPageRunMarker(local, 'chat-a', cp.run_id);
  cp.status = 'completed';
  assert.equal(readPageRunMarker(local, 'chat-a'), null);
  assert.equal(summarizePageRunLifecycle(metadata, 1).page_interruption_count, 0);
});

test('an intentional manual resume on a different page is not an unexplained interruption', () => {
  const metadata = {}, cp = checkpoint();
  reconcilePageRunInstance(metadata, cp, null, 'page-1', 1, { freshRun: true });
  const prior = { run_id: cp.run_id, page_instance_id: 'page-1', request_state: 'idle' };
  const result = reconcilePageRunInstance(metadata, cp, prior, 'page-2', 2, { expectedManualResume: true });
  assert.equal(result.interrupted, false);
  assert.equal(summarizePageRunLifecycle(metadata, 2).page_interruption_count, 0);
});

test('in-flight work with a durable phase commit is recovered, not called provider-empty', () => {
  const metadata = {}, cp = checkpoint();
  reconcilePageRunInstance(metadata, cp, null, 'page-1', 1, { freshRun: true });
  cp.finalization.completed_phases.scene_detection = { completed_at: 10 };
  reconcilePageRunInstance(metadata, cp, { run_id: cp.run_id, page_instance_id: 'page-1', phase: 'scene_detection',
    request_state: 'in_flight', checkpoint_offset: 9434 }, 'page-2', 11);
  const event = summarizePageRunLifecycle(metadata, 2).retained_transitions[0];
  assert.equal(event.committed_phase_recovered, true);
  assert.equal(event.request_outcome, 'recovered_from_durable_phase_commit');
});

test('an interrupted second compaction request preserves the first observed empty response only', () => {
  const metadata = {}, cp = checkpoint();
  reconcilePageRunInstance(metadata, cp, null, 'page-1', 1, { freshRun: true });
  const marker = writePageRunMarker(storage(), 'chat-a', { run_id: cp.run_id, page_instance_id: 'page-1',
    phase: 'shortterm_extraction', request_state: 'in_flight', request_attempt: 2,
    observed_empty_response_count: 1 });
  reconcilePageRunInstance(metadata, cp, marker, 'page-2', 2);
  const event = summarizePageRunLifecycle(metadata, 2).retained_transitions[0];
  assert.equal(event.observed_empty_responses_before, 1);
  assert.equal(event.request_attempt_before, 2);
  assert.equal(event.request_outcome, 'completion_uncertain_after_page_interruption');
});

test('missing legacy marker does not claim complete interruption history', () => {
  const metadata = {}, cp = checkpoint();
  assert.equal(reconcilePageRunInstance(metadata, cp, null, 'new-page').interrupted, false);
  assert.equal(summarizePageRunLifecycle(metadata, 1).interruption_history_available, false);
});

test('bounded transition history retains cumulative count', () => {
  const metadata = {}, cp = checkpoint();
  reconcilePageRunInstance(metadata, cp, null, 'page-0', 1, { freshRun: true });
  for (let index = 1; index <= PAGE_RUN_LIFECYCLE_MAX_TRANSITIONS + 3; index++)
    reconcilePageRunInstance(metadata, cp, { run_id: cp.run_id, page_instance_id: `page-${index - 1}`, request_state: 'in_flight' }, `page-${index}`, index + 1);
  const result = summarizePageRunLifecycle(metadata, PAGE_RUN_LIFECYCLE_MAX_TRANSITIONS + 4);
  assert.equal(result.retained_transition_count, PAGE_RUN_LIFECYCLE_MAX_TRANSITIONS);
  assert.equal(result.page_interruption_count, PAGE_RUN_LIFECYCLE_MAX_TRANSITIONS + 3);
  assert.equal(result.retained_history_truncated, true);
});

test('marker excludes chat and provider content', () => {
  const marker = writePageRunMarker(storage(), 'chat-a', { run_id: 'run-a', page_instance_id: 'page-1',
    request_state: 'in_flight', raw_chat: 'SECRET CHAT', provider_response: 'SECRET RESPONSE' });
  assert.doesNotMatch(JSON.stringify(marker), /SECRET|raw_chat|provider_response/);
});

test('same-page runtime resets and safe exception fingerprints remain distinct from page replacement', () => {
  const metadata = {};
  recordRuntimeLifecycleEvent(metadata, 'run-a', { classification: 'ui_remounted', page_instance_id: 'page-1', subsystem: 'settings_panel' });
  recordRuntimeLifecycleEvent(metadata, 'run-a', { classification: 'unhandled_rejection', page_instance_id: 'page-1', normalized_error_type: 'TypeError', stack_fingerprint: 'fnv1a-test' });
  const summary = summarizePageRunLifecycle(metadata, 1);
  assert.equal(summary.page_interruption_count, 0);
  assert.equal(summary.runtime_event_count, 2);
  assert.equal(summary.runtime_events[0].classification, 'ui_remounted');
  assert.equal(summary.runtime_events[1].classification, 'unhandled_rejection');
  assert.equal(summary.runtime_events[1].stack_fingerprint, 'fnv1a-test');
});
