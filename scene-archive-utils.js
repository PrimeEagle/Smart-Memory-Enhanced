export function trimSceneArchive(history, archiveMax = 100) {
  const max = Number(archiveMax);
  return max < 0 ? [...history] : history.slice(Math.max(0, history.length - Math.max(1, max)));
}

export function selectScenesForInjection(history, injectCount = 5) {
  return history.slice(Math.max(0, history.length - Math.max(1, Number(injectCount) || 5)));
}

function stableLegacySceneId(scene, indices) {
  // Legacy scenes predate stable IDs. Their content and source provenance are
  // already durable, so derive an ID from that state rather than allocating a
  // new random one every time the record is read for reconciliation.
  const source = [
    String(scene?.summary ?? '').trim().toLowerCase(),
    indices.join(','),
    String(scene?.source_start_index ?? ''),
    String(scene?.source_end_index ?? ''),
    String(scene?.detection_message_index ?? ''),
    String(scene?.ts ?? ''),
  ].join('|');
  let hash = 2166136261;
  for (const char of source) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `legacy-scene-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function normalizeSceneRecord(scene, idFactory = null) {
  const indices = [...new Set((scene.source_message_indices ?? []).filter(Number.isInteger))].sort((a, b) => a - b);
  const participants = [...new Set((scene.character_participants ?? [])
    .map((name) => String(name ?? '').trim())
    .filter(isPlausibleEntityName))];
  return {
    ...scene,
    id: scene.id ?? (typeof idFactory === 'function' ? idFactory() : stableLegacySceneId(scene, indices)),
    source_message_indices: indices,
    source_start_index: scene.source_start_index ?? indices[0] ?? null,
    source_end_index: scene.source_end_index ?? indices.at(-1) ?? null,
    source_memory_ids: [...new Set(scene.source_memory_ids ?? [])],
    character_participants: participants,
    grounding_status: scene.grounding_status ?? (indices.length ? 'direct' : 'legacy'),
    validation_status: scene.validation_status ?? (indices.length ? 'validated' : 'legacy'),
    validation_issues: scene.validation_issues ?? [],
    detected_by: scene.detected_by ?? 'legacy',
    detection_message_index: scene.detection_message_index ?? null,
  };
}
import { isPlausibleEntityName } from './parsers.js';
