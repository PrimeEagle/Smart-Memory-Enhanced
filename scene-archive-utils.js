export function trimSceneArchive(history, archiveMax = 100) {
  const max = Number(archiveMax);
  return max < 0 ? [...history] : history.slice(Math.max(0, history.length - Math.max(1, max)));
}

export function selectScenesForInjection(history, injectCount = 5) {
  return history.slice(Math.max(0, history.length - Math.max(1, Number(injectCount) || 5)));
}

export function normalizeSceneRecord(scene, idFactory = () => `legacy:${Date.now()}`) {
  const indices = [...new Set((scene.source_message_indices ?? []).filter(Number.isInteger))].sort((a, b) => a - b);
  return {
    ...scene,
    id: scene.id ?? idFactory(),
    source_message_indices: indices,
    source_start_index: scene.source_start_index ?? indices[0] ?? null,
    source_end_index: scene.source_end_index ?? indices.at(-1) ?? null,
    source_memory_ids: [...new Set(scene.source_memory_ids ?? [])],
    grounding_status: scene.grounding_status ?? (indices.length ? 'direct' : 'legacy'),
    validation_status: scene.validation_status ?? (indices.length ? 'validated' : 'legacy'),
    validation_issues: scene.validation_issues ?? [],
    detected_by: scene.detected_by ?? 'legacy',
    detection_message_index: scene.detection_message_index ?? null,
  };
}
