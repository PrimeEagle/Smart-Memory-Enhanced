import { SCHEMA_VERSION } from './constants.js';
import { cloneSerializableDomain } from './serializable-domain.js';

const STORE_KINDS = new Set(['character', 'chat']);

export function createMemoryStoreSchemaError(kind, actualVersion) {
  const normalizedKind = STORE_KINDS.has(kind) ? kind : 'chat';
  const error = new Error(`${normalizedKind === 'character' ? 'Character' : 'Chat'} memory store uses an unsupported schema. Fresh Start is required.`);
  error.code = 'SME_FRESH_START_REQUIRED';
  error.sme_reason_code = `${normalizedKind}_memory_store_schema_unsupported`;
  error.sme_failure_stage = 'memory_store_schema_validation';
  error.sme_expected_schema_version = SCHEMA_VERSION;
  error.sme_actual_schema_version = Number.isInteger(actualVersion)
    ? actualVersion : null;
  return error;
}

/** Current-schema-only boundary for persisted character/chat memory stores. */
export function assertCurrentMemoryStore(store, kind) {
  if (!store || typeof store !== 'object' || Array.isArray(store)
    || store.schema_version !== SCHEMA_VERSION) {
    throw createMemoryStoreSchemaError(kind, store?.schema_version);
  }
  cloneSerializableDomain(store, {
    path: `$.${kind}_memory_store`, stage: 'memory_store_schema_validation',
    operation_type: `${kind}_memory_store`,
  });
  return store;
}

export function createCurrentMemoryStore(kind, fields = {}) {
  if (!STORE_KINDS.has(kind)) {
    const error = new TypeError(`Unknown memory store kind: ${String(kind)}`);
    error.code = 'SME_INVALID_MEMORY_STORE_KIND';
    throw error;
  }
  const store = cloneSerializableDomain({ ...fields, schema_version: SCHEMA_VERSION }, {
    path: `$.${kind}_memory_store`, stage: 'memory_store_creation',
    operation_type: `${kind}_memory_store`,
  });
  return assertCurrentMemoryStore(store, kind);
}

/** Current Long-Term/Session record boundary; readers never synthesize identity. */
export function assertCurrentMemoryRecord(record, tier) {
  const normalizedTier = tier === 'session' ? 'session' : 'longterm';
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !String(record.id ?? '').trim()
    || !String(record.type ?? '').trim()
    || !String(record.content ?? '').trim()
    || !Number.isFinite(record.ts)
    || typeof record.consolidated !== 'boolean') {
    const error = new Error(`${normalizedTier} memory record uses an unsupported schema. Fresh Start is required.`);
    error.code = 'SME_FRESH_START_REQUIRED';
    error.sme_reason_code = `${normalizedTier}_memory_record_schema_unsupported`;
    error.sme_failure_stage = 'memory_record_schema_validation';
    throw error;
  }
  cloneSerializableDomain(record, {
    path: `$.${normalizedTier}_memory_record`, stage: 'memory_record_schema_validation',
    operation_type: `${normalizedTier}_memory_record`,
  });
  return record;
}
