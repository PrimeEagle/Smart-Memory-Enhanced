import { assertSerializableDomain } from './serializable-domain.js';

/**
 * Chat-scoped execution and diagnostic state invalidated by Fresh Start.
 * Durable memory stores are cleared by their owning modules; this list owns
 * only orchestration state that must never survive into the next run.
 */
export const MEMORIZE_FRESH_START_METADATA_KEYS = Object.freeze([
  'entity_redirects',
  'catch_up_diagnostics',
  'last_catchup_run_id',
  'scene_stability_history',
  'request_efficiency_history',
  'repair_history',
  'repair_volume_changed',
  'repair_volume_delta',
  'repair_volume_change_reason',
  'developer_idempotence_check',
  'historical_persona_snapshot',
  'canonical_persona_context',
  'active_catchup_run_id',
  'catch_up_checkpoint',
  'catch_up_run_manifests',
  'parser_debris_cleanup',
  'provider_completion_journal',
  'fresh_start_postcondition_audit',
  'live_memory_health',
  'page_run_lifecycle',
  'shortterm_compaction_checkpoint',
  'targeted_extraction_replay',
]);

/**
 * Removes every run-scoped value owned by the Memorize Chat architecture.
 * The caller persists this mutation atomically with the tier-store reset.
 *
 * @param {Record<string, unknown>} metadata
 * @returns {{ deleted_keys: string[] }}
 */
export function resetMemorizeRunMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    const error = new TypeError('Fresh Start requires a metadata object.');
    error.code = 'SME_FRESH_START_METADATA_REQUIRED';
    throw error;
  }
  const deletedKeys = [];
  for (const key of MEMORIZE_FRESH_START_METADATA_KEYS) {
    if (!Object.hasOwn(metadata, key)) continue;
    delete metadata[key];
    deletedKeys.push(key);
  }
  const result = { deleted_keys: deletedKeys };
  assertSerializableDomain(result, {
    path: '$.fresh_start_reset',
    stage: 'fresh_start_reset',
    operation_type: 'fresh_start',
  });
  return result;
}
