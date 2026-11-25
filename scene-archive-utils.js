export function trimSceneArchive(history, archiveMax = 100) {
  const max = Number(archiveMax);
  return max < 0 ? [...history] : history.slice(Math.max(0, history.length - Math.max(1, max)));
}

export function selectScenesForInjection(history, injectCount = 5) {
  return history.slice(Math.max(0, history.length - Math.max(1, Number(injectCount) || 5)));
}

export function createCurrentSceneRecord(scene, idFactory) {
  if (typeof idFactory !== 'function' && !String(scene?.id ?? '').trim()) {
    throw new TypeError('Current scene construction requires an ID or ID factory.');
  }
  const indices = [...new Set((scene.source_message_indices ?? []).filter(Number.isInteger))].sort((a, b) => a - b);
  const participants = [...new Set((scene.character_participants ?? [])
    .map((name) => String(name ?? '').trim())
    .filter(isPlausibleEntityName))];
  return {
    ...scene,
    id: scene.id ?? idFactory(),
    source_message_indices: indices,
    source_start_index: scene.source_start_index ?? indices[0] ?? null,
    source_end_index: scene.source_end_index ?? indices.at(-1) ?? null,
    source_memory_ids: [...new Set(scene.source_memory_ids ?? [])],
    character_participants: participants,
    grounding_status: scene.grounding_status ?? (indices.length ? 'direct' : 'unsupported'),
    validation_status: scene.validation_status ?? (indices.length ? 'validated' : 'rejected'),
    validation_issues: scene.validation_issues ?? [],
    detected_by: scene.detected_by ?? 'runtime',
    detection_message_index: scene.detection_message_index ?? null,
  };
}

export function assertCurrentSceneRecord(scene) {
  const valid = scene && typeof scene === 'object' && !Array.isArray(scene)
    && Boolean(String(scene.id ?? '').trim())
    && typeof scene.summary === 'string'
    && Number.isFinite(Number(scene.ts))
    && Array.isArray(scene.source_message_indices)
    && Array.isArray(scene.source_memory_ids)
    && Array.isArray(scene.character_participants)
    && typeof scene.grounding_status === 'string'
    && typeof scene.validation_status === 'string'
    && Array.isArray(scene.validation_issues)
    && Boolean(String(scene.detected_by ?? '').trim());
  if (!valid) {
    const error = new Error('Scene History contains a non-current record. Run Fresh Start before continuing.');
    error.code = 'SME_FRESH_START_REQUIRED';
    error.reason = 'scene_history_record_schema_mismatch';
    throw error;
  }
  return scene;
}
import { isPlausibleEntityName } from './parsers.js';
