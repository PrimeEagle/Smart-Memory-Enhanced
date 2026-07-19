/** Grounding helpers for newly extracted memories. */
import { normalizeMemoryProvenance, prepareRecordForValidation, validateMemoryAncestry } from './record-validation.js';

export function applyDirectProvenance(memories, recentMessages, chatWindowStart, originalMessageIndices = null) {
  for (const memory of memories) {
    prepareRecordForValidation(memory, {
      originalMessageIndices,
      sourceOffset: chatWindowStart,
      sourceLength: recentMessages.length,
      indicesAreRelative: true,
    });
  }
  return memories;
}

export function validateGeneratedMemoryRecord(memory, memoryStore = []) {
  normalizeMemoryProvenance(memory);
  const ancestry = validateMemoryAncestry(memory.id, memory.parent_memory_ids, memoryStore);
  memory.parent_memory_ids = ancestry.parentIds;
  if (!ancestry.valid) {
    memory.grounding_status = 'ungrounded';
    memory.validation_status = 'needs_review';
    memory.validation_issues = [...new Set([...(memory.validation_issues ?? []), ...ancestry.issues])];
  }
  return ancestry;
}

export function isGrounded(memory) {
  // Legacy records predate provenance and remain readable. A user can also
  // explicitly approve a reviewed record, which is then safe to propagate.
  return memory?.grounding_status !== 'ungrounded' || memory?.validation_status === 'approved';
}
