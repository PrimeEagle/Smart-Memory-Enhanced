import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCurrentSceneRecord, createCurrentSceneRecord, selectScenesForInjection, trimSceneArchive } from '../scene-archive-utils.js';

test('scene archive retains all detected scenes up to the archive cap while injecting only the recent subset', () => {
  const scenes = Array.from({ length: 12 }, (_, index) => ({ id: String(index), summary: `Scene ${index}` }));
  assert.equal(trimSceneArchive(scenes, 100).length, 12);
  assert.deepEqual(selectScenesForInjection(scenes, 5).map((scene) => scene.id), ['7', '8', '9', '10', '11']);
});

test('scene construction requires an explicit durable identity source', () => {
  assert.throws(() => createCurrentSceneRecord({ summary: 'A scene', ts: 1 }), TypeError);
});

test('scene records preserve original source indices despite filtered-message gaps', () => {
  const scene = createCurrentSceneRecord({
    summary: 'A scene',
    source_message_indices: [8, 3, 8, 5],
    source_memory_ids: [],
  }, () => 'scene-1');
  assert.deepEqual(scene.source_message_indices, [3, 5, 8]);
  assert.equal(scene.source_start_index, 3);
  assert.equal(scene.source_end_index, 8);
  assert.equal(scene.grounding_status, 'direct');
});

test('scene reads reject records outside the current schema', () => {
  assert.throws(
    () => assertCurrentSceneRecord({ summary: 'Old scene', ts: 1 }),
    (error) => error?.code === 'SME_FRESH_START_REQUIRED'
      && error?.reason === 'scene_history_record_schema_mismatch',
  );
});

test('scene construction removes parser artifacts from participants', () => {
  const scene = createCurrentSceneRecord({
    summary: 'A scene',
    character_participants: ['Paul', 'Sources', 'sources=0', 'Unit 01'],
  }, () => 'scene-2');
  assert.deepEqual(scene.character_participants, ['Paul', 'Unit 01']);
});
