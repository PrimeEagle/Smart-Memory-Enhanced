import test from 'node:test';
import assert from 'node:assert/strict';
import { readPageRunMarker, writePageRunMarker, clearPageRunMarker, reconcilePageRunInstance, summarizePageRunLifecycle, recordRuntimeLifecycleEvent, captureBrowserStartupEvidence, PAGE_RUN_LIFECYCLE_MAX_TRANSITIONS } from '../page-run-lifecycle.js';

const storage = () => {
  const items = new Map();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: (key) => items.delete(key) };
};
const checkpoint = () => ({ run_id: 'run-a', status: 'in_progress', next_source_offset: 260,
  finalization: { active_phase: null, completed_phases: {} }, run_manifest: { total_attempt_count: 1 } });

test('four unexplained page replacements preserve evidence-backed cause-unavailable results and checkpoints', () => {
  const local = storage(), metadata = {}, cp = checkpoint(), scope = 'chat-a';
  assert.equal(reconcilePageRunInstance(metadata, cp, null, 'page-1', 100, { freshRun: true }).interrupted, false);
  let marker = writePageRunMarker(local, scope, { run_id: cp.run_id, page_instance_id: 'page-1', phase: 'source_extraction', checkpoint_offset: 260, request_state: 'in_flight' });
  for (const [index, phase] of ['source_extraction', 'scene_detection', 'shortterm_extraction', 'profile_generation'].entries()) {
    cp.finalization.active_phase = phase === 'source_extraction' ? null : phase;
    if (phase !== 'source_extraction') cp.next_source_offset = 9434;
    const next = `page-${index + 2}`;
    assert.equal(reconcilePageRunInstance(metadata, cp, marker, next, 200 + index).reason, 'page_instance_replaced_cause_unavailable');
    marker = writePageRunMarker(local, scope, { run_id: cp.run_id, page_instance_id: next, phase, checkpoint_offset: cp.next_source_offset, request_state: 'in_flight' });
  }
  const result = summarizePageRunLifecycle(metadata, 5);
  assert.equal(result.page_interruption_count, 4);
  assert.equal(result.unclassified_page_interruption_count, 4);
  assert.equal(result.page_instances_observed, 5);
  assert.equal(result.attempts_account_for_observed_page_transitions, true);
  assert.ok(result.retained_transitions.every((event) => event.cause === 'cause_unavailable'));
  assert.ok(result.retained_transitions.every((event) => event.cause_limitation));
  assert.equal(result.retained_transitions[0].checkpoint_offset_after, 260);
  assert.equal(result.retained_transitions[1].checkpoint_offset_after, 9434);
  assert.equal(result.retained_transitions[2].request_outcome, 'completion_uncertain_after_page_interruption');
  assert.equal(readPageRunMarker(local, scope).page_instance_id, 'page-5');
});

test('browser discard classification requires direct document.wasDiscarded evidence', () => {
  const metadata = {}, cp = checkpoint();
  reconcilePageRunInstance(metadata, cp, null, 'page-1', 1, { freshRun: true });
  const marker = { run_id: cp.run_id, page_instance_id: 'page-1', request_state: 'in_flight', checkpoint_offset: 260 };
  const evidence = captureBrowserStartupEvidence(
    { wasDiscarded: true, visibilityState: 'visible' },
    { getEntriesByType: () => [{ type: 'reload' }] },
    'page-2', marker,
  );
  const result = reconcilePageRunInstance(metadata, cp, marker, 'page-2', 2, { startupEvidence: evidence });
  assert.equal(result.reason, 'confirmed_browser_tab_discard');
  const summary = summarizePageRunLifecycle(metadata, 2);
  assert.equal(summary.confirmed_browser_tab_discard_count, 1);
  assert.equal(summary.unclassified_page_interruption_count, 0);
  assert.equal(summary.retained_transitions[0].cause, 'browser_discard_restoration');
  assert.equal(summary.retained_transitions[0].browser_startup_evidence.navigation_type, 'reload');
});

test('reload navigation without direct initiator evidence reports cause unavailable', () => {
  const metadata = {}, cp = checkpoint();
  reconcilePageRunInstance(metadata, cp, null, 'page-1', 1, { freshRun: true });
  const marker = { run_id: cp.run_id, page_instance_id: 'page-1', request_state: 'in_flight' };
  const evidence = captureBrowserStartupEvidence(
    { wasDiscarded: false, visibilityState: 'visible' },
    { getEntriesByType: () => [{ type: 'reload' }] },
    'page-2', marker,
  );
  const result = reconcilePageRunInstance(metadata, cp, marker, 'page-2', 2, { startupEvidence: evidence });
  assert.equal(result.reason, 'page_instance_replaced_cause_unavailable');
  assert.equal(summarizePageRunLifecycle(metadata, 2).confirmed_browser_tab_discard_count ?? 0, 0);
});

