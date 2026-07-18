/** Grounding helpers for newly extracted memories. */
import { normalizeMemoryProvenance, validateMemoryAncestry } from './record-validation.js';

export function applyDirectProvenance(memories, recentMessages, chatWindowStart) {
  for (const memory of memories) {
    const claimedIndices = Array.isArray(memory.source_message_indices) ? memory.source_message_indices : [];
    const validRelative = [...new Set(claimedIndices.filter(
      (index) => Number.isInteger(index) && index >= 0 && index < recentMessages.length,
    ))];
    const hasMalformedClaim = claimedIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= recentMessages.length);
    if (claimedIndices.length > 0) {
      memory.source_message_indices = validRelative.map((index) => chatWindowStart + index);
    }
    const normalized = normalizeMemoryProvenance(memory);
    const indices = normalized.indices;
    if (indices.length === 0 || hasMalformedClaim) {
      memory.grounding_status = 'ungrounded';
      memory.source_messages = [];
      memory.validation_status = 'needs_review';
      memory.validation_issues = hasMalformedClaim
        ? ['One or more claimed source messages are outside this extraction chunk.']
        : ['No valid source messages were supplied.'];
      continue;
    }
    memory.grounding_status = 'direct';
    memory.source_message_indices = indices;
    memory.validation_status = 'validated';
    memory.validation_issues = [];
    // normalizeMemoryProvenance already rebuilt legacy ranges from the
    // authoritative absolute indices above.
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