test('extension-requested navigation is classified from a retained intent without guessing', () => {
  const metadata = {}, cp = checkpoint();
  reconcilePageRunInstance(metadata, cp, null, 'page-1', 1, { freshRun: true });
  const marker = {
    run_id: cp.run_id, page_instance_id: 'page-1', request_state: 'idle',
    navigation_intent: { initiator: 'smart_memory_enhanced', action: 'reload', at: 1 },
    lifecycle_snapshot: { recent_events: [{ classification: 'extension_navigation_requested' }] },
  };
  const result = reconcilePageRunInstance(metadata, cp, marker, 'page-2', 2, {
    startupEvidence: captureBrowserStartupEvidence({ wasDiscarded: false }, { getEntriesByType: () => [{ type: 'reload' }] }, 'page-2', marker),
  });
  assert.equal(result.reason, 'extension_requested_navigation');
  const transition = summarizePageRunLifecycle(metadata, 2).retained_transitions[0];
  assert.equal(transition.cause_available, true);
  assert.equal(transition.prior_lifecycle_snapshot.recent_events[0].classification, 'extension_navigation_requested');
  assert.equal(summarizePageRunLifecycle(metadata, 2).extension_requested_navigation_count, 1);
  assert.equal(summarizePageRunLifecycle(metadata, 2).confirmed_browser_tab_discard_count ?? 0, 0);
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
  recordRuntimeLifecycleEvent(metadata, 'run-a', { classification: 'run_controller_created', page_instance_id: 'page-1' });
  recordRuntimeLifecycleEvent(metadata, 'run-a', { classification: 'ui_remounted', page_instance_id: 'page-1', subsystem: 'settings_panel' });
  recordRuntimeLifecycleEvent(metadata, 'run-a', { classification: 'unhandled_rejection', page_instance_id: 'page-1', normalized_error_type: 'TypeError', stack_fingerprint: 'fnv1a-test' });
  const summary = summarizePageRunLifecycle(metadata, 1);
  assert.equal(summary.page_interruption_count, 0);
  assert.equal(summary.runtime_event_count, 3);
  assert.equal(summary.controller_mount_count, 1);
  assert.equal(summary.runtime_events[1].classification, 'ui_remounted');
  assert.equal(summary.runtime_events[2].classification, 'unhandled_rejection');
  assert.equal(summary.runtime_events[2].stack_fingerprint, 'fnv1a-test');
});

test('freeze/resume lifecycle is neutral, coalesced, and does not create page interruptions', () => {
  const metadata = {};
  recordRuntimeLifecycleEvent(metadata, 'run-a', { classification: 'document_frozen', page_instance_id: 'page-1', request_state: 'freeze', event_origin: 'native_document_event' });
  recordRuntimeLifecycleEvent(metadata, 'run-a', { classification: 'document_frozen', page_instance_id: 'page-1', request_state: 'freeze' });
  recordRuntimeLifecycleEvent(metadata, 'run-a', { classification: 'document_resumed', page_instance_id: 'page-1', request_state: 'resume_from_freeze' });
  const summary = summarizePageRunLifecycle(metadata, 1);
  assert.equal(summary.page_interruption_count, 0);
  assert.equal(summary.runtime_event_count, 3);
  assert.equal(summary.runtime_events.length, 2);
  assert.equal(summary.runtime_events[0].repeat_count, 2);
  assert.equal(summary.runtime_events[0].event_origin, 'native_document_event');
});

test('startup evidence fills prior page id from persisted lineage with provenance', () => {
  const metadata = {}, cp = checkpoint();
  reconcilePageRunInstance(metadata, cp, null, 'page-1', 1, { freshRun: true });
  const evidence = captureBrowserStartupEvidence({ wasDiscarded: false }, { getEntriesByType: () => [{ type: 'navigate' }] }, 'page-2', null);
  reconcilePageRunInstance(metadata, cp, null, 'page-2', 2, { startupEvidence: evidence });
  const summary = summarizePageRunLifecycle(metadata, 2);
  assert.equal(summary.page_instance_lineage.length, 2);
  assert.equal(summary.retained_transitions[0].browser_startup_evidence.prior_page_instance_id, 'page-1');
  assert.equal(summary.retained_transitions[0].browser_startup_evidence.prior_page_instance_id_source, 'persisted_page_run_ledger');
});
